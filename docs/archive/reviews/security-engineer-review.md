# Security Engineer Review — FreeBSD Jail Runtime

## Summary
NanoClaw's FreeBSD jail implementation provides strong filesystem and network isolation through ZFS clones, nullfs mounts, and pf firewall rules. However, critical vulnerabilities exist: unrestricted DNS allows data exfiltration, ANTHROPIC_API_KEY exposure in process listings enables credential theft, group isolation can be bypassed via IPC directory structure, and path sanitization weaknesses could allow jail escape. The lack of devfs restrictions and mount path validation creates additional attack surface.

## Threat Model
**Assets to Protect**: Host filesystem, ANTHROPIC_API_KEY, cross-group data isolation, host system integrity
**Threat Actors**: Malicious Claude agent code (prompt injection, compromised dependencies), compromised group members (in multi-user scenarios)
**Trust Boundary**: Everything inside the jail is untrusted; host-side code and pf rules are trusted

---

## Findings (ranked: Critical > High > Medium > Low > Info)

### [Critical] 1. API Key Exposure in Process Listings
**Category**: secrets
**Files**: /home/jims/code/nanoclaw/src/jail-runtime.js (line 390), /home/jims/code/nanoclaw/src/src/container-runner.ts (line 390)
**Description**: `ANTHROPIC_API_KEY` is passed as an environment variable to jailed processes. Environment variables are visible to:
- Any process in the jail via `/proc/<pid>/environ` (if procfs is mounted)
- Host processes via `ps -eww` or `jexec <jail> ps -e`
- Other jails if they can execute `ps` on the host (jail escape + privilege escalation)

The credential is also logged in container-runner.ts at debug level (line 386-392), though this is less concerning than the process table exposure.

**Exploitability**: Easy. From inside the jail, an agent can read its own environment with any programming language (`process.env` in Node.js, `os.environ` in Python, `/proc/self/environ` directly). If an agent achieves jail escape or can trigger host commands, they can extract keys for all running jails.

**Recommendation**:
1. Use credential proxy pattern (as Docker path does) - jails should talk to a host-side proxy at 10.99.0.1:<port> that injects the real key
2. Alternative: Use a short-lived token exchange - write a single-use token to a file, agent reads and deletes it, exchanges via API call
3. Never log the full key value, even at debug level

---

### [Critical] 2. Unrestricted DNS Enables Data Exfiltration
**Category**: network
**Files**: /home/jims/code/nanoclaw/src/etc/pf-nanoclaw.conf (lines 138-139), /home/jims/code/nanoclaw/src/etc/pf-nanoclaw-anchor.conf (lines 42-43)
**Description**: pf rules allow jails to query ANY DNS server on port 53 UDP/TCP:
```
pass out quick on $ext_if proto udp from $jail_net to any port 53 keep state
pass out quick on $ext_if proto tcp from $jail_net to any port 53 keep state
```

This allows a malicious agent to:
- Exfiltrate data via DNS queries to attacker-controlled nameservers (e.g., `<base64_data>.attacker.com`)
- Bypass the anthropic_api restriction by resolving malicious domains
- Perform DNS tunneling for bidirectional C2 communication

**Exploitability**: Trivial. Agent can make arbitrary DNS queries from any programming language. DNS tunneling tools are widely available and can exfiltrate at ~1KB/s over standard queries.

**Recommendation**:
1. Restrict DNS to specific trusted servers: `pass out quick on $ext_if proto udp from $jail_net to { 8.8.8.8, 1.1.1.1 } port 53`
2. Add DNS query rate limiting in pf
3. Consider running a caching DNS resolver on the host (10.99.0.1:53) that logs all queries - easier to audit than monitoring external traffic
4. Document that DNS is a known exfiltration vector if agents become adversarial

---

### [High] 3. DNS Table Poisoning Vulnerability
**Category**: network
**Files**: /home/jims/code/nanoclaw/src/etc/pf-nanoclaw.conf (line 84)
**Description**: The anthropic_api table is populated with `api.anthropic.com` at ruleset load time:
```
table <anthropic_api> persist { api.anthropic.com }
```

