import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
  execFile: vi.fn(),
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

// Mock sudo
vi.mock('./jail/sudo.js', () => ({
  getSudoExec: () => vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  getSudoExecSync: () => vi.fn().mockReturnValue(''),
}));

// Mock credential-proxy
vi.mock('./credential-proxy.js', () => ({
  registerJailToken: vi.fn(),
  revokeJailToken: vi.fn(),
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
  MAX_CONCURRENT_JAILS: 50,
  JAIL_STOP_TIMEOUT: 15000,
  JAIL_FORCE_STOP_TIMEOUT: 10000,
  JAIL_QUICK_OP_TIMEOUT: 5000,
  JAIL_PERSIST: false,
  JAIL_IDLE_TIMEOUT: 900000,
  JAIL_PERSIST_ROLLBACK: true,
}));

// Mock DATA_DIR
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/test-data',
  GROUPS_DIR: '/tmp/test-groups',
}));

// Mock network
vi.mock('./jail/network.js', () => ({
  createEpair: vi.fn(),
  configureJailNetwork: vi.fn(),
  releaseEpair: vi.fn(),
  setupJailResolv: vi.fn(),
  getAssignedEpair: vi.fn(),
}));

// Mock mounts
vi.mock('./jail/mounts.js', () => ({
  buildJailMounts: vi.fn().mockReturnValue([]),
  ensureHostDirectories: vi.fn(),
  buildFstab: vi.fn(),
  createMountPoints: vi.fn(),
  mountNullfs: vi.fn(),
}));

// Mock cleanup
vi.mock('./jail/cleanup.js', () => ({
  logCleanupAudit: vi.fn(),
  retryWithBackoff: vi.fn().mockImplementation((fn) => fn()),
  listRunningNanoclawJails: vi.fn().mockReturnValue([]),
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue('{}'),
    chmodSync: vi.fn(),
    chownSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

import {
  getPersistentJail,
  setPersistentJail,
  removePersistentJail,
  getAllPersistentJails,
  updatePersistentJailLastUsed,
} from './jail/lifecycle.js';

import type { PersistentJailState } from './jail/types.js';

describe('jail persistence state management', () => {
  const makeState = (groupId: string): PersistentJailState => ({
    groupId,
    jailName: `nanoclaw_${groupId}_abc`,
    mounts: [],
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    sessionCount: 0,
    baselineSnapshot: `zroot/nanoclaw/jails/nanoclaw_${groupId}_abc@nc-baseline`,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear persistent state between tests
    for (const state of getAllPersistentJails()) {
      removePersistentJail(state.groupId);
    }
  });

  it('setPersistentJail and getPersistentJail round-trip', () => {
    const state = makeState('group1');
    setPersistentJail('group1', state);
    expect(getPersistentJail('group1')).toBe(state);
  });

  it('getPersistentJail returns undefined for unknown group', () => {
    expect(getPersistentJail('unknown')).toBeUndefined();
  });

  it('removePersistentJail removes state', () => {
    setPersistentJail('group1', makeState('group1'));
    removePersistentJail('group1');
    expect(getPersistentJail('group1')).toBeUndefined();
  });

  it('getAllPersistentJails returns all states', () => {
    setPersistentJail('g1', makeState('g1'));
    setPersistentJail('g2', makeState('g2'));
    expect(getAllPersistentJails()).toHaveLength(2);
  });

  it('updatePersistentJailLastUsed updates time and increments count', () => {
    const state = makeState('group1');
    state.sessionCount = 0;
    state.lastUsedAt = 1000;
    setPersistentJail('group1', state);

    updatePersistentJailLastUsed('group1');
    const updated = getPersistentJail('group1')!;
    expect(updated.sessionCount).toBe(1);
    expect(updated.lastUsedAt).toBeGreaterThan(1000);
  });

  it('updatePersistentJailLastUsed is no-op for unknown group', () => {
    // Should not throw
    updatePersistentJailLastUsed('nonexistent');
  });
});
