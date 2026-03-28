/**
 * ZFS snapshot management for jail datasets.
 * Provides snapshot, rollback, and retention for jail workspaces.
 */
import { execFileSync } from 'child_process';
import { logger } from '../logger.js';
import { JAIL_CONFIG } from './config.js';
import { getJailName, isJailRunning } from './lifecycle.js';
import { getSudoExec } from './sudo.js';
import type { SnapshotInfo } from './types.js';

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

/** Maximum number of snapshots to retain per jail */
export const SNAPSHOT_RETENTION = clampInt(
  process.env.NANOCLAW_SNAPSHOT_RETENTION,
  3,
  1,
  50,
);

/** Get the ZFS dataset path for a group's jail */
function getGroupDataset(groupId: string): string {
  const jailName = getJailName(groupId);
  return `${JAIL_CONFIG.jailsDataset}/${jailName}`;
}

/** Generate a compact ISO timestamp */
function compactTimestamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/**
 * Create a ZFS snapshot of a jail's dataset.
 * @param groupId - Group identifier
 * @param label - Snapshot label (default: 'pre-agent')
 * @returns Full snapshot name (dataset@snapName)
 */
export async function createSnapshot(
  groupId: string,
  label: string = 'pre-agent',
): Promise<string> {
  const sudoExec = getSudoExec();
  const jailName = getJailName(groupId);
  const dataset = getGroupDataset(groupId);
  const snapName = `nc-${compactTimestamp()}-${label}`;
  const fullName = `${dataset}@${snapName}`;

  await sudoExec(['zfs', 'snapshot', fullName]);
  logger.info(
    { groupId, jailName, snapshot: fullName },
    'ZFS snapshot created',
  );
  return fullName;
}

/**
 * List ZFS snapshots for a jail's dataset.
 * @param groupId - Group identifier
 * @returns Array of snapshot info, filtered to nc-* snapshots only
 */
export async function listSnapshots(groupId: string): Promise<SnapshotInfo[]> {
  const dataset = getGroupDataset(groupId);

  try {
    const output = execFileSync(
      'zfs',
      [
        'list',
        '-t',
        'snapshot',
        '-H',
        '-o',
        'name,creation,used',
        '-s',
        'creation',
        dataset,
      ],
      { encoding: 'utf-8', stdio: 'pipe', timeout: 10000 },
    );

    return output
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const parts = line.split('\t');
        return {
          name: parts[0] || '',
          creation: parts[1] || '',
          used: parts[2] || '',
        };
      })
      .filter((snap) => snap.name.includes('@nc-'));
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return [];
  }
}

/**
 * Roll back a jail dataset to a specific snapshot.
 * The jail MUST be stopped before rollback.
 * @param groupId - Group identifier
 * @param snapshotName - Full snapshot name (dataset@snapName)
 */
export async function rollbackToSnapshot(
  groupId: string,
  snapshotName: string,
): Promise<void> {
  const sudoExec = getSudoExec();
  const dataset = getGroupDataset(groupId);
  const jailName = getJailName(groupId);

  // Validate snapshot belongs to the correct dataset
  if (!snapshotName.startsWith(dataset + '@')) {
    throw new Error(
      `Snapshot "${snapshotName}" does not belong to dataset "${dataset}"`,
    );
  }

  // Ensure jail is not running
  if (isJailRunning(jailName)) {
    throw new Error(
      `Cannot rollback: jail "${jailName}" is still running. Stop it first.`,
    );
  }

  await sudoExec(['zfs', 'rollback', '-r', snapshotName]);
  logger.info(
    { groupId, jailName, snapshot: snapshotName },
    'ZFS rollback completed',
  );
}

/**
 * Enforce snapshot retention policy by destroying oldest snapshots.
 * @param groupId - Group identifier
 * @param maxSnapshots - Maximum snapshots to keep (default: SNAPSHOT_RETENTION)
 * @returns Number of snapshots destroyed
 */
export async function enforceRetentionPolicy(
  groupId: string,
  maxSnapshots: number = SNAPSHOT_RETENTION,
): Promise<number> {
  const sudoExec = getSudoExec();
  const snapshots = await listSnapshots(groupId);

  if (snapshots.length <= maxSnapshots) {
    return 0;
  }

  const toDestroy = snapshots.slice(0, snapshots.length - maxSnapshots);
  let destroyed = 0;

  for (const snap of toDestroy) {
    try {
      await sudoExec(['zfs', 'destroy', snap.name]);
      destroyed++;
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch (err) {
      logger.warn(
        { snapshot: snap.name, err },
        'Failed to destroy snapshot during retention cleanup',
      );
    }
  }

  if (destroyed > 0) {
    logger.info(
      { groupId, destroyed, remaining: snapshots.length - destroyed },
      'Snapshot retention enforced',
    );
  }

  return destroyed;
}

/**
 * Destroy all nc-* snapshots for a group's dataset.
 * Called during jail cleanup to avoid "dataset has children" errors.
 * @param groupId - Group identifier
 */
export async function destroyAllSnapshots(groupId: string): Promise<void> {
  const sudoExec = getSudoExec();
  const snapshots = await listSnapshots(groupId);

  for (const snap of snapshots) {
    try {
      await sudoExec(['zfs', 'destroy', snap.name]);
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch (err) {
      logger.warn(
        { snapshot: snap.name, err },
        'Failed to destroy snapshot during cleanup',
      );
    }
  }

  if (snapshots.length > 0) {
    logger.info(
      { groupId, count: snapshots.length },
      'Destroyed all nc-* snapshots',
    );
  }
}
