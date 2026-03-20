/**
 * FreeBSD Jail runtime for NanoClaw.
 * Replaces Docker/Apple Container runtime with native FreeBSD jails.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execFile, execFileSync, spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
import pino from 'pino';

/** Jail mount specification */
export interface JailMount {
  hostPath: string;
  jailPath: string;
  readonly: boolean;
}

/** Semantic mount paths for jail creation */
export interface JailMountPaths {
  projectPath: string | null;
  groupPath: string;
  ipcPath: string;
  claudeSessionPath: string;
  agentRunnerPath: string;
}

/** Result of jail creation with paths */
export interface JailCreationResult {
  jailName: string;
  mounts: JailMount[];
}

/** Execution result from execInJail */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Options for execInJail */
export interface ExecInJailOptions {
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
}

/** Options for spawnInJail */
export interface SpawnInJailOptions {
  env?: Record<string, string>;
  cwd?: string;
}

/** Epair interface information */
export interface EpairInfo {
  epairNum: number;
  hostIface: string;
  jailIface: string;
  hostIP: string;
  jailIP: string;
  netmask: string;
}

/** Resource limits configuration */
export interface ResourceLimits {
  memoryuse: string;
  maxproc: string;
  pcpu: string;
}

/** Jail configuration */
export interface JailConfig {
  templateDataset: string;
  templateSnapshot: string;
  jailsDataset: string;
  jailsPath: string;
  workspacesPath: string;
  ipcPath: string;
  networkMode: 'inherit' | 'restricted';
  jailHostIP: string;
  jailIP: string;
  jailNetmask: string;
  resourceLimits: ResourceLimits;
}

/** Result from sudoExec */
interface SudoExecResult {
  stdout: string;
  stderr: string;
}

/** Options for sudoExec */
interface SudoExecOptions {
  timeout?: number;
  encoding?: BufferEncoding;
  stdio?: 'pipe' | 'ignore' | 'inherit';
}

/** Type for injectable sudo executor */
export type SudoExecutor = (
  args: string[],
  options?: SudoExecOptions,
) => Promise<SudoExecResult>;

/** Type for injectable sudo executor (synchronous) */
export type SudoExecutorSync = (
  args: string[],
  options?: SudoExecOptions,
) => string;

/** Jail configuration - adjust paths for your environment */
export const JAIL_CONFIG: JailConfig = {
  templateDataset: 'zroot/nanoclaw/jails/template',
  templateSnapshot: 'base',
  jailsDataset: 'zroot/nanoclaw/jails',
  jailsPath: '/home/jims/code/nanoclaw/jails',
  workspacesPath: '/home/jims/code/nanoclaw/workspaces',
  ipcPath: '/home/jims/code/nanoclaw/ipc',
  // Network mode: "inherit" (ip4=inherit) or "restricted" (vnet with epair and pf)
  networkMode:
    (process.env.NANOCLAW_JAIL_NETWORK_MODE as 'inherit' | 'restricted') ||
    'inherit',
  // Jail network configuration (used when networkMode === 'restricted')
  // Each jail gets its own /30 subnet via epair from pool 10.99.0.0/24:
  //   - Jail N uses subnet 10.99.N.0/30 (where N = epair number)
  //   - Host side (epairNa): 10.99.N.1/30 (gateway)
  //   - Jail side (epairNb): 10.99.N.2/30
  // NOTE: These are legacy defaults - actual IPs are calculated per-jail in createEpair()
  jailHostIP: '10.99.0.1',
  jailIP: '10.99.0.2',
  jailNetmask: '30',
  // Resource limits (rctl) - prevents runaway agents from crashing the host
  resourceLimits: {
    memoryuse: process.env.NANOCLAW_JAIL_MEMORY_LIMIT || '2G', // Memory limit
    maxproc: process.env.NANOCLAW_JAIL_MAXPROC || '100', // Max processes (prevents fork bombs)
    pcpu: process.env.NANOCLAW_JAIL_PCPU || '80', // CPU percentage limit
  },
};

/** Maximum number of epairs allowed (configurable via env var) */
const MAX_EPAIRS = parseInt(process.env.NANOCLAW_MAX_EPAIRS || '200', 10);

/** Epair warning threshold (percentage) */
const EPAIR_WARNING_THRESHOLD = 0.8;

/** Track assigned epair numbers for cleanup */
const assignedEpairs = new Map<string, number>(); // groupId -> epair number (e.g., 0 for epair0a/epair0b)

/** Maximum concurrent jails (configurable via env var) */
const MAX_CONCURRENT_JAILS = parseInt(
  process.env.NANOCLAW_MAX_JAILS || '50',
  10,
);

/** Track active jails */
const activeJails = new Set<string>();

/** Path to persistent epair state file */
const EPAIR_STATE_FILE = '/tmp/nanoclaw-epair-state.json';

/** Cleanup audit logging */
const CLEANUP_AUDIT_LOG = path.join(JAIL_CONFIG.jailsPath, 'cleanup-audit.log');

/** Dependency injection context for testing */
export interface JailRuntimeDeps {
  sudoExec: SudoExecutor;
  sudoExecSync: SudoExecutorSync;
}

/** Global dependency injection context (can be overridden for testing) */
let deps: JailRuntimeDeps | null = null;

/**
 * Set dependency injection context for testing.
 * @param newDeps - Dependency overrides
 */
export function setJailRuntimeDeps(newDeps: Partial<JailRuntimeDeps>): void {
  deps = {
    sudoExec: newDeps.sudoExec || defaultSudoExec,
    sudoExecSync: newDeps.sudoExecSync || defaultSudoExecSync,
  };
}

/**
 * Reset dependency injection context to defaults.
 */
export function resetJailRuntimeDeps(): void {
  deps = null;
}

/**
 * Get the current sudo executor (for testing).
 */
function getSudoExec(): SudoExecutor {
  return deps?.sudoExec || defaultSudoExec;
}

/**
 * Get the current sync sudo executor (for testing).
 */
function getSudoExecSync(): SudoExecutorSync {
  return deps?.sudoExecSync || defaultSudoExecSync;
}

