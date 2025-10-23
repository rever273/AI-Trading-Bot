import 'dotenv/config';

const must = (name: string, optional = false): string | undefined => {
    const v = process.env[name];
    if (!optional && (!v || v.trim() === '')) {
        throw new Error(`Missing env: ${name}`);
    }
    return v;
};

export const CFG = {
    hl: {
        privateKey: must('HL_PRIVATE_KEY')!,
        testnet: (process.env.HL_TESTNET ?? 'true').toLowerCase() === 'true',
        walletAddress: process.env.HL_WALLET_ADDRESS || undefined,
    },
    ai: {
        apiKey: must('AI_API_KEY')!,
        baseURL: must('AI_BASE_URL')!, // (OpenAI-совместимый)
        model: process.env.AI_MODEL ?? 'deepseek-reasoner',
    },
    risk: {
        mode: (process.env.POSITION_MODE ?? 'fixed') as 'fixed' | 'risk_pct',
        minOrderUsd: Number(process.env.MIN_ORDER_USD ?? '10'),
        maxOrderUsd: Number(process.env.MAX_ORDER_USD ?? Number.POSITIVE_INFINITY),
        positionUsd: Number(process.env.POSITION_USD ?? '15'),
        acceptModelSizing: (process.env.ACCEPT_MODEL_SIZING ?? 'false').toLowerCase() === 'true',

        // фиксированный риск для режима risk_pct при ACCEPT_MODEL_SIZING=false
        riskPctDefault: Number(process.env.RISK_PCT ?? '0.05'), //далее  [min,max]
        riskPctMin: Number(process.env.RISK_PCT_MIN ?? '0.01'),
        riskPctMax: Number(process.env.RISK_PCT_MAX ?? '0.06'),

        leverageMax: Number(process.env.LEVERAGE_MAX ?? '5'),
        leverageMode: (process.env.LEVERAGE_MODE ?? 'isolated') as 'isolated' | 'cross',
        syncLeverage: (process.env.SYNC_LEVERAGE ?? 'false').toLowerCase() === 'true',

        defaultTpPct: Number(process.env.DEFAULT_TP_PCT ?? '0.8'),
        defaultSlPct: Number(process.env.DEFAULT_SL_PCT ?? '0.4'),

        //защита от проскальзывания на HL
        maxSlippagePct: Number(process.env.MAX_SLIPPAGE_PCT ?? '0.2'),
    },
    tf: {
        intradayInterval: process.env.INTRADAY_INTERVAL ?? '3m',
        intradayPoints: Number(process.env.INTRADAY_POINTS ?? '120'),
        fourHourPoints: Number(process.env.FOUR_HOURS_POINTS ?? '200'),
    },
    orders: {
        entrySlippagePct: Number(process.env.ENTRY_SLIPPAGE_PCT ?? '0.05'),
        maxEntrySlippageBps: Number(process.env.MAX_ENTRY_SLIPPAGE_BPS ?? '20'),
        entryEpsTicks: Number(process.env.ENTRY_EPS_TICKS ?? '1'),
    },
    symbols: {
        list: (process.env.HL_SYMBOLS ?? 'BTC-PERP')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
    },
    scheduler: {
        pollMs: Number(process.env.POLL_INTERVAL_MS ?? '120000'), // ~2 минуты
        signalPolicy: (process.env.SIGNAL_POLICY ?? 'ignore') as 'ignore' | 'update_tp_sl' | 'flip_if_confident' | 'flip_and_update',
        flipConfidence: Number(process.env.FLIP_CONFIDENCE ?? '0.8'),
        minOpenConfidence: Number(process.env.MIN_OPEN_CONFIDENCE ?? '0.6'),
    },
};
