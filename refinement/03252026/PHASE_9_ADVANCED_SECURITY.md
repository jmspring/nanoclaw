# Phase 9: Advanced Security and Observability

**Priority**: P3-P4 -- defense-in-depth and production observability
**Depends on**: Phase 5 (CI/CD), Phase 6 (Operational Maturity)
**Rationale**: Long-term hardening and differentiation from Docker runtime. These tickets are larger and more exploratory than previous phases. Each involves design decisions that may require judgment calls during implementation.

**Reference**: Before starting any ticket, read `SHARED_INSTRUCTIONS.md` for environment setup, coding standards, test patterns, and commit conventions.

---

## Overview

Phase 9 adds four advanced capabilities that deepen the security posture and observability of the FreeBSD jail runtime:

| Stage | Ticket ID | Title | Files | Effort | Nature |
|-------|-----------|-------|-------|--------|--------|
| 9A | nc-p9a | CLAUDE.md integrity checking with alerting | `src/container-runner.ts`, `src/integrity.ts` (new), `src/integrity.test.ts` (new) | Medium | Extend existing pattern |
| 9B | nc-p9b | Structured alerting module | `src/alerting.ts` (new), `src/alerting.test.ts` (new), `src/index.ts` | Medium | New module, refactor existing |
| 9C | nc-p9c | DTrace scripts for agent observability | `etc/dtrace/` (new), `src/jail/dtrace.ts` (new), `src/jail/dtrace.test.ts` (new) | Large | Exploratory, FreeBSD-native |
| 9D | nc-p9d | Capsicum sandboxing for credential proxy | `src/capsicum.ts` (new), `src/credential-proxy.ts`, native addon | Large | Exploratory, requires native code |

**Acceptance**: CLAUDE.md hash verified before/after agent runs with alert on mismatch. Critical conditions push alerts to admin channel via a structured, channel-agnostic module. DTrace scripts trace jail I/O and network activity. Credential proxy enters Capsicum capability mode after socket bind.

---

## Stage 9A: CLAUDE.md Integrity Checking with Alerting

### Ticket Header

```
ID:           nc-p9a
Title:        Add CLAUDE.md integrity checking with hash storage and alerting
Priority:     P3
Tags:         nanoclaw, phase-9, security, integrity
Files:        src/container-runner.ts, src/integrity.ts (new), src/integrity.test.ts (new)
Dependencies: Phase 5 (CI), Phase 6 (health endpoint, token persistence patterns)
```

### Context

CLAUDE.md files in group directories serve as persistent memory and system prompts for agents. A compromised agent could modify CLAUDE.md to inject persistent backdoor instructions that survive across sessions -- a prompt injection persistence vector. The security engineer and product manager reports both identified this as a gap (PM report section 3.2 item 8, hardening plan Phase 7).

There is already a partial implementation: `container-runner.ts` lines 318-320 compute a SHA-256 hash before and after each agent run and log a warning on mismatch. However, this implementation has three gaps:

1. **No baseline storage**: Hashes are computed fresh each time. There is no record of the "known-good" hash, so a modification that persists across runs becomes the new baseline silently.
2. **No alerting**: The mismatch only produces a `log.warn()`. The operator is not notified unless they are actively watching logs.
3. **No audit trail**: There is no record of which runs produced modifications or what the expected hash should be.

### Developer Prompt

```
TICKET: nc-p9a -- CLAUDE.md integrity checking with hash storage and alerting
WORKTREE: /tmp/nanoclaw-nc-p9a

Read SHARED_INSTRUCTIONS.md before starting.

CONTEXT:
The existing code in src/container-runner.ts (lines 293-301, 318-320, 411-418) already
computes SHA-256 hashes of CLAUDE.md before and after agent runs and logs a warning on
mismatch. Your task is to formalize this into a proper integrity checking system with
persistent hash storage, baseline management, and alerting.

Read these files before writing any code:
- src/container-runner.ts (existing hashFile() and pre/post hash comparison)
- src/index.ts (adminAlertFn pattern at lines 86-88, sendAdminAlert at lines 817-829)
- src/config.ts (DATA_DIR, GROUPS_DIR constants)
- src/db.ts (SQLite patterns -- you may optionally store hashes here)

REQUIREMENTS:

1. Create src/integrity.ts with these exports:
   - IntegrityStore class or module that manages known-good CLAUDE.md hashes
   - Storage: use a JSON file at `${DATA_DIR}/integrity-hashes.json` (follows the
     existing pattern of epairs.json and session-state.json for file-based persistence)
   - The store maps `groupFolder -> { hash: string, updatedAt: string, updatedBy: string }`
   - loadHashes(): Load from disk on startup
   - saveHashes(): Atomic write (write to .tmp, chmod 0o600, rename -- same pattern as
     session-state.json in index.ts lines 130-134)
   - getExpectedHash(groupFolder: string): string | null
   - setExpectedHash(groupFolder: string, hash: string, updatedBy: string): void
   - checkIntegrity(groupFolder: string, currentHash: string): IntegrityResult
     where IntegrityResult = { status: 'match' | 'mismatch' | 'new' | 'missing_file',
     expectedHash?: string, actualHash?: string }

2. Modify src/container-runner.ts to use the integrity module:
   - Before the agent run: compute hash (existing), check against stored baseline
   - After the agent run: compute hash (existing), compare to pre-run hash
   - If post-run hash differs from pre-run hash:
     a. Log warning (existing behavior, keep it)
     b. Call an alert callback if provided (new parameter or module-level registration)
     c. Do NOT automatically update the baseline -- the operator must approve changes
   - If pre-run hash differs from stored baseline (file was modified outside an agent run):
     a. Log warning with details
     b. Alert the operator
   - If no baseline exists (new group): store the current hash as baseline with
     updatedBy: 'auto-initial'

3. DESIGN DECISIONS (use your judgment):
   - Whether to use a JSON file (simpler, consistent with epairs.json) or SQLite
     (consistent with db.ts, supports querying). JSON file is recommended for simplicity,
     but if you see a strong reason for SQLite, document it in a code comment.
   - Whether the alert callback should be passed as a parameter to runContainerAgent()
     or registered at module level. Module-level registration (like adminAlertFn in
     index.ts) avoids changing the function signature, which is better for upstream
     compatibility.
   - Whether to add a CLI/IPC command for approving CLAUDE.md changes (updating the
     baseline). This is optional for this ticket -- a simple log message telling the
     operator how to manually reset the hash is sufficient. If you do add it, use the
     IPC pattern from src/ipc.ts.

4. Create src/integrity.test.ts with tests covering:
   - Loading/saving hash store (mock fs)
   - checkIntegrity returns 'match' when hashes agree
   - checkIntegrity returns 'mismatch' when hashes differ
   - checkIntegrity returns 'new' when no baseline exists
   - checkIntegrity returns 'missing_file' when file doesn't exist
   - Atomic write pattern (tmp file + rename)
   - Auto-initial baseline creation for new groups
   - Integration: pre-run baseline mismatch detection

5. Do NOT remove the existing hashFile() function or the existing pre/post comparison
   logic. Extend it, don't replace it. The hashFile() function is exported and may be
   used elsewhere.

Run: npm test, npx tsc --noEmit, npm run lint, npm run format:check
Report: IMPLEMENTATION_COMPLETE
```

