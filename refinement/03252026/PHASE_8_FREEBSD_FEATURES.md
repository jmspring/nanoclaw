# Phase 8: FreeBSD-Native Features

**Priority**: P3 -- differentiating features
**Depends on**: Phase 6 (Operational Maturity)
**Rationale**: ZFS snapshot rollback, rctl resource monitoring, and jail persistence are the features that most differentiate the FreeBSD jail runtime from Docker. No Docker equivalent exists for instant COW snapshots or kernel-level resource accounting. These features leverage FreeBSD primitives that are zero-cost or near-zero-cost by design.

**All subagents MUST read `refinement/03252026/SHARED_INSTRUCTIONS.md` before starting work.**

---

## Stage 8A: ZFS Snapshot-Based Session Rollback

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p8a` |
| **Title** | Add ZFS snapshot-based session rollback |
| **Priority** | P3 |
| **Tags** | `nanoclaw`, `phase-8`, `zfs`, `freebsd-native` |
| **Files** | `src/jail/snapshots.ts` (new), `src/jail/runner.ts`, `src/ipc.ts`, `src/jail/types.ts` |
| **Dependencies** | Phase 6 complete (token persistence, health endpoint default) |

### Context

ZFS snapshots are instantaneous, zero-copy, and free in terms of storage until data diverges. This is the single most differentiating feature possible for NanoClaw-BSD. Docker has no equivalent -- overlayfs layers cannot be snapshotted and rolled back at the filesystem level without external tooling.

The jail runtime already creates ZFS clones from a template snapshot for each jail (`zfs clone template@base -> jails/<jailName>`). This ticket extends that foundation to take workspace-level snapshots before each agent invocation, enabling users to roll back agent changes with a single IPC command. The snapshots target the jail's ZFS dataset (the clone), capturing the full jail filesystem state including any files the agent created or modified.

Currently, `src/jail/lifecycle.ts` creates a ZFS clone at jail creation (line 277: `zfs clone snapshot dataset`) and destroys it with `zfs destroy -f -r dataset` at cleanup (line 553). Snapshots of the clone dataset are a natural extension of this flow.

### Developer Prompt

```
ROLE: Developer subagent for nc-p8a
TICKET: Add ZFS snapshot-based session rollback
READ FIRST: refinement/03252026/SHARED_INSTRUCTIONS.md

CONTEXT:
You are adding ZFS snapshot support to the jail runtime. The jail lifecycle already
creates ZFS clones from a template (src/jail/lifecycle.ts). You will add the ability
to snapshot those clones before agent execution and roll back to any snapshot on demand.

TASK:

1. CREATE NEW MODULE: src/jail/snapshots.ts

   This module manages ZFS snapshots on jail datasets. It must export these functions:

   a) createSnapshot(groupId: string, label?: string): Promise<string>
      - Derives the jail name via getJailName(groupId) and dataset via the pattern
        `${JAIL_CONFIG.jailsDataset}/${jailName}`
      - Snapshot naming convention: `<dataset>@nc-<timestamp>-<label>`
        where timestamp is ISO compact (e.g., "20260325T143022Z") and label defaults
        to "pre-agent"
      - Runs: sudo zfs snapshot <dataset>@<snapName>
      - Returns the full snapshot name (dataset@snapName)
      - Logs at info level with { groupId, jailName, snapshot }

   b) listSnapshots(groupId: string): Promise<SnapshotInfo[]>
      - Runs: zfs list -t snapshot -H -o name,creation,used -s creation <dataset>
      - Parses output into SnapshotInfo[] = { name: string, creation: string, used: string }
      - Filters to only snapshots matching the `@nc-` prefix (excludes the template @base snapshot)
      - Returns empty array if dataset does not exist or has no matching snapshots

   c) rollbackToSnapshot(groupId: string, snapshotName: string): Promise<void>
      - Validates that snapshotName belongs to the correct dataset (defense against path injection)
      - The jail MUST be stopped before rollback. Check with isJailRunning() and throw if running.
      - Runs: sudo zfs rollback -r <snapshotName>
        (the -r flag destroys more recent snapshots, which is the expected behavior for rollback)
      - Logs at info level

   d) enforceRetentionPolicy(groupId: string, maxSnapshots?: number): Promise<number>
      - maxSnapshots defaults to SNAPSHOT_RETENTION (see config below)
      - Lists snapshots, and if count > maxSnapshots, destroys the oldest ones
        (those with earliest creation time) until count <= maxSnapshots
      - Returns the number of snapshots destroyed
      - Runs: sudo zfs destroy <snapshotName> for each excess snapshot

   e) destroyAllSnapshots(groupId: string): Promise<void>
      - Lists and destroys all nc-* snapshots for the group's dataset
      - Called during jail cleanup to avoid "dataset has children" errors on destroy

   Add a config constant:
   - SNAPSHOT_RETENTION: number = clampInt(process.env.NANOCLAW_SNAPSHOT_RETENTION, 3, 1, 50)
     Import clampInt pattern from src/jail/config.ts or duplicate the helper.

   Add a type:
   - SnapshotInfo: { name: string; creation: string; used: string }
     Add this to src/jail/types.ts.

   Use getSudoExec() from src/jail/sudo.ts for privileged commands.
   Use execFileSync from child_process for non-privileged reads (zfs list).
   Follow the existing error handling pattern: catch, log with pino, re-throw or handle gracefully.

