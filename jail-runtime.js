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
  // Network mode: "inherit" (ip4=inherit) or "restricted" (lo1 with pf)
  networkMode: process.env.NANOCLAW_JAIL_NETWORK_MODE || 'inherit',
  // Jail network configuration (used when networkMode === 'restricted')
  jailInterface: 'lo1',
  jailNetworkPrefix: '10.99.0',
  jailGateway: '10.99.0.1',
};

/** Track assigned jail IPs to prevent collisions */
const assignedJailIPs = new Map(); // groupId -> IP number (1-254)


/**
 * Generate a deterministic IP number (2-254) from a groupId.
 * Uses a simple hash to map groupId to a number in range.
 * @param {string} groupId - The group identifier
 * @returns {number} - IP number (2-254)
 */
function hashGroupIdToIP(groupId) {
  let hash = 0;
  for (let i = 0; i < groupId.length; i++) {
    const char = groupId.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  // Map to range 2-254 (1 is gateway, 255 is broadcast)
  return Math.abs(hash % 253) + 2;
}

/**
 * Assign a unique IP to a jail, avoiding collisions with other running jails.
 * @param {string} groupId - The group identifier
 * @returns {number} - Assigned IP number (2-254)
 */
function assignJailIP(groupId) {
  // Check if already assigned
  if (assignedJailIPs.has(groupId)) {
    return assignedJailIPs.get(groupId);
  }

  // Get deterministic starting point from hash
  let ipNum = hashGroupIdToIP(groupId);
  const usedIPs = new Set(assignedJailIPs.values());

  // Find an unused IP, starting from hash result
  let attempts = 0;
  while (usedIPs.has(ipNum) && attempts < 253) {
    ipNum = (ipNum % 253) + 2; // Wrap around within 2-254
    attempts++;
  }

  if (attempts >= 253) {
    throw new Error('No available IP addresses in jail network (all 253 IPs in use)');
  }

  assignedJailIPs.set(groupId, ipNum);
  return ipNum;
}

/**
 * Release a jail's assigned IP.
 * @param {string} groupId - The group identifier
 */
function releaseJailIP(groupId) {
  assignedJailIPs.delete(groupId);
}

/**
 * Get the full IP address for a jail.
 * @param {string} groupId - The group identifier
 * @returns {string} - Full IP address (e.g., "10.99.0.42")
 */
function getJailIPAddress(groupId) {
  const ipNum = assignedJailIPs.get(groupId);
  if (!ipNum) {
    throw new Error(`No IP assigned for groupId: ${groupId}`);
  }
  return `${JAIL_CONFIG.jailNetworkPrefix}.${ipNum}`;
}

/** Logging helper with prefix */
function log(message, data = {}) {
  const timestamp = new Date().toISOString();
  const dataStr = Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : '';
  console.log(`[jail-runtime] ${timestamp} ${message}${dataStr}`);
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
 * Ensure the lo1 interface exists and has the gateway IP configured.
 * Called once per session, not per jail.
 */
async function ensureJailInterface() {
  const iface = JAIL_CONFIG.jailInterface;
  const gateway = JAIL_CONFIG.jailGateway;

  // Try to create lo1 (ignore error if it already exists)
  try {
    await sudoExec(['ifconfig', iface, 'create']);
    log(`Created interface ${iface}`);
  } catch {
    // Interface already exists, which is fine
  }

  // Check if gateway IP is already configured
  try {
    const output = execFileSync('ifconfig', [iface], { encoding: 'utf-8', stdio: 'pipe' });
    if (output.includes(gateway)) {
      log(`Interface ${iface} already has gateway ${gateway}`);
      return;
    }
  } catch {
    // Interface might not exist yet, continue to configure
  }

  // Add the gateway IP
  try {
    await sudoExec(['ifconfig', iface, 'inet', `${gateway}/24`]);
    log(`Configured ${iface} with gateway ${gateway}/24`);
  } catch (error) {
    // May already be set, check and ignore
    if (!error.message.includes('File exists')) {
      log(`Warning: could not configure gateway IP: ${error.message}`);
    }
  }
}

/**
 * Add an IP alias for a jail on the lo1 interface.
 * @param {string} ipAddress - Full IP address (e.g., "10.99.0.42")
 */
async function addJailIPAlias(ipAddress) {
  const iface = JAIL_CONFIG.jailInterface;
  try {
    await sudoExec(['ifconfig', iface, 'alias', `${ipAddress}/32`]);
    log(`Added IP alias ${ipAddress}/32 on ${iface}`);
  } catch (error) {
    if (!error.message.includes('File exists')) {
      throw error;
    }
    // Alias already exists, which is fine
    log(`IP alias ${ipAddress}/32 already exists on ${iface}`);
  }
}

/**
 * Remove an IP alias from the lo1 interface.
 * @param {string} ipAddress - Full IP address (e.g., "10.99.0.42")
 */
async function removeJailIPAlias(ipAddress) {
  const iface = JAIL_CONFIG.jailInterface;
  try {
    await sudoExec(['ifconfig', iface, '-alias', ipAddress]);
    log(`Removed IP alias ${ipAddress} from ${iface}`);
  } catch (error) {
    // Ignore errors - alias may not exist
    log(`Could not remove IP alias ${ipAddress}: ${error.message}`);
  }
}

/**
 * Setup resolv.conf in the jail for DNS resolution.
 * Points to the jail gateway which should run a local resolver.
 * @param {string} jailPath - Path to the jail root
 */
async function setupJailResolv(jailPath) {
  const resolvPath = path.join(jailPath, 'etc', 'resolv.conf');
  const gateway = JAIL_CONFIG.jailGateway;

  // Check if host has a local resolver (local_unbound)
  let useHostResolver = false;
  try {
    const hostResolv = fs.readFileSync('/etc/resolv.conf', 'utf-8');
    if (hostResolv.includes('127.0.0.1') || hostResolv.includes('::1')) {
      useHostResolver = true;
    }
  } catch {
    // Can't read host resolv.conf, use gateway
  }

  // Create resolv.conf content pointing to gateway
  // The gateway (host) should forward DNS queries appropriately
  const content = `# Generated by NanoClaw jail-runtime
# DNS queries go through the jail gateway (host)
nameserver ${gateway}
`;

  try {
    await sudoExec(['sh', '-c', `cat > ${resolvPath} << 'EOF'\n${content}EOF`]);
    log(`Created jail resolv.conf pointing to ${gateway}`);
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
  for (const mount of mounts) {
    const targetPath = path.join(jailPath, mount.jailPath);
    await sudoExec(['mkdir', '-p', targetPath]);
  }
}

/** Mount all nullfs mounts for a jail */
async function mountNullfs(mounts, jailPath) {
  for (const mount of mounts) {
    const targetPath = path.join(jailPath, mount.jailPath);
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
 * @param {string} groupId - The group identifier
 * @param {Object} paths - Semantic mount paths
 * @param {string} paths.projectPath - Path to NanoClaw source (read-only)
 * @param {string} paths.groupPath - Path to this group's folder (read-write)
 * @param {string} paths.ipcPath - Path to this group's IPC directory (read-write)
 * @param {string} paths.claudeSessionPath - Path to Claude session data (read-write)
 * @param {string} paths.agentRunnerPath - Path to agent runner source (read-only)
 * @returns {Promise<{jailName: string, mounts: Array}>} - The jail name and mount specs for cleanup
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
 * @param {string} groupId - The group identifier
 * @param {Array<{hostPath: string, jailPath: string, readonly: boolean}>} mounts - Mount specifications
 * @returns {Promise<string>} - The jail name
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

    // Network setup for restricted mode
    let jailIP = null;
    if (JAIL_CONFIG.networkMode === 'restricted') {
      // Ensure lo1 interface exists with gateway IP
      await ensureJailInterface();

      // Assign unique IP to this jail
      const ipNum = assignJailIP(groupId);
      jailIP = `${JAIL_CONFIG.jailNetworkPrefix}.${ipNum}`;
      log(`Assigned jail IP`, { groupId, jailIP });

      // Add IP alias on lo1
      await addJailIPAlias(jailIP);

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
      // Use dedicated IP on lo1 interface
      jailParams.push(`ip4.addr=${JAIL_CONFIG.jailInterface}|${jailIP}`);
    }

    // Allow certain sysctls for compatibility
    jailParams.push(
      'allow.raw_sockets', // Needed for DNS resolution
      'allow.sysvipc',
      'enforce_statfs=1',
      'mount.devfs',
    );

    log(`Starting jail`, { jailName, params: jailParams.slice(2) });
    await sudoExec(jailParams);

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
 * Execute a command inside a jail.
 * @param {string} groupId - The group identifier
 * @param {string[]} command - Command and arguments to execute
 * @param {Object} options - Execution options
 * @param {Object} options.env - Environment variables
 * @param {string} options.cwd - Working directory inside jail
 * @param {number} options.timeout - Timeout in milliseconds
 * @param {AbortSignal} options.signal - AbortSignal to cancel execution
 * @param {Function} options.onStdout - Callback for stdout data
 * @param {Function} options.onStderr - Callback for stderr data
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
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
 * Spawn an interactive process inside a jail (for streaming I/O).
 * @param {string} groupId - The group identifier
 * @param {string[]} command - Command and arguments to execute
 * @param {Object} options - Spawn options
 * @param {Object} options.env - Environment variables
 * @param {string} options.cwd - Working directory inside jail
 * @returns {ChildProcess}
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
 * @param {string} groupId - The group identifier
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
 * Clean up jail resources (unmount, destroy dataset, remove fstab, remove IP alias).
 * @param {string} groupId - The group identifier
 * @param {Array<{hostPath: string, jailPath: string, readonly: boolean}>} mounts - Mount specifications (for unmounting)
 */
export async function cleanupJail(groupId, mounts = []) {
  const jailName = getJailName(groupId);
  const dataset = getJailDataset(jailName);
  const jailPath = getJailPath(jailName);
  const fstabPath = getFstabPath(jailName);

  log(`Cleaning up jail`, { jailName });

  // Stop jail if running
  if (isJailRunning(jailName)) {
    try {
      await stopJail(groupId);
    } catch (error) {
      log(`Warning: could not stop jail during cleanup: ${error.message}`);
    }
  }

  // Remove IP alias if in restricted network mode
  if (JAIL_CONFIG.networkMode === 'restricted' && assignedJailIPs.has(groupId)) {
    try {
      const jailIP = getJailIPAddress(groupId);
      await removeJailIPAlias(jailIP);
    } catch (error) {
      log(`Warning: could not remove IP alias: ${error.message}`);
    }
    releaseJailIP(groupId);
  }

  // Unmount devfs first (required before nullfs unmounts and zfs destroy)
  await sudoExec(['umount', '-f', path.join(jailPath, 'dev')]).catch(() => {});

  // Unmount nullfs mounts
  if (mounts.length > 0) {
    await unmountAll(mounts, jailPath);
  }

  // Destroy ZFS dataset
  if (datasetExists(dataset)) {
    try {
      await sudoExec(['zfs', 'destroy', '-r', dataset]);
      log(`Destroyed dataset`, { dataset });
    } catch (error) {
      log(`Warning: could not destroy dataset: ${error.message}`);
    }
  }

  // Remove fstab file
  if (fs.existsSync(fstabPath)) {
    try {
      fs.unlinkSync(fstabPath);
      log(`Removed fstab`, { fstabPath });
    } catch (error) {
      log(`Warning: could not remove fstab: ${error.message}`);
    }
  }

  log(`Jail cleanup completed`, { jailName });
}

/**
 * Destroy a jail completely (stop + cleanup).
 * @param {string} groupId - The group identifier
 * @param {Array} mounts - Mount specifications
 */
export async function destroyJail(groupId, mounts = []) {
  // cleanupJail handles stopping if needed, unmounting, and ZFS cleanup
  await cleanupJail(groupId, mounts);
}

/** Ensure the jail subsystem is available. */
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

/** Kill orphaned NanoClaw jails from previous runs. */
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

    // Clean up any orphan IP aliases on lo1 (for restricted network mode)
    if (JAIL_CONFIG.networkMode === 'restricted' && orphans.length > 0) {
      try {
        const ifconfigOutput = execFileSync('ifconfig', [JAIL_CONFIG.jailInterface], {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        // Find all IPs in our jail network range (10.99.0.X where X != 1)
        const ipRegex = new RegExp(`inet (${JAIL_CONFIG.jailNetworkPrefix}\\.(\\d+))`, 'g');
        let match;
        while ((match = ipRegex.exec(ifconfigOutput)) !== null) {
          const ip = match[1];
          const lastOctet = parseInt(match[2], 10);
          // Don't remove the gateway IP (x.x.x.1)
          if (lastOctet !== 1) {
            try {
              execFileSync('sudo', ['ifconfig', JAIL_CONFIG.jailInterface, '-alias', ip], {
                stdio: 'pipe',
                timeout: 5000,
              });
              log(`Removed orphan IP alias`, { ip });
            } catch {
              log(`Could not remove orphan IP alias`, { ip });
            }
          }
        }
      } catch {
        // Interface may not exist or no aliases - that's fine
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
 * Clean up all running NanoClaw jails.
 * Called during shutdown to ensure devfs is unmounted and ZFS datasets can be destroyed.
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

  // Step 6: Clean up all jail IP aliases on lo1 (for restricted network mode)
  if (JAIL_CONFIG.networkMode === 'restricted') {
    try {
      const ifconfigOutput = execFileSync('ifconfig', [JAIL_CONFIG.jailInterface], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // Find all IPs in our jail network range (10.99.0.X where X != 1)
      const ipRegex = new RegExp(`inet (${JAIL_CONFIG.jailNetworkPrefix}\\.(\\d+))`, 'g');
      let match;
      while ((match = ipRegex.exec(ifconfigOutput)) !== null) {
        const ip = match[1];
        const lastOctet = parseInt(match[2], 10);
        // Don't remove the gateway IP (x.x.x.1)
        if (lastOctet !== 1) {
          try {
            await sudoExec(['ifconfig', JAIL_CONFIG.jailInterface, '-alias', ip]);
            log(`Removed orphan IP alias`, { ip });
          } catch (err) {
            log(`Failed to remove orphan IP alias`, { ip, error: err.message });
          }
        }
      }
    } catch (err) {
      log(`Failed to clean up IP aliases`, { error: err.message });
    }

    // Clear the in-memory IP assignments
    assignedJailIPs.clear();
  }

  log(`Finished cleaning up all NanoClaw jails`);
}

