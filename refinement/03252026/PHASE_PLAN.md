# NanoClaw-BSD Refinement Phase Plan

**Date**: 2026-03-25
**Owner**: Product Owner / Lead Maintainer (jails fork)
**Source**: `reports/synthesis_report.md`, upstream friction analysis, 7-persona review
**Workflow**: Adapted from `pm-data/CLAUDE.md` ticket lifecycle

---

## Workflow Overview

Each ticket follows this lifecycle (adapted from pm-data/CLAUDE.md for the nanoclaw-bsd TypeScript/FreeBSD context):

```
1. CREATE TICKET    → tk create '<title>' --type task --priority N --tags nanoclaw,phase-N
2. CREATE WORKTREE  → git worktree add /tmp/nanoclaw-<id> -b <id>-branch-name
3. DEVELOPER AGENT  → Implements the ticket in the worktree. Ends with IMPLEMENTATION_COMPLETE.
4. QA AGENT         → Validates only (never modifies files). Ends with QA_PASS or QA_FAIL.
5a. QA_PASS         → Commit, push, close ticket. TICKET_COMPLETE.
5b. QA_FAIL         → Fix loop (max 2 retries), then TICKET_BLOCKED if still failing.
6. PHASE PR         → When all phase tickets pass, merge branches, create PR.
7. CLEANUP          → Remove worktrees, prune branches.
```

All prompts reference `SHARED_INSTRUCTIONS.md` for environment setup, coding standards, test patterns, and commit conventions.

---

## Phase Summary

| Phase | Name | Focus | Tickets | Dependencies |
|-------|------|-------|---------|-------------|
| 1 | Critical Security Fixes | Fix active security bugs identified by sysadmin and SRE | 4 | None |
| 2 | Jail Hardening | Add missing jail.conf params, fix cleanup bug, add .env shadow + global mount | 4 | Phase 1 |
| 3 | Operational Hardening | SQLite WAL, rc.d improvements, credential proxy body limit, sudoers tightening, devfs.rules install, pf path parameterization | 6 | Phase 1 |
| 4 | Upstream Merge Friction Reduction | OneCLI shim, extract shared runner code, remove grammy from core, sync upstream features | 4 | Phase 2 |
| 5 | CI/CD and Code Quality | FreeBSD CI, ESLint in CI, build step in CI, coverage enforcement, no-catch-all promotion | 4 | Phase 3 |
| 6 | Operational Maturity | Token persistence, health endpoint default, newsyslog, stale branch cleanup | 4 | Phase 3 |
| 7 | Documentation Consolidation | Unified FreeBSD getting started, anchor config fix, env var reference, install verification, debug checklist navigation | 5 | Phase 2 |
| 8 | FreeBSD-Native Features | ZFS snapshot rollback, rctl monitoring in metrics, jail persistence mode | 3 | Phase 6 |
| 9 | Advanced Security and Observability | CLAUDE.md integrity, structured alerting, DTrace integration, Capsicum sandboxing | 4 | Phase 5, 6 |
| 10 | Code Quality and Testing | index.ts tests, template versioning, deployment/DR docs | 4 | Phases 4, 5 |
| 11 | Operational Infrastructure | Off-host backup, ZFS snapshot cron, cpuset, additional rctl limits | 4 | Phases 6, 8 |
| 12 | Platform Features and Parity | Chromium addon, ZFS send/receive, blue/green automation, bhyve investigation | 4 | Phase 8 |

---

## Phase 1: Critical Security Fixes

**Priority**: P0 -- fix immediately
**Rationale**: The sysadmin and SRE reports independently identified these as active bugs affecting all multi-jail deployments right now.

| Stage | Ticket ID | Title | Files | Effort |
|-------|-----------|-------|-------|--------|
| 1A | nc-p1a | Fix pf jail_net CIDR from /24 to /16 | `etc/pf-nanoclaw.conf` | 1 line |
| 1B | nc-p1b | Fix credential proxy bind address for multi-jail | `src/container-runtime.ts` | ~10 lines |
| 1C | nc-p1c | Fix DNS resolver mismatch (jail resolv.conf vs pf trusted DNS) | `src/jail/lifecycle.ts` | ~10 lines |
| 1D | nc-p1d | Tighten epair pf rules to restrict destinations | `etc/pf-nanoclaw.conf` | ~10 lines |

