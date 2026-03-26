# Phase 6: Operational Maturity

**Priority**: P2 -- production readiness gaps
**Depends on**: Phase 3 (Operational Hardening)
**Rationale**: Token loss on restart is certain. Health endpoint is safe to enable. Main process logs lack newsyslog rotation. Stale branches add noise.

**Source reports**:
- `reports/product_manager_report.md` -- items 3, 4, 7 (token persistence, health default, newsyslog)
- `reports/sre_report.md` -- sections 4.1, 5.1, 10.3 (health endpoint, rc.d log rotation, newsyslog)
- `reports/maintainer_report.md` -- section 7 item 2 (17 stale hardening branches)
- `analysis/experts/onecli-design.md` -- lines 138-184 (token persistence design)

---

## Stage 6A: Jail Token Persistence Across Restarts

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p6a` |
| **Title** | Add jail token persistence to survive restarts |
| **Priority** | P2 |
| **Tags** | `nanoclaw`, `phase-6`, `security`, `reliability` |
| **Files** | `src/jail/lifecycle.ts`, `src/credential-proxy.ts`, `src/jail/index.ts` |
| **Dependencies** | Phase 3 complete (credential proxy body limit in place) |
| **Effort** | ~60 lines |

### Context

The credential proxy uses an in-memory `validTokens` Set (`src/credential-proxy.ts:52`) and the jail lifecycle module uses an in-memory `jailTokens` Map (`src/jail/lifecycle.ts:44`). When the orchestrator process restarts, both structures are cleared. Any jails that survived the restart (FreeBSD jails persist independently of the orchestrator) lose their credential proxy authentication. The `reconnectToRunningJails()` function in `src/jail/index.ts:39-56` re-tracks the jails in the `activeJails` set via `trackActiveJail()`, but does NOT restore their tokens. The jails are alive but credential-blind.

The epair networking module already solves an identical problem: `src/jail/network.ts:19` defines `EPAIR_STATE_FILE = path.join(DATA_DIR, 'epairs.json')`, and the `persistEpairState()` (lines 24-38) and `restoreEpairState()` (lines 43-98) functions persist the `assignedEpairs` Map to disk and restore it on startup, cross-referencing against actual system state (`ifconfig -l`). The token persistence implementation should follow this exact pattern.

The design is fully specified in `analysis/experts/onecli-design.md` lines 138-184, including the file format, startup restore algorithm, and security analysis.

### Developer Prompt

```
TICKET: nc-p6a — Add jail token persistence to survive restarts

Read SHARED_INSTRUCTIONS.md first.

CONTEXT:
After a process restart, running jails lose credential proxy authentication because
the jailTokens Map (src/jail/lifecycle.ts:44) and validTokens Set
(src/credential-proxy.ts:52) are in-memory only. The epair module already solves
this exact problem with data/epairs.json — follow that pattern.

Read these files before making changes:
  - src/jail/network.ts (lines 16-98 — the epairs.json persistence pattern to follow)
  - src/jail/lifecycle.ts (lines 40-47 — jailTokens Map; lines 353-356 — token creation;
    lines 596-602 — token revocation in finally block)
  - src/credential-proxy.ts (lines 51-59 — validTokens Set, registerJailToken,
    revokeJailToken)
  - src/jail/index.ts (lines 39-56 — reconnectToRunningJails; line 35 —
    listRunningNanoclawJails import)
  - src/jail/cleanup.ts (lines 77-92 — listRunningNanoclawJails implementation)
  - src/config.ts (line 49 — DATA_DIR)
  - analysis/experts/onecli-design.md (lines 138-184 — full design spec)

IMPLEMENTATION:

1. In src/jail/lifecycle.ts, add token persistence functions following the
   epairs.json pattern from network.ts:

   a. Add a constant for the state file path:
      const TOKEN_STATE_FILE = path.join(DATA_DIR, 'jail-tokens.json');
      (Import DATA_DIR from '../config.js' — it is already used by network.ts)

   b. Add persistTokenState() — serialize jailTokens Map to TOKEN_STATE_FILE
      using Object.fromEntries(). Wrap in try/catch, log warning on failure.
      Create the directory if it does not exist (match network.ts:26-29).

   c. Add restoreTokenState() (exported) — load TOKEN_STATE_FILE, cross-reference
      with actually running jails from listRunningNanoclawJails() (import from
      './cleanup.js'), re-register valid tokens with registerJailToken(), discard
      stale tokens for jails that are gone. Persist the cleaned state.
      Follow the same defensive pattern as restoreEpairState() in network.ts:43-98.

   d. Call persistTokenState() after token creation (after line 356, where
      registerJailToken is called).

   e. Call persistTokenState() after token revocation in the finally block
      (after line 601, where jailTokens.delete is called).

