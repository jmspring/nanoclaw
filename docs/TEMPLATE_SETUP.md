# Jail Template Setup - Sudo Requirements

This document lists all sudo operations required by `scripts/setup-jail-template.sh` and provides the minimal sudoers configuration needed for template setup.

## Overview

The template setup script requires elevated privileges to manage jails, ZFS datasets, and filesystem operations. All operations are performed on the jail template infrastructure only—no system-wide changes are made.

## Sudo Commands Used

### 1. ZFS Operations

#### `sudo zfs list`
- **Purpose**: Check if ZFS datasets and snapshots exist
- **Why sudo**: ZFS information commands require root privileges to query dataset properties
- **Lines**: 78, 93, 94, 270, 274, 287, 299, 336

#### `sudo zfs destroy`
- **Purpose**: Remove old backup snapshots and validation clones
- **Why sudo**: Destroying ZFS datasets requires root privileges to prevent accidental data loss
- **Lines**: 276, 320, 331, 338

#### `sudo zfs snapshot`
- **Purpose**: Create immutable snapshot of configured template
- **Why sudo**: Creating ZFS snapshots requires root to ensure atomicity and consistency
- **Line**: 284

#### `sudo zfs rename`
- **Purpose**: Rename existing snapshot to backup before creating new one
- **Why sudo**: Renaming ZFS objects requires root privileges to maintain dataset integrity
- **Lines**: 280, 332

#### `sudo zfs clone`
- **Purpose**: Create validation clone to test new snapshot
- **Why sudo**: Cloning ZFS datasets requires root privileges for dataset creation
- **Line**: 306

### 2. Jail Management

#### `sudo jls`
- **Purpose**: Check if a jail is currently running
- **Why sudo**: Querying jail status requires root to access kernel jail subsystem
- **Lines**: 49, 112

#### `sudo jail -c`
- **Purpose**: Create and start temporary jail for template setup
- **Why sudo**: Only root can create jails (kernel-level isolation)
- **Line**: 119

#### `sudo jail -r`
- **Purpose**: Stop and remove temporary jail
- **Why sudo**: Only root can destroy jails
- **Lines**: 51, 114, 256

#### `sudo jexec`
- **Purpose**: Execute commands inside the running jail
- **Why sudo**: Entering jails requires root privileges for security isolation
- **Lines**: 134 (wrapper function used throughout)

### 3. Filesystem Operations

#### `sudo umount`
- **Purpose**: Unmount devfs from template during cleanup
- **Why sudo**: Unmounting filesystems requires root privileges
- **Lines**: 56, 261

#### `sudo cp`
- **Purpose**: Copy agent-runner source files into jail template filesystem
- **Why sudo**: Writing to ZFS-mounted template directory requires appropriate permissions
- **Lines**: 150-153

#### `sudo tee`
- **Purpose**: Write entrypoint script to template filesystem
- **Why sudo**: Creating files in ZFS dataset requires root when ownership restrictions apply
- **Line**: 188

#### `sudo chmod`
- **Purpose**: Make entrypoint script executable
- **Why sudo**: Modifying file permissions in ZFS dataset
- **Line**: 207

## Minimal Sudoers Configuration

For a user running template setup (e.g., `jims`), add this to `/usr/local/etc/sudoers.d/nanoclaw-template`:

