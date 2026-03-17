---
id: src-jc07
status: open
deps: []
links: []
created: 2026-03-16T14:30:00Z
type: task
priority: 3
tags: [jail-cleanup, phase6, docs]
---
# Add JSDoc comments to jail-runtime.js

Document public API functions in `jail-runtime.js`:

Functions to document:
- `createJail()` / `createJailWithPaths()`
- `execInJail()` / `spawnInJail()`
- `stopJail()` / `destroyJail()` / `cleanupJail()`
- `createEpair()` / `destroyEpair()`
- `configureJailNetwork()`
- `cleanupOrphans()` / `cleanupAllJails()`
- `ensureJailRuntimeRunning()`

Add parameter types, return values, and usage examples.

