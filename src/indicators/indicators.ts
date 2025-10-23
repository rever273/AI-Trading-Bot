export function ema(values: number[], period: number): number[] {
    if (values.length === 0) return [];
    const out: number[] = new Array(values.length).fill(NaN);
    const k = 2 / (period + 1);

    const seed = Math.min(period, values.length);
    const sma = values.slice(0, seed).reduce((a, b) => a + b, 0) / seed;
    out[seed - 1] = sma;

    for (let i = seed; i < values.length; i++) {
        out[i] = values[i] * k + out[i - 1] * (1 - k);
    }
    return out;
}

export function macd(values: number[], fast = 12, slow = 26, signal = 9) {
    const emaFast = ema(values, fast);
    const emaSlow = ema(values, slow);
    const macdLine = values.map((_, i) => (isFinite(emaFast[i]) && isFinite(emaSlow[i]) ? emaFast[i] - emaSlow[i] : NaN));
    const signalLine = ema(macdLine.filter(Number.isFinite) as number[], signal);
    const signalAligned: number[] = new Array(values.length).fill(NaN);

    let j = 0;
    for (let i = 0; i < values.length; i++) {
        if (Number.isFinite(macdLine[i])) {
            signalAligned[i] = signalLine[j++] ?? NaN;
        }
    }
    const hist = macdLine.map((v, i) => (Number.isFinite(v) && Number.isFinite(signalAligned[i]) ? v - signalAligned[i] : NaN));
    return { macd: macdLine, signal: signalAligned, hist };
}

export function rsi(values: number[], period = 14): number[] {
    if (values.length < period + 1) return new Array(values.length).fill(NaN);
    const gains: number[] = [];
    const losses: number[] = [];
    for (let i = 1; i < values.length; i++) {
        const diff = values[i] - values[i - 1];
        gains.push(Math.max(0, diff));
        losses.push(Math.max(0, -diff));
    }
    let avgGain = average(gains.slice(0, period));
    let avgLoss = average(losses.slice(0, period));
    const rsis: number[] = new Array(period).fill(NaN);
    for (let i = period; i < gains.length; i++) {
        avgGain = (avgGain * (period - 1) + gains[i]) / period;
        avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
        const rs = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
        rsis.push(rs);
    }
    return [NaN, ...rsis];
}

function average(arr: number[]): number {
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function atr(candles: { h: number; l: number; c: number; prevClose?: number }[], period: number): number[] {
    if (candles.length === 0) return [];
    const trs = candles.map((c, i) => {
        const prev = i === 0 ? c.c : candles[i - 1].c;
        return Math.max(c.h - c.l, Math.abs(c.h - prev), Math.abs(c.l - prev));
    });

    const k = 1 / period;
    const out: number[] = [];
    let prev = trs[0];
    out.push(prev);
    for (let i = 1; i < trs.length; i++) {
        const v = prev + k * (trs[i] - prev);
        out.push(v);
        prev = v;
    }
    return out;
}
