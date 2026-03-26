# Phase 11: Operational Infrastructure

**Priority**: P3
**Depends on**: Phase 6 (operational maturity), Phase 8 (FreeBSD features)
**Source reports**: `reports/sre_report.md`, `reports/freebsd_sysadmin_report.md`

**All subagents MUST read `refinement/03252026/SHARED_INSTRUCTIONS.md` before starting work.**

---

## Stage 11A: Add Off-Host Backup via zfs send

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p11a` |
| **Title** | Add off-host backup via zfs send |
| **Priority** | P3 |
| **Tags** | `nanoclaw`, `phase-11`, `backup`, `zfs` |
| **Files** | `scripts/backup-offhost.sh` (new), `docs/BACKUP.md` (new) |
| **Dependencies** | None (within phase) |
| **Effort** | ~80 lines / Medium |

### Context

The SRE report (`reports/sre_report.md`, section 7.2, line 318) identifies that all backups reside on the same ZFS pool. The `backupDatabase()` function runs daily but writes to the same pool. Session state, group files, and the ZFS template snapshot are also pool-local. A pool failure (unlikely but possible) loses everything.

Section 7.3 (line 336) recommends `zfs send` to a remote host or file as the mitigation:

```
0 2 * * * nanoclaw zfs send -i zroot/nanoclaw@prev zroot/nanoclaw@latest | ssh backup-host zfs recv tank/nanoclaw-backup
```

No off-host backup script or documentation currently exists in the project.

**Impact**: Data survives pool failure. Without off-host backup, a single hardware event destroys all state — database, group workspaces, session data, and the jail template.

### Developer Prompt

```
Read SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-p11a — Add off-host backup via zfs send
FILES: scripts/backup-offhost.sh (new), docs/BACKUP.md (new)

CONTEXT:
The SRE report section 7.2 identifies no off-host backup as a gap. All backups
are on the same ZFS pool. This ticket adds a backup script using zfs send and
a documentation file covering the full backup strategy.

CHANGES:

1. Create scripts/backup-offhost.sh with the following requirements:

   - Begin with #!/bin/sh and set -euo pipefail
   - Accept configuration via environment variables:
     - BACKUP_TARGET (required): file path or ssh://host/dataset
     - BACKUP_DATASET (default: zroot/nanoclaw)
     - BACKUP_SNAP_PREFIX (default: backup)
     - BACKUP_LOG (default: /var/log/nanoclaw-backup.log)
   - Validate that BACKUP_TARGET is set; exit 1 with usage message if missing
   - Create a new snapshot: zfs snapshot ${BACKUP_DATASET}@${BACKUP_SNAP_PREFIX}-$(date +%Y%m%d-%H%M%S)
   - Detect the previous backup snapshot by listing snapshots with the same prefix
     and taking the second-to-last one (after sorting by creation time)
   - If a previous backup snapshot exists, use incremental send:
     zfs send -i @previous @current
   - If no previous backup snapshot exists, use full send:
     zfs send @current
   - Route the send stream to the target:
     - If BACKUP_TARGET starts with ssh://, parse host and dataset, pipe to:
       ssh $host zfs recv $dataset
     - Otherwise, treat BACKUP_TARGET as a file path, redirect to:
       > ${BACKUP_TARGET}/${snapname}.zfs
   - After successful send, compute SHA-256 of the sent stream for verification:
     For file targets: sha256 ${BACKUP_TARGET}/${snapname}.zfs > ${BACKUP_TARGET}/${snapname}.zfs.sha256
   - Retain only 2 backup snapshots (current + previous). Destroy any older ones:
     zfs list -t snapshot -o name -H | grep "@${BACKUP_SNAP_PREFIX}-" | sort | head -n -2 | xargs -I{} zfs destroy {}
   - Log all operations to BACKUP_LOG with timestamps
   - Exit 0 on success, non-zero on any failure (set -e handles this)

   The script must be idempotent and safe to run via cron.

