# Phase 2: Jail Hardening

**Priority**: P1 -- high severity security gaps
**Depends on**: Phase 1 (Critical Security Fixes)
**Rationale**: Missing jail.conf parameters create isolation bypass vectors. The `cleanupByJailName()` bug causes orphan cleanup to target wrong datasets. Missing Docker parity features (.env shadow, global mount) affect correctness and security.

---

## Stage 2A: Add Missing jail.conf Parameters

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p2a` |
| **Title** | Add missing jail.conf parameters (exec.clean, children.max=0, SysV IPC, etc.) |
| **Priority** | P1 |
| **Tags** | `nanoclaw`, `phase-2`, `security`, `jail-hardening` |
| **Files** | `src/jail/lifecycle.ts` |
| **Dependencies** | Phase 1 complete |
| **Effort** | ~15 lines |

### Context

The FreeBSD sysadmin report (Section 1, "Jail Configuration Security") identified that the generated jail.conf in `src/jail/lifecycle.ts` (lines 330-340) is missing critical isolation parameters. The current jail.conf template contains only:

```
path, host.hostname, persist, enforce_statfs = 2, mount.devfs,
devfs_ruleset = 10, securelevel = 3, <network config>
```

The following parameters are absent:

- **`exec.clean`** (sysadmin report Section 1; also Section 5 "Process Isolation"): Without this, environment variables from the host Node.js process leak into the jail when `jail -c` runs. The sysadmin report calls this "critical" because sensitive host environment variables become visible inside the jail.
- **`children.max = 0`**: A jail could theoretically create child jails. The sysadmin report notes the default may allow children depending on host sysctl settings.
- **`allow.raw_sockets = 0`**: Default is 0 but should be explicit. The setup scripts use `allow.raw_sockets` during template build but the production jail does not explicitly deny it.
- **`allow.mount = 0`**: Must be explicitly denied to prevent jail mount operations.
- **`allow.set_hostname = 0`**: Must be explicitly denied.
- **`allow.sysvipc = 0`**: SysV IPC between jails and the host is a known isolation bypass vector.
- **`allow.chflags = 0`**: Could allow modifying file flags.
- **`sysvshm = new`**, **`sysvmsg = new`**, **`sysvsem = new`**: Without these, the jail inherits the host's SysV IPC namespace. Setting `new` gives each jail its own isolated IPC namespace (FreeBSD 12+).

The SRE report (Section 3.2) corroborates by noting that `exec.clean` is not set and `spawnInJail()` does not clean the environment.

### Developer Prompt

```
Read `refinement/03252026/SHARED_INSTRUCTIONS.md` first.

## Ticket nc-p2a: Add Missing jail.conf Parameters

### Objective

Add missing security isolation parameters to the jail.conf template generated in `src/jail/lifecycle.ts`.

### Steps

1. Read `src/jail/lifecycle.ts`. Locate the jail.conf template string at lines 330-340. It currently looks like:

   ```typescript
   const confContent = `${jailName} {
     path = "${jailPath}";
     host.hostname = "${jailName}";
     persist;
     enforce_statfs = 2;
     mount.devfs;
     devfs_ruleset = 10;
     securelevel = 3;
   ${networkConfig}
   }
   `;
   ```

2. Add the following parameters AFTER the `securelevel = 3;` line and BEFORE the `${networkConfig}` line:

   ```
     exec.clean;
     children.max = 0;
     allow.raw_sockets = 0;
     allow.mount = 0;
     allow.set_hostname = 0;
     allow.sysvipc = 0;
     allow.chflags = 0;
     sysvshm = new;
     sysvmsg = new;
     sysvsem = new;
   ```

   Each line must be indented with 2 spaces to match the existing formatting of the jail.conf block.

3. The resulting jail.conf template should be:

   ```typescript
   const confContent = `${jailName} {
     path = "${jailPath}";
     host.hostname = "${jailName}";
     persist;
     enforce_statfs = 2;
     mount.devfs;
     devfs_ruleset = 10;
     securelevel = 3;
     exec.clean;
     children.max = 0;
     allow.raw_sockets = 0;
     allow.mount = 0;
     allow.set_hostname = 0;
     allow.sysvipc = 0;
     allow.chflags = 0;
     sysvshm = new;
     sysvmsg = new;
     sysvsem = new;
   ${networkConfig}
   }
   `;
   ```

4. Run `npm test` to verify all existing tests pass. The jail-runtime tests mock `jail -c` so the new parameters should not affect test behavior.

5. Run `npx tsc --noEmit` to verify TypeScript compiles.

6. Run `npm run lint` to verify linting passes.

7. Run `npm run format:check` and fix any formatting issues.

### Constraints

- Only modify `src/jail/lifecycle.ts`.
- Only modify the jail.conf template string. Do not change any other logic.
- Do not add comments inside the jail.conf template string (jail.conf uses `#` comments which would work, but keep it clean -- the parameters are self-documenting).

