# Sudoers Configuration for NanoClaw Jail Runtime

This document describes all sudo privileges required for the NanoClaw FreeBSD jail runtime to operate correctly.

## Overview

The NanoClaw jail runtime requires elevated privileges to manage jails, ZFS datasets, network interfaces, and resource limits. These operations must be performed via `sudo` with specific permissions granted to the user running NanoClaw.

## Required Commands

### Jail Management

#### `jail` - Create, modify, and remove jails
- **Usage**: `jail -c [params]` (create), `jail -r [name]` (remove)
- **Purpose**: Create and destroy jail instances for isolated agent execution
- **Risk Level**: HIGH - Can create/destroy system jails
- **Lines**: 1010, 1273, 1285, 1334, 1734, 1912

#### `jexec` - Execute commands inside jails
- **Usage**: `jexec [-U user] [-d dir] [jail] [command]`
- **Purpose**: Run commands inside jails (as root or specific user), kill processes
- **Risk Level**: HIGH - Can execute arbitrary commands in jails
- **Lines**: 534, 544, 1080-1111, 1125, 1213-1255, 1282, 1321

#### `jls` - List jails
- **Usage**: `jls [-j jailname] [-N] [params]`
- **Purpose**: Check jail status and list running jails
- **Risk Level**: LOW - Read-only operation
- **Lines**: 618, 1710, 1869

### ZFS Operations

#### `zfs clone` - Clone ZFS snapshots
- **Usage**: `zfs clone [snapshot] [dataset]`
- **Purpose**: Create jail filesystem from template snapshot
- **Risk Level**: MEDIUM - Creates new datasets
- **Line**: 943

#### `zfs destroy` - Destroy ZFS datasets
- **Usage**: `zfs destroy [-f] [-r] [dataset]`
- **Purpose**: Remove jail datasets during cleanup
- **Risk Level**: HIGH - Can permanently delete data
- **Lines**: 931, 1377, 1537, 1783, 1962

### Filesystem Operations

#### `mount_nullfs` - Mount null filesystem
- **Usage**: `mount_nullfs [-o opts] [source] [target]`
- **Purpose**: Mount host directories into jails (project, group, IPC, etc.)
- **Risk Level**: MEDIUM - Can expose host filesystems to jails
- **Line**: 816

#### `umount` - Unmount filesystems
- **Usage**: `umount [-f] [target]`
- **Purpose**: Unmount nullfs and devfs filesystems during cleanup
- **Risk Level**: MEDIUM - Can disrupt running jails if misused
- **Lines**: 842, 847, 1346, 1364, 1500, 1766, 1920, 1946

#### `mkdir` - Create directories
- **Usage**: `mkdir -p [path]`
- **Purpose**: Create mount points inside jails
- **Risk Level**: LOW - Only creates directories
- **Lines**: 786, 957

#### `chown` - Change file ownership
- **Usage**: `chown [-R] [owner:group] [path]`
- **Purpose**: Set ownership of jail home directories
- **Risk Level**: MEDIUM - Can change file ownership in jails
- **Line**: 963

#### `chmod` - Change file permissions
- **Usage**: `chmod [mode] [path]`
- **Purpose**: Set permissions on jail directories (e.g., /tmp)
- **Risk Level**: MEDIUM - Can modify file permissions in jails
- **Line**: 966

### Network Management (Restricted Mode Only)

#### `ifconfig` - Configure network interfaces
- **Usage**: `ifconfig epair create`, `ifconfig [iface] [ip] up`, `ifconfig [iface] destroy`
- **Purpose**: Create/configure/destroy epair interfaces for vnet jails
- **Risk Level**: HIGH - Can modify network configuration
- **Lines**: 372-375 (read-only), 477, 506, 571, 1393, 1829, 2003

#### `route` - Modify routing tables
- **Usage**: `route add default [gateway]` (executed via jexec inside jail)
- **Purpose**: Configure default route inside vnet jails
- **Risk Level**: MEDIUM - Only affects jail routing, not host
- **Line**: 543-549 (via jexec)

### Resource Limits

