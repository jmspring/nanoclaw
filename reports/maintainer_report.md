# NanoClaw-BSD Maintainability Report

**Date:** 2026-03-25
**Branch:** `main` at commit `6122b16`
**Upstream:** `qwibitai/nanoclaw` (remote: `upstream`)
**Fork:** `jmspring/nanoclaw` (remote: `origin`)

---

## 1. Upstream Tracking

### Current Divergence

The fork has diverged significantly from upstream in both directions:

- **190 commits** on `upstream/main` not in `main` (upstream is ahead)
- **233 commits** on `main` not in `upstream/main` (fork is ahead)

The upstream has moved to a OneCLI-based architecture (replacing the credential proxy with `@onecli-sh/sdk`), while this fork retains the self-hosted credential proxy model and adds the entire FreeBSD jail runtime. This architectural split is the primary source of divergence.

### Merge Strategy

The fork uses a **manual cherry-pick/selective sync** strategy, documented in `CLAUDE.md` line 135:

> Upstream PRs to `qwibitai/nanoclaw` are always manual. Do not create upstream PRs automatically. Sync from upstream uses `/update-nanoclaw` or manual cherry-pick from `upstream/main` and `upstream/skill/native-credential-proxy`.

Evidence of this strategy is visible in the git history with numbered sync commits:
```
upstream(13A) through upstream(13K)
```

These sync commits cherry-pick specific files (`container-runner.ts`, `container-runtime.ts`, `index.ts`, `ipc.ts`) from upstream rather than merging entire branches.

### Assessment

The cherry-pick approach is reasonable given the architectural divergence (OneCLI vs self-hosted credential proxy), but it creates significant ongoing maintenance burden. Each upstream sync requires manual file-by-file comparison. The fork's version is `1.2.31` while upstream has reached `1.2.34`, indicating at least 3 version bumps of drift.

**Risk:** Upstream is actively receiving community PRs (Telegram DM backfill, CI fork guards, Emacs channel skill, per-group triggers, etc.) that this fork will not automatically inherit. The 190-commit gap will continue growing.

### Open Upstream Ticket

File `.tickets/src-e9mq.md` contains the sole remaining open ticket:
```
# Submit upstream PR to qwibitai/nanoclaw
```
This has a dependency on `src-bvrj` and has not been acted on.

---

## 2. Feature and Functionality Gaps with Upstream

### Features in Upstream, Missing from Fork

Based on `git log main..upstream/main`, the fork is missing:

1. **OneCLI integration** -- Upstream replaced the self-hosted credential proxy with OneCLI SDK (`@onecli-sh/sdk`). The fork deliberately retains the credential proxy (`src/credential-proxy.ts`, 229 lines).
2. **Version bumps** -- Upstream is at `1.2.34`; fork is at `1.2.31`.
3. **Emacs channel skill** (`feat(skill): add Emacs channel skill`)
4. **Channel-formatting skill** (`feat(skill): add channel-formatting skill`)
5. **macOS status bar skill** (`add-macos-statusbar`)
6. **Telegram DM backfill fix** (`fix/1272-telegram-dm-backfill`)
7. **Telegram topics fix** (`fix/telegram-topics`)
8. **CI fork guards** (`fix/ci-fork-guards`)
9. **Setup mount allowlist preservation** (`fix/setup-preserve-mount-allowlist`)
10. **Per-group trigger support** (`fix-issue-1141-per-group-trigger`)
11. **Enable-linger clean fix** (`fix/enable-linger-clean`)
12. **Various contributor additions and documentation updates**

### Features in Fork, Missing from Upstream

The fork's primary addition is the **FreeBSD jail runtime** (~2,920 lines across 11 modules in `src/jail/`):