2. Make the script executable: chmod 755 scripts/backup-offhost.sh

3. Create docs/BACKUP.md with the following sections:

   ## Backup Strategy
   Overview: three layers of backup protection:
   - Daily SQLite database backup (built-in backupDatabase())
   - Periodic ZFS snapshots for point-in-time recovery (see 11B cron job)
   - Off-host backup via zfs send for disaster recovery

   ## Off-Host Backup (scripts/backup-offhost.sh)
   - What it does
   - Environment variables (BACKUP_TARGET, BACKUP_DATASET, BACKUP_SNAP_PREFIX, BACKUP_LOG)
   - Running manually:
     BACKUP_TARGET=/mnt/external/nanoclaw ./scripts/backup-offhost.sh
   - Running via cron:
     0 2 * * * nanoclaw BACKUP_TARGET=ssh://backup-host/tank/nanoclaw /path/to/scripts/backup-offhost.sh

   ## ZFS Snapshot Policy
   - Automatic 4-hourly snapshots (installed via etc/cron.d/nanoclaw-snapshots)
   - Retention: 42 snapshots (7 days at 4-hour intervals)

   ## Retention Summary
   | Layer | Frequency | Retention | Location |
   |-------|-----------|-----------|----------|
   | SQLite backup | Daily | 7 copies | Same pool |
   | ZFS snapshots | 4-hourly | 42 snapshots (7 days) | Same pool |
   | Off-host backup | Configurable (daily recommended) | 2 snapshots | Remote host or file |

   ## Verification
   - For file-based backups: compare SHA-256 checksums
   - Test restore procedure periodically

   ## Restore Procedure
   - From ZFS snapshot: zfs rollback zroot/nanoclaw@<snapshot>
   - From off-host backup (file): zfs recv zroot/nanoclaw < /path/to/backup.zfs
   - From off-host backup (ssh): ssh backup-host zfs send tank/nanoclaw-backup@latest | zfs recv zroot/nanoclaw
   - After restore: verify database integrity (sqlite3 store/nanoclaw.db "PRAGMA integrity_check")
   - After restore: restart service (sudo service nanoclaw restart)

4. This ticket produces shell script and documentation only — no TypeScript changes.
   Verify the rest of the project is unaffected:
   - Run: npm test
   - Run: npx tsc --noEmit
   - Run: npm run lint

IMPLEMENTATION_COMPLETE
```

### QA Prompt

```
Read SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-p11a — Add off-host backup via zfs send
FILES TO VALIDATE: scripts/backup-offhost.sh, docs/BACKUP.md

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only scripts/backup-offhost.sh
    and docs/BACKUP.md
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

TICKET-SPECIFIC CHECKS:

[ ] Script exists: scripts/backup-offhost.sh is present and executable (has execute bit).

[ ] Script safety: The first two non-comment lines include set -euo pipefail.

[ ] BACKUP_TARGET validation: The script checks that BACKUP_TARGET is set and exits
    with a usage message if missing.

[ ] ZFS send present: The script contains both:
    - zfs send -i (incremental send with previous snapshot)
    - zfs send (full send without -i, for first-time backup)

[ ] Target routing: The script handles both ssh:// targets (pipe to ssh host zfs recv)
    and file path targets (redirect to file).

[ ] SHA-256 verification: The script computes a SHA-256 checksum of the backup file
    for file-based targets.

[ ] Snapshot retention: The script prunes backup snapshots to keep only 2.

[ ] Logging: The script logs operations with timestamps to a configurable log path.

[ ] Documentation exists: docs/BACKUP.md is present and non-empty.

[ ] Documentation sections: docs/BACKUP.md contains all required sections:
    - Backup Strategy (overview of three layers)
    - Off-Host Backup (environment variables, manual usage, cron usage)
    - ZFS Snapshot Policy
    - Retention Summary (table)
    - Verification
    - Restore Procedure

[ ] No hardcoded paths: Neither file contains hardcoded personal paths (/home/jims).