2. In src/jail/index.ts, update reconnectToRunningJails() to also restore
   token state:

   a. Import restoreTokenState from './lifecycle.js'.

   b. Call restoreTokenState() at the START of reconnectToRunningJails(),
      BEFORE the trackActiveJail loop. This ensures tokens are restored for
      jails that are still running, and stale tokens are discarded.

3. Do NOT modify src/credential-proxy.ts — token registration/revocation
   already works via the existing registerJailToken()/revokeJailToken() exports.

FILE FORMAT for data/jail-tokens.json:
{
  "groupA": "550e8400-e29b-41d4-a716-446655440000",
  "groupB": "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
}

RESTORE ALGORITHM (from onecli-design.md):
1. Load data/jail-tokens.json
2. List running jails: listRunningNanoclawJails()
3. For each persisted token:
   - Derive jail name from groupId (getJailName(groupId))
   - If jail name is in the running list -> re-register token with registerJailToken()
     AND populate the in-memory jailTokens Map
   - If jail is gone -> discard token, log info
4. For each running jail NOT in persisted tokens:
   - Log warning: orphaned jail with no token (cleanup.ts will handle these)
5. Persist the cleaned state

TESTING:
Add tests to an existing or new test file. Test:
  - persistTokenState writes valid JSON to the expected file path
  - restoreTokenState loads and cross-references with running jails
  - Stale tokens (jail no longer running) are discarded
  - Valid tokens (jail still running) are re-registered
  - Missing file handled gracefully (first startup)
  - Corrupt file handled gracefully (logs warning, continues)
Mock fs and the jail list functions. Follow patterns in jail-runtime.test.ts.

Run: npm test, npx tsc --noEmit, npm run lint, npm run format:check

Report: IMPLEMENTATION_COMPLETE
```

### QA Prompt

```
TICKET: nc-p6a — QA validation for jail token persistence

Read SHARED_INSTRUCTIONS.md first. Never modify files.

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only expected files
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

TICKET-SPECIFIC CHECKS:

[ ] TOKEN_STATE_FILE constant exists in src/jail/lifecycle.ts, points to
    path.join(DATA_DIR, 'jail-tokens.json')

[ ] persistTokenState() function exists and:
    - Serializes jailTokens Map via Object.fromEntries()
    - Creates directory if missing (fs.mkdirSync with recursive:true)
    - Wrapped in try/catch with logger.warn on failure
    - Follows the same pattern as persistEpairState() in network.ts:24-38

[ ] restoreTokenState() function exists and is exported:
    - Loads TOKEN_STATE_FILE
    - Calls listRunningNanoclawJails() to get actual running jails
    - Calls getJailName() to derive jail name from groupId
    - Re-registers valid tokens via registerJailToken()
    - Populates jailTokens Map for valid entries
    - Discards tokens for jails that no longer exist
    - Calls persistTokenState() to save the cleaned state
    - Handles missing file (first startup) gracefully
    - Handles corrupt JSON gracefully (logs warning, does not throw)

[ ] persistTokenState() is called after token creation in createJail()
    (after the line calling registerJailToken)

[ ] persistTokenState() is called after token deletion in cleanupJail() finally block
    (after jailTokens.delete)

[ ] reconnectToRunningJails() in src/jail/index.ts calls restoreTokenState()

[ ] DATA_DIR is properly imported from '../config.js' in lifecycle.ts

[ ] listRunningNanoclawJails is imported from './cleanup.js' in lifecycle.ts
    (verify no circular dependency issues)

[ ] Tests exist for:
    - Persist writes valid JSON
    - Restore loads and cross-references running jails
    - Stale token discard
    - Valid token re-registration
    - Missing file handling
    - Corrupt file handling

[ ] No changes to src/credential-proxy.ts (existing register/revoke API is unchanged)

[ ] The word "token" does not appear in git diff in a way that exposes actual
    secret values — only variable names and UUIDs in test fixtures are acceptable

Report: QA_PASS or QA_FAIL with per-check breakdown.
```

---

## Stage 6B: Enable Health Endpoint by Default

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p6b` |
| **Title** | Enable health endpoint by default |
| **Priority** | P2 |
| **Tags** | `nanoclaw`, `phase-6`, `monitoring` |
| **Files** | `src/config.ts` |
| **Dependencies** | None (within phase) |
| **Effort** | 1 line (already done -- verify only) |