#### `rctl` - Resource limits
- **Usage**: `rctl -a [rule]` (add), `rctl -r [subject]` (remove)
- **Purpose**: Apply/remove memory, CPU, and process limits to prevent runaway agents
- **Risk Level**: MEDIUM - Can limit resources but not escalate
- **Lines**: 251-268 (apply), 282, 1723, 1900 (remove)

### Firewall (Monitoring Only)

#### `pfctl` - Packet filter control
- **Usage**: `pfctl -si` (show info)
- **Purpose**: Read firewall statistics for metrics
- **Risk Level**: LOW - Read-only operation
- **File**: src/metrics.ts:122

### Utility Commands

#### `sh` - Shell for complex operations
- **Usage**: `sh -c [command]`
- **Purpose**: Execute shell commands (writing resolv.conf, etc.)
- **Risk Level**: HIGH - Can execute arbitrary shell commands
- **Lines**: 602-605, 958-962

#### `kill` - Send signals to processes
- **Usage**: `kill -9 -1` (executed via jexec inside jail)
- **Purpose**: Kill all processes in a jail during cleanup/timeout
- **Risk Level**: MEDIUM - Only affects jail processes via jexec
- **Lines**: 1125, 1282, 1321 (all via jexec)

## Sample Sudoers Configuration

Create a file `/usr/local/etc/sudoers.d/nanoclaw` with the following content:

```sudoers
# NanoClaw jail runtime sudo privileges
# Replace 'nanoclaw_user' with the actual username running NanoClaw

# Jail management
nanoclaw_user ALL=(root) NOPASSWD: /usr/sbin/jail
nanoclaw_user ALL=(root) NOPASSWD: /usr/sbin/jexec
nanoclaw_user ALL=(root) NOPASSWD: /usr/sbin/jls

# ZFS operations (restricted to NanoClaw jail datasets)
nanoclaw_user ALL=(root) NOPASSWD: /sbin/zfs clone *
nanoclaw_user ALL=(root) NOPASSWD: /sbin/zfs destroy *
nanoclaw_user ALL=(root) NOPASSWD: /sbin/zfs list *

# Filesystem operations
nanoclaw_user ALL=(root) NOPASSWD: /sbin/mount_nullfs
nanoclaw_user ALL=(root) NOPASSWD: /sbin/umount
nanoclaw_user ALL=(root) NOPASSWD: /bin/mkdir
nanoclaw_user ALL=(root) NOPASSWD: /usr/sbin/chown
nanoclaw_user ALL=(root) NOPASSWD: /bin/chmod

# Network management (vnet/epair mode only)
nanoclaw_user ALL=(root) NOPASSWD: /sbin/ifconfig
nanoclaw_user ALL=(root) NOPASSWD: /sbin/route

# Resource limits
nanoclaw_user ALL=(root) NOPASSWD: /usr/bin/rctl

# Firewall monitoring (read-only)
nanoclaw_user ALL=(root) NOPASSWD: /sbin/pfctl -si

# Shell for scripted operations
nanoclaw_user ALL=(root) NOPASSWD: /bin/sh
```

### Tighter Restrictions (Advanced)

For production environments, you can further restrict commands to specific patterns:

```sudoers
# Jail operations - restrict to nanoclaw_* jails only
nanoclaw_user ALL=(root) NOPASSWD: /usr/sbin/jail -c name=nanoclaw_*
nanoclaw_user ALL=(root) NOPASSWD: /usr/sbin/jail -r nanoclaw_*
nanoclaw_user ALL=(root) NOPASSWD: /usr/sbin/jexec nanoclaw_*
nanoclaw_user ALL=(root) NOPASSWD: /usr/sbin/jls *

# ZFS - restrict to specific dataset paths
nanoclaw_user ALL=(root) NOPASSWD: /sbin/zfs clone zroot/nanoclaw/jails/template@* zroot/nanoclaw/jails/*
nanoclaw_user ALL=(root) NOPASSWD: /sbin/zfs destroy * zroot/nanoclaw/jails/*

# Filesystem - restrict to jail paths only
nanoclaw_user ALL=(root) NOPASSWD: /sbin/mount_nullfs * /home/jims/code/nanoclaw/jails/*
nanoclaw_user ALL=(root) NOPASSWD: /sbin/umount /home/jims/code/nanoclaw/jails/*
nanoclaw_user ALL=(root) NOPASSWD: /bin/mkdir -p /home/jims/code/nanoclaw/jails/*

# Network - restrict to epair operations only
nanoclaw_user ALL=(root) NOPASSWD: /sbin/ifconfig epair*
```

