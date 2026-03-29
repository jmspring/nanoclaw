#!/bin/sh
# Add Chromium and agent-browser to an existing NanoClaw jail template.
#
# This is an OPTIONAL addon for browser automation. It adds ~500MB to the
# template size. Only install if your agents need browser-based research,
# web scraping, or Playwright testing.
#
# Usage:
#   ./add-chromium-to-template.sh                # modify default "template"
#   ./add-chromium-to-template.sh template-v2    # modify "template-v2"
#
# Prerequisites:
#   - Template must already exist (built via setup-jail-template.sh)
#   - Template snapshot @base must exist

set -eu

# Optional argument: template name (default: "template")
TEMPLATE_NAME="${1:-template}"

# Configuration — override via environment variables or NANOCLAW_ROOT
NANOCLAW_ROOT="${NANOCLAW_ROOT:-/home/nanoclaw}"
JAILS_PATH="${NANOCLAW_JAILS_PATH:-${NANOCLAW_ROOT}/jails}"
JAILS_DATASET="${NANOCLAW_JAILS_DATASET:-zroot/nanoclaw/jails}"
TEMPLATE_PATH="${JAILS_PATH}/${TEMPLATE_NAME}"
TEMPLATE_DATASET="${JAILS_DATASET}/${TEMPLATE_NAME}"
SNAPSHOT_NAME="base"
FULL_SNAPSHOT="${TEMPLATE_DATASET}@${SNAPSHOT_NAME}"
TEMP_JAIL_NAME="nanoclaw_chromium_setup"

log() { echo "[chromium-addon] $*"; }
error() { echo "[chromium-addon] ERROR: $*" >&2; exit 1; }

# Prerequisite checks
log "Checking prerequisites..."
if ! sudo zfs list "$TEMPLATE_DATASET" >/dev/null 2>&1; then
    error "Template dataset not found: $TEMPLATE_DATASET"
fi
if ! sudo zfs list -t snapshot "$FULL_SNAPSHOT" >/dev/null 2>&1; then
    error "Template snapshot not found: $FULL_SNAPSHOT"
fi
log "Prerequisites OK"

# Cleanup trap — stop jail and unmount devfs on exit
cleanup() {
    if sudo jls -j "$TEMP_JAIL_NAME" jid >/dev/null 2>&1; then
        log "Cleaning up: stopping temporary jail..."
        sudo jail -r "$TEMP_JAIL_NAME"
    fi
    if mount | grep -q "${TEMPLATE_PATH}/dev"; then
        log "Cleaning up: unmounting devfs..."
        sudo umount "${TEMPLATE_PATH}/dev"
    fi
}
trap cleanup EXIT

# Stop any running jail with this name
if sudo jls -j "$TEMP_JAIL_NAME" jid >/dev/null 2>&1; then
    log "Stopping existing temporary jail..."
    sudo jail -r "$TEMP_JAIL_NAME"
fi

# Boot template as temporary jail
log "Starting temporary jail for Chromium installation..."
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

# Install Chromium
log "Installing Chromium (this may take a few minutes)..."
sudo jexec "$TEMP_JAIL_NAME" pkg install -y chromium

# Set browser environment variables
log "Configuring browser environment variables..."
sudo jexec "$TEMP_JAIL_NAME" sh -c 'mkdir -p /usr/local/etc/profile.d && cat > /usr/local/etc/profile.d/chromium.sh << "ENVEOF"
export AGENT_BROWSER_EXECUTABLE_PATH=/usr/local/bin/chromium
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/local/bin/chromium
ENVEOF'

# Install agent-browser globally
log "Installing agent-browser..."
sudo jexec "$TEMP_JAIL_NAME" npm install -g agent-browser

# Verify installation
log "Verifying installation..."
if ! sudo jexec "$TEMP_JAIL_NAME" test -f /usr/local/bin/chromium; then
    error "Chromium binary not found at /usr/local/bin/chromium"
fi
if ! sudo jexec "$TEMP_JAIL_NAME" npm list -g agent-browser >/dev/null 2>&1; then
    error "agent-browser not found in global npm packages"
fi
log "Verification passed: Chromium and agent-browser installed"

# Stop jail and unmount devfs
log "Stopping temporary jail..."
sudo jail -r "$TEMP_JAIL_NAME"
if mount | grep -q "${TEMPLATE_PATH}/dev"; then
    log "Unmounting devfs..."
    sudo umount "${TEMPLATE_PATH}/dev"
fi

# Re-snapshot with backup/restore pattern
log "Managing template snapshot..."

BACKUP_SNAPSHOT="${TEMPLATE_DATASET}@base-backup"

# Back up existing snapshot
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
    error "Failed to create snapshot"
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

VALIDATION_OK=true
if sudo zfs clone "$FULL_SNAPSHOT" "$VALIDATION_CLONE" 2>&1; then
    log "    Clone test: SUCCESS"

    # Verify the clone contains expected files
    if [ -f "${VALIDATION_PATH}/app/entrypoint.sh" ] && \
       [ -d "${VALIDATION_PATH}/app/node_modules" ]; then
        log "    Contents verification: SUCCESS"
    else
        log "    Contents verification: FAILED (missing expected files)"
        VALIDATION_OK=false
    fi

    # Clean up validation clone
    sudo zfs destroy "$VALIDATION_CLONE"
else
    log "    Clone test: FAILED"
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

# Regenerate SHA-256 manifest
MANIFEST_PATH="${JAILS_PATH}/${TEMPLATE_NAME}.sha256"
log "  Generating integrity manifest: $MANIFEST_PATH"
if sudo zfs send "$FULL_SNAPSHOT" | sha256 > "${MANIFEST_PATH}.tmp" 2>/dev/null; then
    mv "${MANIFEST_PATH}.tmp" "$MANIFEST_PATH"
    log "  Manifest written: $MANIFEST_PATH"
else
    log "  WARNING: Could not generate SHA-256 manifest (sha256 not available)"
    rm -f "${MANIFEST_PATH}.tmp"
fi

log ""
log "Chromium addon installed. Template size increased by ~500MB."
log "Browser automation (agent-browser) is now available in jails."