### Context

The DevOps and SRE reports both recommended enabling the health endpoint by default. The health endpoint binds to `127.0.0.1` only, is read-only, and exposes no sensitive data -- it checks ZFS template existence, pool space, and pf status. There is zero security risk in enabling it by default.

The Product Manager report (item 4) flagged this as a Priority 1 change: "Single-line change: `config.ts:102` -- change `'false'` to `'true'`."

**Current state**: Examining `src/config.ts:100`, the line reads:
```typescript
export const HEALTH_ENABLED = (process.env.HEALTH_ENABLED || 'true') === 'true';
```

This indicates the health endpoint is ALREADY enabled by default (the fallback is `'true'`). The PM report referenced a stale state. This ticket should verify the current state and confirm no change is needed, OR correct it if the value is still `'false'`.

### Developer Prompt

```
TICKET: nc-p6b — Enable health endpoint by default

Read SHARED_INSTRUCTIONS.md first.

CONTEXT:
The health endpoint should be enabled by default. It binds to 127.0.0.1, is
read-only, and poses no security risk.

Read src/config.ts and examine line 100 (HEALTH_ENABLED).

IMPLEMENTATION:
1. Read src/config.ts and check the HEALTH_ENABLED default value.

2. If the default fallback is already 'true':
   - No code change needed. The PM report referenced stale state.
   - Verify METRICS_ENABLED remains opt-in ('false' default) — these are
     separate concerns. Health checks basic liveness; metrics exposes
     Prometheus counters.
   - Report IMPLEMENTATION_COMPLETE with a note that no change was required.

3. If the default fallback is 'false':
   - Change the fallback from 'false' to 'true':
     BEFORE: (process.env.HEALTH_ENABLED || 'false') === 'true'
     AFTER:  (process.env.HEALTH_ENABLED || 'true') === 'true'
   - This allows operators to opt OUT via HEALTH_ENABLED=false if needed.

4. Verify that .env.example documents HEALTH_ENABLED with a comment
   indicating it defaults to true.

Run: npm test, npx tsc --noEmit, npm run lint, npm run format:check

Report: IMPLEMENTATION_COMPLETE
```

### QA Prompt

```
TICKET: nc-p6b — QA validation for health endpoint default

Read SHARED_INSTRUCTIONS.md first. Never modify files.

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only expected files
    (may be zero files if no change was needed)
[ ] No secrets or credentials in diff

TICKET-SPECIFIC CHECKS:

[ ] HEALTH_ENABLED in src/config.ts defaults to true when HEALTH_ENABLED env var
    is not set. Verify the expression evaluates to true when process.env.HEALTH_ENABLED
    is undefined.

[ ] HEALTH_ENABLED can be disabled by setting HEALTH_ENABLED=false (the expression
    evaluates to false when the env var is 'false').

[ ] METRICS_ENABLED in src/config.ts still defaults to false (opt-in). This must NOT
    have been changed — health and metrics are separate concerns.

[ ] .env.example documents HEALTH_ENABLED (search for the string)

[ ] If no code change was made (already defaulting to true), verify git diff is empty
    or shows only non-functional changes.

Report: QA_PASS or QA_FAIL with per-check breakdown.
```

---

## Stage 6C: Add newsyslog Configuration for rc.d Log Rotation

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p6c` |
| **Title** | Add newsyslog.conf for rc.d log rotation |
| **Priority** | P2 |
| **Tags** | `nanoclaw`, `phase-6`, `operations`, `freebsd` |
| **Files** | `etc/newsyslog.d/nanoclaw.conf` (new), `scripts/setup-freebsd.sh` |
| **Dependencies** | None (within phase) |
| **Effort** | ~10 lines |

### Context

The rc.d service script (`etc/rc.d/nanoclaw:27`) directs daemon stdout/stderr to `/var/log/nanoclaw.log` via `daemon -o /var/log/nanoclaw.log`. This file grows indefinitely because there is no rotation configured for it. The application has its own internal log rotation (via pino + rotating-file-stream in `src/log-rotation.ts`), but that handles only the application-level logs in `logs/nanoclaw.log`, not the daemon-level stdout/stderr capture.

The SRE report (section 5.1, item 4) explicitly identified this gap and recommended:
```
/var/log/nanoclaw.log   nanoclaw:wheel 640 7 * @T00 JC
```

FreeBSD's `newsyslog(8)` is the standard mechanism for rotating log files. Configuration can be placed in `/etc/newsyslog.conf` or in individual files under `/usr/local/etc/newsyslog.conf.d/` (the standard drop-in directory).

The `scripts/setup-freebsd.sh` script is the integration point -- it already installs the rc.d script (section 9), and should also install the newsyslog configuration during setup.

### Developer Prompt

```
TICKET: nc-p6c — Add newsyslog.conf for rc.d log rotation

