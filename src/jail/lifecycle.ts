/**
 * Jail lifecycle: create, stop, destroy, and jail state queries.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import pino from 'pino';
import { logger } from '../logger.js';
import {
  JAIL_STOP_TIMEOUT,
  JAIL_FORCE_STOP_TIMEOUT,
  JAIL_QUICK_OP_TIMEOUT,
} from './config.js';
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
} from './mounts.js';
import {
  logCleanupAudit,
  retryWithBackoff,
  listRunningNanoclawJails,
} from './cleanup.js';
import { DATA_DIR } from '../config.js';
import type {
  JailMount,
  JailMountPaths,
  JailCreationResult,
  EpairInfo,
} from './types.js';

/** Track active jails */
const activeJails = new Set<string>();

/** Map groupId -> credential proxy token for per-jail auth */
const jailTokens = new Map<string, string>();

/** Track per-jail temp directories that need cleanup */
const jailTempDirs = new Map<string, Set<string>>();

/** Track persistent jails that survive between sessions */
const persistentJails = new Map<
  string,
  import('./types.js').PersistentJailState
>();

/** Get persistent jail state for a group */
export function getPersistentJail(
  groupId: string,
): import('./types.js').PersistentJailState | undefined {
  return persistentJails.get(groupId);
}

/** Store persistent jail state */
export function setPersistentJail(
  groupId: string,
  state: import('./types.js').PersistentJailState,
): void {
  persistentJails.set(groupId, state);
}

/** Remove persistent jail state */
export function removePersistentJail(groupId: string): void {
  persistentJails.delete(groupId);
}

/** Get all persistent jail states */
export function getAllPersistentJails(): import('./types.js').PersistentJailState[] {
  return [...persistentJails.values()];
}

/** Update lastUsedAt and increment sessionCount */
export function updatePersistentJailLastUsed(groupId: string): void {
  const state = persistentJails.get(groupId);
  if (state) {
    state.lastUsedAt = Date.now();
    state.sessionCount++;
  }
}

/** Idle timeout scanner interval handle */
let idleTimeoutInterval: ReturnType<typeof setInterval> | null = null;

/** Start scanning for idle persistent jails */
export function startIdleTimeoutScanner(
  intervalMs: number = 60000,
  idleTimeout?: number,
): void {
  if (idleTimeoutInterval) return;

  logger.info({ intervalMs }, 'Starting idle timeout scanner');

  idleTimeoutInterval = setInterval(async () => {
    const timeout =
      idleTimeout ?? (await import('./config.js')).JAIL_IDLE_TIMEOUT;
    const now = Date.now();
    for (const state of getAllPersistentJails()) {
      if (now - state.lastUsedAt > timeout) {
        try {
          logger.info(
            { jailName: state.jailName, groupId: state.groupId },
            'Destroying idle persistent jail',
          );
          await cleanupJail(state.groupId, state.mounts);
          // eslint-disable-next-line no-catch-all/no-catch-all
        } catch (err) {
          logger.warn(
            { jailName: state.jailName, err },
            'Failed to clean up idle persistent jail',
          );
        }
      }
    }
  }, intervalMs);
}

/** Stop the idle timeout scanner */
export function stopIdleTimeoutScanner(): void {
  if (idleTimeoutInterval) {
    clearInterval(idleTimeoutInterval);
    idleTimeoutInterval = null;
  }
}

/** Path to persistent token state file */
const TOKEN_STATE_FILE = path.join(DATA_DIR, 'jail-tokens.json');

/**
 * Persist token state to disk for crash recovery.
 */
function persistTokenState(): void {
  try {
    const stateDir = path.dirname(TOKEN_STATE_FILE);
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o755 });
    }
    const state = Object.fromEntries(jailTokens);
    fs.writeFileSync(TOKEN_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (error) {
    logger.warn(
      { err: error, file: TOKEN_STATE_FILE },
      'Failed to persist token state',
    );
  }
}

/**
 * Restore token state from disk and sync with actually running jails.
 */
export function restoreTokenState(): void {
  if (!fs.existsSync(TOKEN_STATE_FILE)) {
    logger.debug('No token state file found — first startup');
    return;
  }

  let state: Record<string, string>;
  try {
    const data = fs.readFileSync(TOKEN_STATE_FILE, 'utf-8');
    state = JSON.parse(data) as Record<string, string>;
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (error) {
    logger.warn(
      { err: error, file: TOKEN_STATE_FILE },
      'Failed to restore token state — corrupt file',
    );
    return;
  }

  const running = listRunningNanoclawJails();
  const runningSet = new Set(running);
  let restored = 0;
  let discarded = 0;

  for (const [groupId, token] of Object.entries(state)) {
    const jailName = getJailName(groupId);
    if (runningSet.has(jailName)) {
      jailTokens.set(groupId, token);
      registerJailToken(token);
      restored++;
    } else {
      logger.info(
        { groupId, jailName },
        'Discarding stale token — jail no longer running',
      );
      discarded++;
    }
  }

  // Log warnings for running jails with no persisted token
  for (const name of running) {
    const matchedGroup = [...jailTokens.entries()].find(
      ([gid]) => getJailName(gid) === name,
    );
    if (!matchedGroup) {
      logger.warn(
        { jailName: name },
        'Orphaned jail with no persisted token — cleanup will handle',
      );
    }
  }

  logger.info(
    { restored, discarded, file: TOKEN_STATE_FILE },
    'Restored token state from disk',
  );

  persistTokenState();
}

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
    // eslint-disable-next-line no-catch-all/no-catch-all
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
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return false;
  }
}

