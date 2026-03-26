---
id: src-ph06
status: closed
deps: []
links: [src-ph03, src-ph04, src-ph05, src-ph07, src-ph08, src-ph09]
created: 2026-03-23T09:45:00Z
type: task
priority: 2
tags: [hardening, phase6, freebsd, integration]
---
# Phase 6: FreeBSD Integration

Branch: `hardening/phase-6-freebsd-integration`
Worktree: Yes — use worktrees for parallel subagents
Parallel subagents: Yes — 2 parallel agents, then 1 sequential followup

## Subagent Assignment

- **Agent 6-alpha** (worktree): 6A + 6D (rc.d service + platform detection — FreeBSD platform)
- **Agent 6-beta** (worktree): 6B + 6C (jail.conf generation + parameterize paths — jail-runtime.ts)
- **Agent 6-gamma** (sequential, after 6-beta): 6E (blue/green templates — depends on 6C)

6A-6D run in parallel. 6E starts after 6C (from agent 6-beta) is complete. Merge worktree branches into `hardening/phase-6-freebsd-integration` after all complete.

## Section 6A: Create rc.d Service Script

**Cited by**: FreeBSD Expert #5, Newbie
**Files**: Create `etc/rc.d/nanoclaw`, update `scripts/setup-freebsd.sh`

Create FreeBSD rc.d script following `rc.subr(8)` conventions:
```sh
#!/bin/sh
# PROVIDE: nanoclaw
# REQUIRE: LOGIN NETWORKING
# KEYWORD: shutdown
. /etc/rc.subr
name="nanoclaw"
rcvar="${name}_enable"
load_rc_config $name
: ${nanoclaw_enable:=NO}
: ${nanoclaw_user:="jims"}
: ${nanoclaw_dir:="/home/jims/code/nanoclaw/src"}
pidfile="/var/run/${name}.pid"
command="/usr/sbin/daemon"
command_args="-f -p ${pidfile} -u ${nanoclaw_user} -o /var/log/nanoclaw.log /usr/local/bin/node ${nanoclaw_dir}/dist/index.js"
run_rc_command "$@"
```

Add to setup script: `cp etc/rc.d/nanoclaw /usr/local/etc/rc.d/ && chmod 755 /usr/local/etc/rc.d/nanoclaw && sysrc nanoclaw_enable=YES`

Commit: `hardening(6A): add FreeBSD rc.d service script`

## Section 6B: Generate jail.conf Files

**Cited by**: FreeBSD Expert #1
**File**: `src/jail-runtime.ts` — in `createJail()` (~line 1283-1313)

Instead of building a `jailParams` array and calling `sudo jail -c name=... param=...`, write a temp config file and call `sudo jail -f <file> -c <name>`:
```typescript
const confContent = `
${jailName} {
  path = "${jailPath}";
  host.hostname = "${jailName}";
  persist;
  enforce_statfs = 2;
  mount.devfs;
  devfs_ruleset = 10;
  securelevel = 3;
  ${networkConfig}
}`;
const confPath = path.join(JAIL_CONFIG.jailsPath, `${jailName}.conf`);
fs.writeFileSync(confPath, confContent);
await sudoExec(['jail', '-f', confPath, '-c', jailName]);
```

Clean up conf file in `destroyJail()`.

**Tests**: `src/jail-runtime.test.ts` — update jail creation mocks.

Commit: `hardening(6B): generate jail.conf files instead of inline params`

## Section 6C: Parameterize Hardcoded Paths

**Cited by**: DevOps, Newbie
**File**: `src/jail-runtime.ts:128-156`

Replace hardcoded `/home/jims/code/nanoclaw/` paths with env-var-configurable values:
```typescript
const NANOCLAW_ROOT = process.env.NANOCLAW_ROOT || '/home/jims/code/nanoclaw';
export const JAIL_CONFIG: JailConfig = {
  jailsPath: process.env.NANOCLAW_JAILS_PATH || path.join(NANOCLAW_ROOT, 'jails'),
  workspacesPath: process.env.NANOCLAW_WORKSPACES_PATH || path.join(NANOCLAW_ROOT, 'workspaces'),
  ipcPath: process.env.NANOCLAW_IPC_PATH || path.join(NANOCLAW_ROOT, 'ipc'),
  // ...
};
```

Also update `scripts/setup-jail-template.sh` to read `NANOCLAW_ROOT` env var.

**Tests**: `src/jail-runtime.test.ts` — tests should still work since defaults match current values.

Commit: `hardening(6C): parameterize hardcoded paths in jail config`

## Section 6D: FreeBSD Platform Detection

**Cited by**: Newbie
**File**: `setup/platform.ts:8-15`

Change:
```typescript
export type Platform = 'macos' | 'linux' | 'freebsd' | 'unknown';
export function getPlatform(): Platform {
  const platform = os.platform();
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  if (platform === 'freebsd') return 'freebsd';
  return 'unknown';
}
```

Also update `getServiceManager()` (~line 91-99) to return `'rcd'` for FreeBSD.

**Tests**: `setup/platform.test.ts` — add test case for FreeBSD platform.

Commit: `hardening(6D): add FreeBSD platform detection`

## Section 6E: Blue/Green Template Updates

**Cited by**: DevOps P1-5, FreeBSD Expert #10
**Depends on**: Section 6C (parameterized paths)
**Files**: `src/jail-runtime.ts`, `scripts/setup-jail-template.sh`

1. `src/jail-runtime.ts:129` — make `templateDataset` configurable: `process.env.NANOCLAW_TEMPLATE_DATASET || 'zroot/nanoclaw/jails/template'`
2. `scripts/setup-jail-template.sh` — accept optional argument for template name (e.g., `./setup-jail-template.sh template-v2`). Build to new name; old template stays
3. To cut over: set `NANOCLAW_TEMPLATE_DATASET=zroot/nanoclaw/jails/template-v2` and restart. Old jails keep running on old clones

Commit: `hardening(6E): support blue/green template updates`

## Verification

- `npm run build && npm test`
- FreeBSD: `service nanoclaw start` works (6A)
- Verify parameterized paths default correctly (6C)

## PR

```
gh pr create --base main --head hardening/phase-6-freebsd-integration \
  --title "Phase 6: FreeBSD Integration"
```
