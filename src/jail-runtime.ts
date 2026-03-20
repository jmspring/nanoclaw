/**
 * FreeBSD Jail runtime for NanoClaw.
 * Replaces Docker/Apple Container runtime with native FreeBSD jails.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execFile, execFileSync, spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from './logger.js';
import pino from 'pino';
import {
  JAIL_EXEC_TIMEOUT,
  JAIL_CREATE_TIMEOUT,
  JAIL_STOP_TIMEOUT,
  JAIL_FORCE_STOP_TIMEOUT,
  JAIL_QUICK_OP_TIMEOUT,
} from './config.js';

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
  additionalMounts?: Array<{
    hostPath: string;
    jailPath: string;
    readonly: boolean;
  }>;
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
  // IMPORTANT: Changing network mode requires updating pf configuration.
  // See docs/network-mode-migration.md or run scripts/switch-network-mode.sh
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
const EPAIR_STATE_FILE = '/var/run/nanoclaw/epairs.json';

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

/** Track temporary files/directories created during session */
const sessionTempFiles = new Set<string>();

/** Track per-jail temp directories that need cleanup */
const jailTempDirs = new Map<string, Set<string>>(); // groupId -> Set of temp paths

/** Epair lock directory path */
const EPAIR_LOCK_DIR = '/tmp/nanoclaw-epair.lock';

/**
 * Track temp files created during a jail session for later cleanup.
 * @param groupId - The group identifier
 * @param tempPath - The path inside the jail's /tmp directory (e.g., '/tmp/dist', '/tmp/input.json')
 */
export function trackJailTempFile(groupId: string, tempPath: string): void {
  if (!jailTempDirs.has(groupId)) {
    jailTempDirs.set(groupId, new Set());
  }
  jailTempDirs.get(groupId)!.add(tempPath);
  logger.debug({ groupId, tempPath }, 'Tracking jail temp file');
}

/**
 * Clean up tracked temp files for a jail session.
 * Removes /tmp/dist, /tmp/input.json, and other tracked temp files.
 * @param groupId - The group identifier
 */
async function cleanupJailTempFiles(groupId: string): Promise<void> {
  const jailName = getJailName(groupId);
  let tempPaths = jailTempDirs.get(groupId);

  if (!tempPaths || tempPaths.size === 0) {
    // Always try to clean up common temp files even if not tracked
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
      // Use rm -rf to remove both files and directories
      await getSudoExec()(['jexec', jailName, 'rm', '-rf', tempPath], {
        timeout: 5000,
      });
      logger.debug({ groupId, tempPath }, 'Removed jail temp file');
    } catch (error) {
      // File may not exist or already cleaned up - this is fine
      logger.debug(
        { groupId, tempPath, err: error },
        'Could not remove jail temp file (may not exist)',
      );
    }
  }

  // Clear tracking for this jail
  jailTempDirs.delete(groupId);
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

/**
 * Sanitize groupId for use in jail names (alphanumeric + underscore only).
 * Appends a 6-character hash suffix to prevent collisions when different
 * groupIds sanitize to the same value (e.g., "my-group" and "my_group").
 * @param groupId - The original group identifier
 * @returns Sanitized jail name with hash suffix
 */
export function sanitizeJailName(groupId: string): string {
  // Replace non-alphanumeric characters (except underscore) with underscore
  const sanitized = groupId.replace(/[^a-zA-Z0-9_]/g, '_');

  // Generate a short hash of the original groupId for uniqueness
  // Use first 6 chars of SHA-256 hash (base36 for compact representation)
  const hash = crypto
    .createHash('sha256')
    .update(groupId)
    .digest('hex')
    .slice(0, 6);

  // Log warning if sanitization changed the name significantly
  if (sanitized !== groupId) {
    logger.debug(
      { original: groupId, sanitized, hash },
      'Group name sanitized for jail compatibility',
    );
  }

  // Append hash to ensure uniqueness while keeping jail name readable
  // Format: sanitized_hash (e.g., "my_group_a1b2c3")
  return `${sanitized}_${hash}`;
}

