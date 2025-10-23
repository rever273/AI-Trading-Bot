export type Candle = {
    t: number; // open time (ms)
    T?: number; // close time (ms),
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
    n?: number; // trades count
    i?: string; // interval
    s?: string; // symbol
};

export type IntradayBundle = {
    midPrices: number[];
    ema20: number[];
    macd: number[];
    rsi7: number[];
    rsi14: number[];
};

export type FourHourBundle = {
    ema20: number;
    ema50: number;
    atr3: number;
    atr14: number;
    macd: number[];
    rsi14: number[];
    currVolume: number;
    avgVolume: number;
};

export type FundingOi = {
    openInterestLatest: number;
    fundingRate: number;
    markPx?: number;
};

export type AccountPosition = {
    coin: string; // 'BTC'
    quantity: number; // szi
    entry_price: number | null;
    current_price: number | null;
    leverage?: number | null;
    liquidation_price?: number | null;
    unrealized_pnl?: number;
    notional_usd?: number;
    exit_plan?: {
        profit_target?: number | null;
        stop_loss?: number | null;
        invalidation_condition?: string | null;
    };
};

export type AccountSummary = {
    accountValue: number;
    totalMarginUsed: number;
    totalNtlPos: number;
    totalRawUsd?: number;
    crossMaintenanceMarginUsed?: number;
    positions: AccountPosition[];
};

export type AiDecision = {
    action: 'BUY' | 'SELL' | 'HOLD';
    size_usd?: number;
    take_profit_pct?: number;
    stop_loss_pct?: number;
    reasoning?: string;
};

export type ModelCoinDecision = {
    signal: 'buy' | 'sell' | 'hold';
    quantity?: number | null;
    profit_target?: number | null; // ABS price
    stop_loss?: number | null; // ABS price
    coin: string; // e.g. "BTC"
    leverage?: number | null;
    risk_usd?: number | null;
    risk_pct?: number | null;
    confidence?: number | null;
    invalidation_condition?: string | null;
    justification?: string | null;
};

export type ModelResponse = { llm_response: Record<string, ModelCoinDecision> };

export type OpenPosition = {
    side: 'long' | 'short';
    qty: number;
    entryPx: number;
};

export type TradeRecord = {
    trade_id: string;
    symbol: string;
    side: 'long' | 'short';
    entry_time: number;
    entry_human_time: string;
    entry_oid: number;
    entry_tid?: number | null;
    entry_price: number;
    quantity: number;
    leverage?: number | null;

    tp_oid?: number | null;
    sl_oid?: number | null;

    exit_time?: number | null;
    exit_human_time?: string | null;
    exit_oid?: number | null;
    exit_tid?: number | null;
    exit_price?: number | null;

    risk_usd?: number | null;
    confidence?: number | null;
    commission_usd_entry?: number | null;
    commission_usd_exit?: number | null;

    realized_gross_pnl?: number | null;
    realized_net_pnl?: number | null;
    exit_plan?: { profit_target?: number; stop_loss?: number; invalidation_condition?: string };
};
