# QA Engineer Review — FreeBSD Jail Runtime

## Summary

The FreeBSD jail runtime implementation introduces native isolation as an alternative to Docker containers. While the architecture is sound and follows separation-of-concerns principles, there are significant test coverage gaps around error handling, resource cleanup, and edge cases. The dual-runtime approach (Docker/Jail) creates maintenance complexity with limited abstraction. Critical issues include untested failure modes during cleanup, missing network failure handling, and race conditions in concurrent operations.

## Findings (ranked: Critical > High > Medium > Low > Info)

### [Critical] 1. Cleanup Failure Leaves Orphaned Resources
**Category**: test gap | regression risk
**Files**: `/home/jims/code/nanoclaw/src/jail-runtime.js` (lines 726-781)
**Description**: The `cleanupJail` function catches all errors and logs warnings but continues execution. If cleanup fails halfway (e.g., ZFS dataset destroy fails after unmounting devfs), the system can accumulate orphaned datasets, mounts, and epair interfaces. There are no tests verifying cleanup behavior when:
- `umount -f` fails on a busy filesystem
- `zfs destroy -r` fails due to dataset busy/cloned
- Jail stop times out or fails
- Epair destruction fails due to interface busy

The code attempts force unmount as a fallback (line 360-363), but there's no validation that this actually succeeds or that the system reaches a consistent state.

**Recommendation**:
- Add integration tests for partial cleanup failures (mock ZFS/umount failures)
- Implement cleanup state tracking (mark datasets for cleanup, retry on next startup)
- Add `cleanupAllJails` call on startup to handle orphaned resources from crashes
- Consider a "nuclear" cleanup mode that forcibly kills all processes in jail before unmount

### [Critical] 2. No Network Isolation Testing in Restricted Mode
**Category**: test gap | observability
**Files**: `/home/jims/code/nanoclaw/src/etc/pf-nanoclaw.conf`, `/home/jims/code/nanoclaw/src/jail-runtime.js` (lines 452-461, 492-495)
**Description**: The restricted network mode (vnet with pf) has zero automated testing. Manual verification comments exist (lines 54-61 in pf-nanoclaw.conf), but there are no tests confirming:
- Jails can ONLY reach api.anthropic.com:443
- DNS resolution works via copied /etc/resolv.conf
- Blocked traffic (google.com, SSH, etc.) actually fails
- pf rules load without syntax errors
- NAT works when external interface changes (re0 hardcoded on line 70)

Without network isolation tests, regression to permissive networking could expose Claude API keys or allow unauthorized outbound connections.

**Recommendation**:
- Add integration test that spawns a jail in restricted mode and validates:
  - `curl https://api.anthropic.com` succeeds
  - `curl https://google.com` fails/times out
  - DNS queries for anthropic.com work
  - Blocked traffic appears in pflog0
- Add startup check to validate pf rules are loaded and ext_if exists
- Consider making ext_if configurable via environment variable

### [High] 3. Race Condition in Concurrent Jail Operations
**Category**: test gap | regression risk
**Files**: `/home/jims/code/nanoclaw/src/jail-runtime.js` (lines 403-426, 836-903)
**Description**: Multiple operations can race on the same groupId:
1. `createJail` checks if jail is running (line 413), but another thread could start the jail between the check and creation
2. `cleanupOrphans` iterates running jails (line 845) but doesn't lock, so concurrent cleanup/create could conflict
3. Epair number assignment uses a Map (line 30) with no locking - concurrent calls to `createEpair` could assign the same epair number

The code has no concurrency control. If two messages arrive for the same group simultaneously (rapid Telegram burst), both could call `createJailWithPaths`, leading to:
- Duplicate ZFS datasets
- Conflicting jail names
- Epair leaks (both threads think they own epairN)

**Recommendation**:
- Add per-groupId mutex/lock in container-runner.ts before calling jail operations
- Add test for concurrent createJail calls with same groupId
- Make epair assignment atomic (check ifconfig output, not just Map state)
- Add jail name collision detection with explicit error (not silent overwrite)