### QA Prompt

```
TICKET: nc-p9a -- QA validation for CLAUDE.md integrity checking
WORKTREE: /tmp/nanoclaw-nc-p9a

Read SHARED_INSTRUCTIONS.md before starting.

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only expected files
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

TICKET-SPECIFIC CHECKS:

[ ] src/integrity.ts exists and exports: loadHashes, saveHashes, getExpectedHash,
    setExpectedHash, checkIntegrity (or equivalent API)

[ ] IntegrityResult type has status field with values: 'match', 'mismatch', 'new',
    'missing_file'

[ ] Hash storage file path uses DATA_DIR (not hardcoded path)

[ ] Atomic write pattern: verify the save function writes to a .tmp file, sets
    permissions to 0o600, then renames (read the code, compare to session-state.json
    pattern in src/index.ts lines 130-134)

[ ] src/container-runner.ts still contains the existing hashFile() export
    (verify with grep)

[ ] src/container-runner.ts pre/post hash comparison still exists (the log.warn
    for 'CLAUDE.md was modified during agent run' must still be present)

[ ] src/container-runner.ts now calls integrity module functions (check for import
    of integrity.ts and calls to checkIntegrity or equivalent)

[ ] Alert mechanism exists: verify that a mismatch triggers an alert (either via
    callback, module-level function, or event emitter -- check that the alert path
    is wired up, not just defined)

[ ] Baseline is NOT automatically updated on agent modification: verify the code
    does not call setExpectedHash after detecting a post-run mismatch (the operator
    must approve)

[ ] Auto-initial: when no baseline exists, the current hash is stored automatically
    (look for 'auto-initial' or equivalent marker in the updatedBy field)

[ ] Test file exists: src/integrity.test.ts

[ ] Tests cover at minimum: match, mismatch, new, missing_file cases (read the
    test file and verify)

[ ] No 'any' type usage in new code (grep for ': any' in src/integrity.ts)

[ ] Import uses .js extension (NodeNext resolution): import ... from './integrity.js'

Report: QA_PASS or QA_FAIL with per-check breakdown
```

---

## Stage 9B: Structured Alerting Module

### Ticket Header

```
ID:           nc-p9b
Title:        Add structured alerting module with channel-agnostic interface
Priority:     P3
Tags:         nanoclaw, phase-9, observability, alerting
Files:        src/alerting.ts (new), src/alerting.test.ts (new), src/index.ts
Dependencies: Phase 6 (health endpoint, admin alert pattern exists)
```

### Context

NanoClaw currently has a rudimentary alerting mechanism: the `adminAlertFn` callback in `src/index.ts` (lines 86-88) sends a message to the first main group's channel when consecutive agent failures reach a threshold of 3. The jail runtime also has `startJailHealthChecks()` that calls `sendAdminAlert` for ZFS/template issues.

However, this alerting is:
1. **Ad-hoc**: Each alert site constructs its own message string with no structure.
2. **Single-channel**: Alerts only go to the messaging channel (WhatsApp/Telegram/etc.). There is no way to also send to a webhook, write to syslog, or log to an audit file.
3. **No severity levels**: A ZFS pool warning and a security breach get the same treatment.
4. **No deduplication**: The same condition can fire repeatedly (e.g., ZFS low space on every health check interval).
5. **Scattered**: Alert logic is spread across `index.ts`, `jail/index.ts`, and potentially `container-runner.ts` (after 9A).

The SRE report (section 4, section 10) and product manager report (section 3.2 item 5) both recommend structured alerting. The BSD PM report identifies this as a production readiness gap.

### Developer Prompt

