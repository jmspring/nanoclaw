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

// Mock fs
vi.mock('fs');

// Mock child_process
vi.mock('child_process');

import {
  setJailRuntimeDeps,
  resetJailRuntimeDeps,
  isJailRunning,
  sanitizeJailName,
  getJailName,
  stopJail,
  type SudoExecutor,
  type SudoExecutorSync,
} from './jail-runtime.js';

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

  describe('stopJail', () => {
    it('stops a running jail successfully', async () => {
      // Mock jail as running
      mockSudoExecSync.mockReturnValue('123\n');
      // Mock successful jail stop
      mockSudoExec.mockResolvedValue({ stdout: '', stderr: '' });

      await stopJail('test-group');

      // Should check if running
      expect(mockSudoExecSync).toHaveBeenCalledWith(
        ['jls', '-j', 'nanoclaw_test_group', 'jid'],
        { stdio: 'pipe' },
      );
      // Should stop the jail
      expect(mockSudoExec).toHaveBeenCalledWith(
        ['jail', '-r', 'nanoclaw_test_group'],
        { timeout: 15000 },
      );
    });

    it('does nothing when jail is not running', async () => {
      // Mock jail as not running
      mockSudoExecSync.mockReturnValue('');

      await stopJail('test-group');

      // Should check if running
      expect(mockSudoExecSync).toHaveBeenCalledWith(
        ['jls', '-j', 'nanoclaw_test_group', 'jid'],
        { stdio: 'pipe' },
      );
      // Should NOT try to stop
      expect(mockSudoExec).not.toHaveBeenCalled();
    });

    it('force stops jail when graceful stop fails', async () => {
      // Mock jail as running
      mockSudoExecSync.mockReturnValue('123\n');
      // Mock graceful stop failing, then force stop succeeding
      mockSudoExec
        .mockRejectedValueOnce(new Error('jail -r failed'))
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // kill processes
        .mockResolvedValueOnce({ stdout: '', stderr: '' }); // force stop

      await stopJail('test-group');

      // Should attempt graceful stop first
      expect(mockSudoExec).toHaveBeenNthCalledWith(
        1,
        ['jail', '-r', 'nanoclaw_test_group'],
        { timeout: 15000 },
      );
      // Should kill processes
      expect(mockSudoExec).toHaveBeenNthCalledWith(
        2,
        ['jexec', 'nanoclaw_test_group', 'kill', '-9', '-1'],
        { timeout: 5000 },
      );
      // Should force stop
      expect(mockSudoExec).toHaveBeenNthCalledWith(
        3,
        ['jail', '-r', 'nanoclaw_test_group'],
        { timeout: 10000 },
      );
    });

    it('throws when both graceful and force stop fail', async () => {
      // Mock jail as running
      mockSudoExecSync.mockReturnValue('123\n');
      // Mock all stop attempts failing
      mockSudoExec.mockRejectedValue(new Error('stop failed'));

      await expect(stopJail('test-group')).rejects.toThrow('stop failed');
    });
  });

  describe('sanitizeJailName', () => {
    it('replaces non-alphanumeric characters with underscores', () => {
      expect(sanitizeJailName('test@group.com')).toBe('test_group_com');
      expect(sanitizeJailName('user-123')).toBe('user_123');
      expect(sanitizeJailName('test group')).toBe('test_group');
    });

    it('preserves alphanumeric and underscore characters', () => {
      expect(sanitizeJailName('test_group_123')).toBe('test_group_123');
      expect(sanitizeJailName('alphanumeric123')).toBe('alphanumeric123');
    });
  });

  describe('getJailName', () => {
    it('generates jail name with nanoclaw prefix', () => {
      expect(getJailName('test-group')).toBe('nanoclaw_test_group');
      expect(getJailName('user@example.com')).toBe('nanoclaw_user_example_com');
    });
  });
});