2. INTEGRATE INTO RUNNER: src/jail/runner.ts

   In runJailAgent(), after the jail is successfully created (after the createJailWithPaths call
   succeeds, around line 174), add:

   - Import createSnapshot and enforceRetentionPolicy from ./snapshots.js
   - Call: await createSnapshot(group.folder, 'pre-agent')
   - Call: await enforceRetentionPolicy(group.folder)
   - Wrap both calls in try/catch -- snapshot failure must NOT prevent agent execution.
     Log a warning on failure but continue.

3. INTEGRATE INTO IPC: src/ipc.ts

   Add a new IPC command type 'rollback_workspace' in the processTaskIpc switch statement.

   The command payload:
   {
     type: 'rollback_workspace',
     snapshotName?: string   // If omitted, rolls back to the most recent snapshot
   }

   Implementation:
   - Only the main group can issue rollback commands (check isMain)
   - Import rollbackToSnapshot and listSnapshots from ../jail/snapshots.js
     (use dynamic import since ipc.ts is shared between Docker and jail runtimes)
   - Detect runtime: check process.env.NANOCLAW_RUNTIME === 'jail' or
     import detectRuntime from container-runtime.ts. If not jail runtime, log a warning
     and break (rollback is jail-only).
   - If snapshotName is provided, validate it starts with the expected dataset prefix
   - If snapshotName is omitted, call listSnapshots(sourceGroup) and use the last entry
   - The jail for the source group must NOT be running (rollback requires stopped jail).
     If it is running, log an error and break.
   - Call rollbackToSnapshot(sourceGroup, snapshotName)
   - Log success at info level

4. INTEGRATE INTO CLEANUP: src/jail/lifecycle.ts

   In cleanupJail(), before the `zfs destroy -f -r dataset` call (around line 553),
   add a call to destroyAllSnapshots(groupId) wrapped in try/catch. This ensures
   snapshots are explicitly cleaned up before the dataset is destroyed. Import from
   ./snapshots.js using dynamic import (to avoid circular dependency issues).

5. CREATE TESTS: src/jail-snapshots.test.ts

   Write unit tests covering:
   - createSnapshot generates correct snapshot name format
   - listSnapshots parses ZFS output correctly
   - listSnapshots filters out non-nc- snapshots
   - rollbackToSnapshot throws if jail is running
   - rollbackToSnapshot validates snapshot name belongs to correct dataset
   - enforceRetentionPolicy destroys oldest snapshots when over limit
   - enforceRetentionPolicy is a no-op when under limit
   - destroyAllSnapshots destroys all nc- snapshots

   Mock child_process.execFileSync and the sudo executor (getSudoExec/getSudoExecSync)
   following the patterns in existing jail tests (src/jail-runtime.test.ts).
   Mock isJailRunning from ./lifecycle.js.

6. Run: npm test, npx tsc --noEmit, npm run lint, npm run format:check
   Fix any failures before reporting completion.

Report: IMPLEMENTATION_COMPLETE
```

### QA Prompt

```
ROLE: QA subagent for nc-p8a
TICKET: Add ZFS snapshot-based session rollback
READ FIRST: refinement/03252026/SHARED_INSTRUCTIONS.md

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only expected files
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

TICKET-SPECIFIC CHECKS:

1. NEW MODULE EXISTS:
   [ ] src/jail/snapshots.ts exists and exports: createSnapshot, listSnapshots,
       rollbackToSnapshot, enforceRetentionPolicy, destroyAllSnapshots
   [ ] SNAPSHOT_RETENTION constant is exported and defaults to 3
   [ ] SnapshotInfo type is added to src/jail/types.ts

2. SNAPSHOT NAMING:
   [ ] Verify createSnapshot uses the naming convention: @nc-<timestamp>-<label>
   [ ] Verify timestamp format is compact ISO (YYYYMMDDTHHmmssZ or similar)
   [ ] Verify default label is 'pre-agent'

3. SECURITY:
   [ ] rollbackToSnapshot validates snapshotName against expected dataset prefix
       (prevents path injection like "../other-dataset@snap")
   [ ] Only sudo is used for write operations (zfs snapshot, zfs rollback, zfs destroy)
   [ ] Non-privileged zfs list is used for read operations where possible

4. RUNNER INTEGRATION:
   [ ] src/jail/runner.ts calls createSnapshot after jail creation
   [ ] src/jail/runner.ts calls enforceRetentionPolicy after snapshot
   [ ] Both calls are wrapped in try/catch so failures do not block agent execution
   [ ] Failure is logged at warn level, not error

5. IPC INTEGRATION:
   [ ] src/ipc.ts has a 'rollback_workspace' case in the processTaskIpc switch
   [ ] Command is restricted to isMain === true
   [ ] Runtime check prevents execution on non-jail runtimes
   [ ] Missing snapshotName falls back to most recent snapshot
   [ ] Running jail check prevents rollback while jail is active

6. CLEANUP INTEGRATION:
   [ ] src/jail/lifecycle.ts calls destroyAllSnapshots before zfs destroy in cleanupJail
   [ ] The call is wrapped in try/catch (cleanup must not fail on snapshot errors)