Report each check as PASS or FAIL with details.
Final output: QA_PASS or QA_FAIL
```

---

## Stage 11B: Add ZFS Snapshot Cron Job for Data Directories

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p11b` |
| **Title** | Add ZFS snapshot cron job for data directories |
| **Priority** | P3 |
| **Tags** | `nanoclaw`, `phase-11`, `zfs`, `cron`, `backup` |
| **Files** | `etc/cron.d/nanoclaw-snapshots` (new), `scripts/setup-freebsd.sh` |
| **Dependencies** | None (within phase) |
| **Effort** | ~15 lines / Small |

### Context

The SRE report (`reports/sre_report.md`, section 7.3, lines 328-334) recommends 4-hourly ZFS snapshots with 7-day retention for the data directories. The exact recommendation:

```sh
# /etc/cron.d/nanoclaw-snapshots
0 */4 * * * root zfs snapshot -r zroot/nanoclaw@auto-$(date +\%Y\%m\%d-\%H\%M)
# Prune snapshots older than 7 days
0 3 * * * root zfs list -t snapshot -o name -H | grep '@auto-' | head -n -42 | xargs -I{} zfs destroy {}
```

Currently no periodic ZFS snapshots of data directories exist. The `store/` and `groups/` directories contain the database and group workspaces with no point-in-time recovery mechanism.

In `scripts/setup-freebsd.sh`, Section 9 (line 786) installs the rc.d service. There is no cron installation section. The new cron file installation should be added after the rc.d service setup, either as part of Section 9 or as a new subsection before Section 10 (Summary, line 819).

**Impact**: Point-in-time recovery for data directories. With 4-hourly snapshots and 7-day retention (42 snapshots), any accidental data loss or corruption can be recovered to within 4 hours.

### Developer Prompt

```
Read SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-p11b — Add ZFS snapshot cron job for data directories
FILES: etc/cron.d/nanoclaw-snapshots (new), scripts/setup-freebsd.sh

CONTEXT:
The SRE report section 7.3 recommends 4-hourly ZFS snapshots with 7-day retention.
No periodic ZFS snapshots exist for data directories. The setup script has no cron
installation section.

CHANGES:

1. Create etc/cron.d/nanoclaw-snapshots with this exact content:
   ```
   # NanoClaw ZFS snapshot policy
   # Recursive snapshot every 4 hours — covers database, groups, workspaces
   0 */4 * * * root zfs snapshot -r zroot/nanoclaw@auto-$(date +\%Y\%m\%d-\%H\%M)

   # Prune to keep 42 snapshots (7 days at 4-hour intervals)
   # Runs daily at 03:00 — sorts by name (chronological), keeps newest 42
   0 3 * * * root zfs list -t snapshot -o name -H | grep '@auto-' | sort | head -n -42 | xargs -I{} zfs destroy {}
   ```

2. Open scripts/setup-freebsd.sh and read Section 9 (line 786-816) and Section 10
   (line 819+).

3. After the setup_rcd_service() function (after line 816) and BEFORE the Section 10
   comment (line 818), add a new function to install the cron file:

   ```sh
   # =============================================================================
   # Section 9b: Cron Jobs
   # =============================================================================
   setup_cron_jobs() {
       print_header "9b" "Cron Jobs"

       CRON_SRC="$NANOCLAW_SRC/etc/cron.d/nanoclaw-snapshots"
       CRON_DEST="/etc/cron.d/nanoclaw-snapshots"

       if [ ! -f "$CRON_SRC" ]; then
           log_info "Cron file not found in source — skipping"
           return 0
       fi

       log_info "Installing ZFS snapshot cron job..."
       cp "$CRON_SRC" "$CRON_DEST"
       chmod 644 "$CRON_DEST"
       log_success "Cron job installed at $CRON_DEST"
   }
   ```

4. Find the main execution section at the bottom of setup-freebsd.sh where functions
   are called in order. Add a call to setup_cron_jobs after setup_rcd_service and
   before print_summary.

5. This ticket produces a cron file and shell script changes only — no TypeScript
   changes. Verify the rest of the project is unaffected:
   - Run: npm test
   - Run: npx tsc --noEmit
   - Run: npm run lint

IMPLEMENTATION_COMPLETE
```

