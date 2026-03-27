#!/bin/sh
#
# NanoClaw Installation Verification
# Validates that the FreeBSD jail runtime is correctly configured.
#
# Usage: ./scripts/verify-install.sh [--smoke-test] [--quiet] [--help]
#

set -eu

# =============================================================================
# Colors and Output Helpers
# =============================================================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
SMOKE_TEST=0
QUIET=0
CLEANUP_JAIL=""

usage() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Verify NanoClaw FreeBSD jail runtime installation."
    echo ""
    echo "Options:"
    echo "  --smoke-test   Run Tier 3 live smoke test (creates/destroys a test jail)"
    echo "  --quiet        Only show FAIL and SKIP results"
    echo "  --help         Show this help message"
    echo ""
    echo "Tiers:"
    echo "  Tier 1: Static checks (no privileges required)"
    echo "  Tier 2: Privileged checks (requires sudo)"
    echo "  Tier 3: Live smoke test (requires --smoke-test flag)"
    exit 0
}

pass() {
    PASS_COUNT=$((PASS_COUNT + 1))
    if [ "$QUIET" -eq 0 ]; then
        printf "${GREEN}[PASS]${NC} %s\n" "$1"
    fi
}

fail() {
    FAIL_COUNT=$((FAIL_COUNT + 1))
    printf "${RED}[FAIL]${NC} %s\n" "$1"
    if [ -n "${2:-}" ]; then
        printf "       Fix: %s\n" "$2"
    fi
}

skip() {
    SKIP_COUNT=$((SKIP_COUNT + 1))
    if [ "$QUIET" -eq 0 ]; then
        printf "${YELLOW}[SKIP]${NC} %s\n" "$1"
    fi
}

# =============================================================================
# Configuration (read from .env or use defaults matching src/jail/config.ts)
# =============================================================================
load_config() {
    TEMPLATE_DATASET="zroot/nanoclaw/jails/template"
    TEMPLATE_SNAPSHOT="base"
    JAIL_SUBNET="10.99"
    JAILS_PATH=""

    if [ -f .env ]; then
        _val=$(grep '^NANOCLAW_TEMPLATE_DATASET=' .env 2>/dev/null | cut -d'=' -f2- || true)
        [ -n "$_val" ] && TEMPLATE_DATASET="$_val"

        _val=$(grep '^NANOCLAW_TEMPLATE_SNAPSHOT=' .env 2>/dev/null | cut -d'=' -f2- || true)
        [ -n "$_val" ] && TEMPLATE_SNAPSHOT="$_val"

        _val=$(grep '^NANOCLAW_JAIL_SUBNET=' .env 2>/dev/null | cut -d'=' -f2- || true)
        [ -n "$_val" ] && JAIL_SUBNET="$_val"

        _val=$(grep '^NANOCLAW_JAILS_PATH=' .env 2>/dev/null | cut -d'=' -f2- || true)
        [ -n "$_val" ] && JAILS_PATH="$_val"
    fi

    if [ -z "$JAILS_PATH" ]; then
        JAILS_PATH="$(pwd)/jails"
    fi
}

# =============================================================================
# Trap handler for cleanup (Tier 3 smoke test)
# =============================================================================
cleanup() {
    if [ -n "$CLEANUP_JAIL" ]; then
        printf "\nCleaning up test jail...\n"
        sudo jail -r "$CLEANUP_JAIL" 2>/dev/null || true
        sudo umount -f "${JAILS_PATH}/verify_test/dev" 2>/dev/null || true
        sudo zfs destroy -f "${TEMPLATE_DATASET%%/template}/verify_test" 2>/dev/null || true
    fi
}

trap cleanup EXIT INT TERM

# =============================================================================
# Parse Arguments
# =============================================================================
for arg in "$@"; do
    case "$arg" in
        --smoke-test) SMOKE_TEST=1 ;;
        --quiet) QUIET=1 ;;
        --help) usage ;;
        *)
            echo "Unknown option: $arg"
            usage
            ;;
    esac
done

# =============================================================================
# Main
# =============================================================================
echo ""
echo "${BOLD}NanoClaw Installation Verification${NC}"
echo "==================================="
echo ""