**Acceptance**: All pf rules use correct /16 CIDR. Credential proxy reachable from any jail. DNS resolv.conf matches pf trusted servers. Epair rules restrict port 443 to anthropic_api table only.

---

## Phase 2: Jail Hardening

**Priority**: P1 -- high severity security gaps
**Rationale**: Missing jail.conf parameters create isolation bypass vectors. Cleanup bug and missing Docker parity features affect correctness.
**Depends on**: Phase 1

| Stage | Ticket ID | Title | Files | Effort |
|-------|-----------|-------|-------|--------|
| 2A | nc-p2a | Add missing jail.conf parameters (exec.clean, children.max=0, SysV IPC, etc.) | `src/jail/lifecycle.ts` | ~15 lines |
| 2B | nc-p2b | Fix cleanupByJailName() groupId derivation | `src/jail/lifecycle.ts` | ~5 lines |
| 2C | nc-p2c | Add .env shadowing in jail runner | `src/jail/runner.ts`, `src/jail/mounts.ts` | ~10 lines |
| 2D | nc-p2d | Add global memory mount for non-main groups in jail runner | `src/jail/runner.ts`, `src/jail/mounts.ts` | ~10 lines |

**Acceptance**: Jail.conf includes all deny/isolation params. Orphan cleanup correctly identifies jails. .env hidden from jail agents. Non-main groups can read global CLAUDE.md. All existing tests pass.

---

## Phase 3: Operational Hardening

**Priority**: P0-P1 -- reliability and privilege reduction
**Rationale**: SRE identified database corruption risk and process supervision gaps. Sysadmin identified sudoers as the single biggest security problem.
**Depends on**: Phase 1

| Stage | Ticket ID | Title | Files | Effort |
|-------|-----------|-------|-------|--------|
| 3A | nc-p3a | Enable SQLite WAL mode | `src/db.ts` | 2 lines |
| 3B | nc-p3b | Improve rc.d script (daemon -r, pf dependency, default user, required_files) | `etc/rc.d/nanoclaw` | ~20 lines |
| 3C | nc-p3c | Add request body size limit to credential proxy | `src/credential-proxy.ts` | ~15 lines |
| 3D | nc-p3d | Tighten sudoers to restrict commands to nanoclaw paths | `scripts/setup-freebsd.sh` | ~30 lines |
| 3E | nc-p3e | Install devfs.rules in setup-freebsd.sh | `scripts/setup-freebsd.sh` | ~15 lines |
| 3F | nc-p3f | Parameterize hardcoded path in pf config | `etc/pf-nanoclaw.conf` | ~5 lines |

**Acceptance**: DB opens in WAL mode. rc.d auto-restarts on crash, requires pf, defaults to generic user, validates required files. Proxy rejects bodies > 10MB. Sudoers restricts jexec/mount/umount/chmod/chown/cp to nanoclaw paths. devfs.rules installed by setup script. No hardcoded paths in pf config.

---

## Phase 4: Upstream Merge Friction Reduction

**Priority**: P2 -- highest ROI for long-term maintainability
**Rationale**: PM and Maintainer reports identify OneCLI shim as the single most impactful change. Extracting shared code and removing grammy further reduce the conflict surface.
**Depends on**: Phase 2 (jail runner changes settle before refactoring shared code)

| Stage | Ticket ID | Title | Files | Effort |
|-------|-----------|-------|-------|--------|
| 4A | nc-p4a | Build OneCLI SDK shim | `src/onecli-shim.ts` (new), `tsconfig.json` | ~120 lines |
| 4B | nc-p4b | Extract shared runner setup code (settings.json, skills sync) | `src/runner-setup.ts` (new), `src/container-runner.ts`, `src/jail/runner.ts` | ~50 lines net |
| 4C | nc-p4c | Remove grammy from core dependencies | `package.json` | Config change |
| 4D | nc-p4d | Sync 3 high-priority upstream features (per-group triggers, timezone validation, CLAUDE.md template) | `src/index.ts`, `src/config.ts`, `src/ipc.ts` | 2-3 hours |

**Acceptance**: OneCLI shim passes unit tests matching upstream SDK interface. Settings.json and skills sync logic exist in one place. grammy not in core package.json. Per-group triggers, TZ validation, and CLAUDE.md template creation work.

---

## Phase 5: CI/CD and Code Quality

