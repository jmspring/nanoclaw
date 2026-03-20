#!/bin/sh
#
# Setup NanoClaw jail template with all required dependencies
#
# This script:
# 1. Boots the template as a temporary jail
# 2. Installs global npm packages (typescript, @anthropic-ai/claude-code)
# 3. Sets up /app with agent-runner source and dependencies
# 4. Verifies everything works
# 5. Re-snapshots the template
#
# Requirements:
# - Run as a user with passwordless sudo access
#   See docs/TEMPLATE_SETUP.md for detailed sudo requirements and minimal
#   sudoers configuration
# - ZFS dataset zroot/nanoclaw/jails/template must exist
# - Template must already have node24 and npm-node24 installed via pkg
#

set -eu

# Configuration
TEMPLATE_PATH="/home/jims/code/nanoclaw/jails/template"
TEMPLATE_DATASET="zroot/nanoclaw/jails/template"
SNAPSHOT_NAME="base"
AGENT_RUNNER_SRC="/home/jims/code/nanoclaw/src/container/agent-runner"
TEMP_JAIL_NAME="nanoclaw_template_setup"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() {
    echo "${GREEN}[setup]${NC} $1"
}

warn() {
    echo "${YELLOW}[warn]${NC} $1"
}

error() {
    echo "${RED}[error]${NC} $1"
    exit 1
}

cleanup() {
    log "Cleaning up..."
    # Stop jail if running
    if sudo jls -j "$TEMP_JAIL_NAME" jid >/dev/null 2>&1; then
        log "Stopping temporary jail..."
        sudo jail -r "$TEMP_JAIL_NAME" 2>/dev/null || true
    fi
    # Unmount devfs if still mounted
    if mount | grep -q "${TEMPLATE_PATH}/dev"; then
        log "Unmounting devfs..."
        sudo umount "${TEMPLATE_PATH}/dev" 2>/dev/null || true
    fi

    # If backup snapshot exists and base snapshot doesn't, offer restoration
    BACKUP_SNAPSHOT="${TEMPLATE_DATASET}@base-backup"
    FULL_SNAPSHOT="${TEMPLATE_DATASET}@${SNAPSHOT_NAME}"
    if sudo zfs list -t snapshot "$BACKUP_SNAPSHOT" >/dev/null 2>&1 && \
       ! sudo zfs list -t snapshot "$FULL_SNAPSHOT" >/dev/null 2>&1; then
        warn "Backup snapshot exists but base snapshot does not."
        warn "To restore: sudo zfs rename $BACKUP_SNAPSHOT $FULL_SNAPSHOT"
    fi
}

trap cleanup EXIT

# Check prerequisites
log "Checking prerequisites..."

if [ ! -d "$TEMPLATE_PATH" ]; then
    error "Template path does not exist: $TEMPLATE_PATH"
fi

if ! sudo zfs list "$TEMPLATE_DATASET" >/dev/null 2>&1; then
    error "Template dataset does not exist: $TEMPLATE_DATASET"
fi

if [ ! -d "$AGENT_RUNNER_SRC" ]; then
    error "Agent runner source not found: $AGENT_RUNNER_SRC"
fi

if [ ! -f "$AGENT_RUNNER_SRC/package.json" ]; then
    error "Agent runner package.json not found"
fi

# Check for dependent clones of the base snapshot
log "Checking for dependent clones..."
FULL_SNAPSHOT="${TEMPLATE_DATASET}@${SNAPSHOT_NAME}"
if sudo zfs list -t snapshot "$FULL_SNAPSHOT" >/dev/null 2>&1; then
    CLONES=$(sudo zfs list -H -o clones "$FULL_SNAPSHOT" 2>/dev/null | grep -v '^-$' || true)
    if [ -n "$CLONES" ]; then
        error "Cannot update template: snapshot has dependent clones:
$CLONES

Please destroy these clones first, then re-run this script."
    fi
fi

# Check node is available in template
if [ ! -x "$TEMPLATE_PATH/usr/local/bin/node" ]; then
    error "Node not found in template. Install node24 package first:
  sudo pkg -c $TEMPLATE_PATH install -y node24 npm-node24"
fi

log "Prerequisites OK"

# Stop any running jail with this name
if sudo jls -j "$TEMP_JAIL_NAME" jid >/dev/null 2>&1; then
    log "Stopping existing temporary jail..."
    sudo jail -r "$TEMP_JAIL_NAME"
fi

