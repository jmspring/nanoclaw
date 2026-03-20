#!/bin/sh
# =============================================================================
# NanoClaw pf Table IP Refresh Script
# =============================================================================
#
# Purpose: Periodically refresh the <anthropic_api> pf table with current
#          Anthropic API IP ranges to ensure connectivity is maintained
#          if/when Anthropic updates their infrastructure.
#
# Security Note: This script uses OFFICIAL Anthropic documentation (not DNS
#                resolution) to prevent DNS poisoning attacks. IPs are verified
#                before updating the table.
#
# Usage:
#   sudo ./scripts/refresh-pf-tables.sh
#
# Cron Example (weekly refresh, Sundays at 2 AM):
#   0 2 * * 0 /home/jims/code/nanoclaw/src/scripts/refresh-pf-tables.sh >> /var/log/nanoclaw/pf-refresh.log 2>&1
#
# Manual Verification:
#   sudo pfctl -t anthropic_api -T show
#
# =============================================================================

set -e

# Configuration
TABLE_NAME="anthropic_api"
LOG_FILE="${LOG_FILE:-/var/log/nanoclaw/pf-refresh.log}"
PF_CONF="${PF_CONF:-/home/jims/code/nanoclaw/src/etc/pf-nanoclaw.conf}"

# Official Anthropic API IP ranges
# Source: https://docs.anthropic.com/en/api/ip-addresses
# Last verified: 2026-03-16
#
# IMPORTANT: Update these from official Anthropic documentation only.
# Do NOT use DNS resolution (host/dig/drill) to prevent DNS poisoning.
ANTHROPIC_IPV4="160.79.104.0/21"
ANTHROPIC_IPV6="2607:6bc0::/48"

# Logging function
log() {
    echo "[$(date -Iseconds)] $*" | tee -a "$LOG_FILE"
}

# Verify we're running as root
if [ "$(id -u)" -ne 0 ]; then
    echo "Error: This script must be run as root (use sudo)" >&2
    exit 1
fi

# Create log directory if it doesn't exist
mkdir -p "$(dirname "$LOG_FILE")"

log "Starting pf table refresh for <$TABLE_NAME>"

# Verify pf is enabled
if ! pfctl -s info > /dev/null 2>&1; then
    log "ERROR: pf is not running. Enable with: pfctl -e"
    exit 1
fi

# Check if table exists
if ! pfctl -t "$TABLE_NAME" -T show > /dev/null 2>&1; then
    log "ERROR: Table <$TABLE_NAME> does not exist. Check pf configuration."
    exit 1
fi

# Get current table contents
CURRENT_IPS=$(pfctl -t "$TABLE_NAME" -T show | sort)
log "Current IPs in table <$TABLE_NAME>:"
echo "$CURRENT_IPS" | while read -r ip; do
    log "  $ip"
done

# Validate IP ranges (basic CIDR validation)
validate_cidr() {
    local cidr="$1"

    # IPv4 CIDR validation (basic)
    if echo "$cidr" | grep -qE '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/[0-9]{1,2}$'; then
        return 0
    fi

    # IPv6 CIDR validation (basic)
    if echo "$cidr" | grep -qE '^[0-9a-fA-F:]+/[0-9]{1,3}$'; then
        return 0
    fi

    return 1
}

# Validate the IP ranges
log "Validating IP ranges..."

if ! validate_cidr "$ANTHROPIC_IPV4"; then
    log "ERROR: Invalid IPv4 CIDR: $ANTHROPIC_IPV4"
    exit 1
fi
log "  Valid IPv4: $ANTHROPIC_IPV4"

if ! validate_cidr "$ANTHROPIC_IPV6"; then
    log "ERROR: Invalid IPv6 CIDR: $ANTHROPIC_IPV6"
    exit 1
fi
log "  Valid IPv6: $ANTHROPIC_IPV6"

# Create new IP list
NEW_IPS="$ANTHROPIC_IPV4
$ANTHROPIC_IPV6"

# Sort for comparison
NEW_IPS_SORTED=$(echo "$NEW_IPS" | sort)

# Check if IPs have changed
if [ "$CURRENT_IPS" = "$NEW_IPS_SORTED" ]; then
    log "No changes detected. Table <$TABLE_NAME> is up to date."
    exit 0
fi

log "IP ranges have changed. Updating table <$TABLE_NAME>..."

# Create temporary file with new IPs
TEMP_FILE=$(mktemp)
trap 'rm -f "$TEMP_FILE"' EXIT

echo "$ANTHROPIC_IPV4" > "$TEMP_FILE"
echo "$ANTHROPIC_IPV6" >> "$TEMP_FILE"

# Update the pf table
# Use -T replace to atomically replace all entries
if pfctl -t "$TABLE_NAME" -T replace -f "$TEMP_FILE" 2>&1; then
    log "Successfully updated table <$TABLE_NAME>"

    # Show new contents
    NEW_CONTENTS=$(pfctl -t "$TABLE_NAME" -T show | sort)
    log "New IPs in table <$TABLE_NAME>:"
    echo "$NEW_CONTENTS" | while read -r ip; do
        log "  $ip"
    done

    # Verify table was updated correctly
    VERIFY=$(pfctl -t "$TABLE_NAME" -T show | sort)
    if [ "$VERIFY" = "$NEW_IPS_SORTED" ]; then
        log "Verification successful. Table matches expected IPs."
    else
        log "WARNING: Table verification failed. Current contents may not match expected IPs."
        exit 1
    fi
else
    log "ERROR: Failed to update table <$TABLE_NAME>"
    exit 1
fi

log "pf table refresh completed successfully"

# Optional: Test connectivity from a running jail (if any exist)
# This is commented out by default to avoid errors if no jails are running
# Uncomment to enable connectivity testing
#
# if jls -j nanoclaw_test > /dev/null 2>&1; then
#     log "Testing connectivity from jail nanoclaw_test..."
#     if jexec nanoclaw_test curl -I -s -m 5 https://api.anthropic.com > /dev/null 2>&1; then
#         log "Connectivity test: SUCCESS"
#     else
#         log "WARNING: Connectivity test failed. Jail cannot reach api.anthropic.com"
#     fi
# fi

exit 0