```
TICKET: nc-p9b -- Structured alerting module with channel-agnostic interface
WORKTREE: /tmp/nanoclaw-nc-p9b

Read SHARED_INSTRUCTIONS.md before starting.

CONTEXT:
NanoClaw has ad-hoc alerting scattered across index.ts (consecutiveAgentFailures +
adminAlertFn) and jail health checks (startJailHealthChecks calling sendAdminAlert).
Your task is to create a structured alerting module that centralizes alert management,
adds severity levels, supports multiple output targets, and provides deduplication.

Read these files before writing any code:
- src/index.ts (adminAlertFn at line 88, sendAdminAlert at lines 817-829,
  consecutiveAgentFailures at lines 86-87, 447-455, 462-468,
  startJailHealthChecks at line 838)
- src/jail/metrics.ts (health check logic)
- src/logger.ts (pino logger patterns)
- src/config.ts (DATA_DIR)

REQUIREMENTS:

1. Create src/alerting.ts with these exports:

   a. Alert severity enum or union type:
      - 'critical': Security breach, data loss imminent (e.g., CLAUDE.md tampering,
        ZFS pool full)
      - 'warning': Degraded state, attention needed (e.g., ZFS pool low, template
        missing, channel disconnected)
      - 'info': Notable event, no action required (e.g., jail cleanup completed,
        agent failure recovered)

   b. Alert interface:
      {
        severity: AlertSeverity;
        category: string;         // e.g., 'security', 'storage', 'agent', 'network'
        title: string;            // Short summary (one line)
        detail?: string;          // Extended description
        groupFolder?: string;     // If alert relates to a specific group
        metadata?: Record<string, unknown>;  // Arbitrary structured data
        timestamp: string;        // ISO 8601
      }

   c. AlertSink interface (output target):
      {
        name: string;
        send(alert: Alert): Promise<void>;
      }

   d. AlertManager class:
      - constructor(options?: { dedupeWindowMs?: number })
      - registerSink(sink: AlertSink): void
      - removeSink(name: string): void
      - async fire(severity, category, title, detail?, metadata?): Promise<void>
        Constructs an Alert, checks deduplication, dispatches to all registered sinks.
      - Deduplication: alerts with the same (severity + category + title) are suppressed
        for a configurable window (default: 15 minutes). This prevents spamming the
        operator with repeated ZFS low space warnings every health check cycle.
      - All alerts are logged via pino regardless of sinks (alerts should never be lost
        even if all sinks fail).

   e. Built-in sinks (exported as factory functions):
      - createChannelSink(sendFn: (msg: string) => Promise<void>): AlertSink
        Formats the alert as a human-readable message with severity prefix
        (e.g., "[CRITICAL] Security: CLAUDE.md tampered in group 'work'")
        and calls the provided send function. This replaces the current adminAlertFn
        pattern.
      - createLogSink(logPath?: string): AlertSink
        Appends JSON-formatted alerts to a file (default: ${DATA_DIR}/alerts.log).
        This provides a persistent audit trail of all alerts.

2. Modify src/index.ts to use the AlertManager:
   - Import and instantiate AlertManager early in main()
   - Register the channel sink using the existing sendAdminAlert function
   - Register the log sink
   - Replace the consecutiveAgentFailures alerting (lines 447-455, 462-468) with
     alertManager.fire('warning', 'agent', '...')
   - Pass the alertManager (or a bound fire function) to startJailHealthChecks
     instead of the raw sendAdminAlert callback
   - Wire up the adminAlertFn to use alertManager.fire() so other code that
     calls adminAlertFn still works during the transition

3. DESIGN DECISIONS (use your judgment):
   - Whether AlertManager should be a singleton or instance-based. Instance-based
     is better for testing, but a singleton is simpler for global access. Recommendation:
     instance-based with a module-level getter (like the logger pattern).
   - Whether to support async sink registration (some sinks might need initialization).
     Keep it simple -- synchronous registration is fine for now.
   - Whether to add a webhook sink (HTTP POST to a URL). This is optional and can be
     added later. If you include it, make it opt-in via an env var
     (NANOCLAW_ALERT_WEBHOOK_URL).
   - How to handle sink failures: log the error and continue to other sinks (never
     let a failing sink prevent alert delivery to other sinks).
   - Whether the deduplication key should include detail/metadata or only
     severity+category+title. Recommendation: only severity+category+title, so that
     repeated instances of "ZFS pool low" with slightly different free-space numbers
     are still deduplicated.

4. Create src/alerting.test.ts with tests covering:
   - AlertManager fires to all registered sinks
   - Deduplication suppresses repeated alerts within the window
   - Deduplication allows alerts after the window expires (use vi.advanceTimersByTime)
   - Different (severity+category+title) combinations are not deduplicated
   - Sink failure does not prevent delivery to other sinks
   - createChannelSink formats messages correctly with severity prefix
   - createLogSink appends JSON to file (mock fs)
   - fire() always logs via pino even if no sinks registered

5. IMPORTANT: Do not change the function signature of startJailHealthChecks or
   runContainerAgent in this ticket. Instead, adapt the alertManager to be compatible
   with the existing (msg: string) => Promise<void> callback signature. The channel
   sink's sendFn matches this signature exactly. The goal is to centralize alerting
   without a disruptive refactor of call sites.

Run: npm test, npx tsc --noEmit, npm run lint, npm run format:check
Report: IMPLEMENTATION_COMPLETE
```

### QA Prompt

