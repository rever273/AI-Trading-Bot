// utils/hlQuantize.ts

export function hlTickStepForPrice(px: number, { isPerp = true }: { isPerp?: boolean } = {}) {
    if (!(px > 0)) throw new Error('Invalid price');
    const maxDecimals = isPerp ? 6 : 8;
    const exp = Math.floor(Math.log10(px));
    const sigDecimals = Math.max(0, 4 - exp);
    const decimals = Math.min(sigDecimals, maxDecimals);
    const step = 10 ** -decimals;
    return Number(step.toFixed(maxDecimals));
}

export function quantizePxHL(px: number, opts?: { isPerp?: boolean }) {
    const step = hlTickStepForPrice(px, opts);
    const decimals = Math.max(0, Math.round(-Math.log10(step)));
    const q = Math.round(px / step) * step;
    return Number(q.toFixed(decimals));
}

export function quantizeSzHL(sz: number, szDecimals: number) {
    if (!(sz > 0)) throw new Error('Invalid size');
    const step = 10 ** -szDecimals;
    const q = Math.floor(sz / step) * step;
    return Number(q.toFixed(szDecimals));
}

export function roundUpToStep(px: number, step: number): number {
    if (!(px > 0) || !(step > 0)) throw new Error('Invalid px/step');
    const q = Math.ceil(px / step) * step;
    const decimals = Math.max(0, Math.round(-Math.log10(step)));
    return Number(q.toFixed(decimals));
}
export function roundDnToStep(px: number, step: number): number {
    if (!(px > 0) || !(step > 0)) throw new Error('Invalid px/step');
    const q = Math.floor(px / step) * step;
    const decimals = Math.max(0, Math.round(-Math.log10(step)));
    return Number(q.toFixed(decimals));
}

// Направленное квантование именно под сторону сделки
export function quantizePxHLSide(px: number, isBuy: boolean, opts?: { isPerp?: boolean }) {
    const step = hlTickStepForPrice(px, opts);
    return isBuy ? roundUpToStep(px, step) : roundDnToStep(px, step);
}