**Priority**: P2 -- prevent regressions
**Rationale**: 2,920 lines of jail code are never tested in CI. ESLint not enforced. No build verification.
**Depends on**: Phase 3

| Stage | Ticket ID | Title | Files | Effort |
|-------|-----------|-------|-------|--------|
| 5A | nc-p5a | Add ESLint and build step to CI | `.github/workflows/ci.yml` | ~5 lines |
| 5B | nc-p5b | Add npm audit to CI | `.github/workflows/ci.yml` | ~3 lines |
| 5C | nc-p5c | Set up FreeBSD CI via Cirrus CI | `.cirrus.yml` (new) | Medium |
| 5D | nc-p5d | Add coverage thresholds and promote no-catch-all to error | `vitest.config.ts`, `eslint.config.js`, `.github/workflows/ci.yml` | ~15 lines |

**Acceptance**: CI runs lint, build, test, and audit. FreeBSD CI runs jail-specific tests on FreeBSD runner. Coverage thresholds enforced in CI. ESLint no-catch-all set to error.

---

## Phase 6: Operational Maturity

**Priority**: P2 -- production readiness gaps
**Rationale**: Token loss on restart is certain. Health endpoint is safe to enable. Stale branches add noise.
**Depends on**: Phase 3

| Stage | Ticket ID | Title | Files | Effort |
|-------|-----------|-------|-------|--------|
| 6A | nc-p6a | Add jail token persistence to survive restarts | `src/jail/lifecycle.ts`, `src/credential-proxy.ts` | ~60 lines |
| 6B | nc-p6b | Enable health endpoint by default | `src/config.ts` | 1 line |
| 6C | nc-p6c | Add newsyslog.conf for rc.d log rotation | `etc/newsyslog.d/nanoclaw.conf` (new), `scripts/setup-freebsd.sh` | ~10 lines |
| 6D | nc-p6d | Delete stale hardening branches | Git operations only | 1 command |

**Acceptance**: Tokens persist to `data/jail-tokens.json` and restore on startup. Health endpoint on by default. Logs rotate via newsyslog. No stale `hardening/*` or `phase-*/*` branches remain.

---

## Phase 7: Documentation Consolidation

**Priority**: P2 -- unlocks wider adoption
**Rationale**: User reviewer rated setup 6/10. Documentation fragmentation is the primary barrier.
**Depends on**: Phase 2

| Stage | Ticket ID | Title | Files | Effort |
|-------|-----------|-------|-------|--------|
| 7A | nc-p7a | Write unified "Getting Started with NanoClaw on FreeBSD" | `docs/GETTING_STARTED_FREEBSD.md` (new) | New document |
| 7B | nc-p7b | Fix anchor config for vnet/epair architecture | `etc/pf-nanoclaw-anchor.conf` | ~50 lines |
| 7C | nc-p7c | Create consolidated environment variable reference | `docs/ENV_REFERENCE.md` (new) | New document |
| 7D | nc-p7d | Add installation verification smoke test and document it | `scripts/verify-install.sh` (new), docs | ~40 lines |
| 7E | nc-p7e | Add FreeBSD navigation note to DEBUG_CHECKLIST.md | `docs/DEBUG_CHECKLIST.md` | ~3 lines |

**Acceptance**: Single getting-started doc covers prerequisites through first message. Anchor config uses epair (not lo1) and /16 CIDR. All jail env vars documented in one file. Smoke test script validates jail runtime works. Getting-started guide covers credential proxy, channel setup, log locations, and two-script relationship. DEBUG_CHECKLIST.md has FreeBSD navigation note.

---

## Phase 8: FreeBSD-Native Features

**Priority**: P3 -- differentiating features
**Rationale**: ZFS snapshot rollback is the single most differentiating feature possible. No Docker equivalent.
**Depends on**: Phase 6

| Stage | Ticket ID | Title | Files | Effort |
|-------|-----------|-------|-------|--------|
| 8A | nc-p8a | Add ZFS snapshot-based session rollback | `src/jail/snapshots.ts` (new), `src/jail/runner.ts`, `src/ipc.ts` | Medium |
| 8B | nc-p8b | Add rctl resource monitoring to metrics endpoint | `src/jail/metrics.ts` | ~30 lines |
| 8C | nc-p8c | Implement jail persistence mode | `src/jail/runner.ts`, `src/jail/lifecycle.ts`, `src/jail/config.ts` | Medium |

