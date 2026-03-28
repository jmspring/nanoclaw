import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';

vi.mock('os');
vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { isCapsicumAvailable, capRightsLimit, capEnter } from './capsicum.js';

describe('isCapsicumAvailable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false on non-FreeBSD platforms', () => {
    vi.mocked(os.platform).mockReturnValue('linux');
    expect(isCapsicumAvailable()).toBe(false);
  });

  it('returns false on darwin', () => {
    vi.mocked(os.platform).mockReturnValue('darwin');
    expect(isCapsicumAvailable()).toBe(false);
  });

  it('returns false on FreeBSD when native addon is not built (stub)', () => {
    vi.mocked(os.platform).mockReturnValue('freebsd');
    // Stub always returns false since native addon is not built
    expect(isCapsicumAvailable()).toBe(false);
  });
});

describe('capRightsLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false gracefully when Capsicum is not available', () => {
    vi.mocked(os.platform).mockReturnValue('linux');

    const result = capRightsLimit(5, ['CAP_READ', 'CAP_WRITE']);

    expect(result).toBe(false);
  });

  it('does not throw when Capsicum is unavailable', () => {
    vi.mocked(os.platform).mockReturnValue('linux');

    expect(() => capRightsLimit(5, ['CAP_READ'])).not.toThrow();
  });

  it('returns false on FreeBSD with stub implementation', () => {
    vi.mocked(os.platform).mockReturnValue('freebsd');

    const result = capRightsLimit(5, ['CAP_ACCEPT', 'CAP_READ', 'CAP_WRITE']);

    expect(result).toBe(false);
  });
});

describe('capEnter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false when Capsicum is not available', () => {
    vi.mocked(os.platform).mockReturnValue('linux');
    expect(capEnter()).toBe(false);
  });
});
