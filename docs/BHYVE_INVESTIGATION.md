# bhyve Investigation: Linux Container Compatibility for NanoClaw

**Ticket:** nc-p12d
**Date:** 2026-03-28
**Author:** Developer subagent (research)

---

## 1. Executive Summary

NanoClaw currently runs the Claude Agent SDK inside FreeBSD jails using a ZFS-cloned
template with Node.js, Chromium, and supporting libraries installed natively. The
upstream Docker image (`node:24-slim` with Debian-based Chromium) cannot run directly
in a jail because jails share the FreeBSD host kernel and cannot execute Linux
binaries natively. bhyve, FreeBSD's Type 2 hypervisor, could theoretically run the
Docker image inside a full Linux VM, providing byte-for-byte compatibility with
upstream. However, the overhead -- 3-10 second boot times, ~200-512 MB memory per
VM for the kernel alone, complex filesystem sharing via 9pfs/virtio-fs, and the
engineering effort to build a complete `src/bhyve/` runtime module -- makes this
approach impractical for NanoClaw's use case of short-lived, concurrent agent sessions.

**Recommendation: NO-GO.** The jail runtime with FreeBSD-native packages already
achieves feature parity with Docker for NanoClaw's workloads. The startup time
penalty alone (30-100x slower than jail creation) disqualifies bhyve for interactive
agent sessions. If Linux binary compatibility becomes essential in the future, the
FreeBSD Linuxulator (see Section 8) is a more practical path than full VM
virtualization.

---

## 2. bhyve Overview on FreeBSD 15

### What bhyve Provides

bhyve is FreeBSD's native Type 2 hypervisor, available since FreeBSD 10.0 and
substantially improved through FreeBSD 15.0-RELEASE. Key capabilities:

- **Full hardware virtualization** using Intel VT-x or AMD-V extensions
- **UEFI boot** support via the `bhyve_uefi.fd` firmware
- **VirtIO device emulation** for disk (virtio-blk), network (virtio-net),
  console (virtio-console), random (virtio-rng), and filesystem (virtio-9p)
- **Linux guest support** -- runs most Linux distributions including Debian,
  Ubuntu, Alpine, and custom images
- **Snapshots** via ZFS on the host side (VM disk images stored on ZFS)
- **PCI passthrough** for GPU or NIC devices (not relevant to NanoClaw)
- **Memory overcommit** is not supported -- each VM's RAM is fully allocated

### Current State on FreeBSD 15.0-RELEASE

FreeBSD 15.0 ships bhyve with several improvements over prior releases:

- Improved VirtIO device performance and compliance
- Better UEFI variable store handling
- Improved TPM emulation (not relevant here)
- `vmm.ko` kernel module must be loaded: `kldload vmm`
- Management tools: `bhyvectl(8)`, `bhyveload(8)`, and community tools like
  `vm-bhyve` or `cbsd` for higher-level VM management
- virtio-9p (9pfs) filesystem sharing is available but has known performance
  limitations compared to NFS or nullfs

### Key Capabilities Relevant to NanoClaw

| Feature | bhyve Status | NanoClaw Relevance |
|---------|-------------|-------------------|
| Run Linux userland | Full support | Would allow upstream Docker image |
| VirtIO networking | Stable | Needed for credential proxy access |
| 9pfs sharing | Available, slow | Needed for workspace/IPC mounts |
| virtio-fs (virtiofsd) | Experimental | Better mount performance |
| ZFS-backed disk images | Native | Consistent with jail ZFS workflow |
| Resource limits | Via bhyve flags | Memory cap, CPU count per VM |
| Live migration | Not mature | Not needed |

Reference: `bhyve(8)`, `vmm(4)`, FreeBSD Handbook Chapter 22 (Virtualization).

---

## 3. Feasibility Assessment for NanoClaw

### Can bhyve Run the Docker Image?

The NanoClaw Dockerfile builds on `node:24-slim` (Debian bookworm) and installs
Chromium, Node.js 24, `agent-browser`, `claude-code`, and a custom agent-runner.

