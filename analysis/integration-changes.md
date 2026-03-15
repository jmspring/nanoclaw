# Runtime Integration Changes

Generated: 2026-03-14

---

## Summary

Added multi-runtime support via `NANOCLAW_RUNTIME` environment variable. The orchestrator now supports three runtimes:
- `jail` - FreeBSD jails (native, no Docker required)
- `docker` - Docker containers (Linux default)
- `apple` - Apple containers (macOS default)

Auto-detection uses the OS platform when `NANOCLAW_RUNTIME` is not set.

---

## Files Modified

### 1. `src/container-runtime.ts`

**Lines changed:** ~21

**Changes:**

1. **Added `RuntimeType` type and `getRuntime()` function** (lines 11-20)
   ```typescript
   export type RuntimeType = 'jail' | 'docker' | 'apple';

   export function getRuntime(): RuntimeType {
     const env = process.env.NANOCLAW_RUNTIME?.toLowerCase();
     if (env === 'jail' || env === 'docker' || env === 'apple') return env;
     const platform = os.platform();
     if (platform === 'freebsd') return 'jail';
     if (platform === 'darwin') return 'apple';
     return 'docker';
   }
   ```
   **Why:** Centralized runtime detection. Checks env var first, then auto-detects based on `os.platform()`.

2. **Modified `ensureContainerRuntimeRunning()`** (added 6 lines)
   ```typescript
   const runtime = getRuntime();
   if (runtime === 'jail') {
     logger.info({ runtime }, 'Using FreeBSD jail runtime');
     return;
   }
   ```
   **Why:** Skip Docker health check when using jail runtime. Jail validation happens in `jail-runtime.js` when jails are actually created (checks ZFS template, jail command availability).

3. **Modified `cleanupOrphans()`** (added 4 lines)
   ```typescript
   const runtime = getRuntime();
   if (runtime === 'jail') {
     return;
   }
   ```
   **Why:** Docker-specific cleanup (listing containers by name filter) doesn't apply to jails. Jail orphan cleanup is handled separately via `jail-runtime.js`.

---

### 2. `src/index.ts`

**Lines changed:** ~8

**Changes:**

1. **Added `getRuntime` to imports** (line 29)
   ```typescript
   import {
     cleanupOrphans,
     ensureContainerRuntimeRunning,
     getRuntime,  // Added
     PROXY_BIND_HOST,
   } from './container-runtime.js';
   ```

2. **Made `ensureContainerSystemRunning()` async with runtime dispatch** (lines 463-472)
   ```typescript
   async function ensureContainerSystemRunning(): Promise<void> {
     ensureContainerRuntimeRunning();
     if (getRuntime() === 'jail') {
       // @ts-expect-error jail-runtime.js is untyped
       const jailRuntime = await import('../jail-runtime.js');
       jailRuntime.cleanupOrphans();
     } else {
       cleanupOrphans();
     }
   }
   ```
   **Why:** When runtime is `jail`, dynamically import and call the jail-specific `cleanupOrphans()` which handles:
   - Listing jails with `nanoclaw_` prefix via `jls`
   - Stopping them via `jail -r`
   - Cleaning up leftover ZFS datasets

3. **Added `await` to call site in `main()`** (line 469)
   ```typescript
   await ensureContainerSystemRunning();
   ```
   **Why:** Function is now async due to dynamic import.

---

## Files NOT Modified

### `jail-runtime.js`
No changes needed. Already exports:
- `ensureJailRuntimeRunning()` - validates ZFS template, jail command
- `cleanupOrphans()` - kills orphaned jails, cleans ZFS datasets
- Compatibility aliases (`ensureContainerRuntimeRunning`, etc.)

### `container-runner.ts`
No changes needed yet. Currently spawns Docker containers. Future work will add jail-aware container runner that uses `jail-runtime.js` functions (`createJail`, `execInJail`, `destroyJail`).

---

## Test File Updated

### `src/container-runtime.test.ts`

**Lines changed:** ~11

**Changes:**
Added mock for `os.platform` to return `'linux'` so that `getRuntime()` returns `'docker'` during tests. This ensures Docker-specific tests run with Docker behavior regardless of the host platform (e.g., when tests run on FreeBSD).

```typescript
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    default: { ...actual, platform: () => 'linux' },
    platform: () => 'linux',
  };
});
```

---

## Usage

```bash
# Explicit runtime selection
NANOCLAW_RUNTIME=jail npm run dev    # Use FreeBSD jails
NANOCLAW_RUNTIME=docker npm run dev  # Use Docker
NANOCLAW_RUNTIME=apple npm run dev   # Use Apple containers

# Auto-detection (no env var needed)
# FreeBSD → jail
# macOS → apple
# Linux → docker
```

---

## Total Lines Changed

| File | Lines Added/Modified |
|------|---------------------|
| `src/container-runtime.ts` | ~21 |
| `src/index.ts` | ~9 |
| `src/container-runtime.test.ts` | ~11 (mock os.platform for tests) |
| **Total** | **~41** |

Target was <50 lines in existing TypeScript files. Achieved (30 lines in non-test files).

---

## Next Steps

1. **Container runner integration** - Modify `container-runner.ts` to use `jail-runtime.js` functions when `getRuntime() === 'jail'`
2. **Apple container support** - Implement `apple-runtime.ts` for macOS containers
3. **Testing** - Add runtime-specific test cases
