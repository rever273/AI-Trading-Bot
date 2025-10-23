// src/index.ts
import 'dotenv/config';
import { CFG } from './config.js';
import { connectDB } from './db/connect.js';
import { sleep, logger } from './utils/functions.js';
import { getCandles, getFundingAndOI, getMarkPrice } from './hl/market.js';
import type { Candle, AccountSummary, IntradayBundle, FourHourBundle, FundingOi } from './types.js';
import { ema, macd, rsi, atr } from './indicators/indicators.js';
import { buildPrompt, type CoinPromptData } from './ai/prompt.js';
import { askAI } from './ai/ai.js';
import { applyDecisionForSymbol } from './trade/execute.js';
import { warmSzCache } from './hl/precision.js';

import { updateOiAverage } from './hl/oiCache.js';
import { initializeHyperliquidClient, getHlClient } from './hl/client.js';
import { CronJob } from 'cron';

function last<T>(arr: T[]): T | undefined {
    return arr.length ? arr[arr.length - 1] : undefined;
}

async function collectAccountSummary(): Promise<AccountSummary> {
    const hl = getHlClient();
    const addr = CFG.hl.walletAddress;

    const ch: any = await hl.info.perpetuals.getClearinghouseState(addr as string); // баланс/позиции

    const accValue = Number(ch?.crossMarginSummary?.accountValue ?? ch?.marginSummary?.accountValue ?? 0);
    const totalMarginUsed = Number(ch?.crossMarginSummary?.totalMarginUsed ?? ch?.marginSummary?.totalMarginUsed ?? 0);
    const totalNtlPos = Number(ch?.crossMarginSummary?.totalNtlPos ?? ch?.marginSummary?.totalNtlPos ?? 0);
    const totalRawUsd = Number(ch?.crossMarginSummary?.totalRawUsd ?? ch?.marginSummary?.totalRawUsd ?? 0);
    const crossMaintenanceMarginUsed = Number(ch?.crossMaintenanceMarginUsed ?? 0);

    // открытые ордера (для exit-plan)
    const openOrders: any[] = await hl.info.getUserOpenOrders(addr as string).catch(() => []);

    // вытащить TP/SL по монете (reduce-only)
    function extractExitPlan(coin: string, side: 'long' | 'short', markPx: number) {
        const ro = openOrders.filter((o: any) => o?.coin === coin && (o?.reduceOnly === true || o?.reduce_only === true));

        let tp: number | null = null;
        let sl: number | null = null;

        for (const o of ro) {
            const px = Number(o?.limitPx ?? o?.limit_px ?? o?.px ?? NaN);
            const isBuy = !!(o?.isBuy ?? o?.is_buy);
            if (!isFinite(px)) continue;

            // Классификация: TP/SL в терминах цены против стороны позиции
            if (side === 'long') {
                if (!isBuy && px > markPx) tp = tp == null ? px : Math.min(tp, px); // SELL выше рынка
                if (!isBuy && px < markPx) sl = sl == null ? px : Math.max(sl, px); // SELL ниже рынка
            } else {
                // short
                if (isBuy && px < markPx) tp = tp == null ? px : Math.max(tp, px); // BUY ниже рынка
                if (isBuy && px > markPx) sl = sl == null ? px : Math.min(sl, px); // BUY выше рынка
            }
        }
        return { profit_target: tp, stop_loss: sl };
    }

    const positions = (ch?.assetPositions ?? [])
        .map((p: any) => {
            const coin = p?.position?.coin;
            const szi = Number(p?.position?.szi ?? 0);
            const qtyAbs = Math.abs(szi);
            const side = szi > 0 ? 'long' : szi < 0 ? 'short' : 'flat';
            const entryPx = Number(p?.position?.entryPx ?? NaN);
            const lev = Number(p?.position?.leverage?.value ?? NaN);
            const unrealizedPnl = Number(p?.position?.unrealizedPnl ?? 0);
            const liquidationPx = Number(p?.position?.liquidationPx ?? null);
            return { coin, qtyAbs, side, entryPx, lev: isFinite(lev) ? lev : null, unrealizedPnl, liquidationPx };
        })
        .filter((x: any) => x.coin && x.qtyAbs > 0);

    // добавим current_price и exit_plan
    const detailedPositions = await Promise.all(
        positions.map(async (pos: any) => {
            const symbol = `${pos.coin}-PERP`;
            const mark = await getMarkPrice(symbol);
            const exit = extractExitPlan(pos.coin, pos.side, mark);
            return {
                coin: pos.coin,
                quantity: pos.qtyAbs,
                entry_price: isFinite(pos.entryPx) ? pos.entryPx : null,
                current_price: mark,
                leverage: pos.lev,
                liquidation_price: isFinite(pos.liquidationPx) ? pos.liquidationPx : null,
                unrealized_pnl: pos.unrealizedPnl,
                notional_usd: pos.qtyAbs * mark,
                exit_plan: {
                    profit_target: exit.profit_target ?? null,
                    stop_loss: exit.stop_loss ?? null,
                    invalidation_condition: null,
                },
            };
        }),
    );

    return {
        accountValue: accValue,
        totalMarginUsed,
        totalNtlPos,
        totalRawUsd,
        crossMaintenanceMarginUsed,
        positions: detailedPositions,
    };
}