7. TESTS:
   [ ] src/jail-snapshots.test.ts exists
   [ ] Tests cover: snapshot creation, listing with parse, listing with filter,
       rollback-while-running rejection, rollback path validation,
       retention policy enforcement, destroyAll
   [ ] All mocks use the established patterns (mock child_process, mock sudo executor)
   [ ] Tests do not require root or FreeBSD to pass (fully mocked)

8. NO SCOPE CREEP:
   [ ] No unrelated code changes
   [ ] No new dependencies added to package.json
   [ ] No modifications to files outside the listed files

Report: QA_PASS or QA_FAIL with per-check breakdown.
```

---

## Stage 8B: rctl Resource Monitoring in Metrics Endpoint

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p8b` |
| **Title** | Add rctl resource monitoring to metrics endpoint |
| **Priority** | P3 |
| **Tags** | `nanoclaw`, `phase-8`, `rctl`, `metrics`, `freebsd-native` |
| **Files** | `src/jail/metrics.ts` |
| **Dependencies** | Phase 6 complete |

### Context

FreeBSD's `rctl(8)` provides kernel-level resource accounting for jails. The jail runtime already sets rctl limits at jail creation (`rctl -a jail:<name>:memoryuse:deny=2G` etc. in `src/jail/lifecycle.ts` lines 130-149), but it never reads the actual usage. The `rctl -u jail:<name>` command returns current resource consumption in a parseable format:

```
jail:nanoclaw_mygroup_abc123:cputime=142
jail:nanoclaw_mygroup_abc123:datasize=52428800
jail:nanoclaw_mygroup_abc123:stacksize=8388608
jail:nanoclaw_mygroup_abc123:coredumpsize=0
jail:nanoclaw_mygroup_abc123:memoryuse=167772160
jail:nanoclaw_mygroup_abc123:memorylocked=0
jail:nanoclaw_mygroup_abc123:maxproc=12
jail:nanoclaw_mygroup_abc123:openfiles=47
jail:nanoclaw_mygroup_abc123:vmemoryuse=524288000
jail:nanoclaw_mygroup_abc123:pseudoterminals=2
jail:nanoclaw_mygroup_abc123:swapuse=0
jail:nanoclaw_mygroup_abc123:nthr=15
jail:nanoclaw_mygroup_abc123:msgqqueued=0
jail:nanoclaw_mygroup_abc123:msgqsize=0
jail:nanoclaw_mygroup_abc123:nmsgq=0
jail:nanoclaw_mygroup_abc123:nsem=0
jail:nanoclaw_mygroup_abc123:nsemop=0
jail:nanoclaw_mygroup_abc123:nshm=0
jail:nanoclaw_mygroup_abc123:shmsize=0
jail:nanoclaw_mygroup_abc123:wallclock=300
jail:nanoclaw_mygroup_abc123:pcpu=23
jail:nanoclaw_mygroup_abc123:readbps=0
jail:nanoclaw_mygroup_abc123:writebps=0
jail:nanoclaw_mygroup_abc123:readiops=0
jail:nanoclaw_mygroup_abc123:writeiops=0
```

The current metrics endpoint (`src/jail/metrics.ts`) exposes Prometheus-format metrics for active jails, create counters, epair usage, and ZFS pool space. Adding per-jail rctl metrics is a natural extension. Docker provides similar data via `docker stats`, but rctl is kernel-native with zero overhead and finer granularity.

### Developer Prompt