Report IMPLEMENTATION_COMPLETE when done.
```

### QA Prompt

```
Read `refinement/03252026/SHARED_INSTRUCTIONS.md` first.

## QA for nc-p2a: Add Missing jail.conf Parameters

You are validating that the jail.conf template in `src/jail/lifecycle.ts` now includes all required security isolation parameters. Do NOT modify any files.

### Baseline Checks

[ ] TypeScript compiles: `npx tsc --noEmit`
[ ] All tests pass: `npm test`
[ ] Lint passes: `npm run lint`
[ ] Format check passes: `npm run format:check`
[ ] No unintended file changes: `git diff --stat` shows only `src/jail/lifecycle.ts`
[ ] No secrets or credentials in diff: `git diff` does not contain API keys, tokens, passwords

### Ticket-Specific Checks

[ ] **exec.clean present**: Read `src/jail/lifecycle.ts` and verify the jail.conf template string contains `exec.clean;`
[ ] **children.max present**: Verify the template contains `children.max = 0;`
[ ] **allow.raw_sockets present**: Verify the template contains `allow.raw_sockets = 0;`
[ ] **allow.mount present**: Verify the template contains `allow.mount = 0;`
[ ] **allow.set_hostname present**: Verify the template contains `allow.set_hostname = 0;`
[ ] **allow.sysvipc present**: Verify the template contains `allow.sysvipc = 0;`
[ ] **allow.chflags present**: Verify the template contains `allow.chflags = 0;`
[ ] **sysvshm present**: Verify the template contains `sysvshm = new;`
[ ] **sysvmsg present**: Verify the template contains `sysvmsg = new;`
[ ] **sysvsem present**: Verify the template contains `sysvsem = new;`
[ ] **Formatting consistent**: All new lines are indented with 2 spaces, matching existing lines in the template.
[ ] **No other jail.conf changes**: The existing parameters (path, host.hostname, persist, enforce_statfs, mount.devfs, devfs_ruleset, securelevel) are unchanged.
[ ] **Network config preserved**: `${networkConfig}` is still present and in the correct position (after all static parameters, before the closing `}`).

Report QA_PASS or QA_FAIL with per-check results.
```

---

## Stage 2B: Fix cleanupByJailName() groupId Derivation

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p2b` |
| **Title** | Fix cleanupByJailName() groupId derivation |
| **Priority** | P1 |
| **Tags** | `nanoclaw`, `phase-2`, `bug`, `cleanup` |
| **Files** | `src/jail/lifecycle.ts` |
| **Dependencies** | Phase 1 complete |
| **Effort** | ~5 lines |

### Context

The SRE report (Section 3.2, "Concern -- `cleanupByJailName()` derives groupId incorrectly") identified a bug in `cleanupByJailName()` at `src/jail/lifecycle.ts:629-632`.

The current code:

```typescript
export async function cleanupByJailName(jailName: string): Promise<void> {
  const groupId = jailName.replace(/^nanoclaw_/, '');
  await cleanupJail(groupId);
}
```

The problem: `getJailName()` (line 69-71) generates jail names as `nanoclaw_${sanitizeJailName(groupId)}` where `sanitizeJailName()` (lines 50-66) produces `${sanitized}_${hash}`. So a jail name like `nanoclaw_mygroup_abc123` means the original groupId was `mygroup`, but `cleanupByJailName` strips only the `nanoclaw_` prefix and passes `mygroup_abc123` as the groupId.

When `cleanupJail()` receives `mygroup_abc123`, it calls `getJailName('mygroup_abc123')` which produces `nanoclaw_mygroup_abc123_<newhash>` -- a DIFFERENT jail name than the one being cleaned up. This means:

1. The ZFS dataset path will be wrong (targeting a non-existent dataset).
2. The fstab/conf file paths will be wrong.
3. Nullfs mount discovery (lines 450-473) partially mitigates this since it checks `mount -t nullfs` output, but only if there are active mounts.
4. The `activeJails` set and `jailTokens` map use groupId as the key, so token revocation and active tracking will also fail.

This function is called by `cleanupOrphans()` and `cleanupAllJails()` in `src/jail/cleanup.ts` (lines 164-183, 190-218), making it the primary code path for orphan and shutdown cleanup.

The fix must make `cleanupByJailName()` work correctly by passing the jail name directly to the cleanup logic rather than trying to reverse-derive a groupId. Since `cleanupJail()` needs a groupId to call `getJailName()` internally, the cleanest fix is to have `cleanupByJailName()` bypass that derivation and operate on the jail name directly.

### Developer Prompt