bhyve cannot run Docker images directly. Converting requires either: (1) Docker
export to raw disk with manually added bootloader/kernel/init, (2) cloud-init
provisioned minimal Linux VM, or (3) a Packer build pipeline. All approaches add
a parallel build pipeline that must stay in sync with the upstream Dockerfile --
none provide the "just run the Docker image" simplicity that motivates this.

### Startup Time Overhead

| Runtime | Cold Start | Warm/Reuse |
|---------|-----------|------------|
| FreeBSD jail (ZFS clone) | 50-100 ms | N/A (recreated per session) |
| Docker container | 1-3 seconds | ~500 ms (with layer cache) |
| bhyve VM (cold boot) | 3-10 seconds | 1-3 seconds (if kept running) |

NanoClaw creates a fresh jail per agent invocation (unless `JAIL_PERSIST=true`),
completing in under 100ms. Replacing this with a 5-10 second VM boot would be
30-100x slower and directly degrade interactive response times.

### Memory Overhead and Concurrent Instance Limits

Each bhyve VM runs its own Linux kernel (~100-200 MB overhead) plus userland.
Total per VM: ~400-1000 MB vs ~300-800 MB for jails (which share the host kernel).

On a 32 GB host: jails support 30-50 concurrent instances (current default 50);
bhyve VMs support 10-20 (each needing 1.5-2 GB plus kernel overhead). bhyve also
requires per-VM `vmm` devices, tap interfaces, and VirtIO emulation CPU cycles.

---

## 4. Mount Strategy

**9pfs** is the primary filesystem sharing mechanism for bhyve on FreeBSD 15.
The host exposes directories via VirtIO 9p protocol. Performance is 2-5x slower
than nullfs for small file I/O, with metadata operations particularly impacted.
No mmap support in some configurations affects Node.js file watching.

**virtio-fs** offers near-native performance via shared memory (DAX) and FUSE,
but is experimental on FreeBSD 15.0-RELEASE. Not production-ready.

NanoClaw mounts 5 directories per jail via nullfs (project, group, IPC, session,
agent-runner). With bhyve, each would need a 9pfs or virtio-fs share. The IPC
directory is particularly latency-sensitive due to agent file polling.

| Operation | nullfs (jail) | 9pfs (bhyve) | virtio-fs (bhyve) |
|-----------|--------------|-------------|-------------------|
| Small file read (4 KB) | <0.1 ms | 0.5-2 ms | 0.1-0.5 ms |
| Directory listing (100 files) | <1 ms | 5-20 ms | 1-5 ms |
| IPC file poll cycle | <1 ms | 5-15 ms | 2-5 ms |

Reference: `virtio(4)`, QEMU/KVM 9pfs benchmarks.

---

## 5. Network Integration

NanoClaw jails use vnet with epair interfaces (`src/jail/network.ts`): each jail
gets an `epairNa`/`epairNb` pair with `/30` IPs from `10.99.x.x`, filtered by pf.

bhyve VMs use tap interfaces bridged to `bridge0` instead. Key differences:

| Aspect | epair (jails) | tap (bhyve) |
|--------|--------------|-------------|
| Interface type | `epairNa`/`epairNb` | `tapN` + `bridge0` |
| IP allocation | `/30` per pair | `/24` or `/16` on bridge |
| pf rule targeting | `on epairNa` or `$jail_net` | `on bridge0` or bridge subnet |
| Isolation | Per-jail epair | Per-VM tap (bridge shared) |

Existing pf rules target `$jail_net` (`10.99.0.0/16`). VMs could share this
subnet (minimal pf changes but mixed address space) or use a separate subnet
(requires duplicated rules). The credential proxy must be reachable at the
host's bridge IP instead of the epair host IP.

---

## 6. Credential Proxy Integration

In jails, the proxy listens on each epair host IP. A per-jail token is passed
via env var, and `ANTHROPIC_BASE_URL` points to the host epair IP.