Read SHARED_INSTRUCTIONS.md first.

CONTEXT:
The rc.d script directs daemon output to /var/log/nanoclaw.log, but this file has
no rotation configured. FreeBSD uses newsyslog(8) for log rotation. We need to ship
a newsyslog config file and install it during setup.

Read these files:
  - etc/rc.d/nanoclaw (line 27 — daemon -o /var/log/nanoclaw.log)
  - scripts/setup-freebsd.sh (look for the rc.d installation section, around line 640+)

IMPLEMENTATION:

1. Create etc/newsyslog.d/nanoclaw.conf with the following content:

   # NanoClaw daemon log rotation
   # Rotated daily at midnight, 7 archives, compressed with bzip2
   # Signal the daemon process via the PID file after rotation
   #
   # logfilename          owner:group  mode  count  size  when  flags  pid_file
   /var/log/nanoclaw.log  nanoclaw:wheel  640  7  *  @T00  JC  /var/run/nanoclaw.pid

   Field explanation:
   - /var/log/nanoclaw.log: the log file to rotate
   - nanoclaw:wheel: ownership after rotation (match the service user)
   - 640: permissions (owner read+write, group read)
   - 7: keep 7 rotated copies
   - *: no size limit (rotate based on time only)
   - @T00: rotate daily at midnight
   - J: compress rotated files with bzip2
   - C: create the log file if it does not exist after rotation
   - /var/run/nanoclaw.pid: PID file — newsyslog sends SIGHUP to notify the
     daemon. The daemon(8) wrapper will pass this through.

2. In scripts/setup-freebsd.sh, add newsyslog installation near the rc.d
   installation section. Find the section that copies the rc.d script
   (look for cp or install commands referencing etc/rc.d/nanoclaw) and add
   immediately after:

   # Install newsyslog configuration for log rotation
   NEWSYSLOG_DIR="/usr/local/etc/newsyslog.conf.d"
   if [ ! -d "$NEWSYSLOG_DIR" ]; then
       mkdir -p "$NEWSYSLOG_DIR"
       log_success "Created $NEWSYSLOG_DIR"
   fi
   SRC_NEWSYSLOG="$NANOCLAW_MOUNT/src/etc/newsyslog.d/nanoclaw.conf"
   if [ -f "$SRC_NEWSYSLOG" ]; then
       # Update owner field to match the configured nanoclaw user
       sed "s/nanoclaw:wheel/${NANOCLAW_USER}:wheel/" "$SRC_NEWSYSLOG" > "$NEWSYSLOG_DIR/nanoclaw.conf"
       log_success "Installed newsyslog config at $NEWSYSLOG_DIR/nanoclaw.conf"
   else
       log_skip "newsyslog config not found at $SRC_NEWSYSLOG"
   fi

   Make sure to use the $NANOCLAW_USER variable (or whatever variable the script
   uses for the service user) so the ownership field matches the configured user.

NOTES:
- The drop-in directory is /usr/local/etc/newsyslog.conf.d/ on FreeBSD
  (NOT /etc/newsyslog.conf.d/). Verify this is the correct path.
- newsyslog reads all .conf files in this directory automatically.
- The PID file path must match the pidfile in the rc.d script (/var/run/nanoclaw.pid).
- Do NOT modify the rc.d script itself — it is correct as-is.

Run: npm test, npx tsc --noEmit, npm run lint, npm run format:check
(These are TypeScript checks; the shell script and conf file are not linted by
npm, but verify they are syntactically valid by inspection.)

Report: IMPLEMENTATION_COMPLETE
```

### QA Prompt

```
TICKET: nc-p6c — QA validation for newsyslog configuration

Read SHARED_INSTRUCTIONS.md first. Never modify files.

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only expected files
    (etc/newsyslog.d/nanoclaw.conf, scripts/setup-freebsd.sh)
[ ] No secrets or credentials in diff

TICKET-SPECIFIC CHECKS:

[ ] etc/newsyslog.d/nanoclaw.conf exists and is a new file