If DNS is compromised (via DNS cache poisoning, BGP hijacking, or malicious resolver), an attacker can:
1. Poison `api.anthropic.com` resolution to point to attacker IP
2. pf resolves the name, adds attacker IP to table
3. Jails can now connect to attacker's server on port 443
4. MitM attack extracts API keys from jailed agents

The ruleset also documents manual table updates (line 183-186), which are error-prone and could inject malicious IPs.

**Exploitability**: Moderate. Requires compromising DNS resolution at the time pf rules are loaded (system boot, manual reload). If an attacker can trigger rule reloads (e.g., via another vulnerability), they can poison the table.

**Recommendation**:
1. Pin the actual IP ranges for api.anthropic.com in the table instead of using DNS names (e.g., via `pfctl -t anthropic_api -T add 1.2.3.4/24`)
2. Add IP-based validation: `pass out quick on $ext_if proto tcp from $jail_net to <anthropic_api> port 443 keep state user _anthropic_verified`
3. Use TLS certificate pinning in the agent-runner to reject connections to non-Anthropic certificates (defense in depth)
4. Monitor and alert on table modifications: `pfctl -t anthropic_api -T show`

---

### [High] 4. Cross-Group IPC Directory Path Traversal
**Category**: jail escape / input validation
**Files**: /home/jims/code/nanoclaw/src/jail-runtime.js (lines 40-46, 239)
**Description**: `sanitizeJailName()` replaces non-alphanumeric characters with underscores, but does not prevent path traversal:

```javascript
export function sanitizeJailName(groupId) {
  return groupId.replace(/[^a-zA-Z0-9_]/g, '_');
}
```

A malicious groupId like `../../other-group` becomes `______other_group`, but the IPC path construction in container-runner.ts (line 266) uses `group.folder` directly:

```javascript
const groupIpcDir = resolveGroupIpcPath(group.folder);
```

If `group.folder` is not validated separately, an attacker could:
1. Register a group with folder `../../../etc`
2. Write malicious files to host `/etc` via the IPC mount
3. Achieve privilege escalation via `/etc/crontab`, `/etc/passwd`, etc.

**Exploitability**: Depends on `resolveGroupIpcPath()` validation. If it calls `path.resolve()` without checking the result is within the expected base directory, this is exploitable. The `resolveGroupFolderPath()` in container-runner.ts line 97 does reject invalid folders, but IPC path validation was not visible in reviewed files.

**Recommendation**:
1. Review `resolveGroupIpcPath()` implementation - ensure it validates the resolved path is within `GROUPS_DIR` or `ipcPath`
2. Add paranoid check: after resolving, verify path.relative(baseDir, resolvedPath) does not start with '..'
3. Apply the same validation to all group.folder uses (claudeSessionPath, groupPath)
4. Consider using a flat namespace for group folders (UUIDs or sanitized names only, no subdirectories)

---

### [High] 5. Full devfs Exposure in Jails
**Category**: jail escape
**Files**: /home/jims/code/nanoclaw/src/jail-runtime.js (line 486)
**Description**: Jails are created with `mount.devfs` (line 486), which mounts the full `/dev` hierarchy inside the jail by default. This exposes:
- `/dev/mem`, `/dev/kmem` (if not restricted by kernel): direct memory access, jail escape
- `/dev/io` (on some platforms): raw I/O port access
- `/dev/bpf*`: packet capture (sniff host traffic)
- `/dev/mdN`: memory disk devices (mount host filesystems)

While FreeBSD's jail(8) prevents access to some dangerous devices, the lack of explicit devfs ruleset means any kernel bugs or misconfigurations could be exploited.

**Exploitability**: Low to Moderate. Modern FreeBSD restricts most dangerous devices in jails by default, but this varies by kernel version and config. If an agent finds an accessible raw device, jail escape is likely.

**Recommendation**:
1. Create a restrictive devfs ruleset in `/etc/devfs.rules`:
   ```
   [nanoclaw_jail=10]
   add include $devfsrules_jail
   add path 'random' unhide
   add path 'urandom' unhide
   add path 'null' unhide
   add path 'zero' unhide
   add path 'stdin' unhide
   add path 'stdout' unhide
   add path 'stderr' unhide
   add path 'fd' unhide
   add path 'fd/*' unhide
   add path 'pts' unhide
   add path 'pts/*' unhide
   ```
