/**
 * Structured Alerting Module
 *
 * Centralizes alert management with severity levels, deduplication,
 * and channel-agnostic output sinks.
 *
 * Design: instance-based AlertManager (testable) with module-level convenience.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

/** Alert severity levels */
export type AlertSeverity = 'critical' | 'warning' | 'info';

/** Structured alert object */
export interface Alert {
  severity: AlertSeverity;
  category: string;
  title: string;
  detail?: string;
  groupFolder?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

/** Output target for alerts */
export interface AlertSink {
  name: string;
  send(alert: Alert): Promise<void>;
}

const SEVERITY_PREFIX: Record<AlertSeverity, string> = {
  critical: '[CRITICAL]',
  warning: '[WARNING]',
  info: '[INFO]',
};

const DEFAULT_DEDUPE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Central alert manager with deduplication and multi-sink dispatch.
 */
export class AlertManager {
  private sinks: AlertSink[] = [];
  private dedupeWindow: number;
  private recentAlerts = new Map<string, number>();

  constructor(options?: { dedupeWindowMs?: number }) {
    this.dedupeWindow = options?.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
  }

  /** Register an output sink. */
  registerSink(sink: AlertSink): void {
    this.sinks.push(sink);
  }

  /** Remove a sink by name. */
  removeSink(name: string): void {
    this.sinks = this.sinks.filter((s) => s.name !== name);
  }

  /**
   * Fire an alert. Deduplicates by (severity + category + title).
   * Always logs via pino regardless of sinks.
   */
  async fire(
    severity: AlertSeverity,
    category: string,
    title: string,
    detail?: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const alert: Alert = {
      severity,
      category,
      title,
      detail,
      metadata,
      timestamp: new Date().toISOString(),
    };

    // Always log via pino so alerts are never silently lost
    const logMethod = severity === 'critical' ? 'warn' : 'info';
    logger[logMethod](
      { alert: { severity, category, title, detail } },
      `Alert: ${SEVERITY_PREFIX[severity]} ${category}: ${title}`,
    );

    // Deduplication check
    const dedupeKey = `${severity}:${category}:${title}`;
    const lastFired = this.recentAlerts.get(dedupeKey);
    const now = Date.now();
    if (lastFired !== undefined && now - lastFired < this.dedupeWindow) {
      logger.debug(
        { dedupeKey, ageMs: now - lastFired },
        'Alert deduplicated (suppressed)',
      );
      return;
    }
    this.recentAlerts.set(dedupeKey, now);

    // Dispatch to all sinks — failure in one must not block others
    for (const sink of this.sinks) {
      try {
        await sink.send(alert);
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch (err) {
        logger.warn(
          { err, sink: sink.name },
          'Alert sink failed, continuing to next sink',
        );
      }
    }
  }
}

/**
 * Create a channel sink that formats alerts as human-readable messages.
 * The sendFn signature matches the existing (msg: string) => Promise<void>
 * callback used by sendAdminAlert and startJailHealthChecks.
 */
export function createChannelSink(
  sendFn: (msg: string) => Promise<void>,
): AlertSink {
  return {
    name: 'channel',
    async send(alert: Alert): Promise<void> {
      const prefix = SEVERITY_PREFIX[alert.severity];
      let message = `${prefix} ${alert.category}: ${alert.title}`;
      if (alert.detail) {
        message += `\n${alert.detail}`;
      }
      if (alert.groupFolder) {
        message += ` (group: ${alert.groupFolder})`;
      }
      await sendFn(message);
    },
  };
}

/**
 * Create a log sink that appends JSON-formatted alerts to a file.
 * Provides a persistent audit trail of all alerts.
 */
export function createLogSink(logPath?: string): AlertSink {
  const filePath = logPath || path.join(DATA_DIR, 'alerts.log');
  return {
    name: 'log',
    async send(alert: Alert): Promise<void> {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.appendFileSync(filePath, JSON.stringify(alert) + '\n');
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch (err) {
        logger.warn({ err, path: filePath }, 'Failed to write alert log');
      }
    },
  };
}
