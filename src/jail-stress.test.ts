/**
 * Stress test for rapid jail create/destroy cycles.
 *
 * Verifies that creating and destroying jails in rapid succession does not leak:
 *   1. ZFS datasets under the jails dataset
 *   2. epair interfaces on the host
 *   3. Temporary files under /tmp
 *   4. Running jail processes
 *
 * Requires:
 *   - FreeBSD with jails enabled
 *   - ZFS with template snapshot
 *   - sudo access (jails require root)
 *
 * Run with: npm test jail-stress.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createJailWithPaths, destroyJail, getJailName, datasetExists } from './jail/lifecycle.js';
import { JAIL_CONFIG } from './jail/config.js';
import { listRunningNanoclawJails } from './jail/cleanup.js';
import type { JailCreationResult } from './jail/types.js';

const isFreeBSD = process.platform === 'freebsd';
const isRoot = isFreeBSD && process.getuid?.() === 0;
const skipReason = !isFreeBSD
  ? 'Skipping: not running on FreeBSD'
  : !isRoot
    ? 'Skipping: must run as root (jail creation requires root)'
    : null;

const JAIL_COUNT = 10;
const STRESS_TIMEOUT = 120000; // 2 minutes for the full suite
const SINGLE_JAIL_TIMEOUT = 30000;
const STRESS_GROUP_PREFIX = 'stress-test';
const TEMP_BASE = '/tmp/nanoclaw-stress-test';

/** List ZFS datasets under the jails dataset matching a prefix */
function listJailDatasets(prefix: string): string[] {
  try {
    const output = execFileSync(
      'zfs',
      ['list', '-H', '-o', 'name', '-r', JAIL_CONFIG.jailsDataset],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return output
      .trim()
      .split('\n')
      .filter((line) => line.includes(prefix));
  } catch {
    return [];
  }
}

/** List epair interfaces on the host */
function listEpairInterfaces(): string[] {
  try {
    const output = execFileSync('ifconfig', ['-l'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output
      .trim()
      .split(/\s+/)
      .filter((iface) => /^epair\d+a$/.test(iface));
  } catch {
    return [];
  }
}

/** List /tmp directories matching the stress test prefix */
function listTempDirs(): string[] {
  try {
    return fs
      .readdirSync('/tmp')
      .filter((name) => name.startsWith('nanoclaw-stress-test'));
  } catch {
    return [];
  }
}

describe.skipIf(!isFreeBSD || !isRoot)('Jail Stress Test — Rapid Create/Destroy', () => {
  const groupIds: string[] = [];
  const timings: { groupId: string; createMs: number; destroyMs: number }[] = [];

  // Capture baseline state before tests
  let baselineEpairs: string[] = [];
  let baselineRunningJails: string[] = [];

  beforeAll(() => {
    // Record baseline
    baselineEpairs = listEpairInterfaces();
    baselineRunningJails = listRunningNanoclawJails();

    // Generate group IDs
    for (let i = 0; i < JAIL_COUNT; i++) {
      groupIds.push(`${STRESS_GROUP_PREFIX}-${i}`);
    }

    // Clean up any leftover state from previous runs
    if (fs.existsSync(TEMP_BASE)) {
      fs.rmSync(TEMP_BASE, { recursive: true, force: true });
    }
  }, SINGLE_JAIL_TIMEOUT);

  afterAll(() => {
    // Clean up temp directory
    if (fs.existsSync(TEMP_BASE)) {
      fs.rmSync(TEMP_BASE, { recursive: true, force: true });
    }

    // Print timing summary
    if (timings.length > 0) {
      const totalCreate = timings.reduce((sum, t) => sum + t.createMs, 0);
      const totalDestroy = timings.reduce((sum, t) => sum + t.destroyMs, 0);
      const avgCreate = Math.round(totalCreate / timings.length);
      const avgDestroy = Math.round(totalDestroy / timings.length);

      console.log('\n--- Jail Stress Test Timing ---');
      console.log(`Jails cycled: ${timings.length}`);
      console.log(`Avg create:  ${avgCreate}ms`);
      console.log(`Avg destroy: ${avgDestroy}ms`);
      console.log(`Total:       ${totalCreate + totalDestroy}ms`);
      for (const t of timings) {
        console.log(`  ${t.groupId}: create=${t.createMs}ms destroy=${t.destroyMs}ms`);
      }
      console.log('------------------------------\n');
    }
  }, SINGLE_JAIL_TIMEOUT);

  it(
    'rapidly creates and destroys jails without resource leaks',
    async () => {
      // Sequential create/destroy — stress the full lifecycle path
      for (const groupId of groupIds) {
        const groupPath = path.join(TEMP_BASE, groupId);
        const ipcPath = path.join(TEMP_BASE, groupId, 'ipc');
        const sessionPath = path.join(TEMP_BASE, groupId, '.claude');

        // Create
        const createStart = Date.now();
        let result: JailCreationResult;
        try {
          result = await createJailWithPaths(groupId, {
            projectPath: null,
            groupPath,
            ipcPath,
            claudeSessionPath: sessionPath,
            agentRunnerPath: process.cwd(),
          });
        } catch (error) {
          // If creation fails, record and continue to test cleanup
          console.error(`Failed to create jail ${groupId}:`, error);
          continue;
        }
        const createMs = Date.now() - createStart;

        // Verify jail was created
        const jailName = getJailName(groupId);
        expect(datasetExists(`${JAIL_CONFIG.jailsDataset}/${jailName}`)).toBe(true);

        // Destroy
        const destroyStart = Date.now();
        await destroyJail(groupId, result.mounts);
        const destroyMs = Date.now() - destroyStart;

        timings.push({ groupId, createMs, destroyMs });

        // Verify jail dataset is gone after destroy
        expect(datasetExists(`${JAIL_CONFIG.jailsDataset}/${jailName}`)).toBe(false);
      }

      // Must have successfully cycled at least some jails
      expect(timings.length).toBeGreaterThan(0);
    },
    STRESS_TIMEOUT,
  );

  it(
    'no orphan ZFS datasets remain',
    () => {
      const orphanDatasets = listJailDatasets(STRESS_GROUP_PREFIX);
      expect(orphanDatasets).toEqual([]);
    },
    SINGLE_JAIL_TIMEOUT,
  );

  it(
    'no orphan epair interfaces remain',
    () => {
      const currentEpairs = listEpairInterfaces();
      // Should be back to baseline (no new epairs from stress test)
      const newEpairs = currentEpairs.filter((e) => !baselineEpairs.includes(e));
      expect(newEpairs).toEqual([]);
    },
    SINGLE_JAIL_TIMEOUT,
  );

  it(
    'no orphan running jails remain',
    () => {
      const currentJails = listRunningNanoclawJails();
      const orphanJails = currentJails.filter(
        (j) => j.includes(STRESS_GROUP_PREFIX) && !baselineRunningJails.includes(j),
      );
      expect(orphanJails).toEqual([]);
    },
    SINGLE_JAIL_TIMEOUT,
  );

  it(
    'no /tmp directory leaks from stress test',
    () => {
      const stressTempDirs = listTempDirs();
      // The base temp dir may exist (cleaned in afterAll), but no per-jail leaks
      // outside of the base dir
      const leakedDirs = stressTempDirs.filter(
        (d) => d !== 'nanoclaw-stress-test',
      );
      expect(leakedDirs).toEqual([]);
    },
    SINGLE_JAIL_TIMEOUT,
  );
});

if (skipReason) {
  console.log(`[jail-stress.test.ts] ${skipReason}`);
}
