---
id: src-algn
status: closed
deps: []
links: []
created: 2026-03-19T18:09:35Z
type: task
priority: 2
assignee: Jim Spring
tags: [phase-4, observability]
---
# Implement log rotation

## Summary
Operational fix: Jail logs accumulate indefinitely. No rotation or cleanup.

## Key Files
- container-runner.ts:605 (log handling)

## Solution
Implement log rotation for jail logs.

## Implementation Details
1. Use pino-roll or rotating-file-stream
2. Rotate when file reaches size threshold (e.g., 10MB)
3. Keep N rotated files (e.g., 5)
4. Compress rotated files (.gz)
5. Clean up logs older than X days
6. Make rotation configurable via config

## Acceptance Criteria

- Logs rotate at configured size threshold
- Compressed rotated files are retained
- Old logs cleaned up according to retention policy
- Rotation settings are configurable


## Notes

**2026-03-19T20:29:48Z**

Added log rotation. Modified: container-runner.ts, config.ts, index.ts. Created: log-rotation.ts.
