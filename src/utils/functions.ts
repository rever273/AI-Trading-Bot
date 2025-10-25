import chalk from 'chalk';

export function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTimestamp(): string {
    return `[${new Date().toLocaleTimeString('ru-RU')}]`;
}

/**
 * Обертка над console для добавления временных меток.
 */
export const logger = {
    log: (...args: any[]) => console.log(chalk.white(getTimestamp()), ...args),
    warn: (...args: any[]) => console.warn(chalk.yellow(getTimestamp()), ...args),
    error: (...args: any[]) => console.error(chalk.red(getTimestamp()), ...args),
};

export async function withRetries<T>(fn: () => Promise<T>, context: string, maxRetries = 3, delayMs = 2000): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            if (attempt > 1) logger.log(`[RETRY ${context}] Attempt ${attempt}/${maxRetries}...`);
            return await fn();
        } catch (error: any) {
            lastError = error;
            logger.warn(`[RETRY ${context}] Attempt ${attempt}/${maxRetries} failed:`, error.message);
            if (attempt < maxRetries) {
                const backoff = delayMs * 2 ** (attempt - 1) + Math.random() * 500;
                logger.warn(`[RETRY ${context}] Retrying in ${Math.round(backoff / 1000)}s...`);
                await sleep(backoff);
            }
        }
    }
    logger.error(`[RETRY ${context}] All attempts failed.`);
    throw lastError;
}
