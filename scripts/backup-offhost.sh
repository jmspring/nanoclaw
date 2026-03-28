#!/bin/sh
set -euo pipefail

# =============================================================================
# NanoClaw Off-Host Backup via ZFS Send
# =============================================================================
# Sends ZFS snapshots to a remote host (via ssh) or local file path.
# Supports incremental sends and automatic snapshot retention.
#
# Environment variables:
#   BACKUP_TARGET    (required) — ssh://host/dataset or a local directory path
#   BACKUP_DATASET   (default: zroot/nanoclaw) — ZFS dataset to back up
#   BACKUP_SNAP_PREFIX (default: backup) — snapshot name prefix
#   BACKUP_LOG       (default: /var/log/nanoclaw-backup.log) — log file path
# =============================================================================

BACKUP_TARGET="${BACKUP_TARGET:-}"
BACKUP_DATASET="${BACKUP_DATASET:-zroot/nanoclaw}"
BACKUP_SNAP_PREFIX="${BACKUP_SNAP_PREFIX:-backup}"
BACKUP_LOG="${BACKUP_LOG:-/var/log/nanoclaw-backup.log}"

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $1" | tee -a "$BACKUP_LOG"
}

if [ -z "$BACKUP_TARGET" ]; then
    echo "Usage: BACKUP_TARGET=<path|ssh://host/dataset> $0"
    echo ""
    echo "Environment variables:"
    echo "  BACKUP_TARGET      (required) file path or ssh://host/dataset"
    echo "  BACKUP_DATASET     (default: zroot/nanoclaw)"
    echo "  BACKUP_SNAP_PREFIX (default: backup)"
    echo "  BACKUP_LOG         (default: /var/log/nanoclaw-backup.log)"
    exit 1
fi

log "Starting off-host backup of ${BACKUP_DATASET} to ${BACKUP_TARGET}"

# Create a new snapshot
SNAP_NAME="${BACKUP_SNAP_PREFIX}-$(date +%Y%m%d-%H%M%S)"
CURRENT_SNAP="${BACKUP_DATASET}@${SNAP_NAME}"

log "Creating snapshot: ${CURRENT_SNAP}"
zfs snapshot "${CURRENT_SNAP}"

# Find previous backup snapshot (second-to-last with matching prefix)
PREVIOUS_SNAP=$(zfs list -t snapshot -o name -s creation -H | \
    grep "@${BACKUP_SNAP_PREFIX}-" | \
    tail -n 2 | head -n 1)

# If PREVIOUS_SNAP equals CURRENT_SNAP, there is no previous
if [ "$PREVIOUS_SNAP" = "$CURRENT_SNAP" ]; then
    PREVIOUS_SNAP=""
fi

# Determine send mode
if [ -n "$PREVIOUS_SNAP" ]; then
    log "Incremental send from ${PREVIOUS_SNAP} to ${CURRENT_SNAP}"
    SEND_CMD="zfs send -i ${PREVIOUS_SNAP} ${CURRENT_SNAP}"
else
    log "Full send of ${CURRENT_SNAP}"
    SEND_CMD="zfs send ${CURRENT_SNAP}"
fi

# Route send stream to target
case "$BACKUP_TARGET" in
    ssh://*)
        # Parse ssh://host/dataset
        TARGET_STRIPPED="${BACKUP_TARGET#ssh://}"
        TARGET_HOST="${TARGET_STRIPPED%%/*}"
        TARGET_DATASET="${TARGET_STRIPPED#*/}"
        log "Sending to remote host: ${TARGET_HOST}, dataset: ${TARGET_DATASET}"
        eval "$SEND_CMD" | ssh "$TARGET_HOST" zfs recv "$TARGET_DATASET"
        log "Remote send complete"
        ;;
    *)
        # File path target
        if [ ! -d "$BACKUP_TARGET" ]; then
            mkdir -p "$BACKUP_TARGET"
            log "Created target directory: ${BACKUP_TARGET}"
        fi
        OUTFILE="${BACKUP_TARGET}/${SNAP_NAME}.zfs"
        log "Sending to file: ${OUTFILE}"
        eval "$SEND_CMD" > "$OUTFILE"
        log "File send complete, computing SHA-256 checksum"
        sha256 "$OUTFILE" > "${OUTFILE}.sha256"
        log "Checksum written to ${OUTFILE}.sha256"
        ;;
esac

# Retain only 2 backup snapshots (current + previous)
log "Pruning old backup snapshots (keeping newest 2)"
zfs list -t snapshot -o name -s creation -H | \
    grep "@${BACKUP_SNAP_PREFIX}-" | \
    head -n -2 | \
    xargs -I{} zfs destroy {}

log "Backup complete: ${CURRENT_SNAP}"
exit 0
