import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';

const GROUP_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_FOLDERS = new Set(['global']);

export function isValidGroupFolder(folder: string): boolean {
  if (!folder) return false;
  if (folder !== folder.trim()) return false;
  if (!GROUP_FOLDER_PATTERN.test(folder)) return false;
  if (folder.includes('/') || folder.includes('\\')) return false;
  if (folder.includes('..')) return false;
  if (RESERVED_FOLDERS.has(folder.toLowerCase())) return false;
  return true;
}

export function assertValidGroupFolder(folder: string): void {
  if (!isValidGroupFolder(folder)) {
    throw new Error(`Invalid group folder "${folder}"`);
  }
}

/**
 * Paranoid path validation to prevent path traversal attacks.
 * Ensures that a resolved path is strictly within the base directory.
 *
 * This prevents malicious groupId values from escaping the intended
 * directory structure, which could lead to privilege escalation via:
 * - Writing to host /etc (crontab, passwd, etc.)
 * - Reading sensitive files outside the jail
 * - Mounting arbitrary host paths into the jail
 *
 * @param baseDir - The base directory that must contain the path
 * @param resolvedPath - The fully resolved path to validate
 * @throws Error if the path escapes the base directory
 */
function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  // Paranoid check: path must be within base directory
  // - rel.startsWith('..') means path traverses UP from base
  // - path.isAbsolute(rel) means paths are on different drives (Windows)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `Invalid group folder: path traversal detected (${resolvedPath} escapes ${baseDir})`,
    );
  }
}

export function resolveGroupFolderPath(folder: string): string {
  assertValidGroupFolder(folder);
  const groupPath = path.resolve(GROUPS_DIR, folder);
  ensureWithinBase(GROUPS_DIR, groupPath);
  return groupPath;
}

/**
 * Resolve the IPC directory path for a group with paranoid path validation.
 *
 * Security: This function prevents path traversal attacks by:
 * 1. Validating the folder name against a strict pattern (no /, .., etc.)
 * 2. Resolving to absolute path (eliminates symlinks and relative paths)
 * 3. Verifying the result is strictly within the IPC base directory
 *
 * This prevents malicious groups from mounting host directories (e.g., /etc)
 * into the jail, which could lead to privilege escalation.
 *
 * @param folder - The group folder name (validated against GROUP_FOLDER_PATTERN)
 * @returns The absolute path to the group's IPC directory
 * @throws Error if folder is invalid or path traversal is detected
 */
export function resolveGroupIpcPath(folder: string): string {
  assertValidGroupFolder(folder);
  const ipcBaseDir = path.resolve(DATA_DIR, 'ipc');
  const ipcPath = path.resolve(ipcBaseDir, folder);
  ensureWithinBase(ipcBaseDir, ipcPath);
  return ipcPath;
}