```
ROLE: Developer subagent for nc-p8b
TICKET: Add rctl resource monitoring to metrics endpoint
READ FIRST: refinement/03252026/SHARED_INSTRUCTIONS.md

CONTEXT:
You are adding per-jail resource usage metrics from FreeBSD's rctl(8) to the existing
Prometheus metrics endpoint in src/jail/metrics.ts. The module already has a metrics
server, counters, and Prometheus formatting. You are extending it with live rctl data.

TASK:

1. MODIFY: src/jail/metrics.ts

   a) Add a new interface for per-jail rctl metrics:

      interface RctlMetrics {
        jailName: string;
        memoryuse: number;     // bytes
        maxproc: number;       // current process count
        pcpu: number;          // CPU percentage (integer)
        cputime: number;       // CPU seconds consumed
        wallclock: number;     // wall-clock seconds
        openfiles: number;     // open file descriptors
      }

   b) Add a module-level variable to store the latest rctl readings:

      let perJailRctlMetrics: RctlMetrics[] = [];

   c) Add a function to poll rctl for all active jails:

      export async function pollRctlMetrics(): Promise<void>

      Implementation:
      - Use execFileSync('sudo', ['rctl', '-u', 'jail:'], ...) to get usage for ALL
        jails in one call. This is more efficient than per-jail queries.
        Alternatively, list active nanoclaw jails first with `jls -N name` and query
        each with `sudo rctl -u jail:<name>`.
      - Parse the key=value output. Each line is: jail:<name>:<resource>=<value>
      - Group by jail name (only include jails matching the nanoclaw_ prefix)
      - Extract: memoryuse, maxproc, pcpu, cputime, wallclock, openfiles
      - Store results in perJailRctlMetrics
      - Wrap the entire function in try/catch. If rctl is not available or RACCT is not
        enabled in the kernel, log a debug message and return (do not fail loudly --
        rctl may not be available on all FreeBSD systems).
      - Set a timeout of 5000ms on the execFileSync call.

   d) Add a polling loop function:

      let rctlPollInterval: ReturnType<typeof setInterval> | null = null;

      export function startRctlPolling(intervalMs: number = 15000): void
      - Calls pollRctlMetrics() immediately, then sets up setInterval
      - Stores the interval handle in rctlPollInterval
      - Default poll interval is 15 seconds (configurable via parameter)
      - Log at info level when polling starts

      export function stopRctlPolling(): void
      - Clears the interval if running
      - Sets rctlPollInterval to null

   e) Extend formatPrometheusMetrics() to include per-jail rctl data:

      Add these metric families after the existing metrics:

      # HELP nanoclaw_jail_memory_usage_bytes Current memory usage per jail in bytes
      # TYPE nanoclaw_jail_memory_usage_bytes gauge
      nanoclaw_jail_memory_usage_bytes{jail="nanoclaw_mygroup_abc123"} 167772160

      # HELP nanoclaw_jail_process_count Current number of processes per jail
      # TYPE nanoclaw_jail_process_count gauge
      nanoclaw_jail_process_count{jail="nanoclaw_mygroup_abc123"} 12

      # HELP nanoclaw_jail_cpu_percent Current CPU usage percentage per jail
      # TYPE nanoclaw_jail_cpu_percent gauge
      nanoclaw_jail_cpu_percent{jail="nanoclaw_mygroup_abc123"} 23

      # HELP nanoclaw_jail_cputime_seconds_total Total CPU time consumed per jail
      # TYPE nanoclaw_jail_cputime_seconds_total counter
      nanoclaw_jail_cputime_seconds_total{jail="nanoclaw_mygroup_abc123"} 142

      # HELP nanoclaw_jail_wallclock_seconds_total Wall-clock time per jail
      # TYPE nanoclaw_jail_wallclock_seconds_total counter
      nanoclaw_jail_wallclock_seconds_total{jail="nanoclaw_mygroup_abc123"} 300

      # HELP nanoclaw_jail_open_files Current open file descriptors per jail
      # TYPE nanoclaw_jail_open_files gauge
      nanoclaw_jail_open_files{jail="nanoclaw_mygroup_abc123"} 47

      Iterate over perJailRctlMetrics and emit one line per jail per metric.
      If perJailRctlMetrics is empty, still emit the HELP/TYPE headers with no data lines
      (this is valid Prometheus format and signals that the metric exists but has no samples).

   f) Integrate polling into startMetricsServer():

      After the server starts listening (in the listen callback, around line 284),
      if config.metricsEnabled is true, call startRctlPolling().
      This ensures rctl polling only runs when someone has opted into metrics.

      Export stopRctlPolling so it can be called during graceful shutdown.

2. DO NOT modify any other files. This is a self-contained change to metrics.ts.

3. ADD TESTS to the existing test infrastructure:

   Add a test file src/jail-rctl-metrics.test.ts with:

   - Test that pollRctlMetrics() correctly parses multi-jail rctl output
   - Test that pollRctlMetrics() handles empty output gracefully
   - Test that pollRctlMetrics() handles rctl not available (command fails)
   - Test that formatPrometheusMetrics() includes per-jail metrics when data is present
   - Test that formatPrometheusMetrics() emits headers but no data when no jails active
   - Test that startRctlPolling/stopRctlPolling manage the interval correctly

   Mock execFileSync for the rctl and jls commands. Use vi.useFakeTimers() for
   interval testing.

   Note: formatPrometheusMetrics is not currently exported. You may need to either:
   (a) export it for testing, or (b) test indirectly by hitting the /metrics endpoint.
   Prefer (a) -- add the export keyword to the function. This is a minor, safe change.

4. Run: npm test, npx tsc --noEmit, npm run lint, npm run format:check
   Fix any failures before reporting completion.

Report: IMPLEMENTATION_COMPLETE
```

### QA Prompt

```
ROLE: QA subagent for nc-p8b
TICKET: Add rctl resource monitoring to metrics endpoint
READ FIRST: refinement/03252026/SHARED_INSTRUCTIONS.md

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only expected files
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

TICKET-SPECIFIC CHECKS:

1. RCTL PARSING:
   [ ] pollRctlMetrics() parses rctl -u output in the format "jail:<name>:<key>=<value>"
   [ ] Only nanoclaw_ prefixed jails are included
   [ ] All 6 resource types are extracted: memoryuse, maxproc, pcpu, cputime, wallclock, openfiles
   [ ] Values are parsed as numbers (not strings)

2. GRACEFUL DEGRADATION:
   [ ] pollRctlMetrics() does not throw if rctl command fails
   [ ] pollRctlMetrics() does not throw if output is empty
   [ ] Failure is logged at debug level (not error or warn -- rctl may legitimately be unavailable)
   [ ] execFileSync call has a timeout (5000ms or similar)

3. PROMETHEUS FORMAT:
   [ ] Each per-jail metric has correct HELP and TYPE headers
   [ ] Metric names follow Prometheus conventions (snake_case, unit suffix)
   [ ] Gauge types used for point-in-time values (memory, process count, cpu percent, open files)
   [ ] Counter types used for monotonically increasing values (cputime, wallclock)
   [ ] Jail name is a label: {jail="<name>"}
   [ ] Empty perJailRctlMetrics produces headers but no data lines

4. POLLING:
   [ ] startRctlPolling() calls pollRctlMetrics() immediately (not just after first interval)
   [ ] Default interval is 15 seconds
   [ ] stopRctlPolling() clears the interval
   [ ] Polling is only started when metricsEnabled is true
   [ ] startRctlPolling is called inside startMetricsServer when metrics are enabled

5. TESTS:
   [ ] src/jail-rctl-metrics.test.ts exists
   [ ] Tests cover: multi-jail parsing, empty output, rctl unavailable,
       Prometheus output with data, Prometheus output without data,
       polling start/stop lifecycle
   [ ] Mocks are properly cleaned up between tests

6. NO SCOPE CREEP:
   [ ] Only src/jail/metrics.ts is modified (plus the new test file)
   [ ] No new dependencies added to package.json
   [ ] Existing metrics (active_jails, jail_create_total, epair_used, zfs_pool_bytes_avail)
       are unchanged and still present in output
   [ ] formatPrometheusMetrics export is the only signature change to existing code

Report: QA_PASS or QA_FAIL with per-check breakdown.
```