2. Apply the ruleset: `devfs_ruleset=nanoclaw_jail` in jail parameters (line 486)
3. Audit exposed devices: `jexec <jail> ls -la /dev` and verify only safe devices are visible
4. Document the security assumption that devfs restrictions are in place

---

### [High] 6. Nullfs Mount Path Validation Weakness
**Category**: jail escape / mount injection
**Files**: /home/jims/code/nanoclaw/src/jail-runtime.js (lines 324-330, 333-344)
**Description**: `createMountPoints()` and `mountNullfs()` use paths directly from the mounts array without canonicalization:

```javascript
const targetPath = path.join(jailPath, mount.jailPath);
await sudoExec(['mkdir', '-p', targetPath]);
await sudoExec(['mount_nullfs', '-o', opts, mount.hostPath, targetPath]);
```

If `mount.jailPath` contains `..` sequences (e.g., `../../escape`), the mount could be placed outside the jail root. This is mitigated by:
- `buildJailMounts()` hardcodes jailPath values (JAIL_MOUNT_LAYOUT)
- `validateAdditionalMounts()` checks containerPath (line 203-218 in mount-security.ts)

However, the low-level functions trust their inputs. If a future refactoring bypasses the validation layer, jails could write outside their boundaries.

**Exploitability**: Low. Current code paths appear safe, but the defense is fragile.

**Recommendation**:
1. Add paranoid validation in `mountNullfs()`:
   ```javascript
   const resolvedTarget = path.resolve(targetPath);
   const resolvedJailRoot = path.resolve(jailPath);
   if (!resolvedTarget.startsWith(resolvedJailRoot + path.sep)) {
     throw new Error(`Mount target escapes jail root: ${targetPath}`);
   }
   ```
2. Document that low-level mount functions require pre-validated inputs
3. Add integration test: attempt to mount with `..` in jailPath, verify it fails

---

### [Medium] 7. Read-Only Mount Enforcement Relies on nullfs
**Category**: jail escape
**Files**: /home/jims/code/nanoclaw/src/jail-runtime.js (lines 318, 336)
**Description**: Read-only mounts use `nullfs` with the `ro` option:

```javascript
const opts = mount.readonly ? 'ro' : 'rw';
await sudoExec(['mount_nullfs', '-o', opts, mount.hostPath, targetPath]);
```

Nullfs relies on the kernel to enforce read-only. If an agent can:
1. Unmount the nullfs mount (requires root, but jail escape bugs exist)
2. Remount with different options (same prerequisite)
3. Exploit a nullfs kernel bug (CVE history shows these exist)

...they could write to supposedly read-only paths.

**Exploitability**: Low. Requires jail escape to root first. However, the consequence is severe (modify host code, inject backdoors).

**Recommendation**:
1. Add a second layer of defense: set host-side directories to immutable before mounting: `chflags schg <dir>`
2. Monitor mount table changes from within jails (audit log)
3. Consider ZFS snapshots for truly read-only mounts: clone a snapshot, mount the clone read-only
4. Document that read-only mounts are enforced by the kernel, not application logic

---

### [Medium] 8. Inter-Jail Network Reachability (IP Reuse)
**Category**: network / cross-group isolation
**Files**: /home/jims/code/nanoclaw/src/jail-runtime.js (lines 24-26), /home/jims/code/nanoclaw/src/etc/pf-nanoclaw.conf (line 78)
**Description**: All jails use the same IP address (10.99.0.2) on their isolated /30 subnets:

```javascript
jailHostIP: '10.99.0.1',
jailIP: '10.99.0.2',
jailNetmask: '30',
```

This is safe if jails are ephemeral (destroyed after use) and cannot coexist. However, if multiple jails run simultaneously (e.g., concurrent group processing), they could:
1. Share the same epair interface if the epair tracking logic fails
2. Communicate with each other if routing is misconfigured
3. Perform timing attacks to infer data about other groups' API calls

The pf-nanoclaw-anchor.conf also uses a /24 network (10.99.0.0/24), suggesting support for multiple concurrent jails, but the IP assignment logic in jail-runtime.js doesn't implement per-jail IPs.

