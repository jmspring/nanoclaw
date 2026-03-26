# Phase 10: Code Quality and Testing

**Priority**: P2-P3
**Depends on**: Phase 4 (upstream friction reduction), Phase 5 (CI/CD)
**Source reports**: `reports/maintainer_report.md`, `reports/sre_report.md`

---

## Stage 10A: Add index.ts Tests

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p10a` |
| **Title** | Add unit tests for src/index.ts orchestrator |
| **Priority** | P3 |
| **Tags** | `nanoclaw`, `phase-10`, `testing`, `code-quality` |
| **Files** | `src/index.ts`, `src/index.test.ts` (new) |
| **Dependencies** | None (within phase) |
| **Effort** | ~200 lines / Large |

### Context

The Maintainer Report (`reports/maintainer_report.md`, section 5 "Test Coverage Assessment", line 223) identifies `src/index.ts` (895 lines, 0 test lines) as the single largest untested module in the codebase. It is the core orchestrator handling state management, message loop, agent execution, graceful shutdown, channel setup, and admin alerting. The report explicitly calls out `processGroupMessages`, `runAgent`, and the message loop logic as key testable functions.

The file's module-level mutable state (`reports/maintainer_report.md`, section 3 "Concerns", line 127-133) complicates testing but is manageable with mocks. The `_setRegisteredGroups()` export at `src/index.ts:229` was specifically added for test setup. The `isDirectRun` guard at line 884-888 prevents `main()` from executing during test imports.

Key testable functions and their locations:
- `loadState()` at line 93: reads from DB, parses JSON, calls `restoreSessionState()`
- `saveState()` at line 114: writes to DB
- `saveSessionState()` at line 123: writes JSON to disk with atomic rename and permissions
- `restoreSessionState()` at line 148: reads JSON from disk, merges with DB sessions
- `registerGroup()` at line 186: validates folder path, writes to DB, creates directory
- `processGroupMessages()` at line 239: the main message processing pipeline
- `runAgent()` at line 370: invokes container/jail agent, handles output
- `recoverPendingMessages()` at line 578: scans for unprocessed messages at startup

Existing test files demonstrate the mocking patterns needed:
- `src/credential-proxy.test.ts` mocks `./env.js` and `./logger.js` (lines 4-12)
- `src/jail-runtime.test.ts` mocks `fs`, `child_process`, `./logger.js`, `./env.js` (lines 4-23)
- `src/container-runner.test.ts` mocks `./db.js` and other module dependencies

**Impact**: Achieves >50% coverage of the most complex, highest-risk module in the codebase. Prevents regressions in the orchestration logic that affects every message path.

### Developer Prompt

```
Read SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-p10a -- Add unit tests for src/index.ts orchestrator
FILES: src/index.ts (read-only), src/index.test.ts (new)

CONTEXT:
src/index.ts is 895 lines with zero test coverage. It is the core orchestrator.
The Maintainer Report identifies it as the single biggest testing gap. The file
has an isDirectRun guard (line 884-888) that prevents main() from executing
during imports. The _setRegisteredGroups export (line 229) was added specifically
for test setup.

CHANGES:

1. Read src/index.ts entirely to understand all exports and function signatures.

2. Read existing test files for mocking patterns:
   - src/credential-proxy.test.ts (lines 1-20 -- mock setup pattern)
   - src/jail-runtime.test.ts (lines 1-24 -- fs/child_process/logger mocking)
   - src/container-runner.test.ts (lines 1-30 -- db and module mocking)

3. Create src/index.test.ts with the following mock setup at the top
   (mocks MUST be declared before any imports from the module under test):

   vi.mock('./db.js') -- mock all database functions
   vi.mock('./container-runner.js') -- mock runContainerAgent, writeGroupsSnapshot, etc.
   vi.mock('./router.js') -- mock findChannel, formatMessages, formatOutbound
   vi.mock('./channels/registry.js') -- mock getChannelFactory, getRegisteredChannelNames
   vi.mock('./channels/index.js') -- side-effect-only import, mock as empty
   vi.mock('./credential-proxy.js') -- mock startCredentialProxy
   vi.mock('./container-runtime.js') -- mock getRuntime, cleanupOrphans, etc.
   vi.mock('./ipc.js') -- mock startIpcWatcher
   vi.mock('./remote-control.js') -- mock startRemoteControl, etc.
   vi.mock('./sender-allowlist.js') -- mock isSenderAllowed, etc.
   vi.mock('./task-scheduler.js') -- mock startSchedulerLoop
   vi.mock('./group-folder.js') -- mock resolveGroupFolderPath
   vi.mock('./group-queue.js') -- mock GroupQueue class
   vi.mock('./logger.js', () => ({
     logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn(), fatal: vi.fn() },
     generateTraceId: vi.fn(() => 'test-trace-id'),
     createTracedLogger: vi.fn(() => ({
       info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn(),
     })),
   }))
   vi.mock('./log-rotation.js') -- mock cleanupAllGroupLogs, closeAllLogStreams
   vi.mock('fs') -- mock filesystem operations