/**
 * Detect potential collision between group names.
 * Warns if two group IDs would have collided without hash suffix.
 * @param groupId1 - First group identifier
 * @param groupId2 - Second group identifier
 * @returns True if the sanitized names (without hash) would collide
 */
export function detectNameCollision(
  groupId1: string,
  groupId2: string,
): boolean {
  if (groupId1 === groupId2) {
    return false; // Same group, not a collision
  }

  const sanitized1 = groupId1.replace(/[^a-zA-Z0-9_]/g, '_');
  const sanitized2 = groupId2.replace(/[^a-zA-Z0-9_]/g, '_');

  const wouldCollide = sanitized1 === sanitized2;

  if (wouldCollide) {
    logger.warn(
      {
        group1: groupId1,
        group2: groupId2,
        sanitizedBase: sanitized1,
        jail1: getJailName(groupId1),
        jail2: getJailName(groupId2),
      },
      'Potential group name collision detected (prevented by hash suffix)',
    );
  }

  return wouldCollide;
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
    const timeout = options.timeout || JAIL_EXEC_TIMEOUT;
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
      timeout: JAIL_EXEC_TIMEOUT,
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
    const stateDir = path.dirname(EPAIR_STATE_FILE);
    // Ensure directory exists
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o755 });
    }
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
  const maxRetries = 100;
  const retryDelay = 50; // milliseconds

  for (let i = 0; i < maxRetries; i++) {
    try {
      // Atomic operation: mkdir fails if directory exists
      fs.mkdirSync(EPAIR_LOCK_DIR, { mode: 0o755 });

      // Track this temp directory for cleanup
      sessionTempFiles.add(EPAIR_LOCK_DIR);

      // Lock acquired - return unlock function
      return () => {
        try {
          fs.rmdirSync(EPAIR_LOCK_DIR);
          sessionTempFiles.delete(EPAIR_LOCK_DIR);
        } catch (err) {
          logger.warn({ err, lockDir: EPAIR_LOCK_DIR }, 'Failed to release epair lock');
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
/**
 * Validate jail mount paths for security issues.
 * Defense-in-depth: validates even if upstream validation should have occurred.
 * @param mount - The mount to validate
 * @throws Error if mount is unsafe
 */
function validateJailMount(mount: JailMount): void {
  // Validate hostPath - must be absolute and cannot contain path traversal
  if (!path.isAbsolute(mount.hostPath)) {
    throw new Error(
      `Security: jail mount hostPath must be absolute: "${mount.hostPath}"`,
    );
  }

  // Check for path traversal in hostPath
  const normalizedHostPath = path.normalize(mount.hostPath);
  if (normalizedHostPath.includes('..')) {
    throw new Error(
      `Security: jail mount hostPath contains path traversal: "${mount.hostPath}"`,
    );
  }

  // Resolve symlinks in hostPath to prevent escape via symlink
  try {
    const realHostPath = fs.realpathSync(mount.hostPath);
    // Update mount to use real path
    mount.hostPath = realHostPath;
  } catch (err) {
    throw new Error(
      `Security: jail mount hostPath does not exist: "${mount.hostPath}"`,
    );
  }

  // Validate jailPath - must be absolute and cannot contain path traversal
  if (!path.isAbsolute(mount.jailPath)) {
    throw new Error(
      `Security: jail mount jailPath must be absolute: "${mount.jailPath}"`,
    );
  }

  const normalizedJailPath = path.normalize(mount.jailPath);
  if (normalizedJailPath.includes('..')) {
    throw new Error(
      `Security: jail mount jailPath contains path traversal: "${mount.jailPath}"`,
    );
  }

  // Blocked paths - never allow mounting these (even if they pass allowlist)
  const blockedPathPatterns = [
    '/.ssh',
    '/.gnupg',
    '/.aws',
    '/.docker',
    '/etc/passwd',
    '/etc/shadow',
    '/root',
  ];

  for (const pattern of blockedPathPatterns) {
    if (mount.hostPath.includes(pattern)) {
      throw new Error(
        `Security: jail mount hostPath matches blocked pattern "${pattern}": "${mount.hostPath}"`,
      );
    }
  }
}

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

  // Additional mounts - MUST be validated for security
  // Defense-in-depth: validate even if buildJailMountPaths already validated
  if (paths.additionalMounts) {
    for (const mount of paths.additionalMounts) {
      // Create a JailMount to validate
      const jailMount: JailMount = {
        hostPath: mount.hostPath,
        jailPath: mount.jailPath,
        readonly: mount.readonly,
      };

      // Validate for security issues (path traversal, symlinks, blocked paths)
      validateJailMount(jailMount);

      // Add validated mount (hostPath may have been updated to realpath)
      mounts.push(jailMount);
    }
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
      log.warn({ dataset, err: error }, 'Could not destroy existing dataset');
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
          timeout: JAIL_QUICK_OP_TIMEOUT,
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
    await sudoExec(['jail', '-r', jailName], { timeout: JAIL_STOP_TIMEOUT });
    logger.info({ jailName, groupId }, 'Jail stopped');
  } catch (error) {
    logger.warn(
      { jailName, groupId, err: error },
      'Failed to stop jail gracefully, trying force',
    );
    try {
      // Try to kill all processes in jail first
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
        timeout: JAIL_QUICK_OP_TIMEOUT,
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
      await sudoExec(['jail', '-r', jailName], {
        timeout: JAIL_FORCE_STOP_TIMEOUT,
      });
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
      timeout: JAIL_QUICK_OP_TIMEOUT,
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
      await sudoExec(['umount', '-f', targetPath], {
        timeout: JAIL_QUICK_OP_TIMEOUT,
      });
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
        timeout: JAIL_CREATE_TIMEOUT,
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
      await sudoExec(['ifconfig', hostIface, 'destroy'], {
        timeout: JAIL_QUICK_OP_TIMEOUT,
      });
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

  // Clean up temp files inside jail before stopping
  try {
    await cleanupJailTempFiles(groupId);
    logCleanupAudit('CLEANUP_TEMP_FILES', jailName, 'SUCCESS');
  } catch (error) {
    logger.warn(
      { jailName, groupId, err: error },
      'Could not clean up temp files',
    );
    logCleanupAudit('CLEANUP_TEMP_FILES', jailName, 'FAILED', error);
    // Don't add to errors - temp file cleanup is best-effort
  }

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

/**
 * Validate that pf configuration matches the current network mode.
 * In 'restricted' mode, pf must be enabled and have NAT/filter rules for jail network.
 * In 'inherit' mode, pf configuration is optional.
 * @throws Error if validation fails
 */
export function validatePfConfiguration(): void {
  if (JAIL_CONFIG.networkMode !== 'restricted') {
    // In 'inherit' mode, pf is not required
    return;
  }

  // In 'restricted' mode, we need pf enabled with proper rules
  try {
    // Check if pf is enabled
    const pfInfo = execFileSync('sudo', ['pfctl', '-s', 'info'], {
      stdio: 'pipe',
      timeout: 5000,
      encoding: 'utf-8',
    });

    if (!pfInfo.includes('Status: Enabled')) {
      throw new Error(
        'NETWORK MODE MISMATCH: Network mode is "restricted" but pf is not enabled.\n' +
          'To fix this issue:\n' +
          '  1. Run the migration script: scripts/switch-network-mode.sh restricted\n' +
          '  2. Or manually enable pf: sudo pfctl -e\n' +
          '  3. Or switch to "inherit" mode: export NANOCLAW_JAIL_NETWORK_MODE=inherit',
      );
    }

    // Check for NAT rules for jail network (10.99.0.0/24)
    const natRules = execFileSync('sudo', ['pfctl', '-s', 'nat'], {
      stdio: 'pipe',
      timeout: 5000,
      encoding: 'utf-8',
    });

    if (!natRules.includes('10.99.0.0/24')) {
      throw new Error(
        'NETWORK MODE MISMATCH: Network mode is "restricted" but pf NAT rules for jail network not found.\n' +
          'To fix this issue:\n' +
          '  1. Run the migration script: scripts/switch-network-mode.sh restricted\n' +
          '  2. Or manually load pf config: sudo pfctl -f etc/pf-nanoclaw.conf\n' +
          '  3. Or switch to "inherit" mode: export NANOCLAW_JAIL_NETWORK_MODE=inherit',
      );
    }

    logger.info('PF configuration validated for restricted network mode');
  } catch (err) {
    if (err instanceof Error && err.message.includes('NETWORK MODE MISMATCH')) {
      // Re-throw our validation errors as-is
      logger.fatal({ err }, 'PF configuration validation failed');
      throw err;
    }

    // pfctl command failed - pf may not be available or not configured
    logger.fatal(
      { err },
      'FATAL: Cannot validate pf configuration. Ensure pf is installed and configured.',
    );
    throw new Error(
      'NETWORK MODE MISMATCH: Network mode is "restricted" but pf validation failed.\n' +
        'To fix this issue:\n' +
        '  1. Run the migration script: scripts/switch-network-mode.sh restricted\n' +
        '  2. Or manually configure pf (see etc/pf-nanoclaw.conf)\n' +
        '  3. Or switch to "inherit" mode: export NANOCLAW_JAIL_NETWORK_MODE=inherit',
    );
  }
}

/** Ensure the jail subsystem is available. */
export function ensureJailRuntimeRunning(): void {
  try {
    // Check ZFS is available
    execFileSync('zfs', ['version'], { stdio: 'pipe', timeout: JAIL_QUICK_OP_TIMEOUT });

    // Check template snapshot exists
    const snapshot = `${JAIL_CONFIG.templateDataset}@${JAIL_CONFIG.templateSnapshot}`;
    execFileSync('zfs', ['list', '-t', 'snapshot', '-H', snapshot], {
      stdio: 'pipe',
      timeout: JAIL_QUICK_OP_TIMEOUT,
    });

    // Check jail command is available
    execFileSync('which', ['jail'], { stdio: 'pipe', timeout: JAIL_QUICK_OP_TIMEOUT });

    // Validate pf configuration matches network mode
    validatePfConfiguration();

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

/**
 * Clean up orphaned temp files in all running NanoClaw jails.
 * Removes common temp directories like /tmp/dist and /tmp/input.json.
 */
function cleanupOrphanedTempFiles(): void {
  try {
    // List all running jails with nanoclaw_ prefix
    const output = execFileSync('sudo', ['jls', '-N', 'name'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });

    const jailNames = output
      .trim()
      .split('\n')
      .filter((line) => line.startsWith('nanoclaw_'));

    if (jailNames.length === 0) {
      return;
    }

    logger.info(
      { count: jailNames.length },
      'Cleaning orphaned temp files from running jails',
    );

    for (const jailName of jailNames) {
      // Clean up common temp files from previous sessions
      const tempPaths = ['/tmp/dist', '/tmp/input.json'];
      for (const tempPath of tempPaths) {
        try {
          execFileSync('sudo', ['jexec', jailName, 'rm', '-rf', tempPath], {
            stdio: 'pipe',
            timeout: 5000,
          });
          logger.debug({ jailName, tempPath }, 'Removed orphaned temp file');
        } catch {
          // File may not exist - this is fine
        }
      }
    }

    logger.info('Completed orphaned temp file cleanup');
  } catch (err) {
    logger.debug({ err }, 'No running jails found for temp file cleanup');
  }
}

/** Kill orphaned NanoClaw jails from previous runs. */
export function cleanupOrphans(): void {
  // First, clean up temp files in any running jails
  cleanupOrphanedTempFiles();

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
          timeout: JAIL_QUICK_OP_TIMEOUT,
        });
        logger.info({ jailName }, 'Removed rctl limits for orphaned jail');
      } catch {
        // May not have rctl rules - ignore
      }

      try {
        logger.info({ jailName }, 'Stopping orphaned jail');
        execFileSync('sudo', ['jail', '-r', jailName], {
          stdio: 'pipe',
          timeout: JAIL_STOP_TIMEOUT,
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
              timeout: JAIL_QUICK_OP_TIMEOUT,
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
            timeout: JAIL_STOP_TIMEOUT,
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
                  timeout: JAIL_QUICK_OP_TIMEOUT,
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
      await sudoExec(['rctl', '-r', `jail:${jailName}`], {
        timeout: JAIL_QUICK_OP_TIMEOUT,
      });
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
      await sudoExec(['jail', '-r', jailName], { timeout: JAIL_STOP_TIMEOUT });
      logger.info({ jailName }, 'Stopped jail');
    } catch (err) {
      logger.warn({ jailName, err }, 'Failed to stop jail, continuing cleanup');
    }

    // Step 2: Unmount devfs
    try {
      await sudoExec(['umount', '-f', path.join(jailPath, 'dev')], {
        timeout: JAIL_QUICK_OP_TIMEOUT,
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
          await sudoExec(['umount', '-f', mountPoint], {
            timeout: JAIL_QUICK_OP_TIMEOUT,
          });
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
        await sudoExec(['zfs', 'destroy', '-r', dataset], {
          timeout: JAIL_CREATE_TIMEOUT,
        });
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

    // Clear the in-memory epair assignments and persist to disk
    assignedEpairs.clear();
    persistEpairState();
  }

  logger.info('Finished cleaning up all NanoClaw jails');

  // Clean up host-side temp files
  cleanupHostTempFiles();
}

/**
 * Clean up host-side temporary files created during sessions.
 * Removes epair lock directory and clears session tracking.
 */
function cleanupHostTempFiles(): void {
  logger.info('Cleaning up host-side temp files');

  // Clean up epair lock directory if it exists
  if (fs.existsSync(EPAIR_LOCK_DIR)) {
    try {
      fs.rmdirSync(EPAIR_LOCK_DIR);
      logger.debug({ lockDir: EPAIR_LOCK_DIR }, 'Removed epair lock directory');
    } catch (err) {
      logger.debug(
        { err, lockDir: EPAIR_LOCK_DIR },
        'Could not remove epair lock directory',
      );
    }
  }

  // Clean up all tracked session temp files
  for (const tempFile of sessionTempFiles) {
    try {
      if (fs.existsSync(tempFile)) {
        if (fs.statSync(tempFile).isDirectory()) {
          fs.rmdirSync(tempFile);
        } else {
          fs.unlinkSync(tempFile);
        }
        logger.debug({ tempFile }, 'Removed session temp file');
      }
    } catch (err) {
      logger.debug({ err, tempFile }, 'Could not remove session temp file');
    }
  }

  // Clear tracking
  sessionTempFiles.clear();
  jailTempDirs.clear();

  logger.debug('Completed host-side temp file cleanup');
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

/**
 * List all running NanoClaw jails.
 * @returns Array of jail names
 */
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
 * Track a jail as active so it won't be cleaned up as an orphan.
 * Called during startup to reconnect to existing jails.
 * @param jailName - The jail name
 */
export function trackActiveJail(jailName: string): void {
  // Extract groupId from jail name (nanoclaw_<groupId>)
  const groupId = jailName.replace(/^nanoclaw_/, '');
  activeJails.add(groupId);
  logger.debug({ jailName, groupId }, 'Tracked active jail');
}