function logCleanupAudit(
  action: string,
  jailName: string,
  status: string,
  error: unknown = null,
): void {
  const timestamp = new Date().toISOString();
  const errorMessage = error instanceof Error ? error.message : null;
  const entry = {
    timestamp,
    action,
    jailName,
    status,
    error: errorMessage,
  };
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
 * @param fn - Async function to retry
 * @param maxRetries - Maximum number of retries (default: 3)
 * @param initialDelay - Initial delay in ms (default: 100)
 * @param maxDelay - Maximum delay in ms (default: 5000)
 * @returns Result of the function
 */
async function retryWithBackoff<T>(
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

/** Sanitize groupId for use in jail names (alphanumeric + underscore only) */
export function sanitizeJailName(groupId: string): string {
  return groupId.replace(/[^a-zA-Z0-9_]/g, '_');
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
function getJailPath(jailName: string): string {
  return path.join(JAIL_CONFIG.jailsPath, jailName);
}

/** Get the fstab path for a jail */
function getFstabPath(jailName: string): string {
  return path.join(JAIL_CONFIG.jailsPath, `${jailName}.fstab`);
}

/**
 * Apply rctl resource limits to a jail.
 * @param jailName - The jail name
 */
async function applyRctlLimits(jailName: string): Promise<void> {
  const limits = JAIL_CONFIG.resourceLimits;
  const sudoExec = getSudoExec();

  try {
    // Add memory limit
    await sudoExec([
      'rctl',
      '-a',
      `jail:${jailName}:memoryuse:deny=${limits.memoryuse}`,
    ]);
    logger.info({ jailName, limit: limits.memoryuse }, 'Applied memory limit');

    // Add process limit (prevents fork bombs)
    await sudoExec([
      'rctl',
      '-a',
      `jail:${jailName}:maxproc:deny=${limits.maxproc}`,
    ]);
    logger.info({ jailName, limit: limits.maxproc }, 'Applied process limit');

    // Add CPU limit
    await sudoExec(['rctl', '-a', `jail:${jailName}:pcpu:deny=${limits.pcpu}`]);
    logger.info({ jailName, limit: limits.pcpu }, 'Applied CPU limit');
  } catch (error) {
    logger.warn({ jailName, err: error }, 'Could not apply rctl limits');
    // Don't fail jail creation if rctl is not available - just warn
  }
}

/**
 * Remove rctl resource limits from a jail.
 * @param jailName - The jail name
 */
async function removeRctlLimits(jailName: string): Promise<void> {
  const sudoExec = getSudoExec();
  try {
    // Remove all rctl rules for this jail
    await sudoExec(['rctl', '-r', `jail:${jailName}`]);
    logger.debug({ jailName }, 'Removed rctl limits');
  } catch (error) {
    // Jail may not exist or rctl rules may not be set - ignore
    logger.debug(
      { jailName, err: error },
      'Could not remove rctl limits (may not exist)',
    );
  }
}

/** Default implementation: Execute a command with sudo, returning a promise */
function defaultSudoExec(
  args: string[],
  options: SudoExecOptions = {},
): Promise<SudoExecResult> {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout || 30000;
    execFile('sudo', args, { timeout, ...options }, (error, stdout, stderr) => {
      if (error) {
        reject(
          new Error(
            `sudo ${args.join(' ')} failed: ${stderr || error.message}`,
          ),
        );
      } else {
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      }
    });
  });
}

/** Default implementation: Execute a command with sudo synchronously */
function defaultSudoExecSync(args: string[], options: SudoExecOptions = {}): string {
  try {
    return execFileSync('sudo', args, {
      encoding: 'utf-8',
      timeout: 30000,
      ...options,
    });
  } catch (error) {
    throw new Error(
      `sudo ${args.join(' ')} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Persist epair state to disk for crash recovery.
 * Must be called while holding the epair lock.
 */
function persistEpairState(): void {
  try {
    const state = Object.fromEntries(assignedEpairs);
    fs.writeFileSync(EPAIR_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (error) {
    logger.warn(
      { err: error, file: EPAIR_STATE_FILE },
      'Failed to persist epair state',
    );
  }
}

/**
 * Restore epair state from disk and sync with actual system state.
 * Call this on startup to recover from crashes.
 */
function restoreEpairState(): void {
  // First, load persisted state if it exists
  if (fs.existsSync(EPAIR_STATE_FILE)) {
    try {
      const data = fs.readFileSync(EPAIR_STATE_FILE, 'utf-8');
      const state = JSON.parse(data) as Record<string, number>;
      for (const [groupId, epairNum] of Object.entries(state)) {
        assignedEpairs.set(groupId, epairNum);
      }
      logger.info(
        { count: assignedEpairs.size, file: EPAIR_STATE_FILE },
        'Restored epair state from disk',
      );
    } catch (error) {
      logger.warn(
        { err: error, file: EPAIR_STATE_FILE },
        'Failed to restore epair state',
      );
    }
  }

  // Now verify state against actual system interfaces
  try {
    const ifconfigOutput = execFileSync('ifconfig', ['-l'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const interfaces = ifconfigOutput.trim().split(/\s+/);
    const existingEpairs = new Set<number>();
    const epairRegex = /^epair(\d+)a$/;

    for (const iface of interfaces) {
      const match = iface.match(epairRegex);
      if (match) {
        existingEpairs.add(parseInt(match[1], 10));
      }
    }

    // Remove entries from Map if epair no longer exists in system
    for (const [groupId, epairNum] of assignedEpairs.entries()) {
      if (!existingEpairs.has(epairNum)) {
        logger.info(
          { epairNum, groupId },
          'Epair no longer exists, removing from state',
        );
        assignedEpairs.delete(groupId);
      }
    }

    // Persist the cleaned-up state
    persistEpairState();

    logger.debug(
      { tracked: assignedEpairs.size, existing: existingEpairs.size },
      'Synced epair state with system',
    );
  } catch (error) {
    logger.warn({ err: error }, 'Failed to sync epair state with system');
  }
}

/**
 * Acquire an exclusive lock for epair creation.
 * Uses directory creation as an atomic lock mechanism (POSIX mkdir is atomic).
 * @returns Unlock function to release the lock
 */
async function acquireEpairLock(): Promise<() => void> {
  const lockDir = '/tmp/nanoclaw-epair.lock';
  const maxRetries = 100;
  const retryDelay = 50; // milliseconds

  for (let i = 0; i < maxRetries; i++) {
    try {
      // Atomic operation: mkdir fails if directory exists
      fs.mkdirSync(lockDir, { mode: 0o755 });

      // Lock acquired - return unlock function
      return () => {
        try {
          fs.rmdirSync(lockDir);
        } catch (err) {
          logger.warn({ err, lockDir }, 'Failed to release epair lock');
        }
      };
    } catch (err) {
      const nodeError = err as NodeJS.ErrnoException;
      if (nodeError.code !== 'EEXIST') {
        throw err;
      }
      // Lock is held by another process - wait and retry
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }

  throw new Error('Failed to acquire epair lock after maximum retries');
}

/**
 * Create an epair interface pair for a vnet jail.
 * @param groupId - The group identifier (for tracking)
 * @returns Promise with epair information
 */
async function createEpair(groupId: string): Promise<EpairInfo> {
  // Acquire exclusive lock to prevent concurrent epair creation
  const unlock = await acquireEpairLock();
  const sudoExec = getSudoExec();

  try {
    // Check epair pool capacity before creating
    const currentCount = assignedEpairs.size;

    if (currentCount >= MAX_EPAIRS) {
      throw new Error(
        `Epair pool exhausted (${currentCount}/${MAX_EPAIRS}). Wait for jails to complete.`,
      );
    }

    if (currentCount >= MAX_EPAIRS * EPAIR_WARNING_THRESHOLD) {
      logger.warn(
        {
          current: currentCount,
          max: MAX_EPAIRS,
          threshold: Math.floor(MAX_EPAIRS * EPAIR_WARNING_THRESHOLD),
        },
        'Approaching epair pool limit',
      );
    }

    // Create epair - FreeBSD returns the name (e.g., "epair0")
    const result = await sudoExec(['ifconfig', 'epair', 'create']);
    const epairName = result.stdout.trim(); // e.g., "epair0a"

    // Extract the number from epair0a -> 0
    const match = epairName.match(/epair(\d+)a/);
    if (!match) {
      throw new Error(`Unexpected epair name format: ${epairName}`);
    }
    const epairNum = parseInt(match[1], 10);

    // Validate epair number fits in /24 pool (0-255)
    if (epairNum < 0 || epairNum > 255) {
      throw new Error(
        `Epair number ${epairNum} exceeds /24 pool capacity (0-255)`,
      );
    }

    const hostIface = `epair${epairNum}a`;
    const jailIface = `epair${epairNum}b`;

    // Allocate unique /30 subnet for this jail from 10.99.0.0/24 pool
    // Jail N uses subnet 10.99.N.0/30:
    //   - Host IP: 10.99.N.1
    //   - Jail IP: 10.99.N.2
    const hostIP = `10.99.${epairNum}.1`;
    const jailIP = `10.99.${epairNum}.2`;
    const netmask = '30';

    // Configure host side with gateway IP
    await sudoExec(['ifconfig', hostIface, `${hostIP}/${netmask}`, 'up']);

    // Track epair for cleanup and persist state
    assignedEpairs.set(groupId, epairNum);
    persistEpairState();

    logger.info(
      { groupId, epairNum, hostIface, jailIface, hostIP, jailIP },
      'Created epair',
    );
    return { epairNum, hostIface, jailIface, hostIP, jailIP, netmask };
  } finally {
    // Always release lock, even on error
    unlock();
  }
}

/**
 * Configure networking inside a vnet jail after it starts.
 * @param jailName - The jail name
 * @param epairInfo - Epair interface and IP information
 */
async function configureJailNetwork(
  jailName: string,
  epairInfo: EpairInfo,
): Promise<void> {
  const sudoExec = getSudoExec();
  // Configure the jail's interface with its unique IP
  await sudoExec([
    'jexec',
    jailName,
    'ifconfig',
    epairInfo.jailIface,
    `${epairInfo.jailIP}/${epairInfo.netmask}`,
    'up',
  ]);

  // Add default route via the host gateway
  await sudoExec([
    'jexec',
    jailName,
    'route',
    'add',
    'default',
    epairInfo.hostIP,
  ]);

  logger.info(
    {
      jailName,
      jailIface: epairInfo.jailIface,
      ip: epairInfo.jailIP,
      gateway: epairInfo.hostIP,
    },
    'Configured jail network',
  );
}

/**
 * Destroy an epair interface pair.
 * @param epairNum - The epair number
 */
async function destroyEpair(epairNum: number): Promise<void> {
  const sudoExec = getSudoExec();
  const hostIface = `epair${epairNum}a`;
  try {
    // Destroying the 'a' side destroys both sides
    await sudoExec(['ifconfig', hostIface, 'destroy']);
    logger.debug({ epairNum, hostIface }, 'Destroyed epair');
  } catch (error) {
    logger.warn({ epairNum, hostIface, err: error }, 'Could not destroy epair');
  }
}

/**
 * Release a jail's assigned epair and destroy it.
 * @param groupId - The group identifier
 */
async function releaseEpair(groupId: string): Promise<void> {
  const epairNum = assignedEpairs.get(groupId);
  if (epairNum !== undefined) {
    await destroyEpair(epairNum);
    assignedEpairs.delete(groupId);
    persistEpairState();
  }
}

/**
 * Setup resolv.conf in the jail for DNS resolution.
 * Copies the host's /etc/resolv.conf so the jail uses the same DNS servers.
 * @param jailPath - Path to the jail root
 */
async function setupJailResolv(jailPath: string): Promise<void> {
  const sudoExec = getSudoExec();
  const resolvPath = path.join(jailPath, 'etc', 'resolv.conf');

  try {
    const hostResolv = fs.readFileSync('/etc/resolv.conf', 'utf-8');
    await sudoExec([
      'sh',
      '-c',
      `cat > ${resolvPath} << 'RESOLV'\n${hostResolv}\nRESOLV`,
    ]);
    logger.debug({ jailPath, resolvPath }, 'Copied host resolv.conf to jail');
  } catch (error) {
    logger.warn(
      { jailPath, resolvPath, err: error },
      'Could not create jail resolv.conf',
    );
  }
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

/** Check if a ZFS dataset exists */
function datasetExists(dataset: string): boolean {
  try {
    execFileSync('zfs', ['list', '-H', dataset], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Jail-native mount layout.
 * These are the 5 semantic mounts a jail needs - no Docker translation.
 */
export const JAIL_MOUNT_LAYOUT = {
  project: '/workspace/project', // NanoClaw source (ro)
  group: '/workspace/group', // Group's folder (rw)
  ipc: '/workspace/ipc', // Group's IPC directory (rw)
  claudeSession: '/home/node/.claude', // Claude session data (rw)
  agentRunner: '/app/src', // Agent runner source (ro)
};

/**
 * Build mount specs from semantic paths.
 * @param paths - Semantic mount paths
 * @returns Array of mount specifications
 */
export function buildJailMounts(paths: JailMountPaths): JailMount[] {
  const mounts: JailMount[] = [];

  if (paths.projectPath) {
    mounts.push({
      hostPath: paths.projectPath,
      jailPath: JAIL_MOUNT_LAYOUT.project,
      readonly: true,
    });
  }

  if (paths.groupPath) {
    mounts.push({
      hostPath: paths.groupPath,
      jailPath: JAIL_MOUNT_LAYOUT.group,
      readonly: false,
    });
  }

  if (paths.ipcPath) {
    mounts.push({
      hostPath: paths.ipcPath,
      jailPath: JAIL_MOUNT_LAYOUT.ipc,
      readonly: false,
    });
  }

  if (paths.claudeSessionPath) {
    mounts.push({
      hostPath: paths.claudeSessionPath,
      jailPath: JAIL_MOUNT_LAYOUT.claudeSession,
      readonly: false,
    });
  }

  if (paths.agentRunnerPath) {
    mounts.push({
      hostPath: paths.agentRunnerPath,
      jailPath: JAIL_MOUNT_LAYOUT.agentRunner,
      readonly: true,
    });
  }

  return mounts;
}

/**
 * Ensure host-side directories exist for writable mounts.
 * Creates groupPath, ipcPath, claudeSessionPath if they don't exist.
 * Sets mode 2775 (setgid) and group wheel (gid 0) for shared host/jail access.
 * @param paths - Semantic mount paths
 */
export function ensureHostDirectories(paths: JailMountPaths): void {
  const dirsToCreate = [
    paths.groupPath,
    paths.ipcPath,
    paths.claudeSessionPath,
  ];

  // Get current uid for chown (keep ownership, change group to wheel)
  const uid = process.getuid?.() ?? 0;
  const wheelGid = 0;

  for (const dir of dirsToCreate) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      logger.debug({ dir }, 'Created host directory');
    }
    // Set mode 2775 (rwxrwsr-x) - setgid ensures new files inherit wheel group
    // Set group to wheel (gid 0) so jail's node user (supplementary group wheel) can write
    try {
      fs.chmodSync(dir, 0o2775);
      fs.chownSync(dir, uid, wheelGid);
    } catch (err) {
      logger.warn({ dir, err }, 'Could not set permissions on directory');
    }
  }

  // Also create IPC subdirectories with same permissions
  if (paths.ipcPath) {
    for (const subdir of ['messages', 'tasks', 'input']) {
      const subdirPath = path.join(paths.ipcPath, subdir);
      if (!fs.existsSync(subdirPath)) {
        fs.mkdirSync(subdirPath, { recursive: true });
      }
      try {
        fs.chmodSync(subdirPath, 0o2775);
        fs.chownSync(subdirPath, uid, wheelGid);
      } catch (err) {
        logger.warn(
          { subdirPath, err },
          'Could not set permissions on subdirectory',
        );
      }
    }
  }
}

/** Build fstab content for jail mounts */
function buildFstab(mounts: JailMount[], jailPath: string): string {
  const lines: string[] = [];
  for (const mount of mounts) {
    const targetPath = path.join(jailPath, mount.jailPath);
    const opts = mount.readonly ? 'ro' : 'rw';
    lines.push(`${mount.hostPath}\t${targetPath}\tnullfs\t${opts}\t0\t0`);
  }
  return lines.join('\n') + '\n';
}

/** Create mount point directories inside the jail */
async function createMountPoints(
  mounts: JailMount[],
  jailPath: string,
): Promise<void> {
  const sudoExec = getSudoExec();
  const resolvedJailRoot = path.resolve(jailPath);

  for (const mount of mounts) {
    const targetPath = path.resolve(jailPath, mount.jailPath);

    // Paranoid check: target must be within jail root (defense in depth)
    if (
      !targetPath.startsWith(resolvedJailRoot + path.sep) &&
      targetPath !== resolvedJailRoot
    ) {
      throw new Error(`Mount target escapes jail root: ${mount.jailPath}`);
    }

    // Reject any path containing '..' after canonicalization
    if (mount.jailPath.includes('..')) {
      throw new Error(`Mount path contains path traversal: ${mount.jailPath}`);
    }

    await sudoExec(['mkdir', '-p', targetPath]);
  }
}

/** Mount all nullfs mounts for a jail */
async function mountNullfs(
  mounts: JailMount[],
  jailPath: string,
): Promise<void> {
  const sudoExec = getSudoExec();
  const resolvedJailRoot = path.resolve(jailPath);

  for (const mount of mounts) {
    // Canonicalize paths with realpath-style resolution
    const targetPath = path.resolve(jailPath, mount.jailPath);

    // Paranoid check: target must be within jail root (defense in depth)
    if (
      !targetPath.startsWith(resolvedJailRoot + path.sep) &&
      targetPath !== resolvedJailRoot
    ) {
      throw new Error(`Mount target escapes jail root: ${mount.jailPath}`);
    }

    // Reject any path containing '..' after canonicalization
    if (mount.jailPath.includes('..')) {
      throw new Error(`Mount path contains path traversal: ${mount.jailPath}`);
    }

    const opts = mount.readonly ? 'ro' : 'rw';
    try {
      await sudoExec(['mount_nullfs', '-o', opts, mount.hostPath, targetPath]);
      logger.debug(
        { hostPath: mount.hostPath, targetPath, opts },
        'Mounted nullfs',
      );
    } catch (error) {
      logger.error(
        { hostPath: mount.hostPath, targetPath, opts, err: error },
        'Failed to mount nullfs',
      );
      throw error;
    }
  }
}

/** Unmount all nullfs mounts for a jail (reverse order) */
async function unmountAll(
  mounts: JailMount[],
  jailPath: string,
): Promise<void> {
  const sudoExec = getSudoExec();
  const errors: string[] = [];
  // Unmount in reverse order
  for (let i = mounts.length - 1; i >= 0; i--) {
    const mount = mounts[i];
    const targetPath = path.join(jailPath, mount.jailPath);
    try {
      await sudoExec(['umount', targetPath]);
      logger.debug({ targetPath }, 'Unmounted nullfs');
    } catch (error) {
      // Try force unmount
      try {
        await sudoExec(['umount', '-f', targetPath]);
        logger.debug({ targetPath }, 'Force unmounted nullfs');
      } catch {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        errors.push(`Failed to unmount ${targetPath}: ${errorMessage}`);
      }
    }
  }
  if (errors.length > 0) {
    logger.warn({ errors, jailPath }, 'Unmount errors occurred');
  }
}

/**
 * Create a new jail from template snapshot using semantic paths.
 * This is the preferred entry point for jail creation - no Docker translation needed.
 * @param groupId - The group identifier
 * @param paths - Semantic mount paths
 * @param traceId - Optional trace ID for request correlation
 * @param tracedLogger - Optional traced logger for request correlation
 * @returns Promise with jail name and mount specs for cleanup
 */
export async function createJailWithPaths(
  groupId: string,
  paths: JailMountPaths,
  traceId?: string,
  tracedLogger?: pino.Logger,
): Promise<JailCreationResult> {
  const log = tracedLogger || logger;

  // Ensure host directories exist
  ensureHostDirectories(paths);

  // Build mount specs from semantic paths
  const mounts = buildJailMounts(paths);

  // Create the jail
  const jailName = await createJail(groupId, mounts, traceId, tracedLogger);

  return { jailName, mounts };
}

/**
 * Create a new jail from template snapshot.
 * @param groupId - The group identifier
 * @param mounts - Mount specifications
 * @param traceId - Optional trace ID for request correlation
 * @param tracedLogger - Optional traced logger for request correlation
 * @returns Promise with the jail name
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

  // Check if at capacity (only enforce for new jails, not re-creation after cleanup)
  if (!activeJails.has(groupId) && activeJails.size >= MAX_CONCURRENT_JAILS) {
    throw new Error(
      `Cannot create jail: maximum concurrent jail limit reached (${MAX_CONCURRENT_JAILS}). ` +
        `Currently active: ${activeJails.size}. Configure NANOCLAW_MAX_JAILS to adjust limit.`,
    );
  }

  log.info({ jailName, groupId }, 'Creating jail');

  // Check if jail already exists
  if (isJailRunning(jailName)) {
    log.info({ jailName }, 'Jail already running, stopping first');
    await stopJail(groupId);
  }

  // Check if dataset exists (leftover from crash)
  if (datasetExists(dataset)) {
    log.info({ dataset }, 'Dataset exists, destroying first');
    try {
      await sudoExec(['zfs', 'destroy', '-r', dataset]);
    } catch (error) {
      log.warn(
        { dataset, err: error },
        'Could not destroy existing dataset',
      );
    }
  }

  try {
    // Clone template snapshot
    log.debug({ snapshot, dataset }, 'Cloning template');
    await sudoExec(['zfs', 'clone', snapshot, dataset]);

    // Create mount points inside jail
    await createMountPoints(mounts, jailPath);

    // Write fstab for this jail
    const fstabContent = buildFstab(mounts, jailPath);
    fs.writeFileSync(fstabPath, fstabContent);
    log.debug({ fstabPath, mountCount: mounts.length }, 'Wrote fstab');

    // Mount nullfs filesystems
    await mountNullfs(mounts, jailPath);

    // Create .claude directory and .claude.json for Claude Code (required before running as non-root)
    await sudoExec(['mkdir', '-p', `${jailPath}/home/node/.claude`]);
    await sudoExec([
      'sh',
      '-c',
      `echo '{}' > ${jailPath}/home/node/.claude.json`,
    ]);
    await sudoExec(['chown', '-R', '1000:1000', `${jailPath}/home/node`]);

    // Ensure /tmp is writable by node user (entrypoint compiles TypeScript to /tmp/dist)
    await sudoExec(['chmod', '1777', `${jailPath}/tmp`]);

    // Network setup for restricted mode (vnet with epair)
    let epairInfo: EpairInfo | null = null;
    if (JAIL_CONFIG.networkMode === 'restricted') {
      // Create epair interface pair
      epairInfo = await createEpair(groupId);
      log.info({ groupId, ...epairInfo }, 'Created epair for jail');

      // Setup resolv.conf for DNS
      await setupJailResolv(jailPath);
    }

    // Create the jail
    const jailParams = [
      'jail',
      '-c',
      `name=${jailName}`,
      `path=${jailPath}`,
      `host.hostname=${jailName}`,
      'persist',
    ];

    // Network configuration
    if (JAIL_CONFIG.networkMode === 'inherit') {
      jailParams.push('ip4=inherit', 'ip6=inherit');
    } else if (JAIL_CONFIG.networkMode === 'restricted') {
      // Use vnet with epair interface
      jailParams.push('vnet');
      if (epairInfo) {
        jailParams.push(`vnet.interface=${epairInfo.jailIface}`);
      }
    }

    // Allow certain sysctls for compatibility
    jailParams.push(
      'allow.raw_sockets', // Needed for DNS resolution
      'allow.sysvipc',
      'enforce_statfs=1',
      'mount.devfs',
      'devfs_ruleset=10', // Apply restrictive devfs ruleset (see etc/devfs.rules)
    );

    log.debug({ jailName, params: jailParams.slice(2) }, 'Starting jail');
    await sudoExec(jailParams);

    // Apply resource limits to prevent runaway processes
    await applyRctlLimits(jailName);

    // Configure networking inside the vnet jail
    if (JAIL_CONFIG.networkMode === 'restricted' && epairInfo) {
      await configureJailNetwork(jailName, epairInfo);
    }

    // Track active jail
    activeJails.add(groupId);

    log.info(
      {
        jailName,
        groupId,
        activeCount: activeJails.size,
        maxJails: MAX_CONCURRENT_JAILS,
      },
      'Jail created successfully',
    );

    // Update metrics on successful creation
    try {
      const { incrementJailCreateCounter } = await import('./metrics.js');
      incrementJailCreateCounter(true);
    } catch {
      // Metrics module may not be available in all contexts
    }
    return jailName;
  } catch (error) {
    // Update metrics on failed creation
    try {
      const { incrementJailCreateCounter } = await import('./metrics.js');
      incrementJailCreateCounter(false);
    } catch {
      // Metrics module may not be available in all contexts
    }

    // Cleanup on failure
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
 * @param groupId - The group identifier
 * @param command - Command and arguments to execute
 * @param options - Execution options
 * @returns Promise with execution result
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

    // FreeBSD jexec supports -d for working directory
    if (cwd) {
      args.push('-d', cwd);
    }

    args.push(jailName);

    // Wrap command in shell to set umask 002 for group-writable files.
    // This ensures files created by node inside the jail are writable by
    // the host user (jims) via the shared wheel group.
    args.push('sh', '-c', 'umask 002; exec "$@"', '--');

    // Environment variables must be passed via env command inside the jail
    // FreeBSD jexec does not support -e flags
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

    /** Kill all processes in the jail to terminate execution */
    const killJailProcesses = () => {
      try {
        // Kill all processes in the jail - this ensures the jailed process dies
        execFileSync('sudo', ['jexec', jailName, 'kill', '-9', '-1'], {
          stdio: 'pipe',
          timeout: 5000,
        });
      } catch {
        // Jail may have already stopped or no processes to kill
      }
      // Also kill the sudo wrapper process
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

    // Handle AbortSignal
    const abortHandler = () => {
      if (settled) return;
      aborted = true;
      logger.warn({ jailName, groupId }, 'Execution aborted via signal');
      killJailProcesses();
    };

    if (signal) {
      if (signal.aborted) {
        // Already aborted before we started
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
 * @param groupId - The group identifier
 * @param command - Command and arguments to execute
 * @param options - Spawn options
 * @returns ChildProcess
 */
export function spawnInJail(
  groupId: string,
  command: string[],
  options: SpawnInJailOptions = {},
): ChildProcess {
  const jailName = getJailName(groupId);
  const { env = {}, cwd } = options;

  const args = ['jexec', '-U', 'node'];

  // FreeBSD jexec supports -d for working directory
  if (cwd) {
    args.push('-d', cwd);
  }

  args.push(jailName);

  // Environment variables must be passed via env command inside the jail
  // FreeBSD jexec does not support -e flags
  args.push('env');
  for (const [key, value] of Object.entries(env)) {
    args.push(`${key}=${value}`);
  }

  // Set umask 002 for group-writable files. This ensures files created by
  // node inside the jail are writable by the host user (jims) via the
  // shared wheel group. Prepend umask to shell scripts.
  if (command[0] === 'sh' && command[1] === '-c' && command.length >= 3) {
    args.push('sh', '-c', `umask 002; ${command[2]}`);
    args.push(...command.slice(3));
  } else {
    // For non-shell commands, wrap in sh -c to set umask
    args.push('sh', '-c', `umask 002; exec "$@"`, '--', ...command);
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
 * @param groupId - The group identifier
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
    await sudoExec(['jail', '-r', jailName], { timeout: 15000 });
    logger.info({ jailName, groupId }, 'Jail stopped');
  } catch (error) {
    logger.warn(
      { jailName, groupId, err: error },
      'Failed to stop jail gracefully, trying force',
    );
    try {
      // Try to kill all processes in jail first
      await sudoExec(['jexec', jailName, 'kill', '-9', '-1'], {
        timeout: 5000,
      }).catch(() => {});
      await sudoExec(['jail', '-r', jailName], { timeout: 10000 });
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
 * This kills all processes, force unmounts, and force destroys datasets.
 * @param jailName - The jail name
 * @param mounts - Mount specifications
 * @param dataset - The ZFS dataset path
 * @param jailPath - The jail filesystem path
 * @param epairNum - The epair number if in restricted network mode
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

  // 1. Kill all processes in jail (if still running)
  if (isJailRunning(jailName)) {
    try {
      await sudoExec(['jexec', jailName, 'kill', '-9', '-1'], {
        timeout: 5000,
      });
      logger.info({ jailName }, 'Killed all processes in jail');
      logCleanupAudit('KILL_PROCESSES', jailName, 'SUCCESS');
    } catch (error) {
      logger.warn({ jailName, err: error }, 'Could not kill processes in jail');
      logCleanupAudit('KILL_PROCESSES', jailName, 'FAILED', error);
      errors.push(error as Error);
    }

    // 2. Force stop jail
    try {
      await sudoExec(['jail', '-r', jailName], { timeout: 10000 });
      logger.info({ jailName }, 'Force stopped jail');
      logCleanupAudit('FORCE_STOP_JAIL', jailName, 'SUCCESS');
    } catch (error) {
      logger.warn({ jailName, err: error }, 'Could not force stop jail');
      logCleanupAudit('FORCE_STOP_JAIL', jailName, 'FAILED', error);
      errors.push(error as Error);
    }
  }

  // 3. Force unmount devfs
  try {
    await sudoExec(['umount', '-f', path.join(jailPath, 'dev')], {
      timeout: 5000,
    });
    logger.debug({ jailName }, 'Force unmounted devfs');
    logCleanupAudit('FORCE_UNMOUNT_DEVFS', jailName, 'SUCCESS');
  } catch (error) {
    // Expected to fail if not mounted
    logger.debug(
      { jailName, err: error },
      'Could not force unmount devfs (may not be mounted)',
    );
  }

  // 4. Force unmount all nullfs mounts
  for (let i = mounts.length - 1; i >= 0; i--) {
    const mount = mounts[i];
    const targetPath = path.join(jailPath, mount.jailPath);
    try {
      await sudoExec(['umount', '-f', targetPath], { timeout: 5000 });
      logger.debug({ targetPath }, 'Force unmounted nullfs');
      logCleanupAudit('FORCE_UNMOUNT_NULLFS', jailName, 'SUCCESS', null);
    } catch (error) {
      logger.warn({ targetPath, err: error }, 'Could not force unmount nullfs');
      logCleanupAudit('FORCE_UNMOUNT_NULLFS', jailName, 'FAILED', error);
      errors.push(error as Error);
    }
  }

  // 5. Force destroy ZFS dataset with all dependents
  if (datasetExists(dataset)) {
    try {
      await sudoExec(['zfs', 'destroy', '-f', '-r', dataset], {
        timeout: 30000,
      });
      logger.info({ dataset }, 'Force destroyed dataset');
      logCleanupAudit('FORCE_DESTROY_DATASET', jailName, 'SUCCESS');
    } catch (error) {
      logger.warn({ dataset, err: error }, 'Could not force destroy dataset');
      logCleanupAudit('FORCE_DESTROY_DATASET', jailName, 'FAILED', error);
      errors.push(error as Error);
    }
  }

  // 6. Destroy epair (if in restricted network mode)
  if (epairNum !== null) {
    try {
      const hostIface = `epair${epairNum}a`;
      await sudoExec(['ifconfig', hostIface, 'destroy'], { timeout: 5000 });
      logger.info({ epairNum, hostIface }, 'Force destroyed epair');
      logCleanupAudit('FORCE_DESTROY_EPAIR', jailName, 'SUCCESS');
    } catch (error) {
      logger.warn({ epairNum, err: error }, 'Could not force destroy epair');
      logCleanupAudit('FORCE_DESTROY_EPAIR', jailName, 'FAILED', error);
      errors.push(error as Error);
    }
  }

  if (errors.length > 0) {
    logCleanupAudit(
      'FORCE_CLEANUP_END',
      jailName,
      'PARTIAL',
      new Error(`${errors.length} errors during force cleanup`),
    );
    logger.warn(
      { jailName, errorCount: errors.length },
      'Force cleanup completed with errors',
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
 * @param groupId - The group identifier
 * @param mounts - Mount specifications (for unmounting)
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

  logger.info({ jailName, groupId }, 'Cleaning up jail');
  logCleanupAudit('CLEANUP_START', jailName, 'INFO');

  const errors = [];
  const epairNum =
    JAIL_CONFIG.networkMode === 'restricted' && assignedEpairs.has(groupId)
      ? assignedEpairs.get(groupId)
      : null;

  // Remove rctl limits before stopping jail
  await removeRctlLimits(jailName);

  try {
    // Stop jail if running (with retry)
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
      } catch (error) {
        logger.warn(
          { jailName, groupId, err: error },
          'Could not stop jail during cleanup',
        );
        logCleanupAudit('STOP_JAIL', jailName, 'FAILED', error);
        errors.push(error as Error);
      }
    }

    // Destroy epair if in restricted network mode (with retry)
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
      } catch (error) {
        logger.warn(
          { jailName, groupId, err: error },
          'Could not release epair',
        );
        logCleanupAudit('RELEASE_EPAIR', jailName, 'FAILED', error);
        errors.push(error as Error);
      }
    }

    // Unmount devfs first (required before nullfs unmounts and zfs destroy)
    try {
      await sudoExec(['umount', '-f', path.join(jailPath, 'dev')]);
      logCleanupAudit('UNMOUNT_DEVFS', jailName, 'SUCCESS');
    } catch (error) {
      // Expected to fail if devfs not mounted, don't add to errors
      logger.debug(
        { jailName, err: error },
        'Devfs unmount (expected to fail if not mounted)',
      );
    }

    // Unmount nullfs mounts (with retry)
    if (mounts.length > 0) {
      try {
        await retryWithBackoff(
          async () => {
            await unmountAll(mounts, jailPath);
          },
          2,
          300,
          2000,
        );
        logCleanupAudit('UNMOUNT_NULLFS', jailName, 'SUCCESS');
      } catch (error) {
        logger.warn(
          { jailName, groupId, err: error },
          'Could not unmount all filesystems',
        );
        logCleanupAudit('UNMOUNT_NULLFS', jailName, 'FAILED', error);
        errors.push(error as Error);
      }
    }

    // Destroy ZFS dataset (with retry)
    if (datasetExists(dataset)) {
      try {
        await retryWithBackoff(
          async () => {
            await sudoExec(['zfs', 'destroy', '-r', dataset]);
            if (datasetExists(dataset)) {
              throw new Error('Dataset still exists after destroy');
            }
          },
          2,
          500,
          3000,
        );
        logger.info({ dataset, jailName }, 'Destroyed dataset');
        logCleanupAudit('DESTROY_DATASET', jailName, 'SUCCESS');
      } catch (error) {
        logger.warn(
          { dataset, jailName, groupId, err: error },
          'Could not destroy dataset',
        );
        logCleanupAudit('DESTROY_DATASET', jailName, 'FAILED', error);
        errors.push(error as Error);
      }
    }

    // Remove fstab file
    if (fs.existsSync(fstabPath)) {
      try {
        fs.unlinkSync(fstabPath);
        logger.debug({ fstabPath, jailName }, 'Removed fstab');
        logCleanupAudit('REMOVE_FSTAB', jailName, 'SUCCESS');
      } catch (error) {
        logger.warn(
          { fstabPath, jailName, groupId, err: error },
          'Could not remove fstab',
        );
        logCleanupAudit('REMOVE_FSTAB', jailName, 'FAILED', error);
        errors.push(error as Error);
      }
    }
  } catch (unexpectedError) {
    logger.error(
      { jailName, groupId, err: unexpectedError },
      'Unexpected error during cleanup',
    );
    logCleanupAudit(
      'CLEANUP_UNEXPECTED_ERROR',
      jailName,
      'FAILED',
      unexpectedError,
    );
    errors.push(unexpectedError as Error);
  } finally {
    // If normal cleanup had errors, try force cleanup
    if (errors.length > 0) {
      logger.warn(
        { jailName, groupId, errorCount: errors.length },
        'Normal cleanup failed, attempting force cleanup',
      );
      logCleanupAudit('CLEANUP_FALLBACK_TO_FORCE', jailName, 'INFO');

      try {
        await forceCleanup(jailName, mounts, dataset, jailPath, epairNum);
        logger.info(
          { jailName, groupId },
          'Force cleanup succeeded after normal cleanup failed',
        );
        logCleanupAudit('CLEANUP_END', jailName, 'SUCCESS_FORCED');
      } catch (forceError) {
        logger.error(
          { jailName, groupId, err: forceError },
          'Force cleanup also failed',
        );
        logCleanupAudit('CLEANUP_END', jailName, 'FAILED', forceError);

        // Aggregate all errors from both attempts
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

    // Remove from active jails tracking
    activeJails.delete(groupId);
    logger.debug(
      { jailName, groupId, activeCount: activeJails.size },
      'Removed jail from active tracking',
    );
  }
}

/**
 * Destroy a jail completely (stop + cleanup).
 * @param groupId - The group identifier
 * @param mounts - Mount specifications
 */
export async function destroyJail(
  groupId: string,
  mounts: JailMount[] = [],
): Promise<void> {
  // cleanupJail handles stopping if needed, unmounting, and ZFS cleanup
  await cleanupJail(groupId, mounts);
}

/**
 * Get the current number of active jails.
 * @returns Current active jail count
 */
export function getActiveJailCount(): number {
  return activeJails.size;
}

/**
 * Get the current jail capacity status.
 * @returns Object with current count and max limit
 */
export function getJailCapacity(): { current: number; max: number } {
  return { current: activeJails.size, max: MAX_CONCURRENT_JAILS };
}

/**
 * Check if the jail system is at capacity.
 * @returns True if at or above the maximum concurrent jail limit
 */
export function isAtJailCapacity(): boolean {
  return activeJails.size >= MAX_CONCURRENT_JAILS;
}

/** Ensure the jail subsystem is available. */
export function ensureJailRuntimeRunning(): void {
  try {
    // Check ZFS is available
    execFileSync('zfs', ['version'], { stdio: 'pipe', timeout: 5000 });

    // Check template snapshot exists
    const snapshot = `${JAIL_CONFIG.templateDataset}@${JAIL_CONFIG.templateSnapshot}`;
    execFileSync('zfs', ['list', '-t', 'snapshot', '-H', snapshot], {
      stdio: 'pipe',
      timeout: 5000,
    });

    // Check jail command is available
    execFileSync('which', ['jail'], { stdio: 'pipe', timeout: 5000 });

    // Restore epair state from disk for crash recovery
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

/** Kill orphaned NanoClaw jails from previous runs. */
export function cleanupOrphans(): void {
  try {
    // List all running jails with nanoclaw_ prefix
    const output = execFileSync('sudo', ['jls', '-N', 'name'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });

    const orphans = output
      .trim()
      .split('\n')
      .filter((line) => line.startsWith('nanoclaw_'));

    for (const jailName of orphans) {
      // Remove rctl limits for orphaned jail
      try {
        execFileSync('sudo', ['rctl', '-r', `jail:${jailName}`], {
          stdio: 'pipe',
          timeout: 5000,
        });
        logger.info({ jailName }, 'Removed rctl limits for orphaned jail');
      } catch {
        // May not have rctl rules - ignore
      }

      try {
        logger.info({ jailName }, 'Stopping orphaned jail');
        execFileSync('sudo', ['jail', '-r', jailName], {
          stdio: 'pipe',
          timeout: 15000,
        });
        logger.info({ jailName }, 'Stopped orphaned jail');
      } catch {
        // Already stopped or failed - try cleanup anyway
        logger.warn(
          { jailName },
          'Could not stop orphaned jail, attempting cleanup',
        );
      }

      // Unmount any nullfs mounts for this jail before destroying dataset
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
              timeout: 5000,
            });
            logger.debug({ mountPoint }, 'Unmounted orphan mount');
          } catch {
            logger.debug({ mountPoint }, 'Could not unmount orphan mount');
          }
        }
      } catch {
        // No mounts or error checking - continue anyway
      }

      // Also clean up any leftover datasets
      const dataset = `${JAIL_CONFIG.jailsDataset}/${jailName}`;
      if (datasetExists(dataset)) {
        try {
          execFileSync('sudo', ['zfs', 'destroy', '-r', dataset], {
            stdio: 'pipe',
            timeout: 15000,
          });
          logger.info({ dataset }, 'Destroyed orphan dataset');
        } catch {
          logger.warn({ dataset }, 'Could not destroy orphan dataset');
        }
      }

      // Clean up fstab
      const fstabPath = path.join(JAIL_CONFIG.jailsPath, `${jailName}.fstab`);
      if (fs.existsSync(fstabPath)) {
        try {
          fs.unlinkSync(fstabPath);
        } catch {
          // Ignore
        }
      }
    }

    // Clean up orphan epair interfaces (for restricted network mode)
    // An epair is orphaned if it exists in the system but isn't tracked in our state
    if (JAIL_CONFIG.networkMode === 'restricted') {
      try {
        // Restore state from disk first to get accurate tracking info
        restoreEpairState();

        // Find all epair interfaces
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
            // Check if this epair is tracked (if not, it's orphaned)
            const isTracked = Array.from(assignedEpairs.values()).includes(
              epairNum,
            );
            if (!isTracked) {
              try {
                execFileSync('sudo', ['ifconfig', iface, 'destroy'], {
                  stdio: 'pipe',
                  timeout: 5000,
                });
                logger.info({ epairNum, iface }, 'Destroyed orphan epair');
              } catch {
                logger.warn(
                  { epairNum, iface },
                  'Could not destroy orphan epair',
                );
              }
            }
          }
        }
      } catch {
        // No epairs or error checking - that's fine
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
 * Clean up all running NanoClaw jails.
 * Called during shutdown to ensure devfs is unmounted and ZFS datasets can be destroyed.
 * @returns Promise<void>
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
  } catch (err) {
    // No jails running or jls failed
    logger.debug({ err }, 'No running jails found or jls failed');
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

    // Step 0: Remove rctl limits
    try {
      await sudoExec(['rctl', '-r', `jail:${jailName}`], { timeout: 5000 });
      logger.debug({ jailName }, 'Removed rctl limits');
    } catch (err) {
      logger.warn(
        { jailName, err },
        'Failed to remove rctl limits, continuing cleanup',
      );
    }

    // Step 1: Stop the jail
    try {
      logger.info({ jailName }, 'Stopping jail');
      await sudoExec(['jail', '-r', jailName], { timeout: 15000 });
      logger.info({ jailName }, 'Stopped jail');
    } catch (err) {
      logger.warn({ jailName, err }, 'Failed to stop jail, continuing cleanup');
    }

    // Step 2: Unmount devfs
    try {
      await sudoExec(['umount', '-f', path.join(jailPath, 'dev')], {
        timeout: 5000,
      });
      logger.debug({ jailName }, 'Unmounted devfs');
    } catch (err) {
      logger.debug({ jailName, err }, 'Failed to unmount devfs, continuing');
    }

    // Step 3: Unmount all nullfs mounts under jailPath
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
        .reverse(); // Unmount in reverse order

      for (const mountPoint of jailMounts) {
        try {
          await sudoExec(['umount', '-f', mountPoint], { timeout: 5000 });
          logger.debug({ mountPoint }, 'Unmounted nullfs');
        } catch (err) {
          logger.warn(
            { mountPoint, err },
            'Failed to unmount nullfs, continuing',
          );
        }
      }
    } catch (err) {
      logger.warn({ jailName, err }, 'Failed to list/unmount nullfs mounts');
    }

    // Step 4: Destroy ZFS dataset
    if (datasetExists(dataset)) {
      try {
        await sudoExec(['zfs', 'destroy', '-r', dataset], { timeout: 30000 });
        logger.info({ dataset }, 'Destroyed ZFS dataset');
      } catch (err) {
        logger.warn(
          { dataset, err },
          'Failed to destroy ZFS dataset, continuing',
        );
      }
    }

    // Step 5: Remove fstab file
    if (fs.existsSync(fstabPath)) {
      try {
        fs.unlinkSync(fstabPath);
        logger.debug({ fstabPath }, 'Removed fstab file');
      } catch (err) {
        logger.warn(
          { fstabPath, err },
          'Failed to remove fstab file, continuing',
        );
      }
    }

    logger.info({ jailName }, 'Completed cleanup for jail');
  }

  // Step 6: Destroy all epair interfaces (for restricted network mode)
  if (JAIL_CONFIG.networkMode === 'restricted') {
    try {
      // Find all epair interfaces
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
            logger.info({ iface }, 'Destroyed epair');
          } catch (err) {
            logger.warn({ iface, err }, 'Failed to destroy epair');
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to clean up epair interfaces');
    }

    // Clear the in-memory epair assignments
    assignedEpairs.clear();
  }

  logger.info('Finished cleaning up all NanoClaw jails');
}

/**
 * Get epair pool metrics for monitoring.
 * @returns Epair allocation metrics
 */
export function getEpairMetrics(): {
  current: number;
  max: number;
  warningThreshold: number;
} {
  return {
    current: assignedEpairs.size,
    max: MAX_EPAIRS,
    warningThreshold: EPAIR_WARNING_THRESHOLD,
  };
}
