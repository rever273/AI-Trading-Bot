import type { AccountPosition, AccountSummary } from '../types.js';

export type CoinPromptData = {
    symbol: string; // 'BTC-PERP'
    coin: string; // 'BTC'
    markPx: number;

    oiLatest: number;
    oiAvg: number;
    fundingRate: number;

    // "текущие" метрики
    current_ema20: number;
    current_macd: number;
    current_rsi7: number;
    current_rsi14: number;

    // ряды
    intraday: {
        midPrices: number[];
        ema20: number[];
        macd: number[];
        rsi7: number[];
        rsi14: number[];
    };
    fourHour: {
        ema20: number;
        ema50: number;
        atr3: number;
        atr14: number;
        macd: number[];
        rsi14: number[];
        currVolume: number;
        avgVolume: number;
    };
};

function fmt(n: number | null | undefined, d = 3): string {
    if (n == null || !isFinite(n)) return 'NaN';
    return Number(n).toFixed(d);
}
function fmtArr(a: number[], d = 3): string {
    return a.map((x) => fmt(x, d)).join(', ');
}

function renderCoinSection(c: CoinPromptData, intradayInterval: string): string {
    const { coin, markPx, oiLatest, oiAvg, fundingRate } = c;
    const f = c.fourHour;
    const i = c.intraday;
    const decimal = markPx <= 0 ? 6 : markPx < 100 ? 3 : 2;

    return [
        `### ALL ${coin} DATA`,
        ``,
        `current_price = ${fmt(markPx, decimal)}, current_ema20 = ${fmt(c.current_ema20, decimal)}, current_macd = ${fmt(
            c.current_macd,
            decimal,
        )}, current_rsi (7 period) = ${fmt(c.current_rsi7, 2)}`,
        ``,
        `Open Interest: Latest: ${fmt(oiLatest, 1)}  Average: ${fmt(oiAvg, 1)}`,
        ``,
        `Funding Rate: ${fmt(fundingRate, 10)}`,
        ``,
        `**Intraday series (${intradayInterval} intervals, oldest → latest):**`,
        `Mid prices: [${fmtArr(i.midPrices, decimal)}]`,
        `EMA(20): [${fmtArr(i.ema20, decimal)}]`,
        `MACD(12,26,9): [${fmtArr(i.macd, 3)}]`,
        `RSI(7): [${fmtArr(i.rsi7, 2)}]`,
        `RSI(14): [${fmtArr(i.rsi14, 2)}]`,
        ``,
        `**4-hour context:**`,
        `20-EMA: ${fmt(f.ema20, decimal)}`,
        `50-EMA: ${fmt(f.ema50, decimal)}`,
        `3-ATR: ${fmt(f.atr3, 3)}`,
        `14-ATR: ${fmt(f.atr14, 3)}`,
        `MACD: [${fmtArr(f.macd, 3)}]`,
        `RSI(14): [${fmtArr(f.rsi14, 2)}]`,
        `Current Volume: ${fmt(f.currVolume, 2)}  Average Volume: ${fmt(f.avgVolume, 2)}`,
        `---`,
        ``,
    ].join('\n');
}

function renderAccountSection(acc: AccountSummary): string {
    const lines: string[] = [];
    lines.push(`### HERE IS YOUR ACCOUNT INFORMATION & PERFORMANCE`);
    lines.push('');

    lines.push(`Current Account Value: ${fmt(acc.accountValue, 2)} USD`);
    if (acc.totalRawUsd != null) lines.push(`Total Raw USD: ${fmt(acc.totalRawUsd, 2)}`);
    if (acc.totalMarginUsed != null) lines.push(`Total Margin Used: ${fmt(acc.totalMarginUsed, 2)}`);
    if (acc.totalNtlPos != null) lines.push(`Total Notional Position: ${fmt(acc.totalNtlPos, 2)}`);
    if (acc.crossMaintenanceMarginUsed != null) lines.push(`Cross Maintenance Margin Used: ${fmt(acc.crossMaintenanceMarginUsed, 2)}`);

    lines.push('');
    lines.push(`Current live positions & performance:`);

    if (!acc.positions.length) {
        lines.push(`- none`);
    } else {
        // Форматируем каждую позицию как объект, похожий на JSON
        const positionStrings = acc.positions.map((p) => {
            const posObject = {
                symbol: p.coin,
                quantity: p.quantity,
                entry_price: p.entry_price,
                current_price: p.current_price,
                liquidation_price: p.liquidation_price,
                unrealized_pnl: p.unrealized_pnl,
                leverage: p.leverage,
                notional_usd: p.notional_usd,
                exit_plan: p.exit_plan,
            };

            // Преобразуем в строку, удаляя кавычки с ключей
            return JSON.stringify(posObject, null, 2)
                .replace(/"([^"]+)":/g, '$1:')
                .replace(/^{\n/, '{ ')
                .replace(/\n}$/, ' }')
                .replace(/\n  /g, ' ');
        });
        lines.push(positionStrings.join(' '));
    }
    lines.push('');
    lines.push(`---`);
    lines.push('');
    return lines.join('\n');
}

