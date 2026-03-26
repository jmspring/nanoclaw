# Phase 5: CI/CD and Code Quality

**Priority**: P2 -- prevent regressions
**Depends on**: Phase 3 (Operational Hardening)
**Rationale**: 2,920 lines of jail code are never tested in CI. ESLint is not enforced. No build verification step. No security audit. The Maintainer Report (Section 8) and SRE Report (Section 11) independently identified these as the most significant CI gaps.

**Source reports**:
- `reports/maintainer_report.md` Section 8 ("Build System and CI/CD Assessment")
- `reports/sre_report.md` Section 2 ("Build Automation Assessment") and Section 11 ("CI/CD Pipeline Recommendations")

**Current CI pipeline** (`.github/workflows/ci.yml`):
```yaml
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - name: Format check
        run: npm run format:check
      - name: Typecheck
        run: npx tsc --noEmit
      - name: Tests
        run: npx vitest run
```

**Available npm scripts** (from `package.json`):
- `npm run build` -- `tsc` (full compilation to `dist/`)
- `npm run lint` -- `eslint src/`
- `npm test` -- `vitest run`
- `npm run format:check` -- `prettier --check "src/**/*.ts"`
- `npm run typecheck` -- `tsc --noEmit`

---

## Stage 5A: Add ESLint and Build Step to CI

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p5a` |
| **Title** | Add ESLint and build step to CI |
| **Priority** | P1 |
| **Tags** | `nanoclaw`, `phase-5`, `ci`, `lint`, `build` |
| **Files** | `.github/workflows/ci.yml` |
| **Dependencies** | Phase 3 complete (operational hardening settled) |
| **Effort** | ~5 lines |
| **Branch** | `refinement/p5-a-eslint-build-ci` |

### Context

The Maintainer Report (Section 8) states:

> **No lint step in CI.** The `ci.yml` runs format check and typecheck but does not run `npm run lint` (ESLint). ESLint errors could be merged without detection.

> **No build step.** CI runs `tsc --noEmit` for type checking but does not run `npm run build` to verify the actual build output works.

The SRE Report (Section 11.1, item 1) independently recommends:

> **Add ESLint to CI** [...] This is a one-line fix.

The project has ESLint 9 with flat config (`eslint.config.js`), including `eslint-plugin-no-catch-all` for catching empty catch blocks. The `npm run lint` script runs `eslint src/`. The `npm run build` script runs `tsc` which compiles to `dist/`. Currently CI only runs `tsc --noEmit` (type-check without emitting) and never verifies that the full build succeeds.

### Developer Prompt

```
TICKET: nc-p5a -- Add ESLint and build step to CI
WORKTREE: /tmp/nanoclaw-nc-p5a

Read SHARED_INSTRUCTIONS.md first.

## Task

Modify `.github/workflows/ci.yml` to add an ESLint step and a build verification step to the CI pipeline.

## Exact Changes

Edit `.github/workflows/ci.yml` to add two new steps. The final file should be:

```yaml
name: CI

on:
  pull_request:
    branches: [main]

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci

      - name: Format check
        run: npm run format:check

      - name: Lint
        run: npm run lint

      - name: Typecheck
        run: npx tsc --noEmit

      - name: Build
        run: npm run build

      - name: Tests
        run: npx vitest run
```

### Step ordering rationale

1. **Format check** -- fastest, catches formatting issues immediately.
2. **Lint** -- catches code quality issues (empty catch blocks, unused vars, etc.) before spending time on compilation.
3. **Typecheck** -- verifies types without emitting files.
4. **Build** -- full `tsc` compilation to `dist/`, verifies the build artifact is producible. This runs after typecheck because `tsc --noEmit` is faster and catches type errors first.
5. **Tests** -- last, because they take the longest and there is no point running them if the code does not compile or lint.

### Constraints

- Do NOT change the `on:` trigger, the `runs-on:` value, the checkout action, the setup-node action, or the `npm ci` step.
- Do NOT add any other steps (coverage, audit, etc.) -- those are separate tickets.
- Do NOT modify any other files.
- The lint step must use `npm run lint` (which runs `eslint src/`), not a direct `npx eslint` call.
- The build step must use `npm run build` (which runs `tsc`), not a direct `npx tsc` call.

### Verification