```
Read `refinement/03252026/SHARED_INSTRUCTIONS.md` first.

## Ticket nc-p2b: Fix cleanupByJailName() groupId Derivation

### Objective

Fix the `cleanupByJailName()` function in `src/jail/lifecycle.ts` so that orphan and shutdown cleanup correctly targets the right jail.

### Background

The bug: `cleanupByJailName()` at line 629-632 strips the `nanoclaw_` prefix from the jail name and passes the remainder as a groupId to `cleanupJail()`. But `cleanupJail()` calls `getJailName(groupId)` which re-applies `sanitizeJailName()` (adding a hash suffix), producing a different jail name than the one being cleaned up.

Example:
- Jail name: `nanoclaw_mygroup_abc123`
- `cleanupByJailName` derives groupId = `mygroup_abc123`
- `cleanupJail('mygroup_abc123')` calls `getJailName('mygroup_abc123')` = `nanoclaw_mygroup_abc123_<different_hash>`
- Wrong jail targeted.

### Steps

1. Read `src/jail/lifecycle.ts`. Understand the relationship between:
   - `sanitizeJailName(groupId)` (lines 50-66): returns `${sanitized}_${hash}`
   - `getJailName(groupId)` (lines 69-71): returns `nanoclaw_${sanitizeJailName(groupId)}`
   - `cleanupJail(groupId)` (lines 435-622): uses `getJailName(groupId)` to derive paths
   - `cleanupByJailName(jailName)` (lines 629-632): current buggy implementation

2. Also read `src/jail/cleanup.ts` to confirm `cleanupByJailName()` is called from `cleanupOrphans()` (line 168) and `cleanupAllJails()` (line 205) with full jail names from `jls -N`.

3. Modify `cleanupByJailName()` to operate directly with the jail name instead of trying to reverse-derive a groupId. The function should:

   a. Use the `jailName` parameter directly for path derivation (dataset, jailPath, fstabPath, confPath) instead of going through `getJailName()`.
   b. Still perform the same cleanup steps as `cleanupJail()`: stop jail, release epair, unmount devfs, unmount nullfs, destroy ZFS dataset, remove fstab, remove conf, revoke token, update tracking.

   The recommended approach: refactor to use the jailName directly for path computation. Replace the current implementation with:

   ```typescript
   export async function cleanupByJailName(jailName: string): Promise<void> {
     // Derive paths directly from the jail name (bypassing getJailName re-hashing)
     const dataset = `${JAIL_CONFIG.jailsDataset}/${jailName}`;
     const jailPath = path.join(JAIL_CONFIG.jailsPath, jailName);
     const fstabPath = path.join(JAIL_CONFIG.jailsPath, `${jailName}.fstab`);
     const confPath = path.join(JAIL_CONFIG.jailsPath, `${jailName}.conf`);
     const sudoExec = getSudoExec();

     logger.info({ jailName }, 'Cleaning up jail by name (orphan/shutdown path)');
     logCleanupAudit('CLEANUP_START', jailName, 'INFO');

     // Discover nullfs mounts for this jail
     let mounts: JailMount[] = [];
     try {
       const mountOutput = execFileSync('mount', ['-t', 'nullfs'], {
         encoding: 'utf-8',
         stdio: ['pipe', 'pipe', 'pipe'],
       });
       mounts = mountOutput
         .split('\n')
         .filter((line) => line.includes(jailPath))
         .map((line) => {
           const match = line.match(/^(.+?) on (.+?) \(/);
           if (!match) return null;
           return {
             hostPath: match[1],
             jailPath: match[2].replace(jailPath, ''),
             readonly: false,
           };
         })
         .filter((m): m is JailMount => m !== null);
     } catch {
       /* continue with empty list */
     }

     const errors: Error[] = [];

     try {
       // Stop the jail if running
       if (isJailRunning(jailName)) {
         try {
           await sudoExec(['jail', '-r', jailName], { timeout: JAIL_STOP_TIMEOUT });
           logCleanupAudit('STOP_JAIL', jailName, 'SUCCESS');
         } catch (error) {
           logCleanupAudit('STOP_JAIL', jailName, 'FAILED', error);
           errors.push(error as Error);
         }
       }

       // Unmount devfs
       try {
         await sudoExec(['umount', '-f', path.join(jailPath, 'dev')]);
       } catch {
         // Expected if not mounted
       }

       // Unmount nullfs (reverse order)
       for (let i = mounts.length - 1; i >= 0; i--) {
         const mount = mounts[i];
         const targetPath = path.join(jailPath, mount.jailPath);
         try {
           await sudoExec(['umount', '-f', targetPath]);
         } catch (error) {
           errors.push(error as Error);
         }
       }

       // Destroy ZFS dataset
       if (datasetExists(dataset)) {
         try {
           await sudoExec(['zfs', 'destroy', '-f', '-r', dataset]);
           logCleanupAudit('DESTROY_DATASET', jailName, 'SUCCESS');
         } catch (error) {
           logCleanupAudit('DESTROY_DATASET', jailName, 'FAILED', error);
           errors.push(error as Error);
         }
       }

       // Remove fstab and conf files
       for (const filePath of [fstabPath, confPath]) {
         if (fs.existsSync(filePath)) {
           try {
             fs.unlinkSync(filePath);
           } catch (error) {
             errors.push(error as Error);
           }
         }
       }
     } catch (unexpectedError) {
       logCleanupAudit('CLEANUP_UNEXPECTED_ERROR', jailName, 'FAILED', unexpectedError);
       errors.push(unexpectedError as Error);
     }

     if (errors.length > 0) {
       logger.warn({ jailName, errorCount: errors.length }, 'cleanupByJailName completed with errors');
       logCleanupAudit('CLEANUP_END', jailName, 'PARTIAL');
     } else {
       logger.info({ jailName }, 'cleanupByJailName completed successfully');
       logCleanupAudit('CLEANUP_END', jailName, 'SUCCESS');
     }
   }
   ```

   Note: This function does NOT need to handle epair release, rctl removal, or token revocation because those are keyed by groupId which is unknown in the orphan cleanup path. The epair cleanup is handled separately by `cleanupOrphanEpairs()` in `cleanup.ts` (called after `cleanupByJailName`). Token revocation for tracked jails happens via `cleanupJail()` which is used for normal (non-orphan) teardown.

4. Also fix `trackActiveJail()` at line 660-664 which has the same reverse-derivation bug:

   ```typescript
   export function trackActiveJail(jailName: string): void {
     const groupId = jailName.replace(/^nanoclaw_/, '');
     activeJails.add(groupId);
   ```

   This function is less critical (it just adds to the tracking set) but should be aware that the derived "groupId" is actually `${sanitized}_${hash}`, not the original groupId. Since `trackActiveJail` is only used during orphan detection (to prevent cleaning up active jails), and `isActiveJail` checks using the real groupId, there is a mismatch. However, changing this would require a broader refactor. For now, add a comment documenting the limitation:

   ```typescript
   export function trackActiveJail(jailName: string): void {
     // Note: This derives an approximate groupId from the jail name.
     // It will not match the original groupId exactly (due to hash suffix),
     // but this is acceptable because trackActiveJail is only used during
     // startup orphan detection where no real groupIds are tracked yet.
     const groupId = jailName.replace(/^nanoclaw_/, '');
     activeJails.add(groupId);
     logger.debug({ jailName, groupId }, 'Tracked active jail');
   }
   ```

5. Ensure the `JAIL_STOP_TIMEOUT` import is available (it should already be imported at line 12).

6. Run `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run format:check`.

### Constraints

- Only modify `src/jail/lifecycle.ts`.
- Do not change `cleanupJail()` -- it works correctly for normal (non-orphan) teardown where the real groupId is known.
- Do not change `cleanup.ts` -- the callers are correct.

Report IMPLEMENTATION_COMPLETE when done.
```

### QA Prompt

```
Read `refinement/03252026/SHARED_INSTRUCTIONS.md` first.

## QA for nc-p2b: Fix cleanupByJailName() groupId Derivation

You are validating that `cleanupByJailName()` in `src/jail/lifecycle.ts` no longer derives paths via `getJailName()` re-hashing. Do NOT modify any files.

### Baseline Checks

[ ] TypeScript compiles: `npx tsc --noEmit`
[ ] All tests pass: `npm test`
[ ] Lint passes: `npm run lint`
[ ] Format check passes: `npm run format:check`
[ ] No unintended file changes: `git diff --stat` shows only `src/jail/lifecycle.ts`
[ ] No secrets or credentials in diff: `git diff` does not contain API keys, tokens, passwords

### Ticket-Specific Checks

[ ] **No re-hashing**: Read `src/jail/lifecycle.ts` and verify that `cleanupByJailName()` does NOT call `cleanupJail()` with a derived groupId, and does NOT call `getJailName()`.
[ ] **Direct path derivation**: Verify that `cleanupByJailName()` constructs the ZFS dataset path, jailPath, fstabPath, and confPath directly from the `jailName` parameter using `JAIL_CONFIG.jailsDataset` and `JAIL_CONFIG.jailsPath`.
[ ] **Jail stop**: Verify that `cleanupByJailName()` checks `isJailRunning(jailName)` and stops the jail with `jail -r`.
[ ] **Mount discovery**: Verify that `cleanupByJailName()` discovers nullfs mounts by inspecting `mount -t nullfs` output filtered by the jail path.
[ ] **Unmount devfs**: Verify the function unmounts `${jailPath}/dev`.
[ ] **Unmount nullfs**: Verify the function unmounts discovered nullfs mounts in reverse order.
[ ] **ZFS destroy**: Verify the function checks `datasetExists(dataset)` and destroys it with `zfs destroy -f -r`.
[ ] **File cleanup**: Verify the function removes fstab and conf files if they exist.
[ ] **Audit logging**: Verify the function calls `logCleanupAudit()` for start, stop, destroy, and end operations.
[ ] **Error collection**: Verify the function collects errors without short-circuiting (continues cleanup even if one step fails).
[ ] **cleanupJail unchanged**: Verify that `cleanupJail()` is NOT modified -- it should still work via `getJailName(groupId)` for normal teardown.
[ ] **trackActiveJail comment**: Verify that `trackActiveJail()` has a comment documenting the limitation of the reverse-derivation approach.

Report QA_PASS or QA_FAIL with per-check results.
```

---

## Stage 2C: Add .env Shadowing in Jail Runner

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p2c` |
| **Title** | Add .env shadowing in jail runner |
| **Priority** | P1 |
| **Tags** | `nanoclaw`, `phase-2`, `security`, `parity` |
| **Files** | `src/jail/runner.ts`, `src/jail/mounts.ts`, `src/jail/types.ts` |
| **Dependencies** | Phase 1 complete |
| **Effort** | ~10 lines |

### Context

The PM report (Section 6.2, gap #2) and Docker-vs-Jails comparison (Section 6.1, ".env shadow mount" row) identify that the Docker runner shadows the `.env` file but the jail runner does not.

In the Docker runner (`src/container-runner.ts` lines 67-76), when the main group mounts the project root read-only, a second mount of `/dev/null` is placed over `/workspace/project/.env` to prevent agents from reading secrets:

```typescript
// Shadow .env so the agent cannot read secrets from the mounted project root.
// Credentials are injected by the credential proxy, never exposed to containers.
const envFile = path.join(projectRoot, '.env');
if (fs.existsSync(envFile)) {
  mounts.push({
    hostPath: '/dev/null',
    containerPath: '/workspace/project/.env',
    readonly: true,
  });
}
```

In the jail runner (`src/jail/runner.ts` lines 35-123, the `buildJailMountPaths()` function), no equivalent shadowing exists. The project root is mounted read-only for the main group (line 116), but `.env` is visible and readable inside the jail at `/workspace/project/.env`. Although it is read-only (cannot be modified), the agent can read secrets like API keys, OAuth tokens, and other credentials stored in `.env`.

The jail runner comment at line 34 even acknowledges the gap: "Unlike Docker mounts, this doesn't include /dev/null tricks or file masking."

The fix must add an `.env` shadow mount when the project is mounted for the main group. Since nullfs cannot mount `/dev/null` over a file (nullfs operates on directories), the approach for jails is to create an empty temporary file and mount it over the `.env` location inside the jail. Alternatively, after jail creation and before agent execution, the `.env` file can be overwritten with an empty file inside the jail root (since the project is mounted read-only from the host perspective, but we can create a file at the mount point before mounting).

The cleanest approach: add an `envShadowPath` field to `JailMountPaths`, create an empty temp file on the host, and mount it read-only over the `.env` path inside the jail. The `buildJailMounts()` function in `mounts.ts` will add this mount AFTER the project mount (mount order matters for nullfs overlays).

### Developer Prompt

```
Read `refinement/03252026/SHARED_INSTRUCTIONS.md` first.

## Ticket nc-p2c: Add .env Shadowing in Jail Runner

### Objective

Prevent jail agents from reading the `.env` file by shadowing it with an empty file, matching the Docker runner's behavior.

### Steps

1. Read `src/jail/runner.ts`, `src/jail/mounts.ts`, `src/jail/types.ts`, and `src/jail/config.ts`. Understand how mount paths are built and how `JAIL_MOUNT_LAYOUT` defines the jail-side paths.

2. In `src/jail/runner.ts`, modify the `buildJailMountPaths()` function. After line 116 where `projectPath` is set (`projectPath: isMain ? projectRoot : null,`), add logic to detect and shadow `.env`:

   After the `return` statement's `projectPath` line (inside the return object), add a new field `envShadowPath`. Before the return, add the logic:

   ```typescript
   // Shadow .env to prevent agent from reading secrets (matches Docker runner behavior)
   let envShadowPath: string | null = null;
   if (isMain) {
     const envFile = path.join(projectRoot, '.env');
     if (fs.existsSync(envFile)) {
       envShadowPath = '/dev/null';
     }
   }
   ```

   Place this block before the `return {` statement (before line 115). Then add `envShadowPath,` to the returned object.

3. In `src/jail/types.ts`, add `envShadowPath` to the `JailMountPaths` interface:

   ```typescript
   export interface JailMountPaths {
     projectPath: string | null;
     groupPath: string;
     ipcPath: string;
     claudeSessionPath: string;
     agentRunnerPath: string;
     envShadowPath?: string | null;
     additionalMounts?: Array<{
       hostPath: string;
       jailPath: string;
       readonly: boolean;
     }>;
   }
   ```

4. In `src/jail/mounts.ts`, modify the `buildJailMounts()` function. After the project mount block (lines 72-78), add the `.env` shadow mount:

   ```typescript
   if (paths.envShadowPath && paths.projectPath) {
     mounts.push({
       hostPath: paths.envShadowPath,
       jailPath: `${JAIL_MOUNT_LAYOUT.project}/.env`,
       readonly: true,
     });
   }
   ```

   This mount MUST come after the project mount. nullfs mounts are applied in order, so the shadow mount will overlay the `.env` file within the already-mounted project directory.

5. Run `npm test` to verify all existing tests pass.

6. Run `npx tsc --noEmit`, `npm run lint`, `npm run format:check`.

### Important Notes

- On FreeBSD, mounting `/dev/null` via nullfs over a file path works because nullfs can mount any filesystem object. The `mount_nullfs -o ro /dev/null <target>` command will make the target path appear as an empty device node, effectively hiding the real `.env` content.
- The shadow mount only applies when `isMain` is true (only main gets the project mount) AND a `.env` file actually exists on the host.
- Non-main groups do not get the project mount at all, so they cannot access `.env` regardless.

### Constraints

- Only modify `src/jail/runner.ts`, `src/jail/mounts.ts`, and `src/jail/types.ts`.
- Do not modify `src/container-runner.ts` (Docker runner).
- Do not change any existing mount logic -- only add the shadow mount.

Report IMPLEMENTATION_COMPLETE when done.
```

### QA Prompt

```
Read `refinement/03252026/SHARED_INSTRUCTIONS.md` first.

## QA for nc-p2c: Add .env Shadowing in Jail Runner

You are validating that the jail runner now shadows the `.env` file to prevent agents from reading secrets. Do NOT modify any files.

### Baseline Checks

[ ] TypeScript compiles: `npx tsc --noEmit`
[ ] All tests pass: `npm test`
[ ] Lint passes: `npm run lint`
[ ] Format check passes: `npm run format:check`
[ ] No unintended file changes: `git diff --stat` shows only `src/jail/runner.ts`, `src/jail/mounts.ts`, and `src/jail/types.ts`
[ ] No secrets or credentials in diff: `git diff` does not contain API keys, tokens, passwords

### Ticket-Specific Checks

[ ] **JailMountPaths updated**: Read `src/jail/types.ts` and verify the `JailMountPaths` interface includes an `envShadowPath` field typed as `string | null` or optional.
[ ] **Runner detects .env**: Read `src/jail/runner.ts` and verify `buildJailMountPaths()` checks for `.env` existence via `fs.existsSync()` when `isMain` is true.
[ ] **Runner sets envShadowPath**: Verify `buildJailMountPaths()` sets `envShadowPath` to `'/dev/null'` when `.env` exists and `isMain` is true.
[ ] **Runner sets null when no .env**: Verify `envShadowPath` is `null` when `.env` does not exist or `isMain` is false.
[ ] **Mount added in buildJailMounts**: Read `src/jail/mounts.ts` and verify `buildJailMounts()` adds a shadow mount when `paths.envShadowPath` is truthy and `paths.projectPath` is truthy.
[ ] **Shadow mount path correct**: Verify the shadow mount's `jailPath` is `${JAIL_MOUNT_LAYOUT.project}/.env` (which resolves to `/workspace/project/.env`).
[ ] **Shadow mount is read-only**: Verify the shadow mount has `readonly: true`.
[ ] **Shadow mount order**: Verify the shadow mount is added AFTER the project mount in the `mounts` array (mount order matters for overlay behavior).
[ ] **No Docker runner changes**: Verify `src/container-runner.ts` is NOT modified.
[ ] **Comment explains purpose**: Verify there is a comment explaining the `.env` shadow (matching the Docker runner's comment pattern about preventing agents from reading secrets).

Report QA_PASS or QA_FAIL with per-check results.
```

---

## Stage 2D: Add Global Memory Mount for Non-Main Groups in Jail Runner

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p2d` |
| **Title** | Add global memory mount for non-main groups in jail runner |
| **Priority** | P1 |
| **Tags** | `nanoclaw`, `phase-2`, `parity`, `feature` |
| **Files** | `src/jail/runner.ts`, `src/jail/mounts.ts`, `src/jail/types.ts`, `src/jail/config.ts` |
| **Dependencies** | Phase 1 complete |
| **Effort** | ~10 lines |

### Context

The PM report (Section 6.2, gap #1) identifies that the Docker runner mounts a global memory directory for non-main groups but the jail runner does not.

In the Docker runner (`src/container-runner.ts` lines 92-101), non-main groups get a read-only mount of `groups/global/` at `/workspace/global`:

```typescript
// Global memory directory (read-only for non-main)
// Only directory mounts are supported, not file mounts
const globalDir = path.join(GROUPS_DIR, 'global');
if (fs.existsSync(globalDir)) {
  mounts.push({
    hostPath: globalDir,
    containerPath: '/workspace/global',
    readonly: true,
  });
}
```

The `GROUPS_DIR` is defined in `src/config.ts` (line 48) as `path.resolve(PROJECT_ROOT, 'groups')`, so the global directory is `<project_root>/groups/global/`.

This global directory contains a shared `CLAUDE.md` that all agents should be able to read. It provides cross-group context and shared instructions. Without this mount, non-main group agents in jails cannot read global memory, breaking the shared knowledge model.

In the jail runner (`src/jail/runner.ts`), the `buildJailMountPaths()` function (lines 35-123) does not include any global mount. The `JailMountPaths` type in `src/jail/types.ts` has no field for it, and `buildJailMounts()` in `src/jail/mounts.ts` has no logic to handle it.

### Developer Prompt

```
Read `refinement/03252026/SHARED_INSTRUCTIONS.md` first.

## Ticket nc-p2d: Add Global Memory Mount for Non-Main Groups

### Objective

Add a read-only mount of the global memory directory (`groups/global/`) for non-main group jails, matching the Docker runner's behavior.

### Steps

1. Read `src/jail/runner.ts`, `src/jail/mounts.ts`, `src/jail/types.ts`, and `src/jail/config.ts`.

2. In `src/jail/config.ts`, add a new entry to `JAIL_MOUNT_LAYOUT` for the global memory directory:

   ```typescript
   export const JAIL_MOUNT_LAYOUT = {
     project: '/workspace/project',
     group: '/workspace/group',
     global: '/workspace/global',
     ipc: '/workspace/ipc',
     claudeSession: '/home/node/.claude',
     agentRunner: '/app/src',
   };
   ```

   Add `global: '/workspace/global',` after the `group` entry.

3. In `src/jail/types.ts`, add `globalPath` to the `JailMountPaths` interface:

   ```typescript
   export interface JailMountPaths {
     projectPath: string | null;
     groupPath: string;
     globalPath?: string | null;
     ipcPath: string;
     claudeSessionPath: string;
     agentRunnerPath: string;
     envShadowPath?: string | null;  // Added in nc-p2c if run after
     additionalMounts?: Array<{
       hostPath: string;
       jailPath: string;
       readonly: boolean;
     }>;
   }
   ```

   Note: If nc-p2c has not been applied yet, `envShadowPath` will not be present. Add `globalPath` regardless.

4. In `src/jail/runner.ts`, modify `buildJailMountPaths()` to set `globalPath` for non-main groups. Add the import for `GROUPS_DIR` from `../config.js` at the top of the file:

   ```typescript
   import {
     CONTAINER_TIMEOUT,
     CREDENTIAL_PROXY_PORT,
     DATA_DIR,
     GROUPS_DIR,
     TIMEZONE,
   } from '../config.js';
   ```

   Then, before the `return` statement, add:

   ```typescript
   // Global memory directory (read-only for non-main groups)
   // Matches Docker runner behavior: non-main groups can read shared CLAUDE.md
   let globalPath: string | null = null;
   if (!isMain) {
     const globalDir = path.join(GROUPS_DIR, 'global');
     if (fs.existsSync(globalDir)) {
       globalPath = globalDir;
     }
   }
   ```

   Add `globalPath,` to the returned object.

5. In `src/jail/mounts.ts`, modify `buildJailMounts()` to add the global mount. After the group mount block (lines 80-86), add:

   ```typescript
   if (paths.globalPath) {
     mounts.push({
       hostPath: paths.globalPath,
       jailPath: JAIL_MOUNT_LAYOUT.global,
       readonly: true,
     });
   }
   ```

   This mount is always read-only -- non-main groups should never modify global memory.

6. Run `npm test` to verify all existing tests pass.

7. Run `npx tsc --noEmit`, `npm run lint`, `npm run format:check`.

### Constraints

- Only modify `src/jail/runner.ts`, `src/jail/mounts.ts`, `src/jail/types.ts`, and `src/jail/config.ts`.
- Do not modify `src/container-runner.ts` (Docker runner).
- The global mount must be read-only.
- The global mount must only be added for non-main groups (main already has the full project mount which includes `groups/global/`).
- The mount must be conditional on the `groups/global/` directory existing (matching Docker runner behavior).

Report IMPLEMENTATION_COMPLETE when done.
```

### QA Prompt

```
Read `refinement/03252026/SHARED_INSTRUCTIONS.md` first.

## QA for nc-p2d: Add Global Memory Mount for Non-Main Groups

You are validating that non-main group jails now get a read-only mount of the global memory directory. Do NOT modify any files.

### Baseline Checks

[ ] TypeScript compiles: `npx tsc --noEmit`
[ ] All tests pass: `npm test`
[ ] Lint passes: `npm run lint`
[ ] Format check passes: `npm run format:check`
[ ] No unintended file changes: `git diff --stat` shows only `src/jail/runner.ts`, `src/jail/mounts.ts`, `src/jail/types.ts`, and `src/jail/config.ts`
[ ] No secrets or credentials in diff: `git diff` does not contain API keys, tokens, passwords

### Ticket-Specific Checks

[ ] **JAIL_MOUNT_LAYOUT updated**: Read `src/jail/config.ts` and verify `JAIL_MOUNT_LAYOUT` includes `global: '/workspace/global'`.
[ ] **JailMountPaths updated**: Read `src/jail/types.ts` and verify the `JailMountPaths` interface includes a `globalPath` field typed as `string | null` or optional.
[ ] **GROUPS_DIR imported**: Read `src/jail/runner.ts` and verify `GROUPS_DIR` is imported from `'../config.js'`.
[ ] **globalPath set for non-main**: Verify `buildJailMountPaths()` sets `globalPath` to the `groups/global/` directory path when `isMain` is false and the directory exists.
[ ] **globalPath null for main**: Verify `globalPath` is `null` when `isMain` is true.
[ ] **globalPath null when dir missing**: Verify `globalPath` is `null` when the `groups/global/` directory does not exist.
[ ] **Mount added in buildJailMounts**: Read `src/jail/mounts.ts` and verify `buildJailMounts()` adds a mount when `paths.globalPath` is truthy.
[ ] **Mount path correct**: Verify the global mount's `jailPath` uses `JAIL_MOUNT_LAYOUT.global` (which should be `/workspace/global`).
[ ] **Mount is read-only**: Verify the global mount has `readonly: true`.
[ ] **No Docker runner changes**: Verify `src/container-runner.ts` is NOT modified.
[ ] **Comment explains purpose**: Verify there is a comment explaining the global memory mount and its relationship to Docker runner parity.

Report QA_PASS or QA_FAIL with per-check results.
```

---

## Phase 2 Integration QA

After all four stages (2A, 2B, 2C, 2D) pass individual QA, run this integration validation on the merged result.

### Integration QA Prompt

```
Read `refinement/03252026/SHARED_INSTRUCTIONS.md` first.

## Phase 2 Integration QA: Jail Hardening

You are validating that all four Phase 2 tickets (nc-p2a, nc-p2b, nc-p2c, nc-p2d) integrate correctly together. Do NOT modify any files.

### Baseline Checks

[ ] TypeScript compiles: `npx tsc --noEmit`
[ ] All tests pass: `npm test`
[ ] Lint passes: `npm run lint`
[ ] Format check passes: `npm run format:check`
[ ] No secrets or credentials in any changed file

### Integration Checks

[ ] **Files changed are as expected**: `git diff --stat` against the Phase 1 merge base shows changes ONLY in:
  - `src/jail/lifecycle.ts` (2A + 2B)
  - `src/jail/runner.ts` (2C + 2D)
  - `src/jail/mounts.ts` (2C + 2D)
  - `src/jail/types.ts` (2C + 2D)
  - `src/jail/config.ts` (2D)

[ ] **jail.conf completeness**: Read `src/jail/lifecycle.ts` and verify the jail.conf template includes ALL of:
  - `path`, `host.hostname`, `persist`, `enforce_statfs = 2`, `mount.devfs`, `devfs_ruleset = 10`, `securelevel = 3` (existing)
  - `exec.clean`, `children.max = 0`, `allow.raw_sockets = 0`, `allow.mount = 0`, `allow.set_hostname = 0`, `allow.sysvipc = 0`, `allow.chflags = 0`, `sysvshm = new`, `sysvmsg = new`, `sysvsem = new` (new from 2A)

[ ] **cleanupByJailName independence**: Verify `cleanupByJailName()` does NOT call `cleanupJail()` or `getJailName()`. It should operate directly on the jail name parameter.

[ ] **Mount ordering for main group**: Read `src/jail/mounts.ts` and trace the mount order for a main group (where `projectPath` is set and `envShadowPath` is set). Verify:
  1. Project mount comes first (read-only)
  2. .env shadow mount comes immediately after project mount (read-only, overlays the project mount)
  3. No global mount (main groups do not get it)
  4. Group, IPC, claude session, agent runner mounts follow

[ ] **Mount ordering for non-main group**: Trace the mount order for a non-main group (where `projectPath` is null, `globalPath` is set). Verify:
  1. No project mount
  2. No .env shadow mount
  3. Group mount present (read-write)
  4. Global mount present (read-only)
  5. IPC, claude session, agent runner mounts follow

[ ] **JailMountPaths interface consistency**: Verify `JailMountPaths` in `src/jail/types.ts` has both `envShadowPath` and `globalPath` fields, and both are optional or nullable.

[ ] **JAIL_MOUNT_LAYOUT consistency**: Verify `JAIL_MOUNT_LAYOUT` in `src/jail/config.ts` includes `global: '/workspace/global'` and all other existing entries are unchanged.

[ ] **No circular dependencies**: Verify that `src/jail/runner.ts` importing `GROUPS_DIR` from `'../config.js'` does not create a circular import chain. Check that `src/config.ts` does not import from `src/jail/`.

[ ] **Docker runner untouched**: Verify `src/container-runner.ts` has NO changes in the diff.

[ ] **Upstream-risk files untouched**: Verify `src/index.ts`, `src/ipc.ts`, `src/router.ts`, `src/config.ts` (not `jail/config.ts`) have NO changes.

Report QA_PASS or QA_FAIL with per-check results.
```