**Acceptance**: Snapshots taken before agent execution, configurable retention. Per-jail CPU/memory/process metrics in Prometheus format. Persistent jails survive between messages with idle timeout.

---

## Phase 9: Advanced Security and Observability

**Priority**: P3-P4 -- defense-in-depth and production observability
**Rationale**: Long-term hardening and differentiation from Docker runtime.
**Depends on**: Phase 5, Phase 6

| Stage | Ticket ID | Title | Files | Effort |
|-------|-----------|-------|-------|--------|
| 9A | nc-p9a | Add CLAUDE.md integrity checking | `src/container-runner.ts`, new util | Medium |
| 9B | nc-p9b | Add structured alerting via admin channel | `src/index.ts`, new module | Medium |
| 9C | nc-p9c | Add DTrace scripts for agent observability | `etc/dtrace/` (new), `src/jail/dtrace.ts` (new) | Large |
| 9D | nc-p9d | Capsicum sandboxing for credential proxy | `src/credential-proxy.ts`, native addon | Large |

**Acceptance**: CLAUDE.md hash verified before/after agent runs with alert on mismatch. Critical conditions push alerts to admin channel. DTrace scripts trace jail I/O and network. Credential proxy enters capability mode after bind.

---

## Phase 10: Code Quality and Testing

**Priority**: P2-P3 -- testing and documentation
**Rationale**: index.ts (895 lines) is the most complex module with zero tests. Template versioning, deployment SOP, and DR docs are operational gaps identified by the SRE and Maintainer reports.
**Depends on**: Phase 4 (upstream friction reduction), Phase 5 (CI/CD)

| Stage | Ticket ID | Title | Files | Effort |
|-------|-----------|-------|-------|--------|
| 10A | nc-p10a | Add index.ts tests | `src/index.ts`, `src/index.test.ts` (new) | ~200 lines |
| 10B | nc-p10b | Add template versioning | `scripts/setup-jail-template.sh`, `src/jail/lifecycle.ts` | ~30 lines |
| 10C | nc-p10c | Add deployment SOP documentation | `docs/DEPLOYMENT.md` (new) | New document |
| 10D | nc-p10d | Document disaster recovery procedure | `docs/DISASTER_RECOVERY.md` (new) | New document |

**Acceptance**: index.ts has >50% test coverage via new test file. Template build writes version metadata file; startup warns if stale. Deployment SOP covers standard deploy, blue/green, rollback, pre/post checks. DR doc covers ZFS pool, crash, pf, template, database, full rebuild, credentials.

---

## Phase 11: Operational Infrastructure

**Priority**: P3 -- production resilience
**Rationale**: SRE identified no off-host backup and no ZFS snapshot policy. Sysadmin identified missing cpuset pinning and additional rctl limits.
**Depends on**: Phase 6 (operational maturity), Phase 8 (FreeBSD features)

| Stage | Ticket ID | Title | Files | Effort |
|-------|-----------|-------|-------|--------|
| 11A | nc-p11a | Add off-host backup via zfs send | `scripts/backup-offhost.sh` (new), `docs/BACKUP.md` (new) | ~80 lines |
| 11B | nc-p11b | Add ZFS snapshot cron job for data directories | `etc/cron.d/nanoclaw-snapshots` (new), `scripts/setup-freebsd.sh` | ~15 lines |
| 11C | nc-p11c | Add cpuset pinning for jails | `src/jail/lifecycle.ts`, `src/jail/config.ts` | ~20 lines |
| 11D | nc-p11d | Add additional rctl limits | `src/jail/lifecycle.ts`, `src/jail/config.ts` | ~30 lines |

**Acceptance**: Off-host backup script uses incremental zfs send with SHA-256 verification. Cron job takes 4-hourly snapshots with 7-day retention (42 snapshots). cpuset pinning optional via NANOCLAW_JAIL_CPUSET env var. Additional rctl limits (readbps, writebps, openfiles, wallclock) configurable via env vars. cpuset and rctl additions don't conflict.

---

## Phase 12: Platform Features and Parity

**Priority**: P3-P4 -- differentiation and Docker parity
**Rationale**: Chromium is the primary Docker parity gap. ZFS send/receive enables template sharing. Blue/green automation reduces upgrade friction. bhyve investigation informs Linux compat strategy.
**Depends on**: Phase 8 (FreeBSD features)