**Exploitability**: Low. Current code appears to use one jail at a time (epair tracking in lines 29-30 suggests sequential reuse). However, the design is fragile.

**Recommendation**:
1. Implement per-jail IP assignment from a pool: 10.99.0.2, 10.99.0.6, 10.99.0.10, ... (each /30 subnet)
2. Add assertion: refuse to create a jail if another is running for a different group
3. Add pf rules to block inter-jail traffic: `block quick on epair from $jail_net to $jail_net`
4. Document the single-jail-at-a-time constraint, or implement full multi-jail support with unique IPs

---

### [Medium] 9. TOCTOU Vulnerability in Template Snapshot Validation
**Category**: privilege escalation / supply chain
**Files**: /home/jims/code/nanoclaw/src/scripts/setup-jail-template.sh (lines 84-92)
**Description**: The setup script checks for dependent clones before destroying the snapshot:

```bash
CLONES=$(sudo zfs list -H -o clones "$FULL_SNAPSHOT" 2>/dev/null | grep -v '^-$' || true)
if [ -n "$CLONES" ]; then
    error "Cannot update template: snapshot has dependent clones"
fi
# ... (later) ...
sudo zfs destroy "$FULL_SNAPSHOT"
sudo zfs snapshot "$FULL_SNAPSHOT"
```

There's a time-of-check-time-of-use (TOCTOU) window between the clone check and snapshot destruction. If a jail is created during this window, the script destroys the snapshot while the jail is using it, causing filesystem corruption.

**Exploitability**: Low. Requires precise timing and concurrent jail operations. Impact is denial of service (jail crashes) rather than privilege escalation.

**Recommendation**:
1. Use ZFS locking: `zfs hold nanoclaw_setup_lock <snapshot>` before checks, release after completion
2. Alternative: Stop all NanoClaw processes before running setup script (document this requirement)
3. Add retry logic with exponential backoff if clones exist
4. Verify no running jails: `jls | grep nanoclaw_` before proceeding

---

### [Medium] 10. Telegram Content Injection into Shell Commands
**Category**: input validation
**Files**: /home/jims/code/nanoclaw/src/container/agent-runner/src/index.ts (lines 426-437)
**Description**: User input from Telegram/WhatsApp flows into the agent prompt, which the agent can use in Bash tool calls. While the Claude Agent SDK sanitizes tool parameters, the entrypoint script uses shell interpolation:

```javascript
const entrypointScript = `
  set -e
  if [ -f /app/entrypoint.sh ]; then
    exec /app/entrypoint.sh
  else
    cd /app
    npx tsc --outDir /tmp/dist 2>&1 >&2
    ln -sf /app/node_modules /tmp/dist/node_modules
    cat > /tmp/input.json
    exec node /tmp/dist/index.js < /tmp/input.json
  fi
`;
const proc = jailRuntime.spawnInJail(group.folder, ['sh', '-c', entrypointScript], { env });
```

The `env` object is constructed from `process.env.ANTHROPIC_API_KEY`, which is controlled by the host. However, if a future refactoring passes user-controlled data into `env`, shell injection is possible.

**Exploitability**: Very Low with current code (no user data in env). Elevated to Medium due to fragility - easy to introduce in future changes.

**Recommendation**:
1. Use array-based command execution instead of shell interpolation: `spawnInJail(['node', '/tmp/dist/index.js'], { stdin: jsonData })`
2. If shell is required, use `shellEscape()` or similar for any dynamic values
3. Add test: inject `'; malicious-command #` into various input fields, verify it doesn't execute
4. Document that env values must never contain user input

---

