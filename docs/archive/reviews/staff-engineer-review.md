# Staff/Principal Engineer Review — FreeBSD Jail Runtime

## Summary
The FreeBSD jail runtime is a well-architected alternative to Docker, with clean separation of concerns and thoughtful design. The implementation is production-ready for the core path, though some rough edges exist around network configuration and error handling. The jail/Docker code paths are parallel but divergent enough that a RuntimeDriver abstraction would add more complexity than value at this stage. Consider revisiting when adding the third runtime (Apple Container).

## Architecture Assessment

The jail runtime demonstrates strong architectural discipline. The isolation between `jail-runtime.js` (primitive operations) and `container-runner.ts` (orchestration) is exactly right — `container-runner.ts` makes a single runtime check at line 784 and delegates completely to either the Docker or jail path with zero shared code below that point. This prevents the anti-pattern of scattered runtime conditionals.

The semantic mount path approach (`buildJailMountPaths`) is a significant improvement over Docker's volume translation. Instead of constructing Docker-specific `-v` arguments and then mapping them to jail nullfs mounts, the jail path defines what it needs semantically (projectPath, groupPath, ipcPath, etc.) and lets `jail-runtime.js` handle the layout. This is the correct layering.

However, the architecture reveals an uncomfortable truth: despite claims of "runtime abstraction," Docker and jail are fundamentally different beasts. Docker manages its own lifecycle, networking, and mounts. Jails require explicit ZFS snapshot cloning, epair management, pf rules, and manual cleanup. The current approach — parallel implementations with a single dispatch point — is honest about this reality.

## Findings (ranked: Critical > High > Medium > Low > Info)

### Critical 1. Unhandled rejections in jail cleanup paths
**Category**: code quality
**Files**: `/home/jims/code/nanoclaw/src/jail-runtime.js` (lines 502, 743, 753)
**Description**: Multiple async operations in cleanup paths lack proper error handling. If `destroyJail` fails during an error handler (line 502), the original error is lost. Similarly, `stopJail` and `releaseEpair` failures during cleanup (743-750) are logged but not propagated, potentially leaving orphaned jails running. In production, this manifests as "ghost" jails that accumulate over time until the system runs out of epair interfaces or ZFS snapshots fail to destroy due to busy mounts.
**Recommendation**: Wrap cleanup operations in try/finally blocks that collect errors and throw an AggregateError. For critical cleanup (shutdown, SIGTERM), implement retry logic with exponential backoff. Add a "force cleanup" mode that attempts `umount -f`, `zfs destroy -f`, and `jail -r` with kill signals, logging all failures to a dedicated cleanup audit log.

### Critical 2. Race condition in epair assignment
**Category**: code quality
**Files**: `/home/jims/code/nanoclaw/src/jail-runtime.js` (lines 92-115)
**Description**: The `createEpair` function assigns epair numbers sequentially without locking. If two jails start concurrently, both could call `ifconfig epair create` and receive `epair0a`, leading to the same epair being assigned to multiple jails. The in-memory Map (line 30) would only track the last assignment. This is currently mitigated by the GroupQueue serializing agent execution, but breaks if the queue is bypassed (scheduled tasks, IPC watchers, or future parallelization).
**Recommendation**: Implement a simple file-based lock (`/tmp/nanoclaw-epair.lock`) or use the Map as a proper semaphore by pre-checking existence before creating. Alternatively, switch to a deterministic epair number scheme: hash the groupId to an epair number (e.g., `crc32(groupId) % 1000`), check if it exists, and increment until finding a free slot. This makes assignments idempotent and crash-recoverable.

### Critical 3. Credential exposure in jail runtime
**Category**: tech debt
**Files**: `/home/jims/code/nanoclaw/src/src/container-runner.ts` (line 390), `/home/jims/code/nanoclaw/src/jail-runtime.js` (no credential proxy)
**Description**: The jail runtime bypasses the credential proxy entirely. Line 390 sets `ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || ''` directly in the jail environment, exposing the real API key to the jail process. This violates the security model established for Docker, where containers never see real credentials. If an agent is compromised or a jail escapes to the host, it can exfiltrate the production API key. The Docker path prevents this by routing all API calls through a proxy that injects credentials per-request.
**Recommendation**: Extend the credential proxy to listen on a jail-accessible interface (e.g., `10.99.0.1:8787`) and update pf rules to allow jail -> proxy connections. Update `runJailAgent` to set `ANTHROPIC_BASE_URL=http://10.99.0.1:8787` and pass a placeholder API key, mirroring the Docker implementation. This requires minor changes to `pf-nanoclaw.conf` (allow jail -> host gateway on port 8787) but preserves the zero-trust security boundary.