```
TICKET: nc-p9b -- QA validation for structured alerting module
WORKTREE: /tmp/nanoclaw-nc-p9b

Read SHARED_INSTRUCTIONS.md before starting.

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only expected files
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

TICKET-SPECIFIC CHECKS:

[ ] src/alerting.ts exists and exports: AlertSeverity (or equivalent type),
    Alert interface, AlertSink interface, AlertManager class, createChannelSink,
    createLogSink

[ ] AlertSeverity includes exactly: 'critical', 'warning', 'info'

[ ] Alert interface has required fields: severity, category, title, timestamp
    (detail, groupFolder, metadata are optional)

[ ] AlertManager.fire() method exists and dispatches to registered sinks

[ ] Deduplication logic exists: verify code that tracks recent alerts by key
    and suppresses duplicates within a time window

[ ] Deduplication default window is ~15 minutes (900000ms or similar)

[ ] All alerts are logged via pino: verify that fire() calls logger.warn or
    logger.info regardless of sink count (alerts must never be silently lost)

[ ] Sink failure isolation: verify try/catch around each sink's send() call
    so one failing sink does not block others

[ ] createChannelSink formats with severity prefix: read the code and verify
    the output includes a severity indicator (e.g., [CRITICAL], [WARNING])

[ ] createLogSink writes JSON to file: verify it appends (not overwrites) and
    uses DATA_DIR-based path

[ ] src/index.ts imports from './alerting.js' (verify .js extension)

[ ] src/index.ts instantiates AlertManager in main()

[ ] src/index.ts registers at least two sinks: channel sink and log sink

[ ] The existing adminAlertFn variable is either replaced by or wired through
    the AlertManager (verify the consecutiveAgentFailures alert path uses
    alertManager.fire or equivalent)

[ ] The existing sendAdminAlert function or equivalent is passed to
    createChannelSink (preserving the channel delivery path)

[ ] startJailHealthChecks still receives a compatible callback (verify the
    call at ~line 838 still works -- either same signature or adapted)

[ ] Test file exists: src/alerting.test.ts

[ ] Tests cover: multi-sink dispatch, deduplication within window,
    deduplication expiry, sink failure isolation, channel sink formatting,
    log sink file append, pino logging on fire

[ ] No 'any' type usage in src/alerting.ts (grep for ': any')

Report: QA_PASS or QA_FAIL with per-check breakdown
```

---

## Stage 9C: DTrace Scripts for Agent Observability

### Ticket Header

```
ID:           nc-p9c
Title:        Add DTrace scripts for jail agent observability
Priority:     P4
Tags:         nanoclaw, phase-9, observability, dtrace, freebsd
Files:        etc/dtrace/ (new directory), src/jail/dtrace.ts (new), src/jail/dtrace.test.ts (new), docs/DTRACE.md (new)
Dependencies: Phase 5 (CI), Phase 6 (metrics endpoint)
```

### Context

DTrace is FreeBSD's dynamic tracing framework that provides zero-overhead observability at the kernel level. No other container runtime (Docker, Apple containers) can offer this capability. The BSD PM report (section 4.2) identifies DTrace as a medium-priority differentiating feature that enables deep debugging of agent behavior without modifying agent code.

DTrace can answer questions like:
- What files did the agent read/write inside the jail?
- What network connections did the agent attempt (including blocked ones)?
- How many processes did the agent spawn?
- What syscalls is the agent making, and how long do they take?

This ticket is explicitly exploratory. DTrace scripting requires FreeBSD-specific knowledge and the D language. The developer should focus on creating useful, tested D scripts and a thin TypeScript integration layer, not on building a comprehensive DTrace platform.

### Developer Prompt

