// src/trade/execute.ts
import { CFG } from '../config.js';
import { getHlClient } from '../hl/client.js';
import { getMarkPrice } from '../hl/market.js';
import { quantizePxHL /*, quantizePxHLSide */ } from '../utils/hlQuantize.js';
import { buildAggressiveLimitEntry, buildIocEntryOrder } from './limitEntry.js';
import type { ModelCoinDecision, ModelResponse, OpenPosition, AccountSummary } from '../types.js';
import { DecisionModel } from '../models/Decision.js';
import { logger } from '../utils/functions.js';
import { getSzDecimals } from '../hl/precision.js';

/**
 * Унифицированный обработчик ответов от Hyperliquid API.
 * Логирует статусы и ошибки, возвращает true при успехе и false при ошибке.
 * @param context - Строка для логов, например '[BRACKET]' или '[UPDATE]'.
 * @param response - Объект ответа от hl.exchange.
 * @returns {boolean} - true, если все операции успешны, иначе false.
 */
function handleHlResponse(context: string, response: any): boolean {
    if (!response) {
        logger.error(`${context} Request failed: received null or undefined response.`);
        return false;
    }

    // 1. Проверяем общий статус запроса
    if (response.status !== 'ok') {
        logger.error(`${context} Request status is not 'ok':`, response.response?.data ?? response);
        return false;
    }

    // 2. Обрабатываем статусы отдельных ордеров
    const statuses = response.response?.data?.statuses ?? response.statuses ?? [];
    if (!Array.isArray(statuses) || statuses.length === 0) {
        // logger.log(`${context} Request 'ok', no detailed statuses to report.`);
        return true;
    }

    let hasError = false;
    statuses.forEach((st: any, i: number) => {
        if (st?.error) {
            logger.error(`${context} order[${i}] error:`, st.error);
            hasError = true;
        } else if (st?.filled) {
            logger.log(`${context} order[${i}] filled:`, st.filled);
        } else if (st?.resting) {
            logger.log(`${context} order[${i}] resting:`, st.resting);
        } else if (st?.waitingForTrigger) {
            logger.log(`${context} order[${i}] is waiting for trigger TP/SL.`);
        } else {
            logger.log(`${context} order[${i}] status:`, st);
        }
    });

    if (hasError) {
        logger.error(`${context} Aborting due to errors in order statuses.`);
    }

    return !hasError;
}

function extractStatuses(resp: any): any[] {
    return resp?.response?.data?.statuses ?? resp?.statuses ?? [];
}

function isIocNoMatchStatus(st: any): boolean {
    const msg = String(st?.error ?? '').toLowerCase();
    return msg.includes('could not immediately match') || msg.includes('no resting orders');
}

function hasIocNoMatch(resp: any): boolean {
    return extractStatuses(resp).some(isIocNoMatchStatus);
}

function filledSzFrom(resp: any): number {
    const s = extractStatuses(resp)[0];

    const f = s?.filled?.sz ?? s?.filled?.totalSz ?? (typeof s?.filled === 'number' ? s.filled : 0);

    const n = Number(f);
    return Number.isFinite(n) ? n : 0;
}

function clamp(x: number, lo: number, hi: number) {
    return Math.min(hi, Math.max(lo, x));
}

function baseFromSymbol(symbol: string) {
    return symbol.split('-')[0]; // 'BTC-PERP' -> 'BTC'
}

function almostEqualPx(symbol: string, a: number, b: number): boolean {
    return roundPricePerp(a) === roundPricePerp(b);
}
function almostEqualSz(symbol: string, a: number, b: number): boolean {
    return Math.abs(a - b) <= 1e-9;
}

// Вспомогательные утилиты
function quantizeByDecimals(x: number, decimals: number): number {
    const m = 10 ** decimals;
    const n = Math.floor((x + Number.EPSILON) * m); // integer units
    const q = n / m;
    const back = q * m;
    if (Math.abs(Math.round(back) - back) > 1e-9) {
        return (n - 1) / m;
    }
    return q;
}

// Безопасное округление
function roundSz(symbol: string, rawQty: number, szDecimals: number): number {
    return quantizeByDecimals(rawQty, szDecimals);
}

// Жёсткая проверка направлений и уровней
function validateBracketLevels(isBuy: boolean, entry: number, tp: number, sl: number) {
    const tpOk = isBuy ? tp > entry : tp < entry;
    const slOk = isBuy ? sl < entry : sl > entry;
    return { tpOk, slOk };
}

