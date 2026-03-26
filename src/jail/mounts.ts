/**
 * Jail mount validation, building, and nullfs operations.
 */
import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';
import { getSudoExec } from './sudo.js';
import { JAIL_MOUNT_LAYOUT } from './config.js';
import type { JailMount, JailMountPaths } from './types.js';

/**
 * Validate jail mount paths for security issues.
 * Defense-in-depth: validates even if upstream validation should have occurred.
 */
function validateJailMount(mount: JailMount): void {
  if (!path.isAbsolute(mount.hostPath)) {
    throw new Error(
      `Security: jail mount hostPath must be absolute: "${mount.hostPath}"`,
    );
  }

  if (mount.hostPath.split(path.sep).includes('..')) {
    throw new Error(
      `Security: jail mount hostPath contains path traversal: "${mount.hostPath}"`,
    );
  }

  try {
    const realHostPath = fs.realpathSync(mount.hostPath);
    mount.hostPath = realHostPath;
  } catch (err) {
    throw new Error(
      `Security: jail mount hostPath does not exist: "${mount.hostPath}"`,
    );
  }

  if (!path.isAbsolute(mount.jailPath)) {
    throw new Error(
      `Security: jail mount jailPath must be absolute: "${mount.jailPath}"`,
    );
  }

  if (mount.jailPath.split(path.sep).includes('..')) {
    throw new Error(
      `Security: jail mount jailPath contains path traversal: "${mount.jailPath}"`,
    );
  }

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

/** Build mount specs from semantic paths. */
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

  // Global memory directory (read-only for non-main groups)
  if (paths.globalPath) {
    mounts.push({
      hostPath: paths.globalPath,
      jailPath: JAIL_MOUNT_LAYOUT.global,
      readonly: true,
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

  if (paths.additionalMounts) {
    for (const mount of paths.additionalMounts) {
      const jailMount: JailMount = {
        hostPath: mount.hostPath,
        jailPath: mount.jailPath,
        readonly: mount.readonly,
      };
      validateJailMount(jailMount);
      mounts.push(jailMount);
    }
  }

  return mounts;
}

/**
 * Ensure host-side directories exist for writable mounts.
 * Sets mode 2775 (setgid) and group wheel (gid 0) for shared host/jail access.
 */
export function ensureHostDirectories(paths: JailMountPaths): void {
  const dirsToCreate = [
    paths.groupPath,
    paths.ipcPath,
    paths.claudeSessionPath,
  ];

  const uid = process.getuid?.() ?? 0;
  const wheelGid = 0;

  for (const dir of dirsToCreate) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      logger.debug({ dir }, 'Created host directory');
    }
    try {
      fs.chmodSync(dir, 0o2775);
      fs.chownSync(dir, uid, wheelGid);
    } catch (err) {
      logger.warn({ dir, err }, 'Could not set permissions on directory');
    }
  }

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
export function buildFstab(mounts: JailMount[], jailPath: string): string {
  const lines: string[] = [];
  for (const mount of mounts) {
    const targetPath = path.join(jailPath, mount.jailPath);
    const opts = mount.readonly ? 'ro' : 'rw';
    lines.push(`${mount.hostPath}\t${targetPath}\tnullfs\t${opts}\t0\t0`);
  }
  return lines.join('\n') + '\n';
}

/** Validate that a mount target is within the jail root (no escapes or traversal). */
function assertMountWithinJail(jailPath: string, mount: JailMount): string {
  const resolvedJailRoot = path.resolve(jailPath);
  const relativeMountPath = mount.jailPath.replace(/^\//, '');
  const targetPath = path.resolve(jailPath, relativeMountPath);

  if (
    !targetPath.startsWith(resolvedJailRoot + path.sep) &&
    targetPath !== resolvedJailRoot
  ) {
    throw new Error(`Mount target escapes jail root: ${mount.jailPath}`);
  }

  if (mount.jailPath.includes('..')) {
    throw new Error(`Mount path contains path traversal: ${mount.jailPath}`);
  }

  return targetPath;
}

/** Create mount point directories inside the jail */
export async function createMountPoints(
  mounts: JailMount[],
  jailPath: string,
): Promise<void> {
  const sudoExec = getSudoExec();

  for (const mount of mounts) {
    const targetPath = assertMountWithinJail(jailPath, mount);
    await sudoExec(['mkdir', '-p', targetPath]);
  }
}

/** Mount all nullfs mounts for a jail */
export async function mountNullfs(
  mounts: JailMount[],
  jailPath: string,
): Promise<void> {
  const sudoExec = getSudoExec();

  for (const mount of mounts) {
    const targetPath = assertMountWithinJail(jailPath, mount);
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
export async function unmountAll(
  mounts: JailMount[],
  jailPath: string,
): Promise<void> {
  const sudoExec = getSudoExec();
  const errors: string[] = [];

  for (let i = mounts.length - 1; i >= 0; i--) {
    const mount = mounts[i];
    const targetPath = path.join(jailPath, mount.jailPath);
    try {
      await sudoExec(['umount', targetPath]);
      logger.debug({ targetPath }, 'Unmounted nullfs');
    } catch (error) {
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
