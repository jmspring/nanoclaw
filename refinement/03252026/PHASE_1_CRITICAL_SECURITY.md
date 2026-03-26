# Phase 1: Critical Security Fixes

**Priority**: P0 -- fix immediately
**Rationale**: The FreeBSD sysadmin and SRE reports independently identified these as active bugs affecting all multi-jail deployments. Any deployment running more than one concurrent jail has broken firewall rules, unreachable credential proxy, and potential DNS failures.
**Dependencies**: None
**Acceptance**: All pf rules use correct /16 CIDR. Credential proxy reachable from any jail. DNS resolv.conf matches pf trusted servers. Epair rules restrict port 443 to anthropic_api table only.

---

## Stage 1A: Fix pf jail_net CIDR from /24 to /16

### Ticket Header

| Field | Value |
|-------|-------|
| **Ticket ID** | `nc-p1a` |
| **Title** | Fix pf jail_net CIDR from /24 to /16 |
| **Priority** | P0 |
| **Tags** | `nanoclaw`, `phase-1`, `security`, `pf`, `network` |
| **Files Affected** | `etc/pf-nanoclaw.conf` |
| **Dependencies** | None |

### Context

The pf firewall configuration defines the jail network macro as `jail_net = "10.99.0.0/24"` (file `etc/pf-nanoclaw.conf`, line 139). However, the actual addressing scheme allocates each jail N a /30 subnet at `10.99.N.0/30`, where N is the epair number ranging from 0 to 255. This means jail IPs span `10.99.0.2` through `10.99.255.2` -- the full `10.99.0.0/16` address space.

The `/24` CIDR only covers `10.99.0.0` through `10.99.0.255`. Any jail with epair number >= 1 has addresses outside the pf filter range. Concretely:
- Jail 0: IP `10.99.0.2` -- matched by `/24` (works)
- Jail 1: IP `10.99.1.2` -- NOT matched by `/24` (broken)
- Jail N: IP `10.99.N.2` -- NOT matched by `/24` for N > 0 (broken)

This affects every rule that references `$jail_net`: NAT (line 190), credential proxy pass (line 220), inter-jail block (line 228), DNS pass (lines 233-234), API pass (line 239), and the catch-all block (line 243). The epair IP allocation logic is in `src/jail/network.ts` lines 141-142, which uses `${JAIL_CONFIG.jailSubnet}.${epairNum}.1` and `.2`.

**Identified by**: FreeBSD Sysadmin Report, Section 2 ("CRITICAL BUG") and Section 9 item 1; SRE Report, Section 8.1.

**Impact**: All jails except the first one have unfiltered network access when using restricted mode. NAT, egress filtering, and inter-jail isolation are all bypassed.

### Developer Prompt

```
Read `refinement/03252026/SHARED_INSTRUCTIONS.md` first.

## Ticket: nc-p1a -- Fix pf jail_net CIDR from /24 to /16

### Problem
In `etc/pf-nanoclaw.conf`, line 139, the jail network macro is defined as:

    jail_net = "10.99.0.0/24"

This is wrong. The addressing scheme uses 10.99.N.0/30 per jail where N ranges
0-255 (see src/jail/network.ts lines 141-142). The correct CIDR is /16 to cover
10.99.0.0 through 10.99.255.255.

### Changes Required

1. **File: `etc/pf-nanoclaw.conf`**

   **Line 139** -- Change:
       jail_net = "10.99.0.0/24"
   To:
       jail_net = "10.99.0.0/16"

2. **Update comments that reference "/24"** in the same file. There are several
   comments that say "/24 pool" or reference "/24". Update them to say "/16":
   - Line 134: "Jail network - entire /24 pool" -> "Jail network - entire /16 pool"
   - Line 138: "This allows up to 256 concurrent jails" -- keep this, it is correct.
   - Line 201-202: "from 10.99.0.0/24 pool" -> "from 10.99.0.0/16 pool"
   - Line 265: "from the /24 pool" -> "from the /16 pool"
   - Line 269: "Supports up to 256 concurrent jails" -- keep this, it is correct.

   Also update line 23 in the header comment:
   - "from the /24 pool:" -> "from the /16 pool:"

   Do NOT change the /30 references (those are per-jail subnets and are correct).

3. **Update the epair number validation in `src/jail/network.ts`**:
   Line 133-136 currently says:
       if (epairNum < 0 || epairNum > 255) {
         throw new Error(
           `Epair number ${epairNum} exceeds /24 pool capacity (0-255)`,
         );
       }
   Change the error message from "/24 pool capacity" to "/16 pool capacity".

### Acceptance Criteria
- [ ] `jail_net` macro is `"10.99.0.0/16"`
- [ ] All comments referencing the pool CIDR say /16 (not /24)
- [ ] /30 per-jail subnet references are unchanged
- [ ] `sudo pfctl -nf etc/pf-nanoclaw.conf` parses without error (if on FreeBSD; skip if not)
- [ ] `npm test` passes
- [ ] `npx tsc --noEmit` passes
- [ ] `npm run lint` passes

Report IMPLEMENTATION_COMPLETE when done.
```

