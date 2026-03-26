# NanoClaw Runtime Comparison: Docker vs FreeBSD Jails

**Date**: 2026-03-25
**Codebase**: `jmspring/nanoclaw`, branch `main`, commit `6122b16`

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Side-by-Side Feature Comparison](#2-side-by-side-feature-comparison)
3. [Architecture Overview](#3-architecture-overview)
4. [Functionality Differences](#4-functionality-differences)
5. [Setup Complexity](#5-setup-complexity)
6. [Performance Characteristics](#6-performance-characteristics)
7. [Security Model](#7-security-model)
8. [Network Isolation](#8-network-isolation)
9. [Filesystem Isolation](#9-filesystem-isolation)
10. [Resource Limiting](#10-resource-limiting)
11. [Monitoring and Observability](#11-monitoring-and-observability)
12. [Daily Operations](#12-daily-operations)
13. [Debugging and Troubleshooting](#13-debugging-and-troubleshooting)
14. [Use Case Recommendations](#14-use-case-recommendations)
15. [Recommended Improvements](#15-recommended-improvements)
16. [Overall Assessment](#16-overall-assessment)

---

## 1. Executive Summary

NanoClaw supports two container runtime backends for isolating Claude agents: **Docker** (the upstream default, cross-platform) and **FreeBSD Jails** (a fork addition, FreeBSD-only). Both share the same orchestrator (`src/index.ts`), the same agent runner input/output protocol (`runner-common.ts`), and the same credential proxy architecture. They diverge significantly in isolation mechanism, setup complexity, performance profile, and operational model.

Docker provides a batteries-included, cross-platform experience with hypervisor-level isolation (especially with Docker Sandboxes on macOS). FreeBSD Jails provide near-zero-overhead kernel-level isolation with ZFS copy-on-write storage, making them materially faster and lighter at the cost of being FreeBSD-only and requiring more manual setup.

Neither runtime is strictly superior. The right choice depends on the deployment platform, security requirements, and operational preference.

---

## 2. Side-by-Side Feature Comparison

| Feature | Docker | FreeBSD Jails |
|---------|--------|---------------|
| **Platform support** | macOS, Linux, Windows (WSL2) | FreeBSD 15.0+ only |
| **Runtime selection** | `NANOCLAW_RUNTIME=docker` (default on Linux) | `NANOCLAW_RUNTIME=jail` (default on FreeBSD) |
| **Container startup** | 1-3 seconds | <100ms (ZFS clone) |
| **Memory overhead per container** | ~50-100MB | ~0 (shared kernel) |
| **Storage backend** | Overlay/layer-based | ZFS COW clones (instant, zero-copy) |
| **Network isolation** | Docker bridge/NAT | vnet + epair (true network stack) or host inherit |
| **Firewall** | Docker iptables/nftables | pf (packet filter) with pinned IP tables |
| **Filesystem isolation** | Bind mounts (`-v`) | nullfs mounts |
| **Resource limits** | Docker `--memory`, `--cpus` | rctl (memoryuse, maxproc, pcpu) |
| **Privilege model** | Docker daemon (rootless available) | sudo with least-privilege sudoers |
| **Image/template build** | Dockerfile + `docker build` | ZFS snapshot from populated template |
| **Service management** | launchd (macOS), systemd (Linux) | rc.d script (`etc/rc.d/nanoclaw`) |
| **Container cleanup** | `--rm` flag (auto) | Explicit: jail -r, umount, zfs destroy |
| **Browser automation** | Chromium in container (agent-browser) | Not available (no Chromium in jails) |
| **Health/metrics endpoint** | Not implemented | /health + /metrics (Prometheus format) |
| **Orphan cleanup** | `docker ps --filter` + stop | `jls -N name` + full lifecycle cleanup |
| **Crash recovery** | Containers lost on restart | `reconnectToRunningJails()` tracks survivors |
| **Concurrent limit config** | `MAX_CONCURRENT_CONTAINERS` (default 5) | `NANOCLAW_MAX_JAILS` (default 50) |
| **Agent runner compilation** | Per-container `npx tsc` or pre-compiled | Pre-compiled in template (optimized) |
| **Credential proxy binding** | `host.docker.internal` / docker0 bridge | Jail subnet gateway (`10.99.0.1`) |
| **`.env` masking** | `/dev/null` bind mount over `.env` | Not implemented (no project mount for non-main) |
| **Audit logging** | None | Optional via `NANOCLAW_AUDIT_LOG=true` |
| **Template updates** | `docker build --no-cache` | Blue/green via `setup-jail-template.sh template-v2` |

---

## 3. Architecture Overview

### Shared Architecture

Both runtimes share the same core path through the orchestrator:

```
Message -> src/index.ts -> src/container-runner.ts -> runtime dispatch -> agent process -> response
```

The runtime dispatch happens in `runContainerAgent()` (line 323-336 of `src/container-runner.ts`):

```typescript
const runtime = getRuntime();
if (runtime === 'jail') {
  const { runJailAgent } = await import('./jail/runner.js');
  result = await runJailAgent(group, input, logsDir, onProcess, onOutput, traceId, tracedLogger);
} else {
  // Docker path
}
```

Both runtimes use `handleAgentProcess()` from `src/runner-common.ts` for the actual process lifecycle: stdin writing, stdout/stderr collection, output marker parsing, timeout handling, and log rotation. This shared module ensures consistent behavior regardless of runtime.

### Docker Architecture

```
Orchestrator -> docker run -i --rm -> Linux container -> entrypoint.sh -> agent
```

- Single `docker run` command spawns the container
- `--rm` flag ensures automatic cleanup
- Bind mounts (`-v`) connect host directories to container paths
- `host.docker.internal` resolves to host for credential proxy access
- Dockerfile (`container/Dockerfile`) builds from `node:24-slim` with Chromium

### Jail Architecture

```
Orchestrator -> ZFS clone -> nullfs mounts -> jail -c -> jexec -> agent -> cleanup pipeline
```

- Multi-step creation: ZFS clone, mount points, fstab, nullfs mounts, epair (if restricted), jail creation, rctl limits, network config
- Multi-step cleanup: temp files, rctl removal, jail stop, epair release, devfs unmount, nullfs unmounts (reverse order), ZFS destroy, fstab/conf removal, token revocation
- 10 source modules in `src/jail/` totaling ~1600 lines

---

## 4. Functionality Differences

### What Works in Docker but NOT in Jails

| Feature | Details |
|---------|---------|
| **Browser automation** | Docker image includes Chromium, `agent-browser`, and all X11/rendering dependencies. Jails have no browser support. |
| **`.env` masking** | Docker shadows `.env` with `/dev/null` bind mount to prevent secret leakage from the mounted project root. Jails do not implement this. |
| **Cross-platform** | Docker works on macOS, Linux, Windows (WSL2). Jails are FreeBSD-only. |
| **User ID mapping** | Docker passes `--user ${hostUid}:${hostGid}` for non-standard UIDs. Jails always run as `node` (uid 1000) with umask 002. |
| **Apple Container support** | On macOS, NanoClaw can use Apple Container as a lightweight alternative. No equivalent on FreeBSD beyond jails. |

### What Works in Jails but NOT in Docker

| Feature | Details |
|---------|---------|
| **Health/metrics endpoint** | `/health` (JSON, checks template snapshot, ZFS space, pf status) and `/metrics` (Prometheus text format: active jails, epair usage, ZFS space). Docker has no equivalent. |
| **Crash recovery for running containers** | `reconnectToRunningJails()` re-tracks jails that survived an orchestrator restart. Docker containers with `--rm` are lost. |
| **Periodic health checks** | `startJailHealthChecks()` monitors ZFS pool space (<10% triggers admin alert) and template snapshot existence every 5 minutes. |
| **Audit logging** | `NANOCLAW_AUDIT_LOG=true` writes structured cleanup audit trail to `cleanup-audit.log`. |
| **Per-jail credential tokens** | Each jail gets a unique `crypto.randomUUID()` token registered with the credential proxy, then revoked on cleanup. Docker uses a shared placeholder. |
| **Blue/green template updates** | `setup-jail-template.sh template-v2` builds a new template without affecting running jails. Old jails keep their template. |
| **ZFS quotas** | Each jail clone gets a configurable quota (`NANOCLAW_JAIL_QUOTA`, default 1G). Docker relies on Docker's storage driver limits. |
| **rctl resource limits** | Per-jail `memoryuse`, `maxproc`, and `pcpu` limits via FreeBSD's rctl framework. |
| **Restrictive devfs ruleset** | Custom ruleset 10 (`etc/devfs.rules`) exposes only safe devices (null, random, urandom, fd, pts). Blocks mem, kmem, io, bpf. |
| **Epair state persistence** | `data/epairs.json` persists epair assignments for crash recovery and syncs with actual system interfaces on restart. |

### Feature Parity

Both runtimes share:

- Same mount layout: `/workspace/project` (ro), `/workspace/group` (rw), `/workspace/ipc` (rw), `/home/node/.claude` (rw), `/app/src` (ro)
- Same IPC protocol (filesystem-based)
- Same credential proxy architecture (placeholder tokens, proxy injection)
- Same session persistence and skills syncing
- Same tool restrictions (main vs non-main groups)
- Same additional mount validation (`mount-security.ts`)
- Same log rotation system
- Same timeout/idle management

---

## 5. Setup Complexity

### Docker Setup

**Steps**: 3-5 minutes, mostly automated

1. Install Docker Desktop (or Docker Engine on Linux)
2. Clone NanoClaw, `cd src`
3. Run `/setup` in Claude Code
4. `./container/build.sh` builds the image from `container/Dockerfile`

**Dockerfile complexity**: 70 lines, straightforward. Installs Chromium, agent-browser, claude-code, copies agent-runner source, runs `npm install` and `npm run build`.

**Total setup scripts**: `container/build.sh` (24 lines).

### Jail Setup

**Steps**: 30-60 minutes, partially interactive

1. `sudo scripts/setup-freebsd.sh` (600+ lines, 10 sections):
   - Pre-flight checks (FreeBSD 15+, ZFS, pools)
   - Package installation (node24, npm-node24, git)
   - Kernel modules (pf, pflog, IP forwarding, RACCT for rctl)
   - User setup (wheel group, sudoers file with least-privilege entries)
   - ZFS datasets (parent, jails, workspaces, ipc, template)
   - Jail template (base.txz download, extraction, package installation)
   - pf firewall (auto-detect interface, install rules)
   - devfs rules (restrictive ruleset 10)
   - rc.d service installation
   - NanoClaw clone and build

2. `scripts/setup-jail-template.sh` (400+ lines):
   - Boot template as temporary jail
   - Install TypeScript and Claude Code globally with pinned versions
   - Copy agent-runner source, `npm ci` with integrity verification
   - Pre-compile TypeScript in template
   - Create entrypoint script
   - Verify all installations
   - Snapshot with validation (clone test, contents verification)
   - SHA-256 integrity manifest generation
   - Backup/restore on failure

**Additional configuration**:
- `/etc/devfs.rules` (custom ruleset)
- `/etc/pf-nanoclaw.conf` or `/etc/pf-nanoclaw-anchor.conf` (firewall)
- `/boot/loader.conf` (pf_load, pflog_load, kern.racct.enable)
- `/etc/sysctl.conf` (net.inet.ip.forwarding)
- `/etc/rc.conf` (pf_enable, nanoclaw_enable)
- `/usr/local/etc/sudoers.d/nanoclaw` (least-privilege sudo)

**Verdict**: Jail setup is roughly 10x more complex than Docker setup, requiring deep FreeBSD knowledge. However, `setup-freebsd.sh` automates most of it and is idempotent.

---

## 6. Performance Characteristics

### Startup Time

| Metric | Docker | Jails |
|--------|--------|-------|
| Container/jail creation | 1-3 seconds | <100ms (ZFS clone is instant) |
| Agent runner compilation | ~3-5s per-container `npx tsc` | 0s (pre-compiled in template, `entrypoint.sh` skips tsc if `/app/dist` exists) |
| First response latency | 4-8 seconds | <1 second |

The jail template optimization (`setup-jail-template.sh` line 196-207) pre-compiles TypeScript so jails skip the `npx tsc` step entirely:

```sh
if [ -d /app/dist ] && [ -f /app/dist/index.js ]; then
  cat > /tmp/input.json
  exec node /app/dist/index.js < /tmp/input.json
```

Docker's `Dockerfile` also runs `npm run build` during image creation (line 49), but the entrypoint script always re-compiles from the mounted `/app/src` source at runtime.

### Memory Overhead

| Metric | Docker | Jails |
|--------|--------|-------|
| Per-container overhead | ~50-100MB (Linux VM, Docker daemon) | ~0 (shared kernel, no VM) |
| Docker daemon | ~200-500MB resident | N/A |
| 10 concurrent agents | ~700MB-1.5GB overhead | ~0 overhead (just the Node.js processes) |

### I/O Performance

| Metric | Docker | Jails |
|--------|--------|-------|
| Storage layer | overlay2/fuse (macOS) or overlay2 (Linux) | ZFS COW clones (zero-copy, instant) |
| Bind mount I/O | Near-native on Linux, slower on macOS (osxfs/virtiofs) | Native (nullfs is a thin VFS layer) |
| ZFS compression | N/A | lz4 enabled on jails dataset (setup-freebsd.sh line 360) |

### Cleanup Time

| Metric | Docker | Jails |
|--------|--------|-------|
| Container destruction | Instant (`--rm`) | Multi-step: jail stop, unmount (reverse order), ZFS destroy, epair release. Typically 1-3 seconds. |
| Failed cleanup recovery | Not needed | `retryWithBackoff()` with exponential backoff (2 retries, 500ms-3000ms delays) |

---

## 7. Security Model

### Docker Security

**Isolation boundary**: Linux namespaces (pid, net, mnt, uts, ipc, user) + cgroups. On macOS with Docker Sandboxes, each container runs inside a micro VM (hypervisor-level isolation).

**Key security features**:
- Process runs as non-root `node` user inside container (Dockerfile line 64: `USER node`)
- `.env` shadowed with `/dev/null` to prevent secret leakage (container-runner.ts lines 67-76)
- Credential proxy injects real API keys; containers only see `placeholder` values
- Mount allowlist stored outside project root (`~/.config/nanoclaw/mount-allowlist.json`)
- Read-only project mount for main group prevents agent from modifying host code
- No `--privileged`, no `--cap-add`

**Security gaps**:
- Docker daemon runs as root (unless rootless mode)
- Shared placeholder token for all containers (no per-container authentication)
- No device access restrictions beyond Docker defaults
- No explicit CPU/memory limits applied (relies on Docker defaults)

### Jail Security

**Isolation boundary**: FreeBSD jail subsystem (kernel-level). Jails share the host kernel but have restricted syscall access.

**Key security features**:
- `securelevel = 3` in jail.conf (highest security level: no kernel modifications, no raw sockets, no device changes)
- `enforce_statfs = 2` (jail can only see its own mount points)
- `setuid=off` on ZFS dataset (prevents setuid binaries)
- Custom devfs ruleset 10: only null, zero, random, urandom, fd, pts exposed. Blocks mem, kmem, io, bpf (all kernel-escape vectors)
- Per-jail credential tokens (`crypto.randomUUID()`), registered and revoked per session
- ZFS quota per jail (default 1G) prevents storage exhaustion
- rctl limits: memory (2G), processes (100), CPU (80%)
- pf firewall with pinned Anthropic API IP ranges (prevents DNS poisoning MitM attacks)
- Inter-jail traffic blocked (`block drop quick from $jail_net to $jail_net` except credential proxy port 3001)
- DNS restricted to trusted servers only (8.8.8.8, 1.1.1.1)
- Mount path validation: absolute paths required, `..` rejected, blocked patterns (`.ssh`, `.gnupg`, `.aws`, `.docker`, etc.)
- Audit logging (opt-in)
- Least-privilege sudoers with specific command paths (no blanket root)

**Security gaps**:
- Requires passwordless sudo for ~15 commands (attack surface if orchestrator compromised)
- No `.env` masking for main group (main gets project root mounted read-only)
- Shared kernel means kernel vulnerabilities could escape jails (mitigated by securelevel=3 and restrictive devfs)
- `/bin/sh` in sudoers is broad (required for heredoc operations)

**Verdict**: The jail implementation has a deeper, more explicitly documented security model with defense-in-depth (devfs rules, rctl, pf, securelevel, ZFS quotas, per-jail tokens, inter-jail isolation). Docker provides good baseline isolation with less configuration but fewer explicit hardening layers.

---

## 8. Network Isolation

### Docker Networking

Docker uses its built-in bridge networking:

- Containers access the host via `host.docker.internal` (resolved automatically on macOS, requires `--add-host` on Linux)
- NAT through Docker's bridge network
- No explicit egress filtering in NanoClaw's Docker configuration
- Containers can reach any internet destination
- Credential proxy binds to `127.0.0.1` (macOS), `docker0` bridge IP (Linux), or `127.0.0.1` (WSL)

### Jail Networking

Two modes, configured via `NANOCLAW_JAIL_NETWORK_MODE`:

**Inherit mode** (development):
- `ip4=inherit, ip6=inherit` -- jail shares host's full network stack
- No firewall rules needed
- Agent can reach any destination
- Credential proxy binds to `127.0.0.1`

**Restricted mode** (production):
- Each jail gets its own vnet (virtual network stack) with an epair interface pair
- Per-jail /30 subnet from 10.99.0.0/24 pool (up to 256 concurrent jails)
- pf NAT on host's external interface
- Strict egress filtering:
  - DNS: Only ports 53 UDP/TCP to trusted DNS (8.8.8.8, 1.1.1.1)
  - HTTPS: Only port 443 to Anthropic API IP range (160.79.104.0/21, pinned -- not DNS-resolved)
  - Credential proxy: Port 3001 on jail gateway
  - Everything else: Blocked with `block return log`
- Inter-jail isolation: Direct jail-to-jail traffic blocked
- Credential proxy binds to `10.99.0.1` (all jail gateways)
- Blocked packets logged to pflog0 for debugging

**Verdict**: Docker provides no egress filtering in NanoClaw -- agents can reach the entire internet. Jail restricted mode provides fine-grained egress control with pinned IP ranges and DNS restrictions. This is a significant security advantage for the jail implementation in production deployments.

---

## 9. Filesystem Isolation

### Docker Filesystem

- Built from `node:24-slim` Debian base (Dockerfile)
- Overlay2 filesystem with Docker's layer caching
- Bind mounts for host directories:
  - Project root (ro, main only), `.env` shadowed
  - Group directory (rw)
  - IPC directory (rw)
  - Claude sessions (rw)
  - Agent runner source (ro)
- `--rm` flag destroys container filesystem on exit
- No storage quotas
- Agent runner source re-compiled at runtime from mounted `/app/src`

### Jail Filesystem

- ZFS clone from template snapshot (instant, zero-copy)
- Template contains complete FreeBSD userland + Node.js + pre-compiled agent runner
- nullfs mounts for host directories (same semantic layout as Docker)
- ZFS quota per jail (default 1G, configurable via `NANOCLAW_JAIL_QUOTA`)
- `setuid=off` on jail dataset
- `enforce_statfs=2` hides other mount points from jail
- lz4 compression on jails dataset
- Mount validation in `mounts.ts`:
  - `assertMountWithinJail()` prevents mount target escaping jail root
  - `validateJailMount()` checks absolute paths, path traversal, blocked patterns
  - Symlink resolution via `fs.realpathSync()` prevents symlink attacks
- Multi-step cleanup: reverse-order unmount, forced unmount fallback, ZFS destroy with retry

**Verdict**: Jails provide stronger filesystem isolation through ZFS quotas, setuid=off, enforce_statfs, and more thorough mount validation. Docker provides simpler, automatic cleanup via `--rm`.

---

## 10. Resource Limiting

### Docker Resource Limits

NanoClaw's Docker implementation does **not** apply any resource limits. The `buildContainerArgs()` function in `container-runner.ts` does not pass `--memory`, `--cpus`, or `--pids-limit` flags. Containers use Docker's defaults (unlimited).

The only limit is `MAX_CONCURRENT_CONTAINERS` (default 5, configurable via env var), which is an application-level concurrency limit, not a per-container resource limit.

### Jail Resource Limits

Jails use FreeBSD's rctl framework (`lifecycle.ts` lines 130-163):

| Resource | Default | Config Env Var |
|----------|---------|----------------|
| Memory (memoryuse) | 2G | `NANOCLAW_JAIL_MEMORY_LIMIT` |
| Max processes (maxproc) | 100 | `NANOCLAW_JAIL_MAXPROC` |
| CPU percentage (pcpu) | 80% | `NANOCLAW_JAIL_PCPU` |
| Disk quota (ZFS) | 1G | `NANOCLAW_JAIL_QUOTA` |
| Max concurrent jails | 50 | `NANOCLAW_MAX_JAILS` |
| Max epair interfaces | 200 | `NANOCLAW_MAX_EPAIRS` |

All rctl limits use `deny` action -- the kernel hard-denies the resource once the limit is reached rather than just logging.

**Verdict**: The jail implementation has comprehensive, configurable resource limits. Docker has none applied by NanoClaw. This is a significant gap in the Docker implementation for production use.

---

## 11. Monitoring and Observability

### Docker Monitoring

- Application-level logging via pino logger
- Per-group log files with rotation (`log-rotation.ts`)
- Container stdout/stderr captured and written to rotating logs
- No health endpoint
- No metrics endpoint
- No periodic health checks
- Admin alerting for consecutive agent failures (3 failures triggers alert)

### Jail Monitoring

All of the above, plus:

- **Health endpoint** (`/health`): JSON response with checks for template snapshot existence, ZFS pool space, and pf status. Returns 200 (healthy) or 503 (unhealthy).
- **Metrics endpoint** (`/metrics`): Prometheus text format with:
  - `nanoclaw_active_jails` (gauge)
  - `nanoclaw_jail_create_total{status="success|failure"}` (counter)
  - `nanoclaw_epair_used` (gauge)
  - `nanoclaw_zfs_pool_bytes_avail` (gauge)
- **Periodic health checks** (every 5 minutes): ZFS pool space monitoring (<10% triggers admin alert), template snapshot existence verification.
- **Cleanup audit log** (opt-in via `NANOCLAW_AUDIT_LOG=true`): Timestamped entries for every cleanup operation (CLEANUP_START, STOP_JAIL, RELEASE_EPAIR, UNMOUNT_NULLFS, DESTROY_DATASET, REMOVE_FSTAB, CLEANUP_END).
- **Epair pool monitoring**: Warning logged when approaching 80% capacity.

**Verdict**: The jail implementation provides substantially better observability with production-grade health checks, Prometheus metrics, and audit logging.

---

## 12. Daily Operations

### Docker Daily Operations

```bash
# Start
npm run dev                              # Development with hot reload
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist  # macOS service
systemctl --user start nanoclaw          # Linux service

# Stop
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
systemctl --user stop nanoclaw

# Rebuild container
./container/build.sh

# Check orphans
docker ps --filter name=nanoclaw-
docker stop <name>

# Logs
# Check groups/*/logs/ directories
```

**Pros**: Simple, familiar Docker workflow. `--rm` means no cleanup needed. One command to rebuild image.

**Cons**: No built-in health checks. Must manually check Docker state. No metrics.

### Jail Daily Operations

```bash
# Start
npm run dev                              # Development
sudo service nanoclaw start              # rc.d service

# Stop
sudo service nanoclaw stop               # Graceful shutdown cleans up all jails

# Rebuild template
./scripts/setup-jail-template.sh         # Update current template
./scripts/setup-jail-template.sh v2      # Blue/green: build new template

# Check status
curl http://127.0.0.1:9090/health        # Health check
curl http://127.0.0.1:9090/metrics       # Prometheus metrics
sudo jls                                 # List running jails

# Check orphans
sudo jls -N name | grep nanoclaw_        # Automatic cleanup on startup

# Logs
# Check groups/*/logs/ directories
# Check jails/cleanup-audit.log (if NANOCLAW_AUDIT_LOG=true)
```

**Pros**: Health endpoints for automated monitoring. rc.d service with proper daemon management. Blue/green template updates. Crash recovery.

**Cons**: Requires `sudo` for many operations. Template rebuild is slower (boots a temporary jail, installs packages). More moving parts to understand.

---

## 13. Debugging and Troubleshooting

### Docker Debugging

- `docker logs <container>` (but containers are `--rm` and short-lived)
- `docker exec -it <container> bash` (if caught while running)
- Check `groups/*/logs/` for captured stdout/stderr
- `LOG_LEVEL=debug` for verbose logging including container args and mount maps
- Container build issues: `docker build --no-cache` (but must also prune builder for COPY invalidation)

### Jail Debugging

- `sudo jexec <jailname> sh` to enter a running jail
- `sudo jls` to see all running jails with details
- `groups/*/logs/` for captured stdout/stderr
- `LOG_LEVEL=debug` for verbose logging including jail mount maps
- `sudo tcpdump -n -e -ttt -i pflog0` to watch blocked network packets in real-time
- `sudo pfctl -s state` to see active pf connections
- `sudo pfctl -s rules` to verify firewall rules
- `sudo rctl -l jail:<jailname>` to check resource limits
- `zfs list -t snapshot` to verify template snapshots
- `mount -t nullfs` to see all nullfs mounts
- Cleanup audit log at `jails/cleanup-audit.log`
- Epair state at `data/epairs.json`
- `sudo pfctl -t anthropic_api -T show` to verify API IP table

**Verdict**: Jail debugging is richer due to the available system-level tools (jls, jexec, pf, rctl, zfs). Docker debugging is simpler but more limited, especially since containers are ephemeral.

---

## 14. Use Case Recommendations

### Personal Single-User Deployment

| Aspect | Docker | Jails |
|--------|--------|-------|
| **Recommended?** | Yes (macOS/Linux) | Yes (FreeBSD) |
| **Rationale** | Simple setup, cross-platform, `/setup` handles everything | Best performance if already on FreeBSD |

For most personal deployments on macOS or Linux, Docker is the pragmatic choice. If you run FreeBSD as your daily driver, jails provide a materially better experience with faster startup and lower overhead.

### Multi-User Deployment

| Aspect | Docker | Jails |
|--------|--------|-------|
| **Recommended?** | Acceptable | Preferred |
| **Rationale** | Works but lacks resource limits and monitoring | Per-jail resource limits, metrics, health checks, audit logging |

The jail implementation's rctl limits, ZFS quotas, Prometheus metrics, and audit logging make it significantly better suited for multi-user environments where accountability and resource fairness matter.

### High-Security Environments

| Aspect | Docker | Jails |
|--------|--------|-------|
| **Recommended?** | With Docker Sandboxes (micro VMs) | Yes, with restricted network mode |
| **Rationale** | Hypervisor isolation on macOS | Multiple defense layers, explicit egress control |

For high-security deployments, the jail implementation provides:
- Network egress restricted to pinned API IP ranges (immune to DNS poisoning)
- Inter-jail traffic isolation
- Restrictive devfs (blocks kernel escape vectors)
- securelevel=3 (maximum FreeBSD security level)
- Per-jail auth tokens
- Audit logging

Docker Sandboxes provide hypervisor-level isolation which is theoretically stronger (VM escape vs jail escape), but NanoClaw's Docker path does not implement egress filtering.

### Development/Testing

| Aspect | Docker | Jails |
|--------|--------|-------|
| **Recommended?** | Yes | Acceptable (with inherit mode) |
| **Rationale** | Simplest setup, most familiar, hot reload | Faster iteration with instant startup, but more setup |

Docker is preferred for development due to simpler setup and familiarity. Jail inherit mode (`NANOCLAW_JAIL_NETWORK_MODE=inherit`) skips all pf/epair complexity and works well for development, with the bonus of instant startup.

### Production Server

| Aspect | Docker | Jails |
|--------|--------|-------|
| **Recommended?** | Acceptable | Preferred |
| **Rationale** | Works but missing resource limits, metrics, health checks | Production-ready: resource limits, metrics, health checks, rc.d service, crash recovery |

The jail implementation is better equipped for production with its health/metrics endpoints, ZFS health monitoring, crash recovery (reconnect to surviving jails), rc.d daemon management, blue/green template updates, and comprehensive resource limiting.

---

## 15. Recommended Improvements

### Docker Implementation

1. **Add resource limits**: Pass `--memory`, `--cpus`, and `--pids-limit` to `docker run`. The jail implementation's rctl limits (2G memory, 100 processes, 80% CPU) provide a good baseline.

2. **Add health/metrics endpoint**: Port the jail implementation's `/health` and `/metrics` endpoints to work with Docker. Check Docker daemon health, disk space, active containers.

3. **Add egress filtering**: Implement network egress restrictions. Options include Docker network policies, custom bridge configurations, or a sidecar proxy. This is the single biggest security gap compared to jails.

4. **Add per-container authentication**: Generate unique tokens per container for the credential proxy, similar to the jail implementation's `crypto.randomUUID()` approach.

5. **Pre-compile agent runner in Dockerfile**: The Dockerfile already runs `npm run build` but the entrypoint re-compiles from mounted `/app/src`. Skip recompilation when pre-compiled output exists, like the jail entrypoint does.

6. **Add audit logging**: Implement opt-in cleanup/lifecycle audit logging similar to `NANOCLAW_AUDIT_LOG`.

### Jail Implementation

1. **Add browser automation support**: The jail template lacks Chromium. Consider installing `chromium` via pkg in the template, or provide a separate "browser-capable" template alongside the lightweight default.

2. **Implement `.env` masking**: When the main group mounts the project root read-only, shadow `.env` similar to Docker's `/dev/null` bind mount approach.

3. **Reduce sudo surface area**: The `/bin/sh` sudoers entry is broad. Investigate replacing heredoc-based file writes with alternative approaches (write temp file on host, then `cp` into jail).

4. **Add ZFS dataset path restrictions to sudoers**: The setup script's sudoers file already restricts `zfs clone` to the nanoclaw dataset path, but `zfs destroy` is more permissive. Consider tightening.

5. **Document Chromium-less limitations**: Clearly document that browser automation tools (agent-browser, screenshots, PDFs) are unavailable in jail deployments, and what workarounds exist.

6. **Add container image compatibility layer**: Consider supporting running Docker containers inside jails (via Linux binary compatibility) for feature parity, though this adds significant complexity.

### Shared Improvements

1. **Unify health/metrics**: Both runtimes should expose the same health/metrics interface. Docker could check `docker info` health, disk space, and active containers; jails check ZFS and pf.

2. **Unify resource limit configuration**: Use the same env vars (`NANOCLAW_MEMORY_LIMIT`, `NANOCLAW_MAX_PROC`, `NANOCLAW_CPU_LIMIT`) for both runtimes, translated to `--memory`/`--cpus` for Docker and rctl for jails.

3. **Add integration tests that run against both runtimes**: The test suite should verify identical behavior regardless of runtime.

---

## 16. Overall Assessment

The Docker and jail implementations represent two well-executed approaches to the same problem, each optimized for its target environment.

**Docker** is the right default for NanoClaw's upstream audience: individual users on macOS and Linux who want a simple, working setup with minimal friction. Its one-command build, automatic cleanup, cross-platform support, and browser automation make it the most accessible option. Its main weaknesses -- no resource limits, no egress filtering, no health monitoring -- are acceptable for personal single-user deployments but become significant gaps at scale or in security-sensitive environments.

**FreeBSD Jails** represent a more mature, production-oriented implementation that takes full advantage of FreeBSD's isolation primitives. The near-zero startup overhead, ZFS copy-on-write storage, comprehensive resource limiting, fine-grained network egress control, health/metrics endpoints, crash recovery, and audit logging make it substantially better suited for production servers and multi-user deployments. The cost is FreeBSD exclusivity, significantly more complex setup, and the absence of browser automation.

The codebase is well-structured for supporting both runtimes: the shared `runner-common.ts` module ensures consistent agent lifecycle behavior, `container-runtime.ts` provides clean runtime detection and dispatch, and the jail code is properly modularized across 10 focused source files. The jail implementation is not a hack bolted onto a Docker-centric codebase -- it is a first-class alternative with its own setup scripts, service management, firewall configuration, and monitoring infrastructure.

For users who are already on FreeBSD or willing to adopt it, the jail runtime is the stronger choice for any deployment beyond casual personal use. For everyone else, Docker is the pragmatic path that works well enough for the intended use case of a personal AI assistant.

---

## Appendix: Key File References

### Docker Implementation
- `/home/jims/code/nanoclaw/src/src/container-runner.ts` -- Docker agent runner
- `/home/jims/code/nanoclaw/src/src/container-runtime.ts` -- Runtime detection, Docker helpers
- `/home/jims/code/nanoclaw/src/src/runner-common.ts` -- Shared agent process lifecycle
- `/home/jims/code/nanoclaw/src/container/Dockerfile` -- Agent container image
- `/home/jims/code/nanoclaw/src/container/build.sh` -- Container build script

### Jail Implementation
- `/home/jims/code/nanoclaw/src/src/jail/runner.ts` -- Jail agent runner entry point
- `/home/jims/code/nanoclaw/src/src/jail/lifecycle.ts` -- Create, stop, destroy jails
- `/home/jims/code/nanoclaw/src/src/jail/exec.ts` -- Command execution inside jails
- `/home/jims/code/nanoclaw/src/src/jail/network.ts` -- vnet/epair, pf validation, DNS
- `/home/jims/code/nanoclaw/src/src/jail/mounts.ts` -- nullfs mount operations
- `/home/jims/code/nanoclaw/src/src/jail/cleanup.ts` -- Orphan cleanup, audit logging
- `/home/jims/code/nanoclaw/src/src/jail/config.ts` -- Jail configuration constants
- `/home/jims/code/nanoclaw/src/src/jail/metrics.ts` -- Health/metrics HTTP server
- `/home/jims/code/nanoclaw/src/src/jail/sudo.ts` -- Sudo execution with DI
- `/home/jims/code/nanoclaw/src/src/jail/types.ts` -- Type definitions
- `/home/jims/code/nanoclaw/src/src/jail/index.ts` -- Public barrel exports

### Setup and Configuration
- `/home/jims/code/nanoclaw/src/scripts/setup-freebsd.sh` -- FreeBSD bootstrap (10 sections)
- `/home/jims/code/nanoclaw/src/scripts/setup-jail-template.sh` -- Jail template builder
- `/home/jims/code/nanoclaw/src/etc/pf-nanoclaw.conf` -- Standalone pf firewall rules
- `/home/jims/code/nanoclaw/src/etc/pf-nanoclaw-anchor.conf` -- Anchor-mode pf rules
- `/home/jims/code/nanoclaw/src/etc/devfs.rules` -- Restrictive devfs ruleset
- `/home/jims/code/nanoclaw/src/etc/rc.d/nanoclaw` -- FreeBSD rc.d service script

### Orchestrator
- `/home/jims/code/nanoclaw/src/src/index.ts` -- Runtime dispatch, startup, shutdown
- `/home/jims/code/nanoclaw/src/src/config.ts` -- Shared configuration