load_config

# --- Tier 1: Static Checks ---
echo "${BOLD}--- Tier 1: Static Checks ---${NC}"

# 1. Node.js version
if command -v node >/dev/null 2>&1; then
    NODE_VERSION=$(node --version 2>/dev/null || echo "unknown")
    NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/^v//' | cut -d'.' -f1)
    if [ "$NODE_MAJOR" -ge 24 ] 2>/dev/null; then
        pass "Node.js $NODE_VERSION"
    else
        fail "Node.js $NODE_VERSION (requires v24+)" "Install Node.js 24+: pkg install node24"
    fi
else
    fail "Node.js not found" "Install Node.js 24+: pkg install node24"
fi

# npm
if command -v npm >/dev/null 2>&1; then
    NPM_VERSION=$(npm --version 2>/dev/null || echo "unknown")
    pass "npm $NPM_VERSION"
else
    fail "npm not found" "Install npm: pkg install npm"
fi

# 2. Project build
if [ -f dist/index.js ]; then
    pass "dist/index.js exists"
else
    fail "dist/index.js not found (project not compiled)" "Run: npm run build"
fi

# 3. Configuration
if [ -f .env ]; then
    pass ".env file exists"
else
    fail ".env file not found" "Run: cp .env.example .env"
fi

# Check NANOCLAW_RUNTIME
_runtime=$(grep '^NANOCLAW_RUNTIME=' .env 2>/dev/null | cut -d'=' -f2- || true)
if [ "$_runtime" = "jail" ]; then
    pass "NANOCLAW_RUNTIME=jail"
elif [ -z "$_runtime" ] && [ "$(uname -s)" = "FreeBSD" ]; then
    pass "NANOCLAW_RUNTIME not set (auto-detects to jail on FreeBSD)"
else
    fail "NANOCLAW_RUNTIME=${_runtime:-unset} (expected 'jail' on FreeBSD)" "Set NANOCLAW_RUNTIME=jail in .env"
fi

# Check ANTHROPIC_API_KEY (existence only, never print the value)
if grep -q '^ANTHROPIC_API_KEY=.\+' .env 2>/dev/null; then
    pass "ANTHROPIC_API_KEY is set"
else
    fail "ANTHROPIC_API_KEY not set in .env" "Add your API key to .env"
fi

# 4. ZFS checks
if command -v zfs >/dev/null 2>&1; then
    pass "zfs command available"
else
    fail "zfs command not found" "Ensure ZFS is installed and loaded"
fi

if zfs list "$TEMPLATE_DATASET" >/dev/null 2>&1; then
    pass "ZFS template dataset exists ($TEMPLATE_DATASET)"
else
    fail "ZFS template dataset not found ($TEMPLATE_DATASET)" "Run: sudo ./scripts/setup-freebsd.sh"
fi

if zfs list -t snapshot "${TEMPLATE_DATASET}@${TEMPLATE_SNAPSHOT}" >/dev/null 2>&1; then
    pass "ZFS template snapshot exists (${TEMPLATE_DATASET}@${TEMPLATE_SNAPSHOT})"
else
    fail "ZFS template snapshot not found (${TEMPLATE_DATASET}@${TEMPLATE_SNAPSHOT})" "Run: sudo ./scripts/setup-jail-template.sh"
fi

# 5. Package checks
for cmd in jail jexec jls; do
    if command -v "$cmd" >/dev/null 2>&1; then
        pass "${cmd}(8) available"
    else
        fail "${cmd}(8) not found" "This command should be part of FreeBSD base"
    fi
done

# --- Tier 2: Privileged Checks ---
echo ""
echo "${BOLD}--- Tier 2: Privileged Checks ---${NC}"

if ! sudo -n true 2>/dev/null; then
    skip "Tier 2 checks require sudo (run with sudo or configure NOPASSWD)"