// Возвращает текущие цели к позиции для symbol: { tp?, sl? }, выбирая по логике стороны
async function getCurrentTargets(symbol: string, side: 'long' | 'short', posQty: number) {
    const user = CFG.hl.walletAddress!;
    const fe = await getFrontendOpenOrdersSafe(user);
    const mark = await getMarkPrice(symbol);

    const isLong = side === 'long';
    const candidates = fe
        .filter((o: any) => coinMatches(o, symbol))
        .filter((o: any) => o.isTrigger === true || o.isPositionTpsl === true || o.reduceOnly === true || o.reduce_only === true)
        .map((o: any) => {
            const px = Number(o.triggerPx ?? o.trigger?.triggerPx ?? o.limit_px ?? o.limitPx ?? o.p ?? o.price ?? NaN);
            const isBuy = (o.is_buy ?? o.isBuy ?? o.b) === true || (o.side && String(o.side).toLowerCase() === 'buy');
            const sz = Number(o.sz ?? o.size ?? o.s ?? o.resting?.sz ?? o.resting?.size ?? NaN);
            const oid = o.oid ?? o.orderId ?? o.resting?.oid ?? null;
            return { px, isBuy, sz, oid, raw: o };
        })
        .filter((x) => Number.isFinite(x.px) && Number.isFinite(x.sz) && x.oid != null);

    // Классифицируем TP/SL по направлению и расположению цены относительно mark
    const tps: typeof candidates = [];
    const sls: typeof candidates = [];
    for (const c of candidates) {
        if (isLong) {
            // Лонг: TP — sell выше mark; SL — sell ниже mark
            if (!c.isBuy && c.px > mark) tps.push(c);
            else if (!c.isBuy && c.px < mark) sls.push(c);
        } else {
            // Шорт: TP — buy ниже mark; SL — buy выше mark
            if (c.isBuy && c.px < mark) tps.push(c);
            else if (c.isBuy && c.px > mark) sls.push(c);
        }
    }

    // Выбор «актуальной» цели:
    const pickClosestSize = (arr: typeof candidates) => arr.sort((a, b) => Math.abs(b.sz - posQty) - Math.abs(a.sz - posQty)).reverse(); // ближе к posQty — выше

    let tp: any = null;
    if (tps.length) {
        const arr = pickClosestSize(tps);
        tp = arr.reduce((best, cur) => {
            if (!best) return cur;
            return isLong ? (cur.px > best.px ? cur : best) : cur.px < best.px ? cur : best;
        }, arr[0]);
    }

    let sl: any = null;
    if (sls.length) {
        const arr = pickClosestSize(sls);
        sl = arr.reduce((best, cur) => {
            if (!best) return cur;
            if (isLong) return cur.px > best.px ? cur : best;
            return cur.px < best.px ? cur : best;
        }, arr[0]);
    }

    return {
        tp: tp ? { px: roundPricePerp(tp.px), sz: tp.sz, oid: tp.oid } : null,
        sl: sl ? { px: roundPricePerp(sl.px), sz: sl.sz, oid: sl.oid } : null,
    };
}

async function cancelSpecificOrders(symbol: string, oids: number[]): Promise<boolean> {
    if (!oids.length) return true;
    const hl = getHlClient();
    try {
        for (const oid of oids) {
            const res = await (hl.exchange as any).cancelOrder({ coin: symbol, o: oid });
            if (!handleHlResponse(`[CANCEL ORDERS/TARGETS ${symbol} oid=${oid}]`, res)) {
                return false;
            }
        }
        return true;
    } catch (e) {
        logger.error('[CANCEL ORDERS/TARGETS] failed:', e);
        return false;
    }
}

//Унифицированный матчинг монеты/символа
function coinMatches(obj: any, symbol: string): boolean {
    if (!obj) return false;
    const base = baseFromSymbol(symbol); // 'ETH'
    const sym = symbol.toUpperCase(); // 'ETH-PERP'
    const b = base.toUpperCase();

    const pick = (x: any) => (x == null ? '' : String(x).toUpperCase().trim());
    const candidates = [pick(obj.coin), pick(obj.symbol), pick(obj.name), pick(obj.pair), pick(obj.base), pick(obj.inst), pick(obj.instrument)].filter(Boolean);

    return candidates.some((v) => v === sym || v === b);
}

// до 6 знаков после запятой и 5 значащих — безопасно для перпов
function roundPricePerp(px: number): number {
    const dec = 6;
    let p = Number(px.toFixed(dec));
    const s = p.toExponential();
    const [m, e] = s.split('e');
    const mant = Number(m).toPrecision(5);
    return Number(`${mant}e${e}`);
}

async function syncLeverageIfNeeded(symbol: string, lev: number | undefined | null) {
    if (!CFG.risk.syncLeverage || !lev) return;
    const hl = getHlClient();
    const mode = CFG.risk.leverageMode === 'cross' ? 'Cross' : 'Isolated';

    try {
        const res = await (hl.exchange as any).updateLeverage(
            symbol, // 'ETH'
            mode === 'Cross', // isCross
            lev, // leverage
        );
        if (handleHlResponse('[LEVERAGE]', res)) {
            logger.warn('[leverage] updated to', lev);
        }
    } catch (e) {
        logger.warn(`[leverage ${symbol}] update failed`, e);
    }
}