1. **Jail lifecycle management** (`src/jail/lifecycle.ts`, 669 lines) -- ZFS clone, jail create/stop/destroy
2. **vnet networking** (`src/jail/network.ts`, 333 lines) -- epair management, pf integration, DNS
3. **Nullfs mounts** (`src/jail/mounts.ts`, 271 lines) -- mount validation, fstab generation
4. **Jail exec** (`src/jail/exec.ts`, 182 lines) -- command execution inside jails
5. **Orphan cleanup** (`src/jail/cleanup.ts`, 257 lines) -- stale jail detection
6. **Health metrics** (`src/jail/metrics.ts`, 291 lines) -- Prometheus-compatible endpoint
7. **Jail runner** (`src/jail/runner.ts`, 244 lines) -- agent runner for jail runtime
8. **Shared runner logic** (`src/runner-common.ts`, 492 lines) -- extracted from container-runner.ts to share between Docker and jail
9. **Credential proxy hardening** -- jail token auth, per-IP rate limiting, path validation
10. **Log rotation** (`src/log-rotation.ts`, 169 lines)
11. **Structured logging** (`src/logger.ts`, 68 lines) -- pino with trace IDs
12. **FreeBSD-specific scripts** -- `scripts/setup-freebsd.sh` (30K), `scripts/setup-jail-template.sh` (13K), `scripts/switch-network-mode.sh` (8K)
13. **pf firewall rules** -- `etc/pf-nanoclaw.conf` (13K), `etc/pf-nanoclaw-anchor.conf` (2.6K)
14. **rc.d service script** -- `etc/rc.d/nanoclaw`
15. **Extensive FreeBSD documentation** -- `docs/FREEBSD_JAILS.md` (40K), `docs/LINUX_TO_FREEBSD.md`, `docs/TEMPLATE_SETUP.md`, `docs/SUDOERS.md`

---

## 3. Code Quality and Maintainability Assessment

### Source Code Statistics

| Category | Files | Lines |
|----------|-------|-------|
| Core source (`src/*.ts`, non-test) | 22 | ~6,738 |
| Jail modules (`src/jail/*.ts`) | 11 | ~2,920 |
| Channel modules (`src/channels/*.ts`) | 3 | ~345 |
| Test files | 23 | 6,989 |
| **Total** | **59** | **~15,015** |

### Strengths

1. **Well-structured module decomposition.** The jail runtime is cleanly split into focused modules (`lifecycle.ts`, `network.ts`, `mounts.ts`, `exec.ts`, `cleanup.ts`), each with a single responsibility. The barrel export in `src/jail/index.ts` (line 17-27) carefully documents the module structure and only re-exports what's needed externally.

2. **Clean runtime abstraction.** The `container-runtime.ts` module provides runtime detection (`getRuntime()`, line 15-22) that cleanly dispatches between jail/docker/apple. The `runner-common.ts` module (492 lines) extracts shared process lifecycle management, preventing code duplication between Docker and jail runners.

3. **Defense-in-depth security.** Mount validation is done at multiple layers:
   - `mount-security.ts` (419 lines) validates against an external allowlist
   - `src/jail/mounts.ts` line 15-66 performs secondary validation including path traversal checks and blocked pattern matching
   - `assertMountWithinJail()` (line 185-202) prevents jail root escapes
   - Credential proxy uses per-jail tokens, rate limiting, path validation, and source IP filtering

4. **TypeScript strict mode.** `tsconfig.json` enables `strict: true` (line 9). The ESLint config enforces `no-catch-all` and strict unused variable rules.

5. **No technical debt markers.** Zero instances of `TODO`, `FIXME`, `HACK`, `XXX`, or `WORKAROUND` in any `.ts` source file.

6. **Clean ticket hygiene.** Only 1 ticket remains open (`src-e9mq`). All others are closed.

7. **No stale worktrees.** `git worktree list` shows only the main checkout -- all temporary worktrees have been cleaned up.

### Concerns

