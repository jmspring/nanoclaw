import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('fs');
vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('./config.js', () => ({
  DATA_DIR: '/test/data',
}));

import {
  loadHashes,
  getExpectedHash,
  setExpectedHash,
  checkIntegrity,
  setIntegrityAlertFn,
  getIntegrityAlertFn,
} from './integrity.js';

describe('integrity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset module state by loading empty
    vi.mocked(fs.existsSync).mockReturnValue(false);
    loadHashes();
  });

  describe('loadHashes', () => {
    it('loads hashes from disk', () => {
      const stored = {
        'group-a': {
          hash: 'abc123',
          updatedAt: '2026-01-01T00:00:00.000Z',
          updatedBy: 'auto-initial',
        },
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(stored));

      loadHashes();

      expect(getExpectedHash('group-a')).toBe('abc123');
    });

    it('starts fresh when file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      loadHashes();

      expect(getExpectedHash('group-a')).toBeNull();
    });

    it('starts fresh when file is corrupted', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('not valid json');

      loadHashes();

      expect(getExpectedHash('group-a')).toBeNull();
    });
  });

  describe('saveHashes', () => {
    it('writes to tmp file then renames (atomic write)', () => {
      setExpectedHash('group-a', 'abc123', 'test');

      expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalled();
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        expect.any(String),
      );
      expect(vi.mocked(fs.chmodSync)).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        0o600,
      );
      expect(vi.mocked(fs.renameSync)).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        path.join('/test/data', 'integrity-hashes.json'),
      );
    });
  });

  describe('checkIntegrity', () => {
    it('returns match when hashes agree', () => {
      setExpectedHash('group-a', 'abc123', 'test');

      const result = checkIntegrity('group-a', 'abc123');

      expect(result.status).toBe('match');
      expect(result.expectedHash).toBe('abc123');
      expect(result.actualHash).toBe('abc123');
    });

    it('returns mismatch when hashes differ', () => {
      setExpectedHash('group-a', 'abc123', 'test');

      const result = checkIntegrity('group-a', 'def456');

      expect(result.status).toBe('mismatch');
      expect(result.expectedHash).toBe('abc123');
      expect(result.actualHash).toBe('def456');
    });

    it('returns new when no baseline exists', () => {
      const result = checkIntegrity('unknown-group', 'abc123');

      expect(result.status).toBe('new');
      expect(result.actualHash).toBe('abc123');
    });

    it('returns missing_file when currentHash is null', () => {
      const result = checkIntegrity('group-a', null);

      expect(result.status).toBe('missing_file');
    });
  });

  describe('auto-initial baseline', () => {
    it('stores baseline for new group via setExpectedHash', () => {
      expect(getExpectedHash('new-group')).toBeNull();

      setExpectedHash('new-group', 'initial-hash', 'auto-initial');

      expect(getExpectedHash('new-group')).toBe('initial-hash');
    });
  });

  describe('pre-run baseline mismatch detection', () => {
    it('detects out-of-band modification', () => {
      setExpectedHash('group-a', 'original-hash', 'auto-initial');

      // Simulate file modified outside agent run
      const result = checkIntegrity('group-a', 'modified-hash');

      expect(result.status).toBe('mismatch');
      expect(result.expectedHash).toBe('original-hash');
      expect(result.actualHash).toBe('modified-hash');
    });
  });

  describe('alert function registration', () => {
    it('stores and retrieves alert function', () => {
      const alertFn = vi.fn();
      setIntegrityAlertFn(alertFn);

      expect(getIntegrityAlertFn()).toBe(alertFn);
    });

    it('can be cleared', () => {
      setIntegrityAlertFn(vi.fn());
      setIntegrityAlertFn(null);

      expect(getIntegrityAlertFn()).toBeNull();
    });
  });
});
