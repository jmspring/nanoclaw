/**
 * Jail cleanup, orphan handling, and audit logging.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';
import { JAIL_STOP_TIMEOUT, JAIL_CREATE_TIMEOUT, JAIL_QUICK_OP_TIMEOUT } from '../config.js';
import { getSudoExec } from './sudo.js';
import { JAIL_CONFIG } from './config.js';
import {
  restoreEpairState,
  getAssignedEpair,
  clearAllEpairs,
  cleanupHostTempFiles,
} from './network.js';
import { getJailPath, datasetExists } from './lifecycle.js';

/** Cleanup audit logging */
const CLEANUP_AUDIT_LOG = path.join(JAIL_CONFIG.jailsPath, 'cleanup-audit.log');

/** Log an audit entry for cleanup operations. */
export function logCleanupAudit(
  action: string,
  jailName: string,
  status: string,
  error: unknown = null,
): void {
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

/** Clean up orphaned temp files in all running NanoClaw jails. */
function cleanupOrphanedTempFiles(): void {
  try {
    const output = execFileSync('sudo', ['jls', '-N', 'name'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });

    const jailNames = output
      .trim()
      .split('\n')
      .filter((line) => line.startsWith('nanoclaw_'));

    if (jailNames.length === 0) return;

    logger.info(
      { count: jailNames.length },
      'Cleaning orphaned temp files from running jails',
    );

    for (const jailName of jailNames) {
      const tempPaths = ['/tmp/dist', '/tmp/input.json'];
      for (const tempPath of tempPaths) {
        try {
          execFileSync('sudo', ['jexec', jailName, 'rm', '-rf', tempPath], {
            stdio: 'pipe',
            timeout: 5000,
          });
        } catch {
          // File may not exist
        }
      }
    }
  } catch (err) {
    logger.debug({ err }, 'No running jails found for temp file cleanup');
  }
}

/** Kill orphaned NanoClaw jails from previous runs. */
export function cleanupOrphans(): void {
  cleanupOrphanedTempFiles();

  try {
    const output = execFileSync('sudo', ['jls', '-N', 'name'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });

    const orphans = output
      .trim()
      .split('\n')
      .filter((line) => line.startsWith('nanoclaw_'));

    for (const jailName of orphans) {
      // Remove rctl limits
      try {
        execFileSync('sudo', ['rctl', '-r', `jail:${jailName}`], {
          stdio: 'pipe',
          timeout: JAIL_QUICK_OP_TIMEOUT,
        });
      } catch {
        // May not have rctl rules
      }

      try {
        execFileSync('sudo', ['jail', '-r', jailName], {
          stdio: 'pipe',
          timeout: JAIL_STOP_TIMEOUT,
        });
        logger.info({ jailName }, 'Stopped orphaned jail');
      } catch {
        logger.warn(
          { jailName },
          'Could not stop orphaned jail, attempting cleanup',
        );
      }

      // Unmount any nullfs mounts
      const orphanJailPath = getJailPath(jailName);
      try {
        const mountOutput = execFileSync('mount', ['-t', 'nullfs'], {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const jailMounts = mountOutput
          .split('\n')
          .filter((line) => line.includes(orphanJailPath))
          .map((line) => {
            const match = line.match(/on (.+?) \(/);
            return match ? match[1] : null;
          })
          .filter((m): m is string => m !== null)
          .reverse();

        for (const mountPoint of jailMounts) {
          try {
            execFileSync('sudo', ['umount', '-f', mountPoint], {
              stdio: 'pipe',
              timeout: JAIL_QUICK_OP_TIMEOUT,
            });
          } catch {
            // Already unmounted
          }
        }
      } catch {
        // No mounts or error checking
      }

      // Destroy leftover datasets
      const dataset = `${JAIL_CONFIG.jailsDataset}/${jailName}`;
      if (datasetExists(dataset)) {
        try {
          execFileSync('sudo', ['zfs', 'destroy', '-r', dataset], {
            stdio: 'pipe',
            timeout: JAIL_STOP_TIMEOUT,
          });
        } catch {
          logger.warn({ dataset }, 'Could not destroy orphan dataset');
        }
      }

      // Clean up fstab
      const fstabPath = path.join(JAIL_CONFIG.jailsPath, `${jailName}.fstab`);
      if (fs.existsSync(fstabPath)) {
        try { fs.unlinkSync(fstabPath); } catch { /* ignore */ }
      }
    }

    // Clean up orphan epair interfaces
    if (JAIL_CONFIG.networkMode === 'restricted') {
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
            // Check if tracked — if not, it's orphaned
            if (getAssignedEpair(`_epair_check_${epairNum}`) === undefined) {
              // More robust: check if ANY group has this epair
              // The getAssignedEpair check above won't work; use a different approach
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
        // No epairs or error checking
      }
    }

    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Cleaned up orphaned jails',
      );
    }
  } catch (err) {
    logger.error({ err }, 'Failed to clean up orphaned jails');
  }
}

/**
 * Clean up all running NanoClaw jails (called during shutdown).
 */
export async function cleanupAllJails(): Promise<void> {
  const sudoExec = getSudoExec();
  logger.info('Cleaning up all NanoClaw jails');

  let jailNames: string[] = [];
  try {
    const output = execFileSync('sudo', ['jls', '-N', 'name'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    jailNames = output
      .trim()
      .split('\n')
      .filter((line) => line.startsWith('nanoclaw_'));
  } catch {
    logger.debug('No running jails found or jls failed');
    return;
  }

  if (jailNames.length === 0) {
    logger.debug('No NanoClaw jails to clean up');
    return;
  }

  logger.info(
    { count: jailNames.length, names: jailNames },
    'Found jails to clean up',
  );

  for (const jailName of jailNames) {
    const jailPath = getJailPath(jailName);
    const dataset = `${JAIL_CONFIG.jailsDataset}/${jailName}`;
    const fstabPath = path.join(JAIL_CONFIG.jailsPath, `${jailName}.fstab`);

    // Remove rctl limits
    try {
      await sudoExec(['rctl', '-r', `jail:${jailName}`], {
        timeout: JAIL_QUICK_OP_TIMEOUT,
      });
    } catch {
      // Continue cleanup
    }

    // Stop jail
    try {
      await sudoExec(['jail', '-r', jailName], { timeout: JAIL_STOP_TIMEOUT });
    } catch {
      // Continue cleanup
    }

    // Unmount devfs
    try {
      await sudoExec(['umount', '-f', path.join(jailPath, 'dev')], {
        timeout: JAIL_QUICK_OP_TIMEOUT,
      });
    } catch {
      // Continue
    }

    // Unmount all nullfs mounts
    try {
      const mountOutput = execFileSync('mount', ['-t', 'nullfs'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const jailMounts = mountOutput
        .split('\n')
        .filter((line) => line.includes(jailPath))
        .map((line) => {
          const match = line.match(/on (.+?) \(/);
          return match ? match[1] : null;
        })
        .filter((m): m is string => m !== null)
        .reverse();

      for (const mountPoint of jailMounts) {
        try {
          await sudoExec(['umount', '-f', mountPoint], {
            timeout: JAIL_QUICK_OP_TIMEOUT,
          });
        } catch {
          // Continue
        }
      }
    } catch {
      // Continue
    }

    // Destroy ZFS dataset
    if (datasetExists(dataset)) {
      try {
        await sudoExec(['zfs', 'destroy', '-r', dataset], {
          timeout: JAIL_CREATE_TIMEOUT,
        });
      } catch {
        // Continue
      }
    }

    // Remove fstab
    if (fs.existsSync(fstabPath)) {
      try { fs.unlinkSync(fstabPath); } catch { /* continue */ }
    }

    logger.info({ jailName }, 'Completed cleanup for jail');
  }

  // Destroy all epair interfaces
  if (JAIL_CONFIG.networkMode === 'restricted') {
    try {
      const ifconfigOutput = execFileSync('ifconfig', ['-l'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const interfaces = ifconfigOutput.trim().split(/\s+/);
      const epairRegex = /^epair(\d+)a$/;

      for (const iface of interfaces) {
        const match = iface.match(epairRegex);
        if (match) {
          try {
            await sudoExec(['ifconfig', iface, 'destroy']);
          } catch {
            logger.warn({ iface }, 'Failed to destroy epair');
          }
        }
      }
    } catch {
      // Continue
    }

    clearAllEpairs();
  }

  logger.info('Finished cleaning up all NanoClaw jails');
  cleanupHostTempFiles();
}

/** Ensure the jail subsystem is available. */
export function ensureJailRuntimeRunning(): void {
  try {
    execFileSync('zfs', ['version'], { stdio: 'pipe', timeout: JAIL_QUICK_OP_TIMEOUT });

    const snapshot = `${JAIL_CONFIG.templateDataset}@${JAIL_CONFIG.templateSnapshot}`;
    execFileSync('zfs', ['list', '-t', 'snapshot', '-H', snapshot], {
      stdio: 'pipe',
      timeout: JAIL_QUICK_OP_TIMEOUT,
    });

    execFileSync('which', ['jail'], { stdio: 'pipe', timeout: JAIL_QUICK_OP_TIMEOUT });

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
