/**
 * FreeBSD Jail runtime for NanoClaw.
 * Replaces Docker/Apple Container runtime with native FreeBSD jails.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execFile, execFileSync, spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

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

/** Logging helper with prefix */
function log(message: string, data: Record<string, unknown> = {}): void {
  const timestamp = new Date().toISOString();
  const dataStr =
    Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : '';
  console.log(`[jail-runtime] ${timestamp} ${message}${dataStr}`);
}

/** Cleanup audit logging */
const CLEANUP_AUDIT_LOG = path.join(JAIL_CONFIG.jailsPath, 'cleanup-audit.log');

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
    const errMessage = err instanceof Error ? err.message : String(err);
    console.error(`Failed to write cleanup audit log: ${errMessage}`);
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
        log(`Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms`, {
          error: errorMessage,
        });
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

  try {
    // Add memory limit
    await sudoExec([
      'rctl',
      '-a',
      `jail:${jailName}:memoryuse:deny=${limits.memoryuse}`,
    ]);
    log(`Applied memory limit`, { jailName, limit: limits.memoryuse });

    // Add process limit (prevents fork bombs)
    await sudoExec([
      'rctl',
      '-a',
      `jail:${jailName}:maxproc:deny=${limits.maxproc}`,
    ]);
    log(`Applied process limit`, { jailName, limit: limits.maxproc });

    // Add CPU limit
    await sudoExec(['rctl', '-a', `jail:${jailName}:pcpu:deny=${limits.pcpu}`]);
    log(`Applied CPU limit`, { jailName, limit: limits.pcpu });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`Warning: could not apply rctl limits: ${errorMessage}`, { jailName });
    // Don't fail jail creation if rctl is not available - just warn
  }
}

/**
 * Remove rctl resource limits from a jail.
 * @param jailName - The jail name
 */
async function removeRctlLimits(jailName: string): Promise<void> {
  try {
    // Remove all rctl rules for this jail
    await sudoExec(['rctl', '-r', `jail:${jailName}`]);
    log(`Removed rctl limits`, { jailName });
  } catch (error) {
    // Jail may not exist or rctl rules may not be set - ignore
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`Note: could not remove rctl limits (may not exist): ${errorMessage}`, {
      jailName,
    });
  }
}

/** Execute a command with sudo, returning a promise */
function sudoExec(
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

/** Execute a command with sudo synchronously */
function sudoExecSync(args: string[], options: SudoExecOptions = {}): string {
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
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`Warning: failed to persist epair state: ${errorMessage}`);
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
      log(`Restored epair state from disk`, { count: assignedEpairs.size });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log(`Warning: failed to restore epair state: ${errorMessage}`);
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
        log(
          `Epair ${epairNum} for group ${groupId} no longer exists, removing from state`,
        );
        assignedEpairs.delete(groupId);
      }
    }

    // Persist the cleaned-up state
    persistEpairState();

    log(`Synced epair state with system`, {
      tracked: assignedEpairs.size,
      existing: existingEpairs.size,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`Warning: failed to sync epair state with system: ${errorMessage}`);
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
          const errorMessage = err instanceof Error ? err.message : String(err);
          log(`Warning: failed to release epair lock: ${errorMessage}`);
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

  try {
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

    log(`Created epair`, {
      groupId,
      epairNum,
      hostIface,
      jailIface,
      hostIP,
      jailIP,
    });
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

  log(`Configured jail network`, {
    jailName,
    jailIface: epairInfo.jailIface,
    ip: epairInfo.jailIP,
    gateway: epairInfo.hostIP,
  });
}

/**
 * Destroy an epair interface pair.
 * @param epairNum - The epair number
 */
async function destroyEpair(epairNum: number): Promise<void> {
  const hostIface = `epair${epairNum}a`;
  try {
    // Destroying the 'a' side destroys both sides
    await sudoExec(['ifconfig', hostIface, 'destroy']);
    log(`Destroyed epair`, { epairNum });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`Warning: could not destroy epair: ${errorMessage}`, { epairNum });
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
  const resolvPath = path.join(jailPath, 'etc', 'resolv.conf');

  try {
    const hostResolv = fs.readFileSync('/etc/resolv.conf', 'utf-8');
    await sudoExec([
      'sh',
      '-c',
      `cat > ${resolvPath} << 'RESOLV'\n${hostResolv}\nRESOLV`,
    ]);
    log(`Copied host resolv.conf to jail`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`Warning: could not create jail resolv.conf: ${errorMessage}`);
  }
}

/** Check if a jail exists and is running */
export function isJailRunning(jailName: string): boolean {
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
      log(`Created host directory`, { dir });
    }
    // Set mode 2775 (rwxrwsr-x) - setgid ensures new files inherit wheel group
    // Set group to wheel (gid 0) so jail's node user (supplementary group wheel) can write
    try {
      fs.chmodSync(dir, 0o2775);
      fs.chownSync(dir, uid, wheelGid);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log(`Warning: could not set permissions on ${dir}: ${errorMessage}`);
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
        const errorMessage = err instanceof Error ? err.message : String(err);
        log(
          `Warning: could not set permissions on ${subdirPath}: ${errorMessage}`,
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
      log(`Mounted ${mount.hostPath} -> ${targetPath} (${opts})`);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log(`Failed to mount ${mount.hostPath}: ${errorMessage}`);
      throw error;
    }
  }
}