else
    # 6. pf checks
    if sudo pfctl -si >/dev/null 2>&1; then
        pass "pf is running"
    else
        fail "pf is not running" "Run: sudo pfctl -e && sudo pfctl -f /etc/pf.conf"
    fi

    if sudo pfctl -sr 2>/dev/null | grep -qE "nanoclaw|${JAIL_SUBNET}"; then
        pass "NanoClaw pf rules loaded"
    else
        fail "NanoClaw pf rules not found" "Reload rules: sudo pfctl -f /etc/pf.conf"
    fi

    # 7. Sudoers check
    if sudo -l 2>/dev/null | grep -q 'jail\|jexec\|zfs'; then
        pass "Sudoers configured for jail operations"
    else
        fail "Sudoers not configured for jail operations" "Run: sudo ./scripts/setup-freebsd.sh"
    fi

    # 8. Kernel module checks
    if kldstat 2>/dev/null | grep -q if_epair; then
        pass "if_epair kernel module loaded"
    else
        fail "if_epair kernel module not loaded" "Run: sudo kldload if_epair"
    fi

    if sysctl security.jail.allow_raw_sockets >/dev/null 2>&1; then
        pass "Jail subsystem active"
    else
        skip "Could not verify jail subsystem sysctl"
    fi
fi

# --- Tier 3: Live Smoke Test ---
if [ "$SMOKE_TEST" -eq 1 ]; then
    echo ""
    echo "${BOLD}--- Tier 3: Live Smoke Test ---${NC}"

    if ! sudo -n true 2>/dev/null; then
        skip "Smoke test requires sudo"
    else
        JAILS_DATASET="${TEMPLATE_DATASET%%/template}"
        VERIFY_DATASET="${JAILS_DATASET}/verify_test"
        VERIFY_PATH="${JAILS_PATH}/verify_test"
        CLEANUP_JAIL="nanoclaw_verify_test"

        # Clone template
        if sudo zfs clone "${TEMPLATE_DATASET}@${TEMPLATE_SNAPSHOT}" "$VERIFY_DATASET" 2>/dev/null; then
            pass "ZFS clone created"
        else
            fail "Failed to create ZFS clone" "Check ZFS pool space: zfs list"
            # Skip remaining smoke tests
            CLEANUP_JAIL=""
        fi

        if [ -n "$CLEANUP_JAIL" ]; then
            # Create and start jail
            if sudo jail -c "name=${CLEANUP_JAIL}" "path=${VERIFY_PATH}" \
                ip4=inherit host.hostname=verify_test \
                persist allow.raw_sockets 2>/dev/null; then
                pass "Test jail created"
            else
                fail "Failed to create test jail"
            fi

            # Run command inside jail
            JAIL_OUTPUT=$(sudo jexec "$CLEANUP_JAIL" echo "NanoClaw jail runtime OK" 2>/dev/null || echo "EXEC_FAILED")
            if [ "$JAIL_OUTPUT" = "NanoClaw jail runtime OK" ]; then
                pass "Command executed in jail successfully"
            else
                fail "Jail command execution failed (got: ${JAIL_OUTPUT})"
            fi

            # Destroy jail
            if sudo jail -r "$CLEANUP_JAIL" 2>/dev/null; then
                pass "Test jail destroyed"
            else
                fail "Failed to destroy test jail"
            fi
            CLEANUP_JAIL=""

            # Clean up ZFS clone
            if sudo zfs destroy "$VERIFY_DATASET" 2>/dev/null; then
                pass "ZFS clone cleaned up"
            else
                fail "Failed to destroy ZFS clone ($VERIFY_DATASET)"
            fi
        fi
    fi
fi

# --- Summary ---
echo ""
echo "${BOLD}--- Summary ---${NC}"
TOTAL=$((PASS_COUNT + FAIL_COUNT + SKIP_COUNT))
printf "%d passed, %d failed, %d skipped\n" "$PASS_COUNT" "$FAIL_COUNT" "$SKIP_COUNT"
echo ""

if [ "$FAIL_COUNT" -eq 0 ]; then
    printf "${GREEN}Installation looks good.${NC}"
    if [ "$SMOKE_TEST" -eq 0 ]; then
        printf " Run with --smoke-test to verify jail lifecycle."
    fi
    echo ""
    exit 0
else
    printf "${RED}%d check(s) failed.${NC} Review the issues above.\n" "$FAIL_COUNT"
    exit 1
fi
