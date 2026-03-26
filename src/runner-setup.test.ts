import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

vi.mock('./config.js', () => ({
  DATA_DIR: '/mock/data',
}));

vi.mock('fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    existsSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(),
    cpSync: vi.fn(),
  },
}));

import fs from 'fs';
import {
  getGroupSessionsDir,
  ensureGroupSettings,
  syncContainerSkills,
} from './runner-setup.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getGroupSessionsDir', () => {
  it('returns correct path for a given group folder', () => {
    const result = getGroupSessionsDir('my-group');
    expect(result).toBe(path.join('/mock/data', 'sessions', 'my-group', '.claude'));
  });
});

describe('ensureGroupSettings', () => {
  it('creates directory if it does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    ensureGroupSettings('/mock/sessions/.claude');
    expect(fs.mkdirSync).toHaveBeenCalledWith('/mock/sessions/.claude', {
      recursive: true,
    });
  });

  it('writes settings.json with correct content when file missing', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    ensureGroupSettings('/mock/sessions/.claude');
    const settingsPath = path.join('/mock/sessions/.claude', 'settings.json');
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      settingsPath,
      expect.stringContaining('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'),
    );
    // Verify all three keys present
    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
    expect(parsed.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe('1');
    expect(parsed.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('0');
  });

  it('does NOT overwrite existing settings.json', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    ensureGroupSettings('/mock/sessions/.claude');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});

describe('syncContainerSkills', () => {
  it('copies skill directories from container/skills/', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['skill-a', 'skill-b'] as unknown as ReturnType<typeof fs.readdirSync>);
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof fs.statSync>);
    syncContainerSkills('/mock/sessions/.claude');
    expect(fs.cpSync).toHaveBeenCalledTimes(2);
  });

  it('skips non-directory entries', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['file.txt', 'skill-a'] as unknown as ReturnType<typeof fs.readdirSync>);
    vi.mocked(fs.statSync)
      .mockReturnValueOnce({ isDirectory: () => false } as ReturnType<typeof fs.statSync>)
      .mockReturnValueOnce({ isDirectory: () => true } as ReturnType<typeof fs.statSync>);
    syncContainerSkills('/mock/sessions/.claude');
    expect(fs.cpSync).toHaveBeenCalledTimes(1);
  });

  it('handles missing container/skills/ directory gracefully', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(() => syncContainerSkills('/mock/sessions/.claude')).not.toThrow();
    expect(fs.cpSync).not.toHaveBeenCalled();
  });

  it('catches and ignores per-directory copy errors', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['skill-a'] as unknown as ReturnType<typeof fs.readdirSync>);
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof fs.statSync>);
    vi.mocked(fs.cpSync).mockImplementation(() => {
      throw new Error('copy failed');
    });
    expect(() => syncContainerSkills('/mock/sessions/.claude')).not.toThrow();
  });
});
