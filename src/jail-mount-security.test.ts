/**
 * Security tests for jail mount validation
 * Tests defense-in-depth validation in buildJailMounts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildJailMounts } from './jail-runtime.js';
import type { JailMountPaths } from './jail-runtime.js';

describe('Jail Mount Security', () => {
  let testDir: string;
  let validHostPath: string;

  beforeAll(() => {
    // Create a temporary test directory
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-jail-test-'));
    validHostPath = path.join(testDir, 'valid');
    fs.mkdirSync(validHostPath);
  });

  afterAll(() => {
    // Cleanup test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('Path Traversal Prevention', () => {
    it('should reject hostPath with .. traversal', () => {
      const paths: JailMountPaths = {
        projectPath: null,
        groupPath: validHostPath,
        ipcPath: validHostPath,
        claudeSessionPath: validHostPath,
        agentRunnerPath: validHostPath,
        additionalMounts: [
          {
            hostPath: '/tmp/../etc/passwd',
            jailPath: '/workspace/extra/test',
            readonly: true,
          },
        ],
      };

      expect(() => buildJailMounts(paths)).toThrow(/path traversal/i);
    });

    it('should reject jailPath with .. traversal', () => {
      const paths: JailMountPaths = {
        projectPath: null,
        groupPath: validHostPath,
        ipcPath: validHostPath,
        claudeSessionPath: validHostPath,
        agentRunnerPath: validHostPath,
        additionalMounts: [
          {
            hostPath: validHostPath,
            jailPath: '/workspace/../etc/passwd',
            readonly: true,
          },
        ],
      };

      expect(() => buildJailMounts(paths)).toThrow(/path traversal/i);
    });

    it('should reject relative hostPath', () => {
      const paths: JailMountPaths = {
        projectPath: null,
        groupPath: validHostPath,
        ipcPath: validHostPath,
        claudeSessionPath: validHostPath,
        agentRunnerPath: validHostPath,
        additionalMounts: [
          {
            hostPath: '../relative/path',
            jailPath: '/workspace/extra/test',
            readonly: true,
          },
        ],
      };

      expect(() => buildJailMounts(paths)).toThrow(/must be absolute/i);
    });

    it('should reject relative jailPath', () => {
      const paths: JailMountPaths = {
        projectPath: null,
        groupPath: validHostPath,
        ipcPath: validHostPath,
        claudeSessionPath: validHostPath,
        agentRunnerPath: validHostPath,
        additionalMounts: [
          {
            hostPath: validHostPath,
            jailPath: 'relative/path',
            readonly: true,
          },
        ],
      };

      expect(() => buildJailMounts(paths)).toThrow(/must be absolute/i);
    });
  });

  describe('Symlink Resolution', () => {
    it('should resolve symlinks to prevent escape', () => {
      // Create a target directory and a symlink to it
      const targetDir = path.join(testDir, 'symlink-target');
      const symlinkPath = path.join(testDir, 'symlink');
      fs.mkdirSync(targetDir);
      fs.symlinkSync(targetDir, symlinkPath);

      const paths: JailMountPaths = {
        projectPath: null,
        groupPath: validHostPath,
        ipcPath: validHostPath,
        claudeSessionPath: validHostPath,
        agentRunnerPath: validHostPath,
        additionalMounts: [
          {
            hostPath: symlinkPath,
            jailPath: '/workspace/extra/test',
            readonly: true,
          },
        ],
      };

      const mounts = buildJailMounts(paths);
      const additionalMount = mounts.find((m) =>
        m.jailPath.includes('/workspace/extra/test'),
      );

      // Mount should use the real path, not the symlink
      expect(additionalMount?.hostPath).toBe(targetDir);
      expect(additionalMount?.hostPath).not.toBe(symlinkPath);
    });

    it('should reject non-existent hostPath', () => {
      const nonExistentPath = path.join(testDir, 'does-not-exist');

      const paths: JailMountPaths = {
        projectPath: null,
        groupPath: validHostPath,
        ipcPath: validHostPath,
        claudeSessionPath: validHostPath,
        agentRunnerPath: validHostPath,
        additionalMounts: [
          {
            hostPath: nonExistentPath,
            jailPath: '/workspace/extra/test',
            readonly: true,
          },
        ],
      };

      expect(() => buildJailMounts(paths)).toThrow(/does not exist/i);
    });
  });

  describe('Blocked Path Patterns', () => {
    it('should reject .ssh directory', () => {
      // Create a .ssh directory in test dir
      const sshDir = path.join(testDir, '.ssh');
      fs.mkdirSync(sshDir);

      const paths: JailMountPaths = {
        projectPath: null,
        groupPath: validHostPath,
        ipcPath: validHostPath,
        claudeSessionPath: validHostPath,
        agentRunnerPath: validHostPath,
        additionalMounts: [
          {
            hostPath: sshDir,
            jailPath: '/workspace/extra/ssh',
            readonly: true,
          },
        ],
      };

      expect(() => buildJailMounts(paths)).toThrow(/blocked pattern.*\.ssh/i);
    });

    it('should reject .gnupg directory', () => {
      const gnupgDir = path.join(testDir, '.gnupg');
      fs.mkdirSync(gnupgDir);

      const paths: JailMountPaths = {
        projectPath: null,
        groupPath: validHostPath,
        ipcPath: validHostPath,
        claudeSessionPath: validHostPath,
        agentRunnerPath: validHostPath,
        additionalMounts: [
          {
            hostPath: gnupgDir,
            jailPath: '/workspace/extra/gpg',
            readonly: true,
          },
        ],
      };

      expect(() => buildJailMounts(paths)).toThrow(/blocked pattern.*\.gnupg/i);
    });

    it('should reject .aws directory', () => {
      const awsDir = path.join(testDir, '.aws');
      fs.mkdirSync(awsDir);

      const paths: JailMountPaths = {
        projectPath: null,
        groupPath: validHostPath,
        ipcPath: validHostPath,
        claudeSessionPath: validHostPath,
        agentRunnerPath: validHostPath,
        additionalMounts: [
          {
            hostPath: awsDir,
            jailPath: '/workspace/extra/aws',
            readonly: true,
          },
        ],
      };

      expect(() => buildJailMounts(paths)).toThrow(/blocked pattern.*\.aws/i);
    });

    it('should reject .docker directory', () => {
      const dockerDir = path.join(testDir, '.docker');
      fs.mkdirSync(dockerDir);

      const paths: JailMountPaths = {
        projectPath: null,
        groupPath: validHostPath,
        ipcPath: validHostPath,
        claudeSessionPath: validHostPath,
        agentRunnerPath: validHostPath,
        additionalMounts: [
          {
            hostPath: dockerDir,
            jailPath: '/workspace/extra/docker',
            readonly: true,
          },
        ],
      };

      expect(() => buildJailMounts(paths)).toThrow(/blocked pattern.*\.docker/i);
    });
  });

  describe('Valid Mounts', () => {
    it('should accept valid additional mount', () => {
      const safeDir = path.join(testDir, 'safe-data');
      fs.mkdirSync(safeDir);

      const paths: JailMountPaths = {
        projectPath: null,
        groupPath: validHostPath,
        ipcPath: validHostPath,
        claudeSessionPath: validHostPath,
        agentRunnerPath: validHostPath,
        additionalMounts: [
          {
            hostPath: safeDir,
            jailPath: '/workspace/extra/data',
            readonly: true,
          },
        ],
      };

      const mounts = buildJailMounts(paths);
      const additionalMount = mounts.find((m) =>
        m.jailPath.includes('/workspace/extra/data'),
      );

      expect(additionalMount).toBeDefined();
      expect(additionalMount?.hostPath).toBe(safeDir);
      expect(additionalMount?.jailPath).toBe('/workspace/extra/data');
      expect(additionalMount?.readonly).toBe(true);
    });

    it('should accept multiple valid additional mounts', () => {
      const dir1 = path.join(testDir, 'data1');
      const dir2 = path.join(testDir, 'data2');
      fs.mkdirSync(dir1);
      fs.mkdirSync(dir2);

      const paths: JailMountPaths = {
        projectPath: null,
        groupPath: validHostPath,
        ipcPath: validHostPath,
        claudeSessionPath: validHostPath,
        agentRunnerPath: validHostPath,
        additionalMounts: [
          {
            hostPath: dir1,
            jailPath: '/workspace/extra/data1',
            readonly: true,
          },
          {
            hostPath: dir2,
            jailPath: '/workspace/extra/data2',
            readonly: false,
          },
        ],
      };

      const mounts = buildJailMounts(paths);
      const mount1 = mounts.find((m) =>
        m.jailPath.includes('/workspace/extra/data1'),
      );
      const mount2 = mounts.find((m) =>
        m.jailPath.includes('/workspace/extra/data2'),
      );

      expect(mount1).toBeDefined();
      expect(mount1?.readonly).toBe(true);
      expect(mount2).toBeDefined();
      expect(mount2?.readonly).toBe(false);
    });
  });

  describe('Core Mount Paths', () => {
    it('should create mounts without additional mounts', () => {
      const paths: JailMountPaths = {
        projectPath: validHostPath,
        groupPath: validHostPath,
        ipcPath: validHostPath,
        claudeSessionPath: validHostPath,
        agentRunnerPath: validHostPath,
      };

      const mounts = buildJailMounts(paths);

      // Should have all 5 core mounts
      expect(mounts).toHaveLength(5);
      expect(mounts.some((m) => m.jailPath === '/workspace/project')).toBe(true);
      expect(mounts.some((m) => m.jailPath === '/workspace/group')).toBe(true);
      expect(mounts.some((m) => m.jailPath === '/workspace/ipc')).toBe(true);
      expect(mounts.some((m) => m.jailPath === '/home/node/.claude')).toBe(true);
      expect(mounts.some((m) => m.jailPath === '/app/src')).toBe(true);
    });
  });
});