### QA Prompt

```
Read `refinement/03252026/SHARED_INSTRUCTIONS.md` first.

## QA Validation: nc-p1a -- Fix pf jail_net CIDR from /24 to /16

### Baseline Checks
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only expected files (etc/pf-nanoclaw.conf, src/jail/network.ts)
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

### Ticket-Specific Checks

1. [ ] **Verify jail_net macro value**: Read `etc/pf-nanoclaw.conf` and confirm the line
       defining `jail_net` is exactly: `jail_net = "10.99.0.0/16"`

2. [ ] **Verify no /24 pool references remain**: Search `etc/pf-nanoclaw.conf` for the
       string "/24". The ONLY occurrences should be in the per-jail /30 subnet description
       context (e.g., "10.99.N.0/30") -- there should be ZERO references to "/24 pool"
       or "10.99.0.0/24" anywhere in the file.

3. [ ] **Verify /30 references are preserved**: Confirm that per-jail subnet references
       (e.g., "10.99.N.0/30", "/30 subnet") are still present and unchanged.

4. [ ] **Verify /16 pool references exist**: Search for "/16" in the file and confirm
       that the pool description comments now reference /16.

5. [ ] **Verify epair error message updated**: Read `src/jail/network.ts` line 135 area
       and confirm the error message says "/16 pool capacity" not "/24 pool capacity".

6. [ ] **Verify pf syntax (FreeBSD only)**: Run `sudo pfctl -nf etc/pf-nanoclaw.conf`
       and confirm it parses without errors. If not on FreeBSD, report as SKIP.

7. [ ] **Verify no functional rule changes**: The actual pf filter/NAT rules (pass, block,
       nat lines) should be identical to before except that $jail_net now expands to
       10.99.0.0/16. Confirm no rules were added, removed, or reordered.

Report QA_PASS or QA_FAIL with per-check results.
```

---

## Stage 1B: Fix credential proxy bind address for multi-jail

### Ticket Header

| Field | Value |
|-------|-------|
| **Ticket ID** | `nc-p1b` |
| **Title** | Fix credential proxy bind address for multi-jail |
| **Priority** | P0 |
| **Tags** | `nanoclaw`, `phase-1`, `security`, `proxy`, `network` |
| **Files Affected** | `src/container-runtime.ts`, `src/jail/config.ts` |
| **Dependencies** | None (can run in parallel with 1A) |

### Context

The credential proxy binds to a single IP address determined by `PROXY_BIND_HOST` in `src/container-runtime.ts`, line 36-43. The `detectProxyBindHost()` function (line 39-43) returns `${subnet}.0.1` for jail mode, which resolves to `10.99.0.1`. This is the gateway IP for jail 0 only.

However, each jail connects to its own gateway at `10.99.N.1` (where N is the epair number). The jail runner in `src/jail/runner.ts` line 150 sets `ANTHROPIC_BASE_URL` to `http://${jailConfig.jailHostIP}:${CREDENTIAL_PROXY_PORT}`, and `jailConfig.jailHostIP` is hardcoded to `${jailSubnet}.0.1` in `src/jail/config.ts` line 73. So every jail is told to connect to `10.99.0.1:3001`, but only jail 0's epair can route to that address. Jail 1 can only reach `10.99.1.1`, jail 2 can only reach `10.99.2.1`, etc.

**Result**: The credential proxy is only reachable by jail 0. All other jails fail to connect to the API.

There are two bugs here:
1. The proxy binds to only one gateway IP (`10.99.0.1`) instead of all interfaces (`0.0.0.0`).
2. The jail runner tells all jails to use `10.99.0.1` instead of each jail's actual gateway IP.

