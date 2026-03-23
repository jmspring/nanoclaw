import fs from 'fs';
import path from 'path';
import pino from 'pino';
import { randomUUID } from 'crypto';
import { createStream, RotatingFileStream } from 'rotating-file-stream';
import pretty from 'pino-pretty';

const LOG_DIR = path.join(process.cwd(), 'logs');

// Rotating file stream for persistent logs
let logFileStream: RotatingFileStream | undefined;
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  logFileStream = createStream('nanoclaw.log', {
    path: LOG_DIR,
    size: '10M',
    interval: '1d',
    compress: 'gzip',
    maxFiles: 5,
  });
} catch {
  // Fall back to console-only logging if log dir is not writable
}

const streams: pino.StreamEntry[] = [
  { level: 'trace', stream: pretty({ colorize: true }) },
];

if (logFileStream) {
  streams.push({ level: 'trace', stream: logFileStream });
}

export const logger = pino(
  { level: process.env.LOG_LEVEL || 'info' },
  pino.multistream(streams),
);

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