[ ] The newsyslog config file specifies /var/log/nanoclaw.log as the log file

[ ] The ownership field is nanoclaw:wheel (or a reasonable default user)

[ ] The mode is 640 (owner rw, group r)

[ ] The rotation count is >= 7

[ ] The rotation trigger includes a time-based component (@T00 for daily at midnight)

[ ] Flags include J (bzip2 compression) and C (create if missing)

[ ] The pid_file field references /var/run/nanoclaw.pid (must match rc.d script's
    pidfile variable at etc/rc.d/nanoclaw:25)

[ ] The newsyslog config file has comments explaining the fields

[ ] scripts/setup-freebsd.sh was modified to install the newsyslog config

[ ] The setup script installs to /usr/local/etc/newsyslog.conf.d/ (the standard
    FreeBSD drop-in directory, NOT /etc/newsyslog.conf.d/)

[ ] The setup script creates the drop-in directory if it does not exist

[ ] The setup script substitutes the configured user for the ownership field
    (sed replacement or equivalent)

[ ] The setup script handles the case where the source config file does not exist
    (skip with warning, do not fail)

[ ] The PID file path in the newsyslog config (/var/run/nanoclaw.pid) matches
    the pidfile in etc/rc.d/nanoclaw (line 25: pidfile="/var/run/${name}.pid")

[ ] The rc.d script itself (etc/rc.d/nanoclaw) was NOT modified

Report: QA_PASS or QA_FAIL with per-check breakdown.
```

---

## Stage 6D: Delete Stale Hardening Branches

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p6d` |
| **Title** | Delete stale hardening branches |
| **Priority** | P3 |
| **Tags** | `nanoclaw`, `phase-6`, `hygiene` |
| **Files** | Git operations only (no source file changes) |
| **Dependencies** | None (within phase) |
| **Effort** | 1 command |

### Context

The Maintainer report (section 7, item 2) identified 17 stale local branches from hardening phases that have been merged to `main` but never deleted. These create noise in `git branch` output and can confuse contributors. The report provided the specific deletion command:

```bash
git branch -d hardening/phase-{3,4,5,6,7,8,9}-* hardening/phase-10-* phase-{1,4,5,6}/*
```

The branches follow two naming patterns:
- `hardening/phase-N-*` (e.g., `hardening/phase-10-container-backend-interface`, `hardening/phase-10-jail-dead-code-removal`, `hardening/phase-10-jail-module-split`, `hardening/phase-3-proxy-hardening`)
- `phase-N/*` (e.g., `phase-1/codebase-analysis`, `phase-4/*`, `phase-5/*`, `phase-6/*`)

All of these are confirmed merged to `main` -- the `-d` flag (lowercase) will refuse to delete unmerged branches, providing a safety net.

### Developer Prompt

```
TICKET: nc-p6d — Delete stale hardening branches

Read SHARED_INSTRUCTIONS.md first.

CONTEXT:
17 stale local branches from the hardening phases remain after merge. They add noise.
All are confirmed merged to main.

IMPLEMENTATION:

1. First, list all local branches to identify stale ones:
   git branch | grep -E '(hardening/|phase-[0-9])'

2. Verify each branch is fully merged into main:
   git branch --merged main | grep -E '(hardening/|phase-[0-9])'
   Only branches appearing in BOTH outputs should be deleted.

3. Delete merged branches using the safe -d flag (refuses to delete unmerged):
   git branch -d $(git branch --merged main | grep -E '(hardening/|phase-[0-9])' | tr -d ' ')

   If brace expansion is available, the maintainer report suggests:
   git branch -d hardening/phase-{3,4,5,6,7,8,9}-* hardening/phase-10-* phase-{1,4,5,6}/*

   Use whichever approach works. The key safety mechanism is -d (lowercase),
   which will abort if any branch is not fully merged.

4. Also check for any stale remote tracking branches:
   git branch -r | grep -E '(hardening/|phase-[0-9])'
   If remote tracking refs exist for branches that no longer exist on the remote:
   git remote prune origin

5. Verify cleanup:
   git branch | grep -E '(hardening/|phase-[0-9])'
   This should return no output.

NOTES:
- Do NOT delete the current branch (main).
- Do NOT delete any branch matching refinement/* — those are active.
- Do NOT use -D (uppercase) — that forces deletion of unmerged branches.
- Do NOT run git push — this is local cleanup only.
- There are no source file changes for this ticket.

Report: IMPLEMENTATION_COMPLETE with the count of branches deleted.
```

### QA Prompt