**Identified by**: FreeBSD Sysadmin Report, Section 2 item 3 and Section 7 item 1; SRE Report, Section 8.1 item 3 (indirectly via /24 scope discussion).

**Impact**: Only the first jail can reach the credential proxy. All subsequent jails cannot authenticate API requests and will fail.

### Developer Prompt

```
Read `refinement/03252026/SHARED_INSTRUCTIONS.md` first.

## Ticket: nc-p1b -- Fix credential proxy bind address for multi-jail

### Problem
Two related bugs prevent multi-jail credential proxy access:

1. The proxy binds to `10.99.0.1` (a single gateway IP) instead of `0.0.0.0`.
   File: `src/container-runtime.ts`, line 43: `return mode === 'restricted' ? `${subnet}.0.1` : '127.0.0.1';`

2. The jail runner tells ALL jails to connect to `10.99.0.1` regardless of which
   gateway IP the jail can actually reach.
   File: `src/jail/config.ts`, line 73: `jailHostIP: `${jailSubnet}.0.1`,`
   File: `src/jail/runner.ts`, line 150: `ANTHROPIC_BASE_URL: `http://${jailConfig.jailHostIP}:${CREDENTIAL_PROXY_PORT}`,`

### Changes Required

#### Fix 1: Bind proxy to 0.0.0.0 in jail mode

**File: `src/container-runtime.ts`**, function `detectProxyBindHost()` (line 39-43).

Change:
```typescript
if (getRuntime() === 'jail') {
    const mode = process.env.NANOCLAW_JAIL_NETWORK_MODE || 'restricted';
    const subnet = process.env.NANOCLAW_JAIL_SUBNET || '10.99';
    return mode === 'restricted' ? `${subnet}.0.1` : '127.0.0.1';
  }
```

To:
```typescript
if (getRuntime() === 'jail') {
    const mode = process.env.NANOCLAW_JAIL_NETWORK_MODE || 'restricted';
    return mode === 'restricted' ? '0.0.0.0' : '127.0.0.1';
  }
```

The proxy needs to listen on all interfaces so that every jail's gateway IP
(10.99.N.1) can reach it. The pf rules and source IP validation in the
credential proxy (`isAllowedSource()`) already restrict access to the jail
subnet, so binding to 0.0.0.0 does not weaken security.

Note: The `subnet` variable is no longer needed in this branch -- remove it.

#### Fix 2: Pass each jail's actual gateway IP to the runner

**File: `src/jail/runner.ts`**, line 150.

Currently the runner uses `jailConfig.jailHostIP` (which is always `10.99.0.1`).
Instead, the runner should use the actual host IP assigned to this jail's epair.

Read the runner.ts file to understand the full context. The `createJailWithPaths()`
call returns a `JailCreationResult`. Before that call, an epair is created in
`createJail()` (lifecycle.ts line 313) which returns `epairInfo` with `hostIP`.

The approach:
- After creating the jail, retrieve the epair info to get the actual host IP.
- Use that IP for ANTHROPIC_BASE_URL instead of the static jailConfig.jailHostIP.

Look at how the runner calls `jailLifecycle.createJailWithPaths()` and determine
where the epairInfo hostIP can be obtained. The `createEpair()` function in
`network.ts` returns `EpairInfo` with a `hostIP` field. You may need to:
- Export `getAssignedEpair()` from `network.ts` (already exported, line 319)
- After jail creation, look up the epair number and compute the host IP, OR
- Modify `createJailWithPaths` / `createJail` to return the epairInfo in the result.

The cleanest approach: `JailCreationResult` in `types.ts` already has `jailName`
and `mounts`. Add an optional `epairInfo?: EpairInfo` field. Then in
`lifecycle.ts` `createJailWithPaths()`, pass it through from `createJail()`.
In `createJail()`, the `epairInfo` is already available (line 313). Return it
as part of the result.

Then in `runner.ts`, after creating the jail, use:
```typescript
const hostIP = result.epairInfo?.hostIP ?? jailConfig.jailHostIP;
// ...
ANTHROPIC_BASE_URL: `http://${hostIP}:${CREDENTIAL_PROXY_PORT}`,
```

#### Fix 3: Remove stale jailHostIP from config

**File: `src/jail/config.ts`**, line 73-74.

The `jailHostIP` and `jailIP` fields are now misleading since each jail gets a
different IP. Keep them for backward compatibility but add a comment:
```typescript
  /** @deprecated Use epairInfo.hostIP from jail creation result instead. */
  jailHostIP: `${jailSubnet}.0.1`,
  /** @deprecated Use epairInfo.jailIP from jail creation result instead. */
  jailIP: `${jailSubnet}.0.2`,
