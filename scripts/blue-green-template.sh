#!/bin/sh
# Blue/green template update for NanoClaw jails.
#
# Builds a new template alongside the current one, verifies it,
# and switches the active template. Old jails continue using their
# existing template until destroyed.
#
# Usage:
#   ./blue-green-template.sh                     # auto-generate name
#   ./blue-green-template.sh --name template-v2  # explicit name
#   ./blue-green-template.sh --restart           # restart NanoClaw after switch
#   ./blue-green-template.sh --cleanup           # remove old template after switch
#
# The script:
#   1. Builds a new template (via setup-jail-template.sh)
#   2. Verifies the new template by creating and destroying a test clone
#   3. Updates the service environment to use the new template
#   4. Optionally restarts NanoClaw
#   5. Optionally cleans up the old template

set -euo pipefail

# Parse arguments
NEW_TEMPLATE_NAME=""
DO_RESTART="false"
DO_CLEANUP="false"

while [ $# -gt 0 ]; do
    case "$1" in
        --name)
            NEW_TEMPLATE_NAME="$2"
            shift 2
            ;;
        --restart)
            DO_RESTART="true"
            shift
            ;;
        --cleanup)
            DO_CLEANUP="true"
            shift
            ;;
        *)
            echo "Unknown option: $1" >&2
            echo "Usage: $0 [--name <name>] [--restart] [--cleanup]" >&2
            exit 1
            ;;
    esac
done

# Default template name based on timestamp
if [ -z "$NEW_TEMPLATE_NAME" ]; then
    NEW_TEMPLATE_NAME="template-$(date +%Y%m%d%H%M)"
fi

# Configuration
NANOCLAW_ROOT="${NANOCLAW_ROOT:-/home/nanoclaw}"
JAILS_DATASET="${NANOCLAW_JAILS_DATASET:-zroot/nanoclaw/jails}"
JAILS_PATH="${NANOCLAW_JAILS_PATH:-${NANOCLAW_ROOT}/jails}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Determine current template
CURRENT_DATASET="${NANOCLAW_TEMPLATE_DATASET:-${JAILS_DATASET}/template}"
CURRENT_TEMPLATE_NAME="${CURRENT_DATASET##*/}"

log() { echo "[blue-green] $*"; }
error() { echo "[blue-green] ERROR: $*" >&2; exit 1; }

log "Blue/green template update"
log "  Current template: $CURRENT_TEMPLATE_NAME ($CURRENT_DATASET)"
log "  New template:     $NEW_TEMPLATE_NAME"

# Step 1 — Build new template
log ""
log "Step 1: Building new template: $NEW_TEMPLATE_NAME"
if [ ! -x "${SCRIPT_DIR}/setup-jail-template.sh" ]; then
    error "setup-jail-template.sh not found at ${SCRIPT_DIR}/setup-jail-template.sh"
fi
"${SCRIPT_DIR}/setup-jail-template.sh" "$NEW_TEMPLATE_NAME"

# Step 2 — Verify new template
log ""
log "Step 2: Verifying new template..."
NEW_DATASET="${JAILS_DATASET}/${NEW_TEMPLATE_NAME}"
TEST_CLONE="${NEW_DATASET}_verify_$$"
TEST_PATH="${JAILS_PATH}/${NEW_TEMPLATE_NAME}_verify_$$"

if ! sudo zfs clone "${NEW_DATASET}@base" "$TEST_CLONE" 2>&1; then
    error "Failed to create verification clone"
fi

if [ -f "${TEST_PATH}/app/entrypoint.sh" ] && \
   [ -d "${TEST_PATH}/app/node_modules" ]; then
    log "  Verification: PASSED"
else
    log "  Verification: FAILED — missing expected files"
    sudo zfs destroy "$TEST_CLONE"
    exit 1
fi
sudo zfs destroy "$TEST_CLONE"

# Step 3 — Update service environment
log ""
log "Step 3: Switching active template to $NEW_TEMPLATE_NAME"
ENV_FILE="${NANOCLAW_ROOT}/src/.env"
if [ -f "$ENV_FILE" ]; then
    if grep -q "^NANOCLAW_TEMPLATE_DATASET=" "$ENV_FILE"; then
        sed -i '' "s|^NANOCLAW_TEMPLATE_DATASET=.*|NANOCLAW_TEMPLATE_DATASET=${NEW_DATASET}|" "$ENV_FILE"
    else
        echo "NANOCLAW_TEMPLATE_DATASET=${NEW_DATASET}" >> "$ENV_FILE"
    fi
else
    echo "NANOCLAW_TEMPLATE_DATASET=${NEW_DATASET}" > "$ENV_FILE"
fi
log "  Updated .env: NANOCLAW_TEMPLATE_DATASET=${NEW_DATASET}"

if grep -q 'nanoclaw_env' /etc/rc.conf 2>/dev/null; then
    log "  NOTE: Also update NANOCLAW_TEMPLATE_DATASET in /etc/rc.conf or"
    log "        /usr/local/etc/rc.conf.d/nanoclaw if running as a service."
fi

# Step 4 — Optionally restart NanoClaw
log ""
if [ "$DO_RESTART" = "true" ]; then
    log "Step 4: Restarting NanoClaw..."
    if command -v service >/dev/null 2>&1; then
        sudo service nanoclaw restart
    else
        log "  WARNING: 'service' command not found. Restart manually."
    fi
else
    log "Step 4: Skipped (use --restart to restart automatically)"
fi

# Step 5 — Optionally clean up old template
log ""
if [ "$DO_CLEANUP" = "true" ]; then
    log "Step 5: Cleaning up old template: $CURRENT_TEMPLATE_NAME"
    OLD_DATASET="${JAILS_DATASET}/${CURRENT_TEMPLATE_NAME}"
    # Check no dependent clones exist
    CLONES=$(sudo zfs list -H -o name -t filesystem -r "$OLD_DATASET" | wc -l)
    if [ "$CLONES" -gt 1 ]; then
        log "  WARNING: Old template has active clones. Skipping cleanup."
        log "           Destroy dependent jails first, then run:"
        log "           sudo zfs destroy -r $OLD_DATASET"
    else
        sudo zfs destroy -r "$OLD_DATASET"
        log "  Old template destroyed."
    fi
else
    log "Step 5: Skipped (use --cleanup to remove old template)"
fi

# Summary
log ""
log "Blue/green update complete."
log "  Old template: $CURRENT_TEMPLATE_NAME"
log "  New template: $NEW_TEMPLATE_NAME (active)"
log "  Dataset:      $NEW_DATASET"