export function pickCoinDecision(raw: unknown, symbol: string): ModelCoinDecision | null {
    const coinKey = symbol.split('-')[0];
    try {
        if (!raw || typeof raw !== 'object') {
            logger.warn(`[MODEL] Invalid model response format for ${symbol}: not an object`);
            return null;
        }

        // Стандартизация структуры ответа
        const llmResponse = (raw as any).llm_response ?? raw;

        if (!llmResponse || typeof llmResponse !== 'object') {
            logger.warn(`[MODEL] Invalid model structure for ${symbol}: no llm_response object`);
            return null;
        }

        const coinData = llmResponse[coinKey];
        if (!coinData || typeof coinData !== 'object') {
            logger.warn(`[MODEL] No data for ${coinKey} in model response`);
            return null;
        }

        // Обязательная валидация критических полей
        const signal = String(coinData.signal || '').toLowerCase();

        if (!['buy', 'sell', 'hold'].includes(signal)) {
            logger.warn(`[MODEL] Invalid signal for ${coinKey}: "${signal}"`);
            return null;
        }

        // Валидация числовых полей с возможными fallback значениями
        const validateNumber = (value: any, fieldName: string, min = -Infinity, max = Infinity): number | null => {
            const num = Number(value);
            if (signal == 'hold') {
                return num;
            }

            if (Number.isFinite(num) && num >= min && num <= max) {
                return num;
            } else if (value !== undefined && value !== null) {
                logger.warn(`[MODEL] Invalid ${fieldName} value for ${coinKey}: ${value} (not in range ${min}-${max})`);
            }
            return null;
        };

        // Сборка объекта с полной валидацией
        const result: ModelCoinDecision = {
            signal: signal as 'buy' | 'sell' | 'hold',
            quantity: validateNumber(coinData.quantity, 'quantity', 0),
            profit_target: validateNumber(coinData.profit_target, 'profit_target', 0),
            stop_loss: validateNumber(coinData.stop_loss, 'stop_loss', 0),
            coin: coinKey,
            leverage: validateNumber(coinData.leverage, 'leverage', 1, CFG.risk.leverageMax * 2), // ≥1 и ≤max
            risk_usd: validateNumber(coinData.risk_usd, 'risk_usd', 0),
            risk_pct: validateNumber(coinData.risk_pct, 'risk_pct', 0, 1), // от 0 до 1 (0-100%)
            confidence: validateNumber(coinData.confidence, 'confidence', 0, 1), // от 0 до 1
            invalidation_condition: typeof coinData.invalidation_condition === 'string' ? coinData.invalidation_condition : null,
        };

        // Проверка дополнительных бизнес-условий
        if (result.signal !== 'hold') {
            const hasTpSl = !!(result.profit_target && result.stop_loss);
            const hasMinConfidence = (result.confidence ?? 0) >= (CFG.scheduler.minOpenConfidence ?? 0.6);

            if (!hasTpSl) {
                logger.warn(`[MODEL] Missing TP/SL for ${coinKey} with signal ${result.signal}`);
            }

            if (!hasMinConfidence) {
                logger.warn(`[MODEL] Confidence too low for ${coinKey}: ${result.confidence} < ${CFG.scheduler.minOpenConfidence}`);
            }
        }

        return result;
    } catch (e) {
        logger.error(`[MODEL] Error extracting decision for ${symbol}:`, e);
        return null;
    }
}

async function getOpenPosition(symbol: string): Promise<OpenPosition | null> {
    const addr = CFG.hl.walletAddress as string | undefined;
    if (!addr) {
        logger.warn(`[POS] No walletAddress in config`);
        return null;
    }
    const hl = getHlClient();

    try {
        const ch: any = (hl.info as any)?.perpetuals?.getClearinghouseState
            ? await (hl.info as any).perpetuals.getClearinghouseState(addr)
            : await (hl.info as any).getClearinghouseState?.(addr);

        const positions = ch?.assetPositions ?? ch?.perpetuals?.assetPositions ?? [];
        if (!Array.isArray(positions)) return null;

        const p = positions.map((x: any) => x?.position || x).find((p: any) => coinMatches(p, symbol));

        if (!p) return null;

        const szi = Number(p.szi ?? p.size ?? 0);
        if (!Number.isFinite(szi) || szi === 0) return null;

        const entryPx = Number(p.entryPx ?? p.entry_price ?? p.entry ?? 0) || 0;
        return { side: szi > 0 ? 'long' : 'short', qty: Math.abs(szi), entryPx };
    } catch (e) {
        logger.error(`[POS] getOpenPosition failed for ${symbol}:`, e);
        return null;
    }
}

async function getFrontendOpenOrdersSafe(userAddr: string): Promise<any[]> {
    const hl = getHlClient();
    const info: any = hl.info as any;
    try {
        let res: any;

        if (typeof info.getUserFrontendOpenOrders === 'function') {
            res = await info.getUserFrontendOpenOrders(userAddr);
        } else if (typeof info.getFrontendOpenOrders === 'function') {
            res = await info.getFrontendOpenOrders(userAddr);
        } else if (typeof info.get_orders_fe === 'function') {
            res = await info.get_orders_fe(userAddr);
        } else if (typeof info.post === 'function') {
            res = await info.post({ type: 'frontendOpenOrders', user: userAddr });
        }

        const arr = Array.isArray(res) ? res : res?.openOrders ?? res?.orders ?? [];
        return Array.isArray(arr) ? arr : [];
    } catch (e) {
        logger.warn('[FRONTEND_ORDERS] failed to fetch FE orders:', e);
        return [];
    }
}

/**
 * Открывает позицию + TP/SL одним батчем (брекет).
 * Требует grouping: "normalTpsl" и строгие типы ордеров.
 */
