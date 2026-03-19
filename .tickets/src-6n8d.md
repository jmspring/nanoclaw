---
id: src-6n8d
status: closed
deps: []
links: []
created: 2026-03-19T15:26:43Z
type: task
priority: 1
assignee: Jim Spring
external-ref: nan-f183
---
# Add epair limit monitoring and backpressure

Monitor epair pool usage and apply backpressure when approaching limits.

**Context:**
- FreeBSD has a finite epair pool (system-wide)
- No handling when pool depletes - silent failures
- jail-runtime.ts:390-446 handles epair creation
- Currently no monitoring or limits

**Implementation:**
- Track total epair allocation count globally
- Define max epairs (200 or configurable via env var)
- At 80% capacity: log warning
- At 100% capacity: reject new jails with clear error
- Expose epair usage metrics

**Files:**
- src/jail-runtime.ts (epair tracking)

**Acceptance:**
- [ ] Epair count tracked across all jails
- [ ] Warning logged at 80% capacity
- [ ] New jails rejected at 100% capacity with clear error
- [ ] Build succeeds


## Notes

**2026-03-19T17:18:26Z**

Added epair limits. Modified: src/jail-runtime.ts. Exports getEpairMetrics().