### [High] 4. ZFS Dataset Quota/Space Exhaustion Not Handled
**Category**: test gap
**Files**: `/home/jims/code/nanoclaw/src/jail-runtime.js` (lines 429-431)
**Description**: When `zfs clone` fails due to quota exceeded or no space, the error is caught (line 499-503) and cleanup is attempted, but the user gets a generic "Failed to create jail" error. There's no observable distinction between:
- Out of space (actionable: user can delete old datasets)
- Template snapshot missing (fatal: needs setup)
- Permission denied (needs sudo configuration)
- Dataset name collision (transient: retry might work)

The logs (line 33-36) JSON-encode errors, but this doesn't help operators diagnose quota issues vs. other failures.

**Recommendation**:
- Parse ZFS error messages and emit specific error codes (QUOTA_EXCEEDED, NO_SPACE, PERMISSION_DENIED)
- Add dataset size/quota metrics to logs (how much space is available?)
- Add health check command that validates ZFS pool has >10% free space
- Test with `zfs set quota=1G` to verify graceful failure and cleanup

### [High] 5. Template Snapshot Missing Has No Startup Validation
**Category**: test gap | observability
**Files**: `/home/jims/code/nanoclaw/src/jail-runtime.js` (lines 793-834)
**Description**: `ensureJailRuntimeRunning` validates the template snapshot exists (line 800-801), but this is only called when the runtime is jail mode. If the Docker->Jail migration happens and the snapshot is missing, the system will appear healthy until the first jail creation attempt, then fail with a cryptic error.

The error message (lines 808-832) is helpful but only appears when a group tries to activate. An operator deploying the system won't know it's misconfigured until a user triggers the first agent run.

**Recommendation**:
- Call `ensureJailRuntimeRunning` in main startup path (src/index.ts) if runtime is 'jail'
- Add template snapshot metadata check: log node version, package versions, last updated time
- Create `verify-jail-template.sh` script that boots template, runs smoke tests, exits
- Add monitoring endpoint that exposes template snapshot health

### [High] 6. Jail Runtime Not Unit-Testable Without Root
**Category**: testability
**Files**: `/home/jims/code/nanoclaw/src/jail-runtime.js` (all functions call `sudo`)
**Description**: Every function in jail-runtime.js either calls `sudoExec`, `sudoExecSync`, or `execFileSync` with privileged operations (jail, zfs, ifconfig). This makes the code untestable without:
- Running tests as root (insecure, slow)
- Full ZFS setup on CI (complex, fragile)
- Mocking every system call (defeats the purpose of testing)

The jail runtime has no seams for dependency injection. By contrast, container-runtime.ts has abstraction points (CONTAINER_RUNTIME_BIN), but jail-runtime.js hardcodes everything.

**Recommendation**:
- Extract syscall layer into interface:
  ```javascript
  export const syscalls = {
    sudoExec: (...) => ...,
    execFileSync: (...) => ...,
    fs: fs,
  };
  ```
- Allow injection: `createJail(groupId, mounts, syscalls = defaultSyscalls)`
- Create mock syscalls for unit tests (validate command construction, not execution)
- Keep integration tests that require real sudo/ZFS (mark as slow/privileged)

### [Medium] 7. Long/Special Group Names Cause Jail Name Collisions
**Category**: test gap
**Files**: `/home/jims/code/nanoclaw/src/jail-runtime.js` (lines 39-46)
**Description**: `sanitizeJailName` replaces all non-alphanumeric characters with underscores. This creates collisions:
- `user@example.com` → `nanoclaw_user_example_com`
- `user_example_com` → `nanoclaw_user_example_com` (same jail name!)

The function has no length limit. If a groupId is >255 chars, jail creation might fail with "hostname too long" errors. There are no tests for:
- Unicode/emoji in groupId
- Very long groupIds (>100 chars)
- Collision detection (two groups mapping to same sanitized name)

**Recommendation**:
- Truncate to safe length (50 chars?) and add hash suffix: `nanoclaw_{sanitized[:50]}_{hash(groupId)[:8]}`
- Test with pathological inputs: `"../../../../etc/passwd"`, 1000-char string, unicode
- Add collision detection in `getJailName` (check if jail exists with different groupId)
- Document max groupId length in user-facing error