4. Import the functions under test AFTER mock declarations:
   import { _setRegisteredGroups, getAvailableGroups } from './index.js'
   Import mocked modules for assertion: import { getRouterState, ... } from './db.js'

5. Write at least 6 describe blocks:

   a. describe('loadState') -- requires importing indirectly or testing via
      the state it produces. Since loadState is not exported, test it through
      the side effects visible via getAvailableGroups() or _setRegisteredGroups().
      Alternatively, test saveState/loadState by mocking getRouterState and
      setRouterState and verifying the calls. Use dynamic import to re-execute
      the module if needed, or focus on the exported helpers that depend on state.

   b. describe('saveSessionState / restoreSessionState') -- these are private
      but can be tested through their effects. Mock fs.existsSync, fs.readFileSync,
      fs.writeFileSync, fs.mkdirSync, fs.chmodSync, fs.renameSync. Verify
      atomic write pattern (write to .tmp, chmod 0o600, rename).

   c. describe('registerGroup') -- test via side effects. Mock
      resolveGroupFolderPath to return a path, mock fs.mkdirSync, mock
      setRegisteredGroup from db.js. Verify it writes to DB and creates
      the group directory. Also test the rejection case when
      resolveGroupFolderPath throws.

   d. describe('processGroupMessages') -- this is the most important test.
      Since it is not exported, you may need to test it indirectly through
      the GroupQueue callback, or use a workaround:
      - Mock the GroupQueue constructor to capture the callback function
        passed to it, then invoke that callback directly in tests.
      - Verify it calls getNewMessages, formatMessages, runContainerAgent,
        and formatOutbound in the correct sequence.

   e. describe('_setRegisteredGroups / getAvailableGroups') -- these ARE
      exported. Test that _setRegisteredGroups updates the internal state
      and getAvailableGroups returns the correct format after calling
      getAllChats from db.js.

   f. describe('recoverPendingMessages') -- not exported, but test through
      the startup flow or by capturing the GroupQueue enqueue callback.
      Verify it calls getMessagesSince for each registered group and
      enqueues groups with pending messages.

6. For functions that are not exported (loadState, saveState,
   saveSessionState, restoreSessionState, registerGroup,
   processGroupMessages, runAgent, recoverPendingMessages):
   Consider one of these testing strategies:
   - Test through exported functions that call them
   - Use dynamic import with module re-evaluation
   - Test the mock interaction patterns (verify mocked db/fs functions
     were called with expected arguments)
   - If none of these work cleanly for a particular function, document
     it with a TODO comment and a describe.skip block explaining the
     approach needed.

7. Run: npm test
8. Run: npx tsc --noEmit
9. Run: npm run lint
10. Run: npm run format:check

IMPLEMENTATION_COMPLETE
```

### QA Prompt

```
Read SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-p10a -- QA validation for index.ts tests
FILES TO VALIDATE: src/index.test.ts (new)

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only src/index.test.ts
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

TICKET-SPECIFIC CHECKS:

[ ] File exists: src/index.test.ts is present in the working tree.

[ ] At least 6 describe blocks: Count the number of describe() calls in the
    file. There must be at least 6 top-level or nested describe blocks covering
    distinct functional areas.

[ ] Covers processGroupMessages: At least one test or describe block references
    processGroupMessages (either directly or through the GroupQueue callback
    capture pattern).

[ ] Covers runAgent or agent invocation: At least one test verifies that
    runContainerAgent (from container-runner.js) is called or its mock behavior
    is validated.

[ ] Covers loadState/saveState: At least one test verifies interaction with
    getRouterState/setRouterState from db.js (the backing store for loadState
    and saveState).

[ ] Covers saveSessionState/restoreSessionState: At least one test verifies
    the atomic write pattern (fs.writeFileSync to .tmp, fs.chmodSync, fs.renameSync)
    or the read-and-merge pattern (fs.existsSync, fs.readFileSync, JSON.parse).

[ ] Covers registerGroup: At least one test verifies that setRegisteredGroup
    is called (happy path) and that an invalid folder path is rejected
    (error path where resolveGroupFolderPath throws).

[ ] Covers recoverPendingMessages: At least one test verifies that
    getMessagesSince is called for registered groups and that groups with
    pending messages are enqueued.

[ ] Mock setup before imports: All vi.mock() calls appear before the import
    statements for the module under test. This is required by Vitest's
    hoisting behavior.

[ ] No modifications to src/index.ts: The source file under test must not
    be modified. Verify with: git diff src/index.ts (should be empty).

[ ] Tests are meaningful: Spot-check at least 2 test cases to verify they
    make real assertions (expect() calls), not just "it exists" smoke tests.