### [Low] 11. Sudoers Scope Too Broad
**Category**: privilege escalation
**Files**: /home/jims/code/nanoclaw/src/jail-runtime.js (lines 64-85)
**Description**: All jail operations use `sudo` without restricting commands to a specific allowlist. If the user's sudoers config grants full sudo access (common for passwordless sudo), a compromised NanoClaw process can:
1. Execute any command as root (via `sudoExec()` calls)
2. Modify the host system outside jail boundaries
3. Read sensitive files (e.g., other users' data)

The current design assumes sudo is configured correctly, but doesn't enforce least privilege.

**Exploitability**: Depends on sudoers configuration. If sudo is restricted to specific jail commands (jail, zfs, mount), risk is low. If unrestricted, risk is high.

**Recommendation**:
1. Document required sudoers rules in setup docs:
   ```
   nanoclaw-user ALL=(root) NOPASSWD: /usr/sbin/jail
   nanoclaw-user ALL=(root) NOPASSWD: /sbin/zfs
   nanoclaw-user ALL=(root) NOPASSWD: /sbin/mount_nullfs
   nanoclaw-user ALL=(root) NOPASSWD: /sbin/umount
   nanoclaw-user ALL=(root) NOPASSWD: /sbin/ifconfig
   nanoclaw-user ALL=(root) NOPASSWD: /usr/sbin/jexec
   nanoclaw-user ALL=(root) NOPASSWD: /sbin/pfctl -t anthropic_api *
   ```
2. Validate sudo restrictions at startup: attempt to run a non-allowed command, verify it fails
3. Consider using `doas` instead (more restrictive by default)

---

### [Low] 12. Template Integrity Verification Missing
**Category**: supply chain
**Files**: /home/jims/code/nanoclaw/src/scripts/setup-jail-template.sh (entire file)
**Description**: The template setup script installs npm packages without verifying integrity:

```bash
jexec_cmd npm install -g typescript
jexec_cmd npm install -g @anthropic-ai/claude-code
jexec_cmd sh -c 'cd /app && npm install'
```

If npm registry is compromised or a dependency is malicious:
1. Backdoored packages are installed in the template
2. All future jails clone the compromised template
3. Malicious code runs in every agent execution

There's no checksum validation, signature verification, or package pinning.

**Exploitability**: Low (requires npm supply chain attack). Impact is Critical (all jails compromised).

**Recommendation**:
1. Pin exact package versions in package.json: `"typescript": "5.3.3"` (not `^5.3.3`)
2. Use `npm ci` instead of `npm install` (enforces lock file)
3. Generate checksums of installed packages, store in template metadata
4. Verify checksums on jail creation (detect template tampering)
5. Consider vendoring dependencies or using a private npm registry with vulnerability scanning

---

### [Low] 13. Process Visibility Across Jail Boundary
**Category**: information disclosure
**Files**: /home/jims/code/nanoclaw/src/jail-runtime.js (lines 482-487)
**Description**: Jail parameters don't explicitly hide host processes. Depending on FreeBSD version and kernel config, jailed processes might see:
1. Host process list via `/proc` (if procfs is mounted with `linux` mode)
2. Process names and args via `ps` (if `security.jail.param.allow.mount.procfs=1`)
3. Kernel state via sysctl

This leaks information about other groups, host services, and potentially API keys in other processes' environments.

**Exploitability**: Low. Requires specific kernel settings to be vulnerable. Modern FreeBSD jails hide host processes by default.

**Recommendation**:
1. Explicitly disable procfs mounting in jails: Remove `allow.sysvipc` (line 484) or add `allow.mount.procfs=0`
2. Verify isolation: `jexec <jail> ps aux`, ensure only jail processes are visible
3. Add to documentation: required kernel settings (`security.jail.enforce_statfs=2`)

---

### [Info] 14. Network Mode Timing Window During Startup
**Category**: network
**Files**: /home/jims/code/nanoclaw/src/jail-runtime.js (lines 452-495)
**Description**: When `networkMode=restricted`, the jail is created with `vnet` but the network is configured *after* the jail starts:

```javascript
// Step 1: Create jail with vnet (lines 463-490)
await sudoExec(jailParams);

// Step 2: Configure networking (lines 492-494)
if (JAIL_CONFIG.networkMode === 'restricted' && epairInfo) {
  await configureJailNetwork(jailName, epairInfo.jailIface);
}
```

During the window between steps, the jail has a network interface but no IP/routing. If a process starts immediately (race condition), it could:
1. Attempt network operations that fail (denial of service)
2. Bind to the unconfigured interface before routes are set (unexpected behavior)

This is not a security issue but could cause reliability problems.

**Exploitability**: N/A (reliability issue, not security)

**Recommendation**:
1. Move network configuration into jail creation (single atomic step)
2. Alternative: Add a boot script inside the jail that waits for network readiness
3. Monitor for network errors in agent startup logs

---

## Interface Abstraction Assessment

### Security Impact of Current if/else Pattern

**Current State (container-runner.ts lines 783-788):**
```typescript
const runtime = getRuntime();
if (runtime === 'jail') {
  return runJailAgent(group, input, logsDir, onProcess, onOutput);
}
// Docker path only below this point
```

**Security Analysis:**

**Positive Aspects:**
1. **Clear Trust Boundary**: The check happens early, ensuring jail-specific code doesn't interact with Docker-specific logic (mount validation, credential proxy routing, etc.)
2. **Reduced Attack Surface**: Each runtime path is independent - a vulnerability in Docker volume handling doesn't affect jails
3. **Audit Simplicity**: Security reviewers can analyze each path in isolation

**Negative Aspects:**
1. **Fragility**: Adding new runtimes (e.g., Podman, LXC) requires duplicating the entire if/else chain
2. **Inconsistent Security Controls**: Docker uses credential proxy (line 324-336), jails pass raw API key (jail-runtime.js line 390). This inconsistency is error-prone.
3. **Validation Bypass Risk**: Future developers might add runtime-specific features without applying mount-security.ts validation to all paths

### Would a RuntimeDriver Interface Improve Security?

**Proposed Pattern:**
```typescript
interface RuntimeDriver {
  createContainer(group, paths, env): Promise<ContainerId>
  execInContainer(id, command, env): Promise<Result>
  stopContainer(id): Promise<void>
  // Enforces standardized credential handling
  injectCredentials(apiKey: string): EnvironmentVars
}
```

**Security Benefits:**
1. **Enforced Consistency**: All runtimes must implement `injectCredentials()`, preventing the current jail-vs-docker divergence
2. **Interface-Level Validation**: Mount paths, environment variables, and network configs can be validated in a shared layer before reaching runtime-specific code
3. **Easier Penetration Testing**: Security testers can mock the interface to inject malicious inputs, verifying all implementations handle them safely
4. **Reduced Code Duplication**: Credential proxy logic (currently Docker-only) could be shared, reducing the chance of security bugs in copied code

**Security Drawbacks:**
1. **Abstraction Complexity**: Interfaces introduce indirection, making it harder to trace exactly what commands execute with sudo
2. **Shared State Risks**: If poorly designed, a RuntimeDriver might share state between groups (e.g., a global credential cache), violating isolation
3. **Interface Bloat**: Supporting both jail-native semantics (nullfs, devfs) and Docker-native semantics (volume mounts, overlay networks) in one interface may force compromises that weaken both

**Recommendation:**
A RuntimeDriver interface would **likely improve security** if:
1. It enforces credential handling at the interface level (all implementations must use credential proxy or equivalent)
2. Mount validation (mount-security.ts) is called by the interface layer, not individual drivers
3. The interface is designed with security invariants as type constraints (e.g., `readonly paths: ReadonlyArray<ValidatedMount>`)

However, the current if/else pattern is **acceptable** if:
1. A comprehensive test suite verifies both paths handle malicious inputs identically
2. Security-critical logic (credential handling, mount validation) is extracted into shared functions that both paths call
3. Code reviews explicitly check for divergence between runtime implementations

**Priority**: Medium. The current implementation gaps (API key exposure, DNS exfiltration) are higher priority than refactoring for abstraction. Fix the critical issues first, then consider the interface layer as a maintainability improvement.

---

## Summary of Risk Severity

- **Critical**: 2 findings (API key exposure, DNS exfiltration) - **Immediate action required**
- **High**: 5 findings (DNS poisoning, IPC path traversal, devfs exposure, mount validation, cross-group network) - **Patch within 30 days**
- **Medium**: 5 findings (read-only enforcement, IP reuse, TOCTOU, shell injection, sudoers scope) - **Address in next release**
- **Low**: 3 findings (template integrity, process visibility, network timing) - **Track as technical debt**

**Overall Assessment**: The jail runtime provides strong foundational isolation but has critical credential and network vulnerabilities that must be addressed before production use. Once the Critical and High findings are remediated, the architecture is sound for running untrusted code.
