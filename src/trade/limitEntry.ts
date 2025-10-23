// src/trade/limitEntry.ts
import { getBbo } from '../hl/bbo.js';
// import { getMarkPrice } from '../hl/market.js';
import { hlTickStepForPrice, quantizePxHLSide, quantizeSzHL, quantizePxHL } from '../utils/hlQuantize.js';
import { getSzDecimals } from '../hl/precision.js';

export type AggressiveLimitParams = {
    symbol: string; // 'BTC-PERP'
    isBuy: boolean;
    qty: number; // размер до квантования
    refPx: number; // обычно mark или mid
    maxSlippageBps: number;
    epsTicks?: number; // 1–3 тика
};

export type AggressiveLimitBuild =
    | { ok: true; entryPx: number; sz: number; crossedFrom?: string; usedCapPx?: number }
    | { ok: false; reason: 'NO_LIQUIDITY' | 'SIZE_ZERO'; needAtLeastBps?: number };

// function baseCoin(symbol: string) {
//   const i = symbol.indexOf('-');
//   return i > 0 ? symbol.slice(0, i).toUpperCase() : symbol.toUpperCase();
// }

const isPerp = (s: string) => /-PERP/i.test(s);

export async function buildAggressiveLimitEntry(p: AggressiveLimitParams): Promise<AggressiveLimitBuild> {
    const { symbol, isBuy, qty, refPx } = p;
    const epsTicks = Math.max(1, p.epsTicks ?? 2);

    const szDecimals = await getSzDecimals(symbol);
    const sz = quantizeSzHL(qty, szDecimals);
    if (!(sz > 0)) return { ok: false, reason: 'SIZE_ZERO' };

    const bbo = await getBbo(symbol);

    const tick = hlTickStepForPrice(refPx, { isPerp: isPerp(symbol) });

    const capBps = bbo.source === 'synthetic' ? Math.max(p.maxSlippageBps, 60) : p.maxSlippageBps;
    const capPx = refPx * (1 + (isBuy ? +capBps : -capBps) / 10_000);

    let entryPxRaw: number;
    if (isBuy) {
        const base = bbo.bestAsk ?? capPx;
        entryPxRaw = Math.min(capPx, base + epsTicks * tick);
    } else {
        const base = bbo.bestBid ?? capPx;
        entryPxRaw = Math.max(capPx, base - epsTicks * tick);
    }

    let entryPx = quantizePxHLSide(entryPxRaw, isBuy, { isPerp: isPerp(symbol) });

    // Гарантированно пересечь стакан (на случай равенства после округления)
    if (bbo.source !== 'synthetic') {
        if (isBuy && bbo.bestAsk && entryPx <= bbo.bestAsk) {
            entryPx = quantizePxHLSide(bbo.bestAsk + tick, true, { isPerp: isPerp(symbol) });
        }
        if (!isBuy && bbo.bestBid && entryPx >= bbo.bestBid) {
            entryPx = quantizePxHLSide(bbo.bestBid - tick, false, { isPerp: isPerp(symbol) });
        }
    }

    const crossedFrom = isBuy ? `ask=${bbo.bestAsk}` : `bid=${bbo.bestBid}`;
    const usedCapPx = capPx;

    if (!(sz > 0)) return { ok: false, reason: 'SIZE_ZERO' };

    return {
        ok: true,
        entryPx,
        sz,
        crossedFrom,
        usedCapPx,
    };
}

export async function buildIocEntryOrder(symbol: string, isBuy: boolean, szRaw: number, entryPx: number, szDecimals?: number) {
    if (!szDecimals) szDecimals = await getSzDecimals(symbol);
    const sz = quantizeSzHL(szRaw, szDecimals);
    if (!(sz > 0)) throw new Error('Size rounded to 0');

    return {
        coin: symbol,
        is_buy: isBuy,
        sz,
        limit_px: entryPx,
        reduce_only: false,
        order_type: { limit: { tif: 'Ioc' } as const },
    };
}

// export async function buildMarketEntryOrder(symbol: string, isBuy: boolean, szRaw: number, szDecimals?: number) {
//     if (!szDecimals) szDecimals = await getSzDecimals(symbol);
//     const sz = quantizeSzHL(szRaw, szDecimals);
//     if (!(sz > 0)) throw new Error('Size rounded to 0');

//     // const coin = symbol.split('-')[0].toUpperCase();

//     return {
//         coin: symbol,
//         is_buy: isBuy,
//         sz,
//         limit_px: 0,
//         reduce_only: false,
//         order_type: { market: {} as const },
//     };
// }
