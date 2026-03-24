import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Mock env.js so config.ts doesn't crash reading .env with mocked fs
vi.mock('./env.js', () => ({
  readEnvFile: () => ({}),
}));

// Mock fs
vi.mock('fs');

// Mock child_process
vi.mock('child_process');

import { setJailRuntimeDeps, resetJailRuntimeDeps } from './jail/sudo.js';
import {
  isJailRunning,
  isJailRunningAsync,
  sanitizeJailName,
  getJailName,
  stopJail,
} from './jail/lifecycle.js';
import type { SudoExecutor, SudoExecutorSync } from './jail/types.js';

describe('jail-runtime dependency injection', () => {
  let mockSudoExec: ReturnType<typeof vi.fn>;
  let mockSudoExecSync: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock sudo executors
    mockSudoExec = vi.fn();
    mockSudoExecSync = vi.fn();

    // Inject mocks for testing
    setJailRuntimeDeps({
      sudoExec: mockSudoExec as unknown as SudoExecutor,
      sudoExecSync: mockSudoExecSync as unknown as SudoExecutorSync,
    });
  });

  afterEach(() => {
    // Reset to defaults after each test
    resetJailRuntimeDeps();
  });

  describe('isJailRunning', () => {
    it('returns true when jail is running', () => {
      // Mock jls returning a JID
      mockSudoExecSync.mockReturnValue('123\n');

      const result = isJailRunning('nanoclaw_test');

      expect(result).toBe(true);
      expect(mockSudoExecSync).toHaveBeenCalledWith(
        ['jls', '-j', 'nanoclaw_test', 'jid'],
        { stdio: 'pipe' },
      );
    });

    it('returns false when jail is not running', () => {
      // Mock jls throwing error (jail not found)
      mockSudoExecSync.mockImplementation(() => {
        throw new Error('sudo jls -j nanoclaw_test jid failed');
      });

      const result = isJailRunning('nanoclaw_test');

      expect(result).toBe(false);
      expect(mockSudoExecSync).toHaveBeenCalledWith(
        ['jls', '-j', 'nanoclaw_test', 'jid'],
        { stdio: 'pipe' },
      );
    });

    it('returns false when jls returns empty output', () => {
      mockSudoExecSync.mockReturnValue('');

      const result = isJailRunning('nanoclaw_test');

      expect(result).toBe(false);
    });
  });

  describe('isJailRunningAsync', () => {
    it('returns true when jail is running', async () => {
      mockSudoExec.mockResolvedValue({ stdout: '123\n', stderr: '' });

      const result = await isJailRunningAsync('nanoclaw_test');

      expect(result).toBe(true);
      expect(mockSudoExec).toHaveBeenCalledWith(
        ['jls', '-j', 'nanoclaw_test', 'jid'],
        { stdio: 'pipe' },
      );
    });

    it('returns false when jail is not running', async () => {
      mockSudoExec.mockRejectedValue(new Error('jail not found'));

      const result = await isJailRunningAsync('nanoclaw_test');

      expect(result).toBe(false);
    });

    it('returns false when jls returns empty output', async () => {
      mockSudoExec.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await isJailRunningAsync('nanoclaw_test');

      expect(result).toBe(false);
    });
  });

  describe('stopJail', () => {
    it('stops a running jail successfully', async () => {
      const expectedName = getJailName('test-group');
      // Mock isJailRunning (sync) returning true, then jail stop (async)
      mockSudoExecSync.mockReturnValueOnce('123\n'); // isJailRunning
      mockSudoExec.mockResolvedValueOnce({ stdout: '', stderr: '' }); // jail -r

      await stopJail('test-group');

      // Should check if running via sync
      expect(mockSudoExecSync).toHaveBeenCalledWith(
        ['jls', '-j', expectedName, 'jid'],
        { stdio: 'pipe' },
      );
      // Should stop the jail
      expect(mockSudoExec).toHaveBeenNthCalledWith(
        1,
        ['jail', '-r', expectedName],
        { timeout: 15000 },
      );
    });

    it('does nothing when jail is not running', async () => {
      const expectedName = getJailName('test-group');
      // Mock isJailRunning (sync) returning false (throws = not running)
      mockSudoExecSync.mockImplementationOnce(() => { throw new Error('jail not found'); });

      await stopJail('test-group');

      // Should check if running via sync
      expect(mockSudoExecSync).toHaveBeenCalledWith(
        ['jls', '-j', expectedName, 'jid'],
        { stdio: 'pipe' },
      );
      // Should NOT try to stop
      expect(mockSudoExec).toHaveBeenCalledTimes(0);
    });

    it('force stops jail when graceful stop fails', async () => {
      const expectedName = getJailName('test-group');
      // Mock isJailRunning (sync) returning true, then graceful stop failing, then force stop succeeding
      mockSudoExecSync.mockReturnValueOnce('123\n'); // isJailRunning
      mockSudoExec
        .mockRejectedValueOnce(new Error('jail -r failed'))     // graceful stop
        .mockResolvedValueOnce({ stdout: '', stderr: '' })      // kill processes
        .mockResolvedValueOnce({ stdout: '', stderr: '' });     // force stop

      await stopJail('test-group');

      // Should check running via sync
      expect(mockSudoExecSync).toHaveBeenCalledWith(
        ['jls', '-j', expectedName, 'jid'],
        { stdio: 'pipe' },
      );
      // Should attempt graceful stop
      expect(mockSudoExec).toHaveBeenNthCalledWith(
        1,
        ['jail', '-r', expectedName],
        { timeout: 15000 },
      );
      // Should kill processes
      expect(mockSudoExec).toHaveBeenNthCalledWith(
        2,
        ['jexec', expectedName, 'kill', '-9', '-1'],
        { timeout: 5000 },
      );
      // Should force stop
      expect(mockSudoExec).toHaveBeenNthCalledWith(
        3,
        ['jail', '-r', expectedName],
        { timeout: 10000 },
      );
    });

    it('throws when both graceful and force stop fail', async () => {
      // Mock isJailRunning (sync) returning true, all async stops failing
      mockSudoExecSync.mockReturnValueOnce('123\n'); // isJailRunning
      mockSudoExec.mockRejectedValue(new Error('stop failed'));

      await expect(stopJail('test-group')).rejects.toThrow('stop failed');
    });
  });

  describe('sanitizeJailName', () => {
    it('replaces non-alphanumeric characters with underscores and appends hash', () => {
      expect(sanitizeJailName('test@group.com')).toMatch(/^test_group_com_[0-9a-f]{6}$/);
      expect(sanitizeJailName('user-123')).toMatch(/^user_123_[0-9a-f]{6}$/);
      expect(sanitizeJailName('test group')).toMatch(/^test_group_[0-9a-f]{6}$/);
    });

    it('preserves alphanumeric and underscore characters and appends hash', () => {
      expect(sanitizeJailName('test_group_123')).toMatch(/^test_group_123_[0-9a-f]{6}$/);
      expect(sanitizeJailName('alphanumeric123')).toMatch(/^alphanumeric123_[0-9a-f]{6}$/);
    });

    it('produces deterministic output', () => {
      expect(sanitizeJailName('test')).toBe(sanitizeJailName('test'));
    });
  });

  describe('getJailName', () => {
    it('generates jail name with nanoclaw prefix', () => {
      expect(getJailName('test-group')).toMatch(/^nanoclaw_test_group_[0-9a-f]{6}$/);
      expect(getJailName('user@example.com')).toMatch(/^nanoclaw_user_example_com_[0-9a-f]{6}$/);
    });
  });
});
