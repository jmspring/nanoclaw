# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `src/credential-proxy.ts` | HTTP proxy for agent API auth (jail hardening in phases 3/12H) |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/` | Skills loaded inside agent containers (browser, status, formatting) |
| `etc/pf-nanoclaw.conf` | Standalone pf firewall rules (FreeBSD) |
| `etc/pf-nanoclaw-anchor.conf` | Anchor-mode pf rules (FreeBSD) |
| `scripts/setup-freebsd.sh` | FreeBSD bootstrap script |
| `scripts/setup-jail-template.sh` | Jail ZFS template creation |
| `etc/rc.d/nanoclaw` | FreeBSD rc.d service script |

## Secrets / Credentials / Proxy (OneCLI)

API keys, secret keys, OAuth tokens, and auth credentials are managed by the OneCLI gateway — which handles secret injection into containers at request time, so no keys or tokens are ever passed to containers directly. Run `onecli --help`.

## Skills

Four types of skills exist in NanoClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Testing:
```bash
npm test             # vitest run (all tests)
npm run test:watch   # vitest watch mode
npm run lint         # ESLint
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw

# FreeBSD (rc.d)
sudo service nanoclaw start
sudo service nanoclaw stop
sudo service nanoclaw restart
# rc.d script: etc/rc.d/nanoclaw, installed to /usr/local/etc/rc.d/nanoclaw
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate channel fork, not bundled in core. Run `/add-whatsapp` (or `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git && git fetch whatsapp main && (git merge whatsapp/main || { git checkout --theirs package-lock.json && git add package-lock.json && git merge --continue; }) && npm run build`) to install it. Existing auth credentials and groups are preserved.

## FreeBSD Jail Runtime

This fork adds FreeBSD jail support as an alternative container runtime (`NANOCLAW_RUNTIME=jail`). Jail code lives in `src/jail/` (split into focused modules in phase 10). See [docs/FREEBSD_JAILS.md](docs/FREEBSD_JAILS.md) for deployment guide.

| Module | Purpose |
|--------|---------|
| `src/jail/lifecycle.ts` | Create, start, stop, destroy jails |
| `src/jail/exec.ts` | Execute commands inside jails |
| `src/jail/network.ts` | vnet/epair networking, pf integration |
| `src/jail/mounts.ts` | ZFS clones, nullfs mounts |
| `src/jail/cleanup.ts` | Orphan cleanup, force teardown |
| `src/jail/runner.ts` | Jail-specific agent runner |
| `src/jail/config.ts` | Jail configuration and env vars |
| `src/jail/metrics.ts` | Health/metrics endpoint |
| `src/jail/sudo.ts` | Privileged command execution |
| `src/jail/types.ts` | Shared types |

Key config env vars: `NANOCLAW_RUNTIME`, `NANOCLAW_JAIL_NETWORK_MODE`, `NANOCLAW_JAIL_SUBNET`, `NANOCLAW_EXT_IF`, `CREDENTIAL_PROXY_PORT`.

Tickets tracked in `.tickets/` (managed via `tk`). Straggler execution plan: `analysis/sync/stragglers-03252026-1.md`.

## Ticket and Worktree Hygiene

### Tickets
- Tickets live in `.tickets/` with YAML frontmatter (id, status, deps, tags). Managed via `tk`.
- Statuses: `open`, `in_progress`, `closed`.
- **When completing a ticket**: verify the work is on `main` (check `git log --oneline main | grep <ticket-id>`), then close: `sed -i '' 's/^status: open$/status: closed/' .tickets/<id>.md` (also handle `in_progress`).
- **Before starting a ticket**: always check if prior work exists — search git log, grep for the ticket ID, check for `/tmp/nanoclaw-<id>` worktrees. If the work is already merged, close the ticket and skip.
- **Never leave tickets open after merge.** This is the most common hygiene failure.

### Worktrees
- Subagent worktrees live in `.claude/worktrees/` and `/tmp/nanoclaw-*`.
- **After a ticket's worktree is merged to its phase branch or main**: remove the worktree with `git worktree remove <path>` and delete the tracking branch with `git branch -d <branch>`.
- **Stale worktree detection**: `git worktree list` shows all. If a worktree's branch is 0 ahead of main, it's stale and should be removed.
- **Do not accumulate worktrees.** Clean up after each phase PR merges.
- Current cleanup command: `git worktree list | grep -v "^/home" | awk '{print $1}' | xargs -I{} git worktree remove {}` (removes all worktrees outside the main checkout — review before running).

## Upstream

Upstream PRs to `qwibitai/nanoclaw` are always manual. Do not create upstream PRs automatically. Sync from upstream uses `/update-nanoclaw` or manual cherry-pick from `upstream/main` and `upstream/skill/native-credential-proxy`.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
