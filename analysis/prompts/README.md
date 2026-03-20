# NanoClaw Jail Runtime — Implementation Prompts

## Overview

This directory contains prompts for implementing cleanup tasks for the FreeBSD jail runtime. Phases 1-5 are complete and have been archived to docs/archive/prompts/.

## Phase Summary

| Phase | Name | Priority | Status | Archived |
|-------|------|----------|--------|----------|
| 1 | Security | P0 (Critical) | ✓ Complete | docs/archive/prompts/ |
| 2 | Reliability | P0 (Critical) | ✓ Complete | docs/archive/prompts/ |
| 3 | Scalability | P1 (High) | ✓ Complete | docs/archive/prompts/ |
| 4 | Observability | P1 (High) | ✓ Complete | docs/archive/prompts/ |
| 5 | Polish | P2/P3 (Medium/Low) | ✓ Complete | docs/archive/prompts/ |
| 6 | Cleanup | P1-P3 (Housekeeping) | In Progress | This directory |

## Current Phase: Phase 6 Cleanup

Phase 6 cleanup tasks are defined in [phase6-cleanup.md](phase6-cleanup.md). These are low-priority housekeeping tasks that improve maintainability and developer experience.

## Archive

Completed phase implementation prompts and code review artifacts have been moved to:
- **Prompts**: docs/archive/prompts/ (phase1-security.md through phase5-polish.md)
- **Reviews**: docs/archive/reviews/ (qa-engineer-review.md, security-engineer-review.md, sre-devops-review.md, staff-engineer-review.md, synthesis.md)
- **Analysis**: docs/archive/ (runtime-interface.md, sdk-coupling.md)
