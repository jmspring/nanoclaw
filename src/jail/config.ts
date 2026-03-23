/**
 * Jail configuration and constants.
 */
import path from 'path';
import { logger } from '../logger.js';
import type { JailConfig } from './types.js';

/** Root path for NanoClaw data — override via NANOCLAW_ROOT env var */
const NANOCLAW_ROOT = process.env.NANOCLAW_ROOT || process.cwd();

/** Jail configuration — paths derived from NANOCLAW_ROOT with per-path overrides */
export const JAIL_CONFIG: JailConfig = {
  templateDataset: process.env.NANOCLAW_TEMPLATE_DATASET || 'zroot/nanoclaw/jails/template',
  templateSnapshot: process.env.NANOCLAW_TEMPLATE_SNAPSHOT || 'base',
  jailsDataset: process.env.NANOCLAW_JAILS_DATASET || 'zroot/nanoclaw/jails',
  jailsPath: process.env.NANOCLAW_JAILS_PATH || path.join(NANOCLAW_ROOT, 'jails'),
  workspacesPath: process.env.NANOCLAW_WORKSPACES_PATH || path.join(NANOCLAW_ROOT, 'workspaces'),
  ipcPath: process.env.NANOCLAW_IPC_PATH || path.join(NANOCLAW_ROOT, 'ipc'),
  networkMode:
    (process.env.NANOCLAW_JAIL_NETWORK_MODE as 'inherit' | 'restricted') ||
    'restricted',
  jailHostIP: '10.99.0.1',
  jailIP: '10.99.0.2',
  jailNetmask: '30',
  resourceLimits: {
    memoryuse: process.env.NANOCLAW_JAIL_MEMORY_LIMIT || '2G',
    maxproc: process.env.NANOCLAW_JAIL_MAXPROC || '100',
    pcpu: process.env.NANOCLAW_JAIL_PCPU || '80',
  },
};

// Warn if running with unrestricted network access
if (JAIL_CONFIG.networkMode === 'inherit') {
  logger.warn(
    'Running with ip4=inherit — jails have full host network access. Set NANOCLAW_JAIL_NETWORK_MODE=restricted for production use.',
  );
}

/** Maximum number of epairs allowed (configurable via env var, clamped 1-255) */
export const MAX_EPAIRS = Math.min(255, Math.max(1,
  parseInt(process.env.NANOCLAW_MAX_EPAIRS || '200', 10) || 200,
));

/** Epair warning threshold (percentage) */
export const EPAIR_WARNING_THRESHOLD = 0.8;

/** Maximum concurrent jails (configurable via env var, clamped 1-100) */
export const MAX_CONCURRENT_JAILS = Math.min(100, Math.max(1,
  parseInt(process.env.NANOCLAW_MAX_JAILS || '50', 10) || 50,
));

/** Jail-native mount layout paths */
export const JAIL_MOUNT_LAYOUT = {
  project: '/workspace/project',
  group: '/workspace/group',
  ipc: '/workspace/ipc',
  claudeSession: '/home/node/.claude',
  agentRunner: '/app/src',
};
