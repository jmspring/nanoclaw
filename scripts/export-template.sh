#!/bin/sh
# Export a NanoClaw jail template as a portable ZFS stream file.
#
# Usage:
#   ./export-template.sh                    # export default "template"
#   ./export-template.sh template-v2        # export "template-v2"
#
# Produces:
#   nanoclaw-template-<name>.zfs        — ZFS stream file
#   nanoclaw-template-<name>.zfs.sha256 — SHA-256 checksum

set -eu

# Optional argument: template name (default: "template")
TEMPLATE_NAME="${1:-template}"

# Configuration
JAILS_DATASET="${NANOCLAW_JAILS_DATASET:-zroot/nanoclaw/jails}"
TEMPLATE_DATASET="${JAILS_DATASET}/${TEMPLATE_NAME}"
SNAPSHOT_NAME="base"
FULL_SNAPSHOT="${TEMPLATE_DATASET}@${SNAPSHOT_NAME}"
OUTPUT_FILE="nanoclaw-template-${TEMPLATE_NAME}.zfs"
CHECKSUM_FILE="${OUTPUT_FILE}.sha256"

log() { echo "[export-template] $*"; }
error() { echo "[export-template] ERROR: $*" >&2; exit 1; }

# Prerequisite checks
log "Checking prerequisites..."
if ! sudo zfs list -t snapshot "$FULL_SNAPSHOT" >/dev/null 2>&1; then
    error "Snapshot not found: $FULL_SNAPSHOT"
fi
log "Prerequisites OK"

# Export via zfs send
log "Exporting template snapshot: $FULL_SNAPSHOT"
log "  Output file: $OUTPUT_FILE"
sudo zfs send "$FULL_SNAPSHOT" > "$OUTPUT_FILE"

# Generate SHA-256 checksum
log "Generating SHA-256 checksum..."
if command -v sha256 >/dev/null 2>&1; then
    sha256 -q "$OUTPUT_FILE" > "$CHECKSUM_FILE"
elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$OUTPUT_FILE" | awk '{print $1}' > "$CHECKSUM_FILE"
else
    log "WARNING: sha256/sha256sum not available, skipping checksum"
fi

# Log results
FILE_SIZE=$(du -h "$OUTPUT_FILE" | awk '{print $1}')
log ""
log "Export complete:"
log "  File:     $OUTPUT_FILE ($FILE_SIZE)"
if [ -f "$CHECKSUM_FILE" ]; then
    log "  Checksum: $CHECKSUM_FILE"
    log "  SHA-256:  $(cat "$CHECKSUM_FILE")"
fi
