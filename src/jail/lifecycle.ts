/**
 * Jail lifecycle: create, exec, spawn, stop, destroy.
 */
import { execFileSync, spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import pino from 'pino';
import { logger } from '../logger.js';
import {
  DATA_DIR,
  JAIL_EXEC_TIMEOUT,
  JAIL_CREATE_TIMEOUT,
  JAIL_STOP_TIMEOUT,
  JAIL_FORCE_STOP_TIMEOUT,
  JAIL_QUICK_OP_TIMEOUT,
} from '../config.js';
import { registerJailToken, revokeJailToken } from '../credential-proxy.js';
import { getSudoExec, getSudoExecSync } from './sudo.js';
import { JAIL_CONFIG, MAX_CONCURRENT_JAILS } from './config.js';
import {
  createEpair,
  configureJailNetwork,
  releaseEpair,
  setupJailResolv,
  getAssignedEpair,
} from './network.js';
import {
  buildJailMounts,
  ensureHostDirectories,
  buildFstab,
  createMountPoints,
  mountNullfs,
  unmountAll,
} from './mounts.js';
import { logCleanupAudit, retryWithBackoff } from './cleanup.js';
import type {
  JailMount,
  JailMountPaths,
  JailCreationResult,
  ExecResult,
  ExecInJailOptions,
  SpawnInJailOptions,
  EpairInfo,
} from './types.js';

/** Track active jails */
const activeJails = new Set<string>();

/** Map groupId -> credential proxy token for per-jail auth */
const jailTokens = new Map<string, string>();

/** Track per-jail temp directories that need cleanup */
const jailTempDirs = new Map<string, Set<string>>();

/** Sanitize groupId for use in jail names (alphanumeric + underscore only). */
export function sanitizeJailName(groupId: string): string {
  const sanitized = groupId.replace(/[^a-zA-Z0-9_]/g, '_');
  const hash = crypto
    .createHash('sha256')
    .update(groupId)
    .digest('hex')
    .slice(0, 6);

  if (sanitized !== groupId) {
    logger.debug(
      { original: groupId, sanitized, hash },
      'Group name sanitized for jail compatibility',
    );
  }

  return `${sanitized}_${hash}`;
}

/** Generate jail name from groupId */
export function getJailName(groupId: string): string {
  return `nanoclaw_${sanitizeJailName(groupId)}`;
}

/** Get the ZFS dataset path for a jail */
function getJailDataset(jailName: string): string {
  return `${JAIL_CONFIG.jailsDataset}/${jailName}`;
}

/** Get the filesystem path for a jail root */
export function getJailPath(jailName: string): string {
  return path.join(JAIL_CONFIG.jailsPath, jailName);
}

/** Get the fstab path for a jail */
function getFstabPath(jailName: string): string {
  return path.join(JAIL_CONFIG.jailsPath, `${jailName}.fstab`);
}

/** Get the jail.conf path for a jail */
function getConfPath(jailName: string): string {
  return path.join(JAIL_CONFIG.jailsPath, `${jailName}.conf`);
}

/** Check if a jail exists and is running */
export function isJailRunning(jailName: string): boolean {
  const sudoExecSync = getSudoExecSync();
  try {
    const output = sudoExecSync(['jls', '-j', jailName, 'jid'], {
      stdio: 'pipe',
    });
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

/** Check if a jail exists and is running (async — preferred in hot paths) */
export async function isJailRunningAsync(jailName: string): Promise<boolean> {
  const sudoExec = getSudoExec();
  try {
    const result = await sudoExec(['jls', '-j', jailName, 'jid'], {
      stdio: 'pipe',
    });
    return result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** Check if a ZFS dataset exists */
export function datasetExists(dataset: string): boolean {
  try {
    execFileSync('zfs', ['list', '-H', dataset], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Apply rctl resource limits to a jail. */
async function applyRctlLimits(jailName: string): Promise<void> {
  const limits = JAIL_CONFIG.resourceLimits;
  const sudoExec = getSudoExec();

  try {
    await sudoExec([
      'rctl', '-a', `jail:${jailName}:memoryuse:deny=${limits.memoryuse}`,
    ]);
    await sudoExec([
      'rctl', '-a', `jail:${jailName}:maxproc:deny=${limits.maxproc}`,
    ]);
    await sudoExec(['rctl', '-a', `jail:${jailName}:pcpu:deny=${limits.pcpu}`]);
    logger.info({ jailName, limits }, 'Applied rctl limits');
  } catch (error) {
    logger.warn({ jailName, err: error }, 'Could not apply rctl limits');
  }
}

/** Remove rctl resource limits from a jail. */
export async function removeRctlLimits(jailName: string): Promise<void> {
  const sudoExec = getSudoExec();
  try {
    await sudoExec(['rctl', '-r', `jail:${jailName}`]);
    logger.debug({ jailName }, 'Removed rctl limits');
  } catch (error) {
    logger.debug(
      { jailName, err: error },
      'Could not remove rctl limits (may not exist)',
    );
  }
}

/** Get the credential proxy token for a jail. */
export function getJailToken(groupId: string): string | undefined {
  return jailTokens.get(groupId);
}

/** Track temp files created during a jail session for later cleanup. */
export function trackJailTempFile(groupId: string, tempPath: string): void {
  if (!jailTempDirs.has(groupId)) {
    jailTempDirs.set(groupId, new Set());
  }
  jailTempDirs.get(groupId)!.add(tempPath);
  logger.debug({ groupId, tempPath }, 'Tracking jail temp file');
}

/** Clean up tracked temp files for a jail session. */
async function cleanupJailTempFiles(groupId: string): Promise<void> {
  const jailName = getJailName(groupId);
  let tempPaths = jailTempDirs.get(groupId);

  if (!tempPaths || tempPaths.size === 0) {
    tempPaths = new Set(['/tmp/dist', '/tmp/input.json']);
  }

  if (!isJailRunning(jailName)) {
    logger.debug(
      { groupId, jailName },
      'Jail not running, skipping temp file cleanup',
    );
    jailTempDirs.delete(groupId);
    return;
  }

  logger.info(
    { groupId, jailName, count: tempPaths.size },
    'Cleaning up jail temp files',
  );

  for (const tempPath of tempPaths) {
    try {
      await getSudoExec()(['jexec', jailName, 'rm', '-rf', tempPath], {
        timeout: 5000,
      });
      logger.debug({ groupId, tempPath }, 'Removed jail temp file');
    } catch (error) {
      logger.debug(
        { groupId, tempPath, err: error },
        'Could not remove jail temp file (may not exist)',
      );
    }
  }

  jailTempDirs.delete(groupId);
}

/**
 * Create a new jail from template snapshot using semantic paths.
 */
export async function createJailWithPaths(
  groupId: string,
  paths: JailMountPaths,
  traceId?: string,
  tracedLogger?: pino.Logger,
): Promise<JailCreationResult> {
  ensureHostDirectories(paths);
  const mounts = buildJailMounts(paths);
  const jailName = await createJail(groupId, mounts, traceId, tracedLogger);
  return { jailName, mounts };
}

/**
 * Create a new jail from template snapshot.
 */
export async function createJail(
  groupId: string,
  mounts: JailMount[] = [],
  traceId?: string,
  tracedLogger?: pino.Logger,
): Promise<string> {
  const sudoExec = getSudoExec();
  const log = tracedLogger || logger;
  const jailName = getJailName(groupId);
  const dataset = getJailDataset(jailName);
  const jailPath = getJailPath(jailName);
  const fstabPath = getFstabPath(jailName);
  const snapshot = `${JAIL_CONFIG.templateDataset}@${JAIL_CONFIG.templateSnapshot}`;

  if (!activeJails.has(groupId) && activeJails.size >= MAX_CONCURRENT_JAILS) {
    throw new Error(
      `Cannot create jail: maximum concurrent jail limit reached (${MAX_CONCURRENT_JAILS}). ` +
        `Currently active: ${activeJails.size}. Configure NANOCLAW_MAX_JAILS to adjust limit.`,
    );
  }

  log.info({ jailName, groupId }, 'Creating jail');

  if (isJailRunning(jailName)) {
    log.info({ jailName }, 'Jail already running, stopping first');
    await stopJail(groupId);
  }

  if (datasetExists(dataset)) {
    log.info({ dataset }, 'Dataset exists, destroying first');
    try {
      await sudoExec(['zfs', 'destroy', '-r', dataset]);
    } catch (error) {
      log.warn({ dataset, err: error }, 'Could not destroy existing dataset');
    }
  }

  try {
    log.debug({ snapshot, dataset }, 'Cloning template');
    await sudoExec(['zfs', 'clone', snapshot, dataset]);

    const jailQuota = process.env.NANOCLAW_JAIL_QUOTA || '1G';
    await sudoExec(['zfs', 'set', `quota=${jailQuota}`, dataset]);
    await sudoExec(['zfs', 'set', 'setuid=off', dataset]);

    await createMountPoints(mounts, jailPath);

    const fstabContent = buildFstab(mounts, jailPath);
    fs.writeFileSync(fstabPath, fstabContent);
    log.debug({ fstabPath, mountCount: mounts.length }, 'Wrote fstab');

    await mountNullfs(mounts, jailPath);

    // Create .claude directory and .claude.json for Claude Code
    await sudoExec(['mkdir', '-p', `${jailPath}/home/node/.claude`]);
    const tmpClaudeJson = path.join('/tmp', `nanoclaw-claude-json-${crypto.randomUUID()}`);
    fs.writeFileSync(tmpClaudeJson, '{}');
    try {
      await sudoExec(['cp', tmpClaudeJson, `${jailPath}/home/node/.claude.json`]);
    } finally {
      fs.unlinkSync(tmpClaudeJson);
    }
    await sudoExec(['chown', '-R', '1000:1000', `${jailPath}/home/node`]);
    await sudoExec(['chmod', '1777', `${jailPath}/tmp`]);

    // Network setup for restricted mode
    let epairInfo: EpairInfo | null = null;
    if (JAIL_CONFIG.networkMode === 'restricted') {
      epairInfo = await createEpair(groupId);
      log.info({ groupId, ...epairInfo }, 'Created epair for jail');
      await setupJailResolv(jailPath);
    }

    // Build network configuration for jail.conf
    let networkConfig: string;
    if (JAIL_CONFIG.networkMode === 'inherit') {
      networkConfig = '  ip4 = inherit;\n  ip6 = inherit;';
    } else if (JAIL_CONFIG.networkMode === 'restricted' && epairInfo) {
      networkConfig = `  vnet;\n  vnet.interface = "${epairInfo.jailIface}";`;
    } else {
      networkConfig = '  vnet;';
    }

    // Write jail.conf and create jail
    const confPath = getConfPath(jailName);
    const confContent = `${jailName} {
  path = "${jailPath}";
  host.hostname = "${jailName}";
  persist;
  enforce_statfs = 2;
  mount.devfs;
  devfs_ruleset = 10;
  securelevel = 3;
${networkConfig}
}
`;
    fs.writeFileSync(confPath, confContent);
    log.debug({ jailName, confPath }, 'Wrote jail.conf');
    await sudoExec(['jail', '-f', confPath, '-c', jailName]);

    await applyRctlLimits(jailName);

    if (JAIL_CONFIG.networkMode === 'restricted' && epairInfo) {
      await configureJailNetwork(jailName, epairInfo);
    }

    activeJails.add(groupId);

    // Generate per-jail credential proxy token
    const jailToken = crypto.randomUUID();
    jailTokens.set(groupId, jailToken);
    registerJailToken(jailToken);

    log.info(
      {
        jailName,
        groupId,
        activeCount: activeJails.size,
        maxJails: MAX_CONCURRENT_JAILS,
      },
      'Jail created successfully',
    );

    try {
      const { incrementJailCreateCounter } = await import('../metrics.js');
      incrementJailCreateCounter(true);
    } catch {
      // Metrics module may not be available
    }
    return jailName;
  } catch (error) {
    try {
      const { incrementJailCreateCounter } = await import('../metrics.js');
      incrementJailCreateCounter(false);
    } catch {
      // Metrics module may not be available
    }

    log.error(
      { jailName, groupId, err: error },
      'Jail creation failed, cleaning up',
    );
    await cleanupJail(groupId, mounts);
    throw error;
  }
}

/**
 * Execute a command inside a jail.
 */
export async function execInJail(
  groupId: string,
  command: string[],
  options: ExecInJailOptions = {},
): Promise<ExecResult> {
  const jailName = getJailName(groupId);
  const { env = {}, cwd, timeout, signal, onStdout, onStderr } = options;

  if (!isJailRunning(jailName)) {
    throw new Error(`Jail ${jailName} is not running`);
  }

  return new Promise((resolve, reject) => {
    const args = ['jexec', '-U', 'node'];

    if (cwd) {
      args.push('-d', cwd);
    }

    args.push(jailName);
    args.push('sh', '-c', 'umask 002; exec "$@"', '_');

    const envEntries = Object.entries(env);
    if (envEntries.length > 0) {
      args.push('env');
      for (const [key, value] of envEntries) {
        args.push(`${key}=${value}`);
      }
    }

    args.push(...command);

    logger.debug(
      { jailName, groupId, command: command.join(' '), cwd },
      'Executing in jail',
    );

    const proc = spawn('sudo', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const killJailProcesses = () => {
      try {
        execFileSync('sudo', ['jexec', jailName, 'kill', '-9', '-1'], {
          stdio: 'pipe',
          timeout: JAIL_QUICK_OP_TIMEOUT,
        });
      } catch {
        // Jail may have already stopped
      }
      proc.kill('SIGKILL');
    };

    const timeoutId = timeout
      ? setTimeout(() => {
          if (settled) return;
          timedOut = true;
          logger.warn(
            { jailName, groupId, timeout },
            'Execution timeout, killing jail processes',
          );
          killJailProcesses();
        }, timeout)
      : null;

    const abortHandler = () => {
      if (settled) return;
      aborted = true;
      logger.warn({ jailName, groupId }, 'Execution aborted via signal');
      killJailProcesses();
    };

    if (signal) {
      if (signal.aborted) {
        reject(new Error('Execution aborted'));
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      if (onStdout) onStdout(chunk);
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      if (onStderr) onStderr(chunk);
    });

    proc.on('close', (code) => {
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (signal) signal.removeEventListener('abort', abortHandler);

      if (aborted) {
        reject(new Error('Execution aborted'));
        return;
      }

      if (timedOut) {
        reject(new Error(`Execution timed out after ${timeout}ms`));
        return;
      }

      logger.debug({ jailName, groupId, code }, 'Execution completed');
      resolve({ code: code || 0, stdout, stderr });
    });

    proc.on('error', (error) => {
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (signal) signal.removeEventListener('abort', abortHandler);
      logger.error({ jailName, groupId, err: error }, 'Execution error');
      reject(error);
    });
  });
}

/**
 * Spawn an interactive process inside a jail (for streaming I/O).
 */
export function spawnInJail(
  groupId: string,
  command: string[],
  options: SpawnInJailOptions = {},
): ChildProcess {
  const jailName = getJailName(groupId);
  const { env = {}, cwd } = options;

  const args = ['jexec', '-U', 'node'];

  if (cwd) {
    args.push('-d', cwd);
  }

  args.push(jailName);
  args.push('env');
  for (const [key, value] of Object.entries(env)) {
    args.push(`${key}=${value}`);
  }

  if (command[0] === 'sh' && command[1] === '-c' && command.length >= 3) {
    args.push('sh', '-c', `umask 002; ${command[2]}`);
    args.push(...command.slice(3));
  } else {
    args.push('sh', '-c', `umask 002; exec "$@"`, '_', ...command);
  }

  logger.debug(
    { jailName, groupId, command: command.join(' '), cwd },
    'Spawning in jail',
  );

  return spawn('sudo', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Stop a running jail.
 */
export async function stopJail(groupId: string): Promise<void> {
  const sudoExec = getSudoExec();
  const jailName = getJailName(groupId);

  if (!isJailRunning(jailName)) {
    logger.debug({ jailName, groupId }, 'Jail not running');
    return;
  }

  logger.info({ jailName, groupId }, 'Stopping jail');

  try {
    await sudoExec(['jail', '-r', jailName], { timeout: JAIL_STOP_TIMEOUT });
    logger.info({ jailName, groupId }, 'Jail stopped');
  } catch (error) {
    logger.warn(
      { jailName, groupId, err: error },
      'Failed to stop jail gracefully, trying force',
    );
    try {
      await sudoExec(['jexec', jailName, 'kill', '-9', '-1'], {
        timeout: JAIL_QUICK_OP_TIMEOUT,
      }).catch(() => {});
      await sudoExec(['jail', '-r', jailName], {
        timeout: JAIL_FORCE_STOP_TIMEOUT,
      });
      logger.info({ jailName, groupId }, 'Jail force stopped');
    } catch (forceError) {
      logger.error(
        { jailName, groupId, err: forceError },
        'Failed to force stop jail',
      );
      throw forceError;
    }
  }
}

/**
 * Force cleanup of a jail using aggressive methods when normal cleanup fails.
 */
async function forceCleanup(
  jailName: string,
  mounts: JailMount[],
  dataset: string,
  jailPath: string,
  epairNum: number | null = null,
): Promise<void> {
  const sudoExec = getSudoExec();
  logger.info({ jailName }, 'Starting force cleanup');
  logCleanupAudit('FORCE_CLEANUP_START', jailName, 'INFO');

  const errors = [];

  if (isJailRunning(jailName)) {
    try {
      await sudoExec(['jexec', jailName, 'kill', '-9', '-1'], {
        timeout: JAIL_QUICK_OP_TIMEOUT,
      });
      logCleanupAudit('KILL_PROCESSES', jailName, 'SUCCESS');
    } catch (error) {
      logCleanupAudit('KILL_PROCESSES', jailName, 'FAILED', error);
      errors.push(error as Error);
    }

    try {
      await sudoExec(['jail', '-r', jailName], {
        timeout: JAIL_FORCE_STOP_TIMEOUT,
      });
      logCleanupAudit('FORCE_STOP_JAIL', jailName, 'SUCCESS');
    } catch (error) {
      logCleanupAudit('FORCE_STOP_JAIL', jailName, 'FAILED', error);
      errors.push(error as Error);
    }
  }

  try {
    await sudoExec(['umount', '-f', path.join(jailPath, 'dev')], {
      timeout: JAIL_QUICK_OP_TIMEOUT,
    });
  } catch {
    // Expected to fail if not mounted
  }

  for (let i = mounts.length - 1; i >= 0; i--) {
    const mount = mounts[i];
    const targetPath = path.join(jailPath, mount.jailPath);
    try {
      await sudoExec(['umount', '-f', targetPath], {
        timeout: JAIL_QUICK_OP_TIMEOUT,
      });
    } catch (error) {
      logCleanupAudit('FORCE_UNMOUNT_NULLFS', jailName, 'FAILED', error);
      errors.push(error as Error);
    }
  }

  if (datasetExists(dataset)) {
    try {
      await sudoExec(['zfs', 'destroy', '-f', '-r', dataset], {
        timeout: JAIL_CREATE_TIMEOUT,
      });
      logCleanupAudit('FORCE_DESTROY_DATASET', jailName, 'SUCCESS');
    } catch (error) {
      logCleanupAudit('FORCE_DESTROY_DATASET', jailName, 'FAILED', error);
      errors.push(error as Error);
    }
  }

  if (epairNum !== null) {
    try {
      const hostIface = `epair${epairNum}a`;
      await sudoExec(['ifconfig', hostIface, 'destroy'], {
        timeout: JAIL_QUICK_OP_TIMEOUT,
      });
    } catch (error) {
      logCleanupAudit('FORCE_DESTROY_EPAIR', jailName, 'FAILED', error);
      errors.push(error as Error);
    }
  }

  if (errors.length > 0) {
    logCleanupAudit(
      'FORCE_CLEANUP_END', jailName, 'PARTIAL',
      new Error(`${errors.length} errors during force cleanup`),
    );
    throw new AggregateError(
      errors,
      `Force cleanup completed with ${errors.length} error(s)`,
    );
  } else {
    logCleanupAudit('FORCE_CLEANUP_END', jailName, 'SUCCESS');
    logger.info({ jailName }, 'Force cleanup completed successfully');
  }
}

/**
 * Clean up jail resources (unmount, destroy dataset, remove fstab, remove IP alias).
 */
export async function cleanupJail(
  groupId: string,
  mounts: JailMount[] = [],
): Promise<void> {
  const sudoExec = getSudoExec();
  const jailName = getJailName(groupId);
  const dataset = getJailDataset(jailName);
  const jailPath = getJailPath(jailName);
  const fstabPath = getFstabPath(jailName);
  const confPath = getConfPath(jailName);

  logger.info({ jailName, groupId }, 'Cleaning up jail');
  logCleanupAudit('CLEANUP_START', jailName, 'INFO');

  const errors = [];
  const epairNum =
    JAIL_CONFIG.networkMode === 'restricted'
      ? getAssignedEpair(groupId) ?? null
      : null;

  try {
    await cleanupJailTempFiles(groupId);
    logCleanupAudit('CLEANUP_TEMP_FILES', jailName, 'SUCCESS');
  } catch (error) {
    logger.warn(
      { jailName, groupId, err: error },
      'Could not clean up temp files',
    );
  }

  await removeRctlLimits(jailName);

  try {
    if (isJailRunning(jailName)) {
      try {
        await retryWithBackoff(
          async () => {
            await stopJail(groupId);
            if (isJailRunning(jailName)) {
              throw new Error('Jail still running after stop');
            }
          },
          2, 500, 2000,
        );
        logCleanupAudit('STOP_JAIL', jailName, 'SUCCESS');
      } catch (error) {
        logCleanupAudit('STOP_JAIL', jailName, 'FAILED', error);
        errors.push(error as Error);
      }
    }

    if (epairNum !== null) {
      try {
        await retryWithBackoff(
          async () => { await releaseEpair(groupId); },
          2, 200, 1000,
        );
        logCleanupAudit('RELEASE_EPAIR', jailName, 'SUCCESS');
      } catch (error) {
        logCleanupAudit('RELEASE_EPAIR', jailName, 'FAILED', error);
        errors.push(error as Error);
      }
    }

    try {
      await sudoExec(['umount', '-f', path.join(jailPath, 'dev')]);
    } catch {
      // Expected to fail if devfs not mounted
    }

    if (mounts.length > 0) {
      try {
        await retryWithBackoff(
          async () => { await unmountAll(mounts, jailPath); },
          2, 300, 2000,
        );
        logCleanupAudit('UNMOUNT_NULLFS', jailName, 'SUCCESS');
      } catch (error) {
        logCleanupAudit('UNMOUNT_NULLFS', jailName, 'FAILED', error);
        errors.push(error as Error);
      }
    }

    if (datasetExists(dataset)) {
      try {
        await retryWithBackoff(
          async () => {
            await sudoExec(['zfs', 'destroy', '-r', dataset]);
            if (datasetExists(dataset)) {
              throw new Error('Dataset still exists after destroy');
            }
          },
          2, 500, 3000,
        );
        logCleanupAudit('DESTROY_DATASET', jailName, 'SUCCESS');
      } catch (error) {
        logCleanupAudit('DESTROY_DATASET', jailName, 'FAILED', error);
        errors.push(error as Error);
      }
    }

    if (fs.existsSync(fstabPath)) {
      try {
        fs.unlinkSync(fstabPath);
        logCleanupAudit('REMOVE_FSTAB', jailName, 'SUCCESS');
      } catch (error) {
        logCleanupAudit('REMOVE_FSTAB', jailName, 'FAILED', error);
        errors.push(error as Error);
      }
    }

    if (fs.existsSync(confPath)) {
      try {
        fs.unlinkSync(confPath);
        logCleanupAudit('REMOVE_CONF', jailName, 'SUCCESS');
      } catch (error) {
        logCleanupAudit('REMOVE_CONF', jailName, 'FAILED', error);
        errors.push(error as Error);
      }
    }
  } catch (unexpectedError) {
    logCleanupAudit('CLEANUP_UNEXPECTED_ERROR', jailName, 'FAILED', unexpectedError);
    errors.push(unexpectedError as Error);
  } finally {
    if (errors.length > 0) {
      logger.warn(
        { jailName, groupId, errorCount: errors.length },
        'Normal cleanup failed, attempting force cleanup',
      );

      try {
        await forceCleanup(jailName, mounts, dataset, jailPath, epairNum);
        logCleanupAudit('CLEANUP_END', jailName, 'SUCCESS_FORCED');
      } catch (forceError) {
        logCleanupAudit('CLEANUP_END', jailName, 'FAILED', forceError);

        if (forceError instanceof AggregateError) {
          errors.push(...forceError.errors);
        } else {
          errors.push(forceError as Error);
        }

        throw new AggregateError(
          errors,
          `Jail cleanup failed (tried normal and force): ${errors.length} error(s)`,
        );
      }
    } else {
      logger.info({ jailName, groupId }, 'Jail cleanup completed successfully');
      logCleanupAudit('CLEANUP_END', jailName, 'SUCCESS');
    }

    // Revoke credential proxy token
    const token = jailTokens.get(groupId);
    if (token) {
      revokeJailToken(token);
      jailTokens.delete(groupId);
    }

    activeJails.delete(groupId);
  }
}

/** Destroy a jail completely (stop + cleanup). */
export async function destroyJail(
  groupId: string,
  mounts: JailMount[] = [],
): Promise<void> {
  await cleanupJail(groupId, mounts);
}

/** Get the current number of active jails. */
export function getActiveJailCount(): number {
  return activeJails.size;
}

/** Get the current jail capacity status. */
export function getJailCapacity(): { current: number; max: number } {
  return { current: activeJails.size, max: MAX_CONCURRENT_JAILS };
}

/** Check if the jail system is at capacity. */
export function isAtJailCapacity(): boolean {
  return activeJails.size >= MAX_CONCURRENT_JAILS;
}

/**
 * Track a jail as active so it won't be cleaned up as an orphan.
 */
export function trackActiveJail(jailName: string): void {
  const groupId = jailName.replace(/^nanoclaw_/, '');
  activeJails.add(groupId);
  logger.debug({ jailName, groupId }, 'Tracked active jail');
}

/** Check if a groupId is tracked as active. */
export function isActiveJail(groupId: string): boolean {
  return activeJails.has(groupId);
}
