# Jail Template Setup

The canonical reference for building, updating, and managing the FreeBSD jail template used by NanoClaw's jail runtime.

## What the Template Is

The jail template is a complete FreeBSD userland with Node.js, npm, TypeScript, Claude Code CLI, and the agent-runner dependencies pre-installed. It lives as a ZFS dataset at `zroot/nanoclaw/jails/template` with a snapshot at `@base`. Every agent jail is an instant ZFS clone of this snapshot.

### Template Contents

```
/
├── app/
│   ├── entrypoint.sh          # Startup script
│   ├── package.json           # Agent runner deps
│   ├── node_modules/          # Installed dependencies
│   ├── src/                   # Agent runner source (mount point)
│   └── tsconfig.json
├── home/
│   └── node/                  # node user home
│       └── .claude/           # Mount point for sessions
├── tmp/                       # Writable temp (mode 1777)
├── workspace/                 # Mount points
│   ├── group/
│   ├── ipc/
│   ├── project/
│   └── global/
├── etc/
│   └── resolv.conf            # DNS (copied from host)
└── usr/local/
    ├── bin/
    │   ├── node
    │   ├── npm
    │   └── claude
    └── lib/node_modules/      # Global packages
```

## Building the Template

### Prerequisites

- FreeBSD 15.0+ with ZFS
- ZFS dataset hierarchy created (via `scripts/setup-freebsd.sh` or manually)
- Passwordless sudo configured (see [Sudo Requirements](#sudo-requirements) below)

### Initial Build

```sh
cd /path/to/nanoclaw/src
./scripts/setup-jail-template.sh
```

The script:
1. Boots the template dataset as a temporary jail (`nanoclaw_template_setup`)
2. Installs global npm packages (TypeScript, Claude Code CLI) with pinned versions
3. Copies agent-runner source files into the jail
4. Installs agent-runner dependencies via `npm ci`
5. Creates the workspace directory structure
6. Writes the entrypoint script
7. Creates a snapshot (`template@base`), backing up any existing snapshot first
8. Validates the new snapshot by creating and testing a temporary clone

### Verifying the Build

```sh
# Check snapshot exists
zfs list -t snapshot zroot/nanoclaw/jails/template@base

# Check template size
zfs list -o name,used,refer zroot/nanoclaw/jails/template

# Verify key files exist
ls /path/to/jails/template/app/entrypoint.sh
ls /path/to/jails/template/usr/local/bin/node
```

## Updating the Template

### When to Update

- After modifying `container/agent-runner/` source code or dependencies
- After upgrading global packages (TypeScript, Claude Code CLI)
- After upgrading Node.js in the template
- After changes to `container/agent-runner/package.json` or `package-lock.json`

### Update Procedure

```sh
# 1. Stop NanoClaw to prevent new jails from starting
pkill -f 'dist/index.js'

# 2. Wait for active jails to finish (or stop them)
sudo jls -N | grep nanoclaw_

# 3. Destroy active jail clones (required -- snapshot can't update with dependent clones)
sudo zfs list -H -o name -t filesystem | grep 'zroot/nanoclaw/jails/nanoclaw_' | while read ds; do
  sudo zfs destroy -r "$ds"
done

# 4. Re-run template setup (backs up existing snapshot automatically)
./scripts/setup-jail-template.sh

# 5. Restart NanoClaw
npm run dev
```

### Blue/Green Template Updates

The setup script supports safe template updates:
1. Renames the current `template@base` to `template@base.backup`
2. Creates a new `template@base` snapshot
3. Validates the new snapshot by test-cloning it
4. If validation fails, restores the backup
5. If validation succeeds, removes the backup

### Updating Global Packages

Global packages are pinned to specific versions in `scripts/setup-jail-template.sh`. To update:

```sh
# Check latest versions
npm view typescript version
npm view @anthropic-ai/claude-code version

# Edit the pinned versions in scripts/setup-jail-template.sh
# Then rebuild the template
./scripts/setup-jail-template.sh
```

See [Jail Package Updates](JAIL_PACKAGE_UPDATES.md) for detailed package update procedures and supply chain security notes.

### Updating Agent-Runner Dependencies

```sh
# Update dependencies in the agent-runner directory
cd container/agent-runner
npm update  # or npm install <pkg>@<version>
cd ../..

# Commit the updated lockfile
git add container/agent-runner/package.json container/agent-runner/package-lock.json
git commit -m "chore: update agent-runner dependencies"

# Rebuild template
./scripts/setup-jail-template.sh
```

### Dependent Clones Error

If you see `cannot destroy: filesystem has dependent clones`, destroy all jail datasets first:

```sh
# List clones
sudo zfs list -H -o name -t filesystem | grep nanoclaw_

# Destroy them
sudo zfs destroy -r zroot/nanoclaw/jails/nanoclaw_<groupname>
```

## Sudo Requirements

The template setup script requires elevated privileges to manage jails, ZFS datasets, and filesystem operations. All operations target the template infrastructure only -- no system-wide changes are made.

### Commands Used

| Category | Command | Purpose |
|----------|---------|---------|
| ZFS | `sudo zfs list` | Check if datasets/snapshots exist |
| ZFS | `sudo zfs destroy` | Remove old backup snapshots and validation clones |
| ZFS | `sudo zfs snapshot` | Create immutable snapshot of configured template |
| ZFS | `sudo zfs rename` | Rename existing snapshot to backup |
| ZFS | `sudo zfs clone` | Create validation clone to test new snapshot |
| Jail | `sudo jls` | Check if a jail is currently running |
| Jail | `sudo jail -c` | Create and start temporary jail for template setup |
| Jail | `sudo jail -r` | Stop and remove temporary jail |
| Jail | `sudo jexec` | Execute commands inside the running jail |
| Filesystem | `sudo umount` | Unmount devfs from template during cleanup |
| Filesystem | `sudo cp` | Copy agent-runner source files into jail template |
| Filesystem | `sudo tee` | Write entrypoint script to template filesystem |
| Filesystem | `sudo chmod` | Make entrypoint script executable |

### Minimal Sudoers Configuration

For a user running template setup, add to `/usr/local/etc/sudoers.d/nanoclaw-template`:

```sudoers
# NanoClaw jail template setup - minimal required privileges
Defaults:youruser !requiretty

# ZFS operations on template dataset only
youruser ALL=(root) NOPASSWD: /sbin/zfs list *
youruser ALL=(root) NOPASSWD: /sbin/zfs destroy zroot/nanoclaw/jails/template*
youruser ALL=(root) NOPASSWD: /sbin/zfs snapshot zroot/nanoclaw/jails/template@*
youruser ALL=(root) NOPASSWD: /sbin/zfs rename zroot/nanoclaw/jails/template@* zroot/nanoclaw/jails/template@*
youruser ALL=(root) NOPASSWD: /sbin/zfs clone zroot/nanoclaw/jails/template@* zroot/nanoclaw/jails/template_*

# Jail management for template setup
youruser ALL=(root) NOPASSWD: /usr/sbin/jls *
youruser ALL=(root) NOPASSWD: /usr/sbin/jail -c *
youruser ALL=(root) NOPASSWD: /usr/sbin/jail -r nanoclaw_template_setup
youruser ALL=(root) NOPASSWD: /usr/sbin/jexec nanoclaw_template_setup *

# Filesystem operations in template directory
youruser ALL=(root) NOPASSWD: /sbin/umount /path/to/jails/template/dev
youruser ALL=(root) NOPASSWD: /bin/cp * /path/to/jails/template/*
youruser ALL=(root) NOPASSWD: /usr/bin/tee /path/to/jails/template/*
youruser ALL=(root) NOPASSWD: /bin/chmod +x /path/to/jails/template/*

# pkg operations in template
youruser ALL=(root) NOPASSWD: /usr/local/sbin/pkg -c /path/to/jails/template *
```

Replace `youruser` with your username and `/path/to/jails/template` with your actual template path (check with `zfs get mountpoint zroot/nanoclaw/jails/template`).

### Security Notes

1. **Scope Limitation**: All commands are restricted to the template dataset and directory
2. **No System-Wide Access**: No privileges for modifying system ZFS pools or creating arbitrary jails
3. **Predictable Names**: Template jail name is fixed (`nanoclaw_template_setup`)
4. **Read-Only Where Possible**: `zfs list` and `jls` are read-only operations
5. **NOPASSWD**: Prevents interactive password prompts during automated setup

### Alternative: Full Passwordless Sudo (Less Secure)

```sudoers
youruser ALL=(ALL) NOPASSWD: ALL
```

**Warning**: This grants unlimited root access. Use only in development environments.

### Installing the Sudoers File

```sh
# Create the sudoers file
sudo visudo -f /usr/local/etc/sudoers.d/nanoclaw-template

# Verify syntax
sudo visudo -c -f /usr/local/etc/sudoers.d/nanoclaw-template

# Test
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

### Template snapshot not created
- Check that the template dataset exists: `zfs list zroot/nanoclaw/jails/template`
- Verify the temporary jail started: check script output for errors
- Review `scripts/setup-jail-template.sh` output for the specific failing step

## Related Documentation

- **[FREEBSD_JAILS.md](FREEBSD_JAILS.md)** -- Complete jail runtime architecture and configuration
- **[JAIL_PACKAGE_UPDATES.md](JAIL_PACKAGE_UPDATES.md)** -- Package update procedures and supply chain security
- **[SECURITY.md](SECURITY.md)** -- Security model and isolation guarantees
- **scripts/setup-jail-template.sh** -- The setup script itself (inline comments)
- **scripts/setup-freebsd.sh** -- Initial FreeBSD system setup (creates ZFS datasets, installs packages)

## Future Improvements

1. **Delegated ZFS Permissions**: Use `zfs allow` to grant specific dataset operations to non-root users
2. **Jail Management Delegation**: Configure jail.conf to allow specific users to manage template jail
3. **Capability-Based Security**: Use FreeBSD capabilities (capsicum) for fine-grained privilege separation
4. **Dedicated Service Account**: Run template setup as a dedicated user with minimal sudo rights