```
TICKET: nc-p9c -- DTrace scripts for jail agent observability
WORKTREE: /tmp/nanoclaw-nc-p9c

Read SHARED_INSTRUCTIONS.md before starting.

CONTEXT:
DTrace on FreeBSD provides kernel-level tracing that can observe jail activity from the
host without any cooperation from the jailed process. This is a unique capability that
Docker cannot match. Your task is to create D scripts for common tracing scenarios and
a thin TypeScript module that can optionally launch DTrace alongside jail execution.

This is an EXPLORATORY ticket. Not all of these requirements may be feasible as
described. If you encounter DTrace limitations (e.g., probe availability, permission
requirements, D language constraints), document them in code comments and adjust the
implementation accordingly. The goal is a useful, working foundation -- not a
comprehensive DTrace platform.

Read these files before writing any code:
- src/jail/runner.ts (jail agent runner -- where DTrace would attach)
- src/jail/exec.ts (jail command execution patterns)
- src/jail/lifecycle.ts (jail creation -- to understand jail naming/JID)
- src/jail/config.ts (configuration patterns)
- src/jail/sudo.ts (privileged command execution -- DTrace requires root)

REQUIREMENTS:

1. Create etc/dtrace/ directory with D scripts:

   a. etc/dtrace/nanoclaw-io.d -- File I/O tracing per jail:
      - Trace open(), read(), write(), unlink() syscalls
      - Filter by jail ID (passed as a DTrace macro variable, e.g., $jailid)
      - Output: timestamp, syscall, path, bytes (for read/write), return value
      - Include a shebang line: #!/usr/sbin/dtrace -s
      - Add comments explaining each probe and how to run manually

   b. etc/dtrace/nanoclaw-net.d -- Network activity tracing per jail:
      - Trace connect(), sendto(), recvfrom() syscalls
      - Filter by jail ID
      - Output: timestamp, syscall, remote address/port (where feasible),
        bytes transferred
      - Note: extracting IP addresses from sockaddr structs in D is non-trivial.
        If this proves too complex, trace at the syscall level without address
        decoding and document the limitation.

   c. etc/dtrace/nanoclaw-proc.d -- Process activity tracing per jail:
      - Trace fork(), exec(), exit() syscalls
      - Filter by jail ID
      - Output: timestamp, event, PID, process name, arguments (for exec)

   DESIGN DECISION: The jail ID filtering approach. Options:
   - Use the `curpsinfo->pr_jailid` variable if available on FreeBSD 15
   - Use `jail:` provider probes if available
   - Use PID-based filtering by looking up the jail's process list
   - Document which approach you chose and why

2. Create src/jail/dtrace.ts with these exports:
   - DTraceSession interface: { jailId: number, script: string, proc: ChildProcess,
     outputPath: string }
   - startTrace(jailId: number, scriptName: string, outputDir: string): DTraceSession
     Spawns `sudo dtrace -s <script> -D jailid=<id>` as a background process,
     redirecting output to a file in outputDir.
   - stopTrace(session: DTraceSession): Promise<string>
     Sends SIGINT to the DTrace process (graceful stop), waits for exit, returns
     the output file path.
   - listAvailableScripts(): string[]
     Returns the names of D scripts in etc/dtrace/.
   - isDTraceAvailable(): boolean
     Checks if dtrace binary exists and is executable (FreeBSD-only).

   IMPORTANT NOTES:
   - DTrace requires root/sudo. Use the sudo module (src/jail/sudo.ts) for
     privileged execution, following the existing DI pattern.
   - DTrace is optional. If dtrace is not available (non-FreeBSD, or DTrace not
     installed), all functions should return gracefully (no errors, no traces).
   - The integration with jail/runner.ts is NOT part of this ticket. This ticket
     creates the D scripts and the TypeScript wrapper. A future ticket would add
     opt-in DTrace attachment during jail execution.
   - Output files should go in the group's logs directory (same pattern as
     agent output logs).

3. Create src/jail/dtrace.test.ts with tests covering:
   - isDTraceAvailable returns false when dtrace binary not found (mock execFileSync)
   - listAvailableScripts returns script names from etc/dtrace/ (mock fs.readdirSync)
   - startTrace spawns dtrace with correct arguments (mock spawn)
   - startTrace passes jail ID as DTrace macro variable
   - stopTrace sends SIGINT and waits for exit (mock process signals)
   - All functions handle missing dtrace gracefully (no throws)

4. Create docs/DTRACE.md with:
   - Brief explanation of DTrace and why it's valuable for NanoClaw
   - How to run each D script manually (with example commands)
   - Example output from each script
   - Prerequisites (FreeBSD, root access, DTrace kernel module)
   - Security considerations (DTrace has full kernel access -- document who
     should have access and when to use it)

5. DESIGN DECISIONS (use your judgment):
   - D script complexity: start simple. Basic syscall tracing with jail filtering
     is more valuable than complex aggregations that might not compile. You can
     always add complexity later.
   - Output format: plain text vs. structured (JSON-like). Plain text is standard
     for DTrace and easier to read. Structured output is harder in D but easier to
     parse programmatically. Recommendation: plain text with tab-separated fields
     and a header comment explaining the columns.
   - Whether to add a DTrace-based metrics aggregation (e.g., total bytes read/written
     per jail session). This is optional -- raw trace output is sufficient for v1.
   - Error handling for D compilation failures: dtrace -s can fail if probes are
     not available on the running kernel. The startTrace function should capture
     stderr and log a useful error message.

Run: npm test, npx tsc --noEmit, npm run lint, npm run format:check
Report: IMPLEMENTATION_COMPLETE
```

### QA Prompt

```
TICKET: nc-p9c -- QA validation for DTrace scripts and integration module
WORKTREE: /tmp/nanoclaw-nc-p9c

Read SHARED_INSTRUCTIONS.md before starting.

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only expected files
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

TICKET-SPECIFIC CHECKS:

D SCRIPTS:
[ ] etc/dtrace/ directory exists
[ ] etc/dtrace/nanoclaw-io.d exists and contains DTrace probes for file I/O
    (look for syscall::open, syscall::read, syscall::write or equivalent)
[ ] etc/dtrace/nanoclaw-net.d exists and contains DTrace probes for network
    activity (look for syscall::connect, syscall::sendto or equivalent)
[ ] etc/dtrace/nanoclaw-proc.d exists and contains DTrace probes for process
    activity (look for syscall::*fork*, proc::: or equivalent)
[ ] Each D script has a shebang line (#!/usr/sbin/dtrace -s)
[ ] Each D script has comments explaining its purpose and how to run it
[ ] Each D script accepts a jail ID parameter (look for $jailid or $1 or
    equivalent filtering mechanism)
[ ] D scripts are syntactically plausible (no obvious D language errors --
    check for matching braces, valid probe descriptions, proper /predicate/
    syntax). Note: full validation requires running on FreeBSD with DTrace,
    so structural review is sufficient.

TYPESCRIPT MODULE:
[ ] src/jail/dtrace.ts exists
[ ] Exports isDTraceAvailable function (returns boolean)
[ ] Exports startTrace function (takes jail ID, script name, output dir)
[ ] Exports stopTrace function (takes session, returns Promise)
[ ] Exports listAvailableScripts function (returns string[])
[ ] startTrace uses sudo module or sudo command (DTrace requires root)
[ ] isDTraceAvailable does not throw on non-FreeBSD systems
[ ] startTrace does not throw if DTrace is unavailable (graceful degradation)
[ ] Import uses .js extensions for local imports

TESTS:
[ ] src/jail/dtrace.test.ts exists
[ ] Tests mock system dependencies (no actual dtrace execution in tests)
[ ] Tests cover: isDTraceAvailable false case, listAvailableScripts,
    startTrace argument construction, stopTrace signal handling

DOCUMENTATION:
[ ] docs/DTRACE.md exists
[ ] Contains manual execution examples for each D script
[ ] Contains prerequisites section mentioning FreeBSD and root access
[ ] Contains security considerations

[ ] No 'any' type usage in src/jail/dtrace.ts (grep for ': any')

FREEBSD-SPECIFIC:
[ ] If running on FreeBSD: verify D scripts have valid syntax by running
    sudo dtrace -e -s etc/dtrace/nanoclaw-io.d (dry-run parse check).
    If not on FreeBSD: SKIP this check with reason.

Report: QA_PASS or QA_FAIL with per-check breakdown
```

