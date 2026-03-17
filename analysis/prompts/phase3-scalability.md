# Phase 3: Scalability — High Priority (Should Fix Before Production)

## Overview
These tickets address scalability issues that should be fixed before production deployment.

## Dependencies

**IMPORTANT**: Phase 3 has complex dependencies:

1. **nan-whvd** (per-jail IP allocation) depends on ALL Phase 1 and Phase 2 tickets:
   - nan-z19n, nan-z2qc, nan-ugfr, nan-gv4w, nan-8j6g

2. **nan-f183, nan-z5qe, nan-bsv4** depend on nan-whvd

3. **nan-fmb6, nan-1u2t** have no dependencies and can run in parallel with Phase 1/2

## Execution Order

**Wave 1** (run in parallel with Phase 1/2):
- nan-fmb6: Pre-compile TypeScript in template
- nan-1u2t: Convert jail-runtime.js to TypeScript

**Wave 2** (after Phase 1 & 2 complete):
- nan-whvd: Implement per-jail IP allocation

**Wave 3** (after nan-whvd completes):
- nan-f183: Add epair limit monitoring and backpressure
- nan-z5qe: Add concurrent jail limit enforcement
- nan-bsv4: Add inter-jail network isolation

## Tickets

| Ticket ID | Title | Effort | Depends On |
|-----------|-------|--------|------------|
| nan-fmb6 | Pre-compile TypeScript in template | S | none |
| nan-1u2t | Convert jail-runtime.js to TypeScript | M | none |
| nan-whvd | Implement per-jail IP allocation | M | Phase 1, Phase 2 |
| nan-f183 | Add epair limit monitoring and backpressure | S | nan-whvd |
| nan-z5qe | Add concurrent jail limit enforcement | S | nan-whvd |
| nan-bsv4 | Add inter-jail network isolation | S | nan-whvd |

---

## Wave 1 Prompts (No Dependencies)

### nan-fmb6: Pre-compile TypeScript in template

```
You are implementing ticket nan-fmb6 for the NanoClaw FreeBSD jail runtime.

## Setup

1. Read the ticket: tk show nan-fmb6
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-fmb6 -b ticket/nan-fmb6
   cd /tmp/nanoclaw-nan-fmb6
3. Mark in progress: tk start nan-fmb6

## Task Context
Scalability fix: Each jail clones full template + compiles TypeScript. At 50+ jails, ZFS metadata thrashes.

Key files: jail-runtime.js:431, setup-jail-template.sh

Solution: Pre-compile TypeScript in the template so jails don't need to compile on startup.

## Implementation

4. Read setup-jail-template.sh and understand template creation
5. Modify template setup to:
   - Install TypeScript dependencies
   - Run npm run build in template
   - Include compiled JS in snapshot
   - Verify compiled output exists in template
6. Update jail-runtime.js to skip TypeScript compilation if already compiled
7. Run npm run build

## Completion

8. Commit:
   git add -A
   git commit -m "fix(nan-fmb6): pre-compile TypeScript in template

   - Run npm run build during template setup
   - Include compiled JS in template snapshot
   - Skip compilation in jails if already compiled
   - Reduces ZFS overhead at scale

   Closes nan-fmb6"

9. Close: tk add-note nan-fmb6 "Pre-compiled TS. Modified: setup-jail-template.sh, jail-runtime.js." && tk close nan-fmb6
10. Push and cleanup:
    git push -u origin ticket/nan-fmb6
    cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-fmb6

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

### nan-1u2t: Convert jail-runtime.js to TypeScript

```
You are implementing ticket nan-1u2t for the NanoClaw FreeBSD jail runtime.

## Setup

1. Read the ticket: tk show nan-1u2t
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-1u2t -b ticket/nan-1u2t
   cd /tmp/nanoclaw-nan-1u2t
3. Mark in progress: tk start nan-1u2t

## Task Context
Tech debt: jail-runtime.js is plain JS, forcing @ts-expect-error suppressions. No type safety at runtime boundary.

Key files: jail-runtime.js

Solution: Convert to TypeScript with proper type definitions.

## Implementation

4. Read jail-runtime.js completely
5. Convert to TypeScript:
   - Rename to jail-runtime.ts
   - Add type definitions for all functions
   - Add interfaces for JailConfig, JailMount, EpairInfo, etc.
   - Remove @ts-expect-error suppressions in container-runner.ts
   - Export types for use in other modules