### QA Prompt

```
Read SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-p11b — Add ZFS snapshot cron job for data directories
FILES TO VALIDATE: etc/cron.d/nanoclaw-snapshots, scripts/setup-freebsd.sh

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only etc/cron.d/nanoclaw-snapshots
    and scripts/setup-freebsd.sh
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

TICKET-SPECIFIC CHECKS:

[ ] Cron file exists: etc/cron.d/nanoclaw-snapshots is present and non-empty.

[ ] Snapshot schedule: The cron file contains a line with schedule "0 */4 * * *"
    that runs zfs snapshot -r with the @auto- prefix.

[ ] Pruning schedule: The cron file contains a line with schedule "0 3 * * *"
    that prunes snapshots, keeping the newest 42 (head -n -42).

[ ] Cron runs as root: Both cron lines specify "root" as the user field.

[ ] Setup script installs cron: scripts/setup-freebsd.sh contains a function
    (setup_cron_jobs or similar) that copies the cron file to /etc/cron.d/.

[ ] Setup script calls function: The main execution section of setup-freebsd.sh
    calls the cron installation function after setup_rcd_service and before
    print_summary.

[ ] Function is idempotent: The cron installation function uses cp (overwrite)
    and does not fail if the file already exists at the destination.

[ ] File permissions: The setup function sets chmod 644 on the installed cron file
    (cron.d files should not be executable).

Report each check as PASS or FAIL with details.
Final output: QA_PASS or QA_FAIL
```

---

## Stage 11C: Add cpuset Pinning for Jails

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p11c` |
| **Title** | Add cpuset pinning for jails |
| **Priority** | P3 |
| **Tags** | `nanoclaw`, `phase-11`, `freebsd`, `cpuset`, `isolation` |
| **Files** | `src/jail/lifecycle.ts`, `src/jail/config.ts` |
| **Dependencies** | None (within phase) |
| **Effort** | ~20 lines / Small |

### Context

The FreeBSD sysadmin report (`reports/freebsd_sysadmin_report.md`, section 10.1, line 470) identifies missing cpuset pinning:

> "No `cpuset` / `cpuset_id` configuration: Jails should be pinned to specific CPUs or CPU sets to prevent a jail from monopolizing all cores. While `rctl pcpu:deny=80` limits total CPU percentage, `cpuset` provides hard isolation."

The recommended fix is:
```sh
cpuset -l 0-3 -j $jailname
```

In `src/jail/lifecycle.ts`, the `applyRctlLimits()` function at lines 129-150 applies `memoryuse`, `maxproc`, and `pcpu` limits using `rctl -a`. The cpuset command should be applied after rctl limits. The call site is at line 345 in `createJail()`:

```typescript
await applyRctlLimits(jailName);
```

In `src/jail/config.ts`, the `JAIL_CONFIG` object at lines 57-81 contains `resourceLimits` with `memoryuse`, `maxproc`, and `pcpu`. The `clampInt()` helper at lines 8-17 provides the env var parsing pattern. A new `cpuset` property should be added to `JAIL_CONFIG` (not inside `resourceLimits`, since cpuset is not an rctl resource).

**Impact**: Hard CPU core isolation prevents a jail from monopolizing all host cores. While `rctl pcpu:deny=80` limits aggregate CPU percentage, a jail could still spread work across all cores, causing cache thrashing. `cpuset` confines work to specific cores.

### Developer Prompt

```
Read SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-p11c — Add cpuset pinning for jails
FILES: src/jail/lifecycle.ts, src/jail/config.ts

