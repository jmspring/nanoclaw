/**
 * FreeBSD Jail runtime for NanoClaw.
 * Replaces Docker/Apple Container runtime with native FreeBSD jails.
 *
 * Module structure:
 *   types.ts    — Interfaces and type definitions
 *   config.ts   — JAIL_CONFIG, constants, mount layout
 *   sudo.ts     — Sudo execution helpers with DI for testing
 *   network.ts  — Epair management, pf validation, DNS
 *   mounts.ts   — Mount validation, building, nullfs operations
 *   lifecycle.ts — Create, exec, spawn, stop, destroy
 *   cleanup.ts  — Orphan handling, audit logging, full cleanup
 */

// Types
export type {
  JailMount,
  JailMountPaths,
  JailCreationResult,
  ExecResult,
  ExecInJailOptions,
  SpawnInJailOptions,
  EpairInfo,
  ResourceLimits,
  JailConfig,
  SudoExecResult,
  SudoExecOptions,
  SudoExecutor,
  SudoExecutorSync,
  JailRuntimeDeps,
} from './types.js';

// Config
export { JAIL_CONFIG, JAIL_MOUNT_LAYOUT, MAX_CONCURRENT_JAILS } from './config.js';

// Sudo / DI
export { setJailRuntimeDeps, resetJailRuntimeDeps } from './sudo.js';

// Network
export {
  restoreEpairState,
  validatePfConfiguration,
  getEpairMetrics,
  cleanupHostTempFiles,
} from './network.js';

// Mounts
export { buildJailMounts, ensureHostDirectories } from './mounts.js';

// Lifecycle
export {
  sanitizeJailName,
  getJailName,
  getJailPath,
  isJailRunning,
  isJailRunningAsync,
  datasetExists,
  getJailToken,
  trackJailTempFile,
  createJailWithPaths,
  createJail,
  execInJail,
  spawnInJail,
  stopJail,
  cleanupJail,
  destroyJail,
  getActiveJailCount,
  getJailCapacity,
  isAtJailCapacity,
  trackActiveJail,
  removeRctlLimits,
} from './lifecycle.js';

// Cleanup
export {
  logCleanupAudit,
  retryWithBackoff,
  listRunningNanoclawJails,
  cleanupOrphans,
  cleanupAllJails,
  ensureJailRuntimeRunning,
} from './cleanup.js';

// Runner
export { runJailAgent } from './runner.js';
