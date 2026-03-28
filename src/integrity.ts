/**
 * CLAUDE.md Integrity Checking Module
 *
 * Manages known-good hashes for CLAUDE.md files in group directories.
 * Detects modifications made outside agent runs (prompt injection persistence vector)
 * and modifications made during agent runs.
 *
 * Storage: JSON file at ${DATA_DIR}/integrity-hashes.json
 * Design choice: JSON file over SQLite for simplicity and consistency with
 * epairs.json and session-state.json patterns used elsewhere in the codebase.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

/** Result of an integrity check */
export interface IntegrityResult {
  status: 'match' | 'mismatch' | 'new' | 'missing_file';
  expectedHash?: string;
  actualHash?: string;
}

/** Entry in the integrity hash store */
export interface IntegrityEntry {
  hash: string;
  updatedAt: string;
  updatedBy: string;
}

/** The hash store: maps groupFolder -> IntegrityEntry */
type HashStore = Record<string, IntegrityEntry>;

const HASH_FILE = path.join(DATA_DIR, 'integrity-hashes.json');

let hashes: HashStore = {};

/**
 * Load known-good hashes from disk.
 * Safe to call on startup — returns empty store if file doesn't exist.
 */
export function loadHashes(): void {
  try {
    if (!fs.existsSync(HASH_FILE)) {
      hashes = {};
      return;
    }
    const raw = fs.readFileSync(HASH_FILE, 'utf-8');
    hashes = JSON.parse(raw) as HashStore;
    logger.info(
      { count: Object.keys(hashes).length },
      'Integrity hashes loaded',
    );
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (err) {
    logger.warn({ err }, 'Failed to load integrity hashes, starting fresh');
    hashes = {};
  }
}

/**
 * Persist hashes to disk using atomic write pattern.
 * Writes to .tmp file, sets permissions to 0o600, then renames.
 */
export function saveHashes(): void {
  try {
    fs.mkdirSync(path.dirname(HASH_FILE), { recursive: true });
    const tempFile = `${HASH_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(hashes, null, 2));
    fs.chmodSync(tempFile, 0o600);
    fs.renameSync(tempFile, HASH_FILE);
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (err) {
    logger.warn({ err }, 'Failed to save integrity hashes');
  }
}

/**
 * Get the expected (known-good) hash for a group's CLAUDE.md.
 */
export function getExpectedHash(groupFolder: string): string | null {
  return hashes[groupFolder]?.hash ?? null;
}

/**
 * Set the expected hash for a group's CLAUDE.md.
 * Call this when the operator approves a CLAUDE.md change.
 */
export function setExpectedHash(
  groupFolder: string,
  hash: string,
  updatedBy: string,
): void {
  hashes[groupFolder] = {
    hash,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };
  saveHashes();
}

/**
 * Check a CLAUDE.md file's current hash against the stored baseline.
 *
 * Returns:
 * - 'match': currentHash matches stored baseline
 * - 'mismatch': currentHash differs from stored baseline
 * - 'new': no baseline exists for this group (first time seen)
 * - 'missing_file': currentHash is null (file does not exist)
 */
export function checkIntegrity(
  groupFolder: string,
  currentHash: string | null,
): IntegrityResult {
  if (currentHash === null) {
    return { status: 'missing_file' };
  }

  const expected = getExpectedHash(groupFolder);

  if (expected === null) {
    return { status: 'new', actualHash: currentHash };
  }

  if (expected === currentHash) {
    return { status: 'match', expectedHash: expected, actualHash: currentHash };
  }

  return {
    status: 'mismatch',
    expectedHash: expected,
    actualHash: currentHash,
  };
}

/**
 * Module-level alert callback registration.
 * Avoids changing runContainerAgent() signature (upstream compatibility).
 */
let integrityAlertFn: ((msg: string) => Promise<void>) | null = null;

/** Register an alert function for integrity violations. */
export function setIntegrityAlertFn(
  fn: ((msg: string) => Promise<void>) | null,
): void {
  integrityAlertFn = fn;
}

/** Get the current alert function (for use in container-runner). */
export function getIntegrityAlertFn(): ((msg: string) => Promise<void>) | null {
  return integrityAlertFn;
}
