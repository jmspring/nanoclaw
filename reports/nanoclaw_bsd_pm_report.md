# NanoClaw-BSD Product Management Report

**Date**: 2026-03-25
**Author**: PM Agent (Claude Opus 4.6)
**Scope**: Feature parity assessment, FreeBSD-specific functionality, and strategic recommendations

---

## 1. Executive Summary

NanoClaw-BSD (jmspring/nanoclaw) is a FreeBSD-focused fork of upstream NanoClaw (qwibitai/nanoclaw) that adds a first-class FreeBSD jail runtime as an alternative to Docker. The jail implementation is mature and production-ready, spanning approximately 2,720 lines of TypeScript across 10 well-organized modules in `src/jail/`. The fork has a comprehensive setup pipeline, pf firewall integration, ZFS-based template system, rc.d service management, and Prometheus-compatible metrics.

The fork is approximately 190 commits behind upstream on non-merge changes, though many of those are version bumps, doc updates, and contributor additions. There are meaningful upstream features that have not been synced, and there are FreeBSD-native capabilities that could significantly differentiate this fork.

---

## 2. Feature Parity Assessment: Upstream vs. NanoClaw-BSD

### 2.1 Features Successfully Synced from Upstream

The following upstream features are present in the fork (verified via git log and source inspection):

| Feature | Status | Source |
|---------|--------|--------|
| Credential proxy (native) | Synced | `src/credential-proxy.ts` with jail-specific hardening (per-jail tokens, source IP validation, rate limiting) |
| Remote control | Synced | `src/remote-control.ts` exists |
| Per-group IPC namespaces | Synced | `src/ipc.ts`, per-group isolation in both Docker and jail runners |
| Agent runner with streaming output | Synced | `src/runner-common.ts` shared between Docker and jail |
| Container skills (agent-browser, capabilities, status, slack-formatting) | Synced | `container/skills/` directory matches upstream |
| Group queue with concurrency control | Synced | `src/group-queue.ts` |
| Mount security validation | Synced | `src/mount-security.ts` |
| Log rotation | Synced | `src/log-rotation.ts` |
| Task scheduler with script execution | Synced | `src/task-scheduler.ts` (script field added per upstream) |
| ESLint configuration | Synced | Per upstream 13C sync |
| Channel-agnostic registry | Synced | `src/channels/registry.ts` |
| Docker Sandboxes documentation | Present | `docs/docker-sandboxes.md` |

### 2.2 Upstream Features NOT Yet Synced

Based on analysis of the 190 commits on `upstream/main` not present on `main`, the following significant upstream changes have not been synced:

| Feature | Upstream Commit(s) | Impact | Priority |
|---------|-------------------|--------|----------|
| **OneCLI gateway** replacing credential proxy | `e936961` | Major architectural change -- upstream replaced the credential proxy with OneCLI for secret injection. The fork still uses the native credential proxy (which is actually superior for jails since it supports per-jail token isolation). | **EVALUATE** -- may not be desirable for BSD fork |
| **Per-group trigger patterns** | `0015931` | Allows different trigger words per group. Currently missing. | **HIGH** |
| **Agent-runner source cache refresh** | `d05a8de` | Refreshes stale agent-runner source when code changes. The fork copies agent-runner to a per-group dir but does not detect staleness. | **MEDIUM** |
| **CLAUDE.md template on group registration** | `4e3189d`, `5a12ddd` | Creates CLAUDE.md from template when registering groups via IPC. Prevents empty group folders. | **MEDIUM** |
| **macOS status bar skill** | `e4f15b6` | macOS-only; not relevant to FreeBSD. | **SKIP** |
| **Emacs channel skill** | `68c59a1` | Channel skill; would work on FreeBSD if merged. | **LOW** |
| **Channel formatting skill** | `7bba21a` | Generic formatting skill for channels. | **LOW** |
| **Timezone validation** | `11847a1` | Prevents crash on POSIX-style TZ values. | **HIGH** (safety fix) |
| **Version bumps** (1.2.14 through 1.2.34) | Multiple | Version numbering. Fork has its own versioning. | **SKIP** |
| **Diagnostics/PostHog telemetry** | `f04a895` et al. | Opt-in diagnostics via PostHog. May not be desired for privacy-focused BSD users. | **EVALUATE** |
| **Claw CLI skill** | `1846929` | Python CLI for managing NanoClaw from terminal. Would work on FreeBSD. | **MEDIUM** |
| **Login linger fix** | `aeabfcc` | systemd-specific (loginctl). Not applicable to FreeBSD (rc.d handles this natively). | **SKIP** |
| **Docker stop timeout reduction** | `cf3d9dc` | Docker-specific. Not applicable to jails. | **SKIP** |

