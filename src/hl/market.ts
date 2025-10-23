// src/hl/market.ts
import { getHlClient } from '../hl/client.js';
import type { Candle, FundingOi } from '../types.js';

export type Interval = '1m' | '3m' | '5m' | '15m' | '1h' | '4h';

function intervalMs(interval: Interval): number {
    switch (interval) {
        case '1m':
            return 60_000;
        case '3m':
            return 180_000;
        case '5m':
            return 300_000;
        case '15m':
            return 900_000;
        case '1h':
            return 3_600_000;
        case '4h':
            return 14_400_000;
        default:
            throw new Error(`Unsupported interval: ${interval}`);
    }
}

/**
 * Свечи через корректную сигнатуру getCandleSnapshot:
 * позиционные аргументы: (coin, interval, startTime, endTime, limit?)
 */
export async function getCandles(coin: string, interval: Interval, points: number): Promise<Candle[]> {
    const endTime = Date.now();
    const startTime = endTime - intervalMs(interval) * (points + 50);
    const hl = getHlClient();

    const raw: any[] = await hl.info.getCandleSnapshot(coin, interval, startTime, endTime);

    const sliced = raw.slice(-points);
    return sliced.map((c: any) => ({
        t: Number(c.t),
        o: Number(c.o),
        h: Number(c.h),
        l: Number(c.l),
        c: Number(c.c),
        v: Number(c.v),
        // Опциональные поля (если понадобятся)
        T: c.T !== undefined ? Number(c.T) : undefined,
        i: c.i,
        s: c.s,
        n: c.n !== undefined ? Number(c.n) : undefined,
    }));
}

/** Funding/ OI через perpetuals.getMetaAndAssetCtxs() */
export async function getFundingAndOI(coin: string): Promise<FundingOi> {
    const hl = getHlClient();
    const ctx: any = await hl.info.perpetuals.getMetaAndAssetCtxs();

    const universe: Array<{ name: string }> = ctx?.universe ?? ctx?.perpetuals?.universe ?? ctx?.[0]?.universe ?? [];

    const idx = universe.findIndex((u: { name: string }) => u?.name === coin);
    if (idx < 0) throw new Error(`Coin ${coin} not found in perpetuals universe`);

    const assetCtxs: any[] = ctx?.perpetuals?.assetCtxs ?? ctx?.assetCtxs ?? ctx?.[1] ?? [];

    const row = assetCtxs[idx] ?? {};
    return {
        openInterestLatest: Number(row.openInterest ?? row.oi ?? 0),
        fundingRate: Number(row.funding ?? row.fundingRate ?? 0),
        markPx: Number(row.markPx ?? row.markPrice ?? 0),
    };
}

/** Текущий mid-price: getAllMids() → Record<string,string> */
export async function getMarkPrice(symbolOrCoin: string): Promise<number> {
    const hl = getHlClient();
    const mids: Record<string, string> = await hl.info.getAllMids();

    // Убираем возможный суффикс, чтобы работать с чистым именем монеты
    const baseCoin = symbolOrCoin.split('-')[0]; // 'ETH-PERP' -> 'ETH', 'ETH' -> 'ETH'
    const perpSymbol = `${baseCoin}-PERP`; // 'ETH-PERP'

    // Проверяем сначала полное имя, потом чистое
    const key = perpSymbol in mids ? perpSymbol : baseCoin in mids ? baseCoin : '';

    if (!key) {
        throw new Error(`Mid price not found for ${baseCoin}`);
    }
    return parseFloat(mids[key]);
}