async function placeBracketOrders({
    symbol, // 'ETH-PERP'
    isBuy,
    qty,
    entryPx,
    tpPx,
    slPx,
}: {
    symbol: string;
    isBuy: boolean;
    qty: number;
    entryPx: number;
    tpPx: number;
    slPx: number;
}) {
    const hl = getHlClient();
    const isPerp = symbol.endsWith('-PERP');

    const szDecimals = await getSzDecimals(symbol); // напр. ETH → 4
    const sz = roundSz(symbol, qty, szDecimals);
    if (!(sz > 0)) {
        logger.error(`[BRACKET ${symbol}] qty rounded to 0. Aborting.`);
        return;
    }

    // расчёт агрессивной лимит-цены
    const refPx = Number.isFinite(entryPx) ? entryPx : await getMarkPrice(symbol);
    const build = await buildAggressiveLimitEntry({
        symbol,
        isBuy,
        qty: sz,
        refPx,
        maxSlippageBps: CFG.orders.maxEntrySlippageBps ?? 30,
        epsTicks: CFG.orders.entryEpsTicks ?? 1,
    });

    if (build.ok) {
        const ePx = build.entryPx;

        const tPx = quantizePxHL(tpPx, { isPerp });
        const sPx = quantizePxHL(slPx, { isPerp });

        // Логическая валидность TP/SL против ВХОДА
        const { tpOk, slOk } = validateBracketLevels(isBuy, ePx, tPx, sPx);
        if (!tpOk || !slOk) {
            logger.warn(`[BRACKET ${symbol}] Invalid TP/SL vs entry (entry=${ePx}, TP=${tPx}, SL=${sPx}). Aborting.`);
            return;
        }

        logger.log(`[BRACKET ${symbol}] Final order size after quantization: ${sz} (from ${qty})`);

        // ВХОД (с фолбэком)
        let filledSz = 0;
        const entryOrder = await buildIocEntryOrder(symbol, isBuy, sz, ePx, szDecimals);
        try {
            // Первая попытка — текущий IOC лимит
            const res1 = await (hl.exchange as any).placeOrder({ orders: [entryOrder] });
            if (handleHlResponse(`[ENTRY ${symbol}]`, res1)) {
                filledSz = filledSzFrom(res1);
            }

            if (filledSz <= 0 && hasIocNoMatch(res1)) {
                logger.warn(`[ENTRY ${symbol}] IOC didn't match; widening slippage and retrying...`);

                // Вторая попытка — расширяем slippage и пересчитываем лимит
                const widerBps = Math.max((CFG.orders.maxEntrySlippageBps ?? 30) * 2, 300); // >= 3%

                const rebuild = await buildAggressiveLimitEntry({
                    symbol,
                    isBuy,
                    qty: sz,
                    refPx,
                    maxSlippageBps: widerBps,
                    epsTicks: Math.max((CFG.orders.entryEpsTicks ?? 1) + 1, 2),
                });

                if (rebuild.ok) {
                    const ePx2 = rebuild.entryPx;
                    const entryOrder2 = await buildIocEntryOrder(symbol, isBuy, sz, ePx2, szDecimals);
                    const res2 = await (hl.exchange as any).placeOrder({ orders: [entryOrder2] });
                    if (handleHlResponse(`[ENTRY ${symbol} x2]`, res2)) {
                        filledSz = filledSzFrom(res2);
                    }
                    if (filledSz <= 0 && hasIocNoMatch(res2)) {
                        logger.warn(`[ENTRY ${symbol}] Still no match; falling back to MARKET...`);
                    }
                } else {
                    logger.warn(`[ENTRY ${symbol}] Rebuild with wider slippage failed (${rebuild.reason}); falling back to MARKET...`);
                }
            }

            // 1.3 Третья попытка — MARKET (НЕ РАБОТАЕТ)
            // if (filledSz <= 0) {
            //     const entryMarket = await buildMarketEntryOrder(symbol, isBuy, sz, szDecimals);

            //     const res3 = await (hl.exchange as any).placeOrder({ orders: [entryMarket], grouping: 'na' });
            //     if (handleHlResponse(`[ENTRY ${symbol} MARKET]`, res3)) {
            //         filledSz = filledSzFrom(res3);
            //     }
            // }
        } catch (e: any) {
            const deep = e?.response?.data ?? e;
            logger.error(`[ENTRY ${symbol}] Failed to place entry:`, deep);
            return;
        }

        if (!(filledSz > 0) || filledSz === 0) {
            logger.error(`[ENTRY ${symbol}] aborted: entry not filled at any tier`);
            return;
        }

        // УСТАНОВКА TP/SL ПОД ФАКТИЧЕСКИЙ ОБЪЁМ
        try {
            if (!Number.isFinite(tPx) || !Number.isFinite(sPx)) {
                logger.error(`[UPDATE ${symbol}] Invalid TP or SL price: TP=${tPx}, SL=${sPx}. Aborting.`);
                return;
            }

            const roundedTpPx = roundPricePerp(tPx);
            const roundedSlPx = roundPricePerp(sPx);

            const orders = [
                {
                    coin: symbol,
                    is_buy: !isBuy,
                    sz: filledSz,
                    limit_px: roundedTpPx,
                    reduce_only: true,
                    order_type: { trigger: { triggerPx: roundedTpPx, isMarket: true, tpsl: 'tp' } },
                },
                {
                    coin: symbol,
                    is_buy: !isBuy,
                    sz: filledSz,
                    limit_px: roundedSlPx,
                    reduce_only: true,
                    order_type: { trigger: { triggerPx: roundedSlPx, isMarket: true, tpsl: 'sl' } },
                },
            ];

            // console.log('Orders to place:', JSON.stringify(orders));
            const resTpSl = await (hl.exchange as any).placeOrder({ orders, grouping: 'positionTpsl' });
            handleHlResponse(`[UPDATE ${symbol}]`, resTpSl);
        } catch (e: any) {
            const deep = e?.response?.data ?? e;
            logger.error(`[UPDATE ${symbol}] Failed to place TP/SL:`, deep);
        }
    } else {
        if (build.reason === 'NO_LIQUIDITY') {
            logger.error(`[BRACKET ${symbol}] no liquidity/BBO unavailable — skip`);
        } else {
            logger.error(`[BRACKET ${symbol}] slippage cap too tight or size rounded to zero`);
        }
        return;
    }
}

