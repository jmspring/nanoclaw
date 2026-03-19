---
id: src-ijgn
status: closed
deps: []
links: []
created: 2026-03-19T18:09:34Z
type: task
priority: 2
assignee: Jim Spring
tags: [phase-4, observability]
---
# Add monitoring hooks (health and metrics endpoints)

## Summary
Observability fix: Zero instrumentation for external monitoring. No health checks, metrics, or alerting.

## Key Files
- index.ts (HTTP server setup)
- jail-runtime.js
- container-runner.ts

## Solution
Add /health and /metrics endpoints.

## Implementation Details
1. Implement /health endpoint:
   - Check template snapshot exists
   - Check ZFS pool free space
   - Check pf enabled
   - Return 200 if healthy, 503 if degraded

2. Implement /metrics endpoint (Prometheus format):
   - nanoclaw_active_jails gauge
   - nanoclaw_jail_create_total counter (success/failure)
   - nanoclaw_epair_used gauge
   - nanoclaw_zfs_pool_bytes_avail gauge

3. Make metrics optional (disabled by default)

## Acceptance Criteria

- /health returns 200 when all checks pass, 503 when degraded
- /metrics returns Prometheus-compatible format
- Metrics collection is optional and disabled by default
- All checks are non-blocking


## Notes

**2026-03-19T20:22:33Z**

Added /health and /metrics. Modified: src/index.ts, src/config.ts, src/jail-runtime.ts, new src/metrics.ts