For bhyve VMs, the path becomes: VM tap -> bridge -> host -> proxy. Token
injection requires cloud-init, serial console, or a 9pfs-shared config file
instead of a simple env var. The additional bridge hop adds ~1 ms latency and
makes per-VM pf rules more complex than per-jail epair rules.

| Aspect | Jail (epair) | bhyve (tap+bridge) |
|--------|-------------|-------------------|
| Network hops | 1 (epair direct) | 2 (tap -> bridge -> host) |
| Token injection | Environment variable | Config file or cloud-init |
| Latency | Sub-millisecond | ~1 ms (bridge overhead) |

---

## 7. Implementation Estimate

### New Files Required

A bhyve runtime would require a `src/bhyve/` module set mirroring `src/jail/`:

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `src/bhyve/config.ts` | VM configuration, env vars | ~80 |
| `src/bhyve/lifecycle.ts` | Create, start, stop, destroy VMs | ~400 |
| `src/bhyve/network.ts` | tap interface + bridge management | ~200 |
| `src/bhyve/mounts.ts` | 9pfs/virtio-fs share configuration | ~150 |
| `src/bhyve/runner.ts` | Agent runner integration | ~250 |
| `src/bhyve/cleanup.ts` | Orphan VM cleanup | ~100 |
| `src/bhyve/types.ts` | Type definitions | ~50 |
| `src/bhyve/image.ts` | VM image build/management | ~200 |
| `scripts/build-bhyve-image.sh` | VM image build script | ~150 |
| **Total** | | **~1580** |

### Integration Points

Existing files that would need modification:

- `src/container-runner.ts` -- add `bhyve` runtime dispatch alongside `jail`
- `src/container-runtime.ts` -- detect bhyve availability
- `src/config.ts` -- add bhyve-specific configuration variables
- `src/credential-proxy.ts` -- bridge network awareness for token validation
- `etc/pf-nanoclaw.conf` -- bridge/tap rules for VM traffic

### Estimated Development Effort

| Phase | Effort | Description |
|-------|--------|-------------|
| VM image pipeline | 1 week | Build script, cloud-init, package parity |
| `src/bhyve/` core modules | 2 weeks | lifecycle, network, mounts, runner |
| pf integration | 3 days | Bridge rules, NAT, credential proxy path |
| Testing infrastructure | 1 week | Requires hardware VT-x/AMD-V for CI |
| Integration testing | 1 week | End-to-end agent execution in bhyve VM |
| Documentation | 2 days | Deployment guide, configuration reference |
| **Total** | **~5-6 weeks** | |

### Testing Requirements

bhyve requires hardware virtualization support (VT-x or AMD-V). This means:

- Cannot run in CI environments that are themselves VMs (nested virtualization
  required, which is not universally available)
- Development testing requires bare-metal FreeBSD or a hypervisor that supports
  nested virtualization (VMware Workstation, recent KVM)
- Integration tests would need a dedicated test host or be skipped in CI

---

## 8. Alternatives to bhyve

### FreeBSD Linuxulator

The Linux binary compatibility layer (`linux(4)`) translates Linux syscalls to
FreeBSD equivalents at runtime with no VM overhead. Node.js 24 works well under
it. Chromium is problematic -- it uses `seccomp-bpf` and namespaces for
sandboxing which the Linuxulator doesn't implement. Headless Chromium may work
with `--no-sandbox` in a securelevel-3 jail. Can be enabled per-jail via
`linux_enable`. **Most promising alternative** for Linux-only Node.js workloads.

### Jail with Linux Userland (debootstrap + Linuxulator)

Install a Debian/Ubuntu userland in the jail root via `debootstrap`, enable
Linuxulator, and run Linux binaries directly with `apt-get` access. Avoids VM
overhead while providing broader Linux package compatibility. Same Chromium
sandboxing limitations as the Linuxulator approach.

### FreeBSD-Native Equivalents (Current Approach)

