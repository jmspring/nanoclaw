# Shared Instructions for NanoClaw-BSD Refinement

All developer and QA subagents for this refinement MUST read this file before starting work. It defines the environment, conventions, and validation patterns common to all tickets.

---

## Environment Setup

```bash
# Working directory is always the worktree, e.g. /tmp/nanoclaw-nc-p1a
cd $WORKTREE_PATH

# Node.js and npm are available system-wide
node --version   # should show v24.x
npm --version

# The project builds with:
npm run build    # TypeScript compilation to dist/

# Tests run with:
npm test         # vitest run (all tests)
```

---

## Repository Context

- **Project**: NanoClaw-BSD -- FreeBSD jail fork of NanoClaw personal AI assistant
- **Language**: TypeScript (strict mode), targeting ES2022 / NodeNext
- **Runtime**: Node.js 24 on FreeBSD 15.0-RELEASE
- **Test framework**: Vitest 4
- **Linter**: ESLint 9 (flat config) + Prettier
- **Logger**: pino with rotating file stream

### Key Directories

```
src/                     ← Main source code
src/jail/                ← FreeBSD jail runtime modules (fork-only)
src/channels/            ← Channel registry and implementations
etc/                     ← pf rules, devfs.rules, rc.d script
scripts/                 ← setup-freebsd.sh, setup-jail-template.sh
container/               ← Docker container build (Dockerfile, build.sh)
docs/                    ← Project documentation
.tickets/                ← Ticket files (YAML frontmatter, managed via tk)
analysis/                ← Prior expert analyses and design documents
reports/                 ← Multi-persona review reports (do not commit)
```

### Key Files (Read Before Modifying)

| File | Purpose | Upstream Risk |
|------|---------|--------------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation | HIGH -- most upstream merge conflicts |
| `src/container-runner.ts` | Docker runner + jail dispatch | HIGH -- shared with upstream |
| `src/container-runtime.ts` | Runtime detection, proxy bind host | MEDIUM -- fork additions |
| `src/credential-proxy.ts` | HTTP proxy for agent API auth | HIGH -- deleted in upstream |
| `src/runner-common.ts` | Shared agent process lifecycle | FORK-ONLY (no upstream equivalent) |
| `src/jail/lifecycle.ts` | Jail create/stop/destroy, ZFS clones | FORK-ONLY |
| `src/jail/runner.ts` | Jail-specific agent runner | FORK-ONLY |
| `src/jail/network.ts` | vnet/epair, pf validation, DNS | FORK-ONLY |
| `src/jail/mounts.ts` | nullfs mount building and validation | FORK-ONLY |
| `src/jail/cleanup.ts` | Orphan detection, force teardown | FORK-ONLY |
| `src/jail/config.ts` | Jail configuration and env vars | FORK-ONLY |
| `src/jail/metrics.ts` | Health/metrics HTTP endpoint | FORK-ONLY |
| `src/jail/exec.ts` | Command execution inside jails | FORK-ONLY |
| `src/jail/sudo.ts` | Privileged command execution (DI) | FORK-ONLY |
| `src/jail/types.ts` | Shared jail type definitions | FORK-ONLY |
| `src/db.ts` | SQLite operations | LOW -- additive changes merge cleanly |
| `src/config.ts` | Trigger pattern, paths, intervals | MEDIUM -- fork adds config vars |
| `etc/pf-nanoclaw.conf` | Standalone pf firewall rules | FORK-ONLY |
| `etc/rc.d/nanoclaw` | FreeBSD rc.d service script | FORK-ONLY |

---

## Developer Subagent Rules

1. **Read before writing.** Always read the target file(s) before modifying them. Understand existing patterns.
2. **Minimal changes.** Only modify what the ticket requires. Do not refactor surrounding code, add comments to unchanged lines, or "improve" things outside scope.
3. **No commits.** The orchestrator handles commits after QA passes. Never run `git commit`.
4. **No pushes.** Never run `git push`.
5. **Test your changes.** Run `npm test` after implementation. If tests fail, fix them before reporting completion.
6. **Type-check your changes.** Run `npx tsc --noEmit` to verify TypeScript compiles.
7. **Lint your changes.** Run `npm run lint` and fix any errors in files you touched.
8. **Format your changes.** Run `npm run format:check` and fix formatting issues with `npx prettier --write <file>`.
9. **Report completion** with the exact string: `IMPLEMENTATION_COMPLETE`
10. **On QA_FAIL re-run:** Fix ONLY the listed failures. Do not rewrite working code. Report `FIXES_COMPLETE`.

---

## QA Subagent Rules