/** Check if a ZFS dataset exists */
export function datasetExists(dataset: string): boolean {
  try {
    execFileSync('zfs', ['list', '-H', dataset], { stdio: 'pipe' });
    return true;
    // eslint-disable-next-line no-catch-all/no-catch-all
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
      'rctl',
      '-a',
      `jail:${jailName}:memoryuse:deny=${limits.memoryuse}`,
    ]);
    await sudoExec([
      'rctl',
      '-a',
      `jail:${jailName}:maxproc:deny=${limits.maxproc}`,
    ]);
    await sudoExec(['rctl', '-a', `jail:${jailName}:pcpu:deny=${limits.pcpu}`]);

    // Apply optional additional limits (empty string = skip)
    const optionalLimits: Array<[string, string]> = [
      ['readbps', limits.readbps],
      ['writebps', limits.writebps],
      ['openfiles', limits.openfiles],
      ['wallclock', limits.wallclock],
    ];
    for (const [resource, value] of optionalLimits) {
      if (value) {
        await sudoExec([
          'rctl',
          '-a',
          `jail:${jailName}:${resource}:deny=${value}`,
        ]);
      }
    }

    logger.info({ jailName, limits }, 'Applied rctl limits');
    // eslint-disable-next-line no-catch-all/no-catch-all
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
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (error) {
    logger.debug(
      { jailName, err: error },
      'Could not remove rctl limits (may not exist)',
    );
  }
}

/**
 * Check template version metadata and log it at startup.
 * Warns if the template is older than 30 days.
 */