---

## Stage 9D: Capsicum Sandboxing for Credential Proxy

### Ticket Header

```
ID:           nc-p9d
Title:        Add Capsicum capability-mode sandboxing for credential proxy
Priority:     P4
Tags:         nanoclaw, phase-9, security, capsicum, freebsd, native-addon
Files:        src/capsicum.ts (new), src/capsicum.test.ts (new), src/credential-proxy.ts, native/ (new, optional)
Dependencies: Phase 5 (CI), Phase 6 (credential proxy stable)
```

### Context

Capsicum is FreeBSD's capability-mode sandboxing framework. Once a process enters capability mode (`cap_enter()`), it can no longer open new files, create new sockets, or access any global namespace. It can only use file descriptors it already holds and capabilities explicitly granted on those descriptors. This provides the strongest possible defense-in-depth for security-critical processes.

The credential proxy (`src/credential-proxy.ts`) is the most security-sensitive component in NanoClaw: it holds real API keys and forwards authenticated requests to the Anthropic API. The BSD PM report (section 4.3) identifies Capsicum sandboxing as a high-priority security feature.

The approach: after the credential proxy's HTTP server binds its listening socket, enter Capsicum capability mode. From that point, the proxy can accept connections on its bound socket and make outbound HTTPS connections using already-resolved addresses, but it cannot open files, read the filesystem, or do anything else outside its pre-opened capabilities.

**This is the most technically challenging ticket in Phase 9.** Capsicum requires native code (C/C++ addon or FFI) because Node.js does not expose `cap_enter()` or related syscalls. The developer must make design decisions about the native integration approach.

### Developer Prompt