---

## Stage 8C: Jail Persistence Mode

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p8c` |
| **Title** | Implement jail persistence mode |
| **Priority** | P3 |
| **Tags** | `nanoclaw`, `phase-8`, `persistence`, `lifecycle`, `freebsd-native` |
| **Files** | `src/jail/runner.ts`, `src/jail/lifecycle.ts`, `src/jail/config.ts`, `src/jail/types.ts` |
| **Dependencies** | Phase 6 complete; 8A (ZFS snapshots) should be merged first for inter-session rollback |

### Context

Currently, jails follow Docker's `--rm` pattern: create before agent execution, destroy after. This is clean and simple but incurs repeated startup costs and discards all in-jail caches (npm packages, TypeScript compilation artifacts, Node.js module resolution caches). For groups with frequent interactions, a persistent jail that stays alive between messages eliminates this overhead entirely.

The lifecycle change is significant:
- **Current flow**: message arrives -> create jail -> run agent -> destroy jail
- **Persistent flow**: message arrives -> reuse existing jail (or create if first time) -> run agent -> jail stays alive -> idle timeout triggers cleanup

Key design decisions:
1. **ZFS snapshot between sessions**: After agent completes, take a snapshot. Before next session, optionally rollback to that snapshot (provides a clean-but-cached state). This leverages 8A's snapshot module.
2. **Idle timeout**: Persistent jails should not live forever. After N minutes of inactivity, destroy them. This prevents resource exhaustion.
3. **Explicit reset**: An IPC command `/jail-reset` force-destroys and recreates the jail, giving users a way to get a truly fresh start.
4. **Backward compatible**: The default behavior (`NANOCLAW_JAIL_PERSIST=false`) is unchanged.

In `src/jail/runner.ts`, the current `onClose` and `onError` callbacks both call `destroyJail()`. In persistent mode, `onClose` should skip destruction and instead take a snapshot, while `onError` should still destroy (errors indicate a corrupted jail state).

### Developer Prompt

```
ROLE: Developer subagent for nc-p8c
TICKET: Implement jail persistence mode
READ FIRST: refinement/03252026/SHARED_INSTRUCTIONS.md

CONTEXT:
You are adding an optional jail persistence mode where jails survive between agent
invocations. Currently, jails are created fresh for each message and destroyed after.
In persistent mode, the jail stays alive and is reused for subsequent messages to the
same group, with ZFS snapshots providing state management between sessions.

TASK:

1. MODIFY: src/jail/config.ts

   Add the following configuration constants:

   a) JAIL_PERSIST: boolean
      - Read from process.env.NANOCLAW_JAIL_PERSIST
      - Default: false
      - Parse: value === 'true' || value === '1'

   b) JAIL_IDLE_TIMEOUT: number (milliseconds)
      - Read from process.env.NANOCLAW_JAIL_IDLE_TIMEOUT
      - Default: 900000 (15 minutes)
      - Use clampInt with min=60000 (1 minute), max=86400000 (24 hours)

   c) JAIL_PERSIST_ROLLBACK: boolean
      - Read from process.env.NANOCLAW_JAIL_PERSIST_ROLLBACK
      - Default: true
      - When true, rollback to the post-creation snapshot before each reuse.
        This gives a "clean but cached" state (template packages present, but
        previous agent changes reverted).
      - When false, the jail accumulates state across sessions.

   Export all three constants.

2. MODIFY: src/jail/types.ts

   Add a new interface:

   interface PersistentJailState {
     groupId: string;
     jailName: string;
     mounts: JailMount[];
     createdAt: number;           // Date.now() when jail was created
     lastUsedAt: number;          // Date.now() when last agent session ended
     sessionCount: number;        // number of agent sessions run in this jail
     baselineSnapshot?: string;   // snapshot taken after initial creation (for rollback)
   }

