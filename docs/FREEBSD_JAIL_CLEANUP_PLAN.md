# FreeBSD Jail Support - Repository Cleanup Plan

**Created:** 2026-03-16
**Status:** Planning

## Overview

This document outlines the cleanup tasks for the FreeBSD jail support implementation. The jail runtime is functional, but the repository contains analysis artifacts, incomplete tests, and documentation that needs consolidation.

---

## Files Inventory (FreeBSD Jail Support)

### Core Runtime Files
| File | Status | Action |
|------|--------|--------|
| `jail-runtime.js` | Complete | Keep - core runtime |
| `test-jail-runtime.js` | Incomplete | Complete test suite |
| `src/container-runtime.ts` | Complete | Keep - runtime abstraction |
| `src/container-runner.ts` | Complete | Keep - jail agent execution |
| `src/index.ts` | Complete | Keep - orchestrator integration |

### Configuration Files
| File | Status | Action |
|------|--------|--------|
| `etc/pf-nanoclaw.conf` | Complete | Keep - primary firewall rules |
| `etc/pf-nanoclaw-anchor.conf` | Complete | Review - consolidate with primary |

### Setup Scripts
| File | Status | Action |
|------|--------|--------|
| `scripts/setup-freebsd.sh` | Complete | Keep - bootstrap script |
| `scripts/setup-jail-template.sh` | Complete | Keep - template initialization |

### Documentation
| File | Status | Action |
|------|--------|--------|
| `docs/FREEBSD_JAILS.md` | Complete | Keep - deployment guide |
| `analysis/runtime-interface.md` | Archive | Move to docs/archive/ or delete |
| `analysis/integration-changes.md` | Archive | Move to docs/archive/ or delete |
| `analysis/jail-test-results.md` | Delete | Incomplete tracking file |
| `analysis/sdk-coupling.md` | Review | Check if jail-related |

### Runtime Directories (Not in Git)
| Path | Purpose | Action |
|------|---------|--------|
| `jails/template/` | Base jail template | Verify .gitignore |
| `jails/nanoclaw_*/` | Active jail clones | Verify .gitignore |
| `groups/*/logs/jail-*.log` | Jail operation logs | Verify .gitignore |

---

## Cleanup Tickets

### High Priority

1. **JAIL-CLEANUP-001**: Archive or remove analysis files
   - Move `analysis/runtime-interface.md` to `docs/archive/` or delete
   - Move `analysis/integration-changes.md` to `docs/archive/` or delete
   - Delete `analysis/jail-test-results.md` (incomplete, stale)

2. **JAIL-CLEANUP-002**: Complete test-jail-runtime.js test suite
   - Fill in actual test assertions
   - Run tests and verify all pass
   - Add to CI if applicable

3. **JAIL-CLEANUP-003**: Update .gitignore for jail artifacts
   - Add `jails/` directory (except documented structure)
   - Add jail log patterns `groups/*/logs/jail-*.log`
   - Verify ZFS mount points excluded

### Medium Priority

4. **JAIL-CLEANUP-004**: Consolidate pf configuration documentation
   - Document when to use `pf-nanoclaw.conf` vs `pf-nanoclaw-anchor.conf`
   - Or remove one if redundant

5. **JAIL-CLEANUP-005**: Clean up Git branches ✅ **COMPLETED** (ticket src-jc05)
   - Deleted local and remote branches (all work integrated via PRs/tickets):
     - `phase-2/jail-infrastructure` (was b06d15b)
     - `phase-3/jail-runtime` (was f2ea502)
     - `phase-3/jail-runtime-wiring-fix` (was 0e44dcd)
     - `phase-4/jail-runtime-fixes` (was 51010c3)

6. **JAIL-CLEANUP-006**: Verify FREEBSD_JAILS.md accuracy
   - Compare documentation against actual implementation
   - Update any stale instructions or paths
   - Verify all example commands work

### Low Priority

7. **JAIL-CLEANUP-007**: Add JSDoc comments to jail-runtime.js
   - Document public API functions
   - Add parameter and return type documentation

8. **JAIL-CLEANUP-008**: Create jail runtime architecture diagram
   - Visual diagram of ZFS clone → jail → mounts → network flow
   - Add to FREEBSD_JAILS.md

---

## Execution Order

1. Archive/delete analysis files (quick wins)
2. Update .gitignore (prevents future noise)
3. Complete test suite (ensures stability)
4. Clean up branches (reduces confusion)
5. Documentation updates (ongoing)

---

## Success Criteria

- [ ] No stale analysis files in repository
- [ ] All jail-related files properly documented
- [ ] Test suite runs and passes
- [ ] .gitignore covers all runtime artifacts
- [ ] Git branches cleaned up
- [ ] Documentation matches implementation