CONTEXT:
The FreeBSD sysadmin report section 10.1 identifies missing cpuset pinning.
The rctl limits at src/jail/lifecycle.ts:129-150 cover CPU percentage but not
core affinity. In src/jail/config.ts, JAIL_CONFIG at lines 57-81 holds the
resource configuration. Follow existing patterns for env vars and sudo calls.

CHANGES:

1. Open src/jail/config.ts and read the full file (113 lines).

2. Add a new property to JAIL_CONFIG (at the top level, NOT inside resourceLimits,
   since cpuset is not an rctl resource). Add it after the resourceLimits block
   (after line 81):
   ```typescript
   cpuset: process.env.NANOCLAW_JAIL_CPUSET || '',
   ```
   When empty string, cpuset pinning is not applied (opt-in behavior).

3. Open src/jail/types.ts and read the JailConfig interface (lines 74-87).

4. Add the new property to the JailConfig interface:
   ```typescript
   cpuset: string;
   ```
   Add it after the resourceLimits property (after line 86).

5. Open src/jail/lifecycle.ts and read the applyRctlLimits() function (lines 129-150)
   and the createJail() function's call to applyRctlLimits at line 345.

6. Add a new function applyCpuset() AFTER applyRctlLimits() (after line 150):
   ```typescript
   /** Apply cpuset pinning to a jail if configured. */
   async function applyCpuset(jailName: string): Promise<void> {
     if (!JAIL_CONFIG.cpuset) {
       return;
     }
     const sudoExec = getSudoExec();
     try {
       await sudoExec(['cpuset', '-l', JAIL_CONFIG.cpuset, '-j', jailName]);
       logger.info({ jailName, cpuset: JAIL_CONFIG.cpuset }, 'Applied cpuset pinning');
     } catch (error) {
       logger.warn({ jailName, cpuset: JAIL_CONFIG.cpuset, err: error }, 'Could not apply cpuset pinning');
     }
   }
   ```

7. In createJail(), immediately after the applyRctlLimits call (line 345), add:
   ```typescript
   await applyCpuset(jailName);
   ```

8. Run: npm test
9. Run: npx tsc --noEmit
10. Run: npm run lint
11. Run: npm run format:check

IMPLEMENTATION_COMPLETE
```

### QA Prompt

```
Read SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-p11c — Add cpuset pinning for jails
FILES TO VALIDATE: src/jail/lifecycle.ts, src/jail/config.ts, src/jail/types.ts

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only src/jail/lifecycle.ts,
    src/jail/config.ts, and src/jail/types.ts
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

TICKET-SPECIFIC CHECKS:

[ ] Config env var present: src/jail/config.ts JAIL_CONFIG object contains a
    cpuset property reading from process.env.NANOCLAW_JAIL_CPUSET with default
    empty string.

[ ] cpuset NOT inside resourceLimits: The cpuset property is at the top level
    of JAIL_CONFIG, not nested inside resourceLimits.

[ ] Type updated: src/jail/types.ts JailConfig interface contains cpuset: string.

[ ] applyCpuset function exists: src/jail/lifecycle.ts contains a function
    (applyCpuset or equivalent) that:
    - Returns early if JAIL_CONFIG.cpuset is empty/falsy
    - Calls sudoExec with ['cpuset', '-l', JAIL_CONFIG.cpuset, '-j', jailName]
    - Logs at info level on success
    - Catches errors and logs at warn level (does not throw)

[ ] Call order correct: In createJail(), applyCpuset is called AFTER applyRctlLimits
    and BEFORE the network configuration step (configureJailNetwork).

[ ] Opt-in behavior: When NANOCLAW_JAIL_CPUSET is unset or empty, no cpuset
    command is executed (the function returns early).

[ ] No existing rctl logic modified: The applyRctlLimits function at lines 129-150
    is unchanged.