async function buildCoinData(symbol: string): Promise<CoinPromptData> {
    const intraday: Candle[] = await getCandles(symbol, '3m', 120);
    const h4: Candle[] = await getCandles(symbol, '4h', 200);

    const { openInterestLatest, fundingRate } = await getFundingAndOI(symbol);
    const { avg: oiAvg } = updateOiAverage(openInterestLatest);
    const markPx = await getMarkPrice(symbol);

    // 3m серийки — mid
    const mid3m = intraday.map((c) => (c.h + c.l) / 2);
    const ema20_3m = ema(mid3m, 20);
    const macd3m = macd(mid3m);
    const rsi7_3m = rsi(mid3m, 7);
    const rsi14_3m = rsi(mid3m, 14);

    // 4h контекст
    const close4h = h4.map((c) => c.c);
    const high4h = h4.map((c) => c.h);
    const low4h = h4.map((c) => c.l);

    const ema20_4h = ema(close4h, 20);
    const ema50_4h = ema(close4h, 50);
    const macd4h = macd(close4h);
    const rsi14_4h = rsi(close4h, 14);

    const atrInput = h4.map((c, i) => ({ h: high4h[i], l: low4h[i], c: close4h[i] }));
    const atr3_4h = atr(atrInput, 3);
    const atr14_4h = atr(atrInput, 14);

    const vols4h = h4.map((c) => c.v);
    const currVol = last(vols4h) ?? 0;
    const avgVol = vols4h.slice(-50).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(50, vols4h.length));

    const coin = symbol.split('-')[0];

    return {
        symbol,
        coin,
        markPx,

        oiLatest: openInterestLatest,
        oiAvg,
        fundingRate,

        current_ema20: ema20_3m.at(-1) ?? NaN,
        current_macd: macd3m.macd.at(-1) ?? NaN,
        current_rsi7: rsi7_3m.at(-1) ?? NaN,
        current_rsi14: rsi14_3m.at(-1) ?? NaN,

        intraday: {
            midPrices: mid3m.slice(-10),
            ema20: ema20_3m.slice(-10),
            macd: macd3m.macd.slice(-10),
            rsi7: rsi7_3m.slice(-10),
            rsi14: rsi14_3m.slice(-10),
        },
        fourHour: {
            ema20: ema20_4h.at(-1) ?? NaN,
            ema50: ema50_4h.at(-1) ?? NaN,
            atr3: atr3_4h.at(-1) ?? NaN,
            atr14: atr14_4h.at(-1) ?? NaN,
            macd: macd4h.macd.slice(-10),
            rsi14: rsi14_4h.slice(-10),
            currVolume: currVol,
            avgVolume: avgVol,
        },
    };
}

