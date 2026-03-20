#!/bin/sh
# =============================================================================
# NanoClaw Network Mode Migration Script
# =============================================================================
#
# Purpose: Safely switch between "inherit" and "restricted" jail network modes.
# Handles pf configuration, IP forwarding, and validates the system is ready.
#
# Usage:
#   scripts/switch-network-mode.sh {inherit|restricted}
#
# Examples:
#   scripts/switch-network-mode.sh restricted   # Enable restricted mode with pf
#   scripts/switch-network-mode.sh inherit      # Disable restricted mode
#
# =============================================================================

set -e  # Exit on error

# --- Configuration ---
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PF_CONF="${PROJECT_ROOT}/etc/pf-nanoclaw.conf"
SYSCTL_CONF="/etc/sysctl.conf"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# --- Helper Functions ---

print_info() {
    printf "${BLUE}[INFO]${NC} %s\n" "$1"
}

print_success() {
    printf "${GREEN}[SUCCESS]${NC} %s\n" "$1"
}

print_warning() {
    printf "${YELLOW}[WARNING]${NC} %s\n" "$1"
}

print_error() {
    printf "${RED}[ERROR]${NC} %s\n" "$1" >&2
}

check_root() {
    if [ "$(id -u)" -ne 0 ]; then
        print_error "This script requires root privileges (use sudo)"
        exit 1
    fi
}

check_pf_available() {
    if ! command -v pfctl >/dev/null 2>&1; then
        print_error "pfctl command not found. pf is not installed on this system."
        exit 1
    fi
}

# --- Mode-Specific Functions ---

enable_restricted_mode() {
    print_info "Switching to RESTRICTED network mode..."
    echo ""

    # 1. Check pf is available
    check_pf_available

    # 2. Check pf config file exists
    if [ ! -f "$PF_CONF" ]; then
        print_error "PF configuration file not found: $PF_CONF"
        exit 1
    fi

    # 3. Enable IP forwarding
    print_info "Enabling IP forwarding..."
    sysctl net.inet.ip.forwarding=1 >/dev/null

    # 4. Make IP forwarding persistent
    if ! grep -q "^net.inet.ip.forwarding=1" "$SYSCTL_CONF" 2>/dev/null; then
        print_info "Adding IP forwarding to $SYSCTL_CONF (persistent)..."
        echo "" >> "$SYSCTL_CONF"
        echo "# NanoClaw jail networking (required for restricted mode)" >> "$SYSCTL_CONF"
        echo "net.inet.ip.forwarding=1" >> "$SYSCTL_CONF"
        print_success "IP forwarding configured persistently"
    else
        print_success "IP forwarding already configured in $SYSCTL_CONF"
    fi

    # 5. Validate pf config syntax
    print_info "Validating pf configuration syntax..."
    if ! pfctl -nf "$PF_CONF" 2>&1; then
        print_error "PF configuration syntax validation failed"
        exit 1
    fi
    print_success "PF configuration syntax valid"

    # 6. Load pf ruleset
    print_info "Loading pf ruleset from $PF_CONF..."
    if ! pfctl -f "$PF_CONF" 2>&1; then
        print_error "Failed to load pf ruleset"
        exit 1
    fi
    print_success "PF ruleset loaded"

    # 7. Enable pf if not already enabled
    if ! pfctl -s info 2>/dev/null | grep -q "Status: Enabled"; then
        print_info "Enabling pf..."
        pfctl -e >/dev/null 2>&1
        print_success "PF enabled"
    else
        print_success "PF already enabled"
    fi

    # 8. Verify NAT rules are loaded
    print_info "Verifying NAT rules..."
    if ! pfctl -s nat | grep -q "10.99.0.0/24"; then
        print_error "NAT rules for jail network (10.99.0.0/24) not found"
        exit 1
    fi
    print_success "NAT rules verified"

    echo ""
    print_success "Restricted mode enabled successfully!"
    echo ""
    print_info "Next steps:"
    echo "  1. Set NANOCLAW_JAIL_NETWORK_MODE=restricted in your environment"
    echo "  2. Restart NanoClaw to apply the new network mode"
    echo ""
    print_info "To make pf persistent across reboots, add to /etc/rc.conf:"
    echo "    pf_enable=\"YES\""
    echo "    pf_rules=\"$PF_CONF\""
    echo ""
}