After editing, verify:
1. The YAML is syntactically valid (proper indentation, no tabs).
2. `npm run lint` passes locally (run it in the worktree).
3. `npm run build` passes locally (run it in the worktree).
4. `npm test` still passes.

Report IMPLEMENTATION_COMPLETE when done.
```

### QA Prompt

```
TICKET: nc-p5a -- Add ESLint and build step to CI (QA)
WORKTREE: /tmp/nanoclaw-nc-p5a

Read SHARED_INSTRUCTIONS.md first. You are QA. Do NOT modify any files.

## Baseline Checks

[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only .github/workflows/ci.yml
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

## Ticket-Specific Checks

[ ] YAML syntax valid: Run `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` or equivalent to verify YAML parses without error.
[ ] Lint step exists: The file contains a step with `name: Lint` and `run: npm run lint`.
[ ] Build step exists: The file contains a step with `name: Build` and `run: npm run build`.
[ ] Step ordering correct: Steps appear in this order: Format check, Lint, Typecheck, Build, Tests.
[ ] Existing steps unchanged: The `Format check`, `Typecheck`, and `Tests` steps are identical to the original (same `name:` and `run:` values).
[ ] Trigger unchanged: The `on:` block still triggers on `pull_request` to `[main]` only.
[ ] Runner unchanged: `runs-on: ubuntu-latest` is preserved.
[ ] Node version unchanged: `node-version: 20` is preserved.
[ ] No extra steps added: Exactly 5 named steps exist after `npm ci` (Format check, Lint, Typecheck, Build, Tests).
[ ] npm run build succeeds locally: Run `npm run build` and verify exit code 0.

Report QA_PASS or QA_FAIL with per-check breakdown.
```

---

## Stage 5B: Add npm audit to CI

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p5b` |
| **Title** | Add npm audit to CI |
| **Priority** | P1 |
| **Tags** | `nanoclaw`, `phase-5`, `ci`, `security`, `audit` |
| **Files** | `.github/workflows/ci.yml` |
| **Dependencies** | `nc-p5a` (ESLint and build step must be in place so we add after them) |
| **Effort** | ~3 lines |
| **Branch** | `refinement/p5-b-npm-audit-ci` |

### Context

The SRE Report (Section 2.1, gap 3) states:

> **No security scanning.** No `npm audit`, no SAST, no dependency vulnerability scanning in CI.

The SRE Report (Section 11.1, item 2) recommends:

> **Add `npm audit` to CI:**
> ```yaml
> - name: Security audit
>   run: npm audit --audit-level=moderate
> ```

The Maintainer Report (Section 4) notes that `zod` v4 is very new and worth monitoring, and that `grammy` adds weight. Running `npm audit` in CI catches known vulnerabilities in the dependency tree before they reach `main`.

The `--audit-level=moderate` flag means the step will fail if any vulnerability at `moderate` severity or higher is found, but will not fail on `low` severity advisories (which are often informational and would create excessive CI noise).

### Developer Prompt

```
TICKET: nc-p5b -- Add npm audit to CI
WORKTREE: /tmp/nanoclaw-nc-p5b

Read SHARED_INSTRUCTIONS.md first.

## Task

Add an `npm audit` step to `.github/workflows/ci.yml` to catch known dependency vulnerabilities.

## Prerequisites

This ticket assumes nc-p5a has already been applied, so the current ci.yml has these steps after `npm ci`:
1. Format check
2. Lint
3. Typecheck
4. Build
5. Tests

If nc-p5a has NOT been applied in this worktree, first apply those changes (add Lint and Build steps) before proceeding.

## Exact Changes

Add a `Security audit` step AFTER `npm ci` and BEFORE `Format check`. The audit should run early because there is no point linting/building/testing code with known vulnerable dependencies.

The final `.github/workflows/ci.yml` should be:

```yaml
name: CI

on:
  pull_request:
    branches: [main]

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci

      - name: Security audit
        run: npm audit --audit-level=moderate

      - name: Format check
        run: npm run format:check

      - name: Lint
        run: npm run lint

      - name: Typecheck
        run: npx tsc --noEmit

      - name: Build
        run: npm run build

      - name: Tests
        run: npx vitest run
```

### Why `--audit-level=moderate`

- `low` advisories are often informational (e.g., ReDoS in a dev dependency) and would create excessive CI noise.
- `moderate` and above typically indicate real exploitable vulnerabilities.
- `--audit-level=moderate` fails the step if ANY advisory at moderate, high, or critical severity exists.

### Constraints

- Do NOT change any existing steps -- only add the new `Security audit` step.
- Do NOT add `--omit=dev` -- we want to audit both runtime and dev dependencies.
- Do NOT add `|| true` or `continue-on-error` -- the step should fail CI if vulnerabilities are found.
- Do NOT modify any other files.

### Verification

After editing, verify:
1. The YAML is syntactically valid.
2. `npm audit --audit-level=moderate` passes locally (run it in the worktree). If it fails, note which packages have advisories but do NOT fix them in this ticket -- that is a separate concern.
3. `npm test` still passes.

Report IMPLEMENTATION_COMPLETE when done.
```

### QA Prompt

```
TICKET: nc-p5b -- Add npm audit to CI (QA)
WORKTREE: /tmp/nanoclaw-nc-p5b

Read SHARED_INSTRUCTIONS.md first. You are QA. Do NOT modify any files.

## Baseline Checks

[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only .github/workflows/ci.yml
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

## Ticket-Specific Checks

[ ] YAML syntax valid: Run `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` or equivalent to verify YAML parses without error.
[ ] Security audit step exists: The file contains a step with `name: Security audit` and `run: npm audit --audit-level=moderate`.
[ ] Step placement correct: The `Security audit` step appears AFTER `npm ci` and BEFORE `Format check`.
[ ] Audit level is moderate: The run command contains `--audit-level=moderate` (not `low`, not `high`, not `critical`).
[ ] No continue-on-error: The step does NOT contain `continue-on-error: true`.
[ ] No `|| true` suffix: The run command does NOT end with `|| true` or `|| exit 0`.
[ ] No `--omit=dev`: The run command does NOT contain `--omit=dev` or `--production`.
[ ] All previous steps preserved: Format check, Lint, Typecheck, Build, Tests steps are all present and unchanged.
[ ] Step ordering correct: Steps appear in this order: Security audit, Format check, Lint, Typecheck, Build, Tests.
[ ] Exactly 6 named steps: Count all steps with a `name:` field after `npm ci`. There should be exactly 6.
[ ] npm audit runs locally: Run `npm audit --audit-level=moderate` and record the result. If it fails, report as PASS with a note (the step is correctly configured even if current dependencies have advisories -- fixing advisories is out of scope).

Report QA_PASS or QA_FAIL with per-check breakdown.
```

---

## Stage 5C: Set Up FreeBSD CI via Cirrus CI

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p5c` |
| **Title** | Set up FreeBSD CI via Cirrus CI |
| **Priority** | P2 |
| **Tags** | `nanoclaw`, `phase-5`, `ci`, `freebsd`, `cirrus` |
| **Files** | `.cirrus.yml` (new) |
| **Dependencies** | `nc-p5a` (lint/build in GitHub CI settled first) |
| **Effort** | Medium (~50 lines) |
| **Branch** | `refinement/p5-c-freebsd-cirrus-ci` |

### Context

The Maintainer Report (Section 8) identifies this as the most significant CI gap:

> **No FreeBSD CI.** The CI runs on `ubuntu-latest` only. Jail-specific tests are skipped on non-FreeBSD. There is no FreeBSD CI runner configured, meaning the entire jail runtime (2,920 lines) is never tested in CI. This is the most significant CI gap.

The SRE Report (Section 2.1, gap 1) concurs:

> **No FreeBSD CI runner.** The `ci.yml` runs on `ubuntu-latest`. All jail-related code paths (`src/jail/*.ts`) are exercised only via unit tests that mock system calls. There is no integration test that verifies actual jail creation, ZFS cloning, epair networking, or pf rule loading on FreeBSD.

The SRE Report (Section 11.2, item 4) recommends Cirrus CI specifically:

> **FreeBSD integration test workflow** using a FreeBSD VM on Cirrus CI or a self-hosted runner

Cirrus CI is the recommended solution because:
1. It provides native FreeBSD VMs (not emulated) with ZFS support.
2. It integrates with GitHub repositories via the Cirrus CI GitHub App.
3. It offers free usage for open-source projects.
4. FreeBSD is a first-class supported OS (unlike GitHub Actions, which only supports Linux/macOS/Windows).

The Cirrus CI config uses a `.cirrus.yml` file in the repository root. It triggers on PRs and pushes to `main`, similar to the GitHub Actions CI. The FreeBSD VM includes `pkg` for package installation and ZFS is available by default.

**Scope limitation**: This ticket creates the Cirrus CI config for running unit tests on FreeBSD. Full jail integration tests (actual jail creation, ZFS cloning, epair networking) require root privileges and a jail template, which is beyond the scope of CI unit testing. The value here is verifying that the TypeScript code compiles and all unit tests (including jail tests with mocked system calls) pass on a real FreeBSD environment with the correct Node.js version.

### Developer Prompt

```
TICKET: nc-p5c -- Set up FreeBSD CI via Cirrus CI
WORKTREE: /tmp/nanoclaw-nc-p5c

Read SHARED_INSTRUCTIONS.md first.

## Task

Create a `.cirrus.yml` file at the repository root that configures Cirrus CI to run the project's lint, build, and test suite on a FreeBSD 15.0 VM.

## Background

Cirrus CI provides native FreeBSD VMs. The `.cirrus.yml` file defines tasks that run in those VMs. Each task specifies a VM image, setup steps, and test scripts. Cirrus CI integrates with GitHub via the Cirrus CI GitHub App (installed separately by the repo owner).

The project currently uses Node.js 24 on FreeBSD 15.0-RELEASE (per SHARED_INSTRUCTIONS.md). FreeBSD packages for Node.js are available via `pkg` as `node24` and `npm-node24`.

## Exact File Content

Create `.cirrus.yml` with this content:

```yaml
freebsd_task:
  name: "FreeBSD 15.0 - Lint, Build, Test"

  # Trigger on PRs and pushes to main
  only_if: $CIRRUS_PR != '' || $CIRRUS_BRANCH == 'main'

  freebsd_instance:
    image_family: freebsd-15-0
    cpu: 4
    memory: 8G

  env:
    HOME: /root

  # Cache node_modules across builds for faster installs
  node_modules_cache:
    folder: node_modules
    fingerprint_script: cat package-lock.json
    populate_script: npm ci

  install_script:
    - pkg install -y node24 npm-node24
    - node --version
    - npm --version

  # Install dependencies (skipped if cache hit)
  dependencies_script:
    - npm ci

  lint_script:
    - npm run format:check
    - npm run lint

  typecheck_script:
    - npx tsc --noEmit

  build_script:
    - npm run build

  test_script:
    - npx vitest run
```

## Design Decisions

1. **`freebsd-15-0` image family**: Matches the production FreeBSD 15.0-RELEASE environment. Cirrus CI maintains these images and updates them with security patches.

2. **`only_if` trigger**: Runs on PRs (matches GitHub Actions trigger) and on pushes to `main` (for post-merge validation). The `$CIRRUS_PR` and `$CIRRUS_BRANCH` environment variables are provided by Cirrus CI.

3. **`node_modules_cache`**: Caches `node_modules` keyed by `package-lock.json` hash. The `populate_script` runs `npm ci` only on cache miss. This significantly speeds up subsequent builds.

4. **`dependencies_script` with `npm ci`**: Runs after install to ensure dependencies are installed even if the cache was partially populated. `npm ci` is a no-op if `node_modules` matches the lock file.

5. **4 CPU / 8G memory**: Adequate for TypeScript compilation and Vitest. The jail tests use mocked system calls and do not require actual FreeBSD jail infrastructure.

6. **Separate script blocks**: Cirrus CI runs each `*_script` block as a separate step, providing clear pass/fail granularity in the UI. If `lint_script` fails, subsequent scripts still run (Cirrus CI default behavior) but the task is marked as failed.

7. **`HOME: /root`**: Cirrus CI runs as root in FreeBSD VMs. Setting HOME explicitly ensures npm and Node.js resolve config paths correctly.

## What This Does NOT Do

- Does NOT create or test actual FreeBSD jails (requires ZFS datasets, jail template, pf rules, root privileges beyond what CI VMs provide safely).
- Does NOT replace the GitHub Actions CI (`.github/workflows/ci.yml`) -- both run in parallel, covering Linux and FreeBSD.
- Does NOT install the Cirrus CI GitHub App -- that is a manual step for the repository owner.

## Constraints

- Do NOT modify `.github/workflows/ci.yml` -- that file is handled by nc-p5a and nc-p5b.
- Do NOT modify any source files.
- Do NOT add Cirrus CI to `package.json` scripts.
- The file must be named exactly `.cirrus.yml` (not `.cirrus.yaml`, not `cirrus.yml`).
- Place the file at the repository root (same level as `package.json`).

## Verification

After creating the file:
1. Verify the YAML is syntactically valid.
2. Verify the file is at the repository root.
3. Verify `npm test` still passes (no source changes were made).
4. Verify `npm run lint` still passes.

Report IMPLEMENTATION_COMPLETE when done.
```

### QA Prompt

```
TICKET: nc-p5c -- Set up FreeBSD CI via Cirrus CI (QA)
WORKTREE: /tmp/nanoclaw-nc-p5c

Read SHARED_INSTRUCTIONS.md first. You are QA. Do NOT modify any files.

## Baseline Checks

[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only .cirrus.yml (new file)
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

## Ticket-Specific Checks

[ ] File exists at correct path: `.cirrus.yml` exists at the repository root (same directory as `package.json`).
[ ] File is named correctly: The filename is `.cirrus.yml` (leading dot, lowercase, `.yml` extension).
[ ] YAML syntax valid: Run `python3 -c "import yaml; yaml.safe_load(open('.cirrus.yml'))"` or equivalent to verify YAML parses without error.
[ ] FreeBSD image specified: The config contains `image_family: freebsd-15-0` (or a valid FreeBSD 15 Cirrus CI image family).
[ ] Node.js installation: The config includes a step that runs `pkg install -y node24 npm-node24` (or equivalent Node.js 24 packages for FreeBSD).
[ ] Dependencies installed: The config includes `npm ci` in either a dependencies script or a cache populate script.
[ ] Lint step present: The config includes `npm run lint` or `npm run format:check` in a script block.
[ ] Build step present: The config includes `npm run build` in a script block.
[ ] Test step present: The config includes `npx vitest run` or `npm test` in a script block.
[ ] Trigger configuration: The config has an `only_if` condition or equivalent that limits execution to PRs and/or the main branch (not every push to every branch).
[ ] No source files modified: `git diff --stat` shows `.cirrus.yml` as the only changed/added file.
[ ] No GitHub Actions modified: `.github/workflows/ci.yml` is NOT in `git diff --stat`.
[ ] Resource allocation reasonable: CPU is between 2-8 and memory is between 4G-16G (not wastefully large or too small to compile TypeScript).
[ ] Cache configuration: A cache block exists that caches `node_modules` keyed by `package-lock.json` (or similar fingerprint).

Report QA_PASS or QA_FAIL with per-check breakdown.
```

---

## Stage 5D: Coverage Enforcement and ESLint no-catch-all Promotion

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p5d` |
| **Title** | Add coverage thresholds and promote no-catch-all to error |
| **Priority** | P2 |
| **Tags** | `nanoclaw`, `phase-5`, `ci`, `coverage`, `lint` |
| **Files** | `vitest.config.ts`, `eslint.config.js`, `.github/workflows/ci.yml` |
| **Dependencies** | `nc-p5a` (ESLint and build in CI must be in place first) |
| **Effort** | ~15 lines |
| **Branch** | `refinement/p5-d-coverage-lint-promotion` |

### Context

The Synthesis Report (Section 3, CI/CD Gaps) identifies "No coverage enforcement" as a CI gap: coverage can regress silently because there are no thresholds configured. The Synthesis Report (Section 3, Maintainability #3) also identifies that "ESLint `no-catch-all` is set to `warn`, not `error`" — at least 6 instances of empty catch blocks silently swallow errors.

The current configuration:

1. `vitest.config.ts` (7 lines) has no coverage configuration at all:
   ```typescript
   export default defineConfig({
     test: {
       include: ['src/**/*.test.ts', 'setup/**/*.test.ts'],
     },
   });
   ```

2. `eslint.config.js` line 28 has:
   ```javascript
   'no-catch-all/no-catch-all': 'warn',
   ```

3. `.github/workflows/ci.yml` runs `npx vitest run` without a `--coverage` flag.

This ticket makes three small changes:
- Add conservative coverage thresholds to vitest.config.ts
- Promote no-catch-all from warn to error in eslint.config.js
- Add --coverage to the CI test step

**Impact**: Coverage regressions will be caught in CI. Empty catch blocks will block CI instead of producing ignorable warnings.

### Developer Prompt

```
Read refinement/03252026/SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-p5d — Coverage enforcement and ESLint no-catch-all promotion
FILES: vitest.config.ts, eslint.config.js, .github/workflows/ci.yml