1. **`index.ts` complexity.** At 895 lines, `src/index.ts` is the largest single file. It handles state management, message loop, agent execution, graceful shutdown, remote control, channel setup, and admin alerting. The signal handler re-wrapping pattern (lines 870-881) where `shutdownWithCleanup` replaces the original `shutdown` handler is fragile.

2. **Module-level mutable state.** Several modules rely on mutable module-level variables:
   - `src/index.ts`: `lastTimestamp`, `sessions`, `registeredGroups`, `lastAgentTimestamp`, `messageLoopRunning`, `consecutiveAgentFailures`, `adminAlertFn` (lines 76-88)
   - `src/jail/lifecycle.ts`: `activeJails`, `jailTokens`, `jailTempDirs` (lines 41-47)
   - `src/jail/network.ts`: `assignedEpairs` (line 16)
   - `src/credential-proxy.ts`: `validTokens`, `rateLimitMap` (lines 52, 64)

   This makes unit testing harder and creates hidden coupling.

3. **Duplicated settings.json generation.** Both `container-runner.ts` (lines 113-135) and `jail/runner.ts` (lines 60-76) independently create the Claude Code settings file with identical content. This should be extracted to a shared function.

4. **Duplicated skills sync logic.** Both `container-runner.ts` (lines 137-149) and `jail/runner.ts` (lines 78-90) have identical skill directory copy logic. Same extraction opportunity.

5. **Empty catch blocks.** Several catch blocks silently swallow errors:
   - `container-runner.ts` line 147: `try { fs.cpSync(...) } catch {}`
   - `jail/runner.ts` line 88: `try { fs.cpSync(...) } catch {}`
   - Multiple instances in `jail/lifecycle.ts` and `jail/cleanup.ts`

   The ESLint `no-catch-all` rule is set to `warn`, not `error`, so these pass CI.

6. **`grammy` dependency is still in `package.json`** (line 27) even though Telegram is present as a channel. This dependency was explicitly removed from upstream in commit `63f680d` ("chore: remove grammy and pin better-sqlite3/cron-parser versions") but was re-added. This adds ~5MB to node_modules for functionality that is optional.

7. **Stale hardening branches.** `git branch -a` shows 17 local branches from the hardening phases that have been merged but not deleted:
   ```
   hardening/phase-10-container-backend-interface
   hardening/phase-10-jail-dead-code-removal
   hardening/phase-10-jail-module-split
   ... (14 more)
   ```

---

## 4. Dependency Management

### Runtime Dependencies (7)

| Dependency | Version | Purpose | Assessment |
|-----------|---------|---------|------------|
| `better-sqlite3` | `^11.8.1` | SQLite operations | Core, pinned appropriately |
| `cron-parser` | `^5.5.0` | Cron expression parsing | Core, pinned appropriately |
| `grammy` | `^1.39.3` | Telegram bot SDK | Adds weight; should be optional (channel skill) |
| `pino` | `^9.6.0` | Structured logging | Fork-specific addition, good choice |
| `pino-pretty` | `^13.0.0` | Log formatting | Should be devDependency unless used in prod |
| `rotating-file-stream` | `^3.2.9` | Log rotation | Fork-specific, reasonable |
| `yaml` | `^2.8.2` | YAML parsing (tickets) | Reasonable |
| `zod` | `^4.3.6` | Runtime validation | Used for ContainerConfig schema |

### Dev Dependencies (10)

Standard modern TypeScript toolchain: ESLint 9, Prettier, Vitest 4, Husky, tsx. All versions are recent (2025/2026 releases).

### Observations

1. **`pino-pretty`** is listed as a runtime dependency but is typically only needed for development/debugging. In production, structured JSON logs are piped to log aggregators. Consider moving to `devDependencies`.

2. **`grammy`** makes Telegram a core dependency rather than an optional channel. Upstream handled this by removing grammy from core and making Telegram a separate fork (`nanoclaw-telegram`). This fork has the Telegram remote configured but grammy is still in core `package.json`. This creates an unnecessary dependency for users who don't want Telegram.

