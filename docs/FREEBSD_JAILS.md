# FreeBSD Jails Runtime for NanoClaw

This guide covers deploying NanoClaw with FreeBSD jails as the container runtime, an alternative to Docker or Apple Container.

## 1. Overview

### What This Is

NanoClaw's FreeBSD jail runtime provides OS-level isolation for Claude agents. Each agent runs in its own jail with:
- Isolated filesystem via ZFS clones
- Isolated networking via vnet + epair
- Read-only project mounts, read-write group workspace
- Session persistence across conversations

### Why Jails

| Feature | Docker | FreeBSD Jails |
|---------|--------|---------------|
| Container overhead | ~50-100MB memory | ~0 (shared kernel) |
| Startup time | 1-3 seconds | <100ms |
| Storage | Layer-based, dedup varies | ZFS COW clones (instant, zero-copy) |
| Network isolation | Bridge/NAT | vnet + epair (true network stack) |
| Host integration | Separate daemon | Native kernel subsystem |
| Root requirement | Docker daemon (rootless available) | sudo for jail operations |
| Platform | Cross-platform | FreeBSD only |

### Architecture

```
   Telegram/Slack/etc.
          |
          v
   +-------------+
   | Orchestrator|  (Node.js process)
   | src/index.ts|
   +-------------+
          |
          | message arrives
          v
   +-------------------+
   | container-runner.ts|
   +-------------------+
          |
          | NANOCLAW_RUNTIME=jail
          v
   +------------------+
   | jail-runtime.js  |
   +------------------+
          |
     +---------+--------+--------+
     v         v        v        v
   ZFS      nullfs    jail -c   jexec
   clone    mounts    (vnet)    agent
     |         |        |        |
     v         v        v        v
   +----------------------------------+
   | nanoclaw_groupname               |
   | /workspace/project  (ro)         |
   | /workspace/group    (rw)         |
   | /workspace/ipc      (rw)         |
   | /home/node/.claude  (rw)         |
   | /app/src            (ro)         |
   +----------------------------------+
          |
          | Claude Agent SDK
          v
   api.anthropic.com
          |
          v
   response -> orchestrator -> channel
          |
          v
   cleanup: jail -r, umount, zfs destroy
```

## 2. Requirements

### System Requirements

- **FreeBSD 15.0+** (tested on 15.0-RELEASE amd64)
- **ZFS root** or ZFS pool with ~2GB available space
- **RAM**: 4GB minimum, 8GB+ recommended
- **Architecture**: amd64 (arm64 should work but untested)

### Package Dependencies

```sh
# Install required packages
pkg install node24 npm-node24 git

# Verify installations
node --version   # Should be v24.x
npm --version    # Should be 10.x+
```

### Kernel Requirements

For restricted networking mode (production):

```sh
# Load required modules (persistent via /boot/loader.conf)
kldload pf
kldload pflog

# Add to /boot/loader.conf for persistence:
pf_load="YES"
pflog_load="YES"
```

### User Requirements

- Non-root user in **wheel** group
- Passwordless sudo access for jail operations

```sh
# Add user to wheel group if not already
pw groupmod wheel -m youruser

# Configure sudoers (visudo)
# Add this line:
youruser ALL=(ALL) NOPASSWD: /usr/sbin/jail, /usr/sbin/jexec, /sbin/zfs, /sbin/mount*, /sbin/umount, /sbin/ifconfig
```

## 3. Quick Start

### Step 1: Install FreeBSD

Start with a fresh FreeBSD 15.0 installation with ZFS root.

### Step 2: Install Dependencies

```sh
# As root or with sudo
pkg update
pkg install node24 npm-node24 git

# Verify
node --version
npm --version
```

### Step 3: Clone NanoClaw

```sh
cd /home/youruser/code
git clone https://github.com/yourorg/nanoclaw.git
cd nanoclaw/src
```

### Step 4: Create ZFS Datasets

```sh
# Create the jail hierarchy
sudo zfs create -p zroot/nanoclaw/jails/template

# Create directories
mkdir -p /home/youruser/code/nanoclaw/jails
mkdir -p /home/youruser/code/nanoclaw/workspaces
mkdir -p /home/youruser/code/nanoclaw/ipc
```

