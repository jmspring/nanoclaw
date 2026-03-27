import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER']);

/** Clamp a parsed integer to [min, max], falling back to defaultVal on NaN */
function clampInt(
  raw: string | undefined,
  defaultVal: number,
  min: number,
  max: number,
): number {
  const parsed = parseInt(raw || String(defaultVal), 10);
  return Math.min(max, Math.max(min, isNaN(parsed) ? defaultVal : parsed));
}

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
export const CONTAINER_TIMEOUT = clampInt(
  process.env.CONTAINER_TIMEOUT,
  1800000,
  60000,
  7200000,
); // 30min default, min 1min, max 2hr
export const CONTAINER_MAX_OUTPUT_SIZE = clampInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE,
  10485760,
  1048576,
  104857600,
); // 10MB default, min 1MB, max 100MB
export const CREDENTIAL_PROXY_PORT = clampInt(
  process.env.CREDENTIAL_PROXY_PORT,
  3001,
  1024,
  65535,
);
export const ONECLI_URL = process.env.ONECLI_URL || 'http://localhost:10254';
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = clampInt(
  process.env.IDLE_TIMEOUT,
  1800000,
  60000,
  7200000,
); // 30min default, min 1min, max 2hr
export const MAX_CONCURRENT_CONTAINERS = clampInt(
  process.env.MAX_CONCURRENT_CONTAINERS,
  5,
  1,
  50,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build a trigger RegExp from an assistant/bot name. */
export function buildTriggerPattern(name: string): RegExp {
  return new RegExp(`^@${escapeRegex(name)}\\b`, 'i');
}

export const TRIGGER_PATTERN = buildTriggerPattern(ASSISTANT_NAME);

/** Check whether a timezone string is a valid IANA timezone. */
function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return false;
  }
}

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default; falls back to UTC for invalid POSIX-style TZ values
const rawTZ =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
export const TIMEZONE = isValidTimezone(rawTZ) ? rawTZ : 'UTC';

// Health and metrics configuration
export const HEALTH_ENABLED = (process.env.HEALTH_ENABLED || 'true') === 'true'; // Always on by default
export const METRICS_ENABLED =
  (process.env.METRICS_ENABLED || 'false') === 'true'; // Opt-in
export const METRICS_PORT = clampInt(
  process.env.METRICS_PORT,
  9090,
  1024,
  65535,
);

// Log rotation configuration for jail/container logs
export const LOG_ROTATION_SIZE = process.env.LOG_ROTATION_SIZE || '10M'; // Rotate when file reaches this size
export const LOG_ROTATION_MAX_FILES = clampInt(
  process.env.LOG_ROTATION_MAX_FILES,
  5,
  1,
  100,
);
export const LOG_ROTATION_COMPRESS =
  (process.env.LOG_ROTATION_COMPRESS || 'true') === 'true'; // Compress rotated files
export const LOG_RETENTION_DAYS = clampInt(
  process.env.LOG_RETENTION_DAYS,
  30,
  1,
  365,
);