3. **`zod` v4** (`^4.3.6`) is very new (released ~June 2025). This is only used in `db.ts` line 16 for `ContainerConfigSchema`. The caret range means it could auto-upgrade to any 4.x version, which is fine but worth monitoring for breaking changes.

4. **No `package-lock.json` audit** was performed, but the lock file exists (mentioned in merge conflict handling in README.md line 94).

---

## 5. Test Coverage Assessment

### Test File Inventory

| Test File | Lines | Coverage Area |
|-----------|-------|--------------|
| `telegram.test.ts` | 949 | Telegram channel (most comprehensive) |
| `ipc-auth.test.ts` | 687 | IPC authorization (per-group auth) |
| `db.test.ts` | 585 | Database operations |
| `group-queue.test.ts` | 484 | Per-group concurrency queue |
| `credential-proxy.test.ts` | 469 | Credential proxy security |
| `jail-network-isolation.test.ts` | 458 | Jail network (pf, epair) |
| `remote-control.test.ts` | 397 | Remote control |
| `jail-mount-security.test.ts` | 353 | Jail mount path validation |
| `container-runner.test.ts` | 330 | Docker container runner |
| `jail-runtime.test.ts` | 246 | Jail lifecycle/runner |
| `formatting.test.ts` | 256 | Message formatting |
| `jail-stress.test.ts` | 231 | Jail concurrency stress |
| `sender-allowlist.test.ts` | 216 | Sender allowlist |
| `container-runtime.test.ts` | 188 | Runtime detection |
| `routing.test.ts` | 170 | Message routing |
| `task-scheduler.test.ts` | 129 | Task scheduling |
| `group-folder.test.ts` | 83 | Group folder resolution |
| `registry.test.ts` | 42 | Channel registry |
| `timezone.test.ts` | 29 | Timezone helpers |
| `platform.test.ts` (setup/) | 122 | Platform detection |
| `register.test.ts` (setup/) | 257 | Group registration |
| `service.test.ts` (setup/) | 187 | Service management |
| `environment.test.ts` (setup/) | 121 | Environment setup |

**Total: 6,989 lines of tests across 23 files.**

### Coverage Gaps

1. **No tests for `index.ts`** (895 lines, 0 test lines). The orchestrator is the most complex module and has zero direct test coverage. The `isDirectRun` guard (line 885-888) was added to prevent tests from accidentally starting the main loop, but no mock-based tests exist for `processGroupMessages`, `runAgent`, or the message loop logic.

2. **No tests for `runner-common.ts`** (492 lines, 0 test lines). The shared runner logic is only tested indirectly through `container-runner.test.ts` and `jail-runtime.test.ts`.

3. **No tests for `log-rotation.ts`** (169 lines), `logger.ts` (68 lines), `env.ts` (42 lines), or `mount-security.ts` (419 lines -- though `jail-mount-security.test.ts` covers the jail-specific mount validation).

4. **No tests for any jail module directly.** The jail tests (`jail-runtime.test.ts`, `jail-network-isolation.test.ts`, `jail-mount-security.test.ts`, `jail-stress.test.ts`) are in `src/` rather than `src/jail/`, and they test the jail system from the outside. Individual module functions (`lifecycle.ts`, `exec.ts`, `network.ts`, `cleanup.ts`) are not unit tested.

5. **No integration tests.** All tests use mocks. There are no end-to-end tests that verify a real message flows from channel through SQLite through container/jail and back.

6. **No coverage enforcement.** While `@vitest/coverage-v8` is installed as a devDependency, the vitest config (`vitest.config.ts`) does not configure any coverage thresholds. The CI workflow (`ci.yml`) runs `npx vitest run` without `--coverage`.

### Test-to-Code Ratio

- **Source lines (excluding tests):** ~8,026
- **Test lines:** 6,989
- **Ratio:** ~0.87:1 (good)