### Step 5: Build the Jail Template

```sh
# Fetch FreeBSD base system
cd /home/youruser/code/nanoclaw/jails
sudo fetch https://download.freebsd.org/releases/amd64/15.0-RELEASE/base.txz

# Extract to template
sudo tar -xf base.txz -C template

# Install packages inside template
sudo pkg -c template install -y node24 npm-node24

# Create node user (uid 1000) in template
sudo pw -R template useradd node -u 1000 -g wheel -d /home/node -s /bin/sh
sudo mkdir -p template/home/node
sudo chown 1000:0 template/home/node

# Copy DNS configuration
sudo cp /etc/resolv.conf template/etc/resolv.conf

# Run the template setup script
./scripts/setup-jail-template.sh
```

### Step 6: Configure Environment

```sh
# Create .env file
cat > .env << 'EOF'
NANOCLAW_RUNTIME=jail
ANTHROPIC_API_KEY=sk-ant-...your-key-here...
NANOCLAW_JAIL_NETWORK_MODE=inherit
EOF
```

### Step 7: Build and Run

```sh
npm ci
npm run build
npm run dev
```

### Step 8: Test

Send a message to your configured Telegram bot mentioning the trigger word. The agent should respond.

## 4. Architecture

### Jail Lifecycle

```
1. Message arrives at orchestrator
2. container-runner.ts calls jail-runtime.js
3. ZFS clone: zroot/nanoclaw/jails/template@base -> zroot/nanoclaw/jails/nanoclaw_groupname
4. Create mount points inside jail
5. nullfs mounts: project(ro), group(rw), ipc(rw), claude-session(rw), agent-runner(ro)
6. jail -c with vnet (restricted mode) or ip4=inherit (dev mode)
7. jexec -U node runs entrypoint script
8. Agent processes message, writes response
9. Cleanup: jail -r, umount all, zfs destroy clone
```

### Mount Layout

The jail has 5 semantic mounts:

| Jail Path | Host Path | Mode | Purpose |
|-----------|-----------|------|---------|
| `/workspace/project` | NanoClaw source | ro | Project code access (main only) |
| `/workspace/group` | `groups/{name}` | rw | Group's workspace and CLAUDE.md |
| `/workspace/ipc` | `ipc/{name}` | rw | IPC messages, tasks, input queue |
| `/home/node/.claude` | `data/sessions/{name}/.claude` | rw | Claude session data |
| `/app/src` | `container/agent-runner/src` | ro | Agent runner TypeScript source |

### Networking Modes

#### Development Mode (inherit)

```sh
# Set in .env or environment
NANOCLAW_JAIL_NETWORK_MODE=inherit
```

- Jail inherits host's full network stack
- No pf rules needed
- Agent can reach any destination
- Good for development and debugging

#### Production Mode (restricted)

```sh
# Set in .env or environment
NANOCLAW_JAIL_NETWORK_MODE=restricted
```

- Each jail gets its own vnet (virtual network stack)
- epair interface pair connects jail to host
- pf NAT on host's external interface
- Egress restricted to:
  - DNS (port 53 UDP/TCP)
  - api.anthropic.com:443
- All other egress blocked

### Template System

The template is a complete FreeBSD userland with:

- Base system (`base.txz`)
- Node.js 24 and npm
- Global TypeScript
- Global Claude Code CLI
- Agent runner dependencies at `/app/node_modules`
- Entrypoint script at `/app/entrypoint.sh`

Template is snapshotted at `zroot/nanoclaw/jails/template@base`. Each jail clones this snapshot for instant startup.

### Session Persistence

Claude session data persists at `data/sessions/{group}/.claude/`:

- `settings.json` — SDK configuration
- `skills/` — Synced from `container/skills/`
- Session transcripts

This directory is mounted into each jail, preserving conversation history across container restarts.

## 5. Networking

### Development Mode Details

With `NANOCLAW_JAIL_NETWORK_MODE=inherit`:

```sh
jail -c name=nanoclaw_test path=/path/to/jail ip4=inherit ip6=inherit ...
```

The jail shares the host's network stack entirely. No additional configuration needed.

### Production Mode Details

With `NANOCLAW_JAIL_NETWORK_MODE=restricted`:

#### Per-Jail Network Setup

```
Host                          Jail
+-------------------+         +-------------------+
| epair0a           |<------->| epair0b           |
| 10.99.0.1/30      |         | 10.99.0.2/30      |
| (gateway)         |         | (jail IP)         |
+-------------------+         +-------------------+
        |
        | NAT via pf
        v
+-------------------+
| re0 (external)    |
| your.public.ip    |
+-------------------+
        |
        v
    Internet
```

Each jail gets its own /30 subnet. Multiple jails can run simultaneously without IP conflicts (each has its own vnet).

#### pf Configuration

Install the pf rules:

```sh
# Enable IP forwarding (required for NAT)
sudo sysctl net.inet.ip.forwarding=1

# Make persistent
echo 'net.inet.ip.forwarding=1' | sudo tee -a /etc/sysctl.conf

# Enable pf in /etc/rc.conf
sudo sysrc pf_enable="YES"
sudo sysrc pf_rules="/home/jims/code/nanoclaw/src/etc/pf-nanoclaw.conf"

# Load the ruleset
sudo pfctl -f /home/jims/code/nanoclaw/src/etc/pf-nanoclaw.conf

# Enable pf
sudo pfctl -e
```

#### pf Rules Explained

```
# External interface (change for your system - em0, igb0, etc.)
ext_if = "re0"

# Jail network
jail_net = "10.99.0.0/30"

# Allowed destinations
table <anthropic_api> persist { api.anthropic.com }

# NAT jail traffic to internet
nat on $ext_if from $jail_net to any -> ($ext_if)

# Allow DNS
pass out quick on $ext_if proto udp from $jail_net to any port 53 keep state
pass out quick on $ext_if proto tcp from $jail_net to any port 53 keep state

# Allow Claude API
pass out quick on $ext_if proto tcp from $jail_net to <anthropic_api> port 443 keep state

# Block all other jail traffic
block return log quick on $ext_if from $jail_net to any
```

#### Customizing Allowed Destinations

To allow additional destinations, edit `src/etc/pf-nanoclaw.conf`:

```sh
# Add a new table
table <github_api> persist { api.github.com }

# Add a pass rule (before the block rule)
pass out quick on $ext_if proto tcp from $jail_net to <github_api> port 443 keep state
```

Reload rules:

```sh
sudo pfctl -f /home/jims/code/nanoclaw/src/etc/pf-nanoclaw.conf
```

#### Verifying Network Isolation

```sh
# Start a test jail
sudo jail -c name=test path=/path/to/jail vnet persist

# Should work (Claude API)
sudo jexec test curl -I https://api.anthropic.com

# Should be blocked
sudo jexec test curl -I https://google.com

# Watch blocked packets
sudo tcpdump -n -e -ttt -i pflog0
```

## 6. Permissions Model

### Host Side

- **User**: Non-root (e.g., `jims`) in wheel group
- **Ownership**: Files created by user are owned by user
- **Group directories**: Mode 2775 (setgid), group wheel

### Jail Side

- **User**: `node` (uid 1000)
- **Supplementary group**: wheel (gid 0)
- **umask**: 002 (files created are group-writable)

### Shared Access

The wheel group (gid 0) is shared between host user and jail's node user:

```
Host:  jims:wheel  (uid 501, gid 0)
Jail:  node:wheel  (uid 1000, primary gid 0)
```

Directories use setgid (mode 2775) so new files inherit the wheel group, allowing both host and jail to read/write.

### Sudoers Configuration

Add to `/usr/local/etc/sudoers.d/nanoclaw`:

```
# Jail operations
jims ALL=(ALL) NOPASSWD: /usr/sbin/jail
jims ALL=(ALL) NOPASSWD: /usr/sbin/jexec
jims ALL=(ALL) NOPASSWD: /usr/sbin/jls

# ZFS operations
jims ALL=(ALL) NOPASSWD: /sbin/zfs

# Mount operations
jims ALL=(ALL) NOPASSWD: /sbin/mount*
jims ALL=(ALL) NOPASSWD: /sbin/umount

# Network operations (for restricted mode)
jims ALL=(ALL) NOPASSWD: /sbin/ifconfig
```

## 7. Template Management

### Initial Template Creation

The template setup script (`scripts/setup-jail-template.sh`) handles:

1. Booting template as temporary jail
2. Installing global npm packages
3. Copying agent-runner source
4. Installing dependencies
5. Creating workspace structure
6. Snapshotting the result

### Updating the Template

After modifying agent-runner or dependencies:

```sh
# First, destroy all active jail clones
sudo zfs list -H -o name -t filesystem | grep 'zroot/nanoclaw/jails/nanoclaw_' | while read ds; do
  sudo zfs destroy -r "$ds"
done

# Re-run template setup
./scripts/setup-jail-template.sh
```

### Template Contents

```
/
├── app/
│   ├── entrypoint.sh          # Startup script
│   ├── package.json           # Agent runner deps
│   ├── node_modules/          # Installed dependencies
│   ├── src/                   # Agent runner source
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

### Dependent Clones Error

If you see:

```
Cannot update template: snapshot has dependent clones:
zroot/nanoclaw/jails/nanoclaw_mygroup
```

You must destroy all jail datasets first:

```sh
# List clones
sudo zfs list -H -o name -t filesystem | grep nanoclaw_

# Destroy them
sudo zfs destroy -r zroot/nanoclaw/jails/nanoclaw_mygroup
```

## 8. Troubleshooting

### "dataset already exists"

**Cause**: Stale jail from previous crash.

**Fix**:
```sh
# Find the jail
sudo jls

# Stop it
sudo jail -r nanoclaw_groupname

# Unmount filesystems
sudo umount -f /path/to/jail/dev
sudo umount -f /path/to/jail/workspace/project
# ... repeat for all mounts

# Destroy dataset
sudo zfs destroy -r zroot/nanoclaw/jails/nanoclaw_groupname
```

### "node: no such user"

**Cause**: Using lowercase `-u` instead of uppercase `-U` with jexec.

**Fix**: Use `jexec -U node` (capital U for username lookup).

### "Operation not permitted" on chmod

**Cause**: Files owned by uid 1000 (jail's node user), trying to chmod from host.

**Fix**: Use sudo or run the operation inside the jail.

### devfs busy on cleanup

**Cause**: Jail not fully stopped before attempting unmount.

**Fix**:
```sh
# Kill all processes in jail
sudo jexec jailname kill -9 -1

# Stop jail
sudo jail -r jailname

# Wait a moment, then unmount
sleep 1
sudo umount -f /path/to/jail/dev
```

### Agent says "Not logged in"

**Cause**: ANTHROPIC_API_KEY not set or not passed to jail environment.

**Fix**:
```sh
# Check .env has the key
grep ANTHROPIC_API_KEY .env

# Verify it's exported
echo $ANTHROPIC_API_KEY
```

### DNS resolution failure

**Cause**: resolv.conf not copied or pf blocking DNS.

**Fix**:
```sh
# Check jail has resolv.conf
cat /path/to/jail/etc/resolv.conf

# For restricted mode, verify pf allows DNS
sudo pfctl -s rules | grep "port 53"
```

### TypeScript compilation fails

**Cause**: Missing dependencies in template.

**Fix**:
```sh
# Re-run template setup
./scripts/setup-jail-template.sh