```

### Acceptance Criteria
- [ ] `detectProxyBindHost()` returns `'0.0.0.0'` when runtime is jail and mode is restricted
- [ ] `ANTHROPIC_BASE_URL` in runner.ts uses the per-jail epairInfo.hostIP, not the static jailHostIP
- [ ] `JailCreationResult` type includes optional `epairInfo` field
- [ ] `createJail()` returns epairInfo in its result (threaded through `createJailWithPaths`)
- [ ] `jailHostIP` and `jailIP` in config.ts have deprecation comments
- [ ] `npm test` passes
- [ ] `npx tsc --noEmit` passes
- [ ] `npm run lint` passes

Report IMPLEMENTATION_COMPLETE when done.
```

### QA Prompt

```
Read `refinement/03252026/SHARED_INSTRUCTIONS.md` first.

## QA Validation: nc-p1b -- Fix credential proxy bind address for multi-jail

### Baseline Checks
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only expected files
    (src/container-runtime.ts, src/jail/config.ts, src/jail/runner.ts,
     src/jail/lifecycle.ts, src/jail/types.ts)
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

### Ticket-Specific Checks

1. [ ] **Verify proxy bind host for jail/restricted mode**: Read `src/container-runtime.ts`,
       function `detectProxyBindHost()`. Confirm that when runtime is 'jail' and mode is
       'restricted', the function returns `'0.0.0.0'` (not a specific IP like `10.99.0.1`).

2. [ ] **Verify proxy bind host for jail/inherit mode**: Confirm that when runtime is 'jail'
       and mode is 'inherit', the function still returns `'127.0.0.1'`.

3. [ ] **Verify ANTHROPIC_BASE_URL uses dynamic host IP**: Read `src/jail/runner.ts` and
       confirm that the `ANTHROPIC_BASE_URL` environment variable uses the per-jail
       epairInfo.hostIP (or a fallback), NOT the static `jailConfig.jailHostIP`.

4. [ ] **Verify JailCreationResult includes epairInfo**: Read `src/jail/types.ts` and
       confirm `JailCreationResult` has an optional `epairInfo?: EpairInfo` field.

5. [ ] **Verify createJail returns epairInfo**: Read `src/jail/lifecycle.ts`, function
       `createJail()`. Confirm that the return type and return value include the
       `epairInfo` when available (restricted network mode).

6. [ ] **Verify createJailWithPaths passes epairInfo through**: Read
       `src/jail/lifecycle.ts`, function `createJailWithPaths()`. Confirm it passes
       the epairInfo from createJail's result into the JailCreationResult.

7. [ ] **Verify config deprecation comments**: Read `src/jail/config.ts` lines 73-74
       and confirm `jailHostIP` and `jailIP` have deprecation comments.

8. [ ] **Verify no unused variables**: Confirm the `subnet` variable was removed from
       the jail branch in `detectProxyBindHost()` since it is no longer needed.

9. [ ] **Verify existing tests still pass**: Run `npm test` and confirm no regressions,
       especially in jail-related test files.

Report QA_PASS or QA_FAIL with per-check results.
```

---

## Stage 1C: Fix DNS resolver mismatch (jail resolv.conf vs pf trusted DNS)

### Ticket Header

| Field | Value |
|-------|-------|
| **Ticket ID** | `nc-p1c` |
| **Title** | Fix DNS resolver mismatch (jail resolv.conf vs pf trusted DNS) |
| **Priority** | P0 |
| **Tags** | `nanoclaw`, `phase-1`, `security`, `dns`, `network` |
| **Files Affected** | `src/jail/network.ts` |
| **Dependencies** | None (can run in parallel with 1A, 1B) |

### Context

The pf rules in `etc/pf-nanoclaw.conf` restrict DNS traffic to only two trusted servers (line 166):
```
trusted_dns = "{ 8.8.8.8, 1.1.1.1 }"
```

DNS pass rules (lines 233-234) only allow outbound DNS from the jail network to these two servers:
```
pass out quick on $ext_if proto udp from $jail_net to $trusted_dns port 53 keep state
pass out quick on $ext_if proto tcp from $jail_net to $trusted_dns port 53 keep state
```

