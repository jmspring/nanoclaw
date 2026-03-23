# Linux-to-FreeBSD Translation Guide

A reference for Linux/Docker users getting started with NanoClaw's FreeBSD jail runtime.

## Concept Translation Table

| Linux Concept | FreeBSD Equivalent | Key Differences |
|---|---|---|
| Docker container | FreeBSD jail | Jail is a kernel subsystem, not a daemon. No `dockerd`. Jails share the host kernel directly with near-zero overhead. |
| Docker image layers | ZFS snapshot + clone | Instead of layered filesystems, you snapshot an entire dataset and create copy-on-write clones. Clones are instant and initially use zero space. |
| `docker run` | `jail -c` + `jexec` | Creating a jail (`jail -c`) and running commands in it (`jexec`) are separate operations. There is no single command equivalent to `docker run`. |
| Dockerfile | Manual setup + snapshot | No declarative build format. You create a jail, configure it imperatively, then snapshot. Closest equivalent: packer or debootstrap. |
| bind mount (`-v`) | nullfs mount | Both expose host directories inside the container. `nullfs` is FreeBSD's equivalent. Uses `mount_nullfs` instead of `-v host:container`. |
| bridge network | vnet + epair | Docker creates a bridge and veth pairs automatically. FreeBSD requires manual epair creation, IP assignment, and routing. NanoClaw automates this. |
| iptables/nftables | pf (packet filter) | pf rules are evaluated top-to-bottom with `quick` for first-match semantics. Tables (`<name>`) are like ipsets. `pfctl` replaces `iptables`. |
| cgroups v2 | rctl (resource limits) | Both limit memory, CPU, and processes per container/jail. rctl syntax: `rctl -a jail:name:memoryuse:deny=2G`. |
| `/dev` bind mount | devfs + ruleset | FreeBSD has explicit devfs rulesets that whitelist which devices are visible. More granular than Docker's default `/dev` exposure. |
| systemd unit file | rc.d script | FreeBSD uses `/usr/local/etc/rc.d/` for service scripts. `sysrc` configures `/etc/rc.conf`. `service nanoclaw start/stop/restart`. |
| `sysctl -w net.ipv4.ip_forward=1` | `sysctl net.inet.ip.forwarding=1` | Same concept, different path. Persistent config in `/etc/sysctl.conf` on both. |
| `/etc/sudoers.d/` | `/usr/local/etc/sudoers.d/` | FreeBSD keeps locally-installed config under `/usr/local/etc/`. |
| `apt install nodejs` | `pkg install node24` | FreeBSD's `pkg` is like `apt`. Package names differ (`node24` vs `nodejs`). |
| `ufw` / `firewalld` | `pfctl` | No friendly wrapper like `ufw`. You write pf rules directly and load them with `pfctl -f`. |

## What Maps 1:1

- **Isolated execution environments** -- a jail is a container.
- **Filesystem isolation** via mounts works the same way (nullfs vs bind mount).
- **Network namespacing** via vnet is equivalent to Docker's network namespaces.
- **Resource limits** via rctl are equivalent to cgroups.
- **The NanoClaw orchestrator** (`src/index.ts`) is platform-agnostic. It does not care whether it is creating a Docker container or a jail.

## What Is Fundamentally Different

1. **No daemon.** Docker has `dockerd`. Jails are kernel system calls. There is nothing to start or stop -- the jail subsystem is always available.

2. **No image registry.** Docker has `docker pull`. Jails have no equivalent. You build your template locally, snapshot it, and clone it. The template setup is a local process on each machine.

3. **Sudo required.** Docker can be used rootlessly or via group membership (`docker` group). Jails always require `sudo` for creation and management. The sudoers configuration is a prerequisite, not optional.

4. **ZFS is not optional.** The jail runtime depends on ZFS for copy-on-write cloning. On Linux, the filesystem is orthogonal to the container runtime. On FreeBSD with NanoClaw, ZFS is a hard requirement.

