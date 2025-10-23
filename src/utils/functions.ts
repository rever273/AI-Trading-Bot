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