```
TICKET: nc-p9d -- Capsicum capability-mode sandboxing for credential proxy
WORKTREE: /tmp/nanoclaw-nc-p9d

Read SHARED_INSTRUCTIONS.md before starting.

CONTEXT:
Capsicum on FreeBSD restricts a process to only the file descriptors and capabilities
it already holds. After cap_enter(), the process cannot open new files, create new
sockets to arbitrary addresses, or access the global namespace. This ticket adds
Capsicum sandboxing to the credential proxy so that even if the proxy is compromised,
the attacker cannot access the filesystem or make unexpected network connections.

This is an EXPLORATORY and TECHNICALLY CHALLENGING ticket. Capsicum requires calling
FreeBSD-specific C APIs from Node.js. Read the full requirements, consider the design
options, and implement the approach you believe is most maintainable.

Read these files before writing any code:
- src/credential-proxy.ts (the proxy server -- understand its lifecycle, what it
  needs at runtime: a bound listening socket, ability to make outbound HTTPS
  connections, access to the logger)
- src/jail/sudo.ts (dependency injection pattern for system calls)
- src/jail/config.ts (JAIL_CONFIG, environment variable patterns)

IMPORTANT CONSTRAINTS AND REALITIES:
- Capsicum's cap_enter() is a one-way operation. Once entered, the process CANNOT
  exit capability mode.
- Node.js is single-threaded (event loop). The credential proxy runs in the SAME
  process as the NanoClaw orchestrator. Calling cap_enter() would sandbox the
  ENTIRE process, not just the proxy.
- Therefore, the simplest approach (cap_enter in the main process) is NOT viable.
  The proxy would need to run in a CHILD PROCESS to be sandboxed independently.
- Alternative: use Capsicum's cap_rights_limit() to restrict INDIVIDUAL file
  descriptors without entering full capability mode. This is less restrictive but
  works in-process.

REQUIREMENTS:

1. Create src/capsicum.ts with these exports:
   - isCapsicumAvailable(): boolean
     Check if we're on FreeBSD and Capsicum is available (check for
     /usr/include/sys/capsicum.h or try to load the native addon).
   - capRightsLimit(fd: number, rights: string[]): boolean
     Restrict a file descriptor's capabilities. Rights are Capsicum right names
     like 'CAP_READ', 'CAP_WRITE', 'CAP_EVENT', 'CAP_ACCEPT', 'CAP_CONNECT'.
     Returns true on success, false on failure (with logging).
   - Optionally: capEnter(): boolean (for documentation/future use, but NOT
     called in the main process).

2. Native integration approach -- CHOOSE ONE and document why:

   Option A: Node.js native addon (node-addon-api / N-API)
   - Create native/capsicum/binding.gyp and native/capsicum/capsicum.cc
   - Use N-API for ABI stability across Node.js versions
   - Exposes cap_rights_limit() and optionally cap_enter()
   - Pro: most correct, full Capsicum API access
   - Con: requires node-gyp, C++ compilation, adds build complexity

   Option B: FFI via koffi or ffi-napi
   - Use a JavaScript FFI library to call libc's cap_rights_limit directly
   - Pro: no C++ compilation needed, pure JS
   - Con: FFI libraries may not be maintained, performance overhead for
     frequent calls (but cap_rights_limit is called once at startup)

   Option C: Child process with C helper binary
   - Write a small C program (native/capsicum/capsicum-helper.c) that:
     1. Receives a socket FD via SCM_RIGHTS (Unix domain socket FD passing)
     2. Enters cap_enter()
     3. Runs a simple HTTP proxy loop
   - The Node.js process spawns this helper and passes the bound server socket
   - Pro: true capability mode isolation, most secure
   - Con: most complex, requires C development, FD passing is tricky

   Option D: cap_rights_limit via process.binding or execFileSync
   - Since cap_rights_limit() is a simple syscall, investigate if Node.js's
     internal bindings or a small shim script can call it
   - This is a research option -- it may not be feasible

   RECOMMENDATION: Start with Option A (N-API addon) if you are comfortable
   with C++, or Option B (FFI) for faster iteration. Option C is the most
   architecturally sound but significantly more complex.

   If none of these approaches are feasible within the scope of this ticket,
   create the TypeScript interface (src/capsicum.ts) with stub implementations
   that log "Capsicum not available: native addon not built" and document the
   intended approach in code comments. This allows future implementation without
   blocking the rest of Phase 9.

3. Modify src/credential-proxy.ts:
   - After the server.listen() callback fires (line 216-218), call
     capRightsLimit on the server's file descriptor to restrict it to
     CAP_ACCEPT, CAP_EVENT (for epoll/kqueue), CAP_READ, CAP_WRITE.
   - This restricts what the listening socket can do without entering full
     capability mode.
   - Wrap in isCapsicumAvailable() check so non-FreeBSD platforms are unaffected.
   - Log the result: "Credential proxy: Capsicum rights limited on server fd N"
     or "Credential proxy: Capsicum not available, skipping capability restriction"

4. Create src/capsicum.test.ts with tests covering:
   - isCapsicumAvailable returns false on non-FreeBSD (mock os.platform)
   - capRightsLimit returns false gracefully when Capsicum not available
   - capRightsLimit calls native binding with correct arguments (mock the
     native addon/FFI)
   - Integration: credential proxy startup still works when Capsicum is
     unavailable (the proxy must never fail to start because Capsicum is missing)

5. DESIGN DECISIONS (use your judgment):
   - Which native integration approach to use (see options above). Document
     your choice and reasoning in a comment at the top of src/capsicum.ts.
   - Which Capsicum rights to apply. The minimum for a network server is:
     CAP_ACCEPT, CAP_EVENT, CAP_READ, CAP_WRITE, CAP_SHUTDOWN, CAP_GETPEERNAME,
     CAP_GETSOCKNAME, CAP_GETSOCKOPT, CAP_SETSOCKOPT
   - Whether to also restrict outbound connection FDs (the HTTPS connections
     to api.anthropic.com). This is harder because they are created dynamically
     by Node.js's https.request(). Restricting them would require hooking into
     the socket creation. Skip this for v1 unless it's straightforward.
   - Whether to add this to package.json as an optional dependency. If using
     a native addon, it should be an optionalDependency so npm install does
     not fail on non-FreeBSD platforms.
   - If you go with the stub approach: make the stubs clearly indicate they
     are stubs (log at startup, return false from capRightsLimit, etc.) and
     document what a full implementation would look like.

6. CRITICAL: The credential proxy MUST still function correctly after your
   changes. This is a security hardening layer -- it must never break the
   proxy's ability to forward API requests. If Capsicum restriction fails
   for any reason, log a warning and continue without restriction.

Run: npm test, npx tsc --noEmit, npm run lint, npm run format:check
Report: IMPLEMENTATION_COMPLETE
```

### QA Prompt

```
TICKET: nc-p9d -- QA validation for Capsicum sandboxing
WORKTREE: /tmp/nanoclaw-nc-p9d

Read SHARED_INSTRUCTIONS.md before starting.

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only expected files
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

TICKET-SPECIFIC CHECKS:

CAPSICUM MODULE:
[ ] src/capsicum.ts exists
[ ] Exports isCapsicumAvailable function (returns boolean)
[ ] Exports capRightsLimit function (takes fd and rights array, returns boolean)
[ ] isCapsicumAvailable returns false on non-FreeBSD without throwing
[ ] capRightsLimit returns false gracefully when Capsicum is not available
    (verify: no throw, returns false, logs a message)
[ ] The chosen native integration approach is documented in a comment at the
    top of src/capsicum.ts (or the stub approach is documented if no native
    integration was implemented)
[ ] If a native addon was implemented: verify binding.gyp exists, verify
    it is listed as an optionalDependency in package.json
[ ] If FFI was used: verify the FFI library is an optionalDependency
[ ] If stubs were implemented: verify they clearly log that Capsicum is not
    active and document the intended full implementation

CREDENTIAL PROXY INTEGRATION:
[ ] src/credential-proxy.ts imports from './capsicum.js' (verify .js extension)
[ ] The Capsicum integration is called AFTER server.listen() succeeds
    (verify it's inside the listen callback or chained after it)
[ ] The integration is wrapped in an isCapsicumAvailable() check
[ ] Capsicum failure does NOT prevent the proxy from starting (verify:
    the capRightsLimit call is in a try/catch or conditional, and failure
    only logs a warning)
[ ] The proxy's existing functionality is preserved: source IP check,
    jail token auth, rate limiting, path validation, header injection
    (read through the modified credential-proxy.ts to verify no existing
    code was removed or broken)

TESTS:
[ ] src/capsicum.test.ts exists
[ ] Tests mock the native addon/FFI/stubs (no actual Capsicum calls in tests)
[ ] Tests cover: isCapsicumAvailable false case, capRightsLimit graceful
    failure, proxy starts without Capsicum
[ ] No test relies on running on FreeBSD (all FreeBSD-specific behavior mocked)

SECURITY:
[ ] cap_enter() is NOT called in the main process (grep for cap_enter --
    it should only exist in documentation/comments or be exported but never
    called from credential-proxy.ts or index.ts)
[ ] No 'any' type usage in src/capsicum.ts (grep for ': any')
[ ] The Capsicum rights listed for the server FD include at minimum:
    CAP_ACCEPT, CAP_READ, CAP_WRITE (read the code or constants)

FREEBSD-SPECIFIC:
[ ] If running on FreeBSD: verify isCapsicumAvailable() returns true (or
    returns false with a clear reason if the native addon is not built).
    If not on FreeBSD: SKIP this check with reason.
[ ] If running on FreeBSD with native addon built: verify capRightsLimit
    succeeds on a test fd. If not applicable: SKIP with reason.

Report: QA_PASS or QA_FAIL with per-check breakdown
```