# Boot the template as a temporary jail
log "Starting temporary jail for setup..."
sudo jail -c \
    name="$TEMP_JAIL_NAME" \
    path="$TEMPLATE_PATH" \
    host.hostname="$TEMP_JAIL_NAME" \
    ip4=inherit \
    ip6=inherit \
    allow.raw_sockets \
    mount.devfs \
    devfs_ruleset=10 \
    persist

log "Jail started: $TEMP_JAIL_NAME"

# Function to execute commands in the jail
jexec_cmd() {
    sudo jexec "$TEMP_JAIL_NAME" "$@"
}

# Install global npm packages
log "Installing TypeScript globally..."
jexec_cmd npm install -g typescript

log "Installing Claude Code CLI globally..."
jexec_cmd npm install -g @anthropic-ai/claude-code

# Create /app directory structure
log "Creating /app directory structure..."
jexec_cmd mkdir -p /app/src

# Copy agent-runner files into the jail
log "Copying agent-runner source files..."
sudo cp "$AGENT_RUNNER_SRC/package.json" "$TEMPLATE_PATH/app/"
sudo cp "$AGENT_RUNNER_SRC/package-lock.json" "$TEMPLATE_PATH/app/" 2>/dev/null || true
sudo cp "$AGENT_RUNNER_SRC/tsconfig.json" "$TEMPLATE_PATH/app/"
sudo cp -r "$AGENT_RUNNER_SRC/src/"* "$TEMPLATE_PATH/app/src/"

# Install agent-runner dependencies
log "Installing agent-runner dependencies (this may take a moment)..."
jexec_cmd sh -c 'cd /app && npm install'

# Pre-compile TypeScript in template (nan-fmb6: reduces per-jail overhead)
log "Pre-compiling TypeScript in template..."
jexec_cmd sh -c 'cd /app && npm run build'

# Verify compiled output exists
if [ ! -d "$TEMPLATE_PATH/app/dist" ]; then
    error "TypeScript compilation failed - /app/dist not found"
fi
if [ ! -f "$TEMPLATE_PATH/app/dist/index.js" ]; then
    error "TypeScript compilation failed - /app/dist/index.js not found"
fi
log "  TypeScript pre-compiled successfully"

# Create workspace directories (matching Docker)
log "Creating workspace directories..."
jexec_cmd mkdir -p /workspace/group /workspace/global /workspace/extra
jexec_cmd mkdir -p /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create home directory for node user
log "Creating /home/node directory..."
jexec_cmd mkdir -p /home/node/.claude
jexec_cmd chmod 777 /home/node

# Create tmp directory if needed
jexec_cmd mkdir -p /tmp
jexec_cmd chmod 1777 /tmp

# Create entrypoint script (matching Docker)
log "Creating entrypoint script..."
cat << 'EOF' | sudo tee "$TEMPLATE_PATH/app/entrypoint.sh" > /dev/null
#!/bin/sh
set -e
cd /app

# Skip TypeScript compilation if already pre-compiled in template (nan-fmb6)
if [ -d /app/dist ] && [ -f /app/dist/index.js ]; then
  # Use pre-compiled TypeScript from template
  cat > /tmp/input.json
  exec node /app/dist/index.js < /tmp/input.json
else
  # Fallback: compile TypeScript at runtime (legacy behavior)
  npx tsc --outDir /tmp/dist 2>&1 >&2
  ln -sf /app/node_modules /tmp/dist/node_modules
  chmod -R a-w /tmp/dist
  cat > /tmp/input.json
  exec node /tmp/dist/index.js < /tmp/input.json
fi
EOF
sudo chmod +x "$TEMPLATE_PATH/app/entrypoint.sh"

# Verify installations
log "Verifying installations..."

log "  Checking node..."
NODE_VERSION=$(jexec_cmd node --version)
log "    Node version: $NODE_VERSION"

log "  Checking npm..."
NPM_VERSION=$(jexec_cmd npm --version)
log "    npm version: $NPM_VERSION"

log "  Checking tsc..."
TSC_VERSION=$(jexec_cmd npx tsc --version)
log "    TypeScript version: $TSC_VERSION"

log "  Checking claude (CLI)..."
if jexec_cmd which claude >/dev/null 2>&1; then
    CLAUDE_VERSION=$(jexec_cmd claude --version 2>/dev/null | head -1 || echo "installed")
    log "    Claude CLI: $CLAUDE_VERSION"
else
    warn "    Claude CLI not found in PATH (may be OK if installed differently)"
fi

log "  Checking agent-runner dependencies..."
if [ -d "$TEMPLATE_PATH/app/node_modules/@anthropic-ai/claude-agent-sdk" ]; then
    log "    @anthropic-ai/claude-agent-sdk: installed"