Report each check as PASS or FAIL with details.
Final output: QA_PASS or QA_FAIL
```

---

## Stage 11D: Add Additional rctl Limits

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p11d` |
| **Title** | Add additional rctl limits (readbps, writebps, openfiles, wallclock) |
| **Priority** | P3 |
| **Tags** | `nanoclaw`, `phase-11`, `freebsd`, `rctl`, `resource-limits` |
| **Files** | `src/jail/lifecycle.ts`, `src/jail/config.ts`, `src/jail/types.ts` |
| **Dependencies** | None (within phase) |
| **Effort** | ~30 lines / Small |

### Context

The FreeBSD sysadmin report (`reports/freebsd_sysadmin_report.md`, section 10.2, lines 476-482) identifies that the rctl limits only cover `memoryuse`, `maxproc`, and `pcpu`. Missing limits include:

> - `readbps` / `writebps` -- disk I/O bandwidth limits
> - `readiops` / `writeiops` -- disk I/O operations limits
> - `openfiles` -- maximum open file descriptors
> - `wallclock` -- wall clock time limit (the code handles timeout at the process level, but rctl would be a kernel-enforced backstop)

In `src/jail/lifecycle.ts`, the existing `applyRctlLimits()` at lines 129-150 applies three limits using the pattern:

```typescript
await sudoExec(['rctl', '-a', `jail:${jailName}:memoryuse:deny=${limits.memoryuse}`]);
await sudoExec(['rctl', '-a', `jail:${jailName}:maxproc:deny=${limits.maxproc}`]);
await sudoExec(['rctl', '-a', `jail:${jailName}:pcpu:deny=${limits.pcpu}`]);
```

In `src/jail/config.ts`, `resourceLimits` at lines 76-81 defines the three existing limits. In `src/jail/types.ts`, the `ResourceLimits` interface at lines 67-71 types them.

The new limits should follow the same pattern but be optional — empty string means "not applied." This allows operators to opt in to I/O limits and wallclock limits without breaking existing deployments.

**Impact**: Broader resource containment. Disk I/O limits prevent a jail from saturating the ZFS pool's IOPS. Open file limits prevent file descriptor exhaustion. Wall clock limits provide a kernel-enforced backstop complementing the application-level timeout.

### Developer Prompt

```
Read SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-p11d — Add additional rctl limits
FILES: src/jail/lifecycle.ts, src/jail/config.ts, src/jail/types.ts

CONTEXT:
The FreeBSD sysadmin report section 10.2 identifies missing rctl limits. The
existing pattern in lifecycle.ts:129-150 applies memoryuse, maxproc, pcpu via
individual rctl -a calls. config.ts:76-81 defines the limits. types.ts:67-71
provides the interface. New limits should be optional (empty string = not applied).

CHANGES:

1. Open src/jail/types.ts and read the ResourceLimits interface (lines 67-71).

2. Add four optional properties to ResourceLimits:
   ```typescript
   export interface ResourceLimits {
     memoryuse: string;
     maxproc: string;
     pcpu: string;
     readbps: string;
     writebps: string;
     openfiles: string;
     wallclock: string;
   }
   ```

3. Open src/jail/config.ts and read the resourceLimits section (lines 76-81).

4. Add the four new limits to resourceLimits in JAIL_CONFIG. New limits default
   to empty string (not applied) except openfiles which defaults to '1000':
   ```typescript
   resourceLimits: {
     memoryuse: process.env.NANOCLAW_JAIL_MEMORY_LIMIT || '2G',
     maxproc: process.env.NANOCLAW_JAIL_MAXPROC || '100',
     pcpu: process.env.NANOCLAW_JAIL_PCPU || '80',
     readbps: process.env.NANOCLAW_JAIL_READBPS || '',
     writebps: process.env.NANOCLAW_JAIL_WRITEBPS || '',
     openfiles: process.env.NANOCLAW_JAIL_OPENFILES || '1000',
     wallclock: process.env.NANOCLAW_JAIL_WALLCLOCK || '',
   },
   ```

5. Open src/jail/lifecycle.ts and read applyRctlLimits() (lines 129-150).

6. After the existing three rctl calls (memoryuse, maxproc, pcpu at lines 135-145)
   and BEFORE the logger.info call at line 146, add the optional limits:
   ```typescript
   // Apply optional additional limits (empty string = skip)
   const optionalLimits: Array<[string, string]> = [
     ['readbps', limits.readbps],
     ['writebps', limits.writebps],
     ['openfiles', limits.openfiles],
     ['wallclock', limits.wallclock],
   ];
   for (const [resource, value] of optionalLimits) {
     if (value) {
       await sudoExec(['rctl', '-a', `jail:${jailName}:${resource}:deny=${value}`]);
     }
   }
   ```

7. Do NOT modify the existing three rctl calls (memoryuse, maxproc, pcpu). They
   remain as-is. The new code is additive only.

8. Run: npm test
9. Run: npx tsc --noEmit
10. Run: npm run lint
11. Run: npm run format:check

IMPLEMENTATION_COMPLETE
```