The ratio is healthy overall, but the coverage is unevenly distributed. Security-sensitive code (credential proxy, mount security, IPC auth) is well-tested. Core orchestration and runner logic is not.

---

## 6. Documentation Completeness

### Documentation Inventory

| Document | Lines | Content |
|----------|-------|---------|
| `CLAUDE.md` | 140 | Project instructions for Claude Code |
| `README.md` | 239 | Project overview, philosophy, setup |
| `CONTRIBUTING.md` | 147 | Contribution guidelines, skill types |
| `docs/REQUIREMENTS.md` | 197 | Architecture decisions |
| `docs/FREEBSD_JAILS.md` | ~1,200+ | FreeBSD jail deployment guide |
| `docs/LINUX_TO_FREEBSD.md` | ~200 | Translation guide for Docker users |
| `docs/TEMPLATE_SETUP.md` | ~300 | Jail template creation |
| `docs/SUDOERS.md` | ~300 | Sudo configuration |
| `docs/SPEC.md` | ~900 | Architecture specification |
| `docs/SECURITY.md` | ~200 | Security model |
| `docs/DEBUG_CHECKLIST.md` | ~200 | Debug reference |
| `docs/FREEBSD_JAIL_CLEANUP_PLAN.md` | ~120 | Cleanup architecture |
| `docs/JAIL_PACKAGE_UPDATES.md` | ~200 | Package update procedures |
| `docs/SDK_DEEP_DIVE.md` | ~700 | Claude Agent SDK analysis |

### Assessment

Documentation is comprehensive, particularly for the FreeBSD jail runtime. The `FREEBSD_JAILS.md` guide at ~40KB is thorough. The `LINUX_TO_FREEBSD.md` translation guide is a thoughtful addition for Docker-familiar users.

**Gaps:**
1. No API documentation or JSDoc coverage for exported functions. The codebase relies on Claude Code to answer questions about the code rather than self-documenting.
2. No changelog or release notes specific to the BSD fork. The `CHANGELOG.md` reference in README points to upstream.
3. `docs/FREEBSD_JAIL_CLEANUP_PLAN.md` describes a plan that appears to have been executed -- this document should be archived or updated with the outcome.

---

## 7. Technical Debt Inventory

### Quantified Items

1. **Zero `TODO`/`FIXME`/`HACK` markers** -- The codebase is clean of flagged debt.

2. **17 stale local branches** from hardening phases (e.g., `hardening/phase-3-proxy-hardening`, `hardening/phase-10-jail-module-split`, `phase-1/codebase-analysis`). These should be deleted with:
   ```bash
   git branch -d hardening/phase-{3,4,5,6,7,8,9}-* hardening/phase-10-* phase-{1,4,5,6}/*
   ```

3. **Duplicated code between Docker and jail runners:**
   - Settings JSON creation: `container-runner.ts` lines 113-135 and `jail/runner.ts` lines 60-76
   - Skills sync logic: `container-runner.ts` lines 137-149 and `jail/runner.ts` lines 78-90
   - Estimated deduplication: ~50 lines

4. **Signal handler re-wrapping** in `index.ts` lines 870-881 -- The shutdown handler is installed, then removed and reinstalled with a wrapper. This is fragile. A cleaner pattern would be a shutdown hook registry.

5. **`grammy` in core dependencies** -- Should be moved to the Telegram channel skill branch.

6. **Empty catch blocks** -- At least 6 instances across `container-runner.ts`, `jail/runner.ts`, `jail/lifecycle.ts`, and `jail/cleanup.ts` silently swallow errors.

7. **`pino-pretty` as runtime dep** -- Should be `devDependencies`.

8. **Version mismatch with upstream** -- Fork is `1.2.31`, upstream is `1.2.34`. The version field in `package.json` needs a strategy (track upstream version, or use a fork-specific version scheme).

---

## 8. Build System and CI/CD Assessment

### Build Configuration