async function runOnceMulti(sinceStartMs: number, invocations: number) {
    const symbols = CFG.symbols.list;
    const coins: CoinPromptData[] = [];

    for (const symbol of symbols) {
        try {
            coins.push(await buildCoinData(symbol));
        } catch (e) {
            console.error('[collect] error for', symbol, e);
        }
    }

    // Состояние аккаунта/позиции/ордера
    const account = await collectAccountSummary();

    const prompt = buildPrompt({
        CFG: {
            hl: { isTestnet: CFG.hl.testnet },
            tf: { intradayInterval: CFG.tf.intradayInterval },
        },
        sinceMinutes: Math.floor(sinceStartMs / 60000),
        invocations,
        nowIso: new Date().toISOString(),
        coins,
        account,
    });

    // console.log('PROMPT==>\n', prompt);

    const rawModelResponse = await askAI(prompt);

    // return;
    // const rawModelResponse = {
    //     llm_response: {
    //         ETH: {
    //             signal: 'buy',
    //             quantity: 0.004,
    //             profit_target: 3925,
    //             stop_loss: 3750,
    //             coin: 'ETH',
    //             leverage: 4,
    //             risk_usd: 30.99,
    //             risk_pct: 0.05,
    //             confidence: 0.8,
    //             invalidation_condition: 'Price breaks below 109886 with increased volume and OI',
    //         },
    //         // ETH: {
    //         //     signal: 'sell',
    //         //     quantity: 0.003,
    //         //     profit_target: 3725,
    //         //     stop_loss: 4130,
    //         //     coin: 'ETH',
    //         //     leverage: 2,
    //         //     risk_usd: 11.99,
    //         //     risk_pct: 0.05,
    //         //     confidence: 0.8,
    //         //     invalidation_condition: 'Price breaks below 109886 with increased volume and OI',
    //         // },
    //     },
    //  };

    // применяем решения по каждому символу отдельно
    let cnt = 0;
    for (const symbol of symbols) {
        try {
            const res = await applyDecisionForSymbol(rawModelResponse, await getMarkPrice(symbol), symbol, account);
            if (!res) {
                cnt++;
            }
        } catch (e) {
            logger.error('[applyDecision] error for', symbol, e);
        }
    }

    if (cnt === symbols.length) {
        logger.log(`[runOnceMulti] No actions taken for any symbols.`);
    }
}

async function main() {
    await connectDB();

    // Инициализируем клиент Hyperliquid с ретраями
    await initializeHyperliquidClient();

    const symbols = CFG.symbols.list;
    let invocations = 0;
    const startTs = Date.now();

    logger.log('Symbols:', symbols.join(', '));
    logger.log('Testnet mode:', CFG.hl.testnet);
    logger.log('Signal policy:', CFG.scheduler.signalPolicy);

    await warmSzCache(symbols);

    const task = async () => {
        try {
            logger.log('[Rerun] Processing symbols:', symbols.join(', '));
            invocations++;
            await runOnceMulti(Date.now() - startTs, invocations);
        } catch (e) {
            logger.error('[Rerun] error batch', e);
        }
    };

    // Если testnet, выполнить один раз сразу при запуске
    if (CFG.hl.testnet) {
        logger.log('[Testnet] Running initial task for testnet...');
        await task();
    }

    // Запускаем cron-задачу строго каждые X минут
    const cronInterval = `*/${Math.floor(CFG.scheduler.pollMs / 60000)} * * * *`; // '*/2 * * * *'

    const job = new CronJob(
        `0 ${cronInterval}`,
        task,
        null,
        true, // Start the job right now
        'UTC',
    );

    // logger.log(`Cron job scheduled with interval '${job.cronTime.source}'. Next run at: ${job.nextDate().toUTC().toString()}`);
}

main().catch((e) => {
    logger.error(e);
    process.exit(1);
});