CONTEXT:
No coverage thresholds exist, so coverage can regress silently. The no-catch-all
ESLint rule is set to warn instead of error, so empty catch blocks produce
warnings but don't fail CI. The CI test step doesn't include --coverage.

CHANGES:

1. Read vitest.config.ts. Add coverage configuration with conservative thresholds.
   The updated file should be:

   ```typescript
   import { defineConfig } from 'vitest/config';

   export default defineConfig({
     test: {
       include: ['src/**/*.test.ts', 'setup/**/*.test.ts'],
       coverage: {
         provider: 'v8',
         thresholds: {
           statements: 50,
           branches: 40,
           functions: 40,
           lines: 50,
         },
       },
     },
   });
   ```

   These thresholds are intentionally conservative (matching or slightly below
   current levels) to avoid blocking existing code while preventing regressions.

2. Read eslint.config.js. Find the no-catch-all rule on line 28:
   BEFORE: 'no-catch-all/no-catch-all': 'warn',
   AFTER:  'no-catch-all/no-catch-all': 'error',

   IMPORTANT: Before making this change, run `npm run lint` to check if any
   existing code will fail with the promoted rule. If there are existing
   violations:
   - Fix them by adding specific error types to catch blocks (e.g.,
     `catch (error: unknown)` with proper handling or logging)
   - OR add inline eslint-disable comments for genuinely intentional empty catches
   - Do NOT leave the rule at warn if the prompt says to change it to error