- **TypeScript:** Target ES2022, NodeNext module system, strict mode. Clean, standard config.
- **Vitest:** Minimal config with test file discovery via glob. No coverage thresholds.
- **ESLint 9:** Flat config (`eslint.config.mjs`) with TypeScript support, `no-catch-all` plugin. Rules are sensible.
- **Prettier:** Integrated via `format:check` script and husky pre-commit hook.

### CI/CD Pipeline

File: `.github/workflows/ci.yml` (9 lines of job config)

```yaml
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - Format check
      - Typecheck (tsc --noEmit)
      - Tests (vitest run)
```

### Assessment

1. **No FreeBSD CI.** The CI runs on `ubuntu-latest` only. Jail-specific tests are skipped on non-FreeBSD. There is no FreeBSD CI runner configured, meaning the entire jail runtime (2,920 lines) is never tested in CI. This is the most significant CI gap.

2. **No lint step in CI.** The `ci.yml` runs format check and typecheck but does not run `npm run lint` (ESLint). ESLint errors could be merged without detection.

3. **No coverage reporting.** Despite having `@vitest/coverage-v8` installed, CI does not generate or enforce coverage metrics.

4. **No build step.** CI runs `tsc --noEmit` for type checking but does not run `npm run build` to verify the actual build output works.

5. **Other workflows exist but are upstream-focused:**
   - `fork-sync-skills.yml` (fork skill syncing)
   - `merge-forward-skills.yml` (skill branch management)
   - `bump-version.yml` (version bumping)
   - `label-pr.yml` (PR labeling)
   - `update-tokens.yml` (token count badge)

---

## 9. Recommendations for Improving Maintainability

### High Priority

1. **Add FreeBSD CI.** Set up a FreeBSD CI runner (GitHub self-hosted runner or Cirrus CI, which offers native FreeBSD) that runs the jail-specific tests. Without this, the 2,920-line jail runtime has no automated verification.

2. **Add ESLint to CI.** Add `npm run lint` to `.github/workflows/ci.yml`. This is a one-line fix.

3. **Extract shared runner setup code.** Create a `runner-setup.ts` module containing the duplicated settings.json creation and skills sync logic from both `container-runner.ts` and `jail/runner.ts`. This reduces drift risk when upstream changes these patterns.

4. **Add `index.ts` tests.** Extract `processGroupMessages` and `runAgent` into a testable module, or at minimum add mock-based tests for the message processing pipeline. This is the highest-risk untested code.

5. **Clean up stale branches.** Delete the 17 merged hardening branches to reduce branch listing noise.

### Medium Priority

6. **Establish a version scheme.** Options:
   - Track upstream version with a suffix (e.g., `1.2.34-bsd.1`)
   - Use an independent version number
   - The current approach of staying on `1.2.31` while upstream moves ahead creates confusion

7. **Move `grammy` to optional.** Make it a peer/optional dependency or move it to the Telegram channel skill branch. This keeps core dependencies minimal.

8. **Add coverage thresholds.** Configure vitest to enforce a minimum coverage percentage (e.g., 60% statements) and fail CI if it drops.

9. **Fix empty catch blocks.** Either log the caught error at `debug` level or add a comment explaining why the error is expected and safe to ignore.

10. **Move `pino-pretty` to devDependencies.** It should not ship in production.

### Low Priority

11. **Create a sync tracking document.** Maintain a file that records which upstream commits have been synced and which were intentionally skipped (e.g., OneCLI-related). This makes future sync decisions faster.

12. **Archive completed plan documents.** Move `docs/FREEBSD_JAIL_CLEANUP_PLAN.md` to `docs/archive/` since the plan has been executed.

13. **Add JSDoc to exported functions.** At minimum, add JSDoc comments to the public API surface of `src/jail/` modules. This helps contributors unfamiliar with FreeBSD understand the system.

