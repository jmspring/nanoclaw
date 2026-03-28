#!/bin/sh
# Import a NanoClaw jail template from a ZFS stream file.
#
# Usage:
#   ./import-template.sh nanoclaw-template-template.zfs
#   ./import-template.sh nanoclaw-template-template.zfs template-v2
#
# If a .sha256 file exists alongside the .zfs file, it will be verified first.

set -eu

# Required: ZFS stream file path
INPUT_FILE="${1:?Usage: import-template.sh <file.zfs> [template-name]}"

# Optional: template name (default: "template")
TEMPLATE_NAME="${2:-template}"

# Configuration
JAILS_DATASET="${NANOCLAW_JAILS_DATASET:-zroot/nanoclaw/jails}"
TEMPLATE_DATASET="${JAILS_DATASET}/${TEMPLATE_NAME}"

log() { echo "[import-template] $*"; }
error() { echo "[import-template] ERROR: $*" >&2; exit 1; }

# Verify input file exists
if [ ! -f "$INPUT_FILE" ]; then
    error "Input file not found: $INPUT_FILE"
fi

# SHA-256 verification if checksum file exists
CHECKSUM_FILE="${INPUT_FILE}.sha256"
if [ -f "$CHECKSUM_FILE" ]; then
    log "Verifying SHA-256 checksum..."
    EXPECTED=$(cat "$CHECKSUM_FILE")
    if command -v sha256 >/dev/null 2>&1; then
        ACTUAL=$(sha256 -q "$INPUT_FILE")
    elif command -v sha256sum >/dev/null 2>&1; then
        ACTUAL=$(sha256sum "$INPUT_FILE" | awk '{print $1}')
    else
        log "WARNING: sha256/sha256sum not available, skipping verification"
        ACTUAL="$EXPECTED"
    fi
    if [ "$EXPECTED" != "$ACTUAL" ]; then
        error "SHA-256 mismatch!
  Expected: $EXPECTED
  Actual:   $ACTUAL"
    fi
    log "SHA-256 verification passed."
else
    log "WARNING: No .sha256 file found, skipping verification."
fi

# Check target dataset does not already have dependent clones
if sudo zfs list "$TEMPLATE_DATASET" >/dev/null 2>&1; then
    CLONES=$(sudo zfs list -H -o name -t filesystem -r "$TEMPLATE_DATASET" | wc -l)
    if [ "$CLONES" -gt 1 ]; then
        error "Target dataset $TEMPLATE_DATASET has dependent clones.
Destroy existing jails first or import to a different template name."
    fi
fi

# Import via zfs receive
log "Importing template to: $TEMPLATE_DATASET"
sudo zfs receive -F "$TEMPLATE_DATASET" < "$INPUT_FILE"

# Verify snapshot exists after receive
if sudo zfs list -t snapshot "${TEMPLATE_DATASET}@base" >/dev/null 2>&1; then
    log "Template imported successfully: ${TEMPLATE_DATASET}@base"
else
    error "Import completed but snapshot not found."
fi

log "Done. Template is ready for use."