| Stage | Ticket ID | Title | Files | Effort |
|-------|-----------|-------|-------|--------|
| 12A | nc-p12a | Add Chromium as optional jail template addon | `scripts/add-chromium-to-template.sh` (new) | ~60 lines |
| 12B | nc-p12b | Add ZFS send/receive for template distribution | `scripts/export-template.sh` (new), `scripts/import-template.sh` (new) | ~50 lines |
| 12C | nc-p12c | Implement blue/green template automation | `scripts/blue-green-template.sh` (new), `src/jail/config.ts` | ~80 lines |
| 12D | nc-p12d | Investigate bhyve runtime for Linux container compatibility | `docs/BHYVE_INVESTIGATION.md` (new) | Research ticket |

**Acceptance**: Chromium addon script installs pkg, sets browser env vars, re-snapshots. Export/import scripts use zfs send/receive with SHA-256 verification. Blue/green script automates build, verify, switch, cleanup. bhyve investigation doc contains go/no-go recommendation with feasibility analysis.

---

## Dependency Graph

```
Phase 1 (Critical Security)
  |
  +---> Phase 2 (Jail Hardening)
  |       |
  |       +---> Phase 4 (Upstream Friction) --+
  |       +---> Phase 7 (Documentation)       |
  |                                           +--> Phase 10 (Code Quality)
  +---> Phase 3 (Operational Hardening)       |
          |                                   |
          +---> Phase 5 (CI/CD) -------------+
          +---> Phase 6 (Ops Maturity) --+--> Phase 9 (Advanced)
                  |                      |
                  +---> Phase 8 (FreeBSD Features) --+--> Phase 11 (Ops Infra)
                                                     +--> Phase 12 (Platform)
```

---

## Execution Notes

1. **Phases 1 and 3 can run in parallel** -- they touch different files.
2. **Phases 2 and 3 can run in parallel** after Phase 1 completes -- Phase 2 touches jail/ files while Phase 3 touches db.ts, rc.d, credential-proxy, and scripts.
3. **Phase 4 must wait for Phase 2** -- the jail runner changes in 2C/2D must settle before extracting shared code in 4B.
4. **Phases 5, 6, and 7 can run in parallel** after their dependencies complete.
5. **Within each phase, stages A-D are independent** unless noted -- they can be run as parallel subagents.
6. **Phase 9 is optional** and should only be started after Phases 5+6 are stable.

---

## Ticket Naming Convention

```
nc-p{phase}{stage}  →  e.g., nc-p1a, nc-p4b
```

Branch naming:
```
refinement/p{phase}-{stage}-{short-description}
```

Commit convention:
```
fix(nc-p1a): correct pf jail_net CIDR from /24 to /16
```

---

## Success Criteria

| Metric | Current | Target |
|--------|---------|--------|
| Security score | 3.5/5 | 4.5/5 (after Phases 1-3) |
| Upstream compatibility score | 2.5/5 | 4/5 (after Phase 4) |
| Operational readiness score | 3/5 | 4/5 (after Phases 3, 5, 6) |
| Documentation score | 3.5/5 | 4.5/5 (after Phase 7) |
| FreeBSD integration score | 4/5 | 4.5/5 (after Phase 8) |
| Test coverage (index.ts) | 0% | >50% (after Phase 10) |
| Operational documentation | Partial | Complete (after Phase 10) |
| Backup/recovery automation | None | Automated (after Phase 11) |
| Feature parity with Docker | 90% | 95% (after Phase 12) |
| Overall | 3.6/5 | 4.3/5 |

---

## Known Backlog (Not Scheduled)

Items intentionally deferred. No concrete implementation plan.

### P4 Long-Term / Speculative
- Web dashboard (P4, PM)
- IPFW support as pf alternative (P4, BSD PM)
- MAC framework integration (P4, Sysadmin)
- auditd integration for OS-level audit trails (P4, Sysadmin)

### Not Ticketable
- Submit upstream PR src-e9mq (intentionally manual per CLAUDE.md)
- User ID mapping gap — jail uses uid 1000 vs Docker host UID (Low priority)
- Upstream sync cadence strategy (ongoing process decision)
- Anthropic SDK vendor lock-in (unavoidable, monitor)
