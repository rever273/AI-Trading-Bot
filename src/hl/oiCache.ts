// src/hl/oiCache.ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const FILE = 'data/oi_cache.json';

export function updateOiAverage(latest: number, window = 500): { avg: number; count: number } {
    if (!existsSync(dirname(FILE))) mkdirSync(dirname(FILE), { recursive: true });
    let arr: number[] = [];
    if (existsSync(FILE)) {
        try {
            arr = JSON.parse(readFileSync(FILE, 'utf-8'));
        } catch {
            arr = [];
        }
    }
    arr.push(latest);
    if (arr.length > window) arr = arr.slice(-window);
    writeFileSync(FILE, JSON.stringify(arr));
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
    return { avg, count: arr.length };
}