### [Medium] 8. Docker/Jail Code Paths Share No Test Coverage
**Category**: regression risk | testability
**Files**: `/home/jims/code/nanoclaw/src/src/container-runner.ts` (lines 783-788)
**Description**: The runtime switch (lines 783-788) has no test coverage for:
- Does enabling jail mode break Docker paths? (could introduce shared state bugs)
- Do both runtimes produce equivalent mount layouts? (jail uses semantic paths, Docker uses VolumeMount[])
- If someone changes JAIL_MOUNT_LAYOUT, do Docker tests fail? (they should be independent)

The two paths diverge at line 784 and have zero shared logic. This is good for isolation but bad for confidence that switching runtimes won't break existing groups.

**Recommendation**:
- Add integration test that creates the same group in both Docker and Jail modes, verifies:
  - Group folder is writable
  - IPC directory works
  - Agent can read project files (main only)
  - .claude session is isolated
- Create "runtime contract" test suite that both must pass (abstract away implementation)
- Add CI matrix: test Docker path on Linux, test Jail path on FreeBSD (if feasible)

### [Medium] 9. Epair Leaks on Rapid Create/Destroy Cycles
**Category**: test gap | resource leak
**Files**: `/home/jims/code/nanoclaw/src/jail-runtime.js` (lines 29-30, 92-115, 136-157)
**Description**: The `assignedEpairs` Map tracks groupId→epairNum, but this state is in-process memory. If the host process crashes between `createEpair` (line 111) and `destroyJail`, the epair is orphaned. The `cleanupOrphans` function (lines 906-937) tries to destroy untracked epairs, but only if `JAIL_CONFIG.networkMode === 'restricted'` at startup.

If someone switches from restricted→inherit mode, orphaned epairs from the previous run will persist until reboot.

There are no tests for:
- 100 rapid jail create/destroy cycles (does epair counter overflow?)
- Process crash between epair create and jail start
- Switching network modes between runs

**Recommendation**:
- Persist epair assignments to disk (`/var/run/nanoclaw-epairs.json`) for crash recovery
- On startup, destroy ALL epairN interfaces (not just untracked ones) to avoid mode-switch leaks
- Add test: create 10 jails, kill -9 the process, restart, verify epairs are cleaned
- Add epair usage monitoring (how many epairs exist? are we leaking?)

### [Medium] 10. Missing Permission Denied Handling in ensureHostDirectories
**Category**: test gap | observability
**Files**: `/home/jims/code/nanoclaw/src/jail-runtime.js` (lines 264-311)
**Description**: `ensureHostDirectories` calls `fs.chmodSync` and `fs.chownSync` (lines 289-293) but catches errors silently: `log(Warning: could not set permissions...)`. If the user doesn't have permission to change ownership (not running as root), this warning is logged once, then the jail will fail when the node user inside tries to write files.

The error is non-fatal during directory setup but fatal during jail execution. There's no test for:
- Running as non-root user (does jail fail to write?)
- Directories already owned by another user (does chown fail?)
- setgid bit already set by prior run (is re-chown necessary?)

