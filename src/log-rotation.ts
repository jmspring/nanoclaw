/**
 * Log Rotation Utilities
 * Manages jail/container log files with rotation and cleanup
 */
import fs from 'fs';
import path from 'path';
import { createStream, RotatingFileStream } from 'rotating-file-stream';

import {
  LOG_RETENTION_DAYS,
  LOG_ROTATION_COMPRESS,
  LOG_ROTATION_MAX_FILES,
  LOG_ROTATION_SIZE,
} from './config.js';
import { logger } from './logger.js';

// Cache of active log streams per logs directory
const logStreams = new Map<string, RotatingFileStream>();

/**
 * Get or create a rotating log stream for a logs directory.
 * Uses a single rotating stream per directory (jail-*.log or container-*.log pattern).
 */
export function getRotatingLogStream(
  logsDir: string,
  prefix: 'jail' | 'container',
): RotatingFileStream {
  const key = `${logsDir}:${prefix}`;
  let stream = logStreams.get(key);

  if (!stream) {
    fs.mkdirSync(logsDir, { recursive: true });

    // Generator function for log file names
    const generator = (time: number | Date | null, index?: number): string => {
      if (!time) {
        // Current file (no rotation yet)
        return `${prefix}-current.log`;
      }

      // Rotated file with timestamp
      const timestamp =
        time instanceof Date
          ? time.toISOString().replace(/[:.]/g, '-')
          : new Date(time).toISOString().replace(/[:.]/g, '-');
      return `${prefix}-${timestamp}.log`;
    };

    stream = createStream(generator, {
      path: logsDir,
      size: LOG_ROTATION_SIZE, // Rotate when file reaches this size
      maxFiles: LOG_ROTATION_MAX_FILES, // Keep this many rotated files
      compress: LOG_ROTATION_COMPRESS ? 'gzip' : false, // Compress rotated files
      interval: '1d', // Also rotate daily to prevent huge files
    });

    stream.on('error', (err) => {
      logger.error({ logsDir, prefix, err }, 'Log stream error');
    });

    stream.on('rotation', () => {
      logger.debug({ logsDir, prefix }, 'Log file rotated');
      // Trigger cleanup after rotation
      cleanupOldLogs(logsDir, prefix).catch((err) => {
        logger.warn({ logsDir, prefix, err }, 'Failed to cleanup old logs');
      });
    });

    logStreams.set(key, stream);
  }

  return stream;
}

/**
 * Write a log entry to the rotating log stream.
 */
export function writeRotatingLog(
  logsDir: string,
  prefix: 'jail' | 'container',
  content: string,
): void {
  const stream = getRotatingLogStream(logsDir, prefix);

  // Add separator between entries for readability
  const entry = `\n${'='.repeat(80)}\n${content}\n`;

  stream.write(entry, (err) => {
    if (err) {
      logger.error({ logsDir, prefix, err }, 'Failed to write log entry');
    }
  });
}

/**
 * Clean up old log files that exceed the retention period.
 */
async function cleanupOldLogs(
  logsDir: string,
  prefix: 'jail' | 'container',
): Promise<void> {
  const now = Date.now();
  const cutoffTime = now - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  try {
    const files = fs.readdirSync(logsDir);
    const pattern = new RegExp(`^${prefix}-.*\\.log(\\.gz)?$`);

    for (const file of files) {
      if (!pattern.test(file)) continue;

      const filePath = path.join(logsDir, file);
      const stat = fs.statSync(filePath);

      // Delete files older than retention period
      if (stat.mtimeMs < cutoffTime) {
        logger.debug({ file: filePath }, 'Deleting old log file');
        fs.unlinkSync(filePath);
      }
    }
  } catch (err) {
    logger.warn({ logsDir, prefix, err }, 'Error cleaning up old logs');
  }
}

/**
 * Close all open log streams (call on shutdown).
 */
export async function closeAllLogStreams(): Promise<void> {
  const promises: Promise<void>[] = [];

  for (const [key, stream] of logStreams.entries()) {
    promises.push(
      new Promise((resolve) => {
        stream.end(() => {
          logger.debug({ key }, 'Log stream closed');
          resolve();
        });
      }),
    );
  }

  logStreams.clear();
  await Promise.all(promises);
}

/**
 * Run periodic cleanup of old log files for all group logs directories.
 * Should be called periodically (e.g., daily) from the main orchestrator.
 */
export async function cleanupAllGroupLogs(groupsDir: string): Promise<void> {
  try {
    const groups = fs.readdirSync(groupsDir);

    for (const group of groups) {
      const logsDir = path.join(groupsDir, group, 'logs');
      if (!fs.existsSync(logsDir)) continue;

      // Cleanup both jail and container logs
      await cleanupOldLogs(logsDir, 'jail');
      await cleanupOldLogs(logsDir, 'container');
    }
  } catch (err) {
    logger.warn({ groupsDir, err }, 'Error during periodic log cleanup');
  }
}