14. **Consider a monorepo structure.** If the jail runtime continues growing, consider moving `src/jail/` into a separate workspace package. This would allow independent versioning and clearer dependency boundaries.

---

## 10. Risk Areas for Future Upstream Merges

### High Risk

1. **`src/index.ts`** -- The orchestrator has the most divergence. Upstream switched to OneCLI (`@onecli-sh/sdk`), removed the credential proxy import, removed pino logger import, and changed the agent lifecycle. Any upstream changes to `index.ts` will require careful manual merge. The fork adds jail-specific startup (lines 606-614), health checks (lines 836-839), metrics (lines 609-614), session state persistence (lines 123-184), and log rotation (lines 850-857).

2. **`src/container-runner.ts`** -- This file now contains the Docker/jail dispatch logic (line 325-326). Upstream changes to container mount structure, tool lists, or args building will need careful adaptation to maintain jail parity.

3. **`src/credential-proxy.ts`** -- Upstream has removed this file entirely (replaced by OneCLI). Any upstream security improvements to API auth will need to be manually ported to this fork's credential proxy.

4. **`src/container-runtime.ts`** -- Contains jail detection logic. Upstream changes to runtime abstraction will conflict.

### Medium Risk

5. **`src/db.ts`** -- Schema migrations are append-only, so upstream schema changes should merge cleanly. However, the fork added `script` column migration (line 114-118) which needs to stay in sync.

6. **`src/config.ts`** -- The fork adds `HEALTH_ENABLED`, `METRICS_ENABLED`, `METRICS_PORT`, `LOG_ROTATION_*`, and `LOG_RETENTION_DAYS` (lines 100-125). Upstream config changes should merge without conflict unless they touch the same sections.

7. **`src/ipc.ts`** -- The fork added `onTasksChanged` callback (line 26) and `update_task` IPC type (line 378-441). Upstream IPC changes could conflict.

8. **`package.json`** -- Dependency version conflicts are the most common merge issue. The fork adds `pino`, `pino-pretty`, `rotating-file-stream`, `yaml`, and `zod`, plus keeps `grammy`. Upstream version bumps will cause conflicts in the `dependencies` section.

### Low Risk

9. **`src/router.ts`** -- Small, stable file (52 lines). Unlikely to conflict.
10. **`src/types.ts`** -- Type definitions are additive. The fork's `types.ts` matches upstream's structure.
11. **Skills and documentation** -- These are additive and rarely conflict.
12. **`src/channels/`** -- The channel registry pattern is stable. New upstream channels would merge cleanly.

### Structural Risks

- **`runner-common.ts`** is fork-only (492 lines). If upstream refactors its container runner, the fork will need to update `runner-common.ts` to match. This module has no upstream equivalent.
- **`src/jail/`** is entirely fork-only (2,920 lines, 11 modules). It has no merge conflict risk but depends on the interfaces defined in shared modules (`container-runner.ts`, `container-runtime.ts`, `types.ts`). If upstream changes these interfaces, all jail modules must be updated.
- **The `src/logger.ts` fork** (68 lines) adds `generateTraceId` and `createTracedLogger`. Upstream's `logger.ts` is simpler. This divergence will cause merge conflicts whenever upstream touches logging.

---

## Summary

The nanoclaw-bsd fork is well-engineered and well-maintained. The jail runtime is cleanly modularized, security measures are thorough, and test coverage is good for security-sensitive paths. The primary maintainability challenges are:

1. **Growing upstream divergence** (190 commits behind, widening due to OneCLI architectural split)
2. **No FreeBSD CI** for the fork's primary value-add (the jail runtime)
3. **`index.ts` complexity** (895 lines, zero tests, most upstream merge conflicts)
4. **Some duplicated code** between Docker and jail runners

The fork is in a good position to continue as an independent FreeBSD-focused distribution of NanoClaw, but maintaining upstream parity will require increasingly manual effort as the upstream project evolves around OneCLI.