**Recommendation**:
- Fail fast if permission setup fails (don't create the jail)
- Add `--check-permissions` flag to validate before jail creation
- Test as non-root user: verify error is clear ("Need root to set group ownership")
- Document required sudo/setuid configuration for NanoClaw

### [Medium] 11. No Logging of Jail IP Addresses in Restricted Mode
**Category**: observability
**Files**: `/home/jims/code/nanoclaw/src/jail-runtime.js` (lines 452-461, 492-495)
**Description**: When a jail is created in restricted mode, the code logs `epairNum` and interface names (line 113), but not the actual IP addresses (10.99.0.1/10.99.0.2). If network debugging is needed (why can't jail reach api.anthropic.com?), operators must:
1. Find the jail name in logs
2. Determine which epair it's using
3. Run `jexec <jail> ifconfig` to see IPs
4. Check pf state table manually

The logs don't include enough context for post-mortem debugging.

**Recommendation**:
- Log full network config on jail creation: `Created jail network: host=10.99.0.1/30, jail=10.99.0.2/30, iface=epair0b`
- On network setup failure, log `jexec <jail> ifconfig epairNb` output for diagnosis
- Add `listJails()` function that returns running jails with IPs, epairs, mounts
- Create debug command: `nanoclaw-admin inspect-jail <groupId>` (shows all jail metadata)

### [Low] 12. Hardcoded Jail Network Subnet Could Conflict
**Category**: test gap
**Files**: `/home/jims/code/nanoclaw/src/jail-runtime.js` (lines 11-27)
**Description**: The jail network uses `10.99.0.0/24` (line 78 in pf config). If the host is on a network that already uses 10.99.0.x, routing conflicts could occur. The code has no conflict detection and doesn't document how to change the subnet.

**Recommendation**:
- Document how to customize jail network in JAIL_CONFIG
- Add startup check: is 10.99.0.1 already in use? (ping test or route check)
- Consider using link-local range (169.254.x.x) to avoid conflicts
- Test with host on 10.99.x.x network (does jail networking fail?)

### [Low] 13. No Test for setup-jail-template.sh Script
**Category**: test gap
**Files**: `/home/jims/code/nanoclaw/src/scripts/setup-jail-template.sh`
**Description**: The setup script is critical for jail runtime operation, but has no automated tests. It could fail silently if:
- npm install fails due to network timeout
- TypeScript compilation fails due to syntax error
- Snapshot creation succeeds but template is unusable

The script's safety checks (lines 82-92) prevent updates when clones exist, but there's no test verifying this protection works.

**Recommendation**:
- Add shellcheck/bash linting to CI
- Add smoke test: run script in a test ZFS pool, verify snapshot is created
- Test abort path: create a clone, run script, verify it refuses to overwrite
- Add `--dry-run` mode that validates without making changes

### [Info] 14. Interface Abstraction Assessment: RuntimeDriver Pattern
**Category**: testability | observability
**Files**: `/home/jims/code/nanoclaw/src/src/container-runner.ts` (lines 783-788)
**Description**: The current if/else pattern works but creates duplication risk. The jail path (lines 369-767) and Docker path (lines 791-1154) share no code despite having identical responsibilities:
- Manage lifecycle (create, execute, destroy)
- Stream output with markers
- Handle timeouts and cancellation
- Log execution metadata

A RuntimeDriver interface would:
```typescript
interface RuntimeDriver {
  create(group, paths): Promise<RuntimeHandle>;
  exec(handle, command, env): Promise<{ stdout, stderr, code }>;
  spawn(handle, command, env): ChildProcess;
  destroy(handle): Promise<void>;
}
```

**Benefits**:
- Force both implementations to have same signatures (less drift over time)
- Enable runtime contract tests (both must pass same suite)
- Allow mocking entire runtime for container-runner tests (currently impossible)

**Costs**:
- Abstraction overhead (jail and Docker have different primitives)
- Semantic paths don't map 1:1 to Docker volumes (leaky abstraction)

**Recommendation**:
The current separation is acceptable for an initial implementation. The two runtimes are sufficiently different that forcing a shared interface would create artificial complexity. However:
- Extract common output parsing logic (OUTPUT_START_MARKER handling) into shared function
- Create runtime-agnostic test utilities (validate logs, check cleanup, etc.)
- Consider interface when adding a third runtime (Podman, LXC, etc.)

### [Info] 15. pf Configuration Has No Validation on Load
**Category**: observability
**Files**: `/home/jims/code/nanoclaw/src/etc/pf-nanoclaw.conf`, `/home/jims/code/nanoclaw/src/etc/pf-nanoclaw-anchor.conf`
**Description**: The pf configuration files are only validated when `pfctl -f` is run manually. If the external interface name is wrong (re0 vs em0), the rules will load but NAT won't work. There's no automated check that:
- `ext_if` exists on the system
- IP forwarding is enabled (`net.inet.ip.forwarding=1`)
- pf is enabled in rc.conf
- Jail traffic is actually being NAT'd

**Recommendation**:
- Add `verify-pf-config.sh` script that checks prerequisites
- On jail runtime init, verify pf is running: `pfctl -s info`
- Log warning if IP forwarding is disabled
- Add health check: create test jail, curl anthropic API, verify it works

## Interface Abstraction Assessment

The current if/else runtime pattern in container-runner.ts (line 783) is **appropriate for the current scope** but has **future maintenance risks** that should be monitored.

**Why the Current Approach Works:**

1. **Clear Separation**: Docker and Jail have completely independent code paths with no shared state. This reduces the risk of cross-runtime bugs (changing jail code can't break Docker).

2. **Semantic Differences**: The jail runtime uses semantic mount paths (lines 64-70) while Docker uses VolumeMount[] with security tricks (/dev/null shadowing). A shared interface would need to handle these differences via adapter pattern, adding complexity without clear benefit.

3. **Runtime-Specific Features**: Jails have unique concepts (ZFS snapshots, epairs, jexec) that don't map to Docker. Forcing a shared interface would create leaky abstractions.

**Where It Could Become a Problem:**

1. **Code Duplication**: The streaming output parsing (lines 482-526 for jail, 841-890 for Docker) is nearly identical. This is a maintenance burden - if the output protocol changes, both must be updated.

2. **Testing Burden**: Each runtime needs duplicate tests for timeout handling, output truncation, cleanup, etc. A shared contract test suite (that both runtimes must pass) would catch divergence.

3. **Third Runtime**: If a third runtime (Podman, LXC, Windows containers) is added, the if/else chain becomes unwieldy. At that point, a factory pattern with runtime drivers makes sense.

**Recommendations:**

1. **Short Term (Current)**: Keep the if/else pattern but extract shared logic:
   - Output marker parsing → `parseStreamingOutput(buffer, onChunk)`
   - Timeout handling → `createTimeoutHandler(timeoutMs, onTimeout)`
   - Log writing → `writeExecutionLog(logFile, metadata, stdout, stderr)`

2. **Medium Term (2-3 Runtimes)**: Introduce RuntimeDriver interface:
   ```typescript
   interface RuntimeDriver {
     create(group, input): Promise<{ id, cleanup }>;
     spawn(id, command, options): ChildProcess;
     stop(id): Promise<void>;
   }
   ```
   Keep runtime-specific details (mounts, networks) inside each driver. The interface only defines lifecycle, not implementation.

3. **Long Term (Many Runtimes)**: Consider plugin architecture where runtimes are dynamically loaded:
   ```typescript
   const driver = await loadRuntime(getRuntime()); // jail-runtime.js, docker-runtime.js
   ```
   This allows community-contributed runtimes without modifying core.

**Current Verdict**: The if/else pattern is **NOT a blocker for merging the jail runtime**. It's a reasonable first implementation. The main risk is code drift (Docker and Jail diverging over time), which can be mitigated by contract tests and shared utility functions rather than premature abstraction.

## Summary of Test Coverage Gaps

| Category | Critical | High | Medium | Low | Total |
|----------|----------|------|--------|-----|-------|
| Test Gap | 2 | 4 | 5 | 2 | 13 |
| Regression Risk | 2 | 2 | 1 | 0 | 5 |
| Testability | 0 | 1 | 0 | 0 | 1 |
| Observability | 1 | 1 | 2 | 1 | 5 |

**Highest Priority Fixes:**
1. Add cleanup failure tests and recovery mechanisms (Critical #1)
2. Add network isolation integration tests (Critical #2)
3. Add concurrency locks for jail operations (High #3)
4. Make jail-runtime unit-testable via dependency injection (High #6)
5. Add ZFS quota/error classification (High #4)

**Test Suite Recommendations:**

Create three test tiers:

1. **Unit Tests** (no sudo required):
   - Mock syscalls layer, test command construction
   - Test sanitization, path building, config validation
   - Test error handling logic (not actual errors)

2. **Integration Tests** (require sudo/ZFS):
   - Create/destroy jails with real ZFS
   - Test cleanup under failure conditions
   - Test concurrent operations
   - Test network isolation (restricted mode)

3. **Contract Tests** (runtime-agnostic):
   - Both Docker and Jail must pass
   - Test group isolation, mount security, timeout handling
   - Validates both runtimes implement same semantics

This review identifies 15 findings across test coverage, regression risks, testability, and observability. The jail runtime is architecturally sound but needs significant test hardening before production use, particularly around error paths and resource cleanup.
