/**
 * FreeBSD Jail runtime for NanoClaw.
 * Replaces Docker/Apple Container runtime with native FreeBSD jails.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execFile, execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

/** Jail configuration - adjust paths for your environment */
export const JAIL_CONFIG = {
  templateDataset: 'zroot/nanoclaw/jails/template',
  templateSnapshot: 'base',
  jailsDataset: 'zroot/nanoclaw/jails',
  jailsPath: '/home/jims/code/nanoclaw/jails',
  workspacesPath: '/home/jims/code/nanoclaw/workspaces',
  ipcPath: '/home/jims/code/nanoclaw/ipc',
  // Network mode: "inherit" (ip4=inherit) or "restricted" (vnet with epair and pf)
  networkMode: process.env.NANOCLAW_JAIL_NETWORK_MODE || 'inherit',
  // Jail network configuration (used when networkMode === 'restricted')
  // Each jail gets its own /30 subnet via epair:
  //   - Host side (epairNa): 10.99.0.1/30 (gateway)
  //   - Jail side (epairNb): 10.99.0.2/30
  jailHostIP: '10.99.0.1',
  jailIP: '10.99.0.2',
  jailNetmask: '30',
  // Resource limits (rctl) - prevents runaway agents from crashing the host
  resourceLimits: {
    memoryuse: process.env.NANOCLAW_JAIL_MEMORY_LIMIT || '2G',   // Memory limit
    maxproc: process.env.NANOCLAW_JAIL_MAXPROC || '100',          // Max processes (prevents fork bombs)
    pcpu: process.env.NANOCLAW_JAIL_PCPU || '80',                 // CPU percentage limit
  },
};

/** Track assigned epair numbers for cleanup */
const assignedEpairs = new Map(); // groupId -> epair number (e.g., 0 for epair0a/epair0b)

/** Logging helper with prefix */
function log(message, data = {}) {
  const timestamp = new Date().toISOString();
  const dataStr = Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : '';
  console.log(`[jail-runtime] ${timestamp} ${message}${dataStr}`);
}

/** Cleanup audit logging */
const CLEANUP_AUDIT_LOG = path.join(JAIL_CONFIG.jailsPath, 'cleanup-audit.log');

function logCleanupAudit(action, jailName, status, error = null) {
  const timestamp = new Date().toISOString();
  const entry = {
    timestamp,
    action,
    jailName,
    status,
    error: error ? error.message : null,
  };
  const logLine = `${timestamp} [${status}] ${action} ${jailName}${error ? ` - ${error.message}` : ''}\n`;

  try {
    fs.appendFileSync(CLEANUP_AUDIT_LOG, logLine);
  } catch (err) {
    console.error(`Failed to write cleanup audit log: ${err.message}`);
  }
}

/**
 * Retry a function with exponential backoff.
 * @param {Function} fn - Async function to retry
 * @param {number} maxRetries - Maximum number of retries (default: 3)
 * @param {number} initialDelay - Initial delay in ms (default: 100)
 * @param {number} maxDelay - Maximum delay in ms (default: 5000)
 * @returns {Promise<any>} - Result of the function
 */
async function retryWithBackoff(fn, maxRetries = 3, initialDelay = 100, maxDelay = 5000) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const delay = Math.min(initialDelay * Math.pow(2, attempt), maxDelay);
        log(`Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms`, { error: error.message });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

/** Sanitize groupId for use in jail names (alphanumeric + underscore only) */
export function sanitizeJailName(groupId) {
  return groupId.replace(/[^a-zA-Z0-9_]/g, '_');
}

/** Generate jail name from groupId */
export function getJailName(groupId) {
  return `nanoclaw_${sanitizeJailName(groupId)}`;
}

/** Get the ZFS dataset path for a jail */
function getJailDataset(jailName) {
  return `${JAIL_CONFIG.jailsDataset}/${jailName}`;
}

/** Get the filesystem path for a jail root */
function getJailPath(jailName) {
  return path.join(JAIL_CONFIG.jailsPath, jailName);
}

/** Get the fstab path for a jail */
function getFstabPath(jailName) {
  return path.join(JAIL_CONFIG.jailsPath, `${jailName}.fstab`);
}

/**
 * Apply rctl resource limits to a jail.
 * @param {string} jailName - The jail name
 */
async function applyRctlLimits(jailName) {
  const limits = JAIL_CONFIG.resourceLimits;

  try {
    // Add memory limit
    await sudoExec(['rctl', '-a', `jail:${jailName}:memoryuse:deny=${limits.memoryuse}`]);
    log(`Applied memory limit`, { jailName, limit: limits.memoryuse });

    // Add process limit (prevents fork bombs)
    await sudoExec(['rctl', '-a', `jail:${jailName}:maxproc:deny=${limits.maxproc}`]);
    log(`Applied process limit`, { jailName, limit: limits.maxproc });

    // Add CPU limit
    await sudoExec(['rctl', '-a', `jail:${jailName}:pcpu:deny=${limits.pcpu}`]);
    log(`Applied CPU limit`, { jailName, limit: limits.pcpu });
  } catch (error) {
    log(`Warning: could not apply rctl limits: ${error.message}`, { jailName });
    // Don't fail jail creation if rctl is not available - just warn
  }
}

/**
 * Remove rctl resource limits from a jail.
 * @param {string} jailName - The jail name
 */