```
TICKET: nc-p6d — QA validation for stale branch cleanup

Read SHARED_INSTRUCTIONS.md first. Never modify files.

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows no changes
    (this ticket has no source file changes)
[ ] No secrets or credentials in diff

TICKET-SPECIFIC CHECKS:

[ ] No local branches matching 'hardening/*' exist:
    git branch | grep hardening
    (should return empty)

[ ] No local branches matching 'phase-[0-9]/*' exist:
    git branch | grep -E 'phase-[0-9]'
    (should return empty)

[ ] The 'main' branch still exists:
    git branch | grep main

[ ] Any 'refinement/*' branches are still intact (not accidentally deleted):
    git branch | grep refinement
    (if any existed before, they should still exist)

[ ] The current branch is still checked out and functional:
    git status shows clean working tree (or only the expected worktree changes)

[ ] No source files were modified (git diff is empty for tracked files)

[ ] git log --oneline -5 shows the same recent commits as before
    (branch deletion does not affect commit history)

Report: QA_PASS or QA_FAIL with per-check breakdown.
```

---

## Phase 6 Integration QA

After all four stages (6A, 6B, 6C, 6D) pass individual QA, run this integration validation on the merged result.

### Integration QA Prompt

```
PHASE 6 INTEGRATION QA — Operational Maturity

Read SHARED_INSTRUCTIONS.md first. Never modify files.

This QA validates that all four Phase 6 tickets work together correctly
after their branches have been merged.

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No secrets or credentials in any committed file

CROSS-TICKET INTEGRATION CHECKS:

6A + Existing Code:
[ ] Token persistence file path (DATA_DIR/jail-tokens.json) does not conflict
    with epair state file path (DATA_DIR/epairs.json) — verify they are distinct
[ ] restoreTokenState() in lifecycle.ts does not create a circular dependency
    with cleanup.ts (lifecycle imports from cleanup for listRunningNanoclawJails;
    cleanup imports from lifecycle for cleanupByJailName — verify this import
    cycle does not cause runtime issues by checking that npm test passes)
[ ] The reconnectToRunningJails() function in src/jail/index.ts calls
    restoreTokenState() AND trackActiveJail() — both must happen for a
    reconnected jail to have a valid token AND be tracked as active
[ ] Token persistence integrates with the existing token lifecycle:
    - createJail() creates token + persists
    - cleanupJail() revokes token + persists
    - reconnectToRunningJails() restores tokens on startup

6B + Health Endpoint:
[ ] HEALTH_ENABLED defaults to true in src/config.ts
[ ] The health endpoint in src/jail/metrics.ts respects the HEALTH_ENABLED config
    (grep for HEALTH_ENABLED or healthEnabled in metrics.ts to verify it is used)
[ ] METRICS_ENABLED still defaults to false (independent of health)

6C + rc.d Script:
[ ] The PID file in etc/newsyslog.d/nanoclaw.conf matches the pidfile in
    etc/rc.d/nanoclaw (/var/run/nanoclaw.pid)
[ ] The log file in etc/newsyslog.d/nanoclaw.conf matches the daemon -o path
    in etc/rc.d/nanoclaw (/var/log/nanoclaw.log)
[ ] The newsyslog user matches the rc.d default user or uses a substitution
    mechanism during installation

6D + Repository State:
[ ] No hardening/* or phase-[0-9]/* branches remain
[ ] main branch is intact
[ ] git log shows no unexpected changes to commit history

OVERALL:
[ ] All four stages are present in the merged code
[ ] No regressions — the full test suite passes
[ ] The changes are minimal and focused (no scope creep)

Report: PHASE_6_QA_PASS or PHASE_6_QA_FAIL with per-check breakdown.
```

---

## Summary

| Stage | Ticket | Change Type | Risk | Key Validation |
|-------|--------|------------|------|----------------|
| 6A | `nc-p6a` | Feature (persistence) | Low -- follows proven epairs.json pattern | Tokens survive restart; stale tokens cleaned |
| 6B | `nc-p6b` | Config (verify/fix default) | Negligible -- localhost-only, read-only | HEALTH_ENABLED evaluates to true when unset |
| 6C | `nc-p6c` | New file + setup script | Low -- additive, standard FreeBSD mechanism | newsyslog rotates /var/log/nanoclaw.log daily |
| 6D | `nc-p6d` | Git hygiene | Negligible -- safe -d flag prevents data loss | No stale hardening/phase branches remain |

All four stages are independent and can be executed as parallel subagents.
