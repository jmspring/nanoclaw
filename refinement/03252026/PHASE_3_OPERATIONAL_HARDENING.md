# Phase 3: Operational Hardening

**Priority**: P0-P1 -- reliability and privilege reduction
**Depends on**: Phase 1 (Critical Security Fixes)
**Parallel with**: Phase 2 (touches different files)
**Source reports**: `reports/sre_report.md`, `reports/freebsd_sysadmin_report.md`, `reports/freebsd_user_report.md`

---

## Stage 3A: Enable SQLite WAL Mode

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p3a` |
| **Title** | Enable SQLite WAL mode |
| **Priority** | P0 |
| **Tags** | `nanoclaw`, `phase-3`, `reliability`, `database` |
| **Files** | `src/db.ts` |
| **Dependencies** | None (within phase) |
| **Effort** | 2 lines |

### Context

The SRE report (`reports/sre_report.md`, section 3.1 "Database (SQLite)", lines 105-117) identifies that the SQLite database is opened with the default journal mode (DELETE). In a crash scenario (power loss, OOM kill, SIGKILL), this risks database corruption if a write was in progress and causes readers to block writers during concurrent access from the main loop, IPC watcher, and scheduler.

The database is initialized in `src/db.ts` at line 171:

```typescript
db = new Database(DB_PATH);
```

No journal mode or synchronous pragma is set after opening. The `better-sqlite3` library provides some protection via serialization, but WAL mode is the standard recommendation for single-writer, multi-reader SQLite deployments. WAL mode also improves concurrent read performance, which matters because the main event loop, IPC watcher, and task scheduler all read from the database simultaneously.

**Impact**: Without WAL mode, any unclean process termination during a write operation can corrupt the database, requiring restoration from the daily backup (which could be up to 24 hours stale). WAL mode makes crash recovery automatic and corruption-free.

### Developer Prompt

```
Read SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-p3a — Enable SQLite WAL mode
FILES: src/db.ts

CONTEXT:
The SQLite database at src/db.ts:171 is opened without WAL mode. The SRE report
identifies this as a P0 reliability issue: crash during a write operation risks
database corruption, and the default DELETE journal mode causes readers to block
writers during concurrent access.

CHANGES:

1. Open src/db.ts and read the initDatabase() function (lines 168-176).

2. After line 171 (`db = new Database(DB_PATH);`), add two pragma calls:
   ```typescript
   db.pragma('journal_mode = WAL');
   db.pragma('synchronous = NORMAL');
   ```

   The first enables WAL mode (write-ahead logging), which makes crash recovery
   automatic and allows concurrent readers. The second sets synchronous to NORMAL
   (from the default FULL), which is the recommended setting for WAL mode — it
   provides crash safety while reducing fsync overhead.

3. The _initTestDatabase() function (lines 178-181) uses ':memory:' databases.
   WAL mode is not meaningful for in-memory databases, so do NOT add pragmas
   there — they would be silently ignored but would add confusion.

4. Verify the final initDatabase() function looks like:
   ```typescript
   export function initDatabase(): void {
     fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

     db = new Database(DB_PATH);
     db.pragma('journal_mode = WAL');
     db.pragma('synchronous = NORMAL');
     createSchema(db);

     // Migrate from JSON files if they exist
     migrateJsonState();
   }
   ```

   Note: The pragma calls go BEFORE createSchema() so that the schema creation
   itself benefits from WAL mode.

5. Run: npm test
6. Run: npx tsc --noEmit
7. Run: npm run lint
8. Run: npm run format:check

IMPLEMENTATION_COMPLETE
```

### QA Prompt

```
Read SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-p3a — Enable SQLite WAL mode
FILES TO VALIDATE: src/db.ts

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only src/db.ts
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

TICKET-SPECIFIC CHECKS:

[ ] WAL pragma present: src/db.ts initDatabase() contains db.pragma('journal_mode = WAL')
    after the Database constructor call (line ~172) and BEFORE createSchema(db).

[ ] Synchronous pragma present: src/db.ts initDatabase() contains
    db.pragma('synchronous = NORMAL') after the WAL pragma and BEFORE createSchema(db).

[ ] Test database NOT modified: src/db.ts _initTestDatabase() does NOT contain any
    pragma calls (WAL is not meaningful for :memory: databases).

[ ] No other changes to db.ts: Only the two pragma lines were added. No surrounding
    code was refactored, reformatted, or modified.

[ ] Pragma syntax correct: The pragma calls use the better-sqlite3 API format
    db.pragma('key = value'), NOT db.exec('PRAGMA key = value').

Report each check as PASS or FAIL with details.
Final output: QA_PASS or QA_FAIL
```

---

## Stage 3B: Improve rc.d Service Script

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p3b` |
| **Title** | Improve rc.d script (daemon -r, pf dependency, default user, required_files) |
| **Priority** | P1 |
| **Tags** | `nanoclaw`, `phase-3`, `reliability`, `freebsd`, `service` |
| **Files** | `etc/rc.d/nanoclaw` |
| **Dependencies** | None (within phase) |
| **Effort** | ~20 lines |

### Context

Three independent reports identified problems with the rc.d service script at `etc/rc.d/nanoclaw`:

1. **SRE report** (`reports/sre_report.md`, section 5.1, lines 221-271):
   - No automatic restart on crash. `daemon(8)` is invoked with `-f` but NOT `-r`, so if NanoClaw crashes, it stays down until manually restarted.
   - Hardcoded user default (`jims`) at line 22 of the script.
   - No `required_modules` or `required_files` declarations.
   - Recommended fix: add `-r 5` to daemon args for auto-restart with 5-second delay.