async function cancelAllOrdersForSymbol(symbol: string): Promise<boolean> {
    const hl = getHlClient();
    const userAddress = CFG.hl.walletAddress;
    if (!userAddress) {
        logger.warn(`[CANCEL_ALL ${symbol}] Wallet address not configured, cannot cancel orders.`);
        return false;
    }

    // Пробуем high-level кастом из SDK
    try {
        await (hl.custom as any).cancelAllOrders(symbol);
        logger.log(`[CANCEL_ALL ${symbol}] All open orders cancelled via custom.cancelAllOrders.`);
        return true;
    } catch (e) {
        logger.error(`[CANCEL_ALL ${symbol}] custom.cancelAllOrders failed:`, e);
    }

    // Фоллбэк: точечная отмена по oid/cloid
    try {
        const openOrders: any[] = await hl.info.getUserOpenOrders(userAddress);

        const toCancel = openOrders
            .filter((o: any) => coinMatches(o.coin, symbol))
            .map((o: any) => ({ oid: o.oid ?? o.orderId, cloid: o.cloid }))
            .filter((x: any) => x.oid != null || x.cloid != null);

        for (const c of toCancel) {
            try {
                if (c.oid != null) {
                    await (hl.exchange as any).cancelOrder({ coin: symbol, o: c.oid });
                } else if (c.cloid) {
                    await (hl.exchange as any).cancelOrderByCloid({ coin: symbol, cloid: c.cloid });
                }
            } catch (err) {
                logger.warn(`[CANCEL_ALL ${symbol}] Failed to cancel ${c.oid ?? c.cloid}:`, err);
                return false; // FAIL-FAST
            }
        }
        logger.log(`[CANCEL_ALL ${symbol}] Fallback loop: cancelled ${toCancel.length} orders.`);
        return true;
    } catch (err) {
        logger.error(`[CANCEL_ALL ${symbol}] Fallback cancel loop also failed:`, err);
        return false;
    }
}

async function cancelTpSlOrders(symbol: string): Promise<boolean> {
    const hl = getHlClient();
    const userAddress = CFG.hl.walletAddress as string | undefined;
    if (!userAddress) {
        logger.warn(`[CANCEL ${symbol}] Wallet address not configured`);
        return false;
    }

    try {
        const feOrders = await getFrontendOpenOrdersSafe(userAddress);

        // Сохраняем И oid, и cloid
        const toCancel = feOrders
            .filter((o: any) => coinMatches(o, symbol))
            .filter((o: any) => o.isPositionTpsl === true || o.isTrigger === true || o.reduceOnly === true || o.reduce_only === true)
            .map((o: any) => ({
                oid: o.oid ?? o.orderId ?? o.resting?.oid ?? null,
                cloid: o.cloid ?? null,
            }))
            .filter((x: any) => x.oid != null || x.cloid != null);

        if (toCancel.length === 0) {
            logger.log(`[CANCEL ${symbol}] No TP/SL to cancel.`);
            return true;
        }

        logger.log(`[CANCEL ${symbol}] Found ${toCancel.length} TP/SL orders to cancel.`);

        let okCount = 0;
        for (const c of toCancel) {
            try {
                if (c.oid != null) {
                    const res = await (hl.exchange as any).cancelOrder({ coin: symbol, o: c.oid });
                    if (res?.status === 'ok') okCount++;
                    else logger.warn(`[CANCEL ${symbol}] cancelOrder non-ok:`, res?.response?.data ?? res);
                } else if (c.cloid) {
                    const res = await (hl.exchange as any).cancelOrderByCloid({ coin: symbol, cloid: c.cloid });
                    if (res?.status === 'ok') okCount++;
                    else logger.warn(`[CANCEL ${symbol}] cancelOrderByCloid non-ok:`, res?.response?.data ?? res);
                }
            } catch (err) {
                logger.warn(`[CANCEL ${symbol}] Failed to cancel ${c.oid ?? c.cloid}:`, err);
                return false;
            }
        }

        // Верификация: пересчитываем, что по символу не осталось TP/SL
        const feAfter = await getFrontendOpenOrdersSafe(userAddress);
        const still = feAfter
            .filter((o: any) => coinMatches(o, symbol))
            .filter((o: any) => o.isPositionTpsl === true || o.isTrigger === true || o.reduceOnly === true || o.reduce_only === true);

        if (still.length > 0) {
            logger.error(`[CANCEL ${symbol}] ${still.length} TP/SL still present after cancel. Aborting.`);
            return false;
        }

        logger.log(`[CANCEL ${symbol}] Cancelled ${okCount}/${toCancel.length} TP/SL orders.`);
        return okCount === toCancel.length;
    } catch (e) {
        logger.error(`[CANCEL ${symbol}] Error cancelling TP/SL:`, e);
        return false;
    }
}

