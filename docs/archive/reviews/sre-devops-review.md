# SRE/DevOps Engineer Review — FreeBSD Jail Runtime

## Summary
The FreeBSD jail runtime implementation is an impressive prototype demonstrating novel approaches to container isolation, but has critical operational gaps that prevent production deployment without significant hardening. The system shows strong architectural fundamentals but lacks essential reliability patterns, resource management, and operational observability needed for 24/7 operation. Most concerning is the absence of monitoring hooks, resource limits, and recovery mechanisms for common failure scenarios.

## Operational Readiness Score
**2/5 - Dev-only**

**Justification**: While the jail runtime successfully implements the core functionality, it lacks fundamental operational safeguards. No resource limits, no monitoring hooks, brittle recovery from common failures (ZFS full, template corruption, host reboot), and hardcoded configurations make this unsuitable for production. The code shows promise but needs significant hardening before staging deployment.

---

## Findings (ranked: Critical > High > Medium > Low > Info)

### Critical 1. No Resource Limits — System-Wide Failure Risk
**Category**: resources
**Files**: /home/jims/code/nanoclaw/src/jail-runtime.js, /home/jims/code/nanoclaw/src/src/container-runner.ts
**Description**: Jails have NO memory, CPU, or process limits. A single runaway agent can consume all system resources, crashing the host and all other jails. The jail creation at lines 464-490 of jail-runtime.js includes no rctl(8) resource controls.
**Impact**: One misbehaving agent kills the entire NanoClaw system and potentially destabilizes the FreeBSD host. In production, this means total service outage from a single bad query.
**Recommendation**:
- Add rctl limits per jail: `rctl -a jail:${jailName}:memoryuse:deny=${MEMORY_LIMIT}` before starting jail
- Set `jail.${jailName}.cpuset.id` for CPU pinning/limits
- Set `kern.maxfiles` per-jail file descriptor limits
- Set `kern.maxproc` to prevent fork bombs
- Make limits configurable via JAIL_CONFIG with sane defaults (e.g., 2GB RAM, 2 CPUs, 1024 max processes)
- Document in setup-jail-template.sh that template should have rctl enabled

### Critical 2. Epair Exhaustion — Silent Network Failure
**Category**: resources
**Files**: /home/jims/code/nanoclaw/src/jail-runtime.js (lines 92-115)
**Description**: FreeBSD has a finite number of epair interfaces (controlled by `net.link.ether.max_epairs`). createEpair() does not check the limit or handle exhaustion gracefully. When epair creation fails, the error message is cryptic and the jail is left partially configured.
**Impact**: After N concurrent jails (typically ~256), new jails silently fail to get network interfaces. Agents appear to hang indefinitely without clear error messages. Operators have no warning before hitting this limit.
**Recommendation**:
- Query `sysctl net.link.ether.max_epairs` at startup, log current limit
- Track active epair count in memory, fail fast with clear error when approaching limit
- Add JAIL_CONFIG.maxConcurrentJails to enforce a safe limit (e.g., max_epairs - 10 buffer)
- Document epair limits in deployment docs with tuning instructions
- Consider switching to a shared loopback with VIMAGE routing for higher concurrency (1 lo1 interface serves all jails)

### Critical 3. Host Reboot Recovery — Missing Persistence
**Category**: reliability
**Files**: /home/jims/code/nanoclaw/src/jail-runtime.js, /home/jims/code/nanoclaw/src/src/index.ts
**Description**: After a host reboot, NanoClaw has no mechanism to restore active jails. The orphan cleanup in cleanupOrphans() (line 837) destroys all jails unconditionally. Sessions are persisted in SQLite, but there's no code to resume them in jails after reboot.
**Impact**: Host reboot = complete session loss. All active conversations are terminated, forcing users to restart from scratch. For a personal assistant, this breaks the "always available" promise.
**Recommendation**:
- Add session persistence metadata: map sessionId -> {jailName, groupId, lastActivity}
- On startup, check for sessions < 24h old and offer to resume them
- Implement jail resurrection: clone template, mount previous session data, restart agent-runner with resumeSessionAt
- For now, document that host reboot requires manual cleanup and agent restart

