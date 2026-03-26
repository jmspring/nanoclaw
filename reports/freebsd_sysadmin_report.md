# FreeBSD Jail Security Audit Report -- NanoClaw

**Auditor**: Grumpy FreeBSD Sysadmin
**Date**: 2026-03-25
**Scope**: `src/jail/*.ts`, `etc/pf-nanoclaw*.conf`, `etc/devfs.rules`, `etc/rc.d/nanoclaw`, `scripts/setup-freebsd.sh`, `scripts/setup-jail-template.sh`, `src/credential-proxy.ts`
**Verdict**: Functional but has real security gaps. Some of them would make me lose sleep.

---

## Table of Contents

1. [Jail Configuration Security](#1-jail-configuration-security)
2. [Network Isolation](#2-network-isolation)
3. [Filesystem Security](#3-filesystem-security)
4. [ZFS Security](#4-zfs-security)
5. [Process Isolation](#5-process-isolation)
6. [Privilege Escalation Vectors](#6-privilege-escalation-vectors)
7. [Credential Proxy](#7-credential-proxy)
8. [rc.d Script Quality](#8-rcd-script-quality)
9. [pf Rules Analysis](#9-pf-rules-analysis)
10. [What is Missing](#10-what-is-missing)
11. [Comparison to Best Practices](#11-comparison-to-best-practices)
12. [Specific Vulnerabilities](#12-specific-vulnerabilities)
13. [Summary and Recommendations](#13-summary-and-recommendations)

---

## 1. Jail Configuration Security

### What is present (lifecycle.ts, lines 330-340)

The generated per-jail `jail.conf` contains:

```
${jailName} {
  path = "${jailPath}";
  host.hostname = "${jailName}";
  persist;
  enforce_statfs = 2;
  mount.devfs;
  devfs_ruleset = 10;
  securelevel = 3;
  <network config>;
}
```

### What is good

- **`enforce_statfs = 2`**: Correct. Prevents the jail from seeing host mount points. This is the most restrictive setting.
- **`securelevel = 3`**: Good. Prevents modification of pf rules, loading kernel modules, and modifying immutable files from within the jail. This is the highest securelevel.
- **`devfs_ruleset = 10`**: Uses a custom ruleset. See devfs section below.

### What is missing -- and this matters

- **`children.max = 0`**: NOT SET. A jail could theoretically create child jails if the kernel allows it. While the `node` user inside the jail probably cannot invoke `jail(8)` without sudo, the parameter should be explicitly locked down. Default may allow children depending on host `jail.conf` defaults or sysctl `security.jail.children.max`.

- **`allow.raw_sockets = 0`**: NOT SET. The default is 0, which is correct, but it should be explicit. The template setup scripts (`setup-jail-template.sh:146`, `setup-freebsd.sh:471`) actually use `allow.raw_sockets` for the template build jail -- which is fine for setup -- but the production jail conf does not explicitly deny it. Relying on defaults is lazy and dangerous.

- **`allow.mount = 0`**: NOT SET. Should be explicitly denied.

- **`allow.set_hostname = 0`**: NOT SET. Should be explicitly denied.

- **`allow.sysvipc = 0`**: NOT SET. SysV IPC between jails and the host is a known isolation bypass vector. Must be explicitly denied.

- **`allow.chflags = 0`**: NOT SET. Could allow modifying file flags.

- **`sysvshm = new`, `sysvmsg = new`, `sysvsem = new`**: NOT SET. These control SysV IPC namespace isolation. On FreeBSD 12+, you can give each jail its own IPC namespace with `new` instead of the default `inherit`. Without this, the jail inherits the host's SysV IPC namespace.

- **`exec.clean`**: NOT SET. This is critical. Without `exec.clean`, environment variables from the host process leak into the jail when using `jail -c`. The jail inherits the invoking shell's environment. Since this runs from a Node.js process, environment variables including potentially sensitive ones could be visible.

**Recommendation**: Add these parameters to the jail.conf template in `lifecycle.ts`:

```
children.max = 0;
allow.raw_sockets = 0;
allow.mount = 0;
allow.set_hostname = 0;
allow.sysvipc = 0;
allow.chflags = 0;
sysvshm = new;
sysvmsg = new;
sysvsem = new;
exec.clean;
```

---

## 2. Network Isolation

### Architecture

The vnet/epair architecture is fundamentally sound. Each jail gets its own network stack (`vnet`), a dedicated epair pair, and a point-to-point /30 subnet (`10.99.N.0/30`). This is the correct approach for jail network isolation.

### Epair management

Epair creation (`network.ts:103-155`) and cleanup (`network.ts:195-216`) look reasonable. The persistent state file for crash recovery is a nice touch. The orphan cleanup logic works.

### Problems

1. **Subnet math mismatch with pf rules**: The pf config defines `jail_net = "10.99.0.0/24"`. But the actual addressing scheme uses `10.99.N.0/30` where N ranges 0-255. This means the actual address space is `10.99.0.0/16` (a /16), not a /24. The pf rule `jail_net = "10.99.0.0/24"` only covers `10.99.0.0` through `10.99.0.255`. Any jail with epair number > 0 uses `10.99.N.x` where N > 0, which falls OUTSIDE this /24.

   Wait -- let me re-examine. The IPs are `10.99.{epairNum}.1` and `10.99.{epairNum}.2`. With epairNum from 0 to 255, the addresses span `10.99.0.1` to `10.99.255.2`. The pf rule `jail_net = "10.99.0.0/24"` only matches `10.99.0.0` through `10.99.0.255`.

   **THIS IS A CRITICAL BUG**: Any jail with epairNum >= 1 has addresses outside the pf filter range. Jail 1 uses `10.99.1.2` -- this does NOT match `10.99.0.0/24`. The pf rules will not apply NAT, will not apply egress filtering, and will not block inter-jail traffic for any jail except jail 0.

   The `jail_net` macro should be `"10.99.0.0/16"` to cover the full `10.99.0.0` - `10.99.255.255` range. Or better, `"10.99.0.0/15"` if you need safety margin. But really, `10.99.0.0/16` is the correct CIDR for this addressing scheme.

   **Severity: CRITICAL. All jails except the first one have unfiltered network access when using restricted mode.**

2. **NAT rule scope**: The NAT rule `nat on $ext_if from $jail_net to any -> ($ext_if)` suffers from the same /24 vs /16 bug. Jails > 0 cannot NAT their traffic and likely have no outbound connectivity at all (which is accidentally secure but operationally broken).

3. **Credential proxy bind address**: The proxy binds to `10.99.0.1` (from `container-runtime.ts:43`). But each jail connects to its own gateway at `10.99.N.1`. The proxy only listens on `10.99.0.1`, so jails with N > 0 cannot reach the credential proxy. This is another manifestation of the same addressing confusion.

   The code in `runner.ts:150` sets `ANTHROPIC_BASE_URL` to `http://${jailConfig.jailHostIP}:${CREDENTIAL_PROXY_PORT}` where `jailHostIP` is `${subnet}.0.1`. So it always points at `10.99.0.1` regardless of which epair the jail actually got. The jail can only reach its own gateway (`10.99.N.1`), not `10.99.0.1` (unless N == 0).

   **This means the credential proxy is only reachable by jail 0. All other jails will fail to connect to the API.**

4. **`pass on $ext_if all`** (pf-nanoclaw.conf:212): This passes ALL traffic on the external interface, not just host traffic. This rule is evaluated before the jail-specific blocks because pf is last-match-wins (without `quick`). But the jail block rules use `quick`, so they take precedence. However, this `pass on $ext_if all` without `quick` means any packet that does not match a `quick` rule will be passed. This is fine for host traffic but is a defense-in-depth concern -- if a `quick` rule is accidentally removed, everything opens up.

5. **DNS to trusted servers only -- but the jail copies host resolv.conf**: The pf rules restrict DNS to 8.8.8.8 and 1.1.1.1. But `setupJailResolv()` copies the host's `/etc/resolv.conf` into the jail. If the host uses a local resolver (127.0.0.1, or an ISP DNS server), the jail's DNS queries will go to that address, which is not in the trusted list, and will be blocked by pf. This will cause DNS resolution failures inside the jail.

   Either the pf rules should match whatever DNS servers the host uses, or the jail's resolv.conf should be hardcoded to the trusted servers (8.8.8.8, 1.1.1.1).

### Anchor mode (pf-nanoclaw-anchor.conf)

6. **Anchor uses `lo1` instead of epair**: The anchor config references `lo1` as the jail interface. This is a completely different networking model (shared IP on loopback alias) than the vnet/epair model used by the code. If someone uses the anchor config, the rules will not match any traffic because the actual traffic flows through epair interfaces, not lo1. The anchor config appears to be written for a different (older?) architecture and has not been updated.

7. **Anchor allows all jail-to-jail traffic**: The anchor has `pass quick on lo1 from 10.99.0.0/24 to 10.99.0.0/24` and `pass quick on lo1 proto { tcp, udp } from 10.99.0.0/24 to 10.99.0.0/24`. This allows unrestricted inter-jail communication, which defeats isolation.

---

## 3. Filesystem Security

### nullfs mounts

The mount validation in `mounts.ts` is well done:
- Path traversal checks (`..` in paths)
- Absolute path requirement
- `realpathSync()` to resolve symlinks before mounting
- Blocked path patterns (`.ssh`, `.gnupg`, `.aws`, etc.)
- `assertMountWithinJail()` prevents escaping jail root

**Project mount is read-only**: Good. The project code is mounted at `/workspace/project` as `ro`.

**Agent runner mount is read-only**: Good. `/app/src` is `ro`.

### Problems

1. **Group workspace is read-write**: `/workspace/group` is `rw`. This is by design (the agent writes its memory here), but it means a compromised agent can modify its own CLAUDE.md and potentially influence future agent behavior. This is a calculated risk, not a bug.

2. **IPC directory is read-write**: `/workspace/ipc` is `rw`. Again by design for IPC, but a malicious agent could flood the IPC directory with data. The ZFS quota (1G) provides some protection.

3. **Claude session directory is read-write**: `/home/node/.claude` is `rw`. This allows the agent to modify its own Claude session configuration, including `settings.json`.

4. **`chmod 777 /home/node`** (setup-jail-template.sh:217, setup-freebsd.sh:499): World-writable home directory in the template. This is unnecessarily permissive. Should be `755` or `750`. The node user (uid 1000) should own it, other users should not need write access.

5. **`chmod 1777 /tmp`** (lifecycle.ts:308): This is standard for `/tmp` but combined with the lack of `noexec` on the jail's tmpfs, it means the agent can write and execute arbitrary binaries in `/tmp`. The entrypoint already compiles TypeScript there, so this is somewhat expected, but it expands the attack surface.

6. **Validation only on `additionalMounts`**: The `validateJailMount()` function in `mounts.ts` is only called on additional mounts (line 119). The standard mounts (project, group, IPC, session, agent runner) bypass validation entirely. While these paths are derived from trusted configuration, a defense-in-depth approach would validate all mounts.

---

## 4. ZFS Security

### What is good

- **ZFS clones from snapshot**: Correct approach. Each jail gets an instant COW clone of the template. Changes are isolated.
- **Quota enforcement**: `zfs set quota=1G` on each jail dataset. This prevents a runaway jail from filling the pool. The 1G default is configurable via `NANOCLAW_JAIL_QUOTA`.
- **`setuid=off`**: `zfs set setuid=off` on the jail dataset. This prevents SUID binaries from being effective on the jail's filesystem. Good.
- **Template snapshot integrity**: `setup-jail-template.sh` generates a SHA-256 manifest and validates the snapshot with a test clone.
- **Compression and atime**: `lz4` compression and `atime=off` on the jails dataset parent. Standard good practice.

### Problems

1. **No `exec=off` on jail dataset**: The ZFS dataset allows execution. Combined with the writable `/tmp` and `/workspace/group`, an agent can write and execute arbitrary binaries anywhere on the jail's own filesystem. Setting `exec=off` on the jail dataset and only allowing execution from the read-only template content would be more secure, but would break the TypeScript compilation workflow (which writes compiled JS to `/tmp`).

2. **`zfs destroy -f -r`**: The cleanup uses `zfs destroy -f -r` (lifecycle.ts:553). The `-f` flag force-unmounts dependent filesystems. While necessary for cleanup, this is destructive and could mask issues with leaked mounts.

3. **No ZFS delegation**: The code uses `sudo zfs` for all ZFS operations. This is fine, but the sudoers file allows `zfs list *` and `zfs destroy * zroot/nanoclaw/jails/*` -- the wildcard on `destroy` is broad. A compromised process could destroy any jail dataset, not just its own.

4. **Template protection**: The template dataset has no `readonly=on` property set. A bug in the code could accidentally modify the template. Only the snapshot is immutable. Consider `zfs set readonly=on` on the template dataset after snapshot creation.

---

## 5. Process Isolation

### Execution model

Commands run inside jails via `jexec -U node` (exec.ts:30-31), which runs as the `node` user (uid 1000). This is correct -- never run as root inside the jail.

### Problems

1. **No `exec.clean`**: As mentioned in Section 1, the jail configuration does not set `exec.clean`. The `jexec` command itself does not clean the environment either. The `spawnInJail()` function (exec.ts:147-182) passes environment variables explicitly via `env` command, but it prepends them to the existing environment rather than replacing it.

   In `execInJail()` (exec.ts:38-45), the environment is passed via `env KEY=VALUE ...` which adds to the inherited environment. Any environment variable from the host process (including Node.js internals, `HOME`, `PATH`, etc.) leaks into the jail.

   The `spawnInJail()` function is worse -- it always runs `env` with the provided variables but does not clear the existing environment first. There is no `env -i` (clean environment) call.

   **Recommendation**: Use `env -i` before setting variables, or set `exec.clean` in jail.conf.

2. **`umask 002`**: Both `execInJail` and `spawnInJail` set `umask 002`. This means files created by the agent are group-writable. Given that the node user is in group `wheel` (gid 0), this means files are writable by the wheel group. This is intentional for shared host/jail access but is more permissive than necessary.

3. **Process killing**: On timeout, `killJailProcesses()` (exec.ts:64-74) sends `kill -9 -1` to the jail, which kills ALL processes in the jail. This is correct for cleanup but provides no opportunity for graceful shutdown.

---

## 6. Privilege Escalation Vectors

### Sudoers analysis

The sudoers file generated by `setup-freebsd.sh` (lines 267-302) grants NOPASSWD access to:

```
/usr/sbin/jail -c name=nanoclaw_*    # restricted to nanoclaw_ prefix
/usr/sbin/jail -r nanoclaw_*         # restricted to nanoclaw_ prefix
/usr/sbin/jexec *                    # UNRESTRICTED
/usr/sbin/jls *                      # UNRESTRICTED
/sbin/zfs clone ...                  # restricted to nanoclaw datasets
/sbin/zfs destroy * zroot/nanoclaw/* # partially restricted
/sbin/zfs list *                     # UNRESTRICTED (read-only, acceptable)
/sbin/mount_nullfs                   # UNRESTRICTED
/sbin/umount                         # UNRESTRICTED
/sbin/ifconfig                       # UNRESTRICTED
/sbin/route                          # UNRESTRICTED
/bin/mkdir                           # UNRESTRICTED
/bin/chmod                           # UNRESTRICTED
/usr/sbin/chown                      # UNRESTRICTED
/bin/cp                              # UNRESTRICTED
/usr/bin/tee                         # UNRESTRICTED
/usr/bin/rctl                        # UNRESTRICTED
/sbin/pfctl -si                      # restricted to status info
```

**Critical issues**:

1. **`/usr/sbin/jexec *`**: This allows executing ANY command in ANY jail, not just nanoclaw jails. If another jail system (iocage, bastille) is running on the same host, the nanoclaw user can execute commands in those jails. Should be restricted to `jexec nanoclaw_*`.

2. **`/sbin/mount_nullfs` unrestricted**: Can mount any filesystem anywhere. An attacker who compromises the nanoclaw process can mount arbitrary host directories into a jail and read sensitive files. Should be restricted to specific paths.

3. **`/sbin/umount` unrestricted**: Can unmount any filesystem. Could be used to unmount critical host filesystems.

4. **`/sbin/ifconfig` unrestricted**: Can modify any network interface, not just epairs. Could bring down the host's primary interface, add aliases, change MTUs, etc.

5. **`/bin/chmod`, `/usr/sbin/chown`, `/bin/cp` unrestricted**: Can change permissions, ownership, or copy files ANYWHERE on the system. This is essentially root access with extra steps. A compromised nanoclaw process could `sudo chown nanoclaw /etc/shadow` or `sudo cp /etc/master.passwd /tmp/stolen`.

6. **`/sbin/route` unrestricted**: Can modify the host's routing table.

7. **`/usr/bin/rctl` unrestricted**: Can add or remove resource limits on any jail or process, not just nanoclaw ones.

**The sudoers file is the single biggest security problem in this deployment.** The unrestricted `chmod`, `chown`, `cp`, `mount_nullfs`, and `umount` entries effectively give the nanoclaw user root-equivalent filesystem access.

**Recommendation**: Restrict every sudoers entry with argument constraints:

```
# jexec restricted to nanoclaw jails only
nanoclaw ALL=(ALL) NOPASSWD: /usr/sbin/jexec nanoclaw_*

# mount_nullfs restricted to jail paths
nanoclaw ALL=(ALL) NOPASSWD: /sbin/mount_nullfs -o ro * /home/nanoclaw/code/nanoclaw/jails/*
nanoclaw ALL=(ALL) NOPASSWD: /sbin/mount_nullfs -o rw * /home/nanoclaw/code/nanoclaw/jails/*

# umount restricted to jail paths
nanoclaw ALL=(ALL) NOPASSWD: /sbin/umount /home/nanoclaw/code/nanoclaw/jails/*
nanoclaw ALL=(ALL) NOPASSWD: /sbin/umount -f /home/nanoclaw/code/nanoclaw/jails/*

# ifconfig restricted to epair operations
nanoclaw ALL=(ALL) NOPASSWD: /sbin/ifconfig epair create
nanoclaw ALL=(ALL) NOPASSWD: /sbin/ifconfig epair[0-9]* *

# mkdir/chmod/chown restricted to jail paths
nanoclaw ALL=(ALL) NOPASSWD: /bin/mkdir -p /home/nanoclaw/code/nanoclaw/jails/*
nanoclaw ALL=(ALL) NOPASSWD: /bin/chmod * /home/nanoclaw/code/nanoclaw/jails/*
nanoclaw ALL=(ALL) NOPASSWD: /usr/sbin/chown * /home/nanoclaw/code/nanoclaw/jails/*

# cp restricted to jail paths
nanoclaw ALL=(ALL) NOPASSWD: /bin/cp * /home/nanoclaw/code/nanoclaw/jails/*

# rctl restricted to nanoclaw jails
nanoclaw ALL=(ALL) NOPASSWD: /usr/bin/rctl -a jail\:nanoclaw_*
nanoclaw ALL=(ALL) NOPASSWD: /usr/bin/rctl -r jail\:nanoclaw_*
```

### Actual code usage vs sudoers

The code in `sudo.ts` wraps everything through `sudo <args>`. It uses `execFile('sudo', args)` which prevents shell injection (good -- `execFile` does not invoke a shell). However, the args themselves come from jail names that are derived from user-controlled group IDs. The `sanitizeJailName()` function (lifecycle.ts:50-66) strips non-alphanumeric characters and appends a hash, which prevents command injection through jail names.

---

## 7. Credential Proxy

### Architecture

The credential proxy (`credential-proxy.ts`) is a localhost HTTP server that:
1. Accepts requests from jails
2. Validates source IP is in the jail subnet
3. Validates per-jail token (UUID generated on jail creation)
4. Injects real API credentials
5. Forwards to upstream API

### What is good

- **Per-jail tokens**: Each jail gets a unique UUID token registered on creation, revoked on destruction. Prevents one jail from impersonating another.
- **Source IP validation**: `isAllowedSource()` checks that the remote address starts with the jail subnet prefix.
- **Path validation**: Only `/v1/` and `/api/oauth/` paths are proxied. Other paths return 404.
- **Rate limiting**: 60 requests per minute per IP. Prevents abuse.
- **Header stripping**: Hop-by-hop headers and `x-jail-token` are stripped before forwarding.
- **Credential injection**: API keys are injected server-side; the jail never sees real credentials.

### Problems

1. **Proxy binds to single IP**: As discussed in the network section, the proxy binds to `10.99.0.1`. It needs to bind to `0.0.0.0` or to all gateway IPs (`10.99.N.1` for all active N) to be reachable from all jails in the /16 address space.

2. **Source IP validation is prefix-based**: `isAllowedSource()` checks `addr.startsWith(subnet + '.')` where subnet is `10.99`. This means any address starting with `10.99.` is allowed. This is too broad if the subnet prefix were shorter, but with `10.99` it matches the intended range.

3. **No TLS between jail and proxy**: The jail connects to the proxy over plaintext HTTP. The epair is a point-to-point link, so there is no network-level eavesdropping risk, but the lack of TLS means there is no authentication of the proxy endpoint. If an attacker could somehow redirect the jail's traffic (e.g., via a compromised route table inside the vnet), they could MITM the proxy connection and steal the injected credentials.

   In practice, the vnet isolation makes this very difficult, but defense-in-depth would suggest at least mTLS.

4. **Token bypass when no tokens registered**: Line 115: `if (validTokens.size > 0)`. If no tokens are registered (e.g., Docker mode), token validation is skipped entirely. This is by design but means a misconfiguration where tokens are not registered leaves the proxy open to any source in the allowed IP range.

5. **No request body size limit**: The proxy buffers the entire request body in memory (`chunks.push(c)`). A malicious jail could send an extremely large request body to exhaust host memory. Should add a body size limit (e.g., 10MB).

6. **Response streaming without size limit**: The upstream response is piped directly to the jail. If the upstream sends a very large response, it flows through. This is less of a concern since the upstream is Anthropic's API.

---

## 8. rc.d Script Quality

### The script (etc/rc.d/nanoclaw)

```sh
#!/bin/sh
#
# PROVIDE: nanoclaw
# REQUIRE: LOGIN NETWORKING
# KEYWORD: shutdown

. /etc/rc.subr

name="nanoclaw"
rcvar="${name}_enable"

load_rc_config $name

: ${nanoclaw_enable:="NO"}
: ${nanoclaw_user:="jims"}
: ${nanoclaw_dir:="/home/${nanoclaw_user}/code/nanoclaw/src"}

pidfile="/var/run/${name}.pid"
command="/usr/sbin/daemon"
command_args="-f -p ${pidfile} -u ${nanoclaw_user} -o /var/log/nanoclaw.log /usr/local/bin/node ${nanoclaw_dir}/dist/index.js"

run_rc_command "$@"
```

### Problems

1. **No `depend()` function**: The `REQUIRE` line specifies `LOGIN NETWORKING` but there is no `depend()` function that could also specify `BEFORE` or `USE` dependencies. This is minor but means the script relies solely on `rcorder` parsing. Should add `REQUIRE: LOGIN NETWORKING pf` since pf must be running before jails can use restricted networking.

2. **No `stop_cmd` or `stop_postcmd`**: The script relies on the default `kill -TERM` from rc.subr. NanoClaw has its own graceful shutdown handler (index.ts:624), but if it does not exit within the default timeout, rc.subr sends SIGKILL. There is no `stop_postcmd` to clean up orphaned jails after an unclean shutdown. Adding jail cleanup on stop would prevent orphans.

3. **Hardcoded user `jims`**: The default user is `jims`. While overridable via rc.conf, the default should be something more generic like `nanoclaw`.

4. **No `status_cmd`**: The script does not define a custom status command that could show active jail count, proxy status, etc. The default `check_pidfile` from rc.subr works but is minimal.

5. **Log file permissions**: The log file `/var/log/nanoclaw.log` is created by daemon(8) running as the nanoclaw user. The `-o` flag to daemon(8) will create the file if it does not exist, but does not set permissions. Should be created with mode 640 or 600.

6. **No log rotation**: No `newsyslog.conf` entry for `/var/log/nanoclaw.log`. The log will grow unbounded.

7. **No `required_dirs` or `required_files`**: The script does not verify that `nanoclaw_dir` exists or that `dist/index.js` exists before starting. A failed build will result in a confusing error.

8. **Signal handling**: daemon(8) with `-f` runs the process in the foreground (from daemon's perspective, detached from terminal). Signals sent to the daemon PID are forwarded to the child process. This is correct but there is no `sig_stop` or `sig_reload` defined, so the defaults (SIGTERM for stop) apply.

**Recommended improvements**:

```sh
#!/bin/sh
#
# PROVIDE: nanoclaw
# REQUIRE: LOGIN NETWORKING pf
# KEYWORD: shutdown

. /etc/rc.subr

name="nanoclaw"
rcvar="${name}_enable"

load_rc_config $name

: ${nanoclaw_enable:="NO"}
: ${nanoclaw_user:="nanoclaw"}
: ${nanoclaw_dir:="/home/${nanoclaw_user}/code/nanoclaw/src"}

pidfile="/var/run/${name}.pid"
required_dirs="${nanoclaw_dir}"
required_files="${nanoclaw_dir}/dist/index.js"

command="/usr/sbin/daemon"
command_args="-f -p ${pidfile} -u ${nanoclaw_user} -o /var/log/nanoclaw.log /usr/local/bin/node ${nanoclaw_dir}/dist/index.js"

stop_postcmd="${name}_cleanup"

nanoclaw_cleanup() {
    # Clean up orphaned jails after stop
    for jail in $(jls -N name 2>/dev/null | grep '^nanoclaw_'); do
        jail -r "$jail" 2>/dev/null || true
    done
}

run_rc_command "$@"
```

---

## 9. pf Rules Analysis

### Standalone config (pf-nanoclaw.conf)

**The good**:
- Pinned IP table for Anthropic API (prevents DNS poisoning) -- smart
- Trusted DNS restriction (8.8.8.8, 1.1.1.1 only)
- Inter-jail traffic blocked (`block drop quick from $jail_net to $jail_net`)
- Credential proxy port (3001) allowed before inter-jail block
- Blocked traffic logged to pflog0
- `scrub in` for packet normalization
- `keep state` for stateful filtering

**The bad**:

1. **CRITICAL: `jail_net = "10.99.0.0/24"` is wrong for the addressing scheme** (see Section 2). Must be `/16` to cover `10.99.0.0` through `10.99.255.255`.

2. **`pass on $ext_if all` without `quick`**: This is a catch-all pass rule for the external interface. While jail traffic is caught by `quick` rules earlier, this means any non-jail traffic passes. If the host is directly exposed to the internet (not behind a firewall), this provides zero host protection. The rule should at minimum be `pass out on $ext_if all` (outbound only) with explicit inbound rules.

3. **Epair rules are too broad**:
   ```
   block on epair all
   pass quick on epair proto tcp to port 3001
   pass quick on epair proto { tcp, udp } to port 53
   pass quick on epair proto tcp to port 443
   ```
   The `pass quick on epair proto tcp to port 443` allows the jail to connect to ANY destination on port 443, not just the Anthropic API. The ext_if rules restrict the destination, but the epair pass rule creates state entries that may interfere. The epair rules should restrict destinations:
   ```
   pass quick on epair proto tcp to port 3001
   pass quick on epair proto { tcp, udp } to $trusted_dns port 53
   pass quick on epair proto tcp to <anthropic_api> port 443
   ```

4. **No anti-spoofing**: There are no `antispoof` rules. While jails use vnet and cannot easily spoof IPs that would bypass pf, adding `antispoof quick for $ext_if` is standard practice.

5. **No state limits**: The rules do not set `max-src-states` or `max-src-conn` on stateful rules. A jail could create thousands of state entries and exhaust the state table.

6. **IPv6 considerations**: The anthropic_api table includes an IPv6 range (`2607:6bc0::/48`) but there are no IPv6-specific rules. If the host has IPv6, jail traffic might bypass pf rules via IPv6. Should either have explicit IPv6 rules or `block quick inet6 from $jail_net to any`.

### Anchor config (pf-nanoclaw-anchor.conf)

1. **Uses `lo1` interface**: Does not match the vnet/epair architecture. This config appears stale/incorrect for the current implementation.

2. **Allows all jail-to-jail traffic**: Two rules pass all traffic within `10.99.0.0/24` on `lo1`. This defeats isolation.

3. **Same /24 bug**: Uses `10.99.0.0/24` which is insufficient.

4. **Redundant rules**: Lines 46 and 53 are essentially the same rule (pass on lo1 from jail_net to jail_net).

---

## 10. What is Missing

### Missing from a proper FreeBSD jail deployment

1. **No `cpuset` / `cpuset_id` configuration**: Jails should be pinned to specific CPUs or CPU sets to prevent a jail from monopolizing all cores. While `rctl pcpu:deny=80` limits total CPU percentage, `cpuset` provides hard isolation.

   ```sh
   cpuset -l 0-3 -j $jailname
   ```

2. **No `rctl` for disk I/O**: The `rctl` limits only cover `memoryuse`, `maxproc`, and `pcpu`. Missing:
   - `readbps` / `writebps` -- disk I/O bandwidth limits
   - `readiops` / `writeiops` -- disk I/O operations limits
   - `openfiles` -- maximum open file descriptors
   - `vmemoryuse` -- virtual memory limit (distinct from resident memory)
   - `stacksize` -- stack size limit
   - `wallclock` -- wall clock time limit (the code handles timeout at the process level, but rctl would be a kernel-enforced backstop)

3. **No `devfs_ruleset` file deployment**: The `etc/devfs.rules` file exists but is not automatically installed by `setup-freebsd.sh`. Step 4 in the FREEBSD_JAILS.md docs mentions copying it manually. The setup script should install it and verify it is loaded.

4. **No `/etc/jail.conf` or `/etc/jail.conf.d/` usage**: The code generates per-jail conf files in the jails directory. This is functional but non-standard. Using `/etc/jail.conf.d/` would integrate with the system's jail management tools (`service jail start/stop`).

5. **No Capsicum sandboxing**: FreeBSD's Capsicum capability mode could sandbox the Node.js process itself, restricting its access to only the file descriptors it needs. This is admittedly difficult with Node.js, but worth mentioning.

6. **No MAC framework**: FreeBSD's Mandatory Access Control framework (`mac_bsdextended`, `mac_portacl`) could provide additional layer of access control. For example, `mac_portacl` could restrict which UIDs can bind to specific ports, hardening the credential proxy.

7. **No `kern.securelevel` on the host**: While the jails have `securelevel = 3`, the host itself does not appear to set `securelevel`. This means the host's kernel can still be modified.

8. **No auditd**: FreeBSD's audit subsystem (`auditd`) is not configured. Jail operations (creation, destruction, command execution) are logged by the application but not by the OS audit framework. For a security-sensitive deployment, BSM audit trails would be valuable.

9. **No `syslogd` forwarding from jails**: Jails have no syslog configuration. Any syslog messages from processes inside the jail are lost. Should configure `syslogd` to forward jail logs to the host.

10. **No `login.conf` limits**: FreeBSD's `login.conf` can set per-class resource limits. The `node` user's login class could be configured with restrictive limits as a belt-and-suspenders approach alongside rctl.

---

## 11. Comparison to Best Practices

### vs. FreeBSD Handbook

The FreeBSD Handbook recommends:
- **Thin jails** with base system on read-only nullfs: NanoClaw uses ZFS clones instead, which is a reasonable alternative but gives each jail a writable copy of the base system.
- **`exec.start` and `exec.stop`** commands: Not configured. Default `/bin/sh /etc/rc` might run inside the jail.
- **`mount.devfs` with strict ruleset**: Present. The ruleset is reasonably restrictive.
- **Host-level `securelevel`**: Not configured.

### vs. iocage/bastille patterns

- **iocage** uses per-jail `jail.conf` with all security parameters explicitly set. NanoClaw's conf is sparse.
- **iocage** manages devfs rulesets per jail. NanoClaw uses a single ruleset (10) for all jails.
- **bastille** creates dedicated ZFS datasets per jail with explicit properties. NanoClaw does this but misses `exec=off`.
- Both iocage and bastille have built-in resource limit management. NanoClaw's rctl integration is present but incomplete.
- Both frameworks handle log rotation and auditing. NanoClaw has neither.

### What NanoClaw does BETTER than some jail frameworks

- **Per-jail credential tokens**: Unique authentication per jail is a nice security touch.
- **Ephemeral jails**: Jails are created and destroyed per-conversation. This limits the window of exposure -- a compromised jail is destroyed after use.
- **Pinned API IPs in pf**: Prevents DNS poisoning attacks on the allowlist. Most jail setups use hostname-based rules.
- **Mount validation**: The blocked path patterns and symlink resolution in mount validation are thorough.
- **ZFS quota + setuid=off**: Proper ZFS-level restrictions on jail datasets.

---

## 12. Specific Vulnerabilities

### CRITICAL

1. **pf `jail_net` CIDR mismatch** (pf-nanoclaw.conf:139): `10.99.0.0/24` should be `10.99.0.0/16`. All jails except epair0 have unfiltered network access in restricted mode. See Section 2.

2. **Credential proxy only reachable by jail 0** (container-runtime.ts:43): Proxy binds to `10.99.0.1` but jails connect via `10.99.N.1`. See Section 2.

3. **Sudoers grants near-root access** (setup-freebsd.sh:291-295): Unrestricted `sudo chmod`, `sudo chown`, `sudo cp`, `sudo mount_nullfs`, `sudo umount`. See Section 6.

### HIGH

4. **No `exec.clean` in jail.conf**: Host environment leaks into jail processes. Could expose sensitive environment variables.

5. **Missing `children.max = 0`**: Jail could potentially create child jails.

6. **Missing SysV IPC isolation**: Default `inherit` mode means jails share SysV IPC namespace with host.

7. **DNS resolver mismatch**: Jail copies host `resolv.conf` but pf only allows 8.8.8.8 and 1.1.1.1. If host uses different DNS, jail DNS fails.

8. **Anchor config is stale**: Uses `lo1` interface model, does not match vnet/epair code.

### MEDIUM

9. **`chmod 777 /home/node`**: World-writable home directory in template.

10. **No request body size limit on credential proxy**: Memory exhaustion vector.

11. **Epair pf rules allow port 443 to any destination**: Should be restricted to `<anthropic_api>` table.

12. **`pass on $ext_if all`**: Passes all non-jail traffic on external interface, providing no host firewall protection.

13. **No log rotation for `/var/log/nanoclaw.log`**.

14. **rc.d script does not clean up jails on stop**.

### LOW

15. **No `antispoof` rules in pf**.

16. **No state table limits in pf rules**.

17. **Template dataset not set to `readonly=on`**.

18. **No cpuset pinning**.

19. **Missing rctl limits for disk I/O, open files, wallclock**.

---

## 13. Summary and Recommendations

### Priority 1 (Fix immediately)

1. **Change `jail_net` to `"10.99.0.0/16"` in `pf-nanoclaw.conf`**. This is a showstopper -- the firewall does not cover the actual address space used by jails.

2. **Fix credential proxy bind address**. Either bind to `0.0.0.0` (and rely on pf + token auth for security) or bind to each jail's gateway IP when creating the epair. The simpler fix is to bind to `0.0.0.0` since the token auth and source IP check already provide authentication.

3. **Restrict sudoers entries**. At minimum, restrict `chmod`, `chown`, `cp`, `mount_nullfs`, and `umount` to jail paths. Remove `tee`. This is the difference between "compromised nanoclaw process" and "compromised host".

### Priority 2 (Fix before production)

4. **Add missing jail.conf parameters**: `children.max=0`, `allow.raw_sockets=0`, `allow.mount=0`, `allow.set_hostname=0`, `allow.sysvipc=0`, `allow.chflags=0`, `exec.clean`, `sysvshm=new`, `sysvmsg=new`, `sysvsem=new`.

5. **Fix DNS resolver**: Either hardcode `nameserver 8.8.8.8` and `nameserver 1.1.1.1` in the jail's resolv.conf, or dynamically match the pf trusted_dns list to whatever the host uses.

6. **Restrict epair pf rules**: Add destination restrictions to the epair pass rules for port 443.

7. **Install devfs.rules automatically** in `setup-freebsd.sh`.

8. **Fix or remove `pf-nanoclaw-anchor.conf`** to match the vnet/epair architecture.

### Priority 3 (Hardening)

9. Add `cpuset` pinning for jails.
10. Add rctl limits for `openfiles`, `vmemoryuse`, `readbps`, `writebps`.
11. Add request body size limit to credential proxy.
12. Add `newsyslog.conf` entry for log rotation.
13. Add `stop_postcmd` to rc.d script for jail cleanup.
14. Add `antispoof` and state limits to pf rules.
15. Set `readonly=on` on the template ZFS dataset.
16. Change `/home/node` permissions from 777 to 755 in template.
17. Add `REQUIRE: pf` to rc.d script.
18. Use `env -i` for clean environment in jail command execution.

### Overall Assessment

The architecture is sound. vnet/epair for network isolation, ZFS clones for filesystem isolation, devfs rulesets for device restriction, rctl for resource limits, and a credential proxy for credential isolation -- these are the right building blocks. The implementation is well-structured, the code is readable, and the error handling is thorough.

However, the devil is in the details, and the details here have real gaps. The subnet CIDR mismatch alone means the firewall is not actually filtering jail traffic. The sudoers configuration effectively grants root access. And several standard jail hardening parameters are missing.

The foundation is good. The security posture needs work. Fix the three Priority 1 items and you have something I would grudgingly approve for production.

-- End of report --