However, `setupJailResolv()` in `src/jail/network.ts` (lines 221-241) blindly copies the host's `/etc/resolv.conf` into the jail:
```typescript
const hostResolv = fs.readFileSync('/etc/resolv.conf', 'utf-8');
```

If the host uses a local resolver (e.g., `127.0.0.1`, `::1`, or an ISP DNS like `192.168.1.1`), the jail's DNS queries will go to that address, which is NOT in the pf `trusted_dns` list. The pf catch-all block rule (line 243) will drop these DNS packets, causing DNS resolution failures inside the jail. The jail will be unable to resolve `api.anthropic.com` and all API calls will fail.

**Identified by**: FreeBSD Sysadmin Report, Section 2 item 5.

**Impact**: Any host that does not happen to use 8.8.8.8 or 1.1.1.1 as DNS servers will have broken DNS resolution in all jails, making the credential proxy unable to forward API requests.

### Developer Prompt

```
Read `refinement/03252026/SHARED_INSTRUCTIONS.md` first.

## Ticket: nc-p1c -- Fix DNS resolver mismatch (jail resolv.conf vs pf trusted DNS)

### Problem
`setupJailResolv()` in `src/jail/network.ts` (lines 221-241) copies the host's
`/etc/resolv.conf` into the jail. But the pf rules only allow DNS traffic to
`8.8.8.8` and `1.1.1.1` (the `trusted_dns` macro). If the host uses any other
DNS server (local resolver, ISP DNS, etc.), jail DNS queries are silently blocked
by the firewall.

### Changes Required

**File: `src/jail/network.ts`**, function `setupJailResolv()` (lines 221-241).

Replace the logic that copies the host's resolv.conf with logic that generates
a resolv.conf containing the trusted DNS servers that match the pf rules.

Change the function from:
```typescript
export async function setupJailResolv(jailPath: string): Promise<void> {
  const sudoExec = getSudoExec();
  const resolvPath = path.join(jailPath, 'etc', 'resolv.conf');

  try {
    const hostResolv = fs.readFileSync('/etc/resolv.conf', 'utf-8');
    const tmpFile = path.join('/tmp', `nanoclaw-resolv-${crypto.randomUUID()}`);
    fs.writeFileSync(tmpFile, hostResolv);
    try {
      await sudoExec(['cp', tmpFile, resolvPath]);
    } finally {
      fs.unlinkSync(tmpFile);
    }
    logger.debug({ jailPath, resolvPath }, 'Copied host resolv.conf to jail');
  } catch (error) {
    logger.warn(
      { jailPath, resolvPath, err: error },
      'Could not create jail resolv.conf',
    );
  }
}
```

To:
```typescript
/** DNS servers that match the pf trusted_dns macro in etc/pf-nanoclaw.conf. */
const TRUSTED_DNS_SERVERS = ['8.8.8.8', '1.1.1.1'];

export async function setupJailResolv(jailPath: string): Promise<void> {
  const sudoExec = getSudoExec();
  const resolvPath = path.join(jailPath, 'etc', 'resolv.conf');

  try {
    const resolvContent = TRUSTED_DNS_SERVERS.map(
      (s) => `nameserver ${s}`,
    ).join('\n') + '\n';
    const tmpFile = path.join('/tmp', `nanoclaw-resolv-${crypto.randomUUID()}`);
    fs.writeFileSync(tmpFile, resolvContent);
    try {
      await sudoExec(['cp', tmpFile, resolvPath]);
    } finally {
      fs.unlinkSync(tmpFile);
    }
    logger.debug(
      { jailPath, resolvPath, servers: TRUSTED_DNS_SERVERS },
      'Wrote jail resolv.conf with trusted DNS servers',
    );
  } catch (error) {
    logger.warn(
      { jailPath, resolvPath, err: error },
      'Could not create jail resolv.conf',
    );
  }
}
```

Key points:
- The `TRUSTED_DNS_SERVERS` array must match the servers in the pf `trusted_dns`
  macro (`etc/pf-nanoclaw.conf` line 166).
- Export `TRUSTED_DNS_SERVERS` so it can be referenced in tests.
- The old comment in `pf-nanoclaw.conf` Note 3 (line 282-284) says jails use
  host's resolv.conf. Update it:
  Old (line 282-284):
  ```
  # 3. DNS Resolution:
  #    Jails use a copy of the host's /etc/resolv.conf (done automatically
  #    by jail-runtime.js). This allows jails to reach whatever DNS servers
  #    the host uses without requiring a local resolver on the jail gateway.
  ```
  New:
  ```
  # 3. DNS Resolution:
  #    Jails use a generated resolv.conf with the trusted DNS servers
  #    (8.8.8.8, 1.1.1.1) matching the trusted_dns macro above. This ensures
  #    jail DNS queries are always allowed by the pf rules regardless of what
  #    DNS servers the host uses.
  ```

### Acceptance Criteria
- [ ] `setupJailResolv()` generates a resolv.conf with `8.8.8.8` and `1.1.1.1` instead of copying host resolv.conf
- [ ] `TRUSTED_DNS_SERVERS` constant is exported
- [ ] pf-nanoclaw.conf Note 3 comment updated to reflect the new behavior
- [ ] `npm test` passes
- [ ] `npx tsc --noEmit` passes
- [ ] `npm run lint` passes

Report IMPLEMENTATION_COMPLETE when done.
```

