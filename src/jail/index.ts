/**
 * FreeBSD Jail runtime for NanoClaw — public barrel.
 *
 * Only exports consumed by callers *outside* jail/.
 * Internal jail modules import from their siblings directly.
 *
 * Module structure:
 *   types.ts    — Interfaces and type definitions
 *   config.ts   — JAIL_CONFIG, constants, mount layout
 *   sudo.ts     — Sudo execution helpers with DI for testing
 *   network.ts  — Epair management, pf validation, DNS
 *   mounts.ts   — Mount validation, building, nullfs operations
 *   lifecycle.ts — Create, stop, destroy, and jail state queries
 *   exec.ts     — Command execution inside running jails
 *   cleanup.ts  — Orphan handling, audit logging, full cleanup
 *   runner.ts   — Jail agent runner entry point
 */

// ── Re-exports consumed by callers outside jail/ ────────────────────

// Cleanup (used by container-runtime.ts)
export { cleanupOrphans } from './cleanup.js';

// Runner (used by container-runner.ts via direct import of runner.js,
// but re-exported here for discoverability)
export { runJailAgent } from './runner.js';

// ── Runtime hooks (called by src/index.ts when runtime === 'jail') ──

import { execFileSync } from 'child_process';
import { logger } from '../logger.js';
import { JAIL_CONFIG } from './config.js';
import { getActiveJailCount, trackActiveJail } from './lifecycle.js';
import { getEpairMetrics } from './network.js';
import { listRunningNanoclawJails, cleanupAllJails } from './cleanup.js';
import { startMetricsServer, updateMetrics } from './metrics.js';

/** Reconnect to jails that survived a process restart. */
export async function reconnectToRunningJails(): Promise<void> {
  try {
    const running = listRunningNanoclawJails();
    if (running.length === 0) {
      logger.debug('No running jails found to reconnect');
      return;
    }
    for (const name of running) {
      trackActiveJail(name);
    }
    logger.info(
      { count: running.length, jails: running },
      'Reconnected to existing running jails',
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to reconnect to running jails');
  }
}

/** Clean up all jails during shutdown. */
export async function shutdownAllJails(): Promise<void> {
  try {
    await cleanupAllJails();
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up jails during shutdown');
  }
}

/** Start the jail-specific health/metrics HTTP server. */
export async function startJailMetrics(config: {
  healthEnabled: boolean;
  metricsEnabled: boolean;
  metricsPort: number;
}): Promise<{ close: () => void } | null> {
  // Verify pf is loaded when using restricted network mode
  if (JAIL_CONFIG.networkMode === 'restricted') {
    try {
      execFileSync('pfctl', ['-s', 'info'], { stdio: 'pipe' });
    } catch {
      logger.warn(
        'pf firewall does not appear to be running. Restricted network mode requires pf rules for jail connectivity. See docs/FREEBSD_JAILS.md.',
      );
    }
  }

  const poolName = JAIL_CONFIG.jailsDataset.split('/')[0];
  const server = startMetricsServer(
    {
      healthEnabled: config.healthEnabled,
      metricsEnabled: config.metricsEnabled,
      port: config.metricsPort,
    },
    JAIL_CONFIG.templateDataset,
    JAIL_CONFIG.templateSnapshot,
    poolName,
  );

  let metricsInterval: ReturnType<typeof setInterval> | null = null;
  if (config.metricsEnabled) {
    metricsInterval = setInterval(async () => {
      await updateMetrics(getActiveJailCount, getEpairMetrics, poolName);
    }, 30000);
  }

  return {
    close: () => {
      if (metricsInterval) clearInterval(metricsInterval);
      server?.close();
    },
  };
}

/** Periodic ZFS/template health checks. Calls onAlert on critical conditions. */
export function startJailHealthChecks(
  onAlert: (message: string) => void,
): () => void {
  const interval = setInterval(
    async () => {
      try {
        const poolName = JAIL_CONFIG.jailsDataset.split('/')[0];

        // Check ZFS pool space
        try {
          const availOutput = execFileSync(
            'zfs',
            ['get', '-Hp', '-o', 'value', 'available', poolName],
            { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 },
          );
          const usedOutput = execFileSync(
            'zfs',
            ['get', '-Hp', '-o', 'value', 'used', poolName],
            { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 },
          );
          const avail = parseInt(availOutput.trim(), 10);
          const used = parseInt(usedOutput.trim(), 10);
          if (avail > 0 && used > 0) {
            const pctAvail = (avail / (avail + used)) * 100;
            if (pctAvail < 10) {
              onAlert(
                `ZFS pool "${poolName}" is low on space: ${pctAvail.toFixed(1)}% free (${Math.round(avail / 1024 / 1024)}MB available).`,
              );
            }
          }
        } catch {
          // ZFS check failed — skip
        }

        // Check template snapshot exists
        const snapshot = `${JAIL_CONFIG.templateDataset}@${JAIL_CONFIG.templateSnapshot}`;
        try {
          execFileSync('zfs', ['list', '-t', 'snapshot', '-H', snapshot], {
            stdio: 'pipe',
            timeout: 5000,
          });
        } catch {
          onAlert(
            `Template snapshot missing: ${snapshot}. New jails cannot be created.`,
          );
        }
      } catch (err) {
        logger.debug({ err }, 'Runtime health check failed');
      }
    },
    5 * 60 * 1000,
  );

  return () => clearInterval(interval);
}