async function removeRctlLimits(jailName) {
  try {
    // Remove all rctl rules for this jail
    await sudoExec(['rctl', '-r', `jail:${jailName}`]);
    log(`Removed rctl limits`, { jailName });
  } catch (error) {
    // Jail may not exist or rctl rules may not be set - ignore
    log(`Note: could not remove rctl limits (may not exist): ${error.message}`, { jailName });
  }
}

/** Execute a command with sudo, returning a promise */
function sudoExec(args, options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout || 30000;
    execFile('sudo', args, { timeout, ...options }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`sudo ${args.join(' ')} failed: ${stderr || error.message}`));
      } else {
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      }
    });
  });
}

/** Execute a command with sudo synchronously */
function sudoExecSync(args, options = {}) {
  try {
    return execFileSync('sudo', args, { encoding: 'utf-8', timeout: 30000, ...options });
  } catch (error) {
    throw new Error(`sudo ${args.join(' ')} failed: ${error.message}`);
  }
}

/**
 * Execute a function with an exclusive file lock to prevent concurrent access.
 * Uses flock(1) to wrap the operation in an atomic lock.
 * @param {Function} fn - Async function to execute under lock
 * @returns {Promise<*>} Result of the function
 */
async function withEpairLock(fn) {
  const lockPath = '/tmp/nanoclaw-epair.lock';

  // Create lock file if it doesn't exist
  if (!fs.existsSync(lockPath)) {
    fs.writeFileSync(lockPath, '', { mode: 0o644 });
  }

  // We'll use a temporary script file to execute the operation under flock
  // This ensures the lock is held for the entire duration of epair creation
  const scriptPath = `/tmp/nanoclaw-epair-${process.pid}-${Date.now()}.sh`;

  try {
    // Execute function and capture result
    // Since we can't easily pass Node.js function to flock, we use a simpler approach:
    // Just execute the function directly with a mutex-style lock file approach
    let acquired = false;
    let attempts = 0;
    const maxAttempts = 50; // 5 seconds max wait

    while (!acquired && attempts < maxAttempts) {
      try {
        // Try to create lock file exclusively
        fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
        acquired = true;
      } catch (err) {
        if (err.code === 'EEXIST') {
          // Lock held by another process, wait and retry
          await new Promise(resolve => setTimeout(resolve, 100));
          attempts++;

          // Check if lock is stale (process no longer exists)
          try {
            const lockPid = parseInt(fs.readFileSync(lockPath, 'utf8'), 10);
            if (lockPid) {
              // Try to check if process exists (send signal 0)
              try {
                process.kill(lockPid, 0);
                // Process exists, continue waiting
              } catch (e) {
                // Process doesn't exist, lock is stale, remove it
                if (e.code === 'ESRCH') {
                  try {
                    fs.unlinkSync(lockPath);
                  } catch (unlinkErr) {
                    // Another process may have removed it
                  }
                }
              }
            }
          } catch (readErr) {
            // Lock file may have been removed, try again
          }
        } else {
          throw err;
        }
      }
    }

    if (!acquired) {
      throw new Error('Failed to acquire epair lock after timeout');
    }

    // Execute the function under lock
    try {
      return await fn();
    } finally {
      // Release lock
      try {
        // Only remove if we still own it
        const lockPid = parseInt(fs.readFileSync(lockPath, 'utf8'), 10);
        if (lockPid === process.pid) {
          fs.unlinkSync(lockPath);
        }
      } catch (err) {
        // Lock file may have been removed already
      }
    }
  } finally {
    // Clean up temp script if it exists
    try {
      if (fs.existsSync(scriptPath)) {
        fs.unlinkSync(scriptPath);
      }
    } catch (err) {
      // Ignore cleanup errors
    }
  }
}

/**
 * Create an epair interface pair for a vnet jail.
 * Epairs provide virtual network interface pairs for jail network isolation.
 * The host side is configured with the gateway IP, and the jail side is moved into the jail.
 * Uses file-based locking to prevent race conditions in concurrent jail creation.
 * @param {string} groupId - The group identifier (for tracking)
 * @returns {Promise<{epairNum: number, hostIface: string, jailIface: string}>} The epair number and interface names
 * @throws {Error} If epair creation fails or name format is unexpected
 */
export async function createEpair(groupId) {
  // Execute epair creation under exclusive lock to prevent races
  return await withEpairLock(async () => {
    // Create epair - FreeBSD returns the name (e.g., "epair0")
    const result = await sudoExec(['ifconfig', 'epair', 'create']);
    const epairName = result.stdout.trim(); // e.g., "epair0a"

    // Extract the number from epair0a -> 0
    const match = epairName.match(/epair(\d+)a/);
    if (!match) {
      throw new Error(`Unexpected epair name format: ${epairName}`);
    }
    const epairNum = parseInt(match[1], 10);

    const hostIface = `epair${epairNum}a`;
    const jailIface = `epair${epairNum}b`;

    // Configure host side with gateway IP
    await sudoExec(['ifconfig', hostIface, `${JAIL_CONFIG.jailHostIP}/${JAIL_CONFIG.jailNetmask}`, 'up']);

    // Track epair for cleanup
    assignedEpairs.set(groupId, epairNum);

    log(`Created epair`, { groupId, epairNum, hostIface, jailIface });
    return { epairNum, hostIface, jailIface };
  });
}