### QA Prompt

```
Read `refinement/03252026/SHARED_INSTRUCTIONS.md` first.

## QA Validation: nc-p1c -- Fix DNS resolver mismatch

### Baseline Checks
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only expected files
    (src/jail/network.ts, etc/pf-nanoclaw.conf)
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

### Ticket-Specific Checks

1. [ ] **Verify resolv.conf is generated, not copied**: Read `src/jail/network.ts`,
       function `setupJailResolv()`. Confirm it does NOT read `/etc/resolv.conf`.
       Confirm it generates content from a `TRUSTED_DNS_SERVERS` array.

2. [ ] **Verify DNS servers match pf rules**: Confirm that the `TRUSTED_DNS_SERVERS`
       array contains exactly `['8.8.8.8', '1.1.1.1']`. Cross-reference with
       `etc/pf-nanoclaw.conf` line 166 (`trusted_dns = "{ 8.8.8.8, 1.1.1.1 }"`).
       The servers must match.

3. [ ] **Verify resolv.conf content format**: The generated resolv.conf content should
       be in standard format: `nameserver 8.8.8.8\nnameserver 1.1.1.1\n`. Each server
       on its own line prefixed with `nameserver `.

4. [ ] **Verify TRUSTED_DNS_SERVERS is exported**: Confirm the constant is exported
       from `src/jail/network.ts` so it can be imported in tests.

5. [ ] **Verify pf comment updated**: Read `etc/pf-nanoclaw.conf` and find Note 3
       (around line 282-284). Confirm it no longer says "copy of the host's
       /etc/resolv.conf" and instead references trusted DNS servers matching the
       trusted_dns macro.

6. [ ] **Verify temp file cleanup preserved**: Confirm the function still uses a temp
       file with `crypto.randomUUID()` and cleans it up in a `finally` block.

7. [ ] **Verify error handling preserved**: Confirm the function still has a try/catch
       that logs a warning on failure without throwing.

Report QA_PASS or QA_FAIL with per-check results.
```

---

## Stage 1D: Tighten epair pf rules to restrict destinations

### Ticket Header

| Field | Value |
|-------|-------|
| **Ticket ID** | `nc-p1d` |
| **Title** | Tighten epair pf rules to restrict destinations |
| **Priority** | P0 |
| **Tags** | `nanoclaw`, `phase-1`, `security`, `pf`, `network` |
| **Files Affected** | `etc/pf-nanoclaw.conf` |
| **Dependencies** | Stage 1A (jail_net must be /16 before this change) |

### Context

The epair-level pf rules in `etc/pf-nanoclaw.conf` (lines 251-254) block all epair traffic by default and then allow specific ports:

```
block on epair all
pass quick on epair proto tcp to port 3001
pass quick on epair proto { tcp, udp } to port 53
pass quick on epair proto tcp to port 443
```

The problem is that these pass rules allow traffic to ANY destination on those ports. Specifically:
- Port 443: allows the jail to connect to ANY HTTPS server, not just the Anthropic API. While the `$ext_if` rules further restrict the destination to `<anthropic_api>`, the epair pass rule creates state entries that may interfere and represents a defense-in-depth violation.
- Port 53: allows DNS to ANY server, not just the trusted DNS servers. Again, the `$ext_if` rules restrict to `$trusted_dns`, but the epair rules should match.

The sysadmin report (Section 9, item 3) recommends restricting epair pass rules to match the same destination constraints as the `$ext_if` rules.

