#!/bin/sh
#
# NanoClaw FreeBSD Setup Script
# Bootstrap a fresh FreeBSD 15 system for NanoClaw with jail runtime
#
# Usage: sudo ./setup-freebsd.sh
#
# This script is idempotent - safe to run multiple times.
#

set -eu

# =============================================================================
# Configuration (can be overridden via environment)
# =============================================================================
FREEBSD_RELEASE="${FREEBSD_RELEASE:-15.0-RELEASE}"
FREEBSD_ARCH="${FREEBSD_ARCH:-amd64}"
NANOCLAW_REPO="${NANOCLAW_REPO:-https://github.com/qwibitai/nanoclaw.git}"

# =============================================================================
# Colors and Output Helpers
# =============================================================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

print_header() {
    echo ""
    echo "${BLUE}${BOLD}=== [$1/10] $2 ===${NC}"
    echo ""
}

log_success() {
    echo "${GREEN}[OK]${NC} $1"
}

log_skip() {
    echo "${YELLOW}[SKIP]${NC} $1"
}

log_error() {
    echo "${RED}[ERROR]${NC} $1" >&2
}

log_info() {
    echo "     $1"
}

prompt_value() {
    _prompt="$1"
    _default="$2"
    _var="$3"

    printf "%s [%s]: " "$_prompt" "$_default"
    read _input
    if [ -z "$_input" ]; then
        eval "$_var=\"$_default\""
    else
        eval "$_var=\"$_input\""
    fi
}

# =============================================================================
# Section 1: Pre-flight Checks
# =============================================================================
preflight_checks() {
    print_header 1 "Pre-flight Checks"

    # Check running as root
    if [ "$(id -u)" -ne 0 ]; then
        log_error "This script must be run as root (or with sudo)"
        exit 1
    fi
    log_success "Running as root"

    # Check FreeBSD version
    OS_VERSION=$(uname -r | cut -d'-' -f1)
    OS_MAJOR=$(echo "$OS_VERSION" | cut -d'.' -f1)
    if [ "$OS_MAJOR" -lt 15 ]; then
        log_error "FreeBSD 15.0+ required (found: $(uname -r))"
        exit 1
    fi
    log_success "FreeBSD version: $(uname -r)"

    # Check ZFS availability
    if ! kldstat -q -m zfs 2>/dev/null; then
        # Try to load it
        if ! kldload zfs 2>/dev/null; then
            log_error "ZFS kernel module not available"
            exit 1
        fi
    fi
    if ! command -v zfs >/dev/null 2>&1; then
        log_error "ZFS command not found"
        exit 1
    fi
    log_success "ZFS available"

    # Check for existing ZFS pools
    POOL_COUNT=$(zpool list -H -o name 2>/dev/null | wc -l | tr -d ' ')
    if [ "$POOL_COUNT" -eq 0 ]; then
        log_error "No ZFS pools found. Create a ZFS pool first."
        exit 1
    fi
    log_success "ZFS pool(s) found: $(zpool list -H -o name | tr '\n' ' ')"
}

# =============================================================================
# Section 2: System Packages
# =============================================================================
install_packages() {
    print_header 2 "System Packages"

    # Ensure pkg is bootstrapped
    if ! command -v pkg >/dev/null 2>&1; then
        log_info "Bootstrapping pkg..."
        env ASSUME_ALWAYS_YES=yes pkg bootstrap
    fi

    # Update package database
    log_info "Updating package database..."
    pkg update -q

    # Install required packages
    PACKAGES="node24 npm-node24 git"

    for pkg_name in $PACKAGES; do
        if pkg info "$pkg_name" >/dev/null 2>&1; then
            log_skip "$pkg_name already installed"
        else
            log_info "Installing $pkg_name..."
            pkg install -y "$pkg_name"
            log_success "$pkg_name installed"
        fi
    done

    # Verify versions
    log_info "Node.js version: $(node --version)"
    log_info "npm version: $(npm --version)"
    log_info "git version: $(git --version | cut -d' ' -f3)"
}