else
    error "    @anthropic-ai/claude-agent-sdk: NOT FOUND"
fi

if [ -d "$TEMPLATE_PATH/app/node_modules/@modelcontextprotocol/sdk" ]; then
    log "    @modelcontextprotocol/sdk: installed"
else
    error "    @modelcontextprotocol/sdk: NOT FOUND"
fi

# Test compile the agent-runner
log "  Test compiling agent-runner..."
if jexec_cmd sh -c 'cd /app && npx tsc --outDir /tmp/test-dist 2>&1'; then
    log "    TypeScript compilation: SUCCESS"
    jexec_cmd rm -rf /tmp/test-dist
else
    error "    TypeScript compilation: FAILED"
fi

# Stop the temporary jail
log "Stopping temporary jail..."
sudo jail -r "$TEMP_JAIL_NAME"

# Unmount devfs if still mounted
if mount | grep -q "${TEMPLATE_PATH}/dev"; then
    log "Unmounting devfs..."
    sudo umount "${TEMPLATE_PATH}/dev"
fi

# Handle the snapshot
log "Managing template snapshot..."

BACKUP_SNAPSHOT="${TEMPLATE_DATASET}@base-backup"

# If an old snapshot exists, rename it to backup instead of destroying
if sudo zfs list -t snapshot "$FULL_SNAPSHOT" >/dev/null 2>&1; then
    log "  Backing up existing snapshot: $FULL_SNAPSHOT -> $BACKUP_SNAPSHOT"

    # Destroy old backup if it exists
    if sudo zfs list -t snapshot "$BACKUP_SNAPSHOT" >/dev/null 2>&1; then
        log "    Removing old backup snapshot..."
        sudo zfs destroy "$BACKUP_SNAPSHOT"
    fi

    # Rename current snapshot to backup
    sudo zfs rename "$FULL_SNAPSHOT" "$BACKUP_SNAPSHOT"
fi

log "  Creating new snapshot: $FULL_SNAPSHOT"
sudo zfs snapshot "$FULL_SNAPSHOT"

# Verify snapshot was created
if ! sudo zfs list -t snapshot "$FULL_SNAPSHOT" >/dev/null 2>&1; then
    error "  Failed to create snapshot"
fi

log "  Snapshot created successfully"

# Validate the new snapshot by testing a clone
log "  Validating new snapshot..."
VALIDATION_CLONE="${TEMPLATE_DATASET}_validate_$$"
VALIDATION_PATH="${TEMPLATE_PATH}_validate_$$"

validate_cleanup() {
    if sudo zfs list "$VALIDATION_CLONE" >/dev/null 2>&1; then
        sudo zfs destroy "$VALIDATION_CLONE"
    fi
}

trap 'validate_cleanup; cleanup' EXIT

if sudo zfs clone "$FULL_SNAPSHOT" "$VALIDATION_CLONE" 2>&1; then
    log "    Clone test: SUCCESS"

    # Verify the clone mountpoint exists and contains expected files
    if [ -f "${VALIDATION_PATH}/app/entrypoint.sh" ] && \
       [ -d "${VALIDATION_PATH}/app/node_modules" ]; then
        log "    Contents verification: SUCCESS"
        VALIDATION_OK=true
    else
        warn "    Contents verification: FAILED (missing expected files)"
        VALIDATION_OK=false
    fi

    # Clean up validation clone
    sudo zfs destroy "$VALIDATION_CLONE"
else
    warn "    Clone test: FAILED"
    VALIDATION_OK=false
fi

# If validation failed, restore from backup
if [ "$VALIDATION_OK" = "false" ]; then
    error "Snapshot validation failed. Restoring from backup...

To restore manually:
  sudo zfs destroy $FULL_SNAPSHOT
  sudo zfs rename $BACKUP_SNAPSHOT $FULL_SNAPSHOT"
fi

# Validation succeeded, destroy backup
if sudo zfs list -t snapshot "$BACKUP_SNAPSHOT" >/dev/null 2>&1; then
    log "  Removing backup snapshot (validation passed)..."
    sudo zfs destroy "$BACKUP_SNAPSHOT"
fi

log ""
log "=========================================="
log "Template setup complete!"
log "=========================================="
log ""
log "Installed packages:"
log "  - Node.js $NODE_VERSION"
log "  - TypeScript (global)"
log "  - @anthropic-ai/claude-code (global)"
log "  - Agent runner dependencies at /app/node_modules"
log ""
log "Template snapshot: $FULL_SNAPSHOT"
log ""
log "The jail template is ready for use."