5. **Networking is manual.** Docker creates bridge networks and configures NAT automatically. With jails, you must configure vnet, create epair interfaces, assign IPs, configure routing, and set up pf NAT rules. NanoClaw's jail runtime automates all of this, but understanding the components helps when debugging.

## Common Command Equivalents

### Container/Jail Management

| Task | Docker | FreeBSD Jails |
|------|--------|---------------|
| List running | `docker ps` | `sudo jls -N` |
| List all (inc. stopped) | `docker ps -a` | `sudo jls -N` (jails don't persist when stopped) |
| Stop a container | `docker stop <name>` | `sudo jail -r <name>` |
| Run command inside | `docker exec <name> <cmd>` | `sudo jexec <name> <cmd>` |
| View logs | `docker logs <name>` | `cat groups/<name>/logs/jail-*.log` |
| Remove container | `docker rm <name>` | `sudo zfs destroy zroot/nanoclaw/jails/<name>` |

### Storage

| Task | Docker | FreeBSD/ZFS |
|------|--------|-------------|
| List images/templates | `docker images` | `zfs list -t snapshot zroot/nanoclaw/jails/template` |
| Disk usage | `docker system df` | `zfs list -r -o name,used,avail zroot/nanoclaw` |
| Clean up unused | `docker system prune` | See [Cleanup & Recovery](FREEBSD_JAILS.md#8-troubleshooting) |
| Build image/template | `docker build` | `./scripts/setup-jail-template.sh` |

### Networking

| Task | Docker | FreeBSD |
|------|--------|---------|
| List networks | `docker network ls` | `ifconfig -l \| tr ' ' '\n' \| grep epair` |
| Inspect firewall | `iptables -L` | `sudo pfctl -s rules` |
| View NAT rules | `iptables -t nat -L` | `sudo pfctl -s nat` |
| Watch blocked packets | `tcpdump` on docker bridge | `sudo tcpdump -n -e -ttt -i pflog0` |
| Check active connections | `ss -tunap` | `sudo pfctl -s state` |

### Package Management

| Task | apt/yum | FreeBSD pkg |
|------|---------|-------------|
| Update package index | `apt update` | `pkg update` |
| Install a package | `apt install <pkg>` | `pkg install <pkg>` |
| Search for a package | `apt search <term>` | `pkg search <term>` |
| List installed | `dpkg -l` | `pkg info` |

## FreeBSD File Layout

FreeBSD separates base system files from locally-installed software:

| Path | Purpose | Linux Equivalent |
|------|---------|-----------------|
| `/etc/` | Base system configuration | `/etc/` (system configs) |
| `/usr/local/etc/` | Locally-installed software config | `/etc/` (app configs) |
| `/usr/local/bin/` | Locally-installed binaries | `/usr/bin/` or `/usr/local/bin/` |
| `/boot/loader.conf` | Boot-time kernel parameters | `/etc/modules`, GRUB config |
| `/etc/rc.conf` | Service and system configuration | systemd unit enables |
| `/etc/sysctl.conf` | Kernel tuning (persistent) | `/etc/sysctl.conf` (same concept) |

## NanoClaw-Specific Paths

| Purpose | Path |
|---------|------|
| Jail template | ZFS: `zroot/nanoclaw/jails/template` |
| Template snapshot | ZFS: `zroot/nanoclaw/jails/template@base` |
| Active jail clones | ZFS: `zroot/nanoclaw/jails/nanoclaw_<group>` |
| pf configuration | `/usr/local/etc/pf-nanoclaw.conf` |
| Sudoers | `/usr/local/etc/sudoers.d/nanoclaw` |
| devfs ruleset | `/etc/devfs.rules` |

## Related Documentation

- [FreeBSD Jails Runtime Guide](FREEBSD_JAILS.md) -- full setup and architecture
- [Template Setup](TEMPLATE_SETUP.md) -- building and updating the jail template
- [Debug Checklist](DEBUG_CHECKLIST.md) -- jail-specific debugging commands