6. Update imports in container-runner.ts
7. Run npm run build to verify compilation

## Completion

8. Commit:
   git add -A
   git commit -m "fix(nan-1u2t): convert jail-runtime.js to TypeScript

   - Rename jail-runtime.js to jail-runtime.ts
   - Add type definitions for all exported functions
   - Add interfaces: JailConfig, JailMount, EpairInfo, NetworkConfig
   - Remove @ts-expect-error suppressions

   Closes nan-1u2t"

9. Close: tk add-note nan-1u2t "Converted to TS. Modified: jail-runtime.ts, container-runner.ts." && tk close nan-1u2t
10. Push and cleanup:
    git push -u origin ticket/nan-1u2t
    cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-1u2t

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

---

## Wave 2 Prompt (Depends on Phase 1 & 2)

### nan-whvd: Implement per-jail IP allocation

```
You are implementing ticket nan-whvd for the NanoClaw FreeBSD jail runtime.

## Prerequisites Check

BEFORE starting, verify all dependencies are closed:
  tk show nan-z19n  # must be closed
  tk show nan-z2qc  # must be closed
  tk show nan-ugfr  # must be closed
  tk show nan-gv4w  # must be closed
  tk show nan-8j6g  # must be closed

If any dependency is still open, STOP and report which dependencies are blocking.

## Setup

1. Read the ticket: tk show nan-whvd
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-whvd -b ticket/nan-whvd
   cd /tmp/nanoclaw-nan-whvd
3. Merge any completed Phase 1/2 branches into this worktree
4. Mark in progress: tk start nan-whvd

## Task Context
Critical scalability fix: All jails share 10.99.0.2/30, limiting restricted mode to one jail at a time.

Key files: jail-runtime.js:24-26, pf-nanoclaw.conf:78

Solution: Implement per-jail IP allocation from a /24 pool. Each jail N uses subnet 10.99.N.0/30.

## Implementation

4. Read jail-runtime.js IP configuration
5. Implement per-jail IP allocation:
   - Update createEpair to return allocated subnet based on epair number
   - Host IP: 10.99.N.1, Jail IP: 10.99.N.2 (where N = epair number)
   - Update pf rules to use entire 10.99.0.0/24 range
   - Add assertion: refuse to create jail if IP already in use
   - Clean up IP state when epair is released
6. Update pf-nanoclaw.conf:
   - Change jail_net to "10.99.0.0/24"
   - Update NAT rules for dynamic IP range
7. Test: verify 10+ concurrent jails can run
8. Run npm run build

## Completion

9. Commit:
   git add -A
   git commit -m "fix(nan-whvd): implement per-jail IP allocation

   - Allocate unique subnet 10.99.N.0/30 per jail
   - Host IP: 10.99.N.1, Jail IP: 10.99.N.2
   - Update pf to handle entire 10.99.0.0/24 range
   - Add IP collision detection
   - Enable multi-jail concurrency in restricted mode

   Closes nan-whvd"

10. Close: tk add-note nan-whvd "Implemented IP allocation. Modified: jail-runtime.js, pf-nanoclaw.conf." && tk close nan-whvd
11. Push and cleanup:
    git push -u origin ticket/nan-whvd
    cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-whvd

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

---

## Wave 3 Prompts (Depend on nan-whvd)

### nan-f183: Add epair limit monitoring and backpressure

```
You are implementing ticket nan-f183 for the NanoClaw FreeBSD jail runtime.

## Prerequisites Check

BEFORE starting, verify dependency is closed:
  tk show nan-whvd  # must be closed

If dependency is still open, STOP and report.

## Setup

1. Read the ticket: tk show nan-f183
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-f183 -b ticket/nan-f183
   cd /tmp/nanoclaw-nan-f183
3. Merge ticket/nan-whvd branch
4. Mark in progress: tk start nan-f183

## Task Context
Scalability fix: No handling when FreeBSD's finite epair pool depletes. Silent failures.

Key files: jail-runtime.js:92-115

Solution: Monitor epair usage, apply backpressure when approaching limit.

## Implementation