### QA Prompt

```
Read SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-p11d — Add additional rctl limits
FILES TO VALIDATE: src/jail/lifecycle.ts, src/jail/config.ts, src/jail/types.ts

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only src/jail/lifecycle.ts,
    src/jail/config.ts, and src/jail/types.ts
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

TICKET-SPECIFIC CHECKS:

[ ] ResourceLimits type updated: src/jail/types.ts ResourceLimits interface
    contains all 7 properties: memoryuse, maxproc, pcpu, readbps, writebps,
    openfiles, wallclock — all typed as string.

[ ] Config has new env vars: src/jail/config.ts resourceLimits contains:
    - readbps reading from NANOCLAW_JAIL_READBPS, default ''
    - writebps reading from NANOCLAW_JAIL_WRITEBPS, default ''
    - openfiles reading from NANOCLAW_JAIL_OPENFILES, default '1000'
    - wallclock reading from NANOCLAW_JAIL_WALLCLOCK, default ''

[ ] Existing limits unchanged: The three original limits (memoryuse, maxproc, pcpu)
    in config.ts retain their existing defaults ('2G', '100', '80').

[ ] Optional limits applied conditionally: In lifecycle.ts applyRctlLimits(),
    the four new limits are only applied when their value is a non-empty string.
    The code checks each value before calling rctl.

[ ] rctl command format correct: New rctl calls follow the existing pattern:
    rctl -a jail:${jailName}:${resource}:deny=${value}

[ ] Existing rctl calls untouched: The original three rctl -a calls for
    memoryuse, maxproc, and pcpu are not modified (same lines, same format).

[ ] removeRctlLimits still works: The removeRctlLimits function at lines 152-164
    uses rctl -r jail:${jailName} which removes ALL rules for a jail, including
    the new ones. Verify it is NOT modified (it already handles any number of rules).

[ ] Default behavior preserved: With all new env vars unset, only openfiles
    (default '1000') will be applied in addition to the existing three limits.
    readbps, writebps, and wallclock default to '' and are skipped.

Report each check as PASS or FAIL with details.
Final output: QA_PASS or QA_FAIL
```

---

## Phase 11 Integration QA

After all four stage tickets (11A, 11B, 11C, 11D) have individually passed QA and been committed to their respective branches, run the following integration QA on the merged result.

### Integration QA Prompt

