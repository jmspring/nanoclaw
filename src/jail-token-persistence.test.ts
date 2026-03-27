import { describe, it, expect, vi, beforeEach } from 'vitest';

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

// Mock credential-proxy so registerJailToken/revokeJailToken are spies
vi.mock('./credential-proxy.js', () => ({
  registerJailToken: vi.fn(),
  revokeJailToken: vi.fn(),
}));

// We need to mock cleanup.ts to provide listRunningNanoclawJails
vi.mock('./jail/cleanup.js', () => ({
  logCleanupAudit: vi.fn(),
  retryWithBackoff: vi.fn(),
  listRunningNanoclawJails: vi.fn(() => []),
}));

import crypto from 'crypto';
import fs from 'fs';
import { restoreTokenState } from './jail/lifecycle.js';
import { registerJailToken } from './credential-proxy.js';

import { listRunningNanoclawJails } from './jail/cleanup.js';

describe('jail token persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('restoreTokenState', () => {
    it('handles missing file gracefully (first startup)', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      expect(() => restoreTokenState()).not.toThrow();
    });

    it('handles corrupt JSON gracefully', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('not valid json{{{');

      expect(() => restoreTokenState()).not.toThrow();
    });

    it('restores tokens for running jails', () => {
      const state = {
        groupA: '550e8400-e29b-41d4-a716-446655440000',
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(state));
      vi.mocked(listRunningNanoclawJails).mockReturnValue([
        'nanoclaw_groupA_' + 'a'.repeat(6),
      ]);

      // getJailName uses sanitizeJailName which creates a hash
      const hash = crypto
        .createHash('sha256')
        .update('groupA')
        .digest('hex')
        .slice(0, 6);
      const expectedJailName = `nanoclaw_groupA_${hash}`;

      vi.mocked(listRunningNanoclawJails).mockReturnValue([expectedJailName]);

      restoreTokenState();

      expect(registerJailToken).toHaveBeenCalledWith(
        '550e8400-e29b-41d4-a716-446655440000',
      );
    });

    it('discards tokens for jails that are no longer running', () => {
      const state = {
        groupA: '550e8400-e29b-41d4-a716-446655440000',
        groupB: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(state));
      // No jails running
      vi.mocked(listRunningNanoclawJails).mockReturnValue([]);

      restoreTokenState();

      // registerJailToken should NOT have been called since no jails are running
      expect(registerJailToken).not.toHaveBeenCalled();
      // Should have written cleaned state
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('persists cleaned state after restore', () => {
      const state = {
        groupA: '550e8400-e29b-41d4-a716-446655440000',
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(state));
      vi.mocked(listRunningNanoclawJails).mockReturnValue([]);

      restoreTokenState();

      // Should persist the cleaned state (empty since no jails running)
      expect(fs.writeFileSync).toHaveBeenCalled();
      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      expect(String(writeCall[0])).toContain('jail-tokens.json');
    });
  });
});