export async function applyDecisionForSymbol(rawModel: unknown, markPx: number, symbol = 'BTC-PERP', account: AccountSummary) {
    const coin = baseFromSymbol(symbol);
    const d = pickCoinDecision(rawModel, symbol);
    if (!d) {
        // logger.log(`[DECISION ${coin}] No decision found in model response. Skipping.`);
        return;
    }

    const newSide = sideFromSignal(d.signal); // 'long' | 'short' | 'flat'

    // HOLD вообще ничего не делаем
    if (newSide === 'flat') {
        // logger.log(`[DECISION ${coin}] HOLD, no action`);
        return false;
    } else {
        logger.log(`[DECISION ${coin}]`, d);
    }

    const hl = getHlClient();

    const policy = CFG.scheduler.signalPolicy; // 'ignore' | 'update_tp_sl' | 'flip_if_confident'

    // Сохраняем в БД, если это не 'hold'
    if (d.signal === 'buy' || d.signal === 'sell') {
        try {
            const decision = new DecisionModel(d);
            await decision.save();
            // logger.log('[DB] Решение сохранено в MongoDB.');
        } catch (error) {
            logger.error('[DB] Ошибка сохранения решения в MongoDB:', error);
        }
    }

    const userAddr = CFG.hl.walletAddress!;
    const pos = await getOpenPosition(symbol);
    // const base = baseFromSymbol(symbol);

    // Проверяем открытые ордера
    const openOrders: any[] = await hl.info.getUserOpenOrders(userAddr);
    const hasPendingEntry = openOrders.some((o) => coinMatches(o, symbol) && (o.reduceOnly === false || o.reduce_only === false));

    //Политика 'ignore'
    if (policy === 'ignore') {
        if (pos || hasPendingEntry) {
            logger.log(`[POLICY=ignore ${coin}] Position or pending entry exists -> skip.`);
            return;
        }
        // позиция отсутствует и входа нет — можно открыть
        await openAccordingToDecision(symbol, d, markPx, account);
        return;
    }

    if (policy === 'update_tp_sl' || policy === 'flip_if_confident' || policy === 'flip_and_update') {
        if (pos) {
            const sameDirection = (pos.side === 'long' && newSide === 'long') || (pos.side === 'short' && newSide === 'short');

            if (sameDirection) {
                logger.log(`[UPDATE ${coin}] Same direction signal -> updating TP/SL only.`);
                await updateTargets(symbol, pos, d);
                return;
            }

            const canFlip = policy === 'flip_if_confident' || policy === 'flip_and_update';
            const confidence = (d.confidence ?? 0) >= CFG.scheduler.flipConfidence;

            if (!canFlip) {
                logger.log(`[UPDATE ${coin}] Opposite signal but flip not allowed by policy. Updating TP/SL only.`);
                await updateTargets(symbol, pos, d);
                return;
            }

            if (!confidence) {
                logger.log(`[UPDATE ${coin}] Opposite signal but flip not allowed by confidence ${d.confidence}/${CFG.scheduler.flipConfidence}.`);
                return;
            }

            logger.log(`[UPDATE ${coin}] Opposite signal with flip allowed -> flipping position.`);

            const cancelled = await cancelTpSlOrders(symbol);
            if (!cancelled) {
                logger.error('[UPDATE] abort: failed to cancel existing TP/SL');
                return;
            }
            await closePositionMarket(symbol, pos);

            // проверяем, что позиция действительно закрылась перед открытием новой
            let closingAttempts = 0;
            const maxAttempts = 5;
            let positionClosed = false;

            while (closingAttempts < maxAttempts) {
                await new Promise((resolve) => setTimeout(resolve, 1000));
                const currentPosition = await getOpenPosition(symbol);

                if (!currentPosition) {
                    positionClosed = true;
                    logger.log(`[POLICY ${symbol}] Позиция успешно закрыта, можно открывать новую`);
                    break;
                }

                closingAttempts++;
                logger.warn(`[POLICY ${symbol}] Ожидание закрытия позиции, попытка ${closingAttempts}/${maxAttempts}`);
            }

            if (positionClosed) {
                await openAccordingToDecision(symbol, d, markPx, account);
            } else {
                logger.error(`[POLICY ${symbol}] Не удалось закрыть позицию перед открытием новой. Отмена операции.`);
            }
            return;
        }

        // позиции нет. Если есть висящий вход — пересоздаём его под новые цены/цели
        if (hasPendingEntry) {
            logger.log(`[UPDATE ${coin}] Pending entry exists -> cancel and recreate with new params.`);
            await cancelAllOrdersForSymbol(symbol);
            await openAccordingToDecision(symbol, d, markPx, account);
            return;
        }

        // открываем новую позицию
        await openAccordingToDecision(symbol, d, markPx, account);
        return;
    }
}

async function openAccordingToDecision(symbol: string, d: ModelCoinDecision, markPx: number, account: AccountSummary) {
    const coin = baseFromSymbol(symbol);

    // Проверка на минимальную уверенность для открытия новой позиции
    const confidence = d.confidence ?? 0;
    if (confidence < CFG.scheduler.minOpenConfidence) {
        logger.log(`[OPEN ${coin}] Signal confidence ${confidence} is below minOpenConfidence ${CFG.scheduler.minOpenConfidence}. Skipping.`);
        return;
    }

    const isBuy = d.signal === 'buy';

    // Подстраховка валидности целей
    const tpPx = d.profit_target ?? null;
    const slPx = d.stop_loss ?? null;
    if (tpPx != null && slPx != null) {
        if (isBuy && (slPx >= markPx || tpPx <= markPx)) {
            logger.error(`[FATAL ${coin}] Invalid LONG: SL must be < mark, TP > mark. Aborting.`);
            return;
        }
        if (!isBuy && (slPx <= markPx || tpPx >= markPx)) {
            logger.error(`[FATAL ${coin}] Invalid SHORT: SL must be > mark, TP < mark. Aborting.`);
            return;
        }
    }

    // Определяем безопасное целевое плечо
    const leverageFromModel = d.leverage ?? CFG.risk.leverageMax;
    const targetLeverage = Math.min(leverageFromModel, CFG.risk.leverageMax);
    logger.log(`[LEVERAGE ${coin}] Model wants: ${d.leverage}, Config max: ${CFG.risk.leverageMax}. Using: ${targetLeverage}`);

    // Синхронизируем это плечо с биржей
    await syncLeverageIfNeeded(symbol, targetLeverage);

    // Сайзинг
    const sizeInfo = computeSizeUsd({
        mode: CFG.risk.mode,
        accountValue: account.accountValue,
        markPx,
        quantityUnitsFromModel: d.quantity ?? null,
        riskUsdFromModel: d.risk_usd ?? null,
        stopLossPx: slPx ?? null,
        leverageFromModel: targetLeverage,
    });

    // Проверка доступной маржи
    const freeMargin = account.accountValue - account.totalMarginUsed;
    const requiredMargin = sizeInfo.sizeUsd / targetLeverage;

    if (requiredMargin > freeMargin) {
        logger.error(
            `[OPEN ${coin}] Not enough free margin to open position for ${symbol}. Required: ${requiredMargin.toFixed(2)} USD, Available: ${freeMargin.toFixed(
                2,
            )} USD. Aborting.`,
        );
        return;
    }

    const qty = sizeInfo.qtyUnits ?? sizeInfo.sizeUsd / markPx;
    const slip = (CFG.orders.entrySlippagePct ?? 0.05) / 100;
    const entryPx = isBuy ? markPx * (1 + slip) : markPx * (1 - slip);

    await placeBracketOrders({
        symbol,
        isBuy,
        qty,
        entryPx,
        tpPx: tpPx ?? (isBuy ? markPx * (1 + CFG.risk.defaultTpPct / 100) : markPx * (1 - CFG.risk.defaultTpPct / 100)),
        slPx: slPx ?? (isBuy ? markPx * (1 - CFG.risk.defaultSlPct / 100) : markPx * (1 + CFG.risk.defaultSlPct / 100)),
    });
}