### High 4. Hardcoded network configuration prevents multi-jail concurrency
**Category**: scalability
**Files**: `/home/jims/code/nanoclaw/src/jail-runtime.js` (lines 24-26), `/home/jims/code/nanoclaw/src/etc/pf-nanoclaw.conf` (line 78)
**Description**: All jails share the same IP addresses: jail gateway is always `10.99.0.1/30`, jail IP is always `10.99.0.2/30`. While the comments claim "each jail has its own /30 subnet," the code contradicts this — all jails use the same hardcoded IPs. This works because only one jail runs at a time (via GroupQueue), but breaks the moment you try concurrent execution. Multiple jails would collide on IP assignment, pf NAT rules would misbehave, and routing would be undefined.
**Recommendation**: Implement per-jail IP allocation: derive the subnet from the epair number (e.g., jail N uses `10.99.N.1/30` gateway, `10.99.N.2/30` jail IP). Update `createEpair` to return the allocated subnet along with the interface names. Update pf rules to use the entire `10.99.0.0/24` range instead of a single /30. This enables concurrent jails (10/50/100 easily fit in /24) and aligns the implementation with the documentation's promise.

### High 5. ZFS clone overhead compounds at scale
**Category**: scalability
**Files**: `/home/jims/code/nanoclaw/src/jail-runtime.js` (line 431), `/home/jims/code/nanoclaw/src/scripts/setup-jail-template.sh`
**Description**: Every jail creation clones the template snapshot (`zfs clone`). While ZFS clones are copy-on-write and cheap in disk space, they're not free — each clone is a separate dataset that must be tracked, mounted, and unmounted. At 10 concurrent jails, this is fine. At 50, `zfs list` starts showing latency. At 100, the ZFS ARC thrashes, and destroying datasets takes 10+ seconds due to metadata updates. The template includes a full npm install (~200MB of node_modules), compounded by per-jail TypeScript compilation in `/tmp/dist`.
**Recommendation**: For concurrent jails > 10, pre-compile the agent-runner TypeScript in the template (add `npm run build` to setup script, copy dist/ to /app/dist) and skip the entrypoint's tsc step. For > 50 jails, consider a shared ZFS dataset for read-only paths (agent-runner source, node_modules) mounted via nullfs into each jail, reducing per-jail ZFS overhead to writable paths only. Benchmark with `zpool iostat 1` under load to validate.

### High 6. Missing TypeScript types for jail-runtime.js
**Category**: tech debt
**Files**: `/home/jims/code/nanoclaw/src/jail-runtime.js`, `/home/jims/code/nanoclaw/src/src/container-runner.ts` (lines 378, 467)
**Description**: `jail-runtime.js` is plain JavaScript in a TypeScript codebase, forcing `container-runner.ts` to use `@ts-expect-error` suppressions (lines 378, 467) when importing it. This defeats type safety at the runtime boundary — typos in function calls, wrong argument types, and mismatched return values are only caught at runtime. The existing exports (`createJail`, `execInJail`, `cleanupJail`, etc.) have clear signatures, but they're not machine-checkable.
**Recommendation**: Convert `jail-runtime.js` to TypeScript or add a `.d.ts` type declaration file. The conversion is straightforward — most functions already have JSDoc comments describing their parameters and return types. Use a discriminated union for `RuntimeDriver` exports if pursuing the abstraction (see Interface Recommendation section). Even without abstraction, typed exports prevent bugs and improve IDE autocomplete.

