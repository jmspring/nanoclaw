/**
 * Shared runner setup code — settings.json creation and skills sync.
 * Used by both container-runner.ts (Docker) and jail/runner.ts (FreeBSD jails).
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';

/** Compute the group's .claude sessions directory path. */
export function getGroupSessionsDir(groupFolder: string): string {
  return path.join(DATA_DIR, 'sessions', groupFolder, '.claude');
}

/** Create group sessions directory and write settings.json if missing. */
export function ensureGroupSettings(groupSessionsDir: string): void {
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }
}

/** Copy skill directories from container/skills/ into group's .claude/skills/. */
export function syncContainerSkills(groupSessionsDir: string): void {
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      try {
        fs.cpSync(srcDir, dstDir, { recursive: true });
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch {
        // Non-fatal: individual skill copy failure doesn't block container launch
      }
    }
  }
}
