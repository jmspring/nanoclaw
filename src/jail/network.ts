/**
 * Jail networking: epair management, pf validation, DNS setup.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { logger } from '../logger.js';
import { DATA_DIR } from '../config.js';
import { JAIL_QUICK_OP_TIMEOUT } from './config.js';
import { getSudoExec, getSudoExecSync } from './sudo.js';
import { JAIL_CONFIG, MAX_EPAIRS, EPAIR_WARNING_THRESHOLD } from './config.js';
import type { EpairInfo } from './types.js';

/** Track assigned epair numbers for cleanup */
const assignedEpairs = new Map<string, number>();

/** Path to persistent epair state file */
const EPAIR_STATE_FILE = path.join(DATA_DIR, 'epairs.json');

/**
 * Persist epair state to disk for crash recovery.
 */
function persistEpairState(): void {
  try {
    const stateDir = path.dirname(EPAIR_STATE_FILE);
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o755 });
    }
    const state = Object.fromEntries(assignedEpairs);
    fs.writeFileSync(EPAIR_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (error) {
    logger.warn(
      { err: error, file: EPAIR_STATE_FILE },
      'Failed to persist epair state',
    );
  }
}

/**
 * Restore epair state from disk and sync with actual system state.
 */
export function restoreEpairState(): void {
  if (fs.existsSync(EPAIR_STATE_FILE)) {
    try {
      const data = fs.readFileSync(EPAIR_STATE_FILE, 'utf-8');
      const state = JSON.parse(data) as Record<string, number>;
      for (const [groupId, epairNum] of Object.entries(state)) {
        assignedEpairs.set(groupId, epairNum);
      }
      logger.info(
        { count: assignedEpairs.size, file: EPAIR_STATE_FILE },
        'Restored epair state from disk',
      );
    } catch (error) {
      logger.warn(
        { err: error, file: EPAIR_STATE_FILE },
        'Failed to restore epair state',
      );
    }
  }

  // Verify state against actual system interfaces
  try {
    const ifconfigOutput = execFileSync('ifconfig', ['-l'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const interfaces = ifconfigOutput.trim().split(/\s+/);
    const existingEpairs = new Set<number>();
    const epairRegex = /^epair(\d+)a$/;

    for (const iface of interfaces) {
      const match = iface.match(epairRegex);
      if (match) {
        existingEpairs.add(parseInt(match[1], 10));
      }
    }

    for (const [groupId, epairNum] of assignedEpairs.entries()) {
      if (!existingEpairs.has(epairNum)) {
        logger.info(
          { epairNum, groupId },
          'Epair no longer exists, removing from state',
        );
        assignedEpairs.delete(groupId);
      }
    }

    persistEpairState();
    logger.debug(
      { tracked: assignedEpairs.size, existing: existingEpairs.size },
      'Synced epair state with system',
    );
  } catch (error) {
    logger.warn({ err: error }, 'Failed to sync epair state with system');
  }
}

/**
 * Create an epair interface pair for a vnet jail.
 */
export async function createEpair(groupId: string): Promise<EpairInfo> {
  const sudoExec = getSudoExec();
  const currentCount = assignedEpairs.size;

  if (currentCount >= MAX_EPAIRS) {
    throw new Error(
      `Epair pool exhausted (${currentCount}/${MAX_EPAIRS}). Wait for jails to complete.`,
    );
  }

  if (currentCount >= MAX_EPAIRS * EPAIR_WARNING_THRESHOLD) {
    logger.warn(
      {
        current: currentCount,
        max: MAX_EPAIRS,
        threshold: Math.floor(MAX_EPAIRS * EPAIR_WARNING_THRESHOLD),
      },
      'Approaching epair pool limit',
    );
  }

  const result = await sudoExec(['ifconfig', 'epair', 'create']);
  const epairName = result.stdout.trim();

  const match = epairName.match(/epair(\d+)a/);
  if (!match) {
    throw new Error(`Unexpected epair name format: ${epairName}`);
  }
  const epairNum = parseInt(match[1], 10);

  if (epairNum < 0 || epairNum > 255) {
    throw new Error(
      `Epair number ${epairNum} exceeds /24 pool capacity (0-255)`,
    );
  }

  const hostIface = `epair${epairNum}a`;
  const jailIface = `epair${epairNum}b`;
  const hostIP = `${JAIL_CONFIG.jailSubnet}.${epairNum}.1`;
  const jailIP = `${JAIL_CONFIG.jailSubnet}.${epairNum}.2`;
  const netmask = '30';

  await sudoExec(['ifconfig', hostIface, `${hostIP}/${netmask}`, 'up']);

  assignedEpairs.set(groupId, epairNum);
  persistEpairState();

  logger.info(
    { groupId, epairNum, hostIface, jailIface, hostIP, jailIP },
    'Created epair',
  );
  return { epairNum, hostIface, jailIface, hostIP, jailIP, netmask };
}

/**
 * Configure networking inside a vnet jail after it starts.
 */
export async function configureJailNetwork(
  jailName: string,
  epairInfo: EpairInfo,
): Promise<void> {
  const sudoExec = getSudoExec();
  await sudoExec([
    'jexec', jailName, 'ifconfig',
    epairInfo.jailIface, `${epairInfo.jailIP}/${epairInfo.netmask}`, 'up',
  ]);
  await sudoExec([
    'jexec', jailName, 'route', 'add', 'default', epairInfo.hostIP,
  ]);
  logger.info(
    {
      jailName,
      jailIface: epairInfo.jailIface,
      ip: epairInfo.jailIP,
      gateway: epairInfo.hostIP,
    },
    'Configured jail network',
  );
}

/**
 * Destroy an epair interface pair.
 */
export async function destroyEpair(epairNum: number): Promise<void> {
  const sudoExec = getSudoExec();
  const hostIface = `epair${epairNum}a`;
  try {
    await sudoExec(['ifconfig', hostIface, 'destroy']);
    logger.debug({ epairNum, hostIface }, 'Destroyed epair');
  } catch (error) {
    logger.warn({ epairNum, hostIface, err: error }, 'Could not destroy epair');
  }
}

/**
 * Release a jail's assigned epair and destroy it.
 */
export async function releaseEpair(groupId: string): Promise<void> {
  const epairNum = assignedEpairs.get(groupId);
  if (epairNum !== undefined) {
    await destroyEpair(epairNum);
    assignedEpairs.delete(groupId);
    persistEpairState();
  }
}

/**
 * Setup resolv.conf in the jail for DNS resolution.
 */
export async function setupJailResolv(jailPath: string): Promise<void> {
  const sudoExec = getSudoExec();
  const resolvPath = path.join(jailPath, 'etc', 'resolv.conf');

  try {
    const hostResolv = fs.readFileSync('/etc/resolv.conf', 'utf-8');
    const tmpFile = path.join('/tmp', `nanoclaw-resolv-${crypto.randomUUID()}`);
    fs.writeFileSync(tmpFile, hostResolv);
    try {
      await sudoExec(['cp', tmpFile, resolvPath]);
    } finally {
      fs.unlinkSync(tmpFile);
    }
    logger.debug({ jailPath, resolvPath }, 'Copied host resolv.conf to jail');
  } catch (error) {
    logger.warn(
      { jailPath, resolvPath, err: error },
      'Could not create jail resolv.conf',
    );
  }
}

/**
 * Validate that pf configuration matches the current network mode.
 */
export function validatePfConfiguration(): void {
  if (JAIL_CONFIG.networkMode !== 'restricted') {
    return;
  }

  try {
    const pfInfo = execFileSync('sudo', ['pfctl', '-s', 'info'], {
      stdio: 'pipe',
      timeout: 5000,
      encoding: 'utf-8',
    });

    if (!pfInfo.includes('Status: Enabled')) {
      throw new Error(
        'NETWORK MODE MISMATCH: Network mode is "restricted" but pf is not enabled.\n' +
          'To fix this issue:\n' +
          '  1. Run the migration script: scripts/switch-network-mode.sh restricted\n' +
          '  2. Or manually enable pf: sudo pfctl -e\n' +
          '  3. Or switch to "inherit" mode: export NANOCLAW_JAIL_NETWORK_MODE=inherit',
      );
    }

    const natRules = execFileSync('sudo', ['pfctl', '-s', 'nat'], {
      stdio: 'pipe',
      timeout: 5000,
      encoding: 'utf-8',
    });

    if (!natRules.includes(`${JAIL_CONFIG.jailSubnet}.`)) {
      throw new Error(
        'NETWORK MODE MISMATCH: Network mode is "restricted" but pf NAT rules for jail network not found.\n' +
          'To fix this issue:\n' +
          '  1. Run the migration script: scripts/switch-network-mode.sh restricted\n' +
          '  2. Or manually load pf config: sudo pfctl -f etc/pf-nanoclaw.conf\n' +
          '  3. Or switch to "inherit" mode: export NANOCLAW_JAIL_NETWORK_MODE=inherit',
      );
    }

    logger.info('PF configuration validated for restricted network mode');
  } catch (err) {
    if (err instanceof Error && err.message.includes('NETWORK MODE MISMATCH')) {
      logger.fatal({ err }, 'PF configuration validation failed');
      throw err;
    }

    logger.fatal(
      { err },
      'FATAL: Cannot validate pf configuration. Ensure pf is installed and configured.',
    );
    throw new Error(
      'NETWORK MODE MISMATCH: Network mode is "restricted" but pf validation failed.\n' +
        'To fix this issue:\n' +
        '  1. Run the migration script: scripts/switch-network-mode.sh restricted\n' +
        '  2. Or manually configure pf (see etc/pf-nanoclaw.conf)\n' +
        '  3. Or switch to "inherit" mode: export NANOCLAW_JAIL_NETWORK_MODE=inherit',
    );
  }
}

/** Get epair pool metrics for monitoring. */
export function getEpairMetrics(): {
  current: number;
  max: number;
  warningThreshold: number;
} {
  return {
    current: assignedEpairs.size,
    max: MAX_EPAIRS,
    warningThreshold: EPAIR_WARNING_THRESHOLD,
  };
}

/** Get assigned epair number for a group (used by cleanup). */
export function getAssignedEpair(groupId: string): number | undefined {
  return assignedEpairs.get(groupId);
}

/** Clear all epair assignments and persist (used during full cleanup). */
export function clearAllEpairs(): void {
  assignedEpairs.clear();
  persistEpairState();
}

/** Clean up host-side temporary files. */
export function cleanupHostTempFiles(): void {
  logger.info('Cleaning up host-side temp files');
  logger.debug('Completed host-side temp file cleanup');
}