export function checkTemplateVersion(): void {
  const templateBase =
    JAIL_CONFIG.templateDataset.split('/').pop() || 'template';
  const versionFile = path.join(
    JAIL_CONFIG.jailsPath,
    templateBase,
    'etc',
    'nanoclaw-template-version',
  );

  try {
    if (!fs.existsSync(versionFile)) {
      logger.warn(
        { versionFile },
        'Template version file not found -- rebuild template with latest setup-jail-template.sh',
      );
      return;
    }

    const content = fs.readFileSync(versionFile, 'utf-8');
    const metadata: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) {
        metadata[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
    }

    logger.info({ templateVersion: metadata }, 'Jail template version');

    // Warn if template is older than 30 days
    if (metadata.built) {
      const builtDate = new Date(metadata.built);
      const ageMs = Date.now() - builtDate.getTime();
      const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
      if (ageDays > 30) {
        logger.warn(
          { ageDays, built: metadata.built },
          'Jail template is older than 30 days -- consider rebuilding with setup-jail-template.sh',
        );
      }
    }
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (err) {
    logger.warn({ err, versionFile }, 'Failed to read template version');
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
      // eslint-disable-next-line no-catch-all/no-catch-all
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
  const { jailName, epairInfo } = await createJail(
    groupId,
    mounts,
    traceId,
    tracedLogger,
  );
  return { jailName, mounts, epairInfo: epairInfo ?? undefined };
}

/**
 * Create a new jail from template snapshot.
 */
export async function createJail(
  groupId: string,
  mounts: JailMount[] = [],
  _traceId?: string,
  tracedLogger?: pino.Logger,
): Promise<{ jailName: string; epairInfo: EpairInfo | null }> {
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
      // eslint-disable-next-line no-catch-all/no-catch-all
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
    const tmpClaudeJson = path.join(
      '/tmp',
      `nanoclaw-claude-json-${crypto.randomUUID()}`,
    );
    fs.writeFileSync(tmpClaudeJson, '{}');
    try {
      await sudoExec([
        'cp',
        tmpClaudeJson,
        `${jailPath}/home/node/.claude.json`,
      ]);
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
    persistTokenState();

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
      const { incrementJailCreateCounter } = await import('./metrics.js');
      incrementJailCreateCounter(true);
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch {
      // Metrics module may not be available
    }
    return { jailName, epairInfo };
  } catch (error) {
    try {
      const { incrementJailCreateCounter } = await import('./metrics.js');
      incrementJailCreateCounter(false);
      // eslint-disable-next-line no-catch-all/no-catch-all
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

  // Discover nullfs mounts when none were supplied (e.g. orphan cleanup)
  if (mounts.length === 0) {
    try {
      const mountOutput = execFileSync('mount', ['-t', 'nullfs'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const discovered = mountOutput
        .split('\n')
        .filter((line) => line.includes(jailPath))
        .map((line) => {
          const match = line.match(/^(.+?) on (.+?) \(/);
          if (!match) return null;
          return {
            hostPath: match[1],
            jailPath: match[2].replace(jailPath, ''),
            readonly: false,
          };
        })
        .filter((m): m is JailMount => m !== null);
      mounts = discovered;
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch {
      /* continue with empty list */
    }
  }

  const errors = [];
  const epairNum =
    JAIL_CONFIG.networkMode === 'restricted'
      ? (getAssignedEpair(groupId) ?? null)
      : null;

  try {
    await cleanupJailTempFiles(groupId);
    logCleanupAudit('CLEANUP_TEMP_FILES', jailName, 'SUCCESS');
    // eslint-disable-next-line no-catch-all/no-catch-all
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
          2,
          500,
          2000,
        );
        logCleanupAudit('STOP_JAIL', jailName, 'SUCCESS');
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch (error) {
        logCleanupAudit('STOP_JAIL', jailName, 'FAILED', error);
        errors.push(error as Error);
      }
    }

    if (epairNum !== null) {
      try {
        await retryWithBackoff(
          async () => {
            await releaseEpair(groupId);
          },
          2,
          200,
          1000,
        );
        logCleanupAudit('RELEASE_EPAIR', jailName, 'SUCCESS');
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch (error) {
        logCleanupAudit('RELEASE_EPAIR', jailName, 'FAILED', error);
        errors.push(error as Error);
      }
    }

    try {
      await sudoExec(['umount', '-f', path.join(jailPath, 'dev')]);
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch {
      // Expected to fail if devfs not mounted
    }

    for (let i = mounts.length - 1; i >= 0; i--) {
      const mount = mounts[i];
      const targetPath = path.join(jailPath, mount.jailPath);
      try {
        await sudoExec(['umount', '-f', targetPath]);
        logCleanupAudit('UNMOUNT_NULLFS', jailName, 'SUCCESS');
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch (error) {
        logCleanupAudit('UNMOUNT_NULLFS', jailName, 'FAILED', error);
        errors.push(error as Error);
      }
    }

    // Destroy nc-* snapshots before dataset destroy to avoid children errors
    try {
      const { destroyAllSnapshots } = await import('./snapshots.js');
      await destroyAllSnapshots(groupId);
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch {
      // Non-fatal: zfs destroy -r handles children anyway
    }

    if (datasetExists(dataset)) {
      try {
        await retryWithBackoff(
          async () => {
            await sudoExec(['zfs', 'destroy', '-f', '-r', dataset]);
            if (datasetExists(dataset)) {
              throw new Error('Dataset still exists after destroy');
            }
          },
          2,
          500,
          3000,
        );
        logCleanupAudit('DESTROY_DATASET', jailName, 'SUCCESS');
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch (error) {
        logCleanupAudit('DESTROY_DATASET', jailName, 'FAILED', error);
        errors.push(error as Error);
      }
    }

    if (fs.existsSync(fstabPath)) {
      try {
        fs.unlinkSync(fstabPath);
        logCleanupAudit('REMOVE_FSTAB', jailName, 'SUCCESS');
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch (error) {
        logCleanupAudit('REMOVE_FSTAB', jailName, 'FAILED', error);
        errors.push(error as Error);
      }
    }

    if (fs.existsSync(confPath)) {
      try {
        fs.unlinkSync(confPath);
        logCleanupAudit('REMOVE_CONF', jailName, 'SUCCESS');
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch (error) {
        logCleanupAudit('REMOVE_CONF', jailName, 'FAILED', error);
        errors.push(error as Error);
      }
    }
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (unexpectedError) {
    logCleanupAudit(
      'CLEANUP_UNEXPECTED_ERROR',
      jailName,
      'FAILED',
      unexpectedError,
    );
    errors.push(unexpectedError as Error);
  } finally {
    // Always clean up persistent state, tokens, and tracking
    removePersistentJail(groupId);

    const token = jailTokens.get(groupId);
    if (token) {
      revokeJailToken(token);
      jailTokens.delete(groupId);
      persistTokenState();
    }

    activeJails.delete(groupId);

    if (errors.length > 0) {
      logger.warn(
        {
          jailName,
          groupId,
          errorCount: errors.length,
          errors: errors.map((e) => e.message),
        },
        'Jail cleanup completed with errors',
      );
      logCleanupAudit('CLEANUP_END', jailName, 'PARTIAL');
    } else {
      logger.info({ jailName, groupId }, 'Jail cleanup completed successfully');
      logCleanupAudit('CLEANUP_END', jailName, 'SUCCESS');
    }
  }
}

/**
 * Clean up a jail identified by its full jail name (e.g. "nanoclaw_mygroup_abc123").
 * Derives the groupId from the jail name and delegates to cleanupJail(),
 * which handles stop, unmount, dataset destroy, token revocation, etc.
 */
export async function cleanupByJailName(jailName: string): Promise<void> {
  const groupId = jailName.replace(/^nanoclaw_/, '');
  await cleanupJail(groupId);
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
