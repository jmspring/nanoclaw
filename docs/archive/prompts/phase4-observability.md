# Phase 4: Observability — High Priority (Should Fix Before Production)

## Overview
These tickets add monitoring, logging, and observability features needed for production operation.

## Dependencies

- **nan-kblq, nan-1tiy, nan-nfd6**: No dependencies, can run in parallel
- **nan-efbx**: Depends on nan-1tiy (unified logging)

## Tickets

| Ticket ID | Title | Effort | Depends On |
|-----------|-------|--------|------------|
| nan-kblq | Add monitoring hooks (health and metrics endpoints) | L | none |
| nan-1tiy | Unify logging (jail-runtime to pino) | S | none |
| nan-nfd6 | Implement log rotation | S | none |
| nan-efbx | Add request/trace ID correlation | S | nan-1tiy |

---

## Wave 1 Prompts (No Dependencies)

### nan-kblq: Add monitoring hooks (health and metrics endpoints)

```
You are implementing ticket nan-kblq for the NanoClaw FreeBSD jail runtime.

## Setup

1. Read the ticket: tk show nan-kblq
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-kblq -b ticket/nan-kblq
   cd /tmp/nanoclaw-nan-kblq
3. Mark in progress: tk start nan-kblq

## Task Context
Observability fix: Zero instrumentation for external monitoring. No health checks, metrics, or alerting.

Key files: jail-runtime.js, container-runner.ts, index.ts

Solution: Add /health and /metrics endpoints.

## Implementation

4. Read index.ts to understand the HTTP server setup
5. Implement /health endpoint:
   - Check template snapshot exists
   - Check ZFS pool free space
   - Check pf enabled
   - Return 200 if healthy, 503 if degraded
6. Implement /metrics endpoint (Prometheus format):
   - nanoclaw_active_jails gauge
   - nanoclaw_jail_create_total counter (success/failure)
   - nanoclaw_epair_used gauge
   - nanoclaw_zfs_pool_bytes_avail gauge
7. Make metrics optional (disabled by default)
8. Run npm run build

## Completion

9. Commit:
   git add -A
   git commit -m "feat(nan-kblq): add monitoring hooks (health and metrics endpoints)

   - Add /health endpoint with template, ZFS, pf checks
   - Add /metrics endpoint with Prometheus-compatible format
   - Track active jails, create counts, epair usage, pool space
   - Metrics optional, disabled by default

   Closes nan-kblq"

10. Close: tk add-note nan-kblq "Added /health and /metrics. Modified: index.ts." && tk close nan-kblq
11. Push and cleanup:
    git push -u origin ticket/nan-kblq
    cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-kblq

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

### nan-1tiy: Unify logging (jail-runtime to pino)

```
You are implementing ticket nan-1tiy for the NanoClaw FreeBSD jail runtime.

## Setup

1. Read the ticket: tk show nan-1tiy
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-1tiy -b ticket/nan-1tiy
   cd /tmp/nanoclaw-nan-1tiy
3. Mark in progress: tk start nan-1tiy

## Task Context
Code quality fix: jail-runtime.js uses console.log, container-runner.ts uses pino. Inconsistent formats.

Key files: jail-runtime.js:36, container-runner.ts

Solution: Unify logging to use pino throughout.

## Implementation

4. Read jail-runtime.js logging calls
5. Convert to pino:
   - Import pino logger from shared module
   - Replace console.log with logger.info
   - Replace console.error with logger.error
   - Add structured metadata (jailName, groupId, etc.)
6. Verify log format consistency
7. Run npm run build

## Completion

8. Commit:
   git add -A
   git commit -m "fix(nan-1tiy): unify logging (jail-runtime to pino)

   - Replace console.log/error with pino logger
   - Add structured metadata to log entries
   - Consistent log format across codebase

   Closes nan-1tiy"

9. Close: tk add-note nan-1tiy "Unified logging. Modified: jail-runtime.js." && tk close nan-1tiy
10. Push and cleanup:
    git push -u origin ticket/nan-1tiy
    cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-1tiy

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

### nan-nfd6: Implement log rotation

```
You are implementing ticket nan-nfd6 for the NanoClaw FreeBSD jail runtime.

## Setup

1. Read the ticket: tk show nan-nfd6
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-nfd6 -b ticket/nan-nfd6
   cd /tmp/nanoclaw-nan-nfd6
3. Mark in progress: tk start nan-nfd6

## Task Context
Operational fix: Jail logs accumulate indefinitely. No rotation or cleanup.

Key files: container-runner.ts:605

Solution: Implement log rotation for jail logs.

## Implementation

4. Read container-runner.ts log handling
5. Implement log rotation:
   - Use pino-roll or rotating-file-stream
   - Rotate when file reaches size threshold (e.g., 10MB)
   - Keep N rotated files (e.g., 5)
   - Compress rotated files (.gz)
   - Clean up logs older than X days
6. Make rotation configurable
7. Run npm run build

## Completion

8. Commit:
   git add -A
   git commit -m "fix(nan-nfd6): implement log rotation for jail logs

   - Add rotating file stream for jail logs
   - Rotate at 10MB, keep 5 files
   - Compress rotated logs
   - Configurable retention policy

   Closes nan-nfd6"

9. Close: tk add-note nan-nfd6 "Added log rotation. Modified: container-runner.ts." && tk close nan-nfd6
10. Push and cleanup:
    git push -u origin ticket/nan-nfd6
    cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-nfd6

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

---

## Wave 2 Prompt (Depends on nan-1tiy)

### nan-efbx: Add request/trace ID correlation

```
You are implementing ticket nan-efbx for the NanoClaw FreeBSD jail runtime.

## Prerequisites Check

BEFORE starting, verify dependency is closed:
  tk show nan-1tiy  # must be closed

If dependency is still open, STOP and report.

## Setup

1. Read the ticket: tk show nan-efbx
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-efbx -b ticket/nan-efbx
   cd /tmp/nanoclaw-nan-efbx
3. Merge ticket/nan-1tiy branch
4. Mark in progress: tk start nan-efbx

## Task Context
Observability fix: Request/trace ID correlation missing. Cannot trace requests across components.

Key files: index.ts, container-runner.ts, jail-runtime.js

Solution: Add trace IDs to all log entries.

## Implementation

4. Read the unified pino logging setup (from nan-1tiy)
5. Implement trace ID correlation:
   - Generate unique trace ID per request
   - Pass trace ID through all function calls
   - Include trace ID in all log entries
   - Add trace ID to error messages
   - Return trace ID in API responses (for debugging)
6. Run npm run build

## Completion

8. Commit:
   git add -A
   git commit -m "fix(nan-efbx): add request/trace ID correlation to logs

   - Generate unique trace ID per request
   - Include trace ID in all log entries
   - Pass trace ID through jail lifecycle
   - Return trace ID in API responses

   Closes nan-efbx"

9. Close: tk add-note nan-efbx "Added trace IDs. Modified: index.ts, container-runner.ts, jail-runtime.js." && tk close nan-efbx
10. Push and cleanup:
    git push -u origin ticket/nan-efbx
    cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-efbx

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

---

## Execution Order Summary

1. **Immediately**: nan-kblq, nan-1tiy, nan-nfd6 (parallel)
2. **After nan-1tiy**: nan-efbx