# =============================================================================
# Section 3: Kernel Modules
# =============================================================================
setup_kernel_modules() {
    print_header 3 "Kernel Modules"

    # Load pf module
    if kldstat -q -m pf 2>/dev/null; then
        log_skip "pf module already loaded"
    else
        log_info "Loading pf module..."
        kldload pf
        log_success "pf module loaded"
    fi

    # Load pflog module
    if kldstat -q -m pflog 2>/dev/null; then
        log_skip "pflog module already loaded"
    else
        log_info "Loading pflog module..."
        kldload pflog
        log_success "pflog module loaded"
    fi

    # Add to loader.conf for persistence
    LOADER_CONF="/boot/loader.conf"

    if grep -q '^pf_load="YES"' "$LOADER_CONF" 2>/dev/null; then
        log_skip "pf_load already in $LOADER_CONF"
    else
        log_info "Adding pf_load to $LOADER_CONF..."
        echo 'pf_load="YES"' >> "$LOADER_CONF"
        log_success "pf_load added to $LOADER_CONF"
    fi

    if grep -q '^pflog_load="YES"' "$LOADER_CONF" 2>/dev/null; then
        log_skip "pflog_load already in $LOADER_CONF"
    else
        log_info "Adding pflog_load to $LOADER_CONF..."
        echo 'pflog_load="YES"' >> "$LOADER_CONF"
        log_success "pflog_load added to $LOADER_CONF"
    fi

    # Enable IP forwarding
    CURRENT_FORWARDING=$(sysctl -n net.inet.ip.forwarding)
    if [ "$CURRENT_FORWARDING" = "1" ]; then
        log_skip "IP forwarding already enabled"
    else
        log_info "Enabling IP forwarding..."
        sysctl net.inet.ip.forwarding=1
        log_success "IP forwarding enabled"
    fi

    # Make IP forwarding persistent
    SYSCTL_CONF="/etc/sysctl.conf"
    if grep -q '^net.inet.ip.forwarding=1' "$SYSCTL_CONF" 2>/dev/null; then
        log_skip "IP forwarding already in $SYSCTL_CONF"
    else
        log_info "Adding IP forwarding to $SYSCTL_CONF..."
        echo 'net.inet.ip.forwarding=1' >> "$SYSCTL_CONF"
        log_success "IP forwarding added to $SYSCTL_CONF"
    fi

    # Verify RACCT support for rctl resource limits
    if sysctl -n kern.racct.enable 2>/dev/null | grep -q 1; then
        log_skip "RACCT already enabled"
    else
        log_info "RACCT not enabled — rctl resource limits will not work without it"
        if grep -q 'kern.racct.enable' "$LOADER_CONF" 2>/dev/null; then
            log_info "kern.racct.enable already in $LOADER_CONF (reboot required to activate)"
        else
            log_info "Adding kern.racct.enable=1 to $LOADER_CONF..."
            echo 'kern.racct.enable=1' >> "$LOADER_CONF"
            log_success "kern.racct.enable=1 added to $LOADER_CONF (reboot required)"
        fi
    fi
}