3. MODIFY: src/jail/lifecycle.ts

   a) Add a module-level Map to track persistent jail state:

      const persistentJails = new Map<string, PersistentJailState>();

   b) Add exported functions for persistent jail management:

      export function getPersistentJail(groupId: string): PersistentJailState | undefined
      - Returns the persistent state if one exists for this group

      export function setPersistentJail(groupId: string, state: PersistentJailState): void
      - Stores the persistent state

      export function removePersistentJail(groupId: string): void
      - Removes from the map

      export function getAllPersistentJails(): PersistentJailState[]
      - Returns all persistent jail states (for idle timeout scanning)

      export function updatePersistentJailLastUsed(groupId: string): void
      - Updates lastUsedAt to Date.now() and increments sessionCount

   c) Add idle timeout scanning:

      let idleTimeoutInterval: ReturnType<typeof setInterval> | null = null;

      export function startIdleTimeoutScanner(intervalMs?: number): void
      - Default scan interval: 60000 (1 minute)
      - Every interval, iterate getAllPersistentJails()
      - For each jail where (Date.now() - lastUsedAt) > JAIL_IDLE_TIMEOUT:
        - Log at info level: "Destroying idle persistent jail"
        - Call cleanupJail(groupId, state.mounts)
        - Call removePersistentJail(groupId)
      - Wrap each cleanup in try/catch (one idle jail failing should not prevent others
        from being cleaned up)

      export function stopIdleTimeoutScanner(): void
      - Clears the interval

   d) Modify cleanupJail() to also remove from persistentJails:
      - At the start of the finally block (around line 596), add:
        removePersistentJail(groupId);
      - This ensures the persistent state is always cleaned up even on errors.

4. MODIFY: src/jail/runner.ts

   Modify runJailAgent() to support persistence:

   a) At the top, import JAIL_PERSIST, JAIL_PERSIST_ROLLBACK, JAIL_IDLE_TIMEOUT from ./config.js
      and getPersistentJail, setPersistentJail, updatePersistentJailLastUsed from ./lifecycle.js

   b) Before jail creation, check for an existing persistent jail:

      if (JAIL_PERSIST) {
        const existingJail = getPersistentJail(group.folder);
        if (existingJail) {
          // Verify the jail is actually still running
          const running = await jailLifecycle.isJailRunningAsync(existingJail.jailName);
          if (running) {
            log.info({ jailName: existingJail.jailName, sessionCount: existingJail.sessionCount },
              'Reusing persistent jail');
            jailName = existingJail.jailName;
            jailMounts = existingJail.mounts;

            // Optionally rollback to baseline snapshot
            if (JAIL_PERSIST_ROLLBACK && existingJail.baselineSnapshot) {
              try {
                // Stop jail, rollback, restart
                await jailLifecycle.stopJail(group.folder);
                const { rollbackToSnapshot } = await import('./snapshots.js');
                await rollbackToSnapshot(group.folder, existingJail.baselineSnapshot);
                // Re-create jail (re-start with same config)
                // The jail.conf file still exists, so we can just start it
                const sudoExec = (await import('./sudo.js')).getSudoExec();
                const confPath = path.join(
                  (await import('./config.js')).JAIL_CONFIG.jailsPath,
                  `${jailName}.conf`
                );
                await sudoExec(['jail', '-f', confPath, '-c', jailName]);
                log.info({ jailName }, 'Persistent jail rolled back and restarted');
              } catch (err) {
                log.warn({ jailName, err }, 'Rollback failed, continuing with current state');
              }
            }

            // Skip the jail creation block below
            // (use a flag or restructure into if/else)
          } else {
            // Jail was persistent but is no longer running (crashed?)
            log.warn({ jailName: existingJail.jailName },
              'Persistent jail no longer running, recreating');
            removePersistentJail(group.folder);
            // Fall through to normal creation
          }
        }
      }

      IMPORTANT: Structure the code so that the existing jail creation block is only
      executed when we are NOT reusing a persistent jail. Use a boolean flag like
      `let reusingPersistentJail = false` and set it to true when reuse succeeds.

   c) After successful jail creation (for new jails, not reused ones), if JAIL_PERSIST
      is true:

      - Take a baseline snapshot (if snapshots module is available):
        try {
          const { createSnapshot } = await import('./snapshots.js');
          const baselineSnap = await createSnapshot(group.folder, 'baseline');
          // Store persistent state
          setPersistentJail(group.folder, {
            groupId: group.folder,
            jailName,
            mounts: jailMounts,
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
            sessionCount: 0,
            baselineSnapshot: baselineSnap,
          });
        } catch (err) {
          log.warn({ err }, 'Could not create baseline snapshot for persistent jail');
          // Still register as persistent, just without rollback capability
          setPersistentJail(group.folder, {
            groupId: group.folder,
            jailName,
            mounts: jailMounts,
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
            sessionCount: 0,
          });
        }

   d) Modify the onClose callback:

      If JAIL_PERSIST is true and the agent exited successfully (proc exit code 0):
      - Do NOT call destroyJail. Instead:
        - Call updatePersistentJailLastUsed(group.folder)
        - Log: "Persistent jail kept alive"
      - If exit code is non-zero, fall through to existing destroyJail behavior
        (treat errors as corrupted state)

      If JAIL_PERSIST is false: existing behavior (destroyJail).

   e) The onError callback should ALWAYS call destroyJail (even in persistent mode).
      Also call removePersistentJail(group.folder) to clean up tracking state.

   f) The onTimeout callback should ALWAYS call stopJail + destroyJail (even in persistent
      mode). Also call removePersistentJail(group.folder).

