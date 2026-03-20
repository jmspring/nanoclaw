---
id: src-xo6r
status: closed
deps: []
links: []
created: 2026-03-19T15:30:11Z
type: task
priority: 1
assignee: Jim Spring
external-ref: nan-z5qe
---
# Add concurrent jail limit enforcement

Enforce maximum concurrent jail limit with queueing.

**Context:**
- No backpressure when too many jails spawn
- Flash crowds can exhaust system resources
- src/index.ts and src/group-queue.ts handle message processing
- Need to limit concurrent jails and queue excess

**Implementation:**
- Define max concurrent jails (50 or configurable via env var)
- Track active jail count in jail-runtime.ts
- Export getActiveJailCount() function
- Queue new requests when at capacity
- Process queued requests as jails complete
- Return meaningful error if queue grows too large

**Files:**
- src/jail-runtime.ts (jail count tracking)
- src/index.ts (queue integration)

**Acceptance:**
- [ ] Max concurrent jails enforced
- [ ] Excess requests queued (not rejected)
- [ ] Queue processed as jails complete
- [ ] Build succeeds


## Notes

**2026-03-19T18:05:12Z**

Implemented jail limits. Branch: ticket/nan-z5qe. Exports getActiveJailCount(), getJailCapacity(), isAtJailCapacity(). Merged to main via PR #8.