Report each check as PASS or FAIL with details.
Final output: QA_PASS or QA_FAIL
```

---

## Stage 10B: Add Template Versioning

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p10b` |
| **Title** | Add template version metadata to jail template builds |
| **Priority** | P2 |
| **Tags** | `nanoclaw`, `phase-10`, `operational`, `versioning` |
| **Files** | `scripts/setup-jail-template.sh`, `src/jail/lifecycle.ts` |
| **Dependencies** | None (within phase) |
| **Effort** | ~30 lines / Small |

### Context

The SRE Report (`reports/sre_report.md`, section 5 "Service Management", lines 219-271) identifies operational gaps including the absence of template versioning. The Product Manager Report's Known Backlog (`refinement/03252026/PHASE_PLAN.md`, line 268) explicitly lists "Template versioning -- write version file during template build" as a P2 item.

Currently, `scripts/setup-jail-template.sh` builds the jail template and takes a ZFS snapshot at line 320-321 (`sudo zfs snapshot "$FULL_SNAPSHOT"`), but no version metadata is written to the template filesystem. This means operators cannot determine when a template was built, what Node.js or TypeScript versions it contains, or whether it is stale relative to the running NanoClaw code.

The verification section (lines 246-289) already queries `node --version`, `npx tsc --version`, and `claude --version` inside the temporary jail, so the version data is readily available. The version file should be written after verification completes (after line 289) and before the temporary jail is stopped (line 292).

In `src/jail/lifecycle.ts`, the template path is derivable from `JAIL_CONFIG.jailsPath` (defined at `src/jail/config.ts:63-64` as `path.join(NANOCLAW_ROOT, 'jails')`) combined with the template dataset name. A startup check function should read the version file from the template path, log the version info, and warn if the template is older than 30 days.

**Impact**: Operators can detect stale templates and template/code mismatches before they cause runtime failures in jails. Supports blue/green template upgrade workflows by making template versions visible.

### Developer Prompt