5. ADD IPC COMMAND: src/ipc.ts

   Add a 'jail_reset' case to processTaskIpc:

   {
     type: 'jail_reset',
     groupFolder?: string   // If omitted, resets the source group's jail
   }

   Implementation:
   - Both main and non-main groups can reset their own jail
   - Only main can reset another group's jail (when groupFolder is specified)
   - Check runtime is jail (dynamic import of container-runtime.ts)
   - Import cleanupJail from ../jail/lifecycle.js and removePersistentJail
   - Call removePersistentJail then cleanupJail for the target group
   - Log at info level

6. START IDLE SCANNER:

   In src/jail/runner.ts, at module scope (outside runJailAgent), add:

   // Start idle timeout scanner if persistence is enabled
   import { JAIL_PERSIST } from './config.js';
   if (JAIL_PERSIST) {
     import('./lifecycle.js').then(({ startIdleTimeoutScanner }) => {
       startIdleTimeoutScanner();
     });
   }

   This is a top-level side effect that runs once when the module is first imported.
   Alternatively, if the existing code avoids top-level side effects, integrate the
   scanner start into runJailAgent with a "started" guard flag.

7. CREATE TESTS: src/jail-persistence.test.ts

   Write unit tests covering:
   - getPersistentJail / setPersistentJail / removePersistentJail CRUD operations
   - Persistent jail reuse path (isJailRunningAsync returns true -> skip creation)
   - Persistent jail recreation path (isJailRunningAsync returns false -> create new)
   - onClose with JAIL_PERSIST=true does NOT destroy jail
   - onClose with JAIL_PERSIST=false DOES destroy jail (backward compat)
   - onError ALWAYS destroys jail regardless of JAIL_PERSIST
   - Idle timeout scanner destroys jails past the timeout
   - Idle timeout scanner leaves active jails alone
   - jail_reset IPC command cleans up persistent jail state

   Mock the jail lifecycle, exec, config, and snapshots modules.
   Use vi.useFakeTimers() for idle timeout tests.

8. Run: npm test, npx tsc --noEmit, npm run lint, npm run format:check
   Fix any failures before reporting completion.

Report: IMPLEMENTATION_COMPLETE
```

### QA Prompt

```
ROLE: QA subagent for nc-p8c
TICKET: Implement jail persistence mode
READ FIRST: refinement/03252026/SHARED_INSTRUCTIONS.md

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only expected files
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

TICKET-SPECIFIC CHECKS:

1. CONFIGURATION:
   [ ] JAIL_PERSIST is exported from src/jail/config.ts, defaults to false
   [ ] JAIL_IDLE_TIMEOUT is exported, defaults to 900000, clamped between 60000 and 86400000
   [ ] JAIL_PERSIST_ROLLBACK is exported, defaults to true
   [ ] All three read from environment variables

2. TYPE DEFINITIONS:
   [ ] PersistentJailState interface exists in src/jail/types.ts
   [ ] Interface has all required fields: groupId, jailName, mounts, createdAt,
       lastUsedAt, sessionCount, baselineSnapshot (optional)

3. LIFECYCLE STATE MANAGEMENT:
   [ ] persistentJails Map exists in src/jail/lifecycle.ts (module-level, not exported directly)
   [ ] getPersistentJail, setPersistentJail, removePersistentJail, getAllPersistentJails,
       updatePersistentJailLastUsed are all exported
   [ ] cleanupJail() calls removePersistentJail in its finally block
   [ ] updatePersistentJailLastUsed updates lastUsedAt AND increments sessionCount

4. RUNNER PERSISTENCE LOGIC:
   [ ] runJailAgent checks for existing persistent jail before creating new one
   [ ] Reuse path verifies jail is actually running (isJailRunningAsync)
   [ ] Stale persistent jail (not running) triggers recreation, not reuse
   [ ] New persistent jails get a baseline snapshot stored in state
   [ ] Snapshot failure does not prevent persistence (graceful degradation)

5. ROLLBACK BETWEEN SESSIONS:
   [ ] When JAIL_PERSIST_ROLLBACK=true and baselineSnapshot exists, jail is stopped,
       rolled back, and restarted before reuse
   [ ] Rollback failure does not prevent agent execution (warn + continue)
   [ ] When JAIL_PERSIST_ROLLBACK=false, no rollback occurs

6. LIFECYCLE CALLBACKS:
   [ ] onClose with JAIL_PERSIST=true and exit code 0: does NOT destroy jail
   [ ] onClose with JAIL_PERSIST=true and non-zero exit: DOES destroy jail
   [ ] onClose with JAIL_PERSIST=false: DOES destroy jail (backward compatible)
   [ ] onError: ALWAYS destroys jail and removes persistent state
   [ ] onTimeout: ALWAYS destroys jail and removes persistent state

7. IDLE TIMEOUT:
   [ ] startIdleTimeoutScanner starts periodic scanning
   [ ] Scanner destroys jails where (now - lastUsedAt) > JAIL_IDLE_TIMEOUT
   [ ] Scanner calls cleanupJail and removePersistentJail
   [ ] Individual cleanup errors do not prevent other jails from being scanned
   [ ] stopIdleTimeoutScanner clears the interval
   [ ] Scanner is only started when JAIL_PERSIST is true

8. IPC COMMAND:
   [ ] 'jail_reset' case exists in processTaskIpc in src/ipc.ts
   [ ] Non-main groups can only reset their own jail
   [ ] Main group can reset any group's jail
   [ ] Runtime check prevents execution on non-jail runtimes
   [ ] Command calls removePersistentJail then cleanupJail

