import OpenAI from 'openai';
import { CFG } from '../config.js';
import type { AiDecision } from '../types.js';
import { logger } from '../utils/functions.js';

const client = new OpenAI({
    apiKey: CFG.ai.apiKey,
    baseURL: CFG.ai.baseURL,
});

export async function askAI(prompt: string): Promise<AiDecision> {
    // const t0 = Date.now();

    const systemInstructions = [
        `You are an autonomous trading AI for crypto perpetuals on Hyperliquid.`,
        `Your primary goals are:`,
        `1. Capital preservation through proper risk management`,
        `2. Profit generation through technical analysis`,
        `3. Portfolio diversification across available coins`,
        ``,
        `KEY TRADING PRINCIPLES:`,
        `- Use stop losses on EVERY trade`,
        `- Risk no more than 5% of account value per trade`,
        `- Consider correlation between assets`,
        `- Favor high-confidence setups (confidence > 0.7)`,
        `- Always calculate position size based on risk management`,
        ``,
        `ANALYSIS FRAMEWORK:`,
        ``,
        `MARKET CONTEXT:`,
        `- Open Interest changes: increasing = new money, decreasing = unwinding`,
        `- Funding rate: positive = long bias, negative = short bias`,
        `- Volume vs average: high volume confirms price moves`,
        `- ATR levels: high ATR = high volatility, adjust position size accordingly`,
        ``,
        `SIGNAL CRITERIA:`,
        `HOLD: Mixed signals, low confidence, or waiting for better entry`,
        ``,
        `CONFIDENCE LEVELS:`,
        `0.8-1.0: Strong alignment across all timeframes and indicators`,
        `0.6-0.7: Good setup but some conflicting signals`,
        `<0.6: Avoid trading, wait for clearer opportunity`,
        ``,
        `RISK MANAGEMENT RULES:`,
        `- Maximum risk per trade: 5% of account value`,
        `- Leverage: 1-3x (lower for high volatility coins)`,
        `- Position size: Calculate based on stop distance and risk percentage`,
    ].join('\n');

    const resp = await client.chat.completions.create({
        model: CFG.ai.model,
        response_format: { type: 'json_object' } as any,
        messages: [
            {
                role: 'system',
                content: systemInstructions,
            },
            { role: 'user', content: prompt },
        ],
    });

    const msg = resp.choices[0]?.message;
    const raw = msg?.content ?? '';

    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');

    if (start >= 0 && end > start) {
        // const t1 = Date.now();
        try {
            // logger.log(`[AI] Получен ответ за ${(t1 - t0) / 1000}s`);
            return JSON.parse(raw.slice(start, end + 1)) as AiDecision;
        } catch {}
    }

    return { action: 'HOLD', reasoning: 'Non-JSON response' };
}