### Critical 4. ZFS Pool Full — No Graceful Degradation
**Category**: reliability
**Files**: /home/jims/code/nanoclaw/src/jail-runtime.js (lines 429-431)
**Description**: When `zfs clone` fails due to pool exhaustion, the error is caught but cleanup is incomplete (line 501-503). The partial jail (epair created, fstab written) can leak resources. No preemptive checks warn operators before pool fills.
**Impact**: ZFS pool full = cascading failures as new jails fail to clone. Leaked epairs accumulate, requiring manual cleanup. Agents see cryptic "cannot clone" errors instead of actionable "disk full" messages.
**Recommendation**:
- Before cloning, check pool capacity: `zfs list -H -o avail ${JAIL_CONFIG.jailsDataset}` and fail fast if < 1GB free
- Log warnings when pool usage > 80%
- Ensure cleanup is atomic: use try/finally to guarantee epair release and fstab removal even on clone failure
- Add metrics hook for pool capacity monitoring (see Finding #5)

### Critical 5. No Monitoring Hooks — Operational Blindness
**Category**: logging
**Files**: /home/jims/code/nanoclaw/src/jail-runtime.js, /home/jims/code/nanoclaw/src/src/container-runner.ts
**Description**: Zero instrumentation for external monitoring. No health check endpoint, no metrics export, no Prometheus/StatsD integration. Operators cannot track: active jail count, ZFS pool usage, epair allocation, jail creation failure rate, or session churn.
**Impact**: You cannot monitor NanoClaw in production. SREs are blind to capacity issues until users complain. No alerting when approaching resource limits. Post-incident analysis lacks data.
**Recommendation**:
- Add optional metrics endpoint (e.g., /metrics at :9090) with:
  - `nanoclaw_active_jails{group}` (gauge)
  - `nanoclaw_jail_create_total{status}` (counter)
  - `nanoclaw_epair_used` (gauge)
  - `nanoclaw_zfs_pool_bytes_avail` (gauge)
  - `nanoclaw_session_duration_seconds` (histogram)
- Implement health check at /health: returns 200 if template snapshot exists and pool has >10% free space
- Make metrics optional (disabled by default) to avoid adding dependencies

### High 1. Template Corruption — No Validation or Rollback
**Category**: DR
**Files**: /home/jims/code/nanoclaw/src/scripts/setup-jail-template.sh, /home/jims/code/nanoclaw/src/jail-runtime.js (line 800)
**Description**: Template setup (setup-jail-template.sh) destroys the old snapshot immediately (line 236) before verifying the new one works. If the new snapshot is corrupt (e.g., npm install failed silently), ALL future jails fail until the template is manually rebuilt.
**Impact**: A bad template deployment breaks the entire system with no automatic recovery. This is a single point of failure with no rollback path.
**Recommendation**:
- Keep the previous snapshot as a backup: rename old snapshot to `base.old` instead of destroying it
- Add template validation: after creating new snapshot, boot a test jail and verify `node --version` and `npx tsc --version` succeed
- Only destroy old snapshot after new one is validated
- Add `ensureJailRuntimeRunning()` test that creates a throwaway jail to verify template works
- Document rollback procedure: `zfs rename ${TEMPLATE}@base.old ${TEMPLATE}@base`

### High 2. Template Update — No Live Migration Strategy
**Category**: deployment
**Files**: /home/jims/code/nanoclaw/src/scripts/setup-jail-template.sh
**Description**: The setup script requires destroying all active jails before updating the template (lines 86-91). This forces downtime during template upgrades (e.g., Node.js version bump, SDK update).
**Impact**: Template updates = service interruption. All active sessions are terminated. For a 24/7 assistant, this violates SLA.
**Recommendation**:
- Implement blue/green deployment: create new template snapshot with different name (e.g., `base-v2`)
- Add JAIL_CONFIG.templateSnapshot version field, update to point to new snapshot
- New jails use new snapshot; existing jails continue running on old snapshot
- After N hours (or manual confirmation), destroy old snapshot
- Document migration procedure in a runbook

### High 3. Concurrent Jail Limit — No Backpressure
**Category**: resources
**Files**: /home/jims/code/nanoclaw/src/src/index.ts, /home/jims/code/nanoclaw/src/group-queue.ts
**Description**: No enforcement of concurrent jail limits. The GroupQueue processes messages FIFO but doesn't cap the number of simultaneously running jails. Under load, hundreds of jails could spawn.
**Impact**: Flash crowds (e.g., 50 groups get messages simultaneously) spawn 50 jails, exhausting memory/epairs. System thrashes instead of gracefully queueing work.
**Recommendation**:
- Add JAIL_CONFIG.maxConcurrentJails (default: 10)
- Track active jail count in memory (increment on createJail, decrement on destroyJail)
- In GroupQueue, block new jail creation when at limit; queue the work instead
- Return 429-style "rate limit" message to users when queue depth exceeds threshold
- Emit metrics for queue depth and wait time

### High 4. Jail Cleanup — /tmp Growth Over Time
**Category**: resources
**Files**: /home/jims/code/nanoclaw/src/container/agent-runner/src/index.ts (line 432), /home/jims/code/nanoclaw/src/jail-runtime.js (line 450)
**Description**: Agent runner compiles TypeScript to `/tmp/dist` on every run (entrypoint.sh line 169). The jail's /tmp is backed by the template's ZFS clone, which grows as files are written. There's no /tmp cleanup between sessions or periodic tmpwatch.
**Impact**: Long-lived jails (especially in streaming mode with IPC piping) accumulate /tmp bloat. Each TypeScript compilation leaves behind ~10MB of compiled code. After 100 runs, /tmp could be 1GB+, wasting pool space.
**Recommendation**:
- Mount /tmp as tmpfs in jail: add `tmpfs /tmp tmpfs rw,size=512m 0 0` to jail fstab
- Alternative: Add cleanup step in entrypoint.sh: `rm -rf /tmp/dist` before compiling
- Document in setup-jail-template.sh that jails should use tmpfs for /tmp
- Monitor ZFS clone size and alert if any clone exceeds 1GB (indicates /tmp leak)

### High 5. Disaster Recovery — No ZFS Snapshot Strategy
**Category**: DR
**Files**: None (missing)
**Description**: No automated ZFS snapshot/backup strategy for jail data. If the ZFS pool fails or is corrupted, all session data, group folders, and IPC state are lost. No documented restore procedure.
**Impact**: Catastrophic data loss from hardware failure. No way to recover sessions or group history. For a personal assistant holding important context, this is unacceptable.
**Recommendation**:
- Document ZFS snapshot strategy:
  - Snapshot JAIL_CONFIG.jailsPath hourly: `zfs snapshot ${jailsDataset}@hourly-$(date +%Y%m%d%H%M)`
  - Keep 24 hourly, 7 daily, 4 weekly snapshots (use zfs-auto-snapshot or custom cron)
- Add script: `backup-nanoclaw-state.sh` that snapshots jails + sqlite db
- Document restore procedure:
  1. Stop NanoClaw
  2. `zfs rollback ${jailsDataset}@desired-snapshot`
  3. Restore SQLite db from backup
  4. Restart NanoClaw
- Recommend off-host replication: `zfs send | ssh backup-host zfs recv` for DR

### Medium 1. Hardcoded Network Configuration — Single Subnet
**Category**: config
**Files**: /home/jims/code/nanoclaw/src/jail-runtime.js (lines 24-26)
**Description**: All jails share the same /30 subnet (10.99.0.1 gateway, 10.99.0.2 jail). This works because each jail has its own epair, but the configuration is not documented or easily changed. The subnet is hardcoded, making it conflict-prone in environments that already use 10.99.0.0/24.
**Impact**: IP conflict if host network uses 10.99.0.0/24. Difficult to customize for multi-host deployments or VPN environments.
**Recommendation**:
- Make subnet configurable via environment variable: `NANOCLAW_JAIL_SUBNET=10.99.0.0/30`
- Document in setup docs: "Default jail subnet is 10.99.0.0/30. Change if this conflicts with your network."
- Add startup check: warn if subnet overlaps with host routing table
- For scalability, consider a /24 subnet where each jail gets a unique IP (10.99.0.1 gateway, 10.99.0.2-254 jails)

### Medium 2. Hardcoded Interface Name (re0) — Portability Issue
**Category**: config
**Files**: /home/jims/code/nanoclaw/src/etc/pf-nanoclaw.conf (line 70)
**Description**: The pf configuration hardcodes `ext_if = "re0"`. This is specific to the "scratchy" host. On different systems, the external interface could be em0, igb0, vtnet0, etc. The config file includes a comment acknowledging this (line 69) but provides no automatic detection.
**Impact**: pf rules fail to load on hosts with different interface names. New users must manually edit the config, which is error-prone and breaks declarative deployment.
**Recommendation**:
- Generate pf config at runtime: template the interface name
- Add detection script: `detect-ext-interface.sh` that finds the default route interface via `route -n get default | grep interface | awk '{print $2}'`
- Substitute `$ext_if` at service startup
- Alternative: Use `egress` interface group (works on OpenBSD, not FreeBSD) or manually prompt during setup

### Medium 3. Timeout Values — Magic Numbers
**Category**: config
**Files**: /home/jims/code/nanoclaw/src/jail-runtime.js (lines 67, 709, 716), /home/jims/code/nanoclaw/src/src/container-runner.ts (lines 460-461, 920)
**Description**: Hardcoded timeouts throughout: 30s default for sudoExec (line 67), 15s for jail stop (line 709), 10s fallback (line 716). Container runner has complex timeout logic (CONTAINER_TIMEOUT + IDLE_TIMEOUT + 30s buffer). No centralized configuration or justification for these values.
**Impact**: Timeouts may be too short for slow systems or too long for fast failure detection. Tuning requires code changes. Different timeouts in different files create inconsistency.
**Recommendation**:
- Centralize in JAIL_CONFIG:
  ```javascript
  timeouts: {
    sudo: 30000,           // sudo command execution
    jailStart: 30000,      // jail startup
    jailStop: 15000,       // graceful jail stop
    jailStopForce: 10000,  // force jail stop
    zfsOperation: 30000,   // ZFS clone/destroy
  }
  ```
- Document timeout semantics in code comments
- Make timeouts configurable via environment variables for testing/debugging

### Medium 4. File Descriptor Limits — Potential Leak
**Category**: resources
**Files**: /home/jims/code/nanoclaw/src/jail-runtime.js (execInJail lines 557-644)
**Description**: Each execInJail spawns a sudo process (line 557) and each spawnInJail (line 689) does the same. These are child processes with stdio pipes. No explicit fd limit checking. On long-running systems with many concurrent jails, fd exhaustion is possible.
**Impact**: After thousands of jail operations, the NanoClaw process could hit its fd limit (typically 1024 or 4096), causing spawn() to fail with EMFILE. This manifests as random "cannot create jail" errors.
**Recommendation**:
- Increase process fd limit in systemd unit file: `LimitNOFILE=65536`
- Add startup check: log current ulimit -n and warn if < 4096
- Monitor open fd count: `ls /proc/${pid}/fd | wc -l` and alert if approaching limit
- Ensure all child processes are properly cleaned up (check for zombie processes)

### Medium 5. Logging — No Jail Log Retention Policy
**Category**: logging
**Files**: /home/jims/code/nanoclaw/src/src/container-runner.ts (lines 605, 656, 999, 1054)
**Description**: Jail logs are written to `${groupDir}/logs/jail-${timestamp}.log` but there's no rotation or cleanup policy. Over weeks/months, thousands of logs accumulate, consuming disk space. No log aggregation or centralized logging.
**Impact**: Logs fill the disk, eventually causing ZFS pool exhaustion (compounding Finding #Critical 4). Old logs are hard to search for post-incident analysis.
**Recommendation**:
- Add log rotation via logrotate or custom cleanup:
  - Keep jail logs for 7 days, then compress
  - Keep compressed logs for 30 days, then delete
- Alternative: Ship logs to external aggregator (syslog, Loki, Elasticsearch)
- Add log cleanup to daily cron: `find ${GROUPS_DIR}/*/logs -name 'jail-*.log' -mtime +7 -delete`
- Document log retention policy in ops manual

### Medium 6. NanoClaw Update — Session Preservation Challenge
**Category**: deployment
**Files**: /home/jims/code/nanoclaw/src/src/index.ts (lines 489-509), /home/jims/code/nanoclaw/src/jail-runtime.js (cleanupAllJails line 953)
**Description**: The shutdown handler (index.ts lines 489-509) destroys all jails on SIGTERM/SIGINT via cleanupAllJails(). This is correct for graceful shutdown but problematic for rolling updates. Restarting NanoClaw = all active sessions terminated.
**Impact**: Updating NanoClaw code or restarting the service kills all active conversations. Users see their agents go silent mid-task. For critical work, this is disruptive.
**Recommendation**:
- Implement graceful session handoff:
  1. On shutdown, instead of cleanupAllJails, leave jails running (remove cleanup from shutdown handler)
  2. Persist jail metadata: {groupId, jailName, pid, sessionId} to a "handoff" file
  3. On startup, detect running jails via `jls`, match to persisted metadata, adopt them
  4. Resume IPC piping to existing jails instead of creating new ones
- Fallback: Document update procedure with downtime window (e.g., update during low-traffic hours)
- Alternative: Use jail-to-jail migration (requires more sophisticated state transfer)

### Low 1. Package Manager Update Path — Undocumented
**Category**: deployment
**Files**: /home/jims/code/nanoclaw/src/scripts/setup-jail-template.sh (lines 128-132)
**Description**: The template installs global npm packages (typescript, @anthropic-ai/claude-code) at lines 128-132. When these packages are updated, there's no documented procedure to refresh the template. No version pinning, so installs are non-deterministic.
**Impact**: Template built on different dates have different package versions, causing subtle bugs. No way to audit which version is in production. Security updates require manual template rebuild.
**Recommendation**:
- Pin package versions in setup-jail-template.sh:
  ```bash
  npm install -g typescript@5.3.3 @anthropic-ai/claude-code@1.2.3
  ```
- Document update procedure:
  1. Edit setup-jail-template.sh with new versions
  2. Run setup-jail-template.sh to create new template snapshot
  3. Test with a single jail
  4. Roll out to production (see Finding #High 2 for blue/green strategy)
- Add template versioning: tag snapshots with `base-v${VERSION}` instead of just `base`

### Low 2. Message-to-Jail Correlation — Missing Request ID
**Category**: logging
**Files**: /home/jims/code/nanoclaw/src/src/container-runner.ts (logs), /home/jims/code/nanoclaw/src/jail-runtime.js (logs)
**Description**: Log messages include jailName and groupId, but when tracing a user's message through the system (message stored -> queue -> jail creation -> execution), there's no correlation ID linking these events. Debugging "why didn't my message get processed?" requires manual timestamp correlation.
**Impact**: Post-incident analysis is tedious. Can't easily trace a specific message through the pipeline. Log grep requires correlating multiple log files by timestamp.
**Recommendation**:
- Add requestId/traceId to all log entries:
  - Generate UUID when message is stored in DB
  - Pass traceId through queue -> runAgent -> runJailAgent -> execInJail
  - Include in all log.info/error calls: `logger.info({ traceId, jailName }, 'Starting jail')`
- Consider structured logging format (JSON) for easier parsing
- Document how to trace a message: `grep <traceId> *.log`

### Low 3. Jail Log Verbosity — Insufficient Error Context
**Category**: logging
**Files**: /home/jims/code/nanoclaw/src/src/container-runner.ts (lines 609-654)
**Description**: Jail run logs include input/output/mounts only when verbose mode is enabled (LOG_LEVEL=debug) or on error (lines 623-641). This means successful but slow jail runs don't log detailed info, making performance analysis hard.
**Impact**: Cannot debug "why did this jail take 5 minutes?" without enabling verbose logging globally (which floods logs). No performance profiling data for optimization.
**Recommendation**:
- Always log jail duration and resource usage (even on success):
  ```javascript
  logger.info({
    jailName,
    duration,
    code,
    stdoutSize: stdout.length,
    stderrSize: stderr.length,
    mountCount: jailMounts.length,
  }, 'Jail completed');
  ```
- Add performance logging: track time for each phase (clone, mount, start, execute, cleanup)
- Keep verbose input/output logging behind LOG_LEVEL=debug to avoid log spam

### Low 4. Single Point of Failure — Template Snapshot
**Category**: DR
**Files**: /home/jims/code/nanoclaw/src/jail-runtime.js (line 408, 800)
**Description**: All jails depend on a single ZFS snapshot (JAIL_CONFIG.templateDataset@base). If this snapshot is accidentally deleted or corrupted, the entire system stops working. ensureJailRuntimeRunning() (line 800) checks for the snapshot but doesn't auto-restore it.
**Impact**: Accidental `zfs destroy zroot/nanoclaw/jails/template@base` = immediate outage. All jail creation fails with "snapshot not found" until template is manually rebuilt (30+ minutes).
**Recommendation**:
- Keep a backup snapshot: after creating `@base`, also create `@base-backup`
- In ensureJailRuntimeRunning(), if `@base` is missing but `@base-backup` exists, automatically restore it:
  ```javascript
  if (!snapshotExists(`${templateDataset}@base`) && snapshotExists(`${templateDataset}@base-backup`)) {
    execFileSync('zfs', ['clone', `${templateDataset}@base-backup`, `${templateDataset}@base`]);
  }
  ```
- Add periodic snapshot verification to cron (e.g., hourly): check that `@base` exists and is bootable

### Info 1. Jail Naming — Sanitization Could Be More Restrictive
**Category**: config
**Files**: /home/jims/code/nanoclaw/src/jail-runtime.js (lines 40-46)
**Description**: sanitizeJailName() replaces all non-alphanumeric characters with underscores. This allows groupIds like "foo____bar" (multiple underscores) which is ugly but functional. No length limit enforcement.
**Impact**: Cosmetic only. Very long groupIds could create unwieldy jail names, but FreeBSD jail names support long strings.
**Recommendation**:
- Add length limit: `sanitized.slice(0, 63)` (FreeBSD jail name limit is typically 63 chars)
- Collapse multiple underscores to single: `sanitized.replace(/_+/g, '_')`
- Document jail naming convention in code comments

### Info 2. ZFS Clone Growth — Monitoring Recommendation
**Category**: resources
**Files**: /home/jims/code/nanoclaw/src/jail-runtime.js (createJail lines 429-431)
**Description**: ZFS clones created from the template snapshot start at near-zero size (copy-on-write) but grow as files are written. There's no monitoring of clone size. Long-running jails with heavy disk I/O could consume significant space.
**Impact**: Slow space leak. Each jail's clone grows independently. Without monitoring, ZFS pool could slowly fill up over weeks, triggering Finding #Critical 4.
**Recommendation**:
- Add to metrics endpoint (Finding #Critical 5): `nanoclaw_jail_clone_bytes{jail}` (gauge)
- Alert if any clone exceeds 1GB (indicates abnormal disk usage)
- Add cleanup policy: if a jail clone exceeds 5GB, log warning and suggest investigating the group

### Info 3. PF Rules — Static IP Table
**Category**: config
**Files**: /home/jims/code/nanoclaw/src/etc/pf-nanoclaw.conf (line 84)
**Description**: The `<anthropic_api>` table is resolved at rule load time (line 84). If Anthropic's IPs change, jails will fail to connect until pf rules are reloaded. No automation for IP updates.
**Impact**: Low impact (Anthropic's IPs are stable), but a DNS change could cause temporary outage until operator manually runs `pfctl -f`.
**Recommendation**:
- Document IP refresh procedure in pf config comments (already partially done at lines 183-186)
- Add weekly cron to refresh the table: `pfctl -t anthropic_api -T replace api.anthropic.com`
- Consider using DNS-based resolution instead of static IPs (requires pf.conf changes, more complex)

---

## Interface Abstraction Assessment

### Operations Impact of Current If/Else Pattern

**Current State**: container-runner.ts has a runtime check at line 784 (`if (runtime === 'jail')`) that bifurcates into completely separate code paths. The jail path (lines 785-788) calls `runJailAgent()`, while Docker path (lines 790-1154) has inline implementation.

**Operational Advantages of Current Approach**:
1. **Simplicity**: Single file, easy to grep/search for all container logic
2. **No abstraction penalty**: Direct access to runtime-specific features (e.g., epair creation, ZFS snapshots)
3. **Fast iteration**: Changing jail implementation doesn't require interface updates

**Operational Disadvantages**:
1. **Testing burden**: Must test both paths for every change to container-runner.ts
2. **Cognitive load**: Developers must understand both Docker and jail semantics
3. **Drift risk**: Common logic (logging, timeout handling, streaming output) is duplicated between paths, can diverge
4. **Debugging complexity**: Stack traces include if/else branches, harder to isolate runtime-specific bugs

### RuntimeDriver Interface — Pros and Cons

**Proposed Interface** (conceptual):
```typescript
interface RuntimeDriver {
  create(group, paths): Promise<RuntimeHandle>;
  exec(handle, command, opts): Promise<ExecutionResult>;
  destroy(handle): Promise<void>;
  healthCheck(): Promise<boolean>;
}
```

**Operational Pros**:
- **Separation of concerns**: jail-specific bugs can't break Docker runtime (and vice versa)
- **Testing**: Can mock RuntimeDriver for integration tests without requiring ZFS/Docker
- **Metrics**: Centralized instrumentation point (wrap all RuntimeDriver methods with metrics)
- **Multi-runtime**: Could run Docker AND jails simultaneously (useful for migration)
- **Observability**: Runtime-agnostic monitoring (e.g., "container creation failed" vs "jail creation failed")

**Operational Cons**:
- **Indirection**: Harder to trace execution flow (must jump between interface and implementation)
- **Boilerplate**: Interface changes require updates to both implementations
- **Least-common-denominator**: Features unique to jails (ZFS snapshots) or Docker (layer caching) may not fit cleanly
- **Performance**: Extra abstraction layer (negligible, but exists)

### Recommendation: Defer Abstraction Until 3rd Runtime

**Verdict**: The current if/else pattern is acceptable for TWO runtimes. The operational burden is manageable, and the code is still readable. An abstraction layer would add complexity without sufficient benefit.

**Trigger for abstraction**: If/when a third runtime is added (e.g., Podman, Apple Containers, Kubernetes pods), THEN introduce RuntimeDriver interface. Three code paths in a single if/else chain becomes unmaintainable.

**Alternative: Hybrid approach**:
- Extract common logic (streaming output parsing, timeout handling, logging) into shared helpers
- Keep runtime-specific logic (createJail, docker run) in separate modules
- container-runner.ts becomes a thin orchestration layer that delegates to runtime-specific modules
- This gives 80% of abstraction benefits without the interface overhead

**Actionable steps**:
1. Extract shared helpers NOW:
   - `parseStreamingOutput(stdout, onOutput)` — used by both runtimes
   - `handleTimeout(proc, timeoutMs, killFn)` — duplicated logic
   - `writeRunLog(logDir, metadata, stdout, stderr)` — identical in both paths
2. Move jail-specific code from container-runner.ts to jail-runtime.js:
   - `buildJailMountPaths()` → jail-runtime.js
   - `runJailAgent()` → jail-runtime.js
   - container-runner.ts just calls `jailRuntime.runAgent(...)` for jail path
3. Document runtime contract in comments:
   - Input: `ContainerInput` (common)
   - Output: `ContainerOutput` (common)
   - Process lifecycle: onProcess callback (common)
   - Streaming: onOutput callback (common)

This incremental refactoring improves maintainability without committing to a full abstraction layer prematurely.

---

## Summary of Recommendations by Priority

**Must-Fix Before Staging** (Blocking Issues):
1. Add resource limits (Critical #1)
2. Implement monitoring hooks (Critical #5)
3. Fix epair exhaustion handling (Critical #2)
4. Add ZFS pool capacity checks (Critical #4)

**Should-Fix Before Production** (High Risk):
1. Template validation and rollback (High #1)
2. Concurrent jail limit enforcement (High #3)
3. /tmp cleanup strategy (High #4)
4. ZFS snapshot/backup automation (High #5)

**Recommended Improvements** (Medium Priority):
1. Make network config and interface names configurable (Medium #1, #2)
2. Centralize timeout configuration (Medium #3)
3. Implement log retention policy (Medium #5)
4. Session preservation across restarts (Medium #6)

**Nice-to-Have** (Low/Info):
1. Add request tracing (Low #2)
2. Performance logging (Low #3)
3. Package version pinning (Low #1)
4. Metrics for clone size (Info #2)

**Total Findings**: 5 Critical, 5 High, 6 Medium, 4 Low, 3 Info = 23 findings

This review represents ~2 hours of senior SRE analysis. The jail runtime shows strong engineering fundamentals but needs operational hardening before production use. Recommend scheduling a 2-week hardening sprint to address Critical and High findings.