The current working approach: Node.js and Chromium from FreeBSD packages.
Zero boot overhead, native performance, shared kernel memory, mature codebase.
Package versions may lag Linux, and some npm native bindings may not compile.

### Hybrid: Jails + bhyve for Browser Automation

Use jails for most workloads, bhyve only for browser automation. Technically
possible but adds two runtime paths, two mount strategies, two networking
models. Not justified given FreeBSD-native Chromium already works.

---

## 9. Go/No-Go Recommendation

### Pros and Cons Summary

| Factor | bhyve | Jails (current) | Winner |
|--------|-------|-----------------|--------|
| Upstream Docker compatibility | Full | None (FreeBSD native) | bhyve |
| Startup time | 3-10 seconds | 50-100 ms | Jails |
| Memory overhead per instance | 400-1000 MB | 300-800 MB | Jails |
| Concurrent instances (32 GB host) | 10-20 | 30-50 | Jails |
| Filesystem sharing performance | 2-5x slower (9pfs) | Native (nullfs) | Jails |
| Network complexity | Bridge + tap + pf | Epair + pf | Jails |
| Credential proxy integration | Complex (bridge path) | Simple (epair direct) | Jails |
| Implementation effort | ~6 weeks, ~1600 LOC | Already done | Jails |
| CI/testing requirements | Bare metal needed | Standard FreeBSD | Jails |
| Maintenance burden | VM images + jail code | Jail code only | Jails |
| Security isolation | VM boundary (stronger) | Jail boundary + securelevel 3 | bhyve |

### Recommendation: NO-GO

bhyve is not recommended for NanoClaw at this time. The rationale:

1. **Startup time is disqualifying.** NanoClaw creates and destroys containers
   per agent invocation. A 3-10 second boot time (vs 50-100 ms for jails)
   would be directly visible to users as latency on every message.

2. **The problem it solves does not exist today.** The jail template already
   runs Node.js 24 and Chromium successfully. There is no current workload
   that requires Linux-only binaries.

3. **The engineering cost is disproportionate.** ~6 weeks of development for
   a runtime that would be slower, consume more memory, and support fewer
   concurrent instances than the existing jail runtime.

4. **Filesystem sharing is a bottleneck.** 9pfs performance is 2-5x slower
   than nullfs, directly impacting IPC responsiveness and workspace operations.

5. **It adds a second runtime to maintain.** The jail runtime is ~1500 LOC
   across 10 modules. bhyve would add another ~1600 LOC. Maintaining two
   parallel runtimes doubles the testing and debugging surface.

### What Would Change This Recommendation

bhyve should be reconsidered if:

- **Upstream NanoClaw adds a Linux-only dependency** that cannot be replaced
  with a FreeBSD equivalent (e.g., a GPU-accelerated inference runtime)
- **virtio-fs becomes production-ready on FreeBSD**, eliminating the 9pfs
  performance penalty
- **bhyve gains container-mode support** (lightweight VMs with sub-second
  boot, similar to Firecracker on Linux)
- **The Linuxulator improves Chromium sandboxing support**, making the
  Linuxulator-in-a-jail approach viable for full browser automation
- **Persistent VM pools** become a requirement, where VMs are pre-booted and
  reused across sessions (trading memory for latency, similar to
  `JAIL_PERSIST=true` but for VMs)

### Recommended Alternative Path

If Linux binary compatibility becomes necessary:

1. **Phase 1**: Evaluate Linuxulator for Node.js-only workloads in jails
   (1-2 days of investigation)
2. **Phase 2**: If Chromium is needed, test headless Chromium under
   Linuxulator with `--no-sandbox` in a securelevel-3 jail (1 week)
3. **Phase 3**: Only if Linuxulator fails, revisit bhyve with persistent
   VM pools and virtio-fs (reassess at that time)

---

*References: bhyve(8), vmm(4), linux(4), linux64(4), jail(8), pf.conf(5),
nullfs(5), FreeBSD Handbook Chapters 12, 16, and 22.*