/** Unmount all nullfs mounts for a jail (reverse order) */
async function unmountAll(
  mounts: JailMount[],
  jailPath: string,
): Promise<void> {
  const errors: string[] = [];
  // Unmount in reverse order
  for (let i = mounts.length - 1; i >= 0; i--) {
    const mount = mounts[i];
    const targetPath = path.join(jailPath, mount.jailPath);
    try {
      await sudoExec(['umount', targetPath]);
      log(`Unmounted ${targetPath}`);
    } catch (error) {
      // Try force unmount
      try {
        await sudoExec(['umount', '-f', targetPath]);
        log(`Force unmounted ${targetPath}`);
      } catch {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        errors.push(`Failed to unmount ${targetPath}: ${errorMessage}`);
      }
    }
  }
  if (errors.length > 0) {
    log(`Unmount errors: ${errors.join(', ')}`);
  }
}

/**
 * Create a new jail from template snapshot using semantic paths.
 * This is the preferred entry point for jail creation - no Docker translation needed.
 * @param groupId - The group identifier
 * @param paths - Semantic mount paths
 * @returns Promise with jail name and mount specs for cleanup
 */
export async function createJailWithPaths(
  groupId: string,
  paths: JailMountPaths,
): Promise<JailCreationResult> {
  // Ensure host directories exist
  ensureHostDirectories(paths);

  // Build mount specs from semantic paths
  const mounts = buildJailMounts(paths);

  // Create the jail
  const jailName = await createJail(groupId, mounts);

  return { jailName, mounts };
}

/**
 * Create a new jail from template snapshot.
 * @param groupId - The group identifier
 * @param mounts - Mount specifications
 * @returns Promise with the jail name
 */