# Or manually check
sudo jexec nanoclaw_template npm list -g
```

## 9. Security Comparison

| Aspect | Docker | Apple Container | FreeBSD Jails |
|--------|--------|-----------------|---------------|
| **Isolation mechanism** | namespaces + cgroups | xnu sandbox | jail(8) kernel |
| **Filesystem isolation** | overlayfs/devicemapper | APFS snapshots | ZFS clones |
| **Network isolation** | bridge/NAT/none | sandbox rules | vnet + epair + pf |
| **Resource limits** | cgroups v1/v2 | sandbox limits | rctl(8) |
| **Requires root daemon** | dockerd (rootless possible) | containermanagerd | No daemon |
| **Startup time** | 1-3 seconds | 1-2 seconds | <100ms |
| **Storage efficiency** | Layer dedup varies | APFS clones | ZFS block-level COW |
| **Platform** | Linux, macOS (VM), Windows (VM) | macOS 15+ | FreeBSD |
| **Security audit** | Extensive CVE history | New, less scrutiny | 25+ years of hardening |
| **Process visibility** | `docker ps` | Container API | `jls`, `ps` |

### Jail Security Features

- **chflags schg**: System files immutable even to root inside jail
- **securelevel**: Prevent lowering security level
- **allow.* params**: Fine-grained capability control
- **vnet**: True network stack isolation (not just filtering)
- **ZFS properties**: Quota, reservation, compression per-jail

## 10. Configuration Reference

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NANOCLAW_RUNTIME` | `docker` | Set to `jail` for FreeBSD jails |
| `ANTHROPIC_API_KEY` | — | API key for Claude |
| `NANOCLAW_JAIL_NETWORK_MODE` | `inherit` | `inherit` or `restricted` |

### jail-runtime.js Constants

```javascript
export const JAIL_CONFIG = {
  templateDataset: 'zroot/nanoclaw/jails/template',
  templateSnapshot: 'base',
  jailsDataset: 'zroot/nanoclaw/jails',
  jailsPath: '/home/jims/code/nanoclaw/jails',
  workspacesPath: '/home/jims/code/nanoclaw/workspaces',
  ipcPath: '/home/jims/code/nanoclaw/ipc',
  networkMode: process.env.NANOCLAW_JAIL_NETWORK_MODE || 'inherit',
  jailHostIP: '10.99.0.1',
  jailIP: '10.99.0.2',
  jailNetmask: '30',
};
```

Update these values in `src/jail-runtime.js` if your paths differ.

### pf-nanoclaw.conf Customization

Key customization points:

```
# Change external interface (line ~70)
ext_if = "re0"  # Change to em0, igb0, etc.

# Add allowed destinations (before block rule)
table <my_api> persist { api.example.com }
pass out quick on $ext_if proto tcp from $jail_net to <my_api> port 443 keep state

# Refresh Anthropic IPs if needed
sudo pfctl -t anthropic_api -T replace api.anthropic.com
```

### Sudoers File

Complete sudoers configuration at `/usr/local/etc/sudoers.d/nanoclaw`:

```
# NanoClaw jail runtime operations
# Replace 'jims' with your username

# Jail management
jims ALL=(ALL) NOPASSWD: /usr/sbin/jail
jims ALL=(ALL) NOPASSWD: /usr/sbin/jexec
jims ALL=(ALL) NOPASSWD: /usr/sbin/jls

# ZFS operations
jims ALL=(ALL) NOPASSWD: /sbin/zfs

# Filesystem operations
jims ALL=(ALL) NOPASSWD: /sbin/mount
jims ALL=(ALL) NOPASSWD: /sbin/mount_nullfs
jims ALL=(ALL) NOPASSWD: /sbin/umount

# Network operations (restricted mode only)
jims ALL=(ALL) NOPASSWD: /sbin/ifconfig
jims ALL=(ALL) NOPASSWD: /sbin/route

# Directory operations
jims ALL=(ALL) NOPASSWD: /bin/mkdir
jims ALL=(ALL) NOPASSWD: /bin/chmod
jims ALL=(ALL) NOPASSWD: /usr/sbin/chown
jims ALL=(ALL) NOPASSWD: /bin/cp
jims ALL=(ALL) NOPASSWD: /bin/sh
jims ALL=(ALL) NOPASSWD: /bin/cat
```

---

## Notes

- **Test system**: This documentation was developed on "scratchy" (FreeBSD 15.0-RELEASE amd64)
- **ZFS pool**: Examples use `zroot` — adjust for your pool name
- **User**: Examples use `jims` — replace with your username
- **Interface**: Examples use `re0` — check your interface with `ifconfig`