4. Read jail-runtime.js epair management
5. Implement monitoring and backpressure:
   - Track total epair allocation count
   - Define max epairs (e.g., 200 or configurable)
   - When at 80% capacity, log warning
   - When at 100% capacity, reject new jails with clear error
   - Expose epair usage via metrics (if available)
6. Run npm run build

## Completion

8. Commit:
   git add -A
   git commit -m "fix(nan-f183): add epair limit monitoring and backpressure

   - Track epair allocation count
   - Warn at 80% capacity
   - Reject new jails at 100% capacity
   - Expose epair metrics

   Closes nan-f183"

9. Close: tk add-note nan-f183 "Added epair limits. Modified: jail-runtime.js." && tk close nan-f183
10. Push and cleanup:
    git push -u origin ticket/nan-f183
    cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-f183

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

### nan-z5qe: Add concurrent jail limit enforcement

```
You are implementing ticket nan-z5qe for the NanoClaw FreeBSD jail runtime.

## Prerequisites Check

BEFORE starting, verify dependency is closed:
  tk show nan-whvd  # must be closed

If dependency is still open, STOP and report.

## Setup

1. Read the ticket: tk show nan-z5qe
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-z5qe -b ticket/nan-z5qe
   cd /tmp/nanoclaw-nan-z5qe
3. Merge ticket/nan-whvd branch
4. Mark in progress: tk start nan-z5qe

## Task Context
Scalability fix: No backpressure when too many jails spawn. Flash crowds exhaust resources.

Key files: index.ts, group-queue.ts

Solution: Enforce concurrent jail limit, queue excess requests.

## Implementation

4. Read index.ts and group-queue.ts
5. Implement jail limit:
   - Define max concurrent jails (e.g., 50 or configurable)
   - Track active jail count
   - Queue new requests when at capacity
   - Process queued requests as jails complete
   - Return meaningful error if queue is full
6. Run npm run build

## Completion

8. Commit:
   git add -A
   git commit -m "fix(nan-z5qe): add concurrent jail limit enforcement

   - Define max concurrent jails
   - Queue excess requests
   - Apply backpressure on flash crowds
   - Prevent resource exhaustion

   Closes nan-z5qe"

9. Close: tk add-note nan-z5qe "Added jail limits. Modified: index.ts, group-queue.ts." && tk close nan-z5qe
10. Push and cleanup:
    git push -u origin ticket/nan-z5qe
    cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-z5qe

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

### nan-bsv4: Add inter-jail network isolation

```
You are implementing ticket nan-bsv4 for the NanoClaw FreeBSD jail runtime.

## Prerequisites Check

BEFORE starting, verify dependency is closed:
  tk show nan-whvd  # must be closed

If dependency is still open, STOP and report.

## Setup

1. Read the ticket: tk show nan-bsv4
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-bsv4 -b ticket/nan-bsv4
   cd /tmp/nanoclaw-nan-bsv4
3. Merge ticket/nan-whvd branch
4. Mark in progress: tk start nan-bsv4

## Task Context
Security fix: With per-jail IPs, need to ensure jails cannot communicate with each other.

Key files: pf-nanoclaw.conf, jail-runtime.js

Solution: Add pf rules blocking inter-jail traffic on 10.99.x.x network.

## Implementation

4. Read pf-nanoclaw.conf
5. Add inter-jail blocking rules:
   - Block all traffic from 10.99.0.0/24 to 10.99.0.0/24
   - Allow only jail -> host (10.99.N.2 -> 10.99.N.1)
   - Allow only outbound to external networks
6. Test: verify jail A cannot ping jail B
7. Run npm run build

## Completion

8. Commit:
   git add -A
   git commit -m "fix(nan-bsv4): add inter-jail network isolation

   - Block all traffic within 10.99.0.0/24 except to host gateway
   - Prevent jails from communicating with each other
   - Defense in depth for multi-tenant isolation

   Closes nan-bsv4"

9. Close: tk add-note nan-bsv4 "Added inter-jail isolation. Modified: pf-nanoclaw.conf." && tk close nan-bsv4
10. Push and cleanup:
    git push -u origin ticket/nan-bsv4
    cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-bsv4

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

---

## Execution Order Summary

1. **Immediately**: nan-fmb6, nan-1u2t (parallel)
2. **After Phase 1 & 2**: nan-whvd
3. **After nan-whvd**: nan-f183, nan-z5qe, nan-bsv4 (parallel)