export async function createJail(
  groupId: string,
  mounts: JailMount[] = [],
): Promise<string> {
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

  log(`Creating jail`, { jailName, groupId });

  // Check if jail already exists
  if (isJailRunning(jailName)) {
    log(`Jail already running, stopping first`, { jailName });
    await stopJail(groupId);
  }

  // Check if dataset exists (leftover from crash)
  if (datasetExists(dataset)) {
    log(`Dataset exists, destroying first`, { dataset });
    try {
      await sudoExec(['zfs', 'destroy', '-r', dataset]);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log(`Warning: could not destroy existing dataset: ${errorMessage}`);
    }
  }

  try {
    // Clone template snapshot
    log(`Cloning template`, { snapshot, dataset });
    await sudoExec(['zfs', 'clone', snapshot, dataset]);

    // Create mount points inside jail
    await createMountPoints(mounts, jailPath);

    // Write fstab for this jail
    const fstabContent = buildFstab(mounts, jailPath);
    fs.writeFileSync(fstabPath, fstabContent);
    log(`Wrote fstab`, { fstabPath, mountCount: mounts.length });

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
      log(`Created epair for jail`, { groupId, ...epairInfo });

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

    log(`Starting jail`, { jailName, params: jailParams.slice(2) });
    await sudoExec(jailParams);

    // Apply resource limits to prevent runaway processes
    await applyRctlLimits(jailName);

    // Configure networking inside the vnet jail
    if (JAIL_CONFIG.networkMode === 'restricted' && epairInfo) {
      await configureJailNetwork(jailName, epairInfo);
    }

    // Track active jail
    activeJails.add(groupId);

    log(`Jail created successfully`, {
      jailName,
      activeCount: activeJails.size,
      maxJails: MAX_CONCURRENT_JAILS,
    });
    return jailName;
  } catch (error) {
    // Cleanup on failure
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`Jail creation failed, cleaning up`, { jailName, error: errorMessage });
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

    log(`Executing in jail`, { jailName, command: command.join(' '), cwd });

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
          log(`Execution timeout, killing jail processes`, {
            jailName,
            timeout,
          });
          killJailProcesses();
        }, timeout)
      : null;

    // Handle AbortSignal
    const abortHandler = () => {
      if (settled) return;
      aborted = true;
      log(`Execution aborted via signal`, { jailName });
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

      log(`Execution completed`, { jailName, code });
      resolve({ code: code || 0, stdout, stderr });
    });

    proc.on('error', (error) => {
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (signal) signal.removeEventListener('abort', abortHandler);
      log(`Execution error`, { jailName, error: error.message });
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

  log(`Spawning in jail`, { jailName, command: command.join(' '), cwd });

  return spawn('sudo', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Stop a running jail.
 * @param groupId - The group identifier
 */
export async function stopJail(groupId: string): Promise<void> {
  const jailName = getJailName(groupId);

  if (!isJailRunning(jailName)) {
    log(`Jail not running`, { jailName });
    return;
  }

  log(`Stopping jail`, { jailName });

  try {
    await sudoExec(['jail', '-r', jailName], { timeout: 15000 });
    log(`Jail stopped`, { jailName });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`Failed to stop jail gracefully, trying force`, {
      jailName,
      error: errorMessage,
    });
    try {
      // Try to kill all processes in jail first
      await sudoExec(['jexec', jailName, 'kill', '-9', '-1'], {
        timeout: 5000,
      }).catch(() => {});
      await sudoExec(['jail', '-r', jailName], { timeout: 10000 });
      log(`Jail force stopped`, { jailName });
    } catch (forceError) {
      const forceErrorMessage =
        forceError instanceof Error ? forceError.message : String(forceError);
      log(`Failed to force stop jail`, { jailName, error: forceErrorMessage });
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
  log(`Starting force cleanup`, { jailName });
  logCleanupAudit('FORCE_CLEANUP_START', jailName, 'INFO');

  const errors = [];

  // 1. Kill all processes in jail (if still running)
  if (isJailRunning(jailName)) {
    try {
      await sudoExec(['jexec', jailName, 'kill', '-9', '-1'], {
        timeout: 5000,
      });
      log(`Killed all processes in jail`, { jailName });
      logCleanupAudit('KILL_PROCESSES', jailName, 'SUCCESS');
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log(`Could not kill processes in jail: ${errorMessage}`, { jailName });
      logCleanupAudit('KILL_PROCESSES', jailName, 'FAILED', error);
      errors.push(new Error(`Failed to kill processes: ${errorMessage}`));
    }

    // 2. Force stop jail
    try {
      await sudoExec(['jail', '-r', jailName], { timeout: 10000 });
      log(`Force stopped jail`, { jailName });
      logCleanupAudit('FORCE_STOP_JAIL', jailName, 'SUCCESS');
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log(`Could not force stop jail: ${errorMessage}`, { jailName });
      logCleanupAudit('FORCE_STOP_JAIL', jailName, 'FAILED', error);
      errors.push(new Error(`Failed to force stop jail: ${errorMessage}`));
    }
  }

  // 3. Force unmount devfs
  try {
    await sudoExec(['umount', '-f', path.join(jailPath, 'dev')], {
      timeout: 5000,
    });
    log(`Force unmounted devfs`, { jailName });
    logCleanupAudit('FORCE_UNMOUNT_DEVFS', jailName, 'SUCCESS');
  } catch (error) {
    // Expected to fail if not mounted
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`Could not force unmount devfs (may not be mounted): ${errorMessage}`, {
      jailName,
    });
  }

  // 4. Force unmount all nullfs mounts
  for (let i = mounts.length - 1; i >= 0; i--) {
    const mount = mounts[i];
    const targetPath = path.join(jailPath, mount.jailPath);
    try {
      await sudoExec(['umount', '-f', targetPath], { timeout: 5000 });
      log(`Force unmounted ${targetPath}`);
      logCleanupAudit('FORCE_UNMOUNT_NULLFS', jailName, 'SUCCESS', null);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log(`Could not force unmount ${targetPath}: ${errorMessage}`);
      logCleanupAudit('FORCE_UNMOUNT_NULLFS', jailName, 'FAILED', error);
      errors.push(
        new Error(`Failed to force unmount ${targetPath}: ${errorMessage}`),
      );
    }
  }

  // 5. Force destroy ZFS dataset with all dependents
  if (datasetExists(dataset)) {
    try {
      await sudoExec(['zfs', 'destroy', '-f', '-r', dataset], {
        timeout: 30000,
      });
      log(`Force destroyed dataset`, { dataset });
      logCleanupAudit('FORCE_DESTROY_DATASET', jailName, 'SUCCESS');
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log(`Could not force destroy dataset: ${errorMessage}`, { dataset });
      logCleanupAudit('FORCE_DESTROY_DATASET', jailName, 'FAILED', error);
      errors.push(
        new Error(`Failed to force destroy dataset: ${errorMessage}`),
      );
    }
  }

  // 6. Destroy epair (if in restricted network mode)
  if (epairNum !== null) {
    try {
      const hostIface = `epair${epairNum}a`;
      await sudoExec(['ifconfig', hostIface, 'destroy'], { timeout: 5000 });
      log(`Force destroyed epair`, { epairNum });
      logCleanupAudit('FORCE_DESTROY_EPAIR', jailName, 'SUCCESS');
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log(`Could not force destroy epair: ${errorMessage}`, { epairNum });
      logCleanupAudit('FORCE_DESTROY_EPAIR', jailName, 'FAILED', error);
      errors.push(new Error(`Failed to force destroy epair: ${errorMessage}`));
    }
  }

  if (errors.length > 0) {
    logCleanupAudit(
      'FORCE_CLEANUP_END',
      jailName,
      'PARTIAL',
      new Error(`${errors.length} errors during force cleanup`),
    );
    throw new AggregateError(
      errors,
      `Force cleanup completed with ${errors.length} error(s)`,
    );
  } else {
    logCleanupAudit('FORCE_CLEANUP_END', jailName, 'SUCCESS');
  }

  log(`Force cleanup completed`, { jailName, errorCount: errors.length });
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
  const jailName = getJailName(groupId);
  const dataset = getJailDataset(jailName);
  const jailPath = getJailPath(jailName);
  const fstabPath = getFstabPath(jailName);

  log(`Cleaning up jail`, { jailName });
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
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        log(`Warning: could not stop jail during cleanup: ${errorMessage}`);
        logCleanupAudit('STOP_JAIL', jailName, 'FAILED', error);
        errors.push(new Error(`Failed to stop jail: ${errorMessage}`));
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
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        log(`Warning: could not release epair: ${errorMessage}`);
        logCleanupAudit('RELEASE_EPAIR', jailName, 'FAILED', error);
        errors.push(new Error(`Failed to release epair: ${errorMessage}`));
      }
    }

    // Unmount devfs first (required before nullfs unmounts and zfs destroy)
    try {
      await sudoExec(['umount', '-f', path.join(jailPath, 'dev')]);
      logCleanupAudit('UNMOUNT_DEVFS', jailName, 'SUCCESS');
    } catch (error) {
      // Expected to fail if devfs not mounted, don't add to errors
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log(`Devfs unmount (expected to fail if not mounted): ${errorMessage}`);
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
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        log(`Warning: could not unmount all filesystems: ${errorMessage}`);
        logCleanupAudit('UNMOUNT_NULLFS', jailName, 'FAILED', error);
        errors.push(
          new Error(`Failed to unmount filesystems: ${errorMessage}`),
        );
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
        log(`Destroyed dataset`, { dataset });
        logCleanupAudit('DESTROY_DATASET', jailName, 'SUCCESS');
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        log(`Warning: could not destroy dataset: ${errorMessage}`);
        logCleanupAudit('DESTROY_DATASET', jailName, 'FAILED', error);
        errors.push(new Error(`Failed to destroy dataset: ${errorMessage}`));
      }
    }

    // Remove fstab file
    if (fs.existsSync(fstabPath)) {
      try {
        fs.unlinkSync(fstabPath);
        log(`Removed fstab`, { fstabPath });
        logCleanupAudit('REMOVE_FSTAB', jailName, 'SUCCESS');
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        log(`Warning: could not remove fstab: ${errorMessage}`);
        logCleanupAudit('REMOVE_FSTAB', jailName, 'FAILED', error);
        errors.push(new Error(`Failed to remove fstab: ${errorMessage}`));
      }
    }
  } catch (unexpectedError) {
    const errorMessage =
      unexpectedError instanceof Error
        ? unexpectedError.message
        : String(unexpectedError);
    log(`Unexpected error during cleanup: ${errorMessage}`, { jailName });
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
      log(
        `Normal cleanup failed with ${errors.length} error(s), attempting force cleanup`,
        { jailName },
      );
      logCleanupAudit('CLEANUP_FALLBACK_TO_FORCE', jailName, 'INFO');

      try {
        await forceCleanup(jailName, mounts, dataset, jailPath, epairNum);
        log(`Force cleanup succeeded after normal cleanup failed`, {
          jailName,
        });
        logCleanupAudit('CLEANUP_END', jailName, 'SUCCESS_FORCED');
      } catch (forceError) {
        const errorMessage =
          forceError instanceof Error ? forceError.message : String(forceError);
        log(`Force cleanup also failed`, { jailName, error: errorMessage });
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
      log(`Jail cleanup completed successfully`, { jailName });
      logCleanupAudit('CLEANUP_END', jailName, 'SUCCESS');
    }

    // Remove from active jails tracking
    activeJails.delete(groupId);
    log(`Removed jail from active tracking`, {
      jailName,
      activeCount: activeJails.size,
    });
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

    log('Jail runtime verified');
  } catch (err) {
    console.error(
      '\n+================================================================+',
    );
    console.error(
      '|  FATAL: Jail runtime requirements not met                      |',
    );
    console.error(
      '|                                                                |',
    );
    console.error(
      '|  Agents cannot run without the jail subsystem. To fix:        |',
    );
    console.error(
      '|  1. Ensure ZFS is available: zfs version                      |',
    );
    console.error(
      `|  2. Create template snapshot: ${JAIL_CONFIG.templateDataset}@${JAIL_CONFIG.templateSnapshot}  |`,
    );
    console.error(
      '|  3. Ensure jail(8) is in PATH                                 |',
    );
    console.error(
      '+================================================================+\n',
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
        log(`Removed rctl limits for orphaned jail`, { jailName });
      } catch {
        // May not have rctl rules - ignore
      }

      try {
        log(`Stopping orphaned jail`, { jailName });
        execFileSync('sudo', ['jail', '-r', jailName], {
          stdio: 'pipe',
          timeout: 15000,
        });
        log(`Stopped orphaned jail`, { jailName });
      } catch {
        // Already stopped or failed - try cleanup anyway
        log(`Could not stop orphaned jail, attempting cleanup`, { jailName });
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
            log(`Unmounted orphan mount`, { mountPoint });
          } catch {
            log(`Could not unmount orphan mount`, { mountPoint });
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
          log(`Destroyed orphan dataset`, { dataset });
        } catch {
          log(`Could not destroy orphan dataset`, { dataset });
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
                log(`Destroyed orphan epair`, { epairNum });
              } catch {
                log(`Could not destroy orphan epair`, { epairNum });
              }
            }
          }
        }
      } catch {
        // No epairs or error checking - that's fine
      }
    }

    if (orphans.length > 0) {
      log(`Cleaned up orphaned jails`, {
        count: orphans.length,
        names: orphans,
      });
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Failed to clean up orphaned jails`, { error: errorMessage });
  }
}

/**
 * Clean up all running NanoClaw jails.
 * Called during shutdown to ensure devfs is unmounted and ZFS datasets can be destroyed.
 * @returns Promise<void>
 */
export async function cleanupAllJails(): Promise<void> {
  log('Cleaning up all NanoClaw jails...');

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
    const errorMessage = err instanceof Error ? err.message : String(err);
    log('No running jails found or jls failed', { error: errorMessage });
    return;
  }

  if (jailNames.length === 0) {
    log('No NanoClaw jails to clean up');
    return;
  }

  log(`Found ${jailNames.length} jail(s) to clean up`, { names: jailNames });

  for (const jailName of jailNames) {
    const jailPath = getJailPath(jailName);
    const dataset = `${JAIL_CONFIG.jailsDataset}/${jailName}`;
    const fstabPath = path.join(JAIL_CONFIG.jailsPath, `${jailName}.fstab`);

    // Step 0: Remove rctl limits
    try {
      await sudoExec(['rctl', '-r', `jail:${jailName}`], { timeout: 5000 });
      log(`Removed rctl limits`, { jailName });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log(`Failed to remove rctl limits, continuing cleanup`, {
        jailName,
        error: errorMessage,
      });
    }

    // Step 1: Stop the jail
    try {
      log(`Stopping jail`, { jailName });
      await sudoExec(['jail', '-r', jailName], { timeout: 15000 });
      log(`Stopped jail`, { jailName });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log(`Failed to stop jail, continuing cleanup`, {
        jailName,
        error: errorMessage,
      });
    }

    // Step 2: Unmount devfs
    try {
      await sudoExec(['umount', '-f', path.join(jailPath, 'dev')], {
        timeout: 5000,
      });
      log(`Unmounted devfs`, { jailName });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log(`Failed to unmount devfs, continuing`, {
        jailName,
        error: errorMessage,
      });
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
          log(`Unmounted nullfs`, { mountPoint });
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log(`Failed to unmount nullfs, continuing`, {
            mountPoint,
            error: errorMessage,
          });
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log(`Failed to list/unmount nullfs mounts`, {
        jailName,
        error: errorMessage,
      });
    }

    // Step 4: Destroy ZFS dataset
    if (datasetExists(dataset)) {
      try {
        await sudoExec(['zfs', 'destroy', '-r', dataset], { timeout: 30000 });
        log(`Destroyed ZFS dataset`, { dataset });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log(`Failed to destroy ZFS dataset, continuing`, {
          dataset,
          error: errorMessage,
        });
      }
    }

    // Step 5: Remove fstab file
    if (fs.existsSync(fstabPath)) {
      try {
        fs.unlinkSync(fstabPath);
        log(`Removed fstab file`, { fstabPath });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log(`Failed to remove fstab file, continuing`, {
          fstabPath,
          error: errorMessage,
        });
      }
    }

    log(`Completed cleanup for jail`, { jailName });
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
            log(`Destroyed epair`, { iface });
          } catch (err) {
            const errorMessage =
              err instanceof Error ? err.message : String(err);
            log(`Failed to destroy epair`, { iface, error: errorMessage });
          }
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log(`Failed to clean up epair interfaces`, { error: errorMessage });
    }

    // Clear the in-memory epair assignments
    assignedEpairs.clear();
  }

  log(`Finished cleaning up all NanoClaw jails`);
}