### 2.3 Upstream Changes Intentionally Divergent

The fork intentionally diverges from upstream in these areas:

1. **Credential proxy vs. OneCLI**: The fork retains the native credential proxy (`src/credential-proxy.ts`) with jail-specific enhancements (per-jail UUID tokens registered/revoked on jail create/destroy, IP source validation against jail subnet, rate limiting). Upstream moved to OneCLI. The fork's approach is architecturally better for jail isolation because tokens are scoped per-jail and automatically revoked on cleanup. **Recommendation**: Keep the fork's approach; do not adopt OneCLI.

2. **Runtime detection**: `src/container-runtime.ts` line 19 auto-detects FreeBSD and defaults to `jail` runtime. Upstream only knows `docker` and `apple`.

3. **Proxy bind host**: The fork's `detectProxyBindHost()` in `container-runtime.ts` handles jail subnet gateway binding, which upstream does not need.

4. **Config bounds clamping**: `src/config.ts` uses `clampInt()` wrappers (added during hardening phases) to safely bound timeout and resource limit values. Upstream has simpler `parseInt()` calls.

---

## 3. FreeBSD-Specific Features Already Implemented

### 3.1 Jail Runtime (`src/jail/`)

The jail runtime is the crown jewel of this fork. It comprises 10 focused modules (refactored from a monolithic `jail-runtime.js` during hardening phase 10):

| Module | File | Lines | Responsibility |
|--------|------|-------|----------------|
| Lifecycle | `src/jail/lifecycle.ts` | ~670 | Jail create, stop, destroy, ZFS clone management, credential token lifecycle |
| Exec | `src/jail/exec.ts` | ~183 | Command execution inside jails (exec and spawn), timeout handling, abort signals |
| Network | `src/jail/network.ts` | ~334 | vnet/epair creation and teardown, pf validation, DNS setup, epair state persistence |
| Mounts | `src/jail/mounts.ts` | ~272 | nullfs mount building, fstab generation, mount path validation, security checks |
| Cleanup | `src/jail/cleanup.ts` | ~258 | Orphan detection, force cleanup, epair cleanup, audit logging |
| Runner | `src/jail/runner.ts` | ~245 | Jail-specific agent runner (equivalent to Docker runner), mount path building |
| Config | `src/jail/config.ts` | ~113 | All jail configuration, env var parsing, resource limits, mount layout |
| Metrics | `src/jail/metrics.ts` | ~292 | Health check endpoint (/health), Prometheus metrics (/metrics) |
| Sudo | `src/jail/sudo.ts` | ~78 | Dependency-injectable sudo executor (enables testing without root) |
| Types | `src/jail/types.ts` | ~119 | TypeScript type definitions for all jail interfaces |

### 3.2 ZFS Integration

- **Template-based cloning**: Each jail is an instant ZFS clone from `zroot/nanoclaw/jails/template@base` (sub-100ms creation)
- **Copy-on-write storage**: Zero-copy clones mean jails share base system storage
- **Per-jail quota**: Configurable via `NANOCLAW_JAIL_QUOTA` (default 1G)
- **ZFS properties**: `setuid=off` on jail datasets, `compression=lz4` and `atime=off` on parent
- **Blue/green template updates**: `setup-jail-template.sh` supports named templates for zero-downtime updates
- **Template integrity verification**: SHA-256 manifest generation and snapshot validation

### 3.3 Network Isolation (vnet + epair + pf)

- **Per-jail virtual network stack** via `vnet` -- true isolation, not filtering
- **Per-jail /30 subnet** from 10.99.0.0/24 pool -- supports up to 256 concurrent jails
- **Epair state persistence** to disk (`data/epairs.json`) for crash recovery
- **pf firewall rules** restricting jail egress to DNS and api.anthropic.com only
- **Pinned IP ranges** for Anthropic API (defense against DNS poisoning)
- **Two pf configuration modes**: standalone (`etc/pf-nanoclaw.conf`) and anchor (`etc/pf-nanoclaw-anchor.conf`)
- **Inter-jail traffic blocking** -- jails cannot communicate with each other