```
ROLE: Phase Integration QA subagent
PHASE: Phase 11 -- Operational Infrastructure
READ FIRST: refinement/03252026/SHARED_INSTRUCTIONS.md

CONTEXT:
All four Phase 11 stages have been implemented and merged into a single branch.
This integration QA verifies that the four changes work together correctly and
do not interfere with each other or with existing functionality.

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] Only expected files changed: git diff --stat against main shows exactly
    src/jail/lifecycle.ts, src/jail/config.ts, src/jail/types.ts,
    scripts/setup-freebsd.sh, scripts/backup-offhost.sh, docs/BACKUP.md,
    etc/cron.d/nanoclaw-snapshots
[ ] No secrets or credentials in diff

CROSS-TICKET INTEGRATION CHECKS:

[ ] No merge conflicts: Verify there are no conflict markers (<<<<<<, ======,
    >>>>>>) in any modified file. Stages 11C and 11D both modify lifecycle.ts,
    config.ts, and types.ts — confirm the changes are cleanly merged.

[ ] lifecycle.ts function order correct: In src/jail/lifecycle.ts, verify:
    1. applyRctlLimits() exists and applies all 7 limits (3 mandatory + 4 optional)
       The 3 mandatory limits (memoryuse, maxproc, pcpu) are applied unconditionally.
       The 4 optional limits (readbps, writebps, openfiles, wallclock) are applied
       only when their value is non-empty.
    2. applyCpuset() exists AFTER applyRctlLimits and:
       - Returns early if JAIL_CONFIG.cpuset is empty
       - Calls cpuset -l <cpus> -j <jailName>
       - Catches errors without throwing
    3. In createJail(), the call order is: applyRctlLimits -> applyCpuset
       (both after jail -f ... -c and before configureJailNetwork)

[ ] config.ts completeness: src/jail/config.ts JAIL_CONFIG contains:
    - resourceLimits.memoryuse (from NANOCLAW_JAIL_MEMORY_LIMIT, default '2G')
    - resourceLimits.maxproc (from NANOCLAW_JAIL_MAXPROC, default '100')
    - resourceLimits.pcpu (from NANOCLAW_JAIL_PCPU, default '80')
    - resourceLimits.readbps (from NANOCLAW_JAIL_READBPS, default '')
    - resourceLimits.writebps (from NANOCLAW_JAIL_WRITEBPS, default '')
    - resourceLimits.openfiles (from NANOCLAW_JAIL_OPENFILES, default '1000')
    - resourceLimits.wallclock (from NANOCLAW_JAIL_WALLCLOCK, default '')
    - cpuset (from NANOCLAW_JAIL_CPUSET, default '')
    Verify cpuset is at the JAIL_CONFIG top level, not inside resourceLimits.

[ ] types.ts consistency: src/jail/types.ts contains:
    - ResourceLimits with 7 string properties (memoryuse, maxproc, pcpu,
      readbps, writebps, openfiles, wallclock)
    - JailConfig with cpuset: string at top level and resourceLimits: ResourceLimits
    Verify the types match the runtime values in config.ts.

[ ] Backup script is standalone: scripts/backup-offhost.sh does not import or
    depend on any TypeScript modules. It is a self-contained shell script.

[ ] Cron file is installable: etc/cron.d/nanoclaw-snapshots exists and
    scripts/setup-freebsd.sh contains a function to install it to /etc/cron.d/.

[ ] Setup script execution order: In scripts/setup-freebsd.sh, the function
    call order includes: setup_rcd_service -> setup_cron_jobs -> print_summary.
    The cron installation does not interfere with the rc.d installation.

[ ] Backup docs reference cron: docs/BACKUP.md mentions the ZFS snapshot cron
    job (etc/cron.d/nanoclaw-snapshots or the 4-hourly schedule), connecting
    the 11A documentation to the 11B cron file.

[ ] Default behavior unchanged: With all new env vars unset:
    - cpuset pinning is NOT applied (empty string)
    - readbps, writebps, wallclock limits are NOT applied (empty string)
    - openfiles limit IS applied with default '1000'
    - The existing create-run-destroy flow works exactly as before
    - Backup and cron are installed but dormant until BACKUP_TARGET is set

[ ] No regressions in existing tests: All existing test files pass without
    modification. The changes to lifecycle.ts, config.ts, and types.ts are
    additive and backward-compatible with mocked test scenarios.

[ ] Build succeeds end-to-end: npm run build completes without errors.

[ ] No hardcoded paths: grep -r '/home/jims' across all modified files returns
    no results.

Report each check as PASS or FAIL with details.
Final output: QA_PASS or QA_FAIL followed by a summary of all Phase 11 changes.
If QA_FAIL, identify which stage(s) caused the failure and what needs to be fixed.
```