async function updateTargets(symbol: string, pos: OpenPosition, d: ModelCoinDecision) {
    const hl = getHlClient();
    const isBuy = pos.side === 'long';
    const mark = await getMarkPrice(symbol);

    // Кандидаты новых целей
    const wantTp = Number.isFinite(d.profit_target) ? roundPricePerp(d.profit_target!) : null;
    const wantSl = Number.isFinite(d.stop_loss) ? roundPricePerp(d.stop_loss!) : null;

    // Валидность новых целей относительно текущей цены
    const tpOk = wantTp != null && (isBuy ? wantTp > mark : wantTp < mark);
    const slOk = wantSl != null && (isBuy ? wantSl < mark : wantSl > mark);

    // Читаем существующие цели
    const cur = await getCurrentTargets(symbol, pos.side, pos.qty);

    // Если обе новые цели невалидные, не трогаем текущие!
    if (!tpOk && !slOk) {
        logger.warn(`[UPDATE ${symbol}] New TP/SL invalid -> keep current targets intact. Skip.`);
        return;
    }

    // Определяем, что реально нужно менять
    const needTp = tpOk && (!cur.tp || !almostEqualPx(symbol, cur.tp.px, wantTp!) || !almostEqualSz(symbol, cur.tp.sz, pos.qty));
    const needSl = slOk && (!cur.sl || !almostEqualPx(symbol, cur.sl.px, wantSl!) || !almostEqualSz(symbol, cur.sl.sz, pos.qty));

    // Если ничего не меняется — выходим
    if (!needTp && !needSl) {
        logger.log(`[UPDATE ${symbol}] Targets unchanged (same px and size) -> skip.`);
        return;
    }

    // Отменяем то, что реально меняем
    const toCancel: number[] = [];
    if (needTp && cur.tp?.oid != null) toCancel.push(cur.tp.oid);
    if (needSl && cur.sl?.oid != null) toCancel.push(cur.sl.oid);

    if (toCancel.length > 0) {
        const ok = await cancelSpecificOrders(symbol, toCancel);
        if (!ok) {
            logger.error(`[UPDATE ${symbol}] abort: failed to cancel changed TP/SL.`);
            return;
        }
    }

    // Ставим изменившиеся цели
    const orders: any[] = [];
    if (needTp && tpOk) {
        orders.push({
            coin: symbol,
            is_buy: !isBuy,
            sz: pos.qty,
            limit_px: wantTp!,
            reduce_only: true,
            order_type: { trigger: { triggerPx: wantTp!, isMarket: true, tpsl: 'tp' } },
        });
    }
    if (needSl && slOk) {
        orders.push({
            coin: symbol,
            is_buy: !isBuy,
            sz: pos.qty,
            limit_px: wantSl!,
            reduce_only: true,
            order_type: { trigger: { triggerPx: wantSl!, isMarket: true, tpsl: 'sl' } },
        });
    }

    if (orders.length === 0) {
        logger.log(`[UPDATE ${symbol}] After checks, nothing to place.`);
        return;
    }

    const res = await (hl.exchange as any).placeOrder({ orders, grouping: 'positionTpsl' });
    if (!handleHlResponse('[UPDATE]', res)) {
        logger.error('[UPDATE] abort: some TP/SL returned error.');
        return;
    }

    // Верификация - что цели действительно появились
    const fe = await getFrontendOpenOrdersSafe(CFG.hl.walletAddress!);
    const placed = fe
        .filter((o: any) => coinMatches(o, symbol))
        .filter((o: any) => o.isTrigger === true || o.isPositionTpsl === true || o.reduceOnly === true || o.reduce_only === true);
    if (placed.length === 0) {
        logger.error(`[UPDATE ${symbol}] verification failed: no TP/SL detected after placement.`);
    } else {
        logger.log(`[UPDATE ${symbol}] TP/SL placed (${placed.length}) for ${symbol}.`);
    }
}

async function closePositionMarket(symbol: string, pos: OpenPosition) {
    const hl = getHlClient();
    const slippage = CFG.orders.entrySlippagePct / 100;
    const markPx = await getMarkPrice(symbol);
    const px = markPx * (1 + (pos.side === 'short' ? 1 : -1) * slippage);

    const order = {
        coin: symbol,
        is_buy: pos.side === 'short',
        sz: pos.qty,
        limit_px: roundPricePerp(px),
        order_type: { limit: { tif: 'Ioc' } },
        reduce_only: true,
    };

    logger.log(`[CLOSE ${symbol}] Closing position with order:`, order);

    const res = await (hl.exchange as any).placeOrder({
        orders: [order],
        grouping: 'na',
    });

    handleHlResponse(`[CLOSE ${symbol}]`, res);
}

function sideFromSignal(sig: 'buy' | 'sell' | 'hold'): 'long' | 'short' | 'flat' {
    if (sig === 'buy') return 'long';
    if (sig === 'sell') return 'short';
    return 'flat';
}