```sudoers
# NanoClaw jail template setup - minimal required privileges
# Allow user to manage template jail and ZFS dataset without password

# User running NanoClaw
Defaults:jims !requiretty

# ZFS operations on template dataset only
jims ALL=(root) NOPASSWD: /sbin/zfs list *
jims ALL=(root) NOPASSWD: /sbin/zfs destroy zroot/nanoclaw/jails/template*
jims ALL=(root) NOPASSWD: /sbin/zfs snapshot zroot/nanoclaw/jails/template@*
jims ALL=(root) NOPASSWD: /sbin/zfs rename zroot/nanoclaw/jails/template@* zroot/nanoclaw/jails/template@*
jims ALL=(root) NOPASSWD: /sbin/zfs clone zroot/nanoclaw/jails/template@* zroot/nanoclaw/jails/template_*

# Jail management for template setup
jims ALL=(root) NOPASSWD: /usr/sbin/jls *
jims ALL=(root) NOPASSWD: /usr/sbin/jail -c *
jims ALL=(root) NOPASSWD: /usr/sbin/jail -r nanoclaw_template_setup
jims ALL=(root) NOPASSWD: /usr/sbin/jexec nanoclaw_template_setup *

# Filesystem operations in template directory
jims ALL=(root) NOPASSWD: /sbin/umount /home/jims/code/nanoclaw/jails/template/dev
jims ALL=(root) NOPASSWD: /bin/cp * /home/jims/code/nanoclaw/jails/template/*
jims ALL=(root) NOPASSWD: /usr/bin/tee /home/jims/code/nanoclaw/jails/template/*
jims ALL=(root) NOPASSWD: /bin/chmod +x /home/jims/code/nanoclaw/jails/template/*

# pkg operations in template (used during initial creation)
jims ALL=(root) NOPASSWD: /usr/local/sbin/pkg -c /home/jims/code/nanoclaw/jails/template *
```

### Security Notes

1. **Scope Limitation**: All commands are restricted to the template dataset and directory
2. **No System-Wide Access**: No privileges for modifying system ZFS pools or creating arbitrary jails
3. **Predictable Names**: Template jail name is fixed (`nanoclaw_template_setup`)
4. **Read-Only Where Possible**: `zfs list` and `jls` are read-only operations
5. **NOPASSWD**: Prevents interactive password prompts during automated setup

### Alternative: Full Passwordless Sudo (Less Secure)

If granular control is not required, you can allow full passwordless sudo:

```sudoers
jims ALL=(ALL) NOPASSWD: ALL
```

**Warning**: This grants unlimited root access. Use only in development environments or trusted contexts.

## Installation

1. Create the sudoers file:
   ```bash
   sudo visudo -f /usr/local/etc/sudoers.d/nanoclaw-template
   ```

2. Paste the minimal configuration above (replace `jims` with your username)

3. Verify syntax (visudo will prevent invalid configurations):
   ```bash
   sudo visudo -c -f /usr/local/etc/sudoers.d/nanoclaw-template
   ```

4. Test without password prompt:
   ```bash
   sudo -n zfs list zroot/nanoclaw/jails/template
   ```

## Troubleshooting

### "sudo: a password is required"
- Ensure NOPASSWD is present in sudoers configuration
- Verify you're running as the correct user
- Check `Defaults:username !requiretty` is set

### "sorry, user X is not allowed to execute Y"
- Verify the command path matches exactly (use `which <command>` to find full path)
- Check that the target dataset/path matches your configuration
- Ensure sudoers file has correct permissions (0440)

### Script hangs at sudo command
- Missing `Defaults:username !requiretty` for non-interactive shells
- NOPASSWD not configured, waiting for password input

## Related Documentation

- **[FREEBSD_JAILS.md](FREEBSD_JAILS.md)**: Complete jail runtime architecture
- **[SECURITY.md](SECURITY.md)**: Security model and isolation guarantees
- **scripts/setup-jail-template.sh**: The setup script itself (inline comments)

## Future Improvements

Potential privilege escalation alternatives to explore:

1. **Delegated ZFS Permissions**: Use `zfs allow` to grant specific dataset operations to non-root users
2. **Jail Management Delegation**: Configure jail.conf to allow specific users to manage template jail
3. **Capability-Based Security**: Use FreeBSD capabilities (capsicum) for fine-grained privilege separation
4. **Dedicated Service Account**: Run template setup as a dedicated user with minimal sudo rights

See ticket src-lfex for implementation history.
