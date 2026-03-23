import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER']);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Health and metrics configuration
export const HEALTH_ENABLED =
  (process.env.HEALTH_ENABLED || 'true') === 'true'; // Always on by default
export const METRICS_ENABLED =
  (process.env.METRICS_ENABLED || 'false') === 'true'; // Opt-in
export const METRICS_PORT = parseInt(process.env.METRICS_PORT || '9090', 10);

// Log rotation configuration for jail/container logs
export const LOG_ROTATION_SIZE = process.env.LOG_ROTATION_SIZE || '10M'; // Rotate when file reaches this size
export const LOG_ROTATION_MAX_FILES = parseInt(
  process.env.LOG_ROTATION_MAX_FILES || '5',
  10,
); // Keep this many rotated files
export const LOG_ROTATION_COMPRESS =
  (process.env.LOG_ROTATION_COMPRESS || 'true') === 'true'; // Compress rotated files
export const LOG_RETENTION_DAYS = parseInt(
  process.env.LOG_RETENTION_DAYS || '30',
  10,
); // Delete logs older than this many days

// Jail runtime timeout configuration (in milliseconds)
export const JAIL_EXEC_TIMEOUT = parseInt(
  process.env.JAIL_EXEC_TIMEOUT || '30000',
  10,
); // Default timeout for sudo exec operations (30s)
export const JAIL_CREATE_TIMEOUT = parseInt(
  process.env.JAIL_CREATE_TIMEOUT || '30000',
  10,
); // Timeout for ZFS operations during jail creation (30s)
export const JAIL_STOP_TIMEOUT = parseInt(
  process.env.JAIL_STOP_TIMEOUT || '15000',
  10,
); // Timeout for graceful jail stop (15s)
export const JAIL_FORCE_STOP_TIMEOUT = parseInt(
  process.env.JAIL_FORCE_STOP_TIMEOUT || '10000',
  10,
); // Timeout for force jail stop (10s)
export const JAIL_QUICK_OP_TIMEOUT = parseInt(
  process.env.JAIL_QUICK_OP_TIMEOUT || '5000',
  10,
); // Timeout for quick operations like unmount, destroy epair (5s)
