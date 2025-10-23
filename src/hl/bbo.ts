import { getHlClient } from '../hl/client.js';
import { getMarkPrice } from './market.js';

type Bbo = { bestBid: number | null; bestAsk: number | null; source: 'orderbook' | 'synthetic' };

// базовый тикер из 'ETH-PERP' -> 'ETH'
function baseFromSymbol(sym: string) {
    const i = sym.indexOf('-');
    return i > 0 ? sym.slice(0, i) : sym;
}

function pickTop(rows: any[]): number | null {
    if (!Array.isArray(rows) || !rows.length) return null;
    const r = rows[0];
    const px = Array.isArray(r) ? r[0] : typeof r === 'object' ? r.px ?? r.price ?? r[0] : r;
    const n = Number(px);
    return Number.isFinite(n) && n > 0 ? n : null;
}

export async function getBbo(symbol: string): Promise<Bbo> {
    const hl = getHlClient();
    const coin = baseFromSymbol(symbol);
    console.log(`[BBO] Getting orderbook for ${symbol} (base: ${coin})`);
    const info: any = hl.info as any;

    // набор стратегий вызова: сначала дериватив, потом базовый
    const candidates: Array<{ path: string; arg: string }> = [
        { path: 'perpetuals.getOrderbook', arg: symbol },
        { path: 'perpetuals.getOrderbook', arg: coin },
        { path: 'getOrderbook', arg: symbol },
        { path: 'getOrderbook', arg: coin },
        { path: 'orderbook', arg: symbol },
        { path: 'orderbook', arg: coin },
        { path: 'getDepth', arg: symbol },
        { path: 'getDepth', arg: coin },
        { path: 'getL2', arg: symbol },
        { path: 'getL2', arg: coin },
    ];

    for (const { path, arg } of candidates) {
        try {
            const fn = path.split('.').reduce((acc: any, k: string) => acc?.[k], info);
            if (typeof fn !== 'function') continue;

            const ob = await fn(arg);
            if (!ob) continue;

            const bids = ob?.bids ?? ob?.Bids ?? ob?.buy ?? ob?.bid ?? ob?.[0]?.bids ?? [];
            const asks = ob?.asks ?? ob?.Asks ?? ob?.sell ?? ob?.ask ?? ob?.[0]?.asks ?? [];

            const bestBid = pickTop(bids);
            const bestAsk = pickTop(asks);
            if (bestBid || bestAsk) {
                console.log(`[BBO] Found prices from orderbook via ${path}(${arg}): bid=${bestBid}, ask=${bestAsk}`);
                return { bestBid: bestBid ?? null, bestAsk: bestAsk ?? null, source: 'orderbook' };
            }
        } catch {
            /* try next */
        }
    }

    // fallback — синтетика от mark, но отдаём пометку source='synthetic'
    try {
        const markPrice = await getMarkPrice(symbol);
        console.log(`[BBO] Using synthetic BBO from markPrice: ${markPrice}`);
        const spread = 0.002; // 0.2%
        const bid = markPrice * (1 - spread / 2);
        const ask = markPrice * (1 + spread / 2);
        return { bestBid: bid, bestAsk: ask, source: 'synthetic' };
    } catch (e) {
        console.error('[BBO] Failed to get mark price:', e);
    }

    return { bestBid: null, bestAsk: null, source: 'synthetic' };
}
