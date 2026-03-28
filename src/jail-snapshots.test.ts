import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process before imports
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}));

// Mock sudo module
const mockSudoExec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
vi.mock('./jail/sudo.js', () => ({
  getSudoExec: () => mockSudoExec,
  getSudoExecSync: () => vi.fn(),
}));

// Mock lifecycle module
const mockIsJailRunning = vi.fn().mockReturnValue(false);
vi.mock('./jail/lifecycle.js', () => ({
  getJailName: (groupId: string) => `nanoclaw_${groupId}_abc123`,
  isJailRunning: (...args: unknown[]) => mockIsJailRunning(...args),
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock config
vi.mock('./jail/config.js', () => ({
  JAIL_CONFIG: {
    jailsDataset: 'zroot/nanoclaw/jails',
    jailsPath: '/jails',
    templateDataset: 'zroot/nanoclaw/jails/template',
    templateSnapshot: 'base',
    networkMode: 'restricted',
    jailSubnet: '10.99',
    jailHostIP: '10.99.0.1',
    jailIP: '10.99.0.2',
    jailNetmask: '30',
    resourceLimits: { memoryuse: '2G', maxproc: '100', pcpu: '80' },
    workspacesPath: '/workspaces',
    ipcPath: '/ipc',
  },
}));

import { execFileSync } from 'child_process';
import {
  createSnapshot,
  listSnapshots,
  rollbackToSnapshot,
  enforceRetentionPolicy,
  destroyAllSnapshots,
  SNAPSHOT_RETENTION,
} from './jail/snapshots.js';

describe('jail snapshots', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsJailRunning.mockReturnValue(false);
  });

  describe('SNAPSHOT_RETENTION', () => {
    it('defaults to 3', () => {
      expect(SNAPSHOT_RETENTION).toBe(3);
    });
  });

  describe('createSnapshot', () => {
    it('generates correct snapshot name format', async () => {
      const result = await createSnapshot('testgroup');
      expect(mockSudoExec).toHaveBeenCalledOnce();
      const args = mockSudoExec.mock.calls[0][0];
      expect(args[0]).toBe('zfs');
      expect(args[1]).toBe('snapshot');
      expect(args[2]).toMatch(
        /^zroot\/nanoclaw\/jails\/nanoclaw_testgroup_abc123@nc-\d{8}T\d{6}Z-pre-agent$/,
      );
      expect(result).toMatch(/@nc-.*-pre-agent$/);
    });

    it('uses custom label when provided', async () => {
      await createSnapshot('testgroup', 'baseline');
      const args = mockSudoExec.mock.calls[0][0];
      expect(args[2]).toMatch(/-baseline$/);
    });
  });

  describe('listSnapshots', () => {
    it('parses ZFS output correctly', async () => {
      const zfsOutput = [
        'zroot/nanoclaw/jails/nanoclaw_test_abc123@nc-20260325T140000Z-pre-agent\t2026-03-25 14:00\t56K',
        'zroot/nanoclaw/jails/nanoclaw_test_abc123@nc-20260325T150000Z-pre-agent\t2026-03-25 15:00\t128K',
      ].join('\n');

      vi.mocked(execFileSync).mockReturnValue(zfsOutput);

      const result = await listSnapshots('test');
      expect(result).toHaveLength(2);
      expect(result[0].name).toContain('@nc-20260325T140000Z');
      expect(result[0].creation).toBe('2026-03-25 14:00');
      expect(result[0].used).toBe('56K');
    });

    it('filters out non-nc- snapshots', async () => {
      const zfsOutput = [
        'zroot/nanoclaw/jails/nanoclaw_test_abc123@base\t2026-03-01\t1G',
        'zroot/nanoclaw/jails/nanoclaw_test_abc123@nc-20260325T140000Z-pre-agent\t2026-03-25\t56K',
      ].join('\n');

      vi.mocked(execFileSync).mockReturnValue(zfsOutput);

      const result = await listSnapshots('test');
      expect(result).toHaveLength(1);
      expect(result[0].name).toContain('@nc-');
    });

    it('returns empty array if dataset does not exist', async () => {
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('dataset does not exist');
      });

      const result = await listSnapshots('nonexistent');
      expect(result).toEqual([]);
    });
  });

  describe('rollbackToSnapshot', () => {
    it('throws if jail is running', async () => {
      mockIsJailRunning.mockReturnValue(true);
      await expect(
        rollbackToSnapshot(
          'test',
          'zroot/nanoclaw/jails/nanoclaw_test_abc123@nc-snap',
        ),
      ).rejects.toThrow('still running');
    });

    it('validates snapshot belongs to correct dataset', async () => {
      await expect(
        rollbackToSnapshot('test', 'zroot/other/dataset@nc-snap'),
      ).rejects.toThrow('does not belong to dataset');
    });

    it('performs rollback when jail is stopped and name is valid', async () => {
      const snapName =
        'zroot/nanoclaw/jails/nanoclaw_test_abc123@nc-20260325T140000Z-pre-agent';
      await rollbackToSnapshot('test', snapName);

      expect(mockSudoExec).toHaveBeenCalledWith([
        'zfs',
        'rollback',
        '-r',
        snapName,
      ]);
    });
  });

  describe('enforceRetentionPolicy', () => {
    it('destroys oldest snapshots when over limit', async () => {
      const zfsOutput = [
        'zroot/nanoclaw/jails/nanoclaw_test_abc123@nc-1\t2026-03-25 10:00\t10K',
        'zroot/nanoclaw/jails/nanoclaw_test_abc123@nc-2\t2026-03-25 11:00\t10K',
        'zroot/nanoclaw/jails/nanoclaw_test_abc123@nc-3\t2026-03-25 12:00\t10K',
        'zroot/nanoclaw/jails/nanoclaw_test_abc123@nc-4\t2026-03-25 13:00\t10K',
        'zroot/nanoclaw/jails/nanoclaw_test_abc123@nc-5\t2026-03-25 14:00\t10K',
      ].join('\n');

      vi.mocked(execFileSync).mockReturnValue(zfsOutput);

      const destroyed = await enforceRetentionPolicy('test', 3);
      expect(destroyed).toBe(2);
      expect(mockSudoExec).toHaveBeenCalledWith([
        'zfs',
        'destroy',
        expect.stringContaining('@nc-1'),
      ]);
      expect(mockSudoExec).toHaveBeenCalledWith([
        'zfs',
        'destroy',
        expect.stringContaining('@nc-2'),
      ]);
    });

    it('is a no-op when under limit', async () => {
      vi.mocked(execFileSync).mockReturnValue(
        'zroot/nanoclaw/jails/nanoclaw_test_abc123@nc-1\t2026-03-25\t10K',
      );

      const destroyed = await enforceRetentionPolicy('test', 3);
      expect(destroyed).toBe(0);
      expect(mockSudoExec).not.toHaveBeenCalled();
    });
  });

  describe('destroyAllSnapshots', () => {
    it('destroys all nc- snapshots', async () => {
      const zfsOutput = [
        'zroot/nanoclaw/jails/nanoclaw_test_abc123@nc-1\t2026-03-25\t10K',
        'zroot/nanoclaw/jails/nanoclaw_test_abc123@nc-2\t2026-03-25\t10K',
      ].join('\n');

      vi.mocked(execFileSync).mockReturnValue(zfsOutput);

      await destroyAllSnapshots('test');
      expect(mockSudoExec).toHaveBeenCalledTimes(2);
    });

    it('handles empty snapshot list gracefully', async () => {
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('no dataset');
      });

      await destroyAllSnapshots('test');
      expect(mockSudoExec).not.toHaveBeenCalled();
    });
  });
});
