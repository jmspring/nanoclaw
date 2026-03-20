---
id: src-le9k
status: in_progress
deps: [src-696o]
links: []
created: 2026-03-19T18:09:35Z
type: task
priority: 2
assignee: Jim Spring
tags: [phase-4, observability]
---
# Add request/trace ID correlation

## Summary
Observability fix: Request/trace ID correlation missing. Cannot trace requests across components.

## Key Files
- index.ts
- container-runner.ts
- jail-runtime.js

## Prerequisites
- Depends on unified pino logging ticket

## Solution
Add trace IDs to all log entries.

## Implementation Details
1. Generate unique trace ID per request (UUID or nanoid)
2. Pass trace ID through all function calls
3. Include trace ID in all log entries using pino child loggers
4. Add trace ID to error messages
5. Return trace ID in API responses (for debugging)

## Acceptance Criteria

- Each request gets unique trace ID
- All log entries include trace ID
- Trace ID returned in API responses
- Errors include trace ID for debugging