# =============================================================================
# Section 4: User Setup
# =============================================================================
setup_user() {
    print_header 4 "User Setup"

    # Determine default username
    if [ -n "${SUDO_USER:-}" ]; then
        DEFAULT_USER="$SUDO_USER"
    else
        DEFAULT_USER="nanoclaw"
    fi

    prompt_value "Username for NanoClaw" "$DEFAULT_USER" NANOCLAW_USER

    # Verify user exists
    if ! id "$NANOCLAW_USER" >/dev/null 2>&1; then
        log_error "User '$NANOCLAW_USER' does not exist"
        log_info "Create with: pw useradd $NANOCLAW_USER -m -G wheel"
        exit 1
    fi
    log_success "User '$NANOCLAW_USER' exists"

    # Verify user is in wheel group
    if id -Gn "$NANOCLAW_USER" | grep -qw wheel; then
        log_skip "User '$NANOCLAW_USER' already in wheel group"
    else
        log_info "Adding '$NANOCLAW_USER' to wheel group..."
        pw groupmod wheel -m "$NANOCLAW_USER"
        log_success "User added to wheel group"
    fi

    # Get user's home directory
    USER_HOME=$(eval echo ~"$NANOCLAW_USER")
    log_info "User home: $USER_HOME"

    # Create sudoers file
    SUDOERS_DIR="/usr/local/etc/sudoers.d"
    SUDOERS_FILE="$SUDOERS_DIR/nanoclaw"

    mkdir -p "$SUDOERS_DIR"

    : ${NANOCLAW_DIR:="${USER_HOME}/code/nanoclaw/src"}

    log_info "Creating sudoers file at $SUDOERS_FILE..."
    cat > "$SUDOERS_FILE" << EOF
# NanoClaw jail runtime operations (production)
# Generated by setup-freebsd.sh
# Path-restricted for security — only nanoclaw jail paths are permitted.

# Jail management - restrict to nanoclaw_* jails
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /usr/sbin/jail -c name=nanoclaw_*
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /usr/sbin/jail -r nanoclaw_*
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /usr/sbin/jail -f ${NANOCLAW_DIR}/jails/* -c nanoclaw_*
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /usr/sbin/jexec nanoclaw_*
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /usr/sbin/jls *

# ZFS operations - restrict to nanoclaw jail datasets
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /sbin/zfs clone ${ZFS_POOL}/nanoclaw/jails/template@* ${ZFS_POOL}/nanoclaw/jails/*
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /sbin/zfs destroy -f -r ${ZFS_POOL}/nanoclaw/jails/*
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /sbin/zfs destroy -r ${ZFS_POOL}/nanoclaw/jails/*
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /sbin/zfs set quota=* ${ZFS_POOL}/nanoclaw/jails/*
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /sbin/zfs set setuid=off ${ZFS_POOL}/nanoclaw/jails/*
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /sbin/zfs list *

# Mount operations - restrict to jail paths
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /sbin/mount_nullfs -o ro * ${NANOCLAW_DIR}/jails/*
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /sbin/mount_nullfs -o rw * ${NANOCLAW_DIR}/jails/*
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /sbin/umount ${NANOCLAW_DIR}/jails/*
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /sbin/umount -f ${NANOCLAW_DIR}/jails/*

# Network operations - restrict to epair interfaces only
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /sbin/ifconfig epair create
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /sbin/ifconfig epair*

# Directory and file operations - restrict to jail paths
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /bin/mkdir -p ${NANOCLAW_DIR}/jails/*
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /bin/chmod * ${NANOCLAW_DIR}/jails/*
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /usr/sbin/chown * ${NANOCLAW_DIR}/jails/*
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /bin/cp * ${NANOCLAW_DIR}/jails/*

# Resource limits - restrict to nanoclaw jails
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /usr/bin/rctl -a jail\:nanoclaw_*
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /usr/bin/rctl -r jail\:nanoclaw_*

# Firewall monitoring (read-only)
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /sbin/pfctl -si
EOF

    chmod 440 "$SUDOERS_FILE"

    # Validate sudoers file
    if visudo -cf "$SUDOERS_FILE" >/dev/null 2>&1; then
        log_success "Sudoers file created and validated"
    else
        log_error "Sudoers file validation failed"
        rm -f "$SUDOERS_FILE"
        exit 1
    fi
}

# =============================================================================
# Section 5: ZFS Datasets
# =============================================================================
setup_zfs_datasets() {
    print_header 5 "ZFS Datasets"

    # Get default pool (first pool found)
    DEFAULT_POOL=$(zpool list -H -o name | head -1)
    prompt_value "ZFS pool name" "$DEFAULT_POOL" ZFS_POOL

    # Verify pool exists
    if ! zpool list "$ZFS_POOL" >/dev/null 2>&1; then
        log_error "ZFS pool '$ZFS_POOL' does not exist"
        exit 1
    fi
    log_success "Using ZFS pool: $ZFS_POOL"

    # Determine mountpoint
    NANOCLAW_MOUNT="$USER_HOME/code/nanoclaw"

    # Create parent dataset
    PARENT_DATASET="$ZFS_POOL/nanoclaw"
    if zfs list "$PARENT_DATASET" >/dev/null 2>&1; then
        log_skip "Dataset $PARENT_DATASET already exists"
    else
        log_info "Creating dataset $PARENT_DATASET..."
        zfs create -o mountpoint="$NANOCLAW_MOUNT" "$PARENT_DATASET"
        log_success "Dataset $PARENT_DATASET created"
    fi

    # Create child datasets
    for child in jails workspaces ipc; do
        CHILD_DATASET="$PARENT_DATASET/$child"
        if zfs list "$CHILD_DATASET" >/dev/null 2>&1; then
            log_skip "Dataset $CHILD_DATASET already exists"
        else
            log_info "Creating dataset $CHILD_DATASET..."
            zfs create "$CHILD_DATASET"
            log_success "Dataset $CHILD_DATASET created"
        fi
    done

    # Set ZFS properties on jails parent dataset
    log_info "Setting ZFS properties on jails dataset..."
    zfs set compression=lz4 "$PARENT_DATASET/jails"
    zfs set atime=off "$PARENT_DATASET/jails"
    log_success "ZFS properties set (compression=lz4, atime=off)"

    # Create template dataset under jails
    TEMPLATE_DATASET="$PARENT_DATASET/jails/template"
    if zfs list "$TEMPLATE_DATASET" >/dev/null 2>&1; then
        log_skip "Template dataset already exists"
    else
        log_info "Creating template dataset..."
        zfs create "$TEMPLATE_DATASET"
        log_success "Template dataset created"
    fi

    # Set permissions on datasets
    log_info "Setting dataset permissions..."
    NANOCLAW_UID=$(id -u "$NANOCLAW_USER")
    chown -R "$NANOCLAW_USER:wheel" "$NANOCLAW_MOUNT"
    chmod 2775 "$NANOCLAW_MOUNT"
    for child in jails workspaces ipc; do
        chown "$NANOCLAW_USER:wheel" "$NANOCLAW_MOUNT/$child"
        chmod 2775 "$NANOCLAW_MOUNT/$child"
    done
    log_success "Dataset permissions set"

    # Store paths for later
    JAILS_PATH="$NANOCLAW_MOUNT/jails"
    TEMPLATE_PATH="$JAILS_PATH/template"
    WORKSPACES_PATH="$NANOCLAW_MOUNT/workspaces"
    IPC_PATH="$NANOCLAW_MOUNT/ipc"
}

# =============================================================================
# Section 6: Jail Template
# =============================================================================
setup_jail_template() {
    print_header 6 "Jail Template"

    TEMPLATE_SNAPSHOT="${TEMPLATE_DATASET}@base"

    # Check if template snapshot already exists
    if zfs list -t snapshot "$TEMPLATE_SNAPSHOT" >/dev/null 2>&1; then
        log_skip "Template snapshot already exists: $TEMPLATE_SNAPSHOT"
        log_info "To rebuild, first destroy all dependent clones and the snapshot"
        return 0
    fi

    # Check if base.txz needs to be downloaded
    BASE_TXZ="$JAILS_PATH/base.txz"
    FETCH_URL="https://download.freebsd.org/releases/$FREEBSD_ARCH/$FREEBSD_RELEASE/base.txz"

    if [ -f "$BASE_TXZ" ]; then
        log_skip "base.txz already exists"
    else
        log_info "Downloading FreeBSD base system..."
        log_info "URL: $FETCH_URL"
        fetch -o "$BASE_TXZ" "$FETCH_URL"
        log_success "base.txz downloaded"
    fi

    # Check if template is already populated
    if [ -f "$TEMPLATE_PATH/bin/sh" ]; then
        log_skip "Template already has base system extracted"
    else
        log_info "Extracting base.txz to template..."
        tar -xf "$BASE_TXZ" -C "$TEMPLATE_PATH"
        log_success "Base system extracted"
    fi

    # Copy resolv.conf
    log_info "Copying DNS configuration..."
    cp /etc/resolv.conf "$TEMPLATE_PATH/etc/resolv.conf"

    # Install packages inside template using pkg -c (chroot mode)
    log_info "Installing packages inside template (this may take a few minutes)..."

    if [ -x "$TEMPLATE_PATH/usr/local/bin/node" ]; then
        log_skip "node24 already installed in template"
    else
        log_info "Installing node24 npm-node24..."
        pkg -c "$TEMPLATE_PATH" install -y node24 npm-node24
        log_success "Node.js installed in template"
    fi

    # Create node user in template
    if grep -q '^node:' "$TEMPLATE_PATH/etc/passwd" 2>/dev/null; then
        log_skip "node user already exists in template"
    else
        log_info "Creating node user (uid 1000) in template..."
        pw -R "$TEMPLATE_PATH" useradd node -u 1000 -g wheel -d /home/node -s /bin/sh
        mkdir -p "$TEMPLATE_PATH/home/node"
        chown 1000:0 "$TEMPLATE_PATH/home/node"
        log_success "node user created"
    fi

    # Boot template as temporary jail for npm operations
    TEMP_JAIL="nanoclaw_template_setup"

    # Stop any existing temp jail
    if jls -j "$TEMP_JAIL" jid >/dev/null 2>&1; then
        log_info "Stopping existing temporary jail..."
        jail -r "$TEMP_JAIL" 2>/dev/null || true
    fi

    log_info "Starting temporary jail for npm setup..."
    jail -c \
        name="$TEMP_JAIL" \
        path="$TEMPLATE_PATH" \
        host.hostname="$TEMP_JAIL" \
        ip4=inherit \
        ip6=inherit \
        allow.raw_sockets \
        mount.devfs \
        persist

    # Cleanup function for template setup
    cleanup_temp_jail() {
        if jls -j "$TEMP_JAIL" jid >/dev/null 2>&1; then
            jail -r "$TEMP_JAIL" 2>/dev/null || true
        fi
        if mount | grep -q "${TEMPLATE_PATH}/dev"; then
            umount "${TEMPLATE_PATH}/dev" 2>/dev/null || true
        fi
    }
    trap cleanup_temp_jail EXIT

    # Install global npm packages
    log_info "Installing TypeScript globally..."
    jexec "$TEMP_JAIL" npm install -g typescript

    log_info "Installing Claude Code CLI globally..."
    jexec "$TEMP_JAIL" npm install -g @anthropic-ai/claude-code

    # Create directory structure
    log_info "Creating directory structure..."
    jexec "$TEMP_JAIL" mkdir -p /app/src
    jexec "$TEMP_JAIL" mkdir -p /workspace/project /workspace/group /workspace/ipc /workspace/global
    jexec "$TEMP_JAIL" mkdir -p /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input
    jexec "$TEMP_JAIL" mkdir -p /home/node/.claude
    jexec "$TEMP_JAIL" chmod 777 /home/node
    jexec "$TEMP_JAIL" mkdir -p /tmp
    jexec "$TEMP_JAIL" chmod 1777 /tmp

    # Create entrypoint script
    log_info "Creating entrypoint script..."
    cat > "$TEMPLATE_PATH/app/entrypoint.sh" << 'ENTRYPOINT'
#!/bin/sh
set -e
cd /app
npx tsc --outDir /tmp/dist 2>&1 >&2
ln -sf /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist
cat > /tmp/input.json
exec node /tmp/dist/index.js < /tmp/input.json
ENTRYPOINT
    chmod +x "$TEMPLATE_PATH/app/entrypoint.sh"

    # Stop temporary jail
    log_info "Stopping temporary jail..."
    jail -r "$TEMP_JAIL"

    # Unmount devfs
    if mount | grep -q "${TEMPLATE_PATH}/dev"; then
        umount "${TEMPLATE_PATH}/dev"
    fi

    # Clear trap
    trap - EXIT

    # Note: Agent runner dependencies will be installed when setup-jail-template.sh runs
    log_info "Template base setup complete"
    log_info "Run ./scripts/setup-jail-template.sh after cloning NanoClaw to complete agent runner setup"

    # Don't create snapshot yet - that's done by setup-jail-template.sh
    log_success "Jail template prepared (snapshot will be created by setup-jail-template.sh)"
}

# =============================================================================
# Section 7: PF Setup
# =============================================================================
setup_pf() {
    print_header 7 "Packet Filter (pf) Setup"

    # Check for NANOCLAW_EXT_IF environment variable first
    if [ -n "${NANOCLAW_EXT_IF:-}" ]; then
        log_info "Using NANOCLAW_EXT_IF from environment: $NANOCLAW_EXT_IF"
        EXT_IF="$NANOCLAW_EXT_IF"
    else
        # Auto-detect default interface
        DEFAULT_IF=$(route -n get default 2>/dev/null | grep 'interface:' | awk '{print $2}')
        if [ -z "$DEFAULT_IF" ]; then
            log_info "Could not auto-detect interface, falling back to re0"
            DEFAULT_IF="re0"
        fi

        prompt_value "External network interface" "$DEFAULT_IF" EXT_IF
    fi

    # Verify interface exists
    if ! ifconfig "$EXT_IF" >/dev/null 2>&1; then
        log_error "Interface '$EXT_IF' does not exist"
        log_info "Available interfaces: $(ifconfig -l)"
        exit 1
    fi
    log_success "Using interface: $EXT_IF"

    # Source pf config path
    SRC_PF_CONF="$NANOCLAW_MOUNT/src/etc/pf-nanoclaw.conf"
    DEST_PF_CONF="/etc/pf-nanoclaw.conf"

    # Check if source exists (NanoClaw may not be cloned yet)
    if [ -f "$SRC_PF_CONF" ]; then
        log_info "Copying pf-nanoclaw.conf to /etc/..."
        # Copy and update interface name (supports both old hardcoded re0 and new placeholder)
        sed -e "s/^ext_if = \"re0\"/ext_if = \"$EXT_IF\"/" \
            -e "s/^ext_if = \"NANOCLAW_EXT_IF_PLACEHOLDER\"/ext_if = \"$EXT_IF\"/" \
            "$SRC_PF_CONF" > "$DEST_PF_CONF"
        log_success "pf rules installed at $DEST_PF_CONF"
    else
        log_info "Creating minimal pf-nanoclaw.conf (NanoClaw not yet cloned)..."
        cat > "$DEST_PF_CONF" << EOF
# NanoClaw Packet Filter Configuration
# Generated by setup-freebsd.sh
# Full version will be installed when NanoClaw is cloned

ext_if = "$EXT_IF"
lo_if = "lo0"
jail_net = "10.99.0.0/30"

table <anthropic_api> persist { api.anthropic.com }

set skip on lo0
set optimization normal
set block-policy return

scrub in on \$ext_if all fragment reassemble

nat on \$ext_if from \$jail_net to any -> (\$ext_if)

pass on \$ext_if all
pass out quick on \$ext_if proto udp from \$jail_net to any port 53 keep state
pass out quick on \$ext_if proto tcp from \$jail_net to any port 53 keep state
pass out quick on \$ext_if proto tcp from \$jail_net to <anthropic_api> port 443 keep state
block return log quick on \$ext_if from \$jail_net to any

pass on epair
pass on \$lo_if all
EOF
        log_success "Minimal pf rules created"
    fi

    # Setup /etc/pf.conf with anchor if needed
    PF_CONF="/etc/pf.conf"
    if [ ! -f "$PF_CONF" ]; then
        log_info "Creating $PF_CONF with include..."
        cat > "$PF_CONF" << EOF
# FreeBSD Packet Filter Configuration
# Include NanoClaw rules
include "/etc/pf-nanoclaw.conf"
EOF
        log_success "Created $PF_CONF"
    elif ! grep -q 'pf-nanoclaw.conf' "$PF_CONF" 2>/dev/null; then
        log_info "Adding include to existing $PF_CONF..."
        echo 'include "/etc/pf-nanoclaw.conf"' >> "$PF_CONF"
        log_success "Added include to $PF_CONF"
    else
        log_skip "pf-nanoclaw.conf already included in $PF_CONF"
    fi

    # Enable pf in rc.conf
    if sysrc -c pf_enable="YES" 2>/dev/null; then
        log_skip "pf already enabled in rc.conf"
    else
        log_info "Enabling pf in rc.conf..."
        sysrc pf_enable="YES"
        log_success "pf enabled in rc.conf"
    fi

    # Set pf rules file
    sysrc pf_rules="/etc/pf.conf"

    # Enable pflog
    if sysrc -c pflog_enable="YES" 2>/dev/null; then
        log_skip "pflog already enabled in rc.conf"
    else
        sysrc pflog_enable="YES"
        log_success "pflog enabled in rc.conf"
    fi

    # Load rules
    log_info "Loading pf rules..."
    if pfctl -f "$PF_CONF" 2>&1; then
        log_success "pf rules loaded"
    else
        log_error "Failed to load pf rules"
        log_info "Check syntax with: pfctl -nf $PF_CONF"
    fi

    # Enable pf if not already running
    if pfctl -s info 2>/dev/null | grep -q 'Status: Enabled'; then
        log_skip "pf already enabled"
    else
        log_info "Enabling pf..."
        pfctl -e
        log_success "pf enabled"
    fi
}

# =============================================================================
# Section 7b: Install devfs.rules
# =============================================================================

install_devfs_rules() {
    DEVFS_SRC="$NANOCLAW_SRC/etc/devfs.rules"
    if [ ! -f "$DEVFS_SRC" ]; then
        log_info "devfs.rules not found in source — skipping"
        return 0
    fi

    DEVFS_DEST="/etc/devfs.rules"
    if [ -f "$DEVFS_DEST" ] && cmp -s "$DEVFS_SRC" "$DEVFS_DEST"; then
        log_skip "devfs.rules already installed and up to date"
    else
        cp "$DEVFS_SRC" "$DEVFS_DEST"
        log_success "devfs.rules installed at $DEVFS_DEST"
    fi

    if service devfs status >/dev/null 2>&1; then
        service devfs restart
        log_success "devfs rules reloaded"
    fi
}

# =============================================================================
# Section 8: Clone and Configure NanoClaw
# =============================================================================
clone_nanoclaw() {
    print_header 8 "Clone and Configure NanoClaw"

    NANOCLAW_SRC="$NANOCLAW_MOUNT/src"

    # Check if already cloned
    if [ -d "$NANOCLAW_SRC/.git" ]; then
        log_skip "NanoClaw already cloned"
        log_info "Location: $NANOCLAW_SRC"
    else
        prompt_value "Git repository URL" "$NANOCLAW_REPO" REPO_URL

        log_info "Cloning NanoClaw..."
        # Clone to temporary location then move contents
        TEMP_CLONE=$(mktemp -d)
        git clone "$REPO_URL" "$TEMP_CLONE"

        # Move src contents (NanoClaw structure has code in src/)
        if [ -d "$TEMP_CLONE/src" ]; then
            cp -R "$TEMP_CLONE/src/"* "$NANOCLAW_SRC/" 2>/dev/null || true
            cp -R "$TEMP_CLONE/src/".* "$NANOCLAW_SRC/" 2>/dev/null || true
        else
            cp -R "$TEMP_CLONE/"* "$NANOCLAW_SRC/" 2>/dev/null || true
            cp -R "$TEMP_CLONE/".* "$NANOCLAW_SRC/" 2>/dev/null || true
        fi
        rm -rf "$TEMP_CLONE"

        chown -R "$NANOCLAW_USER:wheel" "$NANOCLAW_MOUNT"
        log_success "NanoClaw cloned to $NANOCLAW_SRC"
    fi

    # Install npm dependencies
    log_info "Installing npm dependencies..."
    cd "$NANOCLAW_SRC"
    sudo -u "$NANOCLAW_USER" npm ci || sudo -u "$NANOCLAW_USER" npm install
    log_success "npm dependencies installed"

    # Build TypeScript
    log_info "Building TypeScript..."
    sudo -u "$NANOCLAW_USER" npm run build
    log_success "TypeScript build complete"

    # Create .env file if it doesn't exist
    ENV_FILE="$NANOCLAW_SRC/.env"
    if [ -f "$ENV_FILE" ]; then
        log_skip ".env file already exists"
    else
        log_info "Creating .env file..."
        cat > "$ENV_FILE" << 'EOF'
# NanoClaw Configuration
# Generated by setup-freebsd.sh

# Runtime: Use FreeBSD jails
NANOCLAW_RUNTIME=jail

# Network mode: inherit (dev) or restricted (production)
NANOCLAW_JAIL_NETWORK_MODE=inherit

# API Keys (required)
ANTHROPIC_API_KEY=sk-ant-your-key-here

# Telegram Bot (optional - set to enable Telegram channel)
#TELEGRAM_BOT_TOKEN=your-bot-token-here

# Other channels can be configured here
EOF
        chown "$NANOCLAW_USER:wheel" "$ENV_FILE"
        chmod 600 "$ENV_FILE"
        log_success ".env file created"
    fi

    # Update pf rules with actual config
    SRC_PF_CONF="$NANOCLAW_SRC/etc/pf-nanoclaw.conf"
    if [ -f "$SRC_PF_CONF" ]; then
        log_info "Updating pf rules with full NanoClaw config..."
        # Support both old hardcoded re0 and new placeholder
        sed -e "s/^ext_if = \"re0\"/ext_if = \"$EXT_IF\"/" \
            -e "s/^ext_if = \"NANOCLAW_EXT_IF_PLACEHOLDER\"/ext_if = \"$EXT_IF\"/" \
            "$SRC_PF_CONF" > /etc/pf-nanoclaw.conf
        pfctl -f /etc/pf.conf
        log_success "pf rules updated"
    fi

    # Update jail-runtime.js paths if needed
    JAIL_RUNTIME="$NANOCLAW_SRC/jail-runtime.js"
    if [ -f "$JAIL_RUNTIME" ]; then
        log_info "Checking jail-runtime.js paths..."
        # The paths in jail-runtime.js use /home/jims - update if different
        if [ "$USER_HOME" != "/home/jims" ]; then
            log_info "Updating paths in jail-runtime.js..."
            sed -i '' "s|/home/jims/code/nanoclaw|$NANOCLAW_MOUNT|g" "$JAIL_RUNTIME"
            log_success "jail-runtime.js paths updated"
        else
            log_skip "jail-runtime.js paths already correct"
        fi
    fi

    # Run setup-jail-template.sh to complete template setup
    TEMPLATE_SCRIPT="$NANOCLAW_SRC/scripts/setup-jail-template.sh"
    if [ -f "$TEMPLATE_SCRIPT" ]; then
        # Check if template snapshot exists
        if zfs list -t snapshot "${TEMPLATE_DATASET}@base" >/dev/null 2>&1; then
            log_skip "Template snapshot already exists, skipping setup-jail-template.sh"
        else
            log_info "Running setup-jail-template.sh to complete template..."
            cd "$NANOCLAW_SRC"
            sudo -u "$NANOCLAW_USER" sh "$TEMPLATE_SCRIPT"
            log_success "Template setup complete"
        fi
    else
        log_info "setup-jail-template.sh not found - template needs manual completion"
    fi
}

# =============================================================================
# Section 9: rc.d Service
# =============================================================================
setup_rcd_service() {
    print_header 9 "rc.d Service"

    RCD_SRC="$NANOCLAW_SRC/etc/rc.d/nanoclaw"
    RCD_DEST="/usr/local/etc/rc.d/nanoclaw"

    if [ ! -f "$RCD_SRC" ]; then
        log_info "rc.d script not found in source — skipping"
        return 0
    fi

    log_info "Installing rc.d service script..."
    cp "$RCD_SRC" "$RCD_DEST"
    chmod 755 "$RCD_DEST"
    log_success "rc.d script installed at $RCD_DEST"

    # Enable the service
    if sysrc -c nanoclaw_enable="YES" 2>/dev/null; then
        log_skip "nanoclaw already enabled in rc.conf"
    else
        sysrc nanoclaw_enable="YES"
        log_success "nanoclaw enabled in rc.conf"
    fi

    # Set the user
    sysrc nanoclaw_user="$NANOCLAW_USER"
    sysrc nanoclaw_dir="$NANOCLAW_SRC"
    log_success "rc.conf configured (user=$NANOCLAW_USER, dir=$NANOCLAW_SRC)"
}

# =============================================================================
# Section 10: Summary
# =============================================================================
print_summary() {
    print_header 10 "Setup Complete"

    echo "${GREEN}${BOLD}NanoClaw FreeBSD setup is complete!${NC}"
    echo ""
    echo "${BOLD}Configuration:${NC}"
    echo "  User:              $NANOCLAW_USER"
    echo "  ZFS Pool:          $ZFS_POOL"
    echo "  NanoClaw Path:     $NANOCLAW_MOUNT"
    echo "  Source Code:       $NANOCLAW_MOUNT/src"
    echo "  Jails:             $JAILS_PATH"
    echo "  Template:          $TEMPLATE_PATH"
    echo "  Workspaces:        $WORKSPACES_PATH"
    echo "  IPC:               $IPC_PATH"
    echo "  External Interface: $EXT_IF"
    echo ""
    echo "${BOLD}ZFS Datasets:${NC}"
    echo "  $ZFS_POOL/nanoclaw"
    echo "  $ZFS_POOL/nanoclaw/jails"
    echo "  $ZFS_POOL/nanoclaw/jails/template"
    echo "  $ZFS_POOL/nanoclaw/workspaces"
    echo "  $ZFS_POOL/nanoclaw/ipc"
    echo ""
    echo "${BOLD}Next Steps:${NC}"
    echo ""
    echo "  1. Edit .env file with your API keys:"
    echo "     ${YELLOW}vi $NANOCLAW_MOUNT/src/.env${NC}"
    echo ""
    echo "  2. Start NanoClaw:"
    echo "     ${YELLOW}cd $NANOCLAW_MOUNT/src${NC}"
    echo "     ${YELLOW}NANOCLAW_RUNTIME=jail ANTHROPIC_API_KEY=sk-ant-... npx tsx src/index.ts${NC}"
    echo ""
    echo "  3. Register a Telegram chat (if using Telegram):"
    echo "     - Start a chat with your bot"
    echo "     - Send a message containing your trigger word"
    echo ""
    echo "  4. For production (restricted networking):"
    echo "     - Edit .env and set: ${YELLOW}NANOCLAW_JAIL_NETWORK_MODE=restricted${NC}"
    echo "     - This blocks all egress except api.anthropic.com"
    echo ""
    echo "${BOLD}Useful Commands:${NC}"
    echo "  Start/stop service:    service nanoclaw start|stop|restart|status"
    echo "  List running jails:    sudo jls"
    echo "  Check pf status:       sudo pfctl -s info"
    echo "  View pf rules:         sudo pfctl -s rules"
    echo "  Watch blocked packets: sudo tcpdump -n -e -ttt -i pflog0"
    echo "  Rebuild template:      cd $NANOCLAW_MOUNT/src && ./scripts/setup-jail-template.sh"
    echo ""
    echo "${BOLD}Documentation:${NC}"
    echo "  $NANOCLAW_MOUNT/src/docs/FREEBSD_JAILS.md"
    echo ""
}

# =============================================================================
# Main
# =============================================================================
main() {
    echo ""
    echo "${BLUE}${BOLD}========================================${NC}"
    echo "${BLUE}${BOLD}  NanoClaw FreeBSD Setup Script${NC}"
    echo "${BLUE}${BOLD}========================================${NC}"
    echo ""
    echo "This script will configure FreeBSD for NanoClaw with jail runtime."
    echo "It is safe to run multiple times (idempotent)."
    echo ""

    preflight_checks
    install_packages
    setup_kernel_modules
    setup_user
    setup_zfs_datasets
    setup_jail_template
    setup_pf
    clone_nanoclaw
    install_devfs_rules
    setup_rcd_service
    print_summary
}

main "$@"