### 3.4 Resource Limits (rctl)

- **Memory**: Configurable per-jail memory limit (default 2G)
- **Processes**: Max process count (default 100) -- prevents fork bombs
- **CPU**: CPU percentage limit (default 80%)

### 3.5 Security Hardening

- **Restrictive devfs ruleset** (ruleset #10): Only exposes null, zero, random, urandom, stdin/stdout/stderr, fd/*, pts/*. Blocks mem, kmem, io, bpf, md.
- **securelevel = 3**: Maximum kernel security level inside jails
- **enforce_statfs = 2**: Hides mount information from jail processes
- **setuid=off**: No setuid binaries in jail datasets
- **Mount path validation**: Defense-in-depth against path traversal in `src/jail/mounts.ts`
- **Blocked host path patterns**: Prevents mounting `.ssh`, `.gnupg`, `.aws`, `.docker`, `/etc/passwd`, `/etc/shadow`, `/root`
- **Per-jail credential proxy tokens**: UUID tokens created on jail startup, revoked on destroy
- **Source IP validation**: Credential proxy only accepts requests from jail subnet

### 3.6 Service Management

- **rc.d service script** at `etc/rc.d/nanoclaw` (installed to `/usr/local/etc/rc.d/nanoclaw`)
- **Uses daemon(8)** for process management with PID file and log output
- **Configurable** via `rc.conf`: `nanoclaw_enable`, `nanoclaw_user`, `nanoclaw_dir`

### 3.7 Setup Automation

- **`scripts/setup-freebsd.sh`**: 10-step idempotent bootstrap script covering: pre-flight checks, package installation, kernel modules (pf, pflog, IP forwarding, RACCT), user/sudoers setup, ZFS datasets, jail template, pf configuration, NanoClaw clone/build, rc.d service
- **`scripts/setup-jail-template.sh`**: Builds/rebuilds jail template with agent-runner dependencies, TypeScript pre-compilation, integrity verification, backup/restore capability

### 3.8 Monitoring

- **/health endpoint**: Checks template snapshot existence, ZFS pool space, pf status
- **/metrics endpoint**: Prometheus-format metrics for active jails, create success/failure counters, epair usage, ZFS available bytes
- **Cleanup audit logging**: Optional file-based audit trail (opt-in via `NANOCLAW_AUDIT_LOG=true`)

### 3.9 Testing

The fork has jail-specific test coverage:

| Test File | Coverage |
|-----------|----------|
| `src/jail-runtime.test.ts` | Jail lifecycle, ZFS operations, mount verification |
| `src/jail-mount-security.test.ts` | Path traversal prevention, blocked paths |
| `src/jail-network-isolation.test.ts` | Restricted networking mode verification |
| `src/jail-stress.test.ts` | Rapid create/destroy stress testing |

### 3.10 Documentation

| Document | Purpose |
|----------|---------|
| `docs/FREEBSD_JAILS.md` | Comprehensive deployment guide (1,267 lines) |
| `docs/LINUX_TO_FREEBSD.md` | Translation guide for Docker/Linux users |
| `docs/TEMPLATE_SETUP.md` | Template build and update procedures |
| `docs/JAIL_PACKAGE_UPDATES.md` | Supply chain security for jail packages |
| `docs/SUDOERS.md` | Detailed sudoers documentation |
| `docs/FREEBSD_JAIL_CLEANUP_PLAN.md` | Cleanup architecture |

---

## 4. FreeBSD-Specific Features That SHOULD Be Implemented

### 4.1 ZFS Snapshots for Session Rollback (HIGH PRIORITY)

**What**: Take ZFS snapshots of group workspaces at key points (before agent execution, on user request) to enable rollback of agent changes.

**Why**: ZFS snapshots are free (copy-on-write), instant, and unique to this platform. Docker has no equivalent without external tooling. This would be a killer feature -- "undo agent changes" with a single command.

**Implementation approach**:
- Snapshot the group's workspace directory before each agent invocation
- Keep N most recent snapshots (configurable, default 3)
- Add an IPC command `rollback_workspace` that reverts to a named snapshot
- Add a container skill `/rollback` that agents can surface to users
- Expose via Prometheus metrics (snapshot count, disk usage)

**Files affected**: New file `src/jail/snapshots.ts`, modifications to `src/jail/runner.ts` and `src/ipc.ts`

### 4.2 DTrace Integration for Agent Observability (MEDIUM PRIORITY)

**What**: Use FreeBSD's DTrace to trace agent execution at the syscall level -- file I/O, network connections, process spawning.

**Why**: DTrace provides zero-cost observability that no other container runtime offers. This enables deep debugging of agent behavior without modifying agent code.

**Implementation approach**:
- Create D scripts in `etc/dtrace/` for common tracing scenarios:
  - `nanoclaw-io.d`: File I/O by jail (what files does the agent read/write?)
  - `nanoclaw-net.d`: Network connections by jail (attempted connections, blocked by pf)
  - `nanoclaw-proc.d`: Process tree inside jails
- Add a container skill `/trace` that enables DTrace for the current jail session
- Add a `/debug` skill enhancement that automatically collects DTrace output on failures
- Expose DTrace data via the metrics endpoint when enabled

**Files affected**: New `etc/dtrace/` directory, new `src/jail/dtrace.ts`, modifications to `src/jail/runner.ts`

### 4.3 Capsicum Sandboxing for Credential Proxy (HIGH PRIORITY)

**What**: Use FreeBSD's Capsicum capability mode to further restrict the credential proxy process.

**Why**: The credential proxy is a security-critical component -- it handles real API keys. Capsicum can restrict it to only the capabilities it needs (network sockets, no file system access beyond what is already open). This provides defense-in-depth beyond process-level isolation.

**Implementation approach**:
- After the proxy HTTP server binds its socket, enter Capsicum capability mode
- Pre-open any files needed (e.g., for logging)
- Restrict file descriptor capabilities to only read/write on the bound socket
- This makes the proxy immune to many classes of exploitation even if compromised

**Files affected**: `src/credential-proxy.ts` (FreeBSD-conditional Capsicum calls via `ffi-napi` or a small native addon)

**Note**: Capsicum requires native code integration (C addon or FFI). This is a non-trivial addition but provides exceptional security.

### 4.4 MAC/IPFW Integration as pf Alternative (LOW PRIORITY)

**What**: Support FreeBSD's mandatory access control (MAC framework) and IPFW as alternatives to pf for network filtering.

**Why**: Some FreeBSD deployments use IPFW instead of pf, and MAC provides label-based security that can complement jail isolation.

**Implementation approach**:
- Abstract firewall rules into a pluggable interface
- Support both pf and IPFW rule generation
- Optionally integrate with `mac_bsdextended` for file-level MAC policies

**Files affected**: New `src/jail/firewall.ts` abstraction, modifications to `src/jail/network.ts`

### 4.5 bhyve Support for Linux Agent Containers (MEDIUM PRIORITY)

**What**: Use FreeBSD's bhyve hypervisor to run the upstream Docker container image directly, providing an alternative to jails when Linux-specific agent capabilities are needed (e.g., Chromium for browser automation).

**Why**: Jails cannot run Linux binaries. Browser automation via `agent-browser` requires Chromium, which is available in FreeBSD's package system but may have rendering differences from the Linux version. bhyve can run a lightweight Linux VM that matches the upstream Docker image exactly.

**Implementation approach**:
- Create a new runtime type `bhyve` alongside `jail` and `docker`
- Use `vm-bhyve` or raw bhyve commands to spawn a micro Linux VM
- Pass through the same mount points via 9pfs/virtio-fs
- Use the existing Docker container image as the VM root filesystem
- Fallback for when jail-native Chromium is insufficient

**Files affected**: New `src/bhyve/` module directory, modifications to `src/container-runtime.ts`

**Note**: This is architecturally similar to Docker Sandboxes (which run Docker inside micro VMs). The overhead is higher than jails but provides exact Linux compatibility.

### 4.6 ZFS Send/Receive for Template Distribution (LOW PRIORITY)

**What**: Enable distributing jail templates as ZFS send streams, so users can share pre-built templates or receive official NanoClaw templates without rebuilding from scratch.

**Why**: The template build process (`setup-jail-template.sh`) takes several minutes and downloads packages from the internet. A pre-built template stream would provide instant deployment.

**Implementation approach**:
- Add `scripts/export-template.sh` that does `zfs send template@base > nanoclaw-template.zfs`
- Add `scripts/import-template.sh` that does `zfs receive template < nanoclaw-template.zfs`
- SHA-256 verification of received streams (template integrity manifest already exists)
- Could be hosted alongside NanoClaw releases

**Files affected**: New scripts in `scripts/`

### 4.7 Jail Resource Monitoring with rctl Accounting (MEDIUM PRIORITY)

**What**: Continuously monitor resource usage inside running jails using `rctl -u` and expose it through the metrics endpoint.

**Why**: Currently, rctl is used only to set limits. Actively monitoring usage enables:
- Alerting when a jail approaches its memory limit
- Historical usage graphs (via Prometheus/Grafana)
- Automatic scaling recommendations

**Implementation approach**:
- Add periodic rctl polling to `src/jail/metrics.ts`
- Export per-jail CPU, memory, and process metrics in Prometheus format
- Add warning-level log messages when thresholds are exceeded

**Files affected**: `src/jail/metrics.ts`, `src/jail/lifecycle.ts`

### 4.8 Jail Persistence Mode (HIGH PRIORITY)

**What**: Option to keep jails alive between agent invocations instead of destroying them after each message, with ZFS snapshots for state management.

**Why**: Currently, jails are created and destroyed per-message (matching Docker's `--rm` pattern). For groups with frequent interactions, this incurs repeated startup costs (even if sub-100ms). A persistent jail would:
- Eliminate startup overhead for active groups
- Preserve in-jail caches (npm, TypeScript compilation artifacts)
- Enable long-running agent sessions
- Still provide isolation via ZFS rollback between sessions

**Implementation approach**:
- Add `NANOCLAW_JAIL_PERSIST=true` environment variable
- Keep jail running after agent completes; re-enter for next message
- Take ZFS snapshot between invocations for rollback capability
- Add idle timeout to destroy persistent jails after inactivity
- Add `/jail-reset` IPC command to force destroy and recreate

**Files affected**: `src/jail/runner.ts`, `src/jail/lifecycle.ts`, `src/jail/config.ts`

---

## 5. Skills That Would Complement the FreeBSD Version

### 5.1 Recommended New Skills

| Skill Name | Type | Description | FreeBSD-Specific |
|------------|------|-------------|------------------|
| `/setup-freebsd` | Operational | Interactive FreeBSD setup that wraps `scripts/setup-freebsd.sh` with Claude guidance. Currently users must run the shell script manually. | Yes |
| `/jail-status` | Container | Show running jail status, ZFS usage, epair state, rctl limits from within an agent session. | Yes |
| `/rollback` | Container | Roll back group workspace to a previous ZFS snapshot. | Yes |
| `/add-chromium` | Feature | Install Chromium in the jail template for agent-browser support. FreeBSD-specific pkg install. | Yes |
| `/migrate-docker-to-jail` | Operational | Guide users migrating from Docker runtime to jail runtime, preserving group data and sessions. | Yes |
| `/add-signal` | Feature | Listed in upstream RFS. Would work identically in jails. | No |
| `/clear` | Utility | Listed in upstream RFS (session compaction). Would work identically in jails. | No |
| `/jail-template-update` | Operational | Interactive template rebuild using blue/green deployment. Wraps `setup-jail-template.sh`. | Yes |
| `/add-monitoring` | Feature | Set up Prometheus + Grafana to consume the /metrics endpoint. | Partially |

### 5.2 Existing Skills Assessment

All 23 host-level skills in `.claude/skills/` are platform-independent (they modify code, not runtime). They should work on FreeBSD without modification. However, two have platform-specific considerations:

- **`/convert-to-apple-container`**: macOS-only, not applicable. Should be clearly documented.
- **`/setup`**: Currently assumes Docker/macOS/Linux. Should detect FreeBSD and redirect to `/setup-freebsd` or `scripts/setup-freebsd.sh`.

### 5.3 Container Skills Gap

The Docker container includes **Chromium** for `agent-browser` (the browser automation container skill). The jail template does **not** include Chromium because:
1. FreeBSD's Chromium package is large (~500MB+)
2. It requires X11/Wayland libraries
3. Browser automation use cases may be less common on server deployments

**Recommendation**: Make Chromium an optional add-on via `/add-chromium` skill that runs `pkg install chromium` inside the jail template and re-snapshots. This keeps the base template lean.

---

## 6. Jail Runtime vs. Docker Runtime: Functional Comparison

### 6.1 Feature Comparison Matrix

| Capability | Docker Runtime | Jail Runtime | Notes |
|------------|---------------|--------------|-------|
| **Agent execution** | Full | Full | Both use `handleAgentProcess()` from `runner-common.ts` |
| **Filesystem isolation** | overlayfs layers | ZFS clones | Jails are faster (instant clone vs. layer assembly) |
| **Network isolation** | Docker bridge/NAT | vnet + epair + pf | Jails provide true network stack isolation |
| **Resource limits** | cgroups | rctl | Equivalent functionality |
| **Startup time** | 1-3 seconds | <100ms | Significant jail advantage |
| **Memory overhead** | ~50-100MB per container | ~0 (shared kernel) | Significant jail advantage |
| **Credential proxy** | Placeholder API key via env | Per-jail UUID tokens | Jails have stronger credential isolation |
| **Browser automation** | Chromium included | Not included by default | Docker advantage; mitigated by `/add-chromium` skill |
| **Session persistence** | Bind mounts for .claude/ | nullfs mounts for .claude/ | Equivalent |
| **Orphan cleanup** | `docker ps --filter` | `jls -N` + ZFS list | Both have automatic cleanup |
| **Monitoring** | Docker stats | /health + /metrics endpoints | Jails have better native monitoring |
| **Cross-platform** | macOS, Linux, Windows (WSL) | FreeBSD only | Docker has broader platform support |
| **Global memory mount** | Yes (read-only for non-main) | Not implemented | **Gap** -- non-main groups do not get global memory mount in jails |
| **.env shadow mount** | `/dev/null` over `.env` | Not implemented | **Gap** -- jail runner does not shadow `.env` from project mount |
| **Agent-runner caching** | Copies to per-group dir, detects staleness | Mounts read-only from source | Different approach; jail approach avoids staleness issues |
| **Build system** | Dockerfile + build.sh | setup-jail-template.sh | Both produce ready-to-run environments |
| **Template updates** | `docker pull` or rebuild | Blue/green ZFS snapshots | Jails have zero-downtime update path |

### 6.2 Identified Gaps in Jail Runtime

1. **Global memory mount for non-main groups**: In the Docker runner (`container-runner.ts` line 93-101), non-main groups get a read-only mount of `groups/global/` at `/workspace/global`. The jail runner (`src/jail/runner.ts`) does not mount the global memory directory. This means non-main group agents in jails cannot read global CLAUDE.md.

2. **.env shadowing**: The Docker runner mounts `/dev/null` over `/workspace/project/.env` to prevent agents from reading secrets. The jail runner does not implement this protection. Since the project root is mounted read-only, the `.env` file is readable but not writable -- but it should be hidden entirely.

3. **Host UID mapping**: The Docker runner maps the host user's UID into the container (line 273-278). The jail runner always runs as `node` (uid 1000). This could cause file ownership mismatches on shared mounts.

---

## 7. Upstream Sync Recommendations

### 7.1 High-Priority Syncs

These upstream changes should be synced as soon as possible:

1. **Per-group trigger patterns** (`0015931`): Important usability feature.
2. **Timezone validation** (`11847a1`): Safety fix that prevents crashes.
3. **CLAUDE.md template on group registration** (`4e3189d`, `5a12ddd`): Prevents empty group folders.

### 7.2 Medium-Priority Syncs

4. **Agent-runner source cache refresh** (`d05a8de`): Not critical for jails since they mount the source read-only, but aligns with upstream expectations.
5. **Claw CLI skill** (`1846929`): Useful Python CLI for managing NanoClaw from terminal. Platform-independent.

### 7.3 Do Not Sync

6. **OneCLI gateway** (`e936961`): The fork's native credential proxy with per-jail tokens is architecturally superior for jail isolation. OneCLI would remove this security layer.
7. **PostHog diagnostics** (`f04a895`): Privacy consideration. Opt-in telemetry may not align with the FreeBSD user base's preferences.
8. **macOS status bar** (`e4f15b6`): Platform-irrelevant.
9. **loginctl linger fix** (`aeabfcc`): systemd-specific. FreeBSD uses rc.d.

### 7.4 Open Ticket

Only 1 ticket remains open: `src-e9mq` (submit upstream PR). This is manual-only per CLAUDE.md policy. All other 109 tickets are closed.

---

## 8. Strategic Recommendations

### 8.1 Short-Term (Next 2 Weeks)

1. **Fix the two identified jail runtime gaps**: Add global memory mount for non-main groups and .env shadowing in `src/jail/runner.ts`. These are small changes (10-15 lines each) with high security impact.

2. **Sync the 3 high-priority upstream changes**: Per-group triggers, timezone validation, CLAUDE.md template. Estimated effort: 2-3 hours.

3. **Add `/setup-freebsd` operational skill**: Wrap the existing `scripts/setup-freebsd.sh` in a Claude Code skill so FreeBSD users get the same guided experience as Docker users with `/setup`. Estimated effort: 1-2 hours.

### 8.2 Medium-Term (Next 1-2 Months)

4. **Implement ZFS snapshot-based session rollback** (section 4.1): This is the single most differentiating feature possible. No other NanoClaw runtime can offer "undo agent changes" with zero-cost snapshots.

5. **Implement jail persistence mode** (section 4.8): Eliminates the create/destroy overhead for active groups and enables persistent caching.

6. **Add Chromium as optional jail template addon**: Create the `/add-chromium` skill and document the browser automation workflow on FreeBSD.

7. **Implement rctl resource monitoring** (section 4.7): Low effort, high value for production monitoring.

### 8.3 Long-Term (Next 3-6 Months)

8. **DTrace integration** (section 4.2): Unique observability that no other platform offers. Requires DTrace scripting expertise.

9. **Capsicum sandboxing for credential proxy** (section 4.3): Requires native code integration but provides exceptional security.

10. **bhyve runtime option** (section 4.5): For use cases requiring exact Linux compatibility (Chromium rendering, Linux-only tools).

11. **ZFS send/receive for template distribution** (section 4.6): Enables pre-built template sharing.

### 8.4 Competitive Positioning

NanoClaw-BSD should position itself as the **most secure and performant** NanoClaw deployment option:

- **Security**: jail(8) with 25+ years of hardening > Docker namespaces; Capsicum > cgroups; pf with pinned IPs > Docker bridge; per-jail credential tokens > shared proxy
- **Performance**: <100ms jail startup vs 1-3s Docker; zero memory overhead vs 50-100MB; ZFS COW clones vs overlayfs layers
- **Observability**: Native DTrace tracing; Prometheus metrics endpoint; rctl resource monitoring
- **Reliability**: ZFS snapshot rollback; blue/green template updates; crash-recovery epair state persistence

The FreeBSD version sacrifices cross-platform compatibility for these advantages. This is the correct trade-off for users who run FreeBSD as their primary server platform.

---

## 9. Key File References

| Path | Relevance |
|------|-----------|
| `/home/jims/code/nanoclaw/src/src/jail/lifecycle.ts` | Core jail create/stop/destroy logic |
| `/home/jims/code/nanoclaw/src/src/jail/runner.ts` | Jail agent runner (has identified gaps) |
| `/home/jims/code/nanoclaw/src/src/jail/network.ts` | vnet/epair/pf integration |
| `/home/jims/code/nanoclaw/src/src/jail/config.ts` | All configurable parameters |
| `/home/jims/code/nanoclaw/src/src/jail/metrics.ts` | Health and Prometheus metrics |
| `/home/jims/code/nanoclaw/src/src/container-runner.ts` | Docker runner + jail dispatch (lines 323-336) |
| `/home/jims/code/nanoclaw/src/src/container-runtime.ts` | Runtime detection, proxy bind host |
| `/home/jims/code/nanoclaw/src/src/credential-proxy.ts` | Credential proxy with jail hardening |
| `/home/jims/code/nanoclaw/src/src/runner-common.ts` | Shared agent process handling |
| `/home/jims/code/nanoclaw/src/etc/pf-nanoclaw.conf` | Standalone pf firewall rules |
| `/home/jims/code/nanoclaw/src/etc/pf-nanoclaw-anchor.conf` | Anchor-mode pf rules |
| `/home/jims/code/nanoclaw/src/etc/rc.d/nanoclaw` | FreeBSD service script |
| `/home/jims/code/nanoclaw/src/scripts/setup-freebsd.sh` | FreeBSD bootstrap (900 lines) |
| `/home/jims/code/nanoclaw/src/scripts/setup-jail-template.sh` | Template builder (417 lines) |
| `/home/jims/code/nanoclaw/src/docs/FREEBSD_JAILS.md` | Comprehensive deployment guide |
| `/home/jims/code/nanoclaw/src/container/Dockerfile` | Docker container definition (for comparison) |

---

*Report generated from analysis of NanoClaw-BSD codebase at commit `6122b16` on branch `main`, compared against `upstream/main` at commit `87c3640`.*