/**
 * Универсальный сайзинг по двум режимам:
 * - fixed: берём POSITION_USD
 * - risk_pct: считаем из risk_pct и stop_loss_pct (процент до SL)
 */
function computeSizeUsd(params: {
    mode: 'fixed' | 'risk_pct';
    accountValue: number;
    markPx: number;
    quantityUnitsFromModel?: number | null;
    sizeUsdFromModel?: number | null;
    riskUsdFromModel?: number | null;
    riskPctFromModel?: number | null; // 0.01 = 1%
    stopLossPx?: number | null;
    leverageFromModel?: number | null;
}): { sizeUsd: number; riskUsd: number; targetLeverage?: number; qtyUnits?: number } {
    const { mode, accountValue, markPx, quantityUnitsFromModel, sizeUsdFromModel, riskUsdFromModel, riskPctFromModel, stopLossPx, leverageFromModel } = params;

    const minOrderUsd = CFG.risk.minOrderUsd;

    // Динамический расчет maxOrderUsd
    const numSymbols = CFG.symbols.list.length > 0 ? CFG.symbols.list.length : 1;
    const dynamicMaxOrderUsdBySymbols = Math.floor(accountValue / numSymbols);
    const dynamicMaxOrderUsdByRiskCap = Math.floor(accountValue / 3); // Не более 1/3 баланса
    const dynamicMaxOrderUsd = Math.min(dynamicMaxOrderUsdBySymbols, dynamicMaxOrderUsdByRiskCap);
    logger.log(
        `[SIZING] Dynamic max order size: ${dynamicMaxOrderUsd.toFixed(2)} USD | Symbols cap: ${dynamicMaxOrderUsdBySymbols.toFixed(
            2,
        )} USD | Risk cap (1/3): ${dynamicMaxOrderUsdByRiskCap.toFixed(2)} USD`,
    );

    const clampUsd = (x: number) => Math.max(minOrderUsd, Math.min(dynamicMaxOrderUsd, x));

    // FIXED
    if (mode === 'fixed') {
        if (CFG.risk.acceptModelSizing) {
            // приоритет: quantity → risk_usd+SL → size_usd → fallback fixed
            if (quantityUnitsFromModel && quantityUnitsFromModel > 0 && markPx > 0) {
                const sizeUsd = clampUsd(quantityUnitsFromModel * markPx);
                return { sizeUsd, riskUsd: riskUsdFromModel ?? 0, qtyUnits: sizeUsd / markPx };
            }
            if (riskUsdFromModel && stopLossPx && markPx > 0) {
                const dist = Math.abs(markPx - stopLossPx);
                if (dist > 0) {
                    const sizeUsd = clampUsd((riskUsdFromModel / dist) * markPx);
                    return { sizeUsd, riskUsd: riskUsdFromModel, qtyUnits: sizeUsd / markPx };
                }
            }
            if (sizeUsdFromModel && sizeUsdFromModel > 0) {
                const sizeUsd = clampUsd(sizeUsdFromModel);
                return { sizeUsd, riskUsd: 0, qtyUnits: sizeUsd / markPx };
            }
        }
        // модель игнорируем, строго фикс
        const sizeUsd = clampUsd(CFG.risk.positionUsd);
        return { sizeUsd, riskUsd: 0, qtyUnits: sizeUsd / markPx };
    }

    // RISK %
    if (!stopLossPx || !markPx || markPx <= 0) {
        logger.warn('[SIZING] risk_pct requires stopLossPx and markPx; fallback to fixed');
        const sizeUsd = clampUsd(CFG.risk.positionUsd);
        return { sizeUsd, riskUsd: 0, qtyUnits: sizeUsd / markPx };
    }

    const dist = Math.abs(markPx - stopLossPx);
    if (!(dist > 0)) {
        logger.warn('[SIZING] SL distance too small; fallback to fixed');
        const sizeUsd = clampUsd(CFG.risk.positionUsd);
        return { sizeUsd, riskUsd: 0, qtyUnits: sizeUsd / markPx };
    }

    // берём risk_pct: из модели, иначе константу
    const minPct = CFG.risk.riskPctMin;
    const maxPct = CFG.risk.riskPctMax;
    const defaultPct = CFG.risk.riskPctDefault; // 0.05 = 5%

    const chosenPct = CFG.risk.acceptModelSizing
        ? riskPctFromModel != null
            ? clamp(riskPctFromModel, minPct, maxPct)
            : clamp(defaultPct, minPct, maxPct)
        : clamp(defaultPct, minPct, maxPct);

    const riskUsd = accountValue * chosenPct;

    // размер позиции по риск-менеджменту
    let sizeUsd = (riskUsd / dist) * markPx;

    // Определяем максимально допустимое плечо (из модели или конфига)
    const maxLeverageAllowed = Math.min(params.leverageFromModel ?? CFG.risk.leverageMax, CFG.risk.leverageMax);

    // Рассчитываем максимальный размер позиции в USD, который позволяет это плечо
    const maxSizeByLeverage = accountValue * maxLeverageAllowed;

    // Если рассчитанный по риску размер превышает лимит по плечу, урезаем его
    if (sizeUsd > maxSizeByLeverage) {
        logger.log(`[SIZING] Size ${sizeUsd.toFixed(2)} USD exceeds max leverage limit. Capping to ${maxSizeByLeverage.toFixed(2)} USD.`);
        sizeUsd = maxSizeByLeverage;
    }

    sizeUsd = clampUsd(sizeUsd);
    return { sizeUsd, riskUsd, targetLeverage: maxLeverageAllowed, qtyUnits: sizeUsd / markPx };
}