**Identified by**: FreeBSD Sysadmin Report, Section 9 item 3.

**Impact**: Defense-in-depth violation. If `$ext_if` rules are accidentally modified or removed, the epair rules would allow unrestricted outbound on ports 53 and 443.

### Developer Prompt

```
Read `refinement/03252026/SHARED_INSTRUCTIONS.md` first.

## Ticket: nc-p1d -- Tighten epair pf rules to restrict destinations

### Problem
The epair pass rules in `etc/pf-nanoclaw.conf` (lines 251-254) allow traffic to
ANY destination on ports 3001, 53, and 443. They should restrict destinations to
match the $ext_if rules:
- Port 3001: to $jail_net (credential proxy on gateway IPs) -- already correct
- Port 53: should restrict to $trusted_dns
- Port 443: should restrict to <anthropic_api>

### Changes Required

**File: `etc/pf-nanoclaw.conf`**, lines 251-254.

Change:
```
# Block all epair traffic by default, then allow specific services.
# Without this block, pf's default-pass policy allows all jail traffic on epair,
# creating state entries that bypass the re0 block rules above.
# Allowed ports here are further filtered by destination on $ext_if rules above.
block on epair all
pass quick on epair proto tcp to port 3001
pass quick on epair proto { tcp, udp } to port 53
pass quick on epair proto tcp to port 443
```

To:
```
# Block all epair traffic by default, then allow specific services.
# Without this block, pf's default-pass policy allows all jail traffic on epair,
# creating state entries that bypass the re0 block rules above.
# Destinations match the $ext_if rules above for defense-in-depth.
block on epair all
pass quick on epair proto tcp to port 3001
pass quick on epair proto { tcp, udp } to $trusted_dns port 53
pass quick on epair proto tcp to <anthropic_api> port 443
```

Changes:
1. Line 253: Add `to $trusted_dns` before `port 53`
2. Line 254: Add `to <anthropic_api>` before `port 443`
3. Update the comment on line 250 from "further filtered by destination on $ext_if
   rules above" to "Destinations match the $ext_if rules above for defense-in-depth"

### Acceptance Criteria
- [ ] DNS epair rule restricts destination to `$trusted_dns`
- [ ] HTTPS epair rule restricts destination to `<anthropic_api>`
- [ ] Credential proxy epair rule (port 3001) is unchanged
- [ ] `block on epair all` default-deny is unchanged
- [ ] Comment updated to reflect defense-in-depth rationale
- [ ] `sudo pfctl -nf etc/pf-nanoclaw.conf` parses without error (if on FreeBSD; skip if not)
- [ ] `npm test` passes (pf file is not tested by vitest, but run to confirm no regressions)

Report IMPLEMENTATION_COMPLETE when done.
```

### QA Prompt

```
Read `refinement/03252026/SHARED_INSTRUCTIONS.md` first.

## QA Validation: nc-p1d -- Tighten epair pf rules to restrict destinations

### Baseline Checks
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only `etc/pf-nanoclaw.conf`
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

### Ticket-Specific Checks

1. [ ] **Verify DNS epair rule has destination restriction**: Read `etc/pf-nanoclaw.conf`
       and find the epair DNS pass rule. Confirm it is:
       `pass quick on epair proto { tcp, udp } to $trusted_dns port 53`
       (must include `to $trusted_dns`).

2. [ ] **Verify HTTPS epair rule has destination restriction**: Find the epair HTTPS
       pass rule. Confirm it is:
       `pass quick on epair proto tcp to <anthropic_api> port 443`
       (must include `to <anthropic_api>`).

3. [ ] **Verify credential proxy epair rule unchanged**: Confirm the port 3001 rule
       is still: `pass quick on epair proto tcp to port 3001`
       (no destination restriction needed since $jail_net covers gateway IPs).

4. [ ] **Verify default-deny unchanged**: Confirm `block on epair all` is still
       present before the pass rules.

5. [ ] **Verify comment updated**: Confirm the comment block above the epair rules
       mentions "defense-in-depth" and no longer says "further filtered by
       destination on $ext_if rules above" (the old wording implied the epair rules
       were intentionally broad).

6. [ ] **Verify no other rules changed**: Run `git diff etc/pf-nanoclaw.conf` and
       confirm the ONLY changes are to the epair section (lines ~248-254) and
       its comment. No other pf rules should be modified.

7. [ ] **Verify pf syntax (FreeBSD only)**: Run `sudo pfctl -nf etc/pf-nanoclaw.conf`
       and confirm it parses without errors. If not on FreeBSD, report as SKIP.

8. [ ] **Verify consistency with ext_if rules**: Compare the epair destination
       restrictions with the ext_if rules:
       - ext_if DNS rule (line ~233): `to $trusted_dns port 53` -- must match epair
       - ext_if HTTPS rule (line ~239): `to <anthropic_api> port 443` -- must match epair

Report QA_PASS or QA_FAIL with per-check results.
```

