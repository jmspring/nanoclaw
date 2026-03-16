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
  networkMode: 'inherit',
};

/** The jail command binary. */
export const JAIL_RUNTIME_BIN = 'jail';

/** Hostname jails use to reach the host machine. */
export const JAIL_HOST_GATEWAY = 'localhost';

/**
 * Address the credential proxy binds to.
 * FreeBSD jails with network inheritance see host's loopback.
 */
export const PROXY_BIND_HOST = process.env.CREDENTIAL_PROXY_HOST || '127.0.0.1';

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

/** CLI args needed for the jail to resolve the host gateway (not needed with inherit) */
export function hostGatewayArgs() {
  // With network inheritance, jails can reach localhost directly
  return [];
}

/** Returns mount specification for a readonly nullfs mount */
export function readonlyMountSpec(hostPath, jailPath) {
  return { hostPath, jailPath, readonly: true };
}

/** Returns mount specification for a read-write nullfs mount */
export function writableMountSpec(hostPath, jailPath) {
  return { hostPath, jailPath, readonly: false };
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
 * @param {Object} paths - Semantic mount paths
 */
export function ensureHostDirectories(paths) {
  const dirsToCreate = [
    paths.groupPath,
    paths.ipcPath,
    paths.claudeSessionPath,
  ].filter(Boolean);

  for (const dir of dirsToCreate) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      log(`Created host directory`, { dir });
    }
  }

  // Also create IPC subdirectories
  if (paths.ipcPath) {
    for (const subdir of ['messages', 'tasks', 'input']) {
      const subdirPath = path.join(paths.ipcPath, subdir);
      if (!fs.existsSync(subdirPath)) {
        fs.mkdirSync(subdirPath, { recursive: true });
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

    // Create empty .claude.json for Claude Code (required before running as non-root)
    await sudoExec(['sh', '-c', `echo '{}' > ${jailPath}/home/node/.claude.json`]);
    await sudoExec(['chmod', '644', `${jailPath}/home/node/.claude.json`]);

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
    }

    // Allow certain sysctls for compatibility
    jailParams.push(
      'allow.raw_sockets',
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
    const args = ['jexec'];

    // FreeBSD jexec supports -d for working directory
    if (cwd) {
      args.push('-d', cwd);
    }

    args.push(jailName);

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

  const args = ['jexec', '-u', 'node'];

  // FreeBSD jexec supports -d for working directory
  if (cwd) {
    args.push('-d', cwd);
  }

  args.push(jailName);

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
 * Clean up jail resources (unmount, destroy dataset, remove fstab).
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

  // Unmount devfs first (required before nullfs unmounts and zfs destroy)
  await sudoExec(['umount', jailPath + '/dev']).catch(() => {});

  // Unmount nullfs mounts
  if (mounts.length > 0) {
    await unmountAll(mounts, jailPath);
  } else {
    // Try to unmount any remaining mounts by parsing fstab or using mount output
    try {
      const mountOutput = execFileSync('mount', ['-t', 'nullfs'], { encoding: 'utf-8' });
      const jailMounts = mountOutput.split('\n')
        .filter(line => line.includes(jailPath))
        .map(line => {
          const match = line.match(/on (.+?) \(/);
          return match ? match[1] : null;
        })
        .filter(Boolean)
        .reverse();

      for (const mountPoint of jailMounts) {
        try {
          await sudoExec(['umount', '-f', mountPoint]);
          log(`Unmounted ${mountPoint}`);
        } catch (error) {
          log(`Warning: could not unmount ${mountPoint}: ${error.message}`);
        }
      }
    } catch (error) {
      log(`Warning: could not check for remaining mounts: ${error.message}`);
    }
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
  const jailName = getJailName(groupId);
  log(`Destroying jail`, { jailName });

  await stopJail(groupId);
  await cleanupJail(groupId, mounts);

  log(`Jail destroyed`, { jailName });
}

/** Returns the command to stop a jail by name. */
export function stopJailCommand(jailName) {
  return `sudo jail -r ${jailName}`;
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

    if (orphans.length > 0) {
      log(`Cleaned up orphaned jails`, { count: orphans.length, names: orphans });
    }
  } catch (err) {
    log(`Failed to clean up orphaned jails`, { error: err.message });
  }
}

/**
 * Full jail lifecycle: create, run command, capture output, destroy.
 * This is the primary entry point for running agent commands in jails.
 * @param {string} groupId - The group identifier
 * @param {Array} mounts - Mount specifications
 * @param {string[]} command - Command to execute
 * @param {Object} options - Execution options
 * @param {Object} options.env - Environment variables
 * @param {string} options.cwd - Working directory inside jail
 * @param {Function} options.onStdout - Callback for stdout data
 * @param {Function} options.onStderr - Callback for stderr data
 * @param {number} options.timeout - Timeout in milliseconds
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
export async function runInJail(groupId, mounts, command, options = {}) {
  try {
    await createJail(groupId, mounts);
    const result = await execInJail(groupId, command, options);
    return result;
  } finally {
    await destroyJail(groupId, mounts);
  }
}

// Compatibility exports matching container-runtime.ts interface
export const CONTAINER_RUNTIME_BIN = JAIL_RUNTIME_BIN;
export const CONTAINER_HOST_GATEWAY = JAIL_HOST_GATEWAY;
export const readonlyMountArgs = (hostPath, jailPath) => readonlyMountSpec(hostPath, jailPath);
export const stopContainer = stopJailCommand;
export const ensureContainerRuntimeRunning = ensureJailRuntimeRunning;

export default {
  JAIL_CONFIG,
  JAIL_RUNTIME_BIN,
  JAIL_HOST_GATEWAY,
  PROXY_BIND_HOST,
  JAIL_MOUNT_LAYOUT,
  sanitizeJailName,
  getJailName,
  isJailRunning,
  hostGatewayArgs,
  readonlyMountSpec,
  writableMountSpec,
  buildJailMounts,
  ensureHostDirectories,
  createJailWithPaths,
  createJail,
  execInJail,
  spawnInJail,
  stopJail,
  cleanupJail,
  destroyJail,
  stopJailCommand,
  ensureJailRuntimeRunning,
  cleanupOrphans,
  runInJail,
  // Compatibility
  CONTAINER_RUNTIME_BIN: JAIL_RUNTIME_BIN,
  CONTAINER_HOST_GATEWAY: JAIL_HOST_GATEWAY,
  readonlyMountArgs: readonlyMountSpec,
  stopContainer: stopJailCommand,
  ensureContainerRuntimeRunning: ensureJailRuntimeRunning,
};
