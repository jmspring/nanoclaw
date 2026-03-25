/**
 * Jail cleanup, orphan handling, and audit logging.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';
import { JAIL_QUICK_OP_TIMEOUT } from './config.js';
import { getSudoExec } from './sudo.js';
import { JAIL_CONFIG } from './config.js';
import {
  restoreEpairState,
  getAssignedEpair,
  clearAllEpairs,
  cleanupHostTempFiles,
} from './network.js';
import { cleanupByJailName } from './lifecycle.js';

/** Cleanup audit logging (opt-in via NANOCLAW_AUDIT_LOG=true) */
const AUDIT_ENABLED = process.env.NANOCLAW_AUDIT_LOG === 'true';
const CLEANUP_AUDIT_LOG = path.join(JAIL_CONFIG.jailsPath, 'cleanup-audit.log');

/** Log an audit entry for cleanup operations. No-op unless NANOCLAW_AUDIT_LOG=true. */
export function logCleanupAudit(
  action: string,
  jailName: string,
  status: string,
  error: unknown = null,
): void {
  if (!AUDIT_ENABLED) return;

  const timestamp = new Date().toISOString();
  const errorMessage = error instanceof Error ? error.message : null;
  const logLine = `${timestamp} [${status}] ${action} ${jailName}${errorMessage ? ` - ${errorMessage}` : ''}\n`;

  try {
    fs.appendFileSync(CLEANUP_AUDIT_LOG, logLine);
  } catch (err) {
    logger.error(
      { err, logFile: CLEANUP_AUDIT_LOG },
      'Failed to write cleanup audit log',
    );
  }
}

/**
 * Retry a function with exponential backoff.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  initialDelay = 100,
  maxDelay = 5000,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const delay = Math.min(initialDelay * Math.pow(2, attempt), maxDelay);
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        logger.debug(
          { error: errorMessage, attempt: attempt + 1, maxRetries, delay },
          'Retry attempt',
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

/** List all running NanoClaw jails. */
export function listRunningNanoclawJails(): string[] {
  try {
    const output = execFileSync('sudo', ['jls', '-N', 'name'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });

    return output
      .trim()
      .split('\n')
      .filter((line) => line.startsWith('nanoclaw_'));
  } catch (err) {
    logger.debug({ err }, 'No running jails found or jls failed');
    return [];
  }
}

/**
 * Destroy orphaned epair interfaces that are no longer tracked by any jail.
 * Operates on system-wide interface state — called after individual jail cleanup.
 */
export function cleanupOrphanEpairs(): void {
  try {
    restoreEpairState();

    const ifconfigOutput = execFileSync('ifconfig', ['-l'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const interfaces = ifconfigOutput.trim().split(/\s+/);
    const epairRegex = /^epair(\d+)a$/;

    for (const iface of interfaces) {
      const match = iface.match(epairRegex);
      if (match) {
        const epairNum = parseInt(match[1], 10);
        // If no group is assigned this epair number, it is orphaned
        if (getAssignedEpair(`_epair_check_${epairNum}`) === undefined) {
          try {
            execFileSync('sudo', ['ifconfig', iface, 'destroy'], {
              stdio: 'pipe',
              timeout: JAIL_QUICK_OP_TIMEOUT,
            });
            logger.info({ epairNum, iface }, 'Destroyed orphan epair');
          } catch {
            logger.warn({ epairNum, iface }, 'Could not destroy orphan epair');
          }
        }
      }
    }
  } catch {
    // No epairs or error listing interfaces
  }
}

/**
 * Destroy ALL epair interfaces on the host (used during full shutdown).
 */
export async function destroyAllEpairInterfaces(): Promise<void> {
  const sudoExec = getSudoExec();
  try {
    const ifconfigOutput = execFileSync('ifconfig', ['-l'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const interfaces = ifconfigOutput.trim().split(/\s+/);
    const epairRegex = /^epair(\d+)a$/;

    for (const iface of interfaces) {
      if (epairRegex.test(iface)) {
        try {
          await sudoExec(['ifconfig', iface, 'destroy']);
        } catch {
          logger.warn({ iface }, 'Failed to destroy epair');
        }
      }
    }
  } catch {
    // No epairs or error listing interfaces
  }
}

/**
 * Kill orphaned NanoClaw jails from previous runs.
 * Delegates to cleanupByJailName() in lifecycle.ts for each jail,
 * which ensures proper stop, unmount, dataset destroy, AND token revocation.
 */
export function cleanupOrphans(): void {
  const orphans = listRunningNanoclawJails();

  for (const jailName of orphans) {
    cleanupByJailName(jailName).catch((err) => {
      logger.warn({ jailName, err }, 'Could not clean up orphaned jail');
    });
  }

  if (JAIL_CONFIG.networkMode === 'restricted') {
    cleanupOrphanEpairs();
  }

  if (orphans.length > 0) {
    logger.info(
      { count: orphans.length, names: orphans },
      'Cleaned up orphaned jails',
    );
  }
}

/**
 * Clean up all running NanoClaw jails (called during shutdown).
 * Delegates to cleanupByJailName() in lifecycle.ts for each jail,
 * which ensures proper stop, unmount, dataset destroy, AND token revocation.
 */
export async function cleanupAllJails(): Promise<void> {
  const jailNames = listRunningNanoclawJails();

  if (jailNames.length === 0) {
    logger.debug('No NanoClaw jails to clean up');
    return;
  }

  logger.info(
    { count: jailNames.length, names: jailNames },
    'Cleaning up all jails',
  );

  for (const jailName of jailNames) {
    try {
      await cleanupByJailName(jailName);
    } catch (err) {
      logger.warn({ jailName, err }, 'Cleanup failed for jail');
    }
  }

  if (JAIL_CONFIG.networkMode === 'restricted') {
    await destroyAllEpairInterfaces();
    clearAllEpairs();
  }

  cleanupHostTempFiles();
  logger.info('Finished cleaning up all NanoClaw jails');
}

/** Ensure the jail subsystem is available. */
export function ensureJailRuntimeRunning(): void {
  try {
    execFileSync('zfs', ['version'], {
      stdio: 'pipe',
      timeout: JAIL_QUICK_OP_TIMEOUT,
    });

    const snapshot = `${JAIL_CONFIG.templateDataset}@${JAIL_CONFIG.templateSnapshot}`;
    execFileSync('zfs', ['list', '-t', 'snapshot', '-H', snapshot], {
      stdio: 'pipe',
      timeout: JAIL_QUICK_OP_TIMEOUT,
    });

    execFileSync('which', ['jail'], {
      stdio: 'pipe',
      timeout: JAIL_QUICK_OP_TIMEOUT,
    });

    // Import validatePfConfiguration from network to avoid circular deps
    // pf validation is done inline here
    if (JAIL_CONFIG.networkMode === 'restricted') {
      restoreEpairState();
    }

    logger.info('Jail runtime verified');
  } catch (err) {
    logger.fatal(
      {
        err,
        templateDataset: JAIL_CONFIG.templateDataset,
        templateSnapshot: JAIL_CONFIG.templateSnapshot,
      },
      'FATAL: Jail runtime requirements not met. Ensure ZFS is available, template snapshot exists, and jail(8) is in PATH',
    );
    throw new Error('Jail runtime requirements not met');
  }
}