---

## Phase 1 Integration QA

After all four stages (1A, 1B, 1C, 1D) have passed individual QA, run this integration QA on the merged result.

### Integration QA Prompt

```
Read `refinement/03252026/SHARED_INSTRUCTIONS.md` first.

## Phase 1 Integration QA -- All Critical Security Fixes

You are validating that all four Phase 1 stages work together correctly after
being merged into a single branch. Run ALL checks below.

### Baseline Checks
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes outside the expected set
[ ] No secrets or credentials in any diff

### Cross-Stage Consistency Checks

1. [ ] **pf jail_net CIDR is /16 (1A)**: Read `etc/pf-nanoclaw.conf` and confirm
       `jail_net = "10.99.0.0/16"`. Verify no "/24 pool" references remain.

2. [ ] **pf epair rules are tightened (1D)**: Confirm epair DNS rule restricts to
       `$trusted_dns` and epair HTTPS rule restricts to `<anthropic_api>`.

3. [ ] **pf rules parse clean (1A + 1D combined)**: On FreeBSD, run
       `sudo pfctl -nf etc/pf-nanoclaw.conf` and confirm no syntax errors.
       If not on FreeBSD, SKIP.

4. [ ] **Proxy binds to 0.0.0.0 (1B)**: Read `src/container-runtime.ts` and confirm
       `detectProxyBindHost()` returns `'0.0.0.0'` for jail/restricted mode.

5. [ ] **Runner uses per-jail hostIP (1B)**: Read `src/jail/runner.ts` and confirm
       `ANTHROPIC_BASE_URL` uses the epairInfo.hostIP from jail creation, not the
       static `jailConfig.jailHostIP`.

6. [ ] **JailCreationResult includes epairInfo (1B)**: Confirm `src/jail/types.ts`
       has `epairInfo?: EpairInfo` on `JailCreationResult`.

7. [ ] **DNS resolv.conf uses trusted servers (1C)**: Read `src/jail/network.ts`
       and confirm `setupJailResolv()` generates resolv.conf with `8.8.8.8` and
       `1.1.1.1` (not copying host resolv.conf).

8. [ ] **DNS servers are consistent across pf and code (1A + 1C + 1D)**: Verify
       that the `TRUSTED_DNS_SERVERS` array in `src/jail/network.ts` matches the
       `trusted_dns` macro in `etc/pf-nanoclaw.conf` AND the epair DNS destination.
       All three must reference the same servers: 8.8.8.8 and 1.1.1.1.

9. [ ] **Epair error message updated (1A)**: Confirm `src/jail/network.ts` error
       message on epair number validation says "/16 pool capacity".

10. [ ] **pf Note 3 comment updated (1C)**: Confirm `etc/pf-nanoclaw.conf` Note 3
        references trusted DNS servers, not host resolv.conf.

### End-to-End Scenario Validation (Mental Model)

Verify the following scenario would work with the combined changes:

11. [ ] **Multi-jail scenario**: With the /16 CIDR fix (1A), jail 5 at IP 10.99.5.2
        is covered by `$jail_net`. With the proxy fix (1B), the proxy on 0.0.0.0
        listens on 10.99.5.1:3001. The runner tells jail 5 to connect to
        `http://10.99.5.2's-gateway:3001`. With DNS fix (1C), jail 5's resolv.conf
        points to 8.8.8.8 and 1.1.1.1 which are allowed by pf. With epair
        tightening (1D), jail 5 can only reach the proxy (3001), trusted DNS (53),
        and Anthropic API (443). Confirm this scenario is logically consistent
        by tracing through the code and pf rules.

12. [ ] **No regression for jail 0**: Jail 0 at IP 10.99.0.2 should still work
        exactly as before. The proxy (now on 0.0.0.0) still listens on 10.99.0.1.
        The runner still provides the correct gateway. DNS still works.

Report QA_PASS or QA_FAIL with per-check results.
```