enable_inherit_mode() {
    print_info "Switching to INHERIT network mode..."
    echo ""

    # 1. Check if pf is running
    if command -v pfctl >/dev/null 2>&1 && pfctl -s info 2>/dev/null | grep -q "Status: Enabled"; then
        print_warning "PF is currently enabled"
        print_info "INHERIT mode does not require pf, but you may want to keep it for other purposes."
        echo ""
        printf "Do you want to disable pf? [y/N]: "
        read -r response
        case "$response" in
            [yY][eE][sS]|[yY])
                print_info "Disabling pf..."
                pfctl -d >/dev/null 2>&1
                print_success "PF disabled"
                ;;
            *)
                print_info "Leaving pf enabled (INHERIT mode will ignore pf rules)"
                ;;
        esac
    fi

    # 2. IP forwarding can stay enabled (doesn't hurt, may be needed for other services)
    print_info "IP forwarding will remain enabled (safe for INHERIT mode)"

    echo ""
    print_success "Inherit mode configuration complete!"
    echo ""
    print_info "Next steps:"
    echo "  1. Set NANOCLAW_JAIL_NETWORK_MODE=inherit in your environment"
    echo "  2. Restart NanoClaw to apply the new network mode"
    echo ""
    print_warning "INHERIT mode shares the host's network stack with jails."
    print_warning "Jails will have full network access without pf filtering."
    echo ""
}

show_current_status() {
    print_info "Current Network Configuration:"
    echo ""

    # Check IP forwarding
    printf "  IP Forwarding: "
    if [ "$(sysctl -n net.inet.ip.forwarding 2>/dev/null)" = "1" ]; then
        printf "${GREEN}enabled${NC}\n"
    else
        printf "${RED}disabled${NC}\n"
    fi

    # Check pf status
    if command -v pfctl >/dev/null 2>&1; then
        printf "  PF Status: "
        if pfctl -s info 2>/dev/null | grep -q "Status: Enabled"; then
            printf "${GREEN}enabled${NC}\n"

            # Check NAT rules
            printf "  PF NAT Rules: "
            if pfctl -s nat 2>/dev/null | grep -q "10.99.0.0/24"; then
                printf "${GREEN}configured for jails${NC}\n"
            else
                printf "${YELLOW}not configured for jails${NC}\n"
            fi
        else
            printf "${YELLOW}disabled${NC}\n"
        fi
    else
        printf "  PF Status: ${RED}not installed${NC}\n"
    fi

    # Check environment variable
    printf "  NANOCLAW_JAIL_NETWORK_MODE: "
    if [ -n "$NANOCLAW_JAIL_NETWORK_MODE" ]; then
        printf "${GREEN}%s${NC}\n" "$NANOCLAW_JAIL_NETWORK_MODE"
    else
        printf "${YELLOW}not set (defaults to 'inherit')${NC}\n"
    fi

    echo ""
}

show_usage() {
    cat <<EOF
Usage: $0 {inherit|restricted|status}

Modes:
  inherit     - Jails share host network stack (ip4=inherit)
                No pf configuration required
                Jails have full network access

  restricted  - Jails use vnet with epair interfaces and pf filtering
                Requires pf enabled with NAT/filter rules
                Jails can only reach api.anthropic.com and DNS

  status      - Show current network configuration

Examples:
  $0 restricted   # Enable restricted mode with pf
  $0 inherit      # Disable restricted mode
  $0 status       # Show current configuration

After switching modes:
  1. Set NANOCLAW_JAIL_NETWORK_MODE environment variable
  2. Restart NanoClaw

For more information, see docs/jail-network-modes.md
EOF
}

# --- Main ---

# Parse arguments
if [ $# -eq 0 ]; then
    show_usage
    exit 1
fi

MODE="$1"

case "$MODE" in
    restricted)
        check_root
        enable_restricted_mode
        ;;
    inherit)
        check_root
        enable_inherit_mode
        ;;
    status)
        show_current_status
        ;;
    *)
        print_error "Invalid mode: $MODE"
        echo ""
        show_usage
        exit 1
        ;;
esac
