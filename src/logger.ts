import pino from 'pino';
import { randomUUID } from 'crypto';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});

/**
 * Generate a unique trace ID for request correlation.
 * @returns UUID trace ID
 */
export function generateTraceId(): string {
  return randomUUID();
}

/**
 * Create a child logger with trace ID for request correlation.
 * All log entries from this logger will include the trace ID.
 * @param traceId - Unique trace ID for this request/operation
 * @param additionalContext - Additional context to include in all logs
 * @returns Child logger with trace ID context
 */
export function createTracedLogger(
  traceId: string,
  additionalContext?: Record<string, unknown>,
): pino.Logger {
  return logger.child({ traceId, ...additionalContext });
}