1. **Never modify files.** QA is read-only validation.
2. **Run ALL checks** listed in the ticket's QA prompt, not just the ones you think might fail.
3. **Report per-check results** as PASS or FAIL with details.
4. **Final output** must be exactly `QA_PASS` or `QA_FAIL` followed by the per-check breakdown.
5. **On re-run after fixes:** Re-run ALL checks, not just previously failing ones.
6. **If a check cannot be run** (e.g., requires FreeBSD and you're not on FreeBSD), report as `SKIP` with reason -- do not report as FAIL.

---

## Standard QA Checks

Every ticket's QA prompt should include these baseline checks plus ticket-specific checks:

```
BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only expected files
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords
```

---

## Coding Standards

### TypeScript

- Strict mode is enabled. Do not use `any` unless absolutely necessary.
- Use `execFileSync` / `execFile` for subprocess calls (not `exec` / `execSync` with shell interpolation) to prevent command injection.
- Use `const` by default. Only use `let` when reassignment is required.
- Error handling: catch specific errors, log with pino, and re-throw or handle. Do not swallow errors silently in catch blocks.
- Imports: use `.js` extensions for local imports (NodeNext module resolution).

### pf Rules (etc/pf-nanoclaw.conf)

- Every rule must have a comment explaining its purpose.
- Use macros (`$jail_net`, `$ext_if`, `$trusted_dns`) instead of hardcoded values.
- Use `<anthropic_api>` persistent table for IP ranges.
- The `jail_net` CIDR must be `/16` to cover the `10.99.0.0` - `10.99.255.255` address range.
- Test rule syntax with `sudo pfctl -nf etc/pf-nanoclaw.conf` (dry run).

### Shell Scripts (scripts/)

- Use `set -euo pipefail` at the top.
- Quote all variable expansions.
- Use functions for logical sections.
- Validate inputs before acting.
- Make scripts idempotent (safe to re-run).

### rc.d Scripts (etc/rc.d/)

- Follow FreeBSD rc.subr conventions.
- Declare `REQUIRE` dependencies (LOGIN, NETWORKING, pf).
- Use `required_dirs` and `required_files` for pre-start validation.
- Default user should be `nanoclaw`, not a personal username.

---

## Test Patterns

### Unit Tests (src/*.test.ts)

Tests use Vitest with mocks for system calls. The jail tests mock `sudo`, `jexec`, `zfs`, `jail`, `ifconfig` etc. via the dependency-injectable `sudo.ts` module.

Key patterns:
- Mock `execFileSync` from `child_process` for command execution tests
- Mock `fs` for file system tests
- Use `vi.spyOn()` for function-level mocking
- Use `beforeEach(() => vi.clearAllMocks())` to reset state between tests
- Jail tests are in `src/jail-*.test.ts` (lifecycle, mount security, network isolation, stress)

### Adding Tests for New Code

If your ticket adds new functions or modules:
1. Create a corresponding `.test.ts` file
2. Test the happy path and at least one error path
3. Mock external dependencies (filesystem, subprocess, network)
4. Run `npm test` to verify

---

## Ticket Lifecycle Reference

```
1. Orchestrator creates ticket:
   tk create '<title>' --type task --priority N --tags nanoclaw,phase-N

2. Orchestrator creates worktree:
   git worktree add /tmp/nanoclaw-<id> -b <id>-branch-name

3. Developer subagent runs in worktree:
   - Reads SHARED_INSTRUCTIONS.md
   - Reads ticket-specific developer prompt
   - Implements changes
   - Runs: npm test, npx tsc --noEmit, npm run lint, npm run format:check
   - Reports: IMPLEMENTATION_COMPLETE

4. QA subagent runs in same worktree:
   - Reads SHARED_INSTRUCTIONS.md
   - Reads ticket-specific QA prompt
   - Runs all checks (baseline + ticket-specific)
   - Reports: QA_PASS or QA_FAIL

5. On QA_PASS:
   - Orchestrator commits, pushes, closes ticket
   - TICKET_COMPLETE

6. On QA_FAIL (max 2 retries):
   - Developer subagent re-runs with QA_FAIL output prepended
   - Fixes only listed failures
   - Reports: FIXES_COMPLETE
   - QA re-runs all checks

7. After 3 failures: TICKET_BLOCKED
   - Worktree left intact for manual review

8. When all phase tickets complete:
   - Phase Integration QA runs on merged branches
   - Phase PR created via gh pr create
   - After merge: worktrees removed, branches pruned
```

---

## Commit Convention

```
<type>(nc-<ticket>): short imperative description
```

Types: `fix`, `feat`, `refactor`, `docs`, `chore`, `test`

Examples:
```
fix(nc-p1a): correct pf jail_net CIDR from /24 to /16
feat(nc-p4a): add OneCLI SDK shim for upstream merge compatibility
docs(nc-p7a): add unified FreeBSD getting started guide
chore(nc-p6d): delete stale hardening branches
```

One commit per ticket. Commit only after QA_PASS.

---

## Reference Documents

| Document | Path | When to Read |
|----------|------|-------------|
| Synthesis Report | `reports/synthesis_report.md` | For overall context and priorities |
| Phase Plan | `refinement/03252026/PHASE_PLAN.md` | For phase structure and dependencies |
| Product Manager Report | `reports/product_manager_report.md` | For completion status and gap analysis |
| BSD PM Report | `reports/nanoclaw_bsd_pm_report.md` | For FreeBSD-specific features and upstream sync |
| Maintainer Report | `reports/maintainer_report.md` | For code quality and upstream merge risks |
| SRE Report | `reports/sre_report.md` | For reliability and operational issues |
| FreeBSD Sysadmin Report | `reports/freebsd_sysadmin_report.md` | For jail security details |
| FreeBSD User Report | `reports/freebsd_user_report.md` | For documentation and UX issues |
| Docker vs Jails Report | `reports/docker_vs_jails_report.md` | For feature parity gaps |
| OneCLI Shim Design | `analysis/experts/onecli-design.md` | For Phase 4A implementation details |
| CLAUDE.md | `CLAUDE.md` | For project conventions and key file map |