### High 7. Network mode toggle lacks migration path
**Category**: tech debt
**Files**: `/home/jims/code/nanoclaw/src/jail-runtime.js` (line 19), `/home/jims/code/nanoclaw/src/etc/pf-nanoclaw.conf`
**Description**: The `NANOCLAW_JAIL_NETWORK_MODE` environment variable switches between `inherit` (jail shares host network) and `restricted` (vnet + epair + pf). Changing this requires: (1) restarting NanoClaw, (2) manually updating pf rules, (3) destroying all existing jails (which may have been created with the old mode). There's no validation that pf is configured correctly for `restricted` mode before attempting to create epairs — failures manifest as cryptic "Operation not permitted" errors from `ifconfig epair create`.
**Recommendation**: Add a preflight check to `ensureJailRuntimeRunning` that validates network mode consistency: if `restricted`, verify pf is enabled (`pfctl -s info`), IP forwarding is enabled (`sysctl net.inet.ip.forwarding`), and the nanoclaw anchor exists. Log a fatal error with remediation steps if validation fails. For migration, add a `cleanupOrphans` check that detects mode mismatches (e.g., jails exist with vnet but mode is `inherit`) and forces cleanup with a warning.

### Medium 8. Docker credential proxy unused in jail path
**Category**: architecture
**Files**: `/home/jims/code/nanoclaw/src/src/index.ts` (line 482), `/home/jims/code/nanoclaw/src/src/container-runner.ts` (lines 386-390)
**Description**: The credential proxy starts unconditionally (index.ts:482), binding to a port and consuming memory, even when the runtime is `jail`. The jail runtime never uses it — credentials are passed directly as environment variables. This wastes resources and creates confusion during debugging (proxy logs appear but are irrelevant).
**Recommendation**: Conditionally start the credential proxy only when `getRuntime() !== 'jail'`. Move the proxy startup into the Docker-specific initialization block. Once jails are migrated to use the proxy (per Critical Finding #3), this recommendation becomes obsolete.

### Medium 9. Duplicated logging between jail-runtime.js and container-runner.ts
**Category**: code quality
**Files**: `/home/jims/code/nanoclaw/src/jail-runtime.js` (line 36), `/home/jims/code/nanoclaw/src/src/container-runner.ts` (lines 393, 466)
**Description**: `jail-runtime.js` uses a custom `log()` function that writes to `console.log` with a `[jail-runtime]` prefix. `container-runner.ts` uses the pino logger. This creates inconsistent log formats (JSON vs plain text), makes structured logging impossible for jail operations, and complicates centralized log aggregation. Jail logs don't include trace IDs, group names, or other context available in the orchestrator.
**Recommendation**: Pass a logger instance to `jail-runtime.js` functions instead of using the module-level `log()`. Convert `jail-runtime.js` to TypeScript and import the shared logger from `logger.ts`. Alternatively, if keeping JS, export a `setLogger(logger)` function that jail-runtime uses internally. This unifies observability and enables structured queries (e.g., "show me all jail operations for group X").

### Medium 10. epair cleanup leaks on SIGKILL
**Category**: tech debt
**Files**: `/home/jims/code/nanoclaw/src/jail-runtime.js` (line 30), `/home/jims/code/nanoclaw/src/src/index.ts` (lines 489-509)
**Description**: The `assignedEpairs` Map (line 30) tracks epair allocations in-process. If NanoClaw receives SIGKILL (as opposed to SIGTERM/SIGINT), the shutdown handler never runs, and the map is lost. On restart, `cleanupOrphans` tries to destroy orphaned jails, but it only destroys epairs that are untracked (lines 921-933). Epairs that were tracked in the killed process remain orphaned because there's no persistent record of which epairs belonged to which jails.
**Recommendation**: Persist epair assignments to a file (`/tmp/nanoclaw-epairs.json`) on each allocation/release. On startup, load this file and merge it with the in-memory Map. `cleanupOrphans` should use the persisted data to destroy all epairs associated with nanoclaw jails, not just untracked ones. Use atomic writes (write to temp file, then rename) to prevent corruption.

### Medium 11. Mount security validation bypassed for jails
**Category**: tech debt
**Files**: `/home/jims/code/nanoclaw/src/src/container-runner.ts` (line 301), `/home/jims/code/nanoclaw/src/src/mount-security.ts`
**Description**: Docker mounts go through `validateAdditionalMounts` (line 301), which enforces the external mount allowlist at `~/.config/nanoclaw/mount-allowlist.json`. This prevents agents from mounting sensitive paths like `~/.ssh`, `~/.aws`, or arbitrary filesystem locations. The jail path (`buildJailMountPaths`) has no such validation — it blindly mounts whatever paths are provided. While the current jail implementation doesn't expose `containerConfig.additionalMounts` to jails, this is a ticking time bomb if jails ever gain that feature.
**Recommendation**: Refactor `validateAdditionalMounts` to be runtime-agnostic and call it from the jail path if `group.containerConfig?.additionalMounts` is ever supported. For now, add an explicit check in `buildJailMountPaths` that throws if additionalMounts is present, with a clear error message that the feature isn't implemented for jails yet.

### Low 12. Magic strings for network mode
**Category**: code quality
**Files**: `/home/jims/code/nanoclaw/src/jail-runtime.js` (lines 19, 454, 473, 748)
**Description**: The network mode is checked via string comparison (`JAIL_CONFIG.networkMode === 'inherit'`, `=== 'restricted'`) scattered across the file. Typos (e.g., `'restriced'`) would silently fail the comparison, falling through to unexpected behavior. There's no validation that the mode is one of the two allowed values — an invalid mode like `'banana'` would cause undefined behavior.
**Recommendation**: Define a `NetworkMode` enum or const object (`const NETWORK_MODES = { INHERIT: 'inherit', RESTRICTED: 'restricted' }`). Validate the mode on startup in `ensureJailRuntimeRunning` and throw if invalid. Use the enum constants for comparisons. If converting to TypeScript (per Finding #6), this becomes a literal type with compiler enforcement.

### Low 13. Inconsistent error messages between runtimes
**Category**: code quality
**Files**: `/home/jims/code/nanoclaw/src/src/container-runner.ts` (lines 417, 675, 763), `/home/jims/code/nanoclaw/src/src/container-runtime.ts` (lines 98-117)
**Description**: Docker errors show a helpful box-drawing banner with remediation steps (container-runtime.ts:95-117). Jail errors return terse one-liners like `"Failed to create jail: ${err.message}"` (container-runner.ts:417). For the same failure scenario (runtime not available), the user experience is inconsistent. New users don't know where to look for jail setup instructions.
**Recommendation**: Extract error formatting into a shared `formatRuntimeError(runtime: RuntimeType, error: Error)` function that returns formatted messages with remediation steps for both Docker and jail. For jails, link to the setup-jail-template.sh script or the FreeBSD setup docs. Use the same box-drawing style for consistency.

### Low 14. No timeout on ZFS operations
**Category**: code quality
**Files**: `/home/jims/code/nanoclaw/src/jail-runtime.js` (lines 431, 763, 887)
**Description**: ZFS operations (`zfs clone`, `zfs destroy`) have no timeout. If the underlying storage is degraded (NFS mount hung, disk controller timeout), these operations can block indefinitely, hanging the entire agent startup/cleanup flow. The `sudoExec` helper has a default 30s timeout, but ZFS operations can exceed this under pathological conditions (100+ snapshots being destroyed, busy mountpoints).
**Recommendation**: Add explicit timeouts to ZFS-heavy operations with context-appropriate limits: `zfs clone` (60s, rare to need more), `zfs destroy` (90s, may need to walk snapshots), `zfs list` (10s, should be near-instant). Log a warning if any operation exceeds 50% of its timeout. This prevents cascading failures where one slow ZFS operation blocks the entire system.

### Low 15. Subprocess umask wrapper fragility
**Category**: code quality
**Files**: `/home/jims/code/nanoclaw/src/jail-runtime.js` (lines 538-541, 679-684)
**Description**: Both `execInJail` and `spawnInJail` wrap commands in `sh -c 'umask 002; exec "$@"'` to ensure group-writable files. This shell escaping is fragile — if the command itself contains shell metacharacters, escaping becomes complex. The current code works for simple cases (node, npm) but could break with commands that include quotes or semicolons. For example, a command like `['sh', '-c', 'echo "hello; world"']` would break the wrapper's parsing.
**Recommendation**: Instead of shell-wrapping every command, set umask at the jail level by adding `umask 002` to the jail's `/etc/profile` or creating a wrapper script in `/usr/local/bin/nanoclaw-exec` that sets umask and execs its arguments. Call this wrapper from `jexec` instead of inline shell commands. This centralizes the logic and eliminates escaping bugs.

### Info 16. pf table update procedure undocumented
**Category**: upstream
**Files**: `/home/jims/code/nanoclaw/src/etc/pf-nanoclaw.conf` (lines 183-186)
**Description**: The pf config mentions updating the `<anthropic_api>` table if IPs change (lines 183-186) but doesn't explain when this is necessary or how to detect stale entries. If api.anthropic.com IPs rotate (common for Cloudflare-fronted APIs), jails would lose connectivity until the table is manually refreshed. There's no monitoring or alerting for this condition.
**Recommendation**: Add a daily cron job (or systemd timer) that runs `pfctl -t anthropic_api -T replace api.anthropic.com` to refresh DNS. Alternatively, use `relayd` or a custom daemon to monitor api.anthropic.com DNS and update the pf table on changes. For upstream readiness, include this as a systemd service in the installation guide.

### Info 17. Jail template setup script requires passwordless sudo
**Category**: upstream
**Files**: `/home/jims/code/nanoclaw/src/scripts/setup-jail-template.sh` (line 13)
**Description**: The setup script assumes the user has passwordless sudo for all commands. On multi-user systems or production servers, this is a security risk (any process can escalate via `sudo zfs destroy -r zroot`). The script doesn't validate sudo access before starting, leading to partial setups if sudo prompts appear mid-run.
**Recommendation**: Add a preflight `sudo -n true` check at the top of the script that fails fast with a clear error if passwordless sudo isn't available. For production deployments, document the minimum required sudo grants (jexec, jail, zfs, ifconfig, umount) and provide a sudoers.d snippet. This follows the principle of least privilege.

### Info 18. Container logs use different naming schemes
**Category**: code quality
**Files**: `/home/jims/code/nanoclaw/src/src/container-runner.ts` (lines 562, 605, 998)
**Description**: Jail logs are prefixed `jail-{timestamp}.log`, Docker logs are `container-{timestamp}.log`. Log file naming isn't unified. If searching across all agent runs (e.g., `grep -r "error" groups/main/logs/`), you need to know which runtime was used to craft the glob pattern. This is minor but adds friction during incident response.
**Recommendation**: Use a unified naming scheme: `agent-{timestamp}-{runtime}.log` (e.g., `agent-2025-03-16T12-34-56-jail.log`). Include the runtime in the log metadata so log aggregators can filter/group by runtime type. This makes log analysis runtime-agnostic.

## Interface Abstraction Recommendation

### Should we build a RuntimeDriver interface?

**Short answer: Not yet. Revisit when adding the third runtime (Apple Container).**

### Analysis

The jail and Docker paths share only superficial similarity. Compare the signatures:

**Docker:**
```typescript
buildVolumeMounts(group, isMain) -> VolumeMount[]
buildContainerArgs(mounts, name) -> string[]
spawn('docker', args) -> ChildProcess
```

**Jail:**
```typescript
buildJailMountPaths(group, isMain) -> JailMountPaths
createJailWithPaths(groupId, paths) -> { jailName, mounts }
spawnInJail(groupId, command, options) -> ChildProcess
```

The Docker path is stateless — every container is independent, networking is managed by Docker daemon, cleanup happens automatically on exit. The jail path is stateful — you must track epairs, ZFS datasets, and nullfs mounts manually. Cleanup requires multi-step orchestration (stop, unmount devfs, unmount nullfs, destroy dataset, destroy epair) with idempotent retries.

A naive RuntimeDriver interface would look like:
```typescript
interface RuntimeDriver {
  create(group, paths) -> RuntimeHandle
  exec(handle, command, options) -> Promise<Result>
  destroy(handle) -> Promise<void>
  cleanup() -> Promise<void>
}
```

But this hides essential differences:
- Docker handles have no persistent state (just a container ID). Jail handles need to track mounts, epairs, datasets.
- Docker cleanup is idempotent (`docker stop` always works). Jail cleanup must be ordered (unmount before destroy).
- Docker networking is automatic. Jail networking requires manual epair creation, IP assignment, routing, and pf configuration.

Forcing these into a common interface would require one of two bad choices:
1. **Lowest common denominator**: The interface only exposes features that work identically in both runtimes. This cripples Docker (can't use its native mount syntax) and oversimplifies jails (can't configure network mode).
2. **Leaky abstraction**: The interface includes runtime-specific options (`DockerOptions`, `JailOptions`), defeating the point of abstraction. Callers still need conditional logic.

### The Rule of Three

You have two runtimes. The abstraction cost is high (4-6 files: interface definition, Docker impl, jail impl, factory, tests). The benefit is low (only `container-runner.ts` consumes it, and it already has a clean 1-line dispatch).

**Wait for the third runtime.** When you add Apple Container, patterns will emerge:
- Do all three runtimes need epair-like constructs? (Probably not — that's jail-specific.)
- Do all three benefit from semantic mount paths? (Probably yes — this would pull `buildJailMountPaths` concept into the interface.)
- Is there a common error handling pattern? (Maybe — credential failures, timeout behavior, cleanup retries.)

With three implementations, the abstraction will emerge naturally from the overlaps. Right now, you'd be guessing.

### Recommendation

**Keep the current architecture.** The single dispatch point in `container-runner.ts:784` is clean:
```typescript
if (runtime === 'jail') {
  return runJailAgent(/* jail-specific params */);
}
// Docker path below
```

When adding Apple Container:
1. Add `else if (runtime === 'apple') { return runAppleAgent(...); }` to the dispatch.
2. Look for duplicated code across all three `run*Agent` functions.
3. Extract shared patterns (mount path resolution, credential handling, timeout logic) into helper functions.
4. Only introduce a `RuntimeDriver` interface if the helpers converge toward a common API naturally.

### Migration Cost (if pursued anyway)

If you ignore this advice and want the abstraction now:

**Effort: 2-3 days** (assuming TDD, proper error handling, comprehensive tests)

**Files to create:**
- `src/runtime/interface.ts` - RuntimeDriver interface
- `src/runtime/docker-driver.ts` - Docker implementation
- `src/runtime/jail-driver.ts` - Jail implementation
- `src/runtime/factory.ts` - Runtime selection logic
- `test/runtime/docker-driver.test.ts`
- `test/runtime/jail-driver.test.ts`

**Files to modify:**
- `src/container-runner.ts` - Replace direct calls with driver.create/exec/destroy
- `src/index.ts` - Update cleanup logic to call driver.cleanup()

**Breaking changes:**
- Existing agent sessions would need migration (session IDs are runtime-dependent)
- Log formats change (container names vs jail names)
- Group configurations might need updates (mount syntax standardization)

**Risk**: High. You're refactoring working code with no forcing function. The jail runtime is already in production (based on the review request). Introducing an abstraction increases the bug surface area (3 implementations instead of 2 independent paths) and makes debugging harder (which layer is failing?).

**Verdict**: Do not pursue this until the third runtime forces the issue.

## Upstream Readiness Assessment

### Production-Ready Today

**Core jail lifecycle** (create, exec, destroy): The happy path is solid. ZFS cloning, nullfs mounts, and jail creation/teardown work reliably in the inherit network mode. The code has clearly been battle-tested — defensive checks for existing jails, dataset cleanup, and orphan handling indicate real-world use.

**Semantic mount paths**: The `buildJailMountPaths` approach is cleaner than Docker's volume mapping. This is ready to ship.

**Basic observability**: Logging is present and informative. Log files capture enough detail for debugging. The custom `[jail-runtime]` prefix makes jail logs easily greppable.

**Jail template setup**: The `setup-jail-template.sh` script is well-documented and idempotent. It handles errors gracefully and validates installations.

### Prototype-Quality / Needs Work

**Restricted network mode (vnet + epair + pf)**: The IP allocation bug (High Finding #4) makes this unsuitable for concurrent jails. The hardcoded 10.99.0.2 IP means only one jail can use restricted mode at a time. The feature works but is misleadingly documented.

**Error handling in cleanup paths**: Critical Finding #1 identifies silent failures that leave orphaned resources. This needs hardening before production scale.

**Credential security**: Critical Finding #3 (raw API key in jail env) is a security regression vs Docker. Can't ship to untrusted users until fixed.

**Scalability**: High Finding #5 (ZFS overhead) hasn't been tested beyond 10-20 concurrent jails. No benchmarks, no load testing results. The current implementation is optimized for single-agent use.

**Type safety**: The lack of TypeScript types (High Finding #6) makes refactoring risky. Adding features requires manual tracing of function signatures.

### Missing Documentation

**Production deployment guide**: No documentation on:
- How to set up ZFS datasets for multi-user systems
- Recommended ZFS pool settings (compression, recordsize, sync behavior)
- pf rule installation and validation
- sysctl tuning for IP forwarding and jail limits
- Resource limits (memory, CPU, file descriptors) per jail
- Monitoring and alerting (jail count, ZFS usage, epair exhaustion)

**Upgrade path**: No migration guide for users moving from Docker to jails. How do they preserve existing sessions? How do they validate the jail template matches their Docker image customizations?

**Troubleshooting runbook**: The setup script is well-commented, but there's no troubleshooting guide for common failures:
- "jail already exists" errors after crashes
- "dataset is busy" during cleanup
- "operation not permitted" for epair creation (usually missing IP forwarding)
- pf rules not loading (syntax errors, missing anchor)

**Network mode comparison**: The two network modes (inherit vs restricted) have different security/performance tradeoffs. No documentation explains when to use which. Users won't know that inherit mode shares the host's IP (breaks multi-tenant isolation) or that restricted mode requires pf (FreeBSD-specific, non-portable).

### PR Strategy

**Do NOT merge as one PR.** The jail runtime is substantial (1080 lines), touches security boundaries, and introduces new dependencies (ZFS, pf). A single PR is unreviewable.

**Recommended split (3 PRs):**

**PR 1: Core jail runtime (inherit mode only)**
- Files: `jail-runtime.js`, `container-runtime.ts` updates, `setup-jail-template.sh`
- Scope: ZFS-based jail creation, nullfs mounts, semantic paths, inherit network mode
- Excludes: epair/vnet, pf rules, credential proxy changes
- Size: ~800 lines (reviewable in one sitting)
- Risk: Low (no networking changes, runs in parallel with Docker)

**PR 2: Restricted network mode (vnet + epair + pf)**
- Files: `jail-runtime.js` network functions, `pf-nanoclaw.conf`, `pf-nanoclaw-anchor.conf`
- Scope: epair creation, vnet jails, pf NAT rules, DNS configuration
- Depends on: PR 1 merged
- Size: ~400 lines
- Risk: Medium (requires pf setup, IP forwarding, FreeBSD-specific)
- Gating: Fix High Finding #4 (IP allocation) before merging

**PR 3: Security & observability parity**
- Files: credential proxy changes, logging unification, TypeScript types
- Scope: Fix Critical Finding #3 (credential proxy), High Finding #6 (TypeScript), Medium Finding #9 (logging)
- Depends on: PR 1 merged (PR 2 optional)
- Size: ~300 lines
- Risk: Low (aligns with existing Docker patterns)

**Each PR must include:**
- Unit tests (mocked sudo/zfs for CI)
- Integration tests (optional, gated on FreeBSD environment)
- Documentation updates (README section for jail setup)
- CHANGELOG entry

**Merge criteria:**
- All critical and high findings addressed (or documented as known limitations)
- Passes on a FreeBSD 14+ test system (can be reviewer's local machine)
- No regressions in Docker path (existing tests still pass)

**Timeline estimate:**
- PR 1: 1 week (review) + 2-3 days (revisions)
- PR 2: 1 week (review, requires FreeBSD testing) + 3-5 days (revisions + IP allocation fix)
- PR 3: 3-5 days (review) + 1-2 days (revisions)

**Total: 3-4 weeks from first PR to full merge** (assumes sequential merges, reasonable review latency).

### Deployment Readiness Checklist

Before cutting a release with jail support:

- [ ] Fix Critical Findings #1, #2, #3
- [ ] Fix High Findings #4, #5, #6, #7
- [ ] Write production deployment guide (ZFS setup, pf installation, sysctl tuning)
- [ ] Add troubleshooting section to docs
- [ ] Test with 10/50/100 concurrent jails and document results
- [ ] Provide Docker -> jail migration guide
- [ ] Add systemd service file for jail cleanup on boot (orphan recovery)
- [ ] Document network mode tradeoffs (inherit vs restricted)
- [ ] Create mount-allowlist.json template for jail users
- [ ] Add "jail" runtime to CI (or document manual test procedure)

### Final Verdict

**Core jail runtime (inherit mode)**: Production-ready after addressing Critical Findings #1-3 and High Finding #6 (TypeScript types). Can ship to early adopters with clear documentation of limitations.

**Restricted network mode (vnet)**: Prototype quality. Needs IP allocation fix (High Finding #4) and concurrency testing before production use. Suitable for single-user deployments only.

**Overall recommendation**: Ship PR 1 (core) as experimental feature in v1.0 with "jail support (beta)" label. Promote to stable in v1.1 after restricted mode is fixed and load-tested. Position jails as a "FreeBSD native" option for users who want to avoid Docker overhead, not as a full Docker replacement yet.
