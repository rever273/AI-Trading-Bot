import { Hyperliquid } from 'hyperliquid';
import { CFG } from '../config.js';
import { logger, sleep } from '../utils/functions.js';

let _hlInstance: Hyperliquid | null = null;

/**
 * Инициализирует клиент Hyperliquid с логикой повторных попыток.
 * Эта функция должна быть вызвана один раз при старте приложения.
 */
export async function initializeHyperliquidClient() {
    if (_hlInstance) {
        return _hlInstance;
    }

    const maxRetries = 5;
    const retryDelayMs = 5000; // 5 секунд

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            if (attempt > 1) logger.log(`[HL-CLIENT] Attempt ${attempt}/${maxRetries} to initialize Hyperliquid client...`);

            const client = new Hyperliquid({
                privateKey: CFG.hl.privateKey,
                testnet: CFG.hl.testnet,
                enableWs: false,
                walletAddress: CFG.hl.walletAddress,
            });

            // Попробуем выполнить простой запрос, чтобы убедиться, что API доступно
            await client.info.getAllMids();

            _hlInstance = client;
            logger.log('[HL-CLIENT] Hyperliquid client initialized successfully.');
            return _hlInstance;
        } catch (error: any) {
            logger.error(`[HL-CLIENT] Initialization attempt ${attempt} failed:`, error.message);
            if (attempt < maxRetries) {
                logger.warn(`[HL-CLIENT] Retrying in ${retryDelayMs / 1000} seconds...`);
                await sleep(retryDelayMs);
            } else {
                logger.error('[HL-CLIENT] All initialization attempts failed. Exiting.');
                throw new Error('Could not initialize Hyperliquid client after multiple retries.');
            }
        }
    }
}

/**
 * Возвращает уже инициализированный экземпляр клиента.
 * Вызывать только после успешного выполнения initializeHyperliquidClient().
 */
export function getHlClient(): Hyperliquid {
    if (!_hlInstance) {
        throw new Error('Hyperliquid client has not been initialized. Call initializeHyperliquidClient() first.');
    }
    return _hlInstance;
}