/**
 * Configure networking inside a vnet jail after it starts.
 * Sets up the jail's network interface with IP and default route via the host gateway.
 * Must be called after the jail is started and the epair interface is assigned to it.
 * @param {string} jailName - The jail name
 * @param {string} jailIface - The jail-side interface name (e.g., "epair0b")
 * @returns {Promise<void>}
 * @throws {Error} If interface configuration or routing fails
 */
export async function configureJailNetwork(jailName, jailIface) {
  // Configure the jail's interface
  await sudoExec(['jexec', jailName, 'ifconfig', jailIface, `${JAIL_CONFIG.jailIP}/${JAIL_CONFIG.jailNetmask}`, 'up']);

  // Add default route via the host
  await sudoExec(['jexec', jailName, 'route', 'add', 'default', JAIL_CONFIG.jailHostIP]);

  log(`Configured jail network`, { jailName, jailIface, ip: JAIL_CONFIG.jailIP, gateway: JAIL_CONFIG.jailHostIP });
}

/**
 * Destroy an epair interface pair.
 * Removes both sides of the epair by destroying the host-side interface.
 * Safe to call even if the epair no longer exists.
 * @param {number} epairNum - The epair number
 * @returns {Promise<void>}
 */
export async function destroyEpair(epairNum) {
  const hostIface = `epair${epairNum}a`;
  try {
    // Destroying the 'a' side destroys both sides
    await sudoExec(['ifconfig', hostIface, 'destroy']);
    log(`Destroyed epair`, { epairNum });
  } catch (error) {
    log(`Warning: could not destroy epair: ${error.message}`, { epairNum });
  }
}

/**
 * Release a jail's assigned epair and destroy it.
 * @param {string} groupId - The group identifier
 */
async function releaseEpair(groupId) {
  const epairNum = assignedEpairs.get(groupId);
  if (epairNum !== undefined) {
    await destroyEpair(epairNum);
    assignedEpairs.delete(groupId);
  }
}

/**
 * Setup resolv.conf in the jail for DNS resolution.
 * Copies the host's /etc/resolv.conf so the jail uses the same DNS servers.
 * @param {string} jailPath - Path to the jail root
 */
async function setupJailResolv(jailPath) {
  const resolvPath = path.join(jailPath, 'etc', 'resolv.conf');

  try {
    const hostResolv = fs.readFileSync('/etc/resolv.conf', 'utf-8');
    await sudoExec(['sh', '-c', `cat > ${resolvPath} << 'RESOLV'\n${hostResolv}\nRESOLV`]);
    log(`Copied host resolv.conf to jail`);
  } catch (error) {
    log(`Warning: could not create jail resolv.conf: ${error.message}`);
  }
}

