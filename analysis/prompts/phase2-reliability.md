# Phase 2: Reliability — Critical Fixes (Must Fix Before PR)

## Overview
These tickets address critical reliability issues that must be fixed before any upstream PR.

## Tickets (Run in Parallel)

All tickets in Phase 2 have no dependencies and can be run concurrently.

| Ticket ID | Title | Effort |
|-----------|-------|--------|
| nan-gv4w | Add file-based epair lock or atomic assignment | S |
| nan-8j6g | Implement cleanup retry with error aggregation | M |
| nan-fucj | Add ZFS pool capacity check before clone | S |
| nan-79uf | Add template snapshot backup (base-backup) | S |

---

## Individual Ticket Prompts

### nan-gv4w: Add file-based epair lock or atomic assignment

```
You are implementing ticket nan-gv4w for the NanoClaw FreeBSD jail runtime.

## Setup

1. Read the ticket: tk show nan-gv4w
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-gv4w -b ticket/nan-gv4w
   cd /tmp/nanoclaw-nan-gv4w
3. Mark in progress: tk start nan-gv4w

## Task Context
Critical reliability fix: Concurrent jail creation can assign the same epair number to multiple jails. The in-memory Map has no locking.

Key files: jail-runtime.js:92-115

Solution options:
- File-based lock using flock()
- Deterministic epair scheme (hash groupId)
- Atomic check with ifconfig

## Implementation

4. Read jail-runtime.js epair assignment code
5. Implement locking mechanism (prefer file-based lock for simplicity):
   - Create lock file at /tmp/nanoclaw-epair.lock
   - Acquire exclusive lock before epair creation
   - Release lock after epair assigned
6. Add race condition test: verify 10 parallel jail creations succeed
7. Run npm run build

## Completion

8. Commit:
   git add -A
   git commit -m "fix(nan-gv4w): add file-based epair lock for atomic assignment

   - Implement flock-based locking for epair creation
   - Prevent race condition in concurrent jail creation
   - Ensure Map state consistent with system state

   Closes nan-gv4w"

9. Close: tk add-note nan-gv4w "Added epair locking. Modified: jail-runtime.js." && tk close nan-gv4w
10. Push and cleanup:
    git push -u origin ticket/nan-gv4w
    cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-gv4w

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

### nan-8j6g: Implement cleanup retry with error aggregation

```
You are implementing ticket nan-8j6g for the NanoClaw FreeBSD jail runtime.

## Setup

1. Read the ticket: tk show nan-8j6g
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-8j6g -b ticket/nan-8j6g
   cd /tmp/nanoclaw-nan-8j6g
3. Mark in progress: tk start nan-8j6g

## Task Context
Critical reliability fix: Partial failures during cleanup leave orphaned ZFS datasets, mounts, and epairs. No recovery mechanism.

Key files: jail-runtime.js:726-781

Solution: Implement cleanup retry with error aggregation - continue cleanup even if individual steps fail, collect all errors, retry failed steps.

## Implementation

4. Read jail-runtime.js cleanup code
5. Implement robust cleanup:
   - Wrap each cleanup step in try/catch
   - Continue cleanup even if step fails
   - Collect all errors
   - Retry failed steps up to 3 times with backoff
   - Log aggregated errors at end
   - Return success only if all steps succeeded
6. Add recovery function to clean orphaned resources on startup
7. Run npm run build

## Completion

8. Commit:
   git add -A
   git commit -m "fix(nan-8j6g): implement cleanup retry with error aggregation

   - Wrap cleanup steps in try/catch
   - Continue cleanup even on individual failures
   - Retry failed steps with backoff
   - Aggregate and report all errors
   - Add orphan recovery on startup

   Closes nan-8j6g"

9. Close: tk add-note nan-8j6g "Implemented cleanup retry. Modified: jail-runtime.js." && tk close nan-8j6g
10. Push and cleanup:
    git push -u origin ticket/nan-8j6g
    cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-8j6g

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

### nan-fucj: Add ZFS pool capacity check before clone

```
You are implementing ticket nan-fucj for the NanoClaw FreeBSD jail runtime.

## Setup

1. Read the ticket: tk show nan-fucj
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-fucj -b ticket/nan-fucj
   cd /tmp/nanoclaw-nan-fucj
3. Mark in progress: tk start nan-fucj

## Task Context
Reliability fix: No preemptive checks or graceful degradation when pool fills. Cryptic errors, incomplete cleanup.

Key files: jail-runtime.js:429-431

Solution: Check ZFS pool capacity before cloning, fail gracefully if pool is too full.

## Implementation

4. Read jail-runtime.js clone code
5. Implement capacity check:
   - Run `zfs list -H -o available <pool>` before clone
   - Define minimum threshold (e.g., 1GB or 10%)
   - Fail with clear error message if below threshold
   - Include available space in error message
6. Run npm run build

## Completion

8. Commit:
   git add -A
   git commit -m "fix(nan-fucj): add ZFS pool capacity check before clone

   - Check available space before jail clone
   - Fail gracefully with clear error if pool too full
   - Prevent cryptic failures and incomplete cleanup

   Closes nan-fucj"

9. Close: tk add-note nan-fucj "Added pool check. Modified: jail-runtime.js." && tk close nan-fucj
10. Push and cleanup:
    git push -u origin ticket/nan-fucj
    cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-fucj

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

### nan-79uf: Add template snapshot backup (base-backup)

```
You are implementing ticket nan-79uf for the NanoClaw FreeBSD jail runtime.

## Setup

1. Read the ticket: tk show nan-79uf
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-79uf -b ticket/nan-79uf
   cd /tmp/nanoclaw-nan-79uf
3. Mark in progress: tk start nan-79uf

## Task Context
Reliability fix: Setup script destroys old snapshot before validating new one. No rollback path.

Key files: setup-jail-template.sh:236

Solution: Keep backup snapshot until new one is validated.

## Implementation

4. Read setup-jail-template.sh
5. Implement backup strategy:
   - Before destroying old snapshot, rename to @base-backup
   - Create new snapshot @base
   - Validate new snapshot works (test clone)
   - Only then destroy @base-backup
   - If validation fails, restore from @base-backup
6. Update cleanup to handle backup snapshots

## Completion

8. Commit:
   git add -A
   git commit -m "fix(nan-79uf): add template snapshot backup for rollback

   - Rename old snapshot to @base-backup before update
   - Validate new snapshot before destroying backup
   - Restore from backup if validation fails
   - Ensures template corruption is recoverable

   Closes nan-79uf"

9. Close: tk add-note nan-79uf "Added snapshot backup. Modified: setup-jail-template.sh." && tk close nan-79uf
10. Push and cleanup:
    git push -u origin ticket/nan-79uf
    cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-79uf

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

---

## Execution Command

To run all Phase 2 tickets in parallel, spawn 4 subagents simultaneously with the individual prompts above.

## Dependency Note

Phase 2 has no dependencies on Phase 1. However, Phase 3 (nan-whvd and its dependents) depends on completion of ALL Phase 1 and Phase 2 tickets.