```
Read SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-p10b -- Add template version metadata to jail template builds
FILES: scripts/setup-jail-template.sh, src/jail/lifecycle.ts

CONTEXT:
The SRE report identifies missing template versioning as an operational gap. The
setup script builds templates but writes no version metadata. The verification
section (lines 246-289) already queries component versions inside the jail.

CHANGES:

1. Read scripts/setup-jail-template.sh, focusing on the verification section
   (lines 246-289) and the jail stop at line 292.

2. After the test compilation block (line 289, after the "fi" closing the tsc
   test) and BEFORE "# Stop the temporary jail" (line 291-292), add:

   ```sh
   # Write template version metadata
   log "Writing template version metadata..."
   TEMPLATE_VERSION=$(date +%Y%m%d-%H%M%S)
   TEMPLATE_BUILT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
   TEMPLATE_NODE=$(jexec_cmd node --version)
   TEMPLATE_TSC=$(jexec_cmd npx tsc --version | awk '{print $2}')
   TEMPLATE_CLAUDE=$(jexec_cmd claude --version 2>/dev/null | head -1 || echo "unknown")

   cat > "$TEMPLATE_PATH/etc/nanoclaw-template-version" << VERSIONEOF
   version=$TEMPLATE_VERSION
   node=$TEMPLATE_NODE
   tsc=$TEMPLATE_TSC
   claude_code=$TEMPLATE_CLAUDE
   built=$TEMPLATE_BUILT
   VERSIONEOF

   log "  Template version: $TEMPLATE_VERSION (node=$TEMPLATE_NODE, tsc=$TEMPLATE_TSC)"
   ```

   This writes a simple key=value file at /etc/nanoclaw-template-version inside
   the template filesystem. It will be present in every jail cloned from this
   template.

3. Read src/jail/lifecycle.ts and src/jail/config.ts. Note that:
   - JAIL_CONFIG.jailsPath is the parent directory of all jail filesystems
   - JAIL_CONFIG.templateDataset is the ZFS dataset name (e.g., zroot/nanoclaw/jails/template)
   - The template filesystem path is: path.join(JAIL_CONFIG.jailsPath, templateDatasetBasename)
     where templateDatasetBasename is the last component of JAIL_CONFIG.templateDataset
     (use path.basename or split on '/')

4. In src/jail/lifecycle.ts, add an exported function after the existing
   removeRctlLimits function (around line 164):

   ```typescript
   /**
    * Check template version metadata and log it at startup.
    * Warns if the template is older than 30 days.
    */
   export function checkTemplateVersion(): void {
     const templateBase = JAIL_CONFIG.templateDataset.split('/').pop() || 'template';
     const versionFile = path.join(JAIL_CONFIG.jailsPath, templateBase, 'etc', 'nanoclaw-template-version');

     try {
       if (!fs.existsSync(versionFile)) {
         logger.warn({ versionFile }, 'Template version file not found -- rebuild template with latest setup-jail-template.sh');
         return;
       }

       const content = fs.readFileSync(versionFile, 'utf-8');
       const metadata: Record<string, string> = {};
       for (const line of content.split('\n')) {
         const eq = line.indexOf('=');
         if (eq > 0) {
           metadata[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
         }
       }

       logger.info({ templateVersion: metadata }, 'Jail template version');

       // Warn if template is older than 30 days
       if (metadata.built) {
         const builtDate = new Date(metadata.built);
         const ageMs = Date.now() - builtDate.getTime();
         const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
         if (ageDays > 30) {
           logger.warn(
             { ageDays, built: metadata.built },
             'Jail template is older than 30 days -- consider rebuilding with setup-jail-template.sh',
           );
         }
       }
     } catch (err) {
       logger.warn({ err, versionFile }, 'Failed to read template version');
     }
   }
   ```

5. This function should be called from the startup path. However, do NOT modify
   src/index.ts for this ticket. The function is exported and can be wired in
   during the jail runtime initialization in src/jail/index.ts or called
   directly when the jail runtime is detected. For now, just export it --
   wiring will be done as a follow-up or by the orchestrator.

6. Run: npm test
7. Run: npx tsc --noEmit
8. Run: npm run lint
9. Run: npm run format:check

IMPLEMENTATION_COMPLETE
```

### QA Prompt

```
Read SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-p10b -- QA validation for template versioning
FILES TO VALIDATE: scripts/setup-jail-template.sh, src/jail/lifecycle.ts

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only
    scripts/setup-jail-template.sh and src/jail/lifecycle.ts
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

TICKET-SPECIFIC CHECKS:

[ ] Version file creation in setup script: scripts/setup-jail-template.sh
    contains a block that writes to "$TEMPLATE_PATH/etc/nanoclaw-template-version".
    The block must appear AFTER the verification/test compilation section
    (after the tsc test block around line 289) and BEFORE the "Stop the
    temporary jail" section (line 292).

[ ] Version file format: The version file content includes at least these keys:
    version, node, tsc, claude_code, built. Each on its own line in key=value
    format.

[ ] Version values are dynamic: The version file uses command substitution
    (jexec_cmd, date) for values, not hardcoded strings.

[ ] checkTemplateVersion function exists: src/jail/lifecycle.ts contains an
    exported function named checkTemplateVersion.

[ ] Function reads correct path: checkTemplateVersion derives the template
    path from JAIL_CONFIG.jailsPath and JAIL_CONFIG.templateDataset, and
    reads etc/nanoclaw-template-version from within it.

[ ] Missing file handled: checkTemplateVersion logs a warning (not throws)
    if the version file does not exist.

[ ] Stale template warning: checkTemplateVersion compares the 'built' date
    against the current date and warns if the template is older than 30 days.

[ ] No changes to src/index.ts: Verify the orchestrator was not modified.
    git diff src/index.ts should be empty.

[ ] Script still uses set -eu: Verify setup-jail-template.sh still has
    set -eu at the top (line 29). The new code must not break strict mode.

Report each check as PASS or FAIL with details.
Final output: QA_PASS or QA_FAIL
```

---

## Stage 10C: Add Deployment SOP Documentation

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p10c` |
| **Title** | Create deployment standard operating procedure document |
| **Priority** | P2 |
| **Tags** | `nanoclaw`, `phase-10`, `documentation`, `deployment` |
| **Files** | `docs/DEPLOYMENT.md` (new) |
| **Dependencies** | None (within phase) |
| **Effort** | New document / Medium |

### Context

The SRE Report (`reports/sre_report.md`, section 6 "Deployment and Upgrade Strategies", lines 275-300) identifies the deployment process as undocumented and entirely manual. The current process is: `git pull`, `npm ci && npm run build`, `sudo service nanoclaw restart`. There is no documented rollback procedure, no pre-deploy checklist, and no post-deploy verification steps.

Section 6.1 (lines 278-288) details three specific issues:
- No zero-downtime deployment: restart drops all active connections and aborts in-progress agents
- No rollback mechanism: operator must manually `git revert` and rebuild
- Template updates require stopping all jails (setup-jail-template.sh checks for dependent clones)

Section 6.2 (lines 290-300) recommends documenting the blue/green template deployment that is already supported by `scripts/setup-jail-template.sh` (accepts an optional template name argument at line 32: `TEMPLATE_NAME="${1:-template}"`), tagging releases in git, and keeping a previous dist build for rollback.

The Known Backlog in `refinement/03252026/PHASE_PLAN.md` (line 269) lists "Deployment SOP documentation" as a P2 item from the SRE report.

**Impact**: Operators have a standard runbook for deployments, reducing the risk of errors during manual deploy steps and providing a documented rollback path.

### Developer Prompt

```
Read SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-p10c -- Create deployment standard operating procedure document
FILES: docs/DEPLOYMENT.md (new)

CONTEXT:
The SRE report (section 6, lines 275-300) identifies no documented deployment
SOP. Current process: git pull, npm ci, build, restart. No rollback, no
checklist, no verification. Blue/green template updates are already supported
by setup-jail-template.sh but undocumented.

CHANGES:

1. Read the following for deployment context:
   - reports/sre_report.md (section 6, lines 275-300)
   - scripts/setup-jail-template.sh (lines 29-42 -- configuration, template name arg)
   - etc/rc.d/nanoclaw (service management commands)
   - docs/FREEBSD_JAILS.md (for any existing deployment references)

2. Create docs/DEPLOYMENT.md with the following sections:

   ## 1. Standard Deployment

   Document the basic deploy sequence:
   ```bash
   cd /home/nanoclaw/code/nanoclaw/src  # or $NANOCLAW_ROOT/src
   git pull
   npm ci
   npm run build
   sudo service nanoclaw restart
   ```

   Note the limitations: not zero-downtime, in-progress agents will be
   terminated after the 10-second graceful shutdown window.

   ## 2. Blue/Green Template Update

   Document how to use setup-jail-template.sh with a named template:
   ```bash
   # Build new template alongside existing one
   sudo ./scripts/setup-jail-template.sh template-v2

   # Update environment to use new template
   export NANOCLAW_TEMPLATE_DATASET=zroot/nanoclaw/jails/template-v2

   # Restart service to pick up new template
   sudo service nanoclaw restart

   # After verifying, remove old template (optional)
   sudo zfs destroy -r zroot/nanoclaw/jails/template
   ```

   Explain that this avoids stopping running jails during the template build.
   Reference NANOCLAW_TEMPLATE_DATASET env var.

   ## 3. Rollback Procedure

   Document rollback via git:
   ```bash
   git log --oneline -5           # identify the bad commit
   git revert <commit-hash>       # create a revert commit
   npm ci && npm run build
   sudo service nanoclaw restart
   ```

   For template rollback, reference the @base-backup snapshot that
   setup-jail-template.sh creates automatically (lines 304-318):
   ```bash
   sudo zfs rollback zroot/nanoclaw/jails/template@base-backup
   ```

   ## 4. Pre-Deploy Checklist

   Document checks to perform before deploying:
   - [ ] Back up the database: `cp store/nanoclaw.db store/nanoclaw.db.pre-deploy`
   - [ ] Check for running jails: `sudo jls | grep nanoclaw`
   - [ ] Run the test suite: `npm test`
   - [ ] Build succeeds: `npm run build`
   - [ ] Check disk space: `zfs list -o name,used,avail | grep nanoclaw`
   - [ ] Read the changelog / commit log for breaking changes

   ## 5. Post-Deploy Verification

   Document verification after deploying:
   - [ ] Service is running: `sudo service nanoclaw status`
   - [ ] Health endpoint responds: `curl http://localhost:${METRICS_PORT:-9090}/health`
   - [ ] Test a message: send a test trigger message to a registered group
   - [ ] Check logs for errors: `tail -50 logs/nanoclaw.log | grep -i error`
   - [ ] Verify jail creation works: check that the next triggered agent creates
         a jail successfully (visible in logs)

3. Use concise prose. Keep the document under 150 lines. Avoid restating
   information already in FREEBSD_JAILS.md -- cross-reference it instead.

4. Run: npm test
5. Run: npx tsc --noEmit
6. Run: npm run lint
7. Run: npm run format:check

IMPLEMENTATION_COMPLETE
```

### QA Prompt

```
Read SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-p10c -- QA validation for deployment SOP document
FILES TO VALIDATE: docs/DEPLOYMENT.md (new)

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only docs/DEPLOYMENT.md
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

TICKET-SPECIFIC CHECKS:

[ ] File exists: docs/DEPLOYMENT.md is present in the working tree.

[ ] Section 1 -- Standard Deployment: The document contains a section covering
    the basic git pull / npm ci / npm run build / service restart sequence.

[ ] Section 2 -- Blue/Green Template Update: The document contains a section
    explaining how to use setup-jail-template.sh with a custom template name
    and the NANOCLAW_TEMPLATE_DATASET env var.

[ ] Section 3 -- Rollback Procedure: The document contains a section covering
    git revert and template rollback via ZFS snapshots (@base-backup).

[ ] Section 4 -- Pre-Deploy Checklist: The document contains a checklist
    including at minimum: database backup, check for running jails, run tests,
    verify build succeeds.

[ ] Section 5 -- Post-Deploy Verification: The document contains a checklist
    including at minimum: service status, health endpoint check, test message,
    log inspection.

[ ] No broken references: Any file paths or command references in the document
    correspond to actual files or commands in the repository. Spot-check at
    least 2 references (e.g., scripts/setup-jail-template.sh exists,
    etc/rc.d/nanoclaw exists).

[ ] Concise: The document is under 200 lines total.

Report each check as PASS or FAIL with details.
Final output: QA_PASS or QA_FAIL
```

---

## Stage 10D: Document Disaster Recovery Procedure

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p10d` |
| **Title** | Create disaster recovery runbook |
| **Priority** | P3 |
| **Tags** | `nanoclaw`, `phase-10`, `documentation`, `disaster-recovery` |
| **Files** | `docs/DISASTER_RECOVERY.md` (new) |
| **Dependencies** | None (within phase) |
| **Effort** | New document / Medium |

### Context

The SRE Report (`reports/sre_report.md`, section 7 "Backup and Disaster Recovery", lines 303-342) identifies four backup/DR gaps:

1. **No off-host backup** (line 318): All backups are on the same ZFS pool. A pool failure loses everything.
2. **No ZFS snapshot policy** (line 320): The `store/` and `groups/` directories have no periodic snapshots.
3. **No credential backup** (line 322): The `.env` file with API keys has no documented recovery procedure.
4. **No documented DR procedure** (line 324): If the host is destroyed, there is no runbook for rebuilding.

The section 7.3 recommendations (lines 326-341) propose a ZFS snapshot cron job, `zfs send` to a remote host, and documenting the DR procedure in `docs/DISASTER_RECOVERY.md`.

The Known Backlog in `refinement/03252026/PHASE_PLAN.md` (line 270) lists "DR procedure documentation" as a P3 item from the SRE report.

Key system components that need DR coverage:
- ZFS pool: `zroot/nanoclaw` with datasets for jails, template, data
- SQLite database: `store/nanoclaw.db` with daily backups from `backupDatabase()` (SRE report line 309)
- Template snapshot: `@base` with `@base-backup` created by setup-jail-template.sh
- pf rules: `etc/pf-nanoclaw.conf` (or installed at `/etc/pf-nanoclaw.conf`)
- Session state: `data/session-state.json`, `data/epairs.json`, `data/jail-tokens.json`
- Credentials: `.env` file with API keys and channel auth tokens
- Group data: `groups/{name}/CLAUDE.md` per-group memory files

**Impact**: Operators have a recovery runbook for all major failure scenarios, reducing mean time to recovery after incidents.

### Developer Prompt

```
Read SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-p10d -- Create disaster recovery runbook
FILES: docs/DISASTER_RECOVERY.md (new)

CONTEXT:
The SRE report (section 7, lines 303-342) identifies no documented DR procedure.
The report lists four specific gaps: no off-host backup, no ZFS snapshot policy,
no credential backup, and no DR runbook.

CHANGES:

1. Read the following for DR context:
   - reports/sre_report.md (section 7, lines 303-342)
   - scripts/setup-freebsd.sh (overall setup flow for full rebuild)
   - scripts/setup-jail-template.sh (template rebuild, backup snapshot at lines 304-318)
   - src/db.ts (backupDatabase function -- daily backup to store/backups/)
   - src/jail/cleanup.ts (reconnectToRunningJails, cleanupOrphans)
   - src/jail/network.ts (epair state file at data/epairs.json)

2. Create docs/DISASTER_RECOVERY.md with the following 7 sections:

   ## 1. ZFS Pool Degradation

   Document recovery for degraded ZFS pool:
   - Detect: `zpool status` (look for DEGRADED or FAULTED)
   - Scrub: `sudo zpool scrub zroot`
   - Replace disk: `sudo zpool replace zroot <old-device> <new-device>`
   - After replacement, verify: `zpool status zroot` shows ONLINE
   - Reference FreeBSD Handbook ZFS chapter for detailed procedures

   ## 2. Host Crash During Jail Creation

   Document recovery from crash during jail lifecycle:
   - Orphan jails will exist without orchestrator tracking them
   - On restart, reconnectToRunningJails() (src/jail/index.ts) automatically
     re-tracks running jails
   - If orphans persist: `sudo jls | grep nanoclaw` to list, then
     `sudo jail -r <jailname>` to stop them manually
   - ZFS clone cleanup: `sudo zfs list -t all | grep nanoclaw/jails` to find
     orphaned clones, then `sudo zfs destroy -r <dataset>` to remove
   - Stale epair interfaces: `ifconfig -l | tr ' ' '\n' | grep epair`
     to list, then `sudo ifconfig <epairNa> destroy` to clean up
   - NanoClaw's built-in cleanup (src/jail/cleanup.ts) handles most of
     this automatically on next startup

   ## 3. pf Rule Corruption

   Document recovery from broken firewall rules:
   - Symptom: jail agents cannot reach Anthropic API, or network is unrestricted
   - Verify current rules: `sudo pfctl -s rules`
   - Reload from source: `sudo pfctl -f /etc/pf-nanoclaw.conf`
   - If anchor mode: `sudo pfctl -a nanoclaw -f etc/pf-nanoclaw-anchor.conf`
   - Verify after reload: `sudo pfctl -s rules | grep jail_net`
   - If /etc/pf-nanoclaw.conf is missing or corrupt, restore from repo:
     `cp etc/pf-nanoclaw.conf /etc/pf-nanoclaw.conf`
   - Reference: etc/pf-nanoclaw.conf for standalone rules,
     etc/pf-nanoclaw-anchor.conf for anchor mode

   ## 4. Template Corruption

   Document recovery from corrupted or missing jail template:
   - Option A -- restore from backup snapshot:
     ```bash
     sudo zfs rollback zroot/nanoclaw/jails/template@base-backup
     ```
     The @base-backup snapshot is created automatically by
     setup-jail-template.sh before each new @base snapshot.
   - Option B -- full rebuild:
     ```bash
     sudo ./scripts/setup-jail-template.sh
     ```
     This creates a fresh template with the latest packages.
   - After restoration, verify: `sudo zfs list -t snapshot | grep template`
   - Running jails are unaffected (they use ZFS clones, not the template
     directly). New jails will use the restored/rebuilt template.

   ## 5. Database Corruption

   Document recovery from SQLite database corruption:
   - Daily backups are in store/backups/ (created by backupDatabase() in db.ts)
   - WAL recovery (if WAL mode is enabled per Phase 3):
     ```bash
     # SQLite automatically recovers from WAL on next open
     # If the WAL file is corrupt, remove it (data since last checkpoint is lost):
     rm store/nanoclaw.db-wal
     ```
   - Restore from backup:
     ```bash
     sudo service nanoclaw stop
     cp store/backups/nanoclaw-<latest>.db store/nanoclaw.db
     sudo service nanoclaw start
     ```
   - Verify: check that registered groups and messages are present
   - Note: session state is also persisted in data/session-state.json
     and will be merged on startup

   ## 6. Full Rebuild from Scratch

   Document rebuilding a completely destroyed host:
   1. Install FreeBSD 15.0-RELEASE with ZFS root
   2. Run the bootstrap script:
      ```bash
      sudo ./scripts/setup-freebsd.sh
      ```
      This installs packages, creates the nanoclaw user, sets up ZFS datasets,
      configures pf, and installs the rc.d service.
   3. Build the jail template:
      ```bash
      sudo ./scripts/setup-jail-template.sh
      ```
   4. Restore data from off-host backup (if available):
      ```bash
      # ZFS receive:
      ssh backup-host zfs send tank/nanoclaw-backup@latest | sudo zfs recv zroot/nanoclaw
      # Or restore individual files:
      # - store/nanoclaw.db (database)
      # - groups/ (per-group CLAUDE.md files)
      # - .env (credentials)
      # - data/ (session state, epair state, jail tokens)
      ```
   5. Rebuild the application:
      ```bash
      npm ci && npm run build
      ```
   6. Start the service:
      ```bash
      sudo service nanoclaw start
      ```

   ## 7. Credential Recovery

   Document recovering API keys and channel auth tokens:
   - The .env file contains all API keys (Anthropic, channel tokens, etc.)
   - If .env is lost and no backup exists:
     - Anthropic API key: regenerate at console.anthropic.com
     - Channel auth tokens: re-authenticate each channel
       (WhatsApp: scan QR code, Telegram: /start with BotFather, etc.)
     - Other API keys: regenerate from respective provider dashboards
   - Recommendation: keep an encrypted backup of .env off-host
     (e.g., `gpg -c .env` uploaded to secure storage)
   - Group registrations are in the SQLite database, not .env, so they
     survive credential recovery

3. Use concise prose with code blocks for commands. Keep the document
   under 250 lines.

4. Run: npm test
5. Run: npx tsc --noEmit
6. Run: npm run lint
7. Run: npm run format:check

IMPLEMENTATION_COMPLETE
```

### QA Prompt

```
Read SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-p10d -- QA validation for disaster recovery runbook
FILES TO VALIDATE: docs/DISASTER_RECOVERY.md (new)

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only docs/DISASTER_RECOVERY.md
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

TICKET-SPECIFIC CHECKS:

[ ] File exists: docs/DISASTER_RECOVERY.md is present in the working tree.

[ ] Section 1 -- ZFS Pool Degradation: Contains zpool status, zpool scrub,
    and zpool replace commands or references.

[ ] Section 2 -- Host Crash During Jail Creation: Covers orphan jail detection
    (jls), manual jail stop (jail -r), and ZFS clone cleanup. References the
    automatic reconnectToRunningJails() behavior.

[ ] Section 3 -- pf Rule Corruption: Covers pfctl -f reload, verification
    with pfctl -s rules, and restoring from the repo copy of pf-nanoclaw.conf.

[ ] Section 4 -- Template Corruption: Covers both restore-from-snapshot
    (@base-backup) and full rebuild (setup-jail-template.sh) options.

[ ] Section 5 -- Database Corruption: Covers WAL recovery, restoring from
    daily backups in store/backups/, and the session state merge behavior.

[ ] Section 6 -- Full Rebuild from Scratch: Covers the complete rebuild
    sequence: setup-freebsd.sh, setup-jail-template.sh, data restoration,
    npm ci / build, service start.

[ ] Section 7 -- Credential Recovery: Covers .env file loss, API key
    regeneration, channel re-authentication, and the recommendation for
    encrypted off-host backup.

[ ] No broken references: Spot-check at least 3 file path references
    in the document (e.g., scripts/setup-freebsd.sh, store/backups/,
    etc/pf-nanoclaw.conf). Verify each referenced file or directory exists
    in the repository or is a well-documented runtime path.

[ ] Concise: The document is under 300 lines total.

Report each check as PASS or FAIL with details.
Final output: QA_PASS or QA_FAIL
```

---

## Phase 10 Integration QA

After all four stage tickets (10A, 10B, 10C, 10D) have individually passed QA and been committed to their respective branches, run the following integration QA on the merged result.

### Integration QA Prompt

```
Read SHARED_INSTRUCTIONS.md before starting.

PHASE 10 INTEGRATION QA -- Code Quality and Testing
MERGED BRANCHES: nc-p10a, nc-p10b, nc-p10c, nc-p10d
FILES MODIFIED: src/index.test.ts (new), scripts/setup-jail-template.sh,
  src/jail/lifecycle.ts, docs/DEPLOYMENT.md (new), docs/DISASTER_RECOVERY.md (new)

This is a read-only validation of the merged Phase 10 changes. Never modify files.

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] Only expected files changed: git diff --stat against main shows exactly
    src/index.test.ts, scripts/setup-jail-template.sh, src/jail/lifecycle.ts,
    docs/DEPLOYMENT.md, docs/DISASTER_RECOVERY.md
[ ] No secrets or credentials in diff

CROSS-TICKET INTEGRATION CHECKS:

[ ] No conflicting changes: The four tickets modify different files with no
    overlapping lines. Only nc-p10b touches both scripts/setup-jail-template.sh
    and src/jail/lifecycle.ts, which is a single ticket. Verify there are no
    merge artifacts or conflict markers in any modified file:
    grep -rn '<<<<<<' src/index.test.ts scripts/setup-jail-template.sh src/jail/lifecycle.ts docs/DEPLOYMENT.md docs/DISASTER_RECOVERY.md

[ ] index.ts tests exist and pass (10A): src/index.test.ts exists, contains
    at least 6 describe blocks, and npm test shows all tests in that file
    passing. Verify the test file does NOT modify src/index.ts itself.

[ ] Template version function compiles (10B): src/jail/lifecycle.ts contains
    the exported checkTemplateVersion() function. Verify it compiles by
    confirming npx tsc --noEmit passes with no errors in lifecycle.ts.
    Verify the version file write block exists in scripts/setup-jail-template.sh
    and references $TEMPLATE_PATH/etc/nanoclaw-template-version.

[ ] Deployment SOP complete (10C): docs/DEPLOYMENT.md exists and contains
    all 5 required sections:
    1. Standard Deployment (git pull / build / restart)
    2. Blue/Green Template Update (setup-jail-template.sh with custom name)
    3. Rollback Procedure (git revert + template @base-backup)
    4. Pre-Deploy Checklist (database backup, running jails, tests, build)
    5. Post-Deploy Verification (service status, health, test message, logs)

[ ] Disaster recovery runbook complete (10D): docs/DISASTER_RECOVERY.md exists
    and contains all 7 required sections:
    1. ZFS Pool Degradation
    2. Host Crash During Jail Creation
    3. pf Rule Corruption
    4. Template Corruption
    5. Database Corruption
    6. Full Rebuild from Scratch
    7. Credential Recovery

[ ] Documentation cross-references are consistent: If DEPLOYMENT.md references
    DISASTER_RECOVERY.md or vice versa, verify the references are correct.
    If DEPLOYMENT.md references the template version (from 10B), verify the
    reference matches the actual file path (etc/nanoclaw-template-version).

[ ] No regression in existing tests: All existing test files pass without
    modification. The new index.test.ts should not interfere with existing
    tests. Run npm test and confirm the full test count includes the new
    test file alongside all previously passing tests.

[ ] src/index.ts is unmodified: git diff src/index.ts shows no changes.
    The orchestrator must not be touched by any Phase 10 ticket.

[ ] Build succeeds end-to-end: npm run build completes without errors.

Report each check as PASS or FAIL with details.
Final output: QA_PASS or QA_FAIL followed by a summary of all Phase 10 changes.
```