9. BACKWARD COMPATIBILITY:
   [ ] With NANOCLAW_JAIL_PERSIST unset or false, behavior is identical to pre-change
   [ ] No existing test failures introduced
   [ ] The create-run-destroy flow works exactly as before when persistence is off

10. TESTS:
    [ ] src/jail-persistence.test.ts exists
    [ ] Tests cover: CRUD operations, reuse path, recreation path, onClose behavior
        (both persist modes), onError behavior, idle timeout, jail_reset IPC
    [ ] Tests verify backward compatibility (JAIL_PERSIST=false)
    [ ] Mocks are properly cleaned up

11. NO SCOPE CREEP:
    [ ] Only the listed files are modified (plus new test file)
    [ ] No new dependencies added to package.json
    [ ] No changes to the snapshot module (8A) beyond importing it

Report: QA_PASS or QA_FAIL with per-check breakdown.
```

---

## Phase 8 Integration QA

After all three stage tickets (8A, 8B, 8C) pass individual QA and their branches are merged into a single phase branch, run this integration QA.

### Integration QA Prompt

```
ROLE: Phase Integration QA subagent
PHASE: Phase 8 -- FreeBSD-Native Features
READ FIRST: refinement/03252026/SHARED_INSTRUCTIONS.md

CONTEXT:
All three Phase 8 stages have been implemented and merged into a single branch.
This integration QA verifies that the three features work together correctly and
do not interfere with each other or with existing functionality.

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check

INTEGRATION CHECKS:

1. MODULE DEPENDENCY GRAPH:
   [ ] src/jail/snapshots.ts imports from: ./config.js, ./lifecycle.js, ./sudo.js, ./types.js
       and does NOT have circular imports
   [ ] src/jail/metrics.ts does NOT import from snapshots.ts or lifecycle.ts directly
       (it gets data via updateMetrics callback or module-level state)
   [ ] src/jail/runner.ts imports from snapshots.ts via dynamic import (not top-level)
       to avoid loading snapshot code when persistence is disabled
   [ ] src/jail/lifecycle.ts imports from snapshots.ts via dynamic import in cleanupJail
       (not top-level) to avoid circular dependency

2. SNAPSHOT + PERSISTENCE INTERACTION:
   [ ] When JAIL_PERSIST=true: baseline snapshot is created after jail creation
   [ ] When JAIL_PERSIST=true and JAIL_PERSIST_ROLLBACK=true: rollback uses the
       baseline snapshot from PersistentJailState, not a hardcoded name
   [ ] When JAIL_PERSIST=false: pre-agent snapshots are still created (8A standalone behavior)
   [ ] enforceRetentionPolicy does not destroy the baseline snapshot used by persistence
       (baseline snapshot has label 'baseline', retention deletes oldest 'pre-agent' snapshots)
   [ ] cleanupJail calls destroyAllSnapshots before dataset destroy regardless of persistence mode

3. METRICS + PERSISTENCE INTERACTION:
   [ ] rctl polling includes persistent jails in its output (they are still running jails)
   [ ] Active jail count metric reflects persistent jails
   [ ] When a persistent jail is idle-timeout destroyed, it is no longer in rctl output
       on the next poll

4. ALL THREE FEATURES TOGETHER:
   [ ] A persistent jail has: rctl metrics reported, pre-agent snapshots taken,
       baseline snapshot for rollback, idle timeout for cleanup
   [ ] Destroying a persistent jail via idle timeout: removes rctl metrics, destroys
       all snapshots, cleans up dataset

5. IPC COMMANDS:
   [ ] 'rollback_workspace' (from 8A) and 'jail_reset' (from 8C) are both present
       in processTaskIpc and do not conflict
   [ ] Both commands check runtime and isMain appropriately
   [ ] 'jail_reset' on a persistent jail: removes persistent state, destroys snapshots,
       destroys jail

6. CONFIG COMPLETENESS:
   [ ] All new env vars are documented in JAIL_CONFIG or as module-level constants:
       NANOCLAW_SNAPSHOT_RETENTION, NANOCLAW_JAIL_PERSIST, NANOCLAW_JAIL_IDLE_TIMEOUT,
       NANOCLAW_JAIL_PERSIST_ROLLBACK
   [ ] Default values are sensible and safe (persist=false, retention=3, timeout=15min,
       rollback=true)

7. BACKWARD COMPATIBILITY:
   [ ] With all new env vars unset, behavior is identical to pre-Phase-8
   [ ] No existing tests are modified or broken
   [ ] The existing create-run-destroy flow works exactly as before

8. TEST COVERAGE:
   [ ] src/jail-snapshots.test.ts passes
   [ ] src/jail-rctl-metrics.test.ts passes
   [ ] src/jail-persistence.test.ts passes
   [ ] Existing test files pass: src/jail-runtime.test.ts, src/jail-mount-security.test.ts,
       src/jail-network-isolation.test.ts, src/jail-stress.test.ts

9. NO REGRESSIONS:
   [ ] git diff against the phase-6 merge base shows only expected file changes
   [ ] No files outside src/jail/, src/ipc.ts, and test files are modified
   [ ] package.json and package-lock.json are unchanged (no new dependencies)

Report: QA_PASS or QA_FAIL with per-check breakdown.
If QA_FAIL, identify which stage(s) caused the failure and what needs to be fixed.
```
