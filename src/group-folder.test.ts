import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  isValidGroupFolder,
  resolveGroupFolderPath,
  resolveGroupIpcPath,
} from './group-folder.js';

describe('group folder validation', () => {
  it('accepts normal group folder names', () => {
    expect(isValidGroupFolder('main')).toBe(true);
    expect(isValidGroupFolder('family-chat')).toBe(true);
    expect(isValidGroupFolder('Team_42')).toBe(true);
  });

  it('rejects traversal and reserved names', () => {
    expect(isValidGroupFolder('../../etc')).toBe(false);
    expect(isValidGroupFolder('/tmp')).toBe(false);
    expect(isValidGroupFolder('global')).toBe(false);
    expect(isValidGroupFolder('')).toBe(false);
  });

  it('resolves safe paths under groups directory', () => {
    const resolved = resolveGroupFolderPath('family-chat');
    expect(resolved.endsWith(`${path.sep}groups${path.sep}family-chat`)).toBe(
      true,
    );
  });

  it('resolves safe paths under data ipc directory', () => {
    const resolved = resolveGroupIpcPath('family-chat');
    expect(
      resolved.endsWith(`${path.sep}data${path.sep}ipc${path.sep}family-chat`),
    ).toBe(true);
  });

  it('throws for unsafe folder names', () => {
    expect(() => resolveGroupFolderPath('../../etc')).toThrow();
    expect(() => resolveGroupIpcPath('/tmp')).toThrow();
  });

  it('rejects path traversal vectors in resolveGroupIpcPath', () => {
    // Test various path traversal attempts
    expect(() => resolveGroupIpcPath('../../../etc/passwd')).toThrow(
      'Invalid group folder',
    );
    expect(() => resolveGroupIpcPath('../../../../etc')).toThrow(
      'Invalid group folder',
    );
    expect(() => resolveGroupIpcPath('../etc')).toThrow('Invalid group folder');
    expect(() => resolveGroupIpcPath('/etc/passwd')).toThrow(
      'Invalid group folder',
    );
    expect(() => resolveGroupIpcPath('/tmp')).toThrow('Invalid group folder');
    expect(() => resolveGroupIpcPath('foo/../../../etc')).toThrow(
      'Invalid group folder',
    );
  });

  it('rejects path traversal vectors in resolveGroupFolderPath', () => {
    // Test various path traversal attempts
    expect(() => resolveGroupFolderPath('../../../etc/passwd')).toThrow(
      'Invalid group folder',
    );
    expect(() => resolveGroupFolderPath('../../../../etc')).toThrow(
      'Invalid group folder',
    );
    expect(() => resolveGroupFolderPath('../etc')).toThrow(
      'Invalid group folder',
    );
    expect(() => resolveGroupFolderPath('/etc/passwd')).toThrow(
      'Invalid group folder',
    );
    expect(() => resolveGroupFolderPath('/tmp')).toThrow(
      'Invalid group folder',
    );
    expect(() => resolveGroupFolderPath('foo/../../../etc')).toThrow(
      'Invalid group folder',
    );
  });
});