export function buildPrompt(params: {
    CFG: {
        hl: { isTestnet: boolean };
        tf: { intradayInterval: string };
    };
    sinceMinutes: number;
    invocations: number;
    nowIso: string;
    coins: CoinPromptData[];
    account: AccountSummary;
}): string {
    const header = `It has been ${params.sinceMinutes} minutes since you started trading. The current time is ${params.nowIso} and you've been invoked ${params.invocations} times.`;

    const tfNote = `**ALL OF THE PRICE OR SIGNAL DATA BELOW IS ORDERED: OLDEST → NEWEST**\n**Timeframes note:** Unless stated otherwise, intraday series are ${params.CFG.tf.intradayInterval} intervals (oldest → latest) and context series are 4-hour intervals.`;

    const testnetNote = `Note: data source is **${
        params.CFG.hl.isTestnet ? 'testnet' : 'mainnet'
    }**. Focus on **relative changes** (latest vs average) in OI/volume/funding rather than absolute magnitudes.`;

    const currentContext = [
        `CURRENT MARKET CONTEXT:`,
        `${params.CFG.hl.isTestnet ? '- Testnet environment: focus on pattern recognition and strategy' : ''}`,
        `- Account has existing positions: consider portfolio balance and risk exposure`,
        `- Multiple timeframes available: align intraday signals with 4h trend direction`,
        `- Analyze all coins independently but consider overall portfolio correlation`,
    ].join('\n');

    const marketHeader = `### CURRENT MARKET STATE FOR ALL COINS`;

    const sections = params.coins.map((coin) => renderCoinSection(coin, params.CFG.tf.intradayInterval)).join('\n');

    const accountBlock = renderAccountSection(params.account);

    const responseFormat = [
        `Return STRICT JSON only, no prose. You MUST provide an entry for EACH coin.`,
        ``,
        `Required structure:`,
        ``,
        `{`,
        `  "llm_response": {`,
        `    // One object for each coin: ${params.coins.map((c) => c.coin).join(', ')}`,
        `    "COIN_NAME": {`,
        `      "signal": "buy" | "sell" | "hold",`,
        `      "quantity": number,                // UNITS/CONTRACTS (calculate based on risk management)`,
        `      "profit_target": number,           // ABSOLUTE take profit price (set 2-3% from entry for scalps)`,
        `      "stop_loss": number,               // ABSOLUTE stop loss price (max 1-2% risk from entry)`,
        `      "coin": "string",                  // MUST be the same as the key (e.g. "BTC")`,
        `      "leverage": number,                // 2-5x (lower for high volatility)`,
        `      "risk_usd": number,                // Actual USD risk (stop distance × position size)`,
        `      "risk_pct": number,                // Desired risk as percentage of account (0.005-0.02 for 0.5%-2%)`,
        `      "confidence": number,              // 0.0-1.0 (only >0.6 for actual trades)`,
        `      "invalidation_condition": string,  // e.g., "Break below EMA20 with high volume"`,
        `    }`,
        `  }`,
        `}`,
    ].join('\n');

    return ['', header, '', tfNote, testnetNote, '', currentContext, '', marketHeader, '', sections, accountBlock, responseFormat].join('\n');
}