/** Check if a jail exists and is running */
export function isJailRunning(jailName) {
  try {
    const output = sudoExecSync(['jls', '-j', jailName, 'jid'], { stdio: 'pipe' });
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

/** Check if a ZFS dataset exists */
function datasetExists(dataset) {
  try {
    execFileSync('zfs', ['list', '-H', dataset], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if ZFS pool has sufficient available space before cloning.
 * Prevents cryptic errors and incomplete cleanup when pool is full.
 * @param {string} pool - The ZFS pool name (e.g., "zroot")
 * @param {number} minAvailableGB - Minimum required space in GB (default: 1GB)
 * @throws {Error} If pool has insufficient space
 */
function checkPoolCapacity(pool, minAvailableGB = 1) {
  try {
    const result = execFileSync('zfs', ['list', '-H', '-o', 'available', pool], {
      encoding: 'utf8',
      stdio: 'pipe'
    });
    const availableStr = result.trim();

    // Parse the available space (can be in K, M, G, T, P format)
    const match = availableStr.match(/^([\d.]+)([KMGTP]?)$/);
    if (!match) {
      throw new Error(`Unable to parse available space: ${availableStr}`);
    }

    const value = parseFloat(match[1]);
    const unit = match[2] || 'B';

    // Convert to GB
    const multipliers = { 'K': 1e-6, 'M': 1e-3, 'G': 1, 'T': 1000, 'P': 1e6, 'B': 1e-9 };
    const availableGB = value * (multipliers[unit] || 1);

    if (availableGB < minAvailableGB) {
      throw new Error(
        `Insufficient ZFS pool space: ${availableStr} available on ${pool}, ` +
        `but ${minAvailableGB}GB required. Free up space before creating new jails.`
      );
    }

    log(`ZFS pool capacity check passed`, { pool, available: availableStr, requiredGB: minAvailableGB });
  } catch (error) {
    if (error.message.includes('Insufficient ZFS pool space')) {
      throw error;
    }
    // If we can't check capacity, log warning but don't fail
    log(`Warning: could not check ZFS pool capacity: ${error.message}`, { pool });
  }
}

/**
 * Jail-native mount layout.
 * These are the 5 semantic mounts a jail needs - no Docker translation.
 */
export const JAIL_MOUNT_LAYOUT = {
  project: '/workspace/project',      // NanoClaw source (ro)
  group: '/workspace/group',          // Group's folder (rw)
  ipc: '/workspace/ipc',              // Group's IPC directory (rw)
  claudeSession: '/home/node/.claude', // Claude session data (rw)
  agentRunner: '/app/src',            // Agent runner source (ro)
};

/**
 * Build mount specs from semantic paths.
 * @param {Object} paths - Semantic mount paths
 * @param {string} paths.projectPath - Path to NanoClaw source (read-only)
 * @param {string} paths.groupPath - Path to this group's folder (read-write)
 * @param {string} paths.ipcPath - Path to this group's IPC directory (read-write)
 * @param {string} paths.claudeSessionPath - Path to Claude session data (read-write)
 * @param {string} paths.agentRunnerPath - Path to agent runner source (read-only)
 * @returns {Array<{hostPath: string, jailPath: string, readonly: boolean}>}
 */
export function buildJailMounts(paths) {
  const mounts = [];

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
 * @param {Object} paths - Semantic mount paths
 */
export function ensureHostDirectories(paths) {
  const dirsToCreate = [
    paths.groupPath,
    paths.ipcPath,
    paths.claudeSessionPath,
  ].filter(Boolean);

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
      log(`Warning: could not set permissions on ${dir}: ${err.message}`);
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
        log(`Warning: could not set permissions on ${subdirPath}: ${err.message}`);
      }
    }
  }
}

/** Build fstab content for jail mounts */
function buildFstab(mounts, jailPath) {
  const lines = [];
  for (const mount of mounts) {
    const targetPath = path.join(jailPath, mount.jailPath);
    const opts = mount.readonly ? 'ro' : 'rw';
    lines.push(`${mount.hostPath}\t${targetPath}\tnullfs\t${opts}\t0\t0`);
  }
  return lines.join('\n') + '\n';
}

/** Create mount point directories inside the jail */
async function createMountPoints(mounts, jailPath) {
  const resolvedJailRoot = path.resolve(jailPath);

  for (const mount of mounts) {
    const targetPath = path.resolve(jailPath, mount.jailPath);

    // Paranoid check: target must be within jail root (defense in depth)
    if (!targetPath.startsWith(resolvedJailRoot + path.sep) && targetPath !== resolvedJailRoot) {
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
async function mountNullfs(mounts, jailPath) {
  const resolvedJailRoot = path.resolve(jailPath);

  for (const mount of mounts) {
    // Canonicalize paths with realpath-style resolution
    const targetPath = path.resolve(jailPath, mount.jailPath);

    // Paranoid check: target must be within jail root (defense in depth)
    if (!targetPath.startsWith(resolvedJailRoot + path.sep) && targetPath !== resolvedJailRoot) {
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
      log(`Failed to mount ${mount.hostPath}: ${error.message}`);
      throw error;
    }
  }
}

/** Unmount all nullfs mounts for a jail (reverse order) */
async function unmountAll(mounts, jailPath) {
  const errors = [];
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
        errors.push(`Failed to unmount ${targetPath}: ${error.message}`);
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
 * Ensures host directories exist with proper permissions, builds mount specs, and creates the jail.
 * Returns both the jail name and mount specs for use during cleanup.
 * @param {string} groupId - The group identifier
 * @param {Object} paths - Semantic mount paths
 * @param {string} [paths.projectPath] - Path to NanoClaw source (read-only)
 * @param {string} [paths.groupPath] - Path to this group's folder (read-write)
 * @param {string} [paths.ipcPath] - Path to this group's IPC directory (read-write)
 * @param {string} [paths.claudeSessionPath] - Path to Claude session data (read-write)
 * @param {string} [paths.agentRunnerPath] - Path to agent runner source (read-only)
 * @returns {Promise<{jailName: string, mounts: Array<{hostPath: string, jailPath: string, readonly: boolean}>}>} The jail name and mount specs for cleanup
 * @throws {Error} If jail creation fails
 */
export async function createJailWithPaths(groupId, paths) {
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
 * Clones the ZFS template, creates mount points, configures networking, and starts the jail.
 * Applies resource limits (rctl) to prevent runaway processes. Automatically cleans up on failure.
 * For most use cases, prefer createJailWithPaths() which handles path setup automatically.
 * @param {string} groupId - The group identifier
 * @param {Array<{hostPath: string, jailPath: string, readonly: boolean}>} [mounts=[]] - Mount specifications
 * @returns {Promise<string>} The jail name
 * @throws {Error} If jail creation fails (triggers automatic cleanup on failure)
 */
export async function createJail(groupId, mounts = []) {
  const jailName = getJailName(groupId);
  const dataset = getJailDataset(jailName);
  const jailPath = getJailPath(jailName);
  const fstabPath = getFstabPath(jailName);
  const snapshot = `${JAIL_CONFIG.templateDataset}@${JAIL_CONFIG.templateSnapshot}`;

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
      log(`Warning: could not destroy existing dataset: ${error.message}`);
    }
  }

  try {
    // Check ZFS pool capacity before clone to prevent cryptic errors
    const pool = dataset.split('/')[0]; // Extract pool name (e.g., "zroot" from "zroot/nanoclaw/jails/...")
    checkPoolCapacity(pool, 1); // Require at least 1GB available

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
    await sudoExec(['sh', '-c', `echo '{}' > ${jailPath}/home/node/.claude.json`]);
    await sudoExec(['chown', '-R', '1000:1000', `${jailPath}/home/node`]);

    // Ensure /tmp is writable by node user (entrypoint compiles TypeScript to /tmp/dist)
    await sudoExec(['chmod', '1777', `${jailPath}/tmp`]);

    // Network setup for restricted mode (vnet with epair)
    let epairInfo = null;
    if (JAIL_CONFIG.networkMode === 'restricted') {
      // Create epair interface pair
      epairInfo = await createEpair(groupId);
      log(`Created epair for jail`, { groupId, ...epairInfo });

      // Setup resolv.conf for DNS
      await setupJailResolv(jailPath);
    }

    // Create the jail
    const jailParams = [
      'jail', '-c',
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
      jailParams.push(`vnet.interface=${epairInfo.jailIface}`);
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
      await configureJailNetwork(jailName, epairInfo.jailIface);
    }

    log(`Jail created successfully`, { jailName });
    return jailName;
  } catch (error) {
    // Cleanup on failure
    log(`Jail creation failed, cleaning up`, { jailName, error: error.message });
    await cleanupJail(groupId, mounts);
    throw error;
  }
}

/**
 * Execute a command inside a jail and wait for completion.
 * Runs as the 'node' user with umask 002 for group-writable files. Supports configurable
 * environment, working directory, timeout, and abort signals. Streaming output available
 * via onStdout/onStderr callbacks for real-time monitoring.
 * @param {string} groupId - The group identifier
 * @param {string[]} command - Command and arguments to execute
 * @param {Object} [options={}] - Execution options
 * @param {Object} [options.env={}] - Environment variables to set
 * @param {string} [options.cwd] - Working directory inside jail
 * @param {number} [options.timeout] - Timeout in milliseconds (kills all jail processes on timeout)
 * @param {AbortSignal} [options.signal] - AbortSignal to cancel execution (kills all jail processes)
 * @param {Function} [options.onStdout] - Callback for stdout data chunks (string)
 * @param {Function} [options.onStderr] - Callback for stderr data chunks (string)
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} Exit code and captured output
 * @throws {Error} If jail is not running, execution times out, or is aborted
 */
export async function execInJail(groupId, command, options = {}) {
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
    // Note: 'sh' after the script becomes $0, then command arguments become $1, $2, ... ($@)
    args.push('sh', '-c', 'umask 002; exec "$@"', 'sh');

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

    const timeoutId = timeout ? setTimeout(() => {
      if (settled) return;
      timedOut = true;
      log(`Execution timeout, killing jail processes`, { jailName, timeout });
      killJailProcesses();
    }, timeout) : null;

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
 * Spawn an interactive process inside a jail for streaming I/O.
 * Returns a ChildProcess for direct control of stdin/stdout/stderr streams. Unlike execInJail,
 * this does not wait for completion - use for long-running processes or interactive sessions.
 * Runs as the 'node' user with umask 002 for group-writable files.
 * @param {string} groupId - The group identifier
 * @param {string[]} command - Command and arguments to execute
 * @param {Object} [options={}] - Spawn options
 * @param {Object} [options.env={}] - Environment variables to set
 * @param {string} [options.cwd] - Working directory inside jail
 * @returns {import('child_process').ChildProcess} Child process handle with stdin/stdout/stderr streams
 */
export function spawnInJail(groupId, command, options = {}) {
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
 * Attempts graceful shutdown first (jail -r), then force stops by killing all processes
 * and retrying if necessary. Safe to call even if jail is not running.
 * @param {string} groupId - The group identifier
 * @returns {Promise<void>}
 * @throws {Error} If force stop fails after multiple attempts
 */
export async function stopJail(groupId) {
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
    log(`Failed to stop jail gracefully, trying force`, { jailName, error: error.message });
    try {
      // Try to kill all processes in jail first
      await sudoExec(['jexec', jailName, 'kill', '-9', '-1'], { timeout: 5000 }).catch(() => {});
      await sudoExec(['jail', '-r', jailName], { timeout: 10000 });
      log(`Jail force stopped`, { jailName });
    } catch (forceError) {
      log(`Failed to force stop jail`, { jailName, error: forceError.message });
      throw forceError;
    }
  }
}

/**
 * Force cleanup of a jail using aggressive methods when normal cleanup fails.
 * This kills all processes, force unmounts, and force destroys datasets.
 * @param {string} jailName - The jail name
 * @param {Array<{hostPath: string, jailPath: string, readonly: boolean}>} mounts - Mount specifications
 * @param {string} dataset - The ZFS dataset path
 * @param {string} jailPath - The jail filesystem path
 * @param {string|null} epairNum - The epair number if in restricted network mode
 */
async function forceCleanup(jailName, mounts, dataset, jailPath, epairNum = null) {
  log(`Starting force cleanup`, { jailName });
  logCleanupAudit('FORCE_CLEANUP_START', jailName, 'INFO');

  const errors = [];

  // 1. Kill all processes in jail (if still running)
  if (isJailRunning(jailName)) {
    try {
      await sudoExec(['jexec', jailName, 'kill', '-9', '-1'], { timeout: 5000 });
      log(`Killed all processes in jail`, { jailName });
      logCleanupAudit('KILL_PROCESSES', jailName, 'SUCCESS');
    } catch (error) {
      log(`Could not kill processes in jail: ${error.message}`, { jailName });
      logCleanupAudit('KILL_PROCESSES', jailName, 'FAILED', error);
      errors.push(new Error(`Failed to kill processes: ${error.message}`));
    }

    // 2. Force stop jail
    try {
      await sudoExec(['jail', '-r', jailName], { timeout: 10000 });
      log(`Force stopped jail`, { jailName });
      logCleanupAudit('FORCE_STOP_JAIL', jailName, 'SUCCESS');
    } catch (error) {
      log(`Could not force stop jail: ${error.message}`, { jailName });
      logCleanupAudit('FORCE_STOP_JAIL', jailName, 'FAILED', error);
      errors.push(new Error(`Failed to force stop jail: ${error.message}`));
    }
  }

  // 3. Force unmount devfs
  try {
    await sudoExec(['umount', '-f', path.join(jailPath, 'dev')], { timeout: 5000 });
    log(`Force unmounted devfs`, { jailName });
    logCleanupAudit('FORCE_UNMOUNT_DEVFS', jailName, 'SUCCESS');
  } catch (error) {
    // Expected to fail if not mounted
    log(`Could not force unmount devfs (may not be mounted): ${error.message}`, { jailName });
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
      log(`Could not force unmount ${targetPath}: ${error.message}`);
      logCleanupAudit('FORCE_UNMOUNT_NULLFS', jailName, 'FAILED', error);
      errors.push(new Error(`Failed to force unmount ${targetPath}: ${error.message}`));
    }
  }

  // 5. Force destroy ZFS dataset with all dependents
  if (datasetExists(dataset)) {
    try {
      await sudoExec(['zfs', 'destroy', '-f', '-r', dataset], { timeout: 30000 });
      log(`Force destroyed dataset`, { dataset });
      logCleanupAudit('FORCE_DESTROY_DATASET', jailName, 'SUCCESS');
    } catch (error) {
      log(`Could not force destroy dataset: ${error.message}`, { dataset });
      logCleanupAudit('FORCE_DESTROY_DATASET', jailName, 'FAILED', error);
      errors.push(new Error(`Failed to force destroy dataset: ${error.message}`));
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
      log(`Could not force destroy epair: ${error.message}`, { epairNum });
      logCleanupAudit('FORCE_DESTROY_EPAIR', jailName, 'FAILED', error);
      errors.push(new Error(`Failed to force destroy epair: ${error.message}`));
    }
  }

  if (errors.length > 0) {
    logCleanupAudit('FORCE_CLEANUP_END', jailName, 'PARTIAL', new Error(`${errors.length} errors during force cleanup`));
    throw new AggregateError(errors, `Force cleanup completed with ${errors.length} error(s)`);
  } else {
    logCleanupAudit('FORCE_CLEANUP_END', jailName, 'SUCCESS');
  }

  log(`Force cleanup completed`, { jailName, errorCount: errors.length });
}

/**
 * Clean up jail resources completely with retry logic and error aggregation.
 * Removes rctl limits, stops the jail, destroys epair interfaces, unmounts filesystems
 * (devfs and nullfs), destroys the ZFS dataset, and removes the fstab file.
 * Safe to call even if jail is partially created or already destroyed.
 * Falls back to force cleanup if normal cleanup fails.
 * @param {string} groupId - The group identifier
 * @param {Array<{hostPath: string, jailPath: string, readonly: boolean}>} [mounts=[]] - Mount specifications (for unmounting)
 * @returns {Promise<void>}
 */
export async function cleanupJail(groupId, mounts = []) {
  const jailName = getJailName(groupId);
  const dataset = getJailDataset(jailName);
  const jailPath = getJailPath(jailName);
  const fstabPath = getFstabPath(jailName);

  log(`Cleaning up jail`, { jailName });
  logCleanupAudit('CLEANUP_START', jailName, 'INFO');

  const errors = [];
  const epairNum = JAIL_CONFIG.networkMode === 'restricted' && assignedEpairs.has(groupId)
    ? assignedEpairs.get(groupId)
    : null;

  // Remove rctl limits before stopping jail
  await removeRctlLimits(jailName);

  try {
    // Stop jail if running (with retry)
    if (isJailRunning(jailName)) {
      try {
        await retryWithBackoff(async () => {
          await stopJail(groupId);
          if (isJailRunning(jailName)) {
            throw new Error('Jail still running after stop');
          }
        }, 2, 500, 2000);
        logCleanupAudit('STOP_JAIL', jailName, 'SUCCESS');
      } catch (error) {
        log(`Warning: could not stop jail during cleanup: ${error.message}`);
        logCleanupAudit('STOP_JAIL', jailName, 'FAILED', error);
        errors.push(new Error(`Failed to stop jail: ${error.message}`));
      }
    }

    // Destroy epair if in restricted network mode (with retry)
    if (epairNum !== null) {
      try {
        await retryWithBackoff(async () => {
          await releaseEpair(groupId);
        }, 2, 200, 1000);
        logCleanupAudit('RELEASE_EPAIR', jailName, 'SUCCESS');
      } catch (error) {
        log(`Warning: could not release epair: ${error.message}`);
        logCleanupAudit('RELEASE_EPAIR', jailName, 'FAILED', error);
        errors.push(new Error(`Failed to release epair: ${error.message}`));
      }
    }

    // Unmount devfs first (required before nullfs unmounts and zfs destroy)
    try {
      await sudoExec(['umount', '-f', path.join(jailPath, 'dev')]);
      logCleanupAudit('UNMOUNT_DEVFS', jailName, 'SUCCESS');
    } catch (error) {
      // Expected to fail if devfs not mounted, don't add to errors
      log(`Devfs unmount (expected to fail if not mounted): ${error.message}`);
    }

    // Unmount nullfs mounts (with retry)
    if (mounts.length > 0) {
      try {
        await retryWithBackoff(async () => {
          await unmountAll(mounts, jailPath);
        }, 2, 300, 2000);
        logCleanupAudit('UNMOUNT_NULLFS', jailName, 'SUCCESS');
      } catch (error) {
        log(`Warning: could not unmount all filesystems: ${error.message}`);
        logCleanupAudit('UNMOUNT_NULLFS', jailName, 'FAILED', error);
        errors.push(new Error(`Failed to unmount filesystems: ${error.message}`));
      }
    }

    // Destroy ZFS dataset (with retry)
    if (datasetExists(dataset)) {
      try {
        await retryWithBackoff(async () => {
          await sudoExec(['zfs', 'destroy', '-r', dataset]);
          if (datasetExists(dataset)) {
            throw new Error('Dataset still exists after destroy');
          }
        }, 2, 500, 3000);
        log(`Destroyed dataset`, { dataset });
        logCleanupAudit('DESTROY_DATASET', jailName, 'SUCCESS');
      } catch (error) {
        log(`Warning: could not destroy dataset: ${error.message}`);
        logCleanupAudit('DESTROY_DATASET', jailName, 'FAILED', error);
        errors.push(new Error(`Failed to destroy dataset: ${error.message}`));
      }
    }

    // Remove fstab file
    if (fs.existsSync(fstabPath)) {
      try {
        fs.unlinkSync(fstabPath);
        log(`Removed fstab`, { fstabPath });
        logCleanupAudit('REMOVE_FSTAB', jailName, 'SUCCESS');
      } catch (error) {
        log(`Warning: could not remove fstab: ${error.message}`);
        logCleanupAudit('REMOVE_FSTAB', jailName, 'FAILED', error);
        errors.push(new Error(`Failed to remove fstab: ${error.message}`));
      }
    }
  } catch (unexpectedError) {
    log(`Unexpected error during cleanup: ${unexpectedError.message}`, { jailName });
    logCleanupAudit('CLEANUP_UNEXPECTED_ERROR', jailName, 'FAILED', unexpectedError);
    errors.push(unexpectedError);
  } finally {
    // If normal cleanup had errors, try force cleanup
    if (errors.length > 0) {
      log(`Normal cleanup failed with ${errors.length} error(s), attempting force cleanup`, { jailName });
      logCleanupAudit('CLEANUP_FALLBACK_TO_FORCE', jailName, 'INFO');

      try {
        await forceCleanup(jailName, mounts, dataset, jailPath, epairNum);
        log(`Force cleanup succeeded after normal cleanup failed`, { jailName });
        logCleanupAudit('CLEANUP_END', jailName, 'SUCCESS_FORCED');
      } catch (forceError) {
        log(`Force cleanup also failed`, { jailName, error: forceError.message });
        logCleanupAudit('CLEANUP_END', jailName, 'FAILED', forceError);

        // Aggregate all errors from both attempts
        if (forceError instanceof AggregateError) {
          errors.push(...forceError.errors);
        } else {
          errors.push(forceError);
        }

        throw new AggregateError(errors, `Jail cleanup failed (tried normal and force): ${errors.length} error(s)`);
      }
    } else {
      log(`Jail cleanup completed successfully`, { jailName });
      logCleanupAudit('CLEANUP_END', jailName, 'SUCCESS');
    }
  }
}

/**
 * Destroy a jail completely.
 * Convenience function that calls cleanupJail to perform full teardown including stopping,
 * unmounting, and removing all jail resources. Alias for cleanupJail.
 * @param {string} groupId - The group identifier
 * @param {Array<{hostPath: string, jailPath: string, readonly: boolean}>} [mounts=[]] - Mount specifications
 * @returns {Promise<void>}
 */
export async function destroyJail(groupId, mounts = []) {
  // cleanupJail handles stopping if needed, unmounting, and ZFS cleanup
  await cleanupJail(groupId, mounts);
}

/**
 * Ensure the jail subsystem is available and properly configured.
 * Verifies that ZFS is available, the required template snapshot exists, and the jail
 * command is present. Prints helpful error message if requirements are not met.
 * Should be called during startup to fail fast if the environment is not ready.
 * @throws {Error} If jail runtime requirements are not met (ZFS, template snapshot, or jail command missing)
 */
export function ensureJailRuntimeRunning() {
  try {
    // Check ZFS is available
    execFileSync('zfs', ['version'], { stdio: 'pipe', timeout: 5000 });

    // Check template snapshot exists
    const snapshot = `${JAIL_CONFIG.templateDataset}@${JAIL_CONFIG.templateSnapshot}`;
    execFileSync('zfs', ['list', '-t', 'snapshot', '-H', snapshot], { stdio: 'pipe', timeout: 5000 });

    // Check jail command is available
    execFileSync('which', ['jail'], { stdio: 'pipe', timeout: 5000 });

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

/**
 * Clean up orphaned NanoClaw jails from previous runs.
 * Finds all running jails with 'nanoclaw_' prefix and performs full cleanup: removes rctl
 * limits, stops jails, unmounts filesystems, destroys ZFS datasets, removes fstab files,
 * and destroys orphaned epair interfaces. Called at startup to ensure clean slate.
 * @returns {void}
 */
export function cleanupOrphans() {
  try {
    // List all running jails with nanoclaw_ prefix
    const output = execFileSync('sudo', ['jls', '-N', 'name'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });

    const orphans = output.trim().split('\n')
      .filter(line => line.startsWith('nanoclaw_'));

    for (const jailName of orphans) {
      // Remove rctl limits for orphaned jail
      try {
        execFileSync('sudo', ['rctl', '-r', `jail:${jailName}`], { stdio: 'pipe', timeout: 5000 });
        log(`Removed rctl limits for orphaned jail`, { jailName });
      } catch {
        // May not have rctl rules - ignore
      }

      try {
        log(`Stopping orphaned jail`, { jailName });
        execFileSync('sudo', ['jail', '-r', jailName], { stdio: 'pipe', timeout: 15000 });
        log(`Stopped orphaned jail`, { jailName });
      } catch {
        // Already stopped or failed - try cleanup anyway
        log(`Could not stop orphaned jail, attempting cleanup`, { jailName });
      }

      // Unmount any nullfs mounts for this jail before destroying dataset
      const orphanJailPath = getJailPath(jailName);
      try {
        const mountOutput = execFileSync('mount', ['-t', 'nullfs'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        const jailMounts = mountOutput.split('\n')
          .filter(line => line.includes(orphanJailPath))
          .map(line => {
            const match = line.match(/on (.+?) \(/);
            return match ? match[1] : null;
          })
          .filter(Boolean)
          .reverse();

        for (const mountPoint of jailMounts) {
          try {
            execFileSync('sudo', ['umount', '-f', mountPoint], { stdio: 'pipe', timeout: 5000 });
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
          execFileSync('sudo', ['zfs', 'destroy', '-r', dataset], { stdio: 'pipe', timeout: 15000 });
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
            const epairNum = parseInt(match[1], 10);
            // Check if this epair is tracked (if not, it's orphaned)
            const isTracked = Array.from(assignedEpairs.values()).includes(epairNum);
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
      log(`Cleaned up orphaned jails`, { count: orphans.length, names: orphans });
    }
  } catch (err) {
    log(`Failed to clean up orphaned jails`, { error: err.message });
  }
}

/**
 * Clean up all running NanoClaw jails during shutdown.
 * Ensures proper teardown of all jails: removes rctl limits, stops jails, unmounts
 * filesystems (devfs and nullfs), destroys ZFS datasets, removes fstab files, and
 * destroys all epair interfaces. Prevents resource leaks and ensures ZFS can be cleanly
 * destroyed. Should be called during graceful shutdown.
 * @returns {Promise<void>}
 */
export async function cleanupAllJails() {
  log('Cleaning up all NanoClaw jails...');

  let jailNames = [];
  try {
    const output = execFileSync('sudo', ['jls', '-N', 'name'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    jailNames = output.trim().split('\n').filter(line => line.startsWith('nanoclaw_'));
  } catch (err) {
    // No jails running or jls failed
    log('No running jails found or jls failed', { error: err.message });
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
      log(`Failed to remove rctl limits, continuing cleanup`, { jailName, error: err.message });
    }

    // Step 1: Stop the jail
    try {
      log(`Stopping jail`, { jailName });
      await sudoExec(['jail', '-r', jailName], { timeout: 15000 });
      log(`Stopped jail`, { jailName });
    } catch (err) {
      log(`Failed to stop jail, continuing cleanup`, { jailName, error: err.message });
    }

    // Step 2: Unmount devfs
    try {
      await sudoExec(['umount', '-f', path.join(jailPath, 'dev')], { timeout: 5000 });
      log(`Unmounted devfs`, { jailName });
    } catch (err) {
      log(`Failed to unmount devfs, continuing`, { jailName, error: err.message });
    }

    // Step 3: Unmount all nullfs mounts under jailPath
    try {
      const mountOutput = execFileSync('mount', ['-t', 'nullfs'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const jailMounts = mountOutput.split('\n')
        .filter(line => line.includes(jailPath))
        .map(line => {
          const match = line.match(/on (.+?) \(/);
          return match ? match[1] : null;
        })
        .filter(Boolean)
        .reverse(); // Unmount in reverse order

      for (const mountPoint of jailMounts) {
        try {
          await sudoExec(['umount', '-f', mountPoint], { timeout: 5000 });
          log(`Unmounted nullfs`, { mountPoint });
        } catch (err) {
          log(`Failed to unmount nullfs, continuing`, { mountPoint, error: err.message });
        }
      }
    } catch (err) {
      log(`Failed to list/unmount nullfs mounts`, { jailName, error: err.message });
    }

    // Step 4: Destroy ZFS dataset
    if (datasetExists(dataset)) {
      try {
        await sudoExec(['zfs', 'destroy', '-r', dataset], { timeout: 30000 });
        log(`Destroyed ZFS dataset`, { dataset });
      } catch (err) {
        log(`Failed to destroy ZFS dataset, continuing`, { dataset, error: err.message });
      }
    }

    // Step 5: Remove fstab file
    if (fs.existsSync(fstabPath)) {
      try {
        fs.unlinkSync(fstabPath);
        log(`Removed fstab file`, { fstabPath });
      } catch (err) {
        log(`Failed to remove fstab file, continuing`, { fstabPath, error: err.message });
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
            log(`Failed to destroy epair`, { iface, error: err.message });
          }
        }
      }
    } catch (err) {
      log(`Failed to clean up epair interfaces`, { error: err.message });
    }

    // Clear the in-memory epair assignments
    assignedEpairs.clear();
  }

  log(`Finished cleaning up all NanoClaw jails`);
}