2. **FreeBSD sysadmin report** (`reports/freebsd_sysadmin_report.md`, section 8, lines 327-411):
   - `REQUIRE` line specifies `LOGIN NETWORKING` but omits `pf`. Since the jail runtime in restricted mode depends on pf rules being loaded, pf must be a declared dependency.
   - No `required_dirs` or `required_files` declarations. A failed build (missing `dist/index.js`) produces confusing errors.
   - No `stop_postcmd` for orphan jail cleanup after unclean shutdown.
   - Recommended a complete rewrite with `required_dirs`, `required_files`, and a `nanoclaw_cleanup()` function.

3. **FreeBSD user report** (`reports/freebsd_user_report.md`, section 4, line 144):
   - Line 22 hardcodes `${nanoclaw_user:="jims"}` (the project creator's username). A new user installing the rc.d script manually gets a broken default.
   - Recommended changing to a generic default like `nanoclaw`.

The current script (`etc/rc.d/nanoclaw`) is 29 lines. The key problems are on lines 5, 22, 23, and 27:

```
Line 5:  # REQUIRE: LOGIN NETWORKING
Line 22: : ${nanoclaw_user:="jims"}
Line 23: : ${nanoclaw_dir:="/home/${nanoclaw_user}/code/nanoclaw/src"}
Line 27: command_args="-f -p ${pidfile} ..."
```

**Impact**: Without `-r`, any crash (OOM, unhandled rejection, segfault) leaves the service down with no automatic recovery. Without the pf dependency, the service can start before pf rules are loaded, leaving jails with unfiltered network access. The hardcoded username prevents clean installs.

### Developer Prompt

```
Read SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-p3b — Improve rc.d script
FILES: etc/rc.d/nanoclaw

CONTEXT:
The rc.d service script has four issues identified by the SRE, sysadmin, and
user reports: no auto-restart on crash, missing pf dependency, hardcoded personal
username as default, and no pre-start validation of required files/dirs.

CHANGES:

1. Open etc/rc.d/nanoclaw and read the entire file (29 lines).

2. Update the REQUIRE comment (line 5) to add pf:
   BEFORE: # REQUIRE: LOGIN NETWORKING
   AFTER:  # REQUIRE: LOGIN NETWORKING pf

3. Change the default user (line 22) from "jims" to "nanoclaw":
   BEFORE: : ${nanoclaw_user:="jims"}
   AFTER:  : ${nanoclaw_user:="nanoclaw"}

4. Update the comment on line 10 to reflect the new default:
   BEFORE: #   nanoclaw_user="jims"            # (default: jims)
   AFTER:  #   nanoclaw_user="nanoclaw"         # (default: nanoclaw)

5. Add required_dirs and required_files AFTER the nanoclaw_dir variable
   definition (after line 23) and BEFORE the pidfile declaration (line 25):
   ```sh
   required_dirs="${nanoclaw_dir}"
   required_files="${nanoclaw_dir}/dist/index.js ${nanoclaw_dir}/.env"
   ```

6. Update command_args (line 27) to add -r 5 for auto-restart after 5-second
   delay. Insert -r 5 after -f:
   BEFORE: command_args="-f -p ${pidfile} -u ${nanoclaw_user} -o /var/log/nanoclaw.log /usr/local/bin/node ${nanoclaw_dir}/dist/index.js"
   AFTER:  command_args="-f -r 5 -p ${pidfile} -u ${nanoclaw_user} -o /var/log/nanoclaw.log /usr/local/bin/node ${nanoclaw_dir}/dist/index.js"

7. The final file should look like:
   ```sh
   #!/bin/sh
   #
   # PROVIDE: nanoclaw
   # REQUIRE: LOGIN NETWORKING pf
   # KEYWORD: shutdown
   #
   # Add the following lines to /etc/rc.conf to enable nanoclaw:
   #
   #   nanoclaw_enable="YES"
   #   nanoclaw_user="nanoclaw"         # (default: nanoclaw)
   #   nanoclaw_dir="/path/to/src"     # (default: /home/${nanoclaw_user}/code/nanoclaw/src)
   #

   . /etc/rc.subr

   name="nanoclaw"
   rcvar="${name}_enable"

   load_rc_config $name

   : ${nanoclaw_enable:="NO"}
   : ${nanoclaw_user:="nanoclaw"}
   : ${nanoclaw_dir:="/home/${nanoclaw_user}/code/nanoclaw/src"}

   required_dirs="${nanoclaw_dir}"
   required_files="${nanoclaw_dir}/dist/index.js ${nanoclaw_dir}/.env"

   pidfile="/var/run/${name}.pid"
   command="/usr/sbin/daemon"
   command_args="-f -r 5 -p ${pidfile} -u ${nanoclaw_user} -o /var/log/nanoclaw.log /usr/local/bin/node ${nanoclaw_dir}/dist/index.js"

   run_rc_command "$@"
   ```

8. This is a shell script, not TypeScript. There are no TypeScript or lint checks
   to run on this file. However, verify the rest of the project is unaffected:
   - Run: npm test
   - Run: npx tsc --noEmit
   - Run: npm run lint

IMPLEMENTATION_COMPLETE
```

### QA Prompt

```
Read SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-p3b — Improve rc.d script
FILES TO VALIDATE: etc/rc.d/nanoclaw

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only etc/rc.d/nanoclaw
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

TICKET-SPECIFIC CHECKS:

[ ] pf dependency added: The REQUIRE comment line reads:
    # REQUIRE: LOGIN NETWORKING pf

[ ] Default user changed: The variable default reads:
    : ${nanoclaw_user:="nanoclaw"}
    (NOT "jims")

[ ] Comment updated: The usage comment reads:
    #   nanoclaw_user="nanoclaw"
    (NOT "jims")

[ ] required_dirs present: The script contains:
    required_dirs="${nanoclaw_dir}"
    This line must appear AFTER the nanoclaw_dir variable definition.

[ ] required_files present: The script contains:
    required_files="${nanoclaw_dir}/dist/index.js ${nanoclaw_dir}/.env"
    This line must appear AFTER the nanoclaw_dir variable definition.

[ ] Auto-restart enabled: The command_args variable includes -r 5:
    command_args="-f -r 5 -p ${pidfile} ..."
    (NOT just "-f -p ...")

[ ] Script structure preserved: The script still:
    - Starts with #!/bin/sh
    - Sources /etc/rc.subr
    - Calls load_rc_config
    - Ends with run_rc_command "$@"
    - Uses daemon(8) as the command

[ ] File is executable: Check file permissions include execute bit.

[ ] No extraneous changes: No lines were added or removed beyond the specified
    changes. The script structure and ordering are preserved.

Report each check as PASS or FAIL with details.
Final output: QA_PASS or QA_FAIL
```

---

## Stage 3C: Add Request Body Size Limit to Credential Proxy

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p3c` |
| **Title** | Add request body size limit to credential proxy |
| **Priority** | P1 |
| **Tags** | `nanoclaw`, `phase-3`, `security`, `proxy`, `reliability` |
| **Files** | `src/credential-proxy.ts` |
| **Dependencies** | None (within phase) |
| **Effort** | ~15 lines |

### Context

Both the SRE report and the FreeBSD sysadmin report independently identified that the credential proxy has no request body size limit:

1. **SRE report** (`reports/sre_report.md`, section 3.3, line 155):
   > "No request body size limit. A malicious jail could send arbitrarily large request bodies to the proxy, potentially exhausting memory. The proxy buffers the entire request body (`chunks.push(c)`) before forwarding."

2. **FreeBSD sysadmin report** (`reports/freebsd_sysadmin_report.md`, section 7, line 321):
   > "No request body size limit: The proxy buffers the entire request body in memory (`chunks.push(c)`). A malicious jail could send an extremely large request body to exhaust host memory. Should add a body size limit (e.g., 10MB)."

The vulnerable code is in `src/credential-proxy.ts` inside `startCredentialProxy()`. At lines 152-155, the request body is accumulated without any size check:

```typescript
const chunks: Buffer[] = [];
req.on('data', (c) => chunks.push(c));
req.on('end', () => {
  const body = Buffer.concat(chunks);
```

A compromised or malicious jail could send an arbitrarily large POST body (e.g., multiple gigabytes) to the credential proxy, which would buffer the entire body in the Node.js process heap before forwarding. This could cause an out-of-memory condition that crashes the entire NanoClaw process, affecting all groups and channels.

The Anthropic API's `/v1/messages` endpoint accepts request bodies that can be reasonably large (long conversations with many messages), but 10MB is a generous upper bound. Claude's maximum context window produces request bodies well under 10MB when serialized as JSON.

**Impact**: A single compromised jail can crash the entire NanoClaw process by sending an oversized request body to the credential proxy.

### Developer Prompt

```
Read SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-p3c — Add request body size limit to credential proxy
FILES: src/credential-proxy.ts

CONTEXT:
The credential proxy at src/credential-proxy.ts buffers entire request bodies in
memory (lines 152-155) without any size limit. Both the SRE and sysadmin reports
identify this as a P1 reliability/security issue: a malicious jail can exhaust
host memory by sending an oversized request body.

CHANGES:

1. Open src/credential-proxy.ts and read the full file (230 lines).

2. Add a constant for the maximum body size AFTER the existing rate limit
   constants (after line 63, which defines RATE_LIMIT_WINDOW_MS):
   ```typescript
   const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB
   ```

3. Modify the request body accumulation logic inside the createServer callback.
   The current code at lines 152-155 is:
   ```typescript
   const chunks: Buffer[] = [];
   req.on('data', (c) => chunks.push(c));
   req.on('end', () => {
     const body = Buffer.concat(chunks);
   ```

   Replace lines 152-153 with a size-tracking accumulation that aborts if the
   limit is exceeded:
   ```typescript
   const chunks: Buffer[] = [];
   let bodySize = 0;
   let aborted = false;
   req.on('data', (c: Buffer) => {
     bodySize += c.length;
     if (bodySize > MAX_BODY_BYTES) {
       if (!aborted) {
         aborted = true;
         logger.warn(
           { remoteAddr, url: req.url, bodySize },
           'Credential proxy: request body too large',
         );
         res.writeHead(413);
         res.end('Payload Too Large');
         req.destroy();
       }
       return;
     }
     chunks.push(c);
   });
   req.on('end', () => {
     if (aborted) return;
     const body = Buffer.concat(chunks);
   ```

   The key changes:
   - Track bodySize incrementally as chunks arrive.
   - If bodySize exceeds MAX_BODY_BYTES, respond with 413 (Payload Too Large),
     log a warning, destroy the request stream, and set an aborted flag.
   - On 'end', check the aborted flag and return early if set.
   - The rest of the 'end' handler (header manipulation, upstream forwarding)
     remains unchanged.

4. Make sure the closing braces and the rest of the request handler are not
   disturbed. The 'end' callback still closes with the same structure as before.

5. Run: npm test
6. Run: npx tsc --noEmit
7. Run: npm run lint
8. Run: npm run format:check

IMPLEMENTATION_COMPLETE
```

### QA Prompt

```
Read SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-p3c — Add request body size limit to credential proxy
FILES TO VALIDATE: src/credential-proxy.ts

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only src/credential-proxy.ts
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

TICKET-SPECIFIC CHECKS:

[ ] MAX_BODY_BYTES constant defined: A constant named MAX_BODY_BYTES is defined
    with value 10 * 1024 * 1024 (10 MB). It should be defined at module scope,
    near the existing rate limit constants (RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS).

[ ] Body size tracking: Inside the createServer callback's request handler, the
    'data' event handler tracks cumulative body size via a counter variable
    (bodySize or equivalent) that increments by c.length on each chunk.

[ ] Size limit enforced: When bodySize exceeds MAX_BODY_BYTES, the handler:
    a. Responds with HTTP 413 (Payload Too Large)
    b. Logs a warning via logger.warn with remoteAddr and url context
    c. Destroys the request stream (req.destroy())
    d. Prevents further chunk accumulation
    e. Does NOT forward the request to upstream

[ ] Aborted flag prevents double-response: An aborted/rejected flag ensures that:
    a. The 413 response is sent only once (not on every subsequent chunk)
    b. The 'end' handler returns early without forwarding to upstream

[ ] Existing functionality preserved: The following must still work:
    a. Source IP validation (isAllowedSource)
    b. Per-jail token validation
    c. Path validation (/v1/, /api/oauth/)
    d. Rate limiting
    e. Header stripping (connection, keep-alive, transfer-encoding, x-jail-token)
    f. Credential injection (api-key and oauth modes)
    g. Upstream forwarding and error handling
    h. Response piping from upstream to client

[ ] No other behavioral changes: The only new behavior is the body size limit.
    All existing validation, forwarding, and error handling logic is unchanged.

[ ] HTTP status code correct: 413 is the correct status code for "Payload Too Large"
    (previously "Request Entity Too Large").

Report each check as PASS or FAIL with details.
Final output: QA_PASS or QA_FAIL
```

---

## Stage 3D: Tighten Sudoers to Restrict Commands to NanoClaw Paths

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p3d` |
| **Title** | Tighten sudoers to restrict commands to nanoclaw paths |
| **Priority** | P0 |
| **Tags** | `nanoclaw`, `phase-3`, `security`, `sudoers`, `privilege-escalation` |
| **Files** | `scripts/setup-freebsd.sh` (lines 267-302) |
| **Dependencies** | None (within phase) |
| **Effort** | ~30 lines |

### Context

The FreeBSD sysadmin report (`reports/freebsd_sysadmin_report.md`, section 6 "Privilege Escalation Vectors", lines 207-285) calls the sudoers configuration **"the single biggest security problem in this deployment"**. The current sudoers file generated by `scripts/setup-freebsd.sh` at lines 267-302 grants unrestricted NOPASSWD access for several dangerous commands:

```
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /usr/sbin/jexec *              # can exec in ANY jail
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /sbin/mount_nullfs              # can mount ANYWHERE
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /sbin/umount                    # can unmount ANYTHING
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /sbin/ifconfig                  # can modify ANY interface
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /sbin/route                     # can modify routing table
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /bin/mkdir                      # can create dirs ANYWHERE
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /bin/chmod                      # can chmod ANYTHING
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /usr/sbin/chown                 # can chown ANYTHING
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /bin/cp                         # can copy ANYTHING
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /usr/bin/tee                    # can write ANYWHERE
$NANOCLAW_USER ALL=(ALL) NOPASSWD: /usr/bin/rctl                   # can modify ANY rctl rule
```

The sysadmin report specifically warns (line 244): "A compromised nanoclaw process could `sudo chown nanoclaw /etc/shadow` or `sudo cp /etc/master.passwd /tmp/stolen`."

The FreeBSD user report (`reports/freebsd_user_report.md`, section 9, line 367) also notes: "The `/bin/sh` sudoers entry should be eliminated" and "the `setup-freebsd.sh` version... still grants broad permissions for `/bin/mkdir`, `/bin/chmod`, `/usr/sbin/chown`, `/bin/cp`, and `/usr/bin/tee` without path restrictions."

**Actual code usage analysis** (from `src/jail/*.ts` grep results):

- `jexec` is always called with `nanoclaw_*` jail names (lifecycle.ts:205,415; network.ts:165,173; exec.ts)
- `mount_nullfs` is always called with `-o ro` or `-o rw` mounting into jail paths (mounts.ts:228)
- `umount` and `umount -f` target paths inside jail roots (lifecycle.ts:532,541; mounts.ts:255,259)
- `ifconfig` is used for `epair create` and `epair* ...` operations (network.ts:124,145,199; cleanup.ts:148)
- `route` is only called via `jexec` inside jails, NOT directly on the host (network.ts:173-179)
- `mkdir -p` targets `${jailPath}/home/node/.claude` (lifecycle.ts:292)
- `chmod` targets `${jailPath}/tmp` (lifecycle.ts:308)
- `chown -R` targets `${jailPath}/home/node` (lifecycle.ts:307)
- `cp` copies temp files into jail paths (lifecycle.ts:300; network.ts:230)
- `tee` is NOT used anywhere in the jail code -- it can be removed
- `rctl -a` and `rctl -r` are always called with `jail:nanoclaw_*` (lifecycle.ts:135-156)

The sudoers file uses variables from the setup script. The key variable is `$NANOCLAW_USER` (the username) and the jail paths are derived from ZFS datasets. The jails dataset is at `zroot/nanoclaw/jails` and jails live under the `jailsPath` directory (which defaults to `${NANOCLAW_ROOT}/jails` but is configured via `NANOCLAW_JAILS_PATH`).

Since the sudoers file must work with configurable paths, we use the `NANOCLAW_DIR` variable (which the setup script has available as the project root) to construct path restrictions. The jails directory is always `${NANOCLAW_DIR}/jails/*` relative to the project root.

**Impact**: The unrestricted sudoers entries give the nanoclaw user root-equivalent filesystem access. If the Node.js process is compromised (e.g., via a supply-chain attack on an npm dependency), the attacker can read/write any file on the system.

### Developer Prompt

```
Read SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-p3d — Tighten sudoers to restrict commands to nanoclaw paths
FILES: scripts/setup-freebsd.sh (lines 267-302)

CONTEXT:
The sudoers file generated by setup-freebsd.sh grants unrestricted NOPASSWD access
for mkdir, chmod, chown, cp, tee, mount_nullfs, umount, ifconfig, route, jexec,
and rctl. The sysadmin report calls this "the single biggest security problem."
All these commands should be restricted to nanoclaw-specific paths and arguments.

The setup script has these variables available at the point where the sudoers file
is generated (line 267):
  - $NANOCLAW_USER — the system username
  - $USER_HOME — the user's home directory (derived at line 257)
  - $NANOCLAW_DIR — available as the working directory variable (set earlier in the script)
  - $ZFS_POOL — the ZFS pool name (e.g., "zroot")

The jails are always created under the ZFS dataset "zroot/nanoclaw/jails/" and
the jail filesystem path is "${NANOCLAW_DIR}/jails/".

IMPORTANT CONSTRAINT: sudoers argument matching is positional and exact. A rule
like `NOPASSWD: /bin/chmod * /path/*` means "chmod, then exactly one arg, then a
path starting with /path/". Wildcards in sudoers match within a single argument
only. Be careful with multi-argument commands.

IMPORTANT: The `route` command is NOT called directly by the host process — it is
only called via `jexec nanoclaw_* route ...` inside jails. So the sudoers `route`
entry can be removed entirely.

IMPORTANT: The `tee` command is NOT used anywhere in the jail runtime code. It
can be removed.

CHANGES:

1. Open scripts/setup-freebsd.sh and read lines 250-310.

2. Replace the sudoers file content (the heredoc from line 267 to line 302)
   with the following tightened version. The NANOCLAW_DIR variable needs to
   be set before the heredoc. Look for where NANOCLAW_DIR is defined in the
   script — it should already be available. If it is not set by this point,
   derive it from USER_HOME:

   Add before the heredoc (after line 266, before the cat command), only if
   NANOCLAW_DIR is not already set:
   ```sh
   : ${NANOCLAW_DIR:="${USER_HOME}/code/nanoclaw/src"}
   ```

3. Replace the heredoc content (lines 268-301) with:

   ```
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
   ```

   Key changes from the original:
   a. jexec restricted to nanoclaw_* jails (was unrestricted)
   b. jail -f added for the conf-file form used by lifecycle.ts:343
   c. mount_nullfs restricted to -o ro/rw into jail paths (was unrestricted)
   d. umount restricted to jail paths (was unrestricted)
   e. ifconfig restricted to epair* interfaces (was unrestricted)
   f. route REMOVED (only called inside jails via jexec, not on host)
   g. mkdir restricted to jail paths (was unrestricted)
   h. chmod restricted to jail paths (was unrestricted)
   i. chown restricted to jail paths (was unrestricted)
   j. cp restricted to jail paths (was unrestricted)
   k. tee REMOVED (not used in jail code)
   l. rctl restricted to jail:nanoclaw_* (was unrestricted)
   m. zfs destroy split into -f -r and -r variants to match actual usage
   n. zfs set restricted to quota=* and setuid=off on jail datasets

4. Verify that the visudo validation (line 307) still passes after the changes.
   The validation line is:
   ```sh
   if visudo -cf "$SUDOERS_FILE" >/dev/null 2>&1; then
   ```
   This is NOT something you can run in the worktree (requires sudo), but verify
   the sudoers syntax is correct by inspection:
   - Each line follows: user hostlist=(runaslist) NOPASSWD: command [args]
   - Colons in rctl rules are escaped with backslash (\:)
   - Wildcards (*) are valid in sudoers for argument matching
   - No trailing whitespace after backslash continuations

5. This file is a shell script, not TypeScript, but verify the project is
   unaffected:
   - Run: npm test
   - Run: npx tsc --noEmit
   - Run: npm run lint

IMPLEMENTATION_COMPLETE
```

### QA Prompt

```
Read SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-p3d — Tighten sudoers to restrict commands to nanoclaw paths
FILES TO VALIDATE: scripts/setup-freebsd.sh (lines ~267-310)

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only scripts/setup-freebsd.sh
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

TICKET-SPECIFIC CHECKS:

[ ] jexec restricted: The sudoers jexec entry reads:
    NOPASSWD: /usr/sbin/jexec nanoclaw_*
    (NOT /usr/sbin/jexec *)

[ ] mount_nullfs restricted: The sudoers mount_nullfs entries restrict
    the destination to ${NANOCLAW_DIR}/jails/* and include -o ro and -o rw
    variants. There should be NO unrestricted mount_nullfs entry.

[ ] umount restricted: The sudoers umount entries restrict paths to
    ${NANOCLAW_DIR}/jails/* with both regular and -f (force) variants.
    There should be NO unrestricted umount entry.

[ ] ifconfig restricted: The sudoers ifconfig entries are restricted to
    "epair create" and "epair*". There should be NO unrestricted ifconfig entry.

[ ] route REMOVED: There should be NO sudoers entry for /sbin/route.
    (Route is only called inside jails via jexec, not on the host.)

[ ] tee REMOVED: There should be NO sudoers entry for /usr/bin/tee.
    (Tee is not used in the jail runtime code.)

[ ] mkdir restricted: The sudoers mkdir entry restricts paths to
    ${NANOCLAW_DIR}/jails/*. There should be NO unrestricted mkdir entry.

[ ] chmod restricted: The sudoers chmod entry restricts paths to
    ${NANOCLAW_DIR}/jails/*. There should be NO unrestricted chmod entry.

[ ] chown restricted: The sudoers chown entry restricts paths to
    ${NANOCLAW_DIR}/jails/*. There should be NO unrestricted chown entry.

[ ] cp restricted: The sudoers cp entry restricts the destination to
    ${NANOCLAW_DIR}/jails/*. There should be NO unrestricted cp entry.

[ ] rctl restricted: The sudoers rctl entries are restricted to
    jail:nanoclaw_* (with escaped colon \:). Both -a and -r variants present.
    There should be NO unrestricted rctl entry.

[ ] zfs entries use variable: The zfs clone/destroy/set entries use
    ${ZFS_POOL}/nanoclaw/jails/* (NOT hardcoded zroot).

[ ] jail -f entry present: A sudoers entry exists for:
    /usr/sbin/jail -f ${NANOCLAW_DIR}/jails/* -c nanoclaw_*
    This matches the actual invocation in lifecycle.ts:343.

[ ] jls preserved: The jls entry is still present (read-only, acceptable
    as unrestricted per sysadmin report).

[ ] pfctl preserved: The pfctl -si entry is still present (read-only).

[ ] NANOCLAW_DIR variable available: The NANOCLAW_DIR variable is set or
    defaulted before the heredoc. Verify it will expand correctly in the
    generated sudoers file.

[ ] Sudoers syntax valid: Inspect each line for correct sudoers syntax:
    - Proper user/host/runas format
    - Escaped colons (\:) in rctl rules
    - No syntax errors that would cause visudo to reject the file

[ ] No remaining unrestricted entries: Grep the heredoc for lines that
    contain NOPASSWD: /path/to/cmd without any argument restrictions
    (except jls and pfctl which are read-only and acceptable).

[ ] Comment header present: The sudoers file header includes a comment noting
    that commands are path-restricted for security.

Report each check as PASS or FAIL with details.
Final output: QA_PASS or QA_FAIL
```

---

## Stage 3E: Install devfs.rules in setup-freebsd.sh

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p3e` |
| **Title** | Install devfs.rules in setup-freebsd.sh |
| **Priority** | P1 |
| **Tags** | `nanoclaw`, `phase-3`, `security`, `freebsd`, `setup` |
| **Files** | `scripts/setup-freebsd.sh` |
| **Dependencies** | None (within phase) |
| **Effort** | ~15 lines |

### Context

The Synthesis Report (Section 4, UX pain point 5) and Appendix B identify that `etc/devfs.rules` is not installed by `setup-freebsd.sh`. This security-critical file restricts device exposure inside jails (hiding `/dev/mem`, `/dev/kmem`, `/dev/io`, `/dev/bpf*`, etc.) and is referenced by `src/jail/lifecycle.ts:336` which sets `devfs_ruleset = 10` in jail.conf.

The `etc/devfs.rules` file defines ruleset `[nanoclaw_jail=10]` which starts from the standard jail devfs rules and explicitly unhides only safe devices (random, urandom, null, zero, stdin, stdout, stderr, fd/*, pts/*).

The setup script (`scripts/setup-freebsd.sh`) currently has 10 sections. The function execution order is:
1. `preflight_checks` (Section 1)
2. `install_packages` (Section 2)
3. `setup_kernel_modules` (Section 3)
4. `setup_user` (Section 4)
5. `setup_zfs_datasets` (Section 5)
6. `setup_jail_template` (Section 6)
7. `setup_pf` (Section 7)
8. `clone_nanoclaw` (Section 8)
9. `setup_rcd_service` (Section 9)
10. `print_summary` (Section 10)

The devfs.rules installation should be added as a new function called after `setup_pf` (Section 7) and before `setup_rcd_service` (Section 9). The `$NANOCLAW_SRC` variable (available in the script) points to the source directory containing `etc/devfs.rules`.

**Impact**: Without devfs.rules installed on the host, jails either use the default (overly permissive) devfs ruleset or fail if the code expects ruleset 10 to exist. The sysadmin and user reviewers both flagged this as a setup gap.

### Developer Prompt

```
Read refinement/03252026/SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-p3e — Install devfs.rules in setup-freebsd.sh
FILES: scripts/setup-freebsd.sh

CONTEXT:
The setup script does not install etc/devfs.rules to /etc/devfs.rules. The jail
runtime at src/jail/lifecycle.ts:336 sets devfs_ruleset=10, which references the
ruleset defined in etc/devfs.rules. Without this file on the host, jails use the
default devfs ruleset (too permissive) or fail.

CHANGES:

1. Read scripts/setup-freebsd.sh and find the setup_pf() function (Section 7,
   around line 540) and the setup_rcd_service() function (Section 9, around line 788).

2. Add a new function install_devfs_rules() between setup_pf() and
   clone_nanoclaw(). The function should:

   a. Print a section header (matching existing style):
      No separate print_header needed — this is a small addition.
      Use log_info/log_success/log_skip style like other functions.

   b. Check if etc/devfs.rules exists in the source:
      DEVFS_SRC="$NANOCLAW_SRC/etc/devfs.rules"
      if [ ! -f "$DEVFS_SRC" ]; then
          log_info "devfs.rules not found in source — skipping"
          return 0
      fi

   c. Copy to /etc/devfs.rules if not already identical:
      DEVFS_DEST="/etc/devfs.rules"
      if [ -f "$DEVFS_DEST" ] && cmp -s "$DEVFS_SRC" "$DEVFS_DEST"; then
          log_skip "devfs.rules already installed and up to date"
      else
          cp "$DEVFS_SRC" "$DEVFS_DEST"
          log_success "devfs.rules installed at $DEVFS_DEST"
      fi

   d. Reload devfs rules if devfs service is running:
      if service devfs status >/dev/null 2>&1; then
          service devfs restart
          log_success "devfs rules reloaded"
      fi

3. Add a call to install_devfs_rules in the main() function, after setup_pf
   and before clone_nanoclaw (or before setup_rcd_service — between the pf and
   rc.d sections):

   Find this section in main():
       setup_pf
       clone_nanoclaw
       setup_rcd_service

   Change to:
       setup_pf
       install_devfs_rules
       clone_nanoclaw
       setup_rcd_service

4. This is a shell script change. Verify the project is unaffected:
   - Run: npm test
   - Run: npx tsc --noEmit
   - Run: npm run lint
   - Run: npm run format:check

IMPLEMENTATION_COMPLETE
```

### QA Prompt

```
Read refinement/03252026/SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-p3e — Install devfs.rules in setup-freebsd.sh
FILES TO VALIDATE: scripts/setup-freebsd.sh

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only scripts/setup-freebsd.sh
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

TICKET-SPECIFIC CHECKS:

[ ] install_devfs_rules function exists: The function is defined in
    scripts/setup-freebsd.sh with the name install_devfs_rules.

[ ] Source path correct: The function references $NANOCLAW_SRC/etc/devfs.rules
    as the source file.

[ ] Destination correct: The function copies to /etc/devfs.rules.

[ ] Idempotent: The function checks if the destination already exists and is
    identical (via cmp -s or equivalent) before copying. If identical, it skips.

[ ] Execution order correct: In main(), install_devfs_rules is called AFTER
    setup_pf and BEFORE setup_rcd_service (between the pf and rc.d sections).

[ ] Ruleset number matches lifecycle.ts: The devfs.rules file at etc/devfs.rules
    defines ruleset number 10 (line: [nanoclaw_jail=10]), which matches
    src/jail/lifecycle.ts:336 (devfs_ruleset = 10).

[ ] devfs reload present: The function attempts to reload devfs rules after
    installation (service devfs restart or equivalent).

[ ] Graceful fallback: If etc/devfs.rules does not exist in the source tree,
    the function logs a message and returns without error.

Report each check as PASS or FAIL with details.
Final output: QA_PASS or QA_FAIL
```

---

## Stage 3F: Parameterize Hardcoded Path in pf Config

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p3f` |
| **Title** | Parameterize hardcoded path in pf config |
| **Priority** | P2 |
| **Tags** | `nanoclaw`, `phase-3`, `ux`, `freebsd`, `pf` |
| **Files** | `etc/pf-nanoclaw.conf` |
| **Dependencies** | None (within phase) |
| **Effort** | ~5 lines |

### Context

The Synthesis Report (Section 4, UX pain point 4) and the FreeBSD User Report (Section 4) identified that `etc/pf-nanoclaw.conf` contains hardcoded references to `/home/jims/code/nanoclaw/src/` in the MANUAL SETUP comment section (lines 55 and 58):

```
#      pf_rules="/home/jims/code/nanoclaw/src/etc/pf-nanoclaw.conf"
#   5. Load the ruleset:
#      sudo pfctl -f /home/jims/code/nanoclaw/src/etc/pf-nanoclaw.conf
```

These appear in comment blocks (not active rules), so they don't affect runtime behavior. However, they confuse users who read the manual setup instructions and see a personal path instead of a generic placeholder.

The `setup-freebsd.sh` script already performs placeholder substitution for `NANOCLAW_EXT_IF_PLACEHOLDER` (line 574-575), replacing it with the detected interface name. The path in the comments should use a similar pattern or a generic placeholder.

**Impact**: Cosmetic/UX issue. Users reading the manual setup guide see a hardcoded personal path and may incorrectly assume they need to create the same directory structure.

### Developer Prompt

```
Read refinement/03252026/SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-p3f — Parameterize hardcoded path in pf config
FILES: etc/pf-nanoclaw.conf

CONTEXT:
The pf config file has hardcoded /home/jims/code/nanoclaw/src/ paths in the
MANUAL SETUP comment section (lines 55 and 58). These should use a generic
placeholder path instead.

CHANGES:

1. Read etc/pf-nanoclaw.conf and find all instances of /home/jims/.

2. Replace the two instances in the MANUAL SETUP section:

   Line 55:
   BEFORE: #      pf_rules="/home/jims/code/nanoclaw/src/etc/pf-nanoclaw.conf"
   AFTER:  #      pf_rules="/path/to/nanoclaw/src/etc/pf-nanoclaw.conf"

   Line 58:
   BEFORE: #      sudo pfctl -f /home/jims/code/nanoclaw/src/etc/pf-nanoclaw.conf
   AFTER:  #      sudo pfctl -f /path/to/nanoclaw/src/etc/pf-nanoclaw.conf

3. Add a comment after the manual setup section noting that setup-freebsd.sh
   handles this automatically:
   #      Note: setup-freebsd.sh copies this file to /etc/pf-nanoclaw.conf
   #      and substitutes the correct interface automatically.

4. Verify no other instances of /home/jims/ exist in the file.
   Search: grep '/home/jims' etc/pf-nanoclaw.conf (should return 0 after changes)

5. Verify pf syntax is unaffected (these are all in comments):
   The file should still parse without errors. Since the changes are only in
   comments, pfctl -nf should still succeed.

6. Run: npm test
7. Run: npx tsc --noEmit
8. Run: npm run lint
9. Run: npm run format:check

IMPLEMENTATION_COMPLETE
```

### QA Prompt

```
Read refinement/03252026/SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-p3f — Parameterize hardcoded path in pf config
FILES TO VALIDATE: etc/pf-nanoclaw.conf

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only etc/pf-nanoclaw.conf
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

TICKET-SPECIFIC CHECKS:

[ ] No hardcoded personal paths: grep -c '/home/jims' etc/pf-nanoclaw.conf
    returns 0. No instances of /home/jims/ remain anywhere in the file.

[ ] Generic placeholder used: The manual setup section uses /path/to/nanoclaw/src/
    or equivalent generic placeholder instead of a personal path.

[ ] Comment notes auto-setup: A comment mentions that setup-freebsd.sh handles
    the configuration automatically.

[ ] Active rules unchanged: No active (non-comment) pf rules were modified.
    The ext_if, jail_net, NAT, and filter rules are identical to before.

[ ] pf syntax still valid (SKIP if sudo unavailable):
    sudo pfctl -nf etc/pf-nanoclaw.conf exits 0.
    Since changes are only in comments, this should always pass.

Report each check as PASS or FAIL with details.
Final output: QA_PASS or QA_FAIL
```

---

## Phase 3 Integration QA

After all six stage tickets (3A, 3B, 3C, 3D, 3E, 3F) have individually passed QA and been committed to their respective branches, run the following integration QA on the merged result.

### Integration QA Prompt

```
Read SHARED_INSTRUCTIONS.md before starting.

PHASE 3 INTEGRATION QA — Operational Hardening
MERGED BRANCHES: nc-p3a, nc-p3b, nc-p3c, nc-p3d, nc-p3e, nc-p3f
FILES MODIFIED: src/db.ts, etc/rc.d/nanoclaw, src/credential-proxy.ts, scripts/setup-freebsd.sh, etc/pf-nanoclaw.conf

This is a read-only validation of the merged Phase 3 changes. Never modify files.

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] Only expected files changed: git diff --stat against main shows exactly
    src/db.ts, etc/rc.d/nanoclaw, src/credential-proxy.ts, scripts/setup-freebsd.sh, etc/pf-nanoclaw.conf
[ ] No secrets or credentials in diff

CROSS-TICKET INTEGRATION CHECKS:

[ ] No conflicting changes: The four tickets modify four different files with
    no overlapping lines. Verify there are no merge artifacts or conflict markers
    in any modified file.

[ ] Database initialization order correct (3A): In src/db.ts, verify the order is:
    1. new Database(DB_PATH)
    2. pragma journal_mode = WAL
    3. pragma synchronous = NORMAL
    4. createSchema(db)
    5. migrateJsonState()

[ ] rc.d script coherent (3B): In etc/rc.d/nanoclaw, verify:
    - REQUIRE line includes pf
    - Default user is "nanoclaw"
    - required_dirs and required_files are present and reference ${nanoclaw_dir}
    - daemon -r 5 is in command_args
    - Script still sources rc.subr and ends with run_rc_command

[ ] Credential proxy defense layers intact (3C): In src/credential-proxy.ts, verify
    the request validation order inside createServer is:
    1. Source IP check (isAllowedSource)
    2. Per-jail token check (validTokens)
    3. Path validation (/v1/, /api/oauth/)
    4. Rate limit check (checkRateLimit)
    5. Body size limit (MAX_BODY_BYTES) — NEW
    6. Header manipulation and upstream forwarding
    All five layers must be present and in correct order.

[ ] Sudoers restrictions match code usage (3D): Cross-reference the new sudoers
    entries in scripts/setup-freebsd.sh against actual sudo calls in jail modules:
    - lifecycle.ts:292 calls mkdir -p ${jailPath}/... → matches /bin/mkdir -p ${NANOCLAW_DIR}/jails/*
    - lifecycle.ts:307 calls chown -R 1000:1000 ${jailPath}/... → matches /usr/sbin/chown * ${NANOCLAW_DIR}/jails/*
    - lifecycle.ts:308 calls chmod 1777 ${jailPath}/tmp → matches /bin/chmod * ${NANOCLAW_DIR}/jails/*
    - lifecycle.ts:300 calls cp <tmpfile> ${jailPath}/... → matches /bin/cp * ${NANOCLAW_DIR}/jails/*
    - lifecycle.ts:343 calls jail -f <confPath> -c <jailName> → matches jail -f entry
    - mounts.ts:228 calls mount_nullfs -o <opts> <host> <target> → matches mount_nullfs entries
    - network.ts:124 calls ifconfig epair create → matches ifconfig epair create
    - network.ts:145 calls ifconfig epairNa ... → matches ifconfig epair*
    Verify no jail module sudo call would be blocked by the new restrictions.

[ ] devfs.rules installation order correct (3E): In scripts/setup-freebsd.sh,
    verify install_devfs_rules is called AFTER setup_pf and BEFORE
    setup_rcd_service. The devfs.rules file must reference ruleset number 10,
    matching src/jail/lifecycle.ts:336 (devfs_ruleset = 10).

[ ] No hardcoded paths in pf config (3F): In etc/pf-nanoclaw.conf, verify:
    - grep -c '/home/jims' etc/pf-nanoclaw.conf returns 0
    - Manual setup section uses generic /path/to/ placeholder
    - All active (non-comment) pf rules are unchanged from Phase 1 fixes

[ ] No regression in existing tests: All existing test files pass without
    modification. The four changes should not require any test updates because:
    - WAL pragma does not affect in-memory test databases
    - rc.d script has no tests
    - Credential proxy tests mock HTTP (body size limit is not unit tested in
      existing tests — this is acceptable for a P1 hardening ticket)
    - Sudoers is generated by a shell script that has no TypeScript tests

[ ] Build succeeds end-to-end: npm run build completes without errors.

Report each check as PASS or FAIL with details.
Final output: QA_PASS or QA_FAIL followed by a summary of all Phase 3 changes.
```