---

## Phase 9 Integration QA

After all four stage tickets (9A, 9B, 9C, 9D) pass individual QA, run this integration QA on the merged result.

### Integration QA Prompt

```
PHASE 9 INTEGRATION QA
BRANCH: Merged result of nc-p9a, nc-p9b, nc-p9c, nc-p9d

Read SHARED_INSTRUCTIONS.md before starting.

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No merge conflict markers in any file: grep -r '<<<<<<' src/ etc/ docs/

INTEGRATION CHECKS:

CROSS-MODULE WIRING:
[ ] 9A (integrity) can use 9B (alerting): verify that the integrity module's
    alert on CLAUDE.md mismatch routes through the AlertManager (or is wired
    to do so). If they are independent, verify there is a clear path to connect
    them (e.g., both accept the same callback signature).

[ ] 9B (alerting) is used by index.ts: verify AlertManager is instantiated in
    main() and has at least two sinks registered (channel + log).

[ ] 9C (DTrace) and 9D (Capsicum) are independent: verify they do not conflict
    (no shared state, no import cycles, no namespace collisions).

[ ] All new modules use consistent patterns:
    - .js import extensions throughout
    - pino logger for all log output
    - Graceful degradation on non-FreeBSD for 9C and 9D

NO REGRESSIONS:
[ ] Existing credential proxy tests still pass (run credential-proxy.test.ts
    specifically if possible)
[ ] Existing jail tests still pass (jail-runtime.test.ts, jail-mount-security.test.ts,
    jail-network-isolation.test.ts, jail-stress.test.ts)
[ ] The existing CLAUDE.md hash check in container-runner.ts (log.warn for
    'CLAUDE.md was modified during agent run') is still present and functional

FILE INVENTORY:
[ ] New files created:
    - src/integrity.ts
    - src/integrity.test.ts
    - src/alerting.ts
    - src/alerting.test.ts
    - src/jail/dtrace.ts
    - src/jail/dtrace.test.ts
    - src/capsicum.ts
    - src/capsicum.test.ts
    - etc/dtrace/nanoclaw-io.d
    - etc/dtrace/nanoclaw-net.d
    - etc/dtrace/nanoclaw-proc.d
    - docs/DTRACE.md
    Verify each exists. If any are missing, report as FAIL.

[ ] Modified files:
    - src/container-runner.ts (integrity integration)
    - src/credential-proxy.ts (Capsicum integration)
    - src/index.ts (AlertManager instantiation)
    Verify each was modified. If any were not, report as FAIL with explanation.

[ ] No files outside the expected set were modified (git diff --stat)

UPSTREAM COMPATIBILITY:
[ ] No changes to function signatures in container-runner.ts that would break
    upstream merges (runContainerAgent, hashFile, buildVolumeMounts should have
    the same exported signatures)
[ ] No changes to function signatures in credential-proxy.ts that would break
    upstream merges (startCredentialProxy, detectAuthMode, isAllowedSource should
    have the same exported signatures)
[ ] New modules (integrity.ts, alerting.ts, capsicum.ts, jail/dtrace.ts) are
    fork-only additions that do not conflict with any upstream file

SECURITY REVIEW:
[ ] No secrets, API keys, or credentials appear in any new file
[ ] Capsicum cap_enter() is never called from the main process
[ ] DTrace scripts do not contain hardcoded paths or credentials
[ ] Integrity hash storage file has restricted permissions (0o600)
[ ] Alert log file does not contain sensitive data (verify createLogSink
    does not log API keys or tokens in alert metadata)

Report: QA_PASS or QA_FAIL with per-check breakdown
```

---

## Execution Notes

1. **Stages 9A-9D are independent** and can be developed in parallel worktrees. There are no code-level dependencies between them (9A's integrity alerts could use 9B's AlertManager, but this wiring can happen during integration).

2. **9A and 9B are the most straightforward** -- they extend existing patterns (hash checking, admin alerts) with well-understood TypeScript. Start here if prioritizing early wins.

3. **9C and 9D are exploratory** and may require multiple iterations. The developer prompts explicitly allow for graceful degradation and stub implementations. Do not block the phase on achieving full DTrace or Capsicum integration.

4. **9D has the highest risk of requiring a stub implementation.** Building a Node.js native addon is non-trivial and may not be achievable in a single ticket. The prompt explicitly permits a stub approach with documentation of the intended full implementation.

5. **Phase 9 is optional** per the PHASE_PLAN.md execution notes. It should only be started after Phases 5 and 6 are stable and merged to main.