3. Read .github/workflows/ci.yml. Find the Tests step:
   BEFORE: run: npx vitest run
   AFTER:  run: npx vitest run --coverage

4. Run: npm test (verify tests still pass)
5. Run: npx tsc --noEmit
6. Run: npm run lint (verify no new lint errors from the rule promotion)
7. Run: npm run format:check

IMPLEMENTATION_COMPLETE
```

### QA Prompt

```
Read refinement/03252026/SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-p5d — Coverage enforcement and ESLint no-catch-all promotion (QA)
WORKTREE: /tmp/nanoclaw-nc-p5d

Read SHARED_INSTRUCTIONS.md first. You are QA. Do NOT modify any files.

## Baseline Checks

[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only vitest.config.ts, eslint.config.js, .github/workflows/ci.yml
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

## Ticket-Specific Checks

[ ] Coverage thresholds defined: vitest.config.ts contains a coverage.thresholds
    object with statements, branches, functions, and lines properties.

[ ] Coverage provider specified: vitest.config.ts contains coverage.provider
    set to 'v8' (or 'istanbul').

[ ] Thresholds are conservative: All threshold values are between 30 and 70
    (conservative enough not to block existing code).

[ ] no-catch-all set to error: eslint.config.js contains:
    'no-catch-all/no-catch-all': 'error'
    (NOT 'warn')

[ ] CI includes --coverage: .github/workflows/ci.yml Tests step has:
    run: npx vitest run --coverage

[ ] npm run lint passes: Run npm run lint and verify it exits 0 with the
    promoted no-catch-all rule. If existing empty catch blocks now fail,
    they must have been fixed by the developer.

[ ] npm test passes: Run npm test and verify it exits 0. Coverage thresholds
    should not block if they are conservative.

[ ] Existing steps unchanged: All other CI steps (Format check, Lint, Typecheck,
    Build, Security audit if present) are unchanged.

[ ] vitest.config.ts test.include unchanged: The include array still contains
    ['src/**/*.test.ts', 'setup/**/*.test.ts'].

Report QA_PASS or QA_FAIL with per-check breakdown.
```

---

## Phase 5 Integration QA

After all four stages (5A, 5B, 5C, 5D) pass individual QA, run this integration QA on the merged result.

### Integration QA Prompt

```
PHASE 5 INTEGRATION QA -- CI/CD and Code Quality
BRANCH: Merged result of nc-p5a + nc-p5b + nc-p5c + nc-p5d

Read SHARED_INSTRUCTIONS.md first. You are QA. Do NOT modify any files.

## Baseline Checks

[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No secrets or credentials in diff

## Integration Checks

### GitHub Actions CI (`.github/workflows/ci.yml`)

[ ] File exists and is valid YAML.
[ ] Contains exactly 6 named steps after `npm ci`: Security audit, Format check, Lint, Typecheck, Build, Tests.
[ ] Steps are in the correct order:
    1. Security audit (`npm audit --audit-level=moderate`)
    2. Format check (`npm run format:check`)
    3. Lint (`npm run lint`)
    4. Typecheck (`npx tsc --noEmit`)
    5. Build (`npm run build`)
    6. Tests (`npx vitest run`)
[ ] Tests step includes --coverage flag: `npx vitest run --coverage`
[ ] Trigger is `pull_request` on `[main]` only.
[ ] Runner is `ubuntu-latest`.
[ ] Node version is 20.
[ ] No `continue-on-error` or `|| true` on any step.

### Cirrus CI (`.cirrus.yml`)

[ ] File exists at repository root and is valid YAML.
[ ] Uses FreeBSD 15.0 image (image_family: freebsd-15-0 or equivalent).
[ ] Installs Node.js 24 via pkg.
[ ] Runs lint, build, and test steps.
[ ] Has trigger limiting (only_if or equivalent for PRs/main).
[ ] Has node_modules caching.

### Cross-File Consistency

[ ] Both CI configs run lint: GitHub Actions has `npm run lint`, Cirrus CI has `npm run lint` (or equivalent).
[ ] Both CI configs run build: GitHub Actions has `npm run build`, Cirrus CI has `npm run build`.
[ ] Both CI configs run tests: GitHub Actions has `npx vitest run`, Cirrus CI has `npx vitest run` (or `npm test`).
[ ] No conflicting configurations: The two CI systems are complementary (GitHub Actions on Linux, Cirrus CI on FreeBSD) and do not conflict.

### Coverage and Lint Promotion (nc-p5d)

[ ] vitest.config.ts has coverage thresholds defined with provider 'v8'.
[ ] Coverage thresholds are conservative (statements/lines ~50, branches/functions ~40).
[ ] eslint.config.js has no-catch-all set to 'error' (not 'warn').
[ ] npm run lint passes with no-catch-all as error.
[ ] npm test passes with coverage thresholds active.

### No Regressions

[ ] No source files modified: Only `.github/workflows/ci.yml` and `.cirrus.yml` should appear in the diff.
[ ] `package.json` is unchanged.
[ ] `vitest.config.ts` changes are limited to coverage configuration.
[ ] `tsconfig.json` is unchanged.
[ ] `eslint.config.js` change is limited to no-catch-all severity.

Report QA_PASS or QA_FAIL with per-check breakdown.
```

---

## Summary

| Stage | Ticket | Change | Files Modified | Files Created |
|-------|--------|--------|----------------|---------------|
| 5A | `nc-p5a` | Add ESLint and build step to CI | `.github/workflows/ci.yml` | -- |
| 5B | `nc-p5b` | Add npm audit to CI | `.github/workflows/ci.yml` | -- |
| 5C | `nc-p5c` | Set up FreeBSD CI via Cirrus CI | -- | `.cirrus.yml` |
| 5D | `nc-p5d` | Coverage thresholds + no-catch-all promotion | `vitest.config.ts`, `eslint.config.js`, `.github/workflows/ci.yml` | -- |

**Total lines changed**: ~15 lines modified in `ci.yml`, ~15 lines in `vitest.config.ts` and `eslint.config.js`, ~50 lines in new `.cirrus.yml`
**Risk**: Low -- only CI configuration files are touched. No source code changes. No test changes.
**Rollback**: Revert the CI file changes. Cirrus CI is inert without the GitHub App installed.

### Post-Merge Verification

After the Phase 5 PR merges to `main`:

1. Open a test PR to verify the GitHub Actions CI runs all 6 steps (Security audit, Format check, Lint, Typecheck, Build, Tests).
2. Install the Cirrus CI GitHub App on the repository (if not already installed) and verify the FreeBSD task runs on the test PR.
3. Confirm both CI systems report status checks on the PR.
4. Clean up: remove worktrees and delete `refinement/p5-*` branches.
