# NanoClaw Jail Runtime — Implementation Prompts

## Overview

This directory contains prompts for implementing the 36 recommendations from the code review synthesis. Each ticket should run in its own subagent using git worktrees for isolation.

## Phase Summary

| Phase | Name | Priority | Tickets | Dependencies |
|-------|------|----------|---------|--------------|
| 1 | Security | P0 (Critical) | 7 | None |
| 2 | Reliability | P0 (Critical) | 4 | None |
| 3 | Scalability | P1 (High) | 6 | Phase 1, 2 (partial) |
| 4 | Observability | P1 (High) | 4 | None (partial internal deps) |
| 5 | Polish | P2/P3 (Medium/Low) | 15 | Phase 3 (1 ticket) |

## Execution Order

### Parallel Execution Wave 1 (Immediate)

Run all Phase 1, Phase 2, and independent tickets from Phases 3-5:

**Phase 1 - Security (7 tickets)**:
- nan-z19n, nan-z2qc, nan-ugfr, nan-jd7e, nan-pue5, nan-042c, nan-07jw

**Phase 2 - Reliability (4 tickets)**:
- nan-gv4w, nan-8j6g, nan-fucj, nan-79uf

**Phase 3 - Wave 1 (2 tickets)**:
- nan-fmb6, nan-1u2t

**Phase 4 - Wave 1 (3 tickets)**:
- nan-kblq, nan-1tiy, nan-nfd6

**Phase 5 - Wave 1 (14 tickets)**:
- nan-xnfm, nan-cqy5, nan-k05n, nan-vgw5, nan-5b31, nan-jf38, nan-jk4w, nan-o0h5, nan-tu7w, nan-vfsa, nan-570i, nan-82hf, nan-j669, nan-zh1c

**Total Wave 1**: 30 tickets in parallel

### Parallel Execution Wave 2 (After Phase 1 & 2)

**Phase 3 - Wave 2**:
- nan-whvd (depends on: nan-z19n, nan-z2qc, nan-ugfr, nan-gv4w, nan-8j6g)

**Phase 4 - Wave 2**:
- nan-efbx (depends on: nan-1tiy)

### Parallel Execution Wave 3 (After nan-whvd)

**Phase 3 - Wave 3 (3 tickets)**:
- nan-f183, nan-z5qe, nan-bsv4

**Phase 5 - Wave 2 (1 ticket)**:
- nan-s5yk

## Subagent Instructions Template

Each subagent should follow this pattern:

```
1. Read ticket: tk show <ticket-id>
2. Create worktree: git worktree add /tmp/nanoclaw-<ticket-id> -b ticket/<ticket-id>
3. Mark in progress: tk start <ticket-id>
4. Implement changes following ticket acceptance criteria
5. Build: npm run build
6. Commit with message referencing ticket
7. Add note: tk add-note <ticket-id> "<summary>"
8. Close ticket: tk close <ticket-id>
9. Push branch: git push -u origin ticket/<ticket-id>
10. Clean up: git worktree remove /tmp/nanoclaw-<ticket-id>
11. Report: ticket ID, files modified, changes made, status
```

## Monitoring Progress

Check ticket status at any time:

```bash
# Ready tickets (no blocking deps)
tk ready

# Blocked tickets (waiting on deps)
tk blocked

# Recently closed tickets
tk closed --limit=50

# Show specific ticket
tk show <ticket-id>
```

## Dependency Graph

```
Phase 1 (P0)          Phase 2 (P0)
├─ nan-z19n ──┐       ├─ nan-gv4w ──┐
├─ nan-z2qc ──┼───────┤             │
├─ nan-ugfr ──┤       ├─ nan-8j6g ──┼───> nan-whvd (P1)
├─ nan-jd7e   │       ├─ nan-fucj   │           │
├─ nan-pue5   │       └─ nan-79uf   │           │
├─ nan-042c   │                     │           ├──> nan-f183
└─ nan-07jw   └─────────────────────┘           ├──> nan-z5qe
                                                ├──> nan-bsv4
                                                └──> nan-s5yk

Phase 4 (P1)
├─ nan-kblq
├─ nan-1tiy ──────> nan-efbx
└─ nan-nfd6
```

## Files

| File | Description |
|------|-------------|
| [phase1-security.md](phase1-security.md) | Critical security fixes (7 tickets) |
| [phase2-reliability.md](phase2-reliability.md) | Critical reliability fixes (4 tickets) |
| [phase3-scalability.md](phase3-scalability.md) | Scalability improvements (6 tickets) |
| [phase4-observability.md](phase4-observability.md) | Monitoring and logging (4 tickets) |
| [phase5-polish.md](phase5-polish.md) | Documentation and polish (15 tickets) |

## Merging Strategy

After all tickets in a phase are complete:

1. Create integration branch: `git checkout -b integrate/phase-N`
2. Merge all ticket branches into integration branch
3. Run full test suite
4. Resolve any conflicts
5. Create PR for phase

## Quick Reference: All Tickets

### P0 - Critical (Must Fix Before PR)
```
nan-z19n  Route jail API calls through credential proxy
nan-z2qc  Restrict DNS to trusted servers only
nan-ugfr  Add rctl resource limits for jails
nan-jd7e  Create restrictive devfs ruleset
nan-pue5  Add paranoid path validation in mountNullfs
nan-042c  Fix DNS table poisoning vulnerability
nan-07jw  Validate IPC path to prevent path traversal
nan-gv4w  Add file-based epair lock or atomic assignment
nan-8j6g  Implement cleanup retry with error aggregation
nan-fucj  Add ZFS pool capacity check before clone
nan-79uf  Add template snapshot backup (base-backup)
```

### P1 - High (Should Fix Before Production)
```
nan-whvd  Implement per-jail IP allocation
nan-fmb6  Pre-compile TypeScript in template
nan-1u2t  Convert jail-runtime.js to TypeScript
nan-f183  Add epair limit monitoring and backpressure
nan-z5qe  Add concurrent jail limit enforcement
nan-kblq  Add monitoring hooks (health and metrics endpoints)
nan-1tiy  Unify logging (jail-runtime to pino)
nan-efbx  Add request/trace ID correlation
nan-nfd6  Implement log rotation
```

### P2 - Medium
```
nan-bsv4  Add inter-jail network isolation
nan-xnfm  Make network interface configurable
nan-cqy5  Centralize timeout configuration
nan-vgw5  Pin npm package versions in template
nan-5b31  Persist epair assignments for SIGKILL recovery
nan-jf38  Session preservation across NanoClaw restarts
nan-jk4w  Network mode migration path
nan-o0h5  Mount security validation for jail path
nan-tu7w  Dependency injection for unit testing
nan-vfsa  /tmp cleanup to prevent growth
```

### P3 - Low
```
nan-s5yk  Add network isolation integration tests
nan-k05n  Document sudoers requirements
nan-570i  pf table IP refresh automation
nan-82hf  Template setup sudo documentation
nan-j669  Group name sanitization collisions
nan-zh1c  Unify log file naming
```
