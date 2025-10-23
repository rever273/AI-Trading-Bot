// src/hl/precision.ts
import { getHlClient } from '../hl/client.js';
import { sleep } from '../utils/functions.js';

const _szCache: Record<string, number> = {};
let _lastBuilt = 0;
const TTL_MS = 60 * 60 * 1000;

// fallback для популярных активов
const FALLBACK_SZ_DECIMALS: Record<string, number> = {
    'BTC-PERP': 5,
    'ETH-PERP': 4,
    'SOL-PERP': 2,
    'BNB-PERP': 3,
    'XRP-PERP': 0,
    'DOGE-PERP': 0,
    'NEAR-PERP': 1,
};

const HYPHENS = /[\u2010\u2011\u2012\u2013\u2014\u2212]/g;
const base = (sym: string) => sym.replace(HYPHENS, '-').split('-')[0].trim().toUpperCase();

async function getMetaWithRetry(maxAttempts = 3) {
    const hl = getHlClient();
    let attempt = 0,
        lastErr: unknown;
    while (attempt < maxAttempts) {
        try {
            const meta: any = await hl.info.perpetuals.getMeta();
            return meta;
        } catch (e) {
            lastErr = e;
            attempt++;
            const backoff = Math.min(1500 * 2 ** (attempt - 1), 6000) + Math.random() * 200;
            await sleep(backoff);
        }
    }
    throw lastErr;
}

function ingestEntry(entry: any) {
    const nameRaw = entry?.name ?? entry?.symbol ?? entry?.asset ?? entry;
    if (!nameRaw) return;

    const key = String(nameRaw).toUpperCase();

    const decRaw = entry?.szDecimals ?? entry?.sz_decimals ?? entry?.sizeDecimals ?? entry?.size_decimals ?? entry?.sz_precision ?? entry?.quantityDecimals;

    const decNum = decRaw == null ? NaN : Number(decRaw);
    if (Number.isFinite(decNum)) {
        _szCache[key] = decNum;
    }
}

async function rebuildIfNeeded(force = false) {
    const now = Date.now();
    if (!force && now - _lastBuilt < TTL_MS && Object.keys(_szCache).length) return;

    const meta: any = await getMetaWithRetry(3);

    // Универсальные ветки
    const uni = meta?.universe ?? meta?.perpetuals?.universe ?? (Array.isArray(meta) ? meta[0]?.universe : undefined) ?? [];

    for (const u of uni) ingestEntry(u);

    const assets = meta?.assets ?? meta?.perpetuals?.assets ?? meta?.perpAssets ?? [];

    for (const a of assets) ingestEntry(a);

    // Аккуратно добавим fallback’и, если API чего-то не вернул
    for (const [k, v] of Object.entries(FALLBACK_SZ_DECIMALS)) {
        if (!Number.isFinite(_szCache[k])) {
            _szCache[k] = v;
        }
    }

    _lastBuilt = Date.now();
}

/** Возвращает точность размера (szDecimals) для базового актива перпеты. */
export async function getSzDecimals(symbol: string): Promise<number> {
    await rebuildIfNeeded(false);
    let d = _szCache[symbol];

    // Если промахнулись — форс-перестроение
    if (!Number.isFinite(d)) {
        await rebuildIfNeeded(true);
        d = _szCache[symbol];
    }

    if (Number.isFinite(d)) return d!;

    // Жёсткий фолбэк — только если API реально не дал данных
    const fb = (FALLBACK_SZ_DECIMALS as any)[symbol];
    if (fb !== undefined) {
        const n = Number(fb);
        if (Number.isFinite(n)) {
            _szCache[symbol] = n; // сразу кешируем
            console.warn(`[precision] using FALLBACK szDecimals for ${symbol}: ${n}`);
            return n;
        }
    }

    throw new Error(`No szDecimals for ${symbol}`);
}

// прогрев кеша для набора символов
export async function warmSzCache(symbols: string[]) {
    await rebuildIfNeeded(true);
    for (const s of symbols) {
        const b = base(s);
        if (!Number.isFinite(_szCache[b]) && Number.isFinite(FALLBACK_SZ_DECIMALS[b])) {
            _szCache[b] = FALLBACK_SZ_DECIMALS[b];
        }
    }
}

// очистка кеша вручную
export function clearSzCache() {
    for (const k of Object.keys(_szCache)) delete _szCache[k];
    _lastBuilt = 0;
}