**Note**: The advanced restrictions above require careful path configuration and may need adjustment based on your actual `JAIL_CONFIG` paths in `src/jail-runtime.ts`.

## Security Considerations

### Principle of Least Privilege

1. **User Isolation**: Run NanoClaw under a dedicated service account, not your personal account
2. **Group Restrictions**: Consider using sudo's group restrictions to limit who can run these commands
3. **Audit Logging**: Enable sudo logging to track all privileged operations
4. **Path Restrictions**: Use full command paths in sudoers to prevent PATH manipulation
5. **Argument Validation**: The jail runtime validates all inputs before passing to sudo

### Risk Assessment

**HIGH RISK** commands that require careful monitoring:
- `jail` - Can create/destroy system jails
- `jexec` - Can execute arbitrary commands in jails
- `zfs destroy` - Can permanently delete data
- `ifconfig` - Can modify network configuration
- `sh` - Can execute arbitrary shell commands

**MEDIUM RISK** commands with bounded impact:
- `mount_nullfs`, `umount` - Limited to jail paths
- `rctl` - Can only restrict, not escalate resources
- `chown`, `chmod` - Limited to jail filesystems

**LOW RISK** read-only commands:
- `jls` - Only lists jails
- `pfctl -si` - Only reads statistics
- `zfs list` - Only lists datasets

### Operational Security

1. **Template Snapshot**: Ensure the ZFS template snapshot exists and is read-only
2. **Dataset Isolation**: Use dedicated ZFS datasets for jails, separate from system datasets
3. **Network Isolation**: Use `networkMode: 'restricted'` with vnet/epair for production
4. **Resource Limits**: Configure appropriate `NANOCLAW_JAIL_MEMORY_LIMIT`, `NANOCLAW_JAIL_MAXPROC`, and `NANOCLAW_JAIL_PCPU` limits
5. **Devfs Ruleset**: Apply restrictive devfs ruleset (ruleset 10) to limit device access in jails
6. **Cleanup Auditing**: Monitor the cleanup audit log at `{jailsPath}/cleanup-audit.log`

### What NanoClaw Does NOT Need

The following privileges are NOT required and should NOT be granted:
- `pkg` - Package installation (use template snapshot with packages pre-installed)
- `pw` - User/group management (jail uses template's users)
- `sysctl` - Kernel parameter changes (jail settings are hardcoded)
- `kldload`/`kldunload` - Kernel module management
- Full root access or `NOPASSWD: ALL`

## Verification

After configuring sudoers, verify permissions with:

```bash
# Test jail listing (should work without password)
sudo jls -N

# Test ZFS listing (should work without password)
sudo zfs list -t snapshot | grep nanoclaw

# Test ifconfig (should work without password)
sudo ifconfig -l
```

## Troubleshooting

**"sudo: no tty present and no askpass program specified"**
- Missing `NOPASSWD` in sudoers configuration
- Solution: Ensure all NanoClaw commands have `NOPASSWD` directive

**"sudo: /usr/sbin/jail: command not found"**
- Incorrect command path in sudoers
- Solution: Verify paths with `which jail`, `which jexec`, etc.

**Permission denied on ZFS operations**
- ZFS delegation may conflict with sudo permissions
- Solution: Use sudo for all ZFS operations, not ZFS delegation

**Epair creation fails with "Operation not permitted"**
- Missing ifconfig sudo permission or vnet not enabled
- Solution: Verify sudo access to ifconfig and check `kern.features.vimage` sysctl

## References

- [FreeBSD Handbook: Jails](https://docs.freebsd.org/en/books/handbook/jails/)
- [sudoers(5) Manual Page](https://www.freebsd.org/cgi/man.cgi?query=sudoers&sektion=5)
- [ZFS Administration](https://docs.freebsd.org/en/books/handbook/zfs/)
- [Resource Limits (rctl)](https://www.freebsd.org/cgi/man.cgi?query=rctl&sektion=8)
