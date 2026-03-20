---
id: src-696o
status: closed
deps: []
links: []
created: 2026-03-19T18:09:34Z
type: task
priority: 2
assignee: Jim Spring
tags: [phase-4, observability]
---
# Unify logging (jail-runtime to pino)

## Summary
Code quality fix: jail-runtime.js uses console.log, container-runner.ts uses pino. Inconsistent formats.

## Key Files
- jail-runtime.js:36 (console.log usage)
- container-runner.ts (pino usage)

## Solution
Unify logging to use pino throughout.

## Implementation Details
1. Import pino logger from shared module in jail-runtime.js
2. Replace console.log with logger.info
3. Replace console.error with logger.error
4. Add structured metadata (jailName, groupId, etc.)
5. Verify log format consistency across codebase

## Acceptance Criteria

- All console.log/error calls replaced with pino
- Structured metadata included in log entries
- Consistent JSON log format across all modules


## Notes

**2026-03-19T20:21:36Z**

Unified logging. Modified: jail-runtime.ts. Replaced console.log/error with pino logger, added structured metadata, removed custom log() helper.
