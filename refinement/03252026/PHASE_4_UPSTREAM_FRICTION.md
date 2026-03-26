# Phase 4: Upstream Merge Friction Reduction

**Priority**: P2 -- highest ROI for long-term maintainability
**Depends on**: Phase 2 (jail runner changes in 2C/2D must settle before extracting shared code)
**Source reports**: Product Manager Report (Priority 1), Maintainer Report (sections 1-3, 7, 10), BSD PM Report (section 7), OneCLI Shim Design (`analysis/experts/onecli-design.md`)

---

## Rationale

The fork is 190 commits behind upstream with an architectural split: upstream replaced the credential proxy with `@onecli-sh/sdk` (OneCLI), while this fork retains the self-hosted credential proxy with jail-specific hardening. Every upstream merge now conflicts on `container-runner.ts` and `index.ts` at the OneCLI integration points.

Three additional friction sources compound the problem:
1. **Duplicated code** between `container-runner.ts` and `jail/runner.ts` (settings.json generation + skills sync) drifts independently.
2. **grammy in core** adds 5MB to node_modules for an optional channel; upstream removed it.
3. **Missing upstream features** (per-group triggers, timezone validation, CLAUDE.md templates) widen the gap.

Phase 4 addresses all four sources. The OneCLI shim (4A) is the single most impactful change in the entire refinement: it reduces `container-runner.ts` to zero diff from upstream, making future merges mechanical.

---

## Stage 4A: Build OneCLI SDK Shim

### Ticket Header

```yaml
id: nc-p4a
title: Build OneCLI SDK shim for upstream merge compatibility
priority: 2
tags: [nanoclaw, phase-4, upstream, onecli, shim]
files:
  - src/onecli-shim.ts (NEW)
  - src/onecli-shim.test.ts (NEW)
  - tsconfig.json (ADD paths alias)
  - src/config.ts (RESTORE ONECLI_URL export)
dependencies: [nc-p2c, nc-p2d]
effort: ~120 lines + tests
```

### Context

The Product Manager Report identifies this as "the single most impactful change for long-term maintainability" (Priority 1, item 1). The Maintainer Report quantifies the problem: 190 commits behind upstream, with `container-runner.ts` and `index.ts` as the two highest-risk merge conflict files (section 10). The BSD PM Report confirms the architectural divergence: upstream uses `@onecli-sh/sdk` for credential injection; the fork uses a self-hosted credential proxy with per-jail UUID tokens, source IP filtering, and rate limiting.

The OneCLI design document (`analysis/experts/onecli-design.md`) provides a complete design: a TypeScript class that exports the same interface as `@onecli-sh/sdk` but delegates to the existing credential proxy internals. Once this shim is in place, upstream code that does `import { OneCLI } from '@onecli-sh/sdk'` resolves to the shim via a `tsconfig.json` paths mapping. The result: `container-runner.ts` can be reverted to match upstream exactly (zero diff), and `index.ts` reduces to an additive-only diff (proxy startup alongside upstream's `ensureOneCLIAgent()` calls).

### Developer Prompt

```
TICKET: nc-p4a — Build OneCLI SDK shim for upstream merge compatibility
WORKTREE: /tmp/nanoclaw-nc-p4a

READ FIRST:
- refinement/03252026/SHARED_INSTRUCTIONS.md (environment, coding standards, rules)
- analysis/experts/onecli-design.md (FULL — this is your specification)
- src/credential-proxy.ts (exports you will call: registerJailToken, revokeJailToken)
- src/config.ts (you will add ONECLI_URL export here)
- tsconfig.json (you will add paths mapping)

OBJECTIVE:
Create src/onecli-shim.ts — a drop-in replacement for @onecli-sh/sdk that implements
the OneCLI class interface while delegating to the existing credential proxy internals.
This is a FACADE — same front door, completely different house behind it.

IMPORTANT DESIGN CONSTRAINTS (from onecli-design.md):
- The shim does NOT touch jail token lifecycle. Jail tokens are created/revoked in
  jail/lifecycle.ts at jail creation/destruction time. The shim handles upstream's
  Docker-oriented calls only.
- The shim does NOT start any HTTP server. The credential proxy already runs one.
- The shim does NOT make HTTP calls. The real @onecli-sh/sdk calls http://localhost:10254;
  our shim goes straight to in-process credential proxy functions.
- The shim runs in the orchestrator process. It is NOT a separate service.

STEP 1: Create src/onecli-shim.ts

The file must export a class named OneCLI with this exact interface:

```typescript
interface OneCLIOptions {
  url?: string;       // Ignored by shim (no external gateway)
  apiKey?: string;    // Ignored by shim
  timeout?: number;   // Ignored by shim
}

interface EnsureAgentResult {
  created: boolean;
}

interface ApplyContainerConfigOptions {
  addHostMapping?: boolean;
  agent?: string;     // Agent identifier — maps to jail token lookup
}

export class OneCLI {
  constructor(options?: OneCLIOptions);
  ensureAgent(config: { name: string; identifier: string }): Promise<EnsureAgentResult>;
  applyContainerConfig(args: string[], options?: ApplyContainerConfigOptions): Promise<boolean>;
}
```

Implementation details for each method:

constructor(options?: OneCLIOptions):
- Store the options for potential future use, but do not act on them.
- Log at debug level that the shim is being used (not the real OneCLI).
- Use the logger from src/logger.ts.

ensureAgent({ name, identifier }):
- Return { created: true }. No side effects.
- Upstream calls this at group registration time for Docker agent identity.
- Jail token creation happens separately in jail/lifecycle.ts — this method
  must NOT create jail tokens. The two paths are independent:
    Docker path: group registered -> ensureOneCLIAgent() -> shim.ensureAgent() -> no-op
    Jail path:   jail created -> lifecycle.ts -> crypto.randomUUID() -> registerJailToken()
- Log at debug level: "OneCLI shim: ensureAgent (no-op)" with name and identifier.

applyContainerConfig(args, options?):
- This is called by upstream's container-runner.ts for Docker containers.
- It must inject ANTHROPIC_BASE_URL and a placeholder API key into the Docker
  args array, mirroring what the real OneCLI gateway does.
- Read CREDENTIAL_PROXY_PORT from src/config.ts.
- Read CONTAINER_HOST_GATEWAY from src/container-runtime.ts.
- Import detectAuthMode from src/credential-proxy.ts.
- Inject into the args array (before the image name, which is the last element):
    -e ANTHROPIC_BASE_URL=http://{CONTAINER_HOST_GATEWAY}:{CREDENTIAL_PROXY_PORT}
    -e ANTHROPIC_API_KEY=placeholder  (if auth mode is api-key)
    -e CLAUDE_CODE_OAUTH_TOKEN=placeholder  (if auth mode is oauth)
- Return true (success).
- Log at debug level with the agent identifier if provided.

Also export the interfaces (OneCLIOptions, EnsureAgentResult, ApplyContainerConfigOptions)
as named exports so consumers can import types.

STEP 2: Update tsconfig.json

Add a "paths" entry and a "baseUrl" to compilerOptions so that:
  import { OneCLI } from '@onecli-sh/sdk'
resolves to ./src/onecli-shim.ts.

The current tsconfig.json compilerOptions are:
{
  "target": "ES2022",
  "module": "NodeNext",
  "moduleResolution": "NodeNext",
  "lib": ["ES2022"],
  "outDir": "./dist",
  "rootDir": "./src",
  "strict": true,
  "esModuleInterop": true,
  "skipLibCheck": true,
  "forceConsistentCasingInFileNames": true,
  "resolveJsonModule": true,
  "declaration": true,
  "declarationMap": true,
  "sourceMap": true
}

Add:
  "baseUrl": ".",
  "paths": {
    "@onecli-sh/sdk": ["./src/onecli-shim.ts"]
  }

IMPORTANT: With NodeNext moduleResolution, paths mappings are primarily for
type checking. At runtime, the import must also resolve. Since the fork never
installs the real @onecli-sh/sdk package, the paths mapping alone suffices for
TypeScript compilation. If runtime resolution fails during testing, add a
package.json alias as a fallback:
  "dependencies": { "@onecli-sh/sdk": "file:./src/onecli-shim" }
However, try the tsconfig.json paths approach first — it is cleaner.

STEP 3: Update src/config.ts

Add the ONECLI_URL export that upstream references:

export const ONECLI_URL = process.env.ONECLI_URL || 'http://localhost:10254';

This value is passed to the OneCLI constructor but ignored by the shim.
Add it near the other URL/port config exports (after CREDENTIAL_PROXY_PORT).

STEP 4: Create src/onecli-shim.test.ts

Write unit tests covering:

1. Constructor accepts options without error
2. Constructor works with no options
3. ensureAgent() returns { created: true }
4. ensureAgent() does NOT call registerJailToken (verify no side effects)
5. applyContainerConfig() injects ANTHROPIC_BASE_URL into args array
6. applyContainerConfig() injects placeholder API key when auth mode is api-key
7. applyContainerConfig() injects placeholder OAuth token when auth mode is oauth
8. applyContainerConfig() returns true
9. applyContainerConfig() preserves existing args (does not clobber)
10. The module exports OneCLI as a named export (verify import shape)
11. The module exports the interface types

Mock dependencies:
- Mock src/logger.ts (logger.debug, logger.info)
- Mock src/credential-proxy.ts (detectAuthMode — return 'api-key' or 'oauth')
- Mock src/container-runtime.ts (CONTAINER_HOST_GATEWAY — return 'host.docker.internal')
- Mock src/config.ts (CREDENTIAL_PROXY_PORT — return 3001)

Use vi.mock() for all mocks. Use beforeEach(() => vi.clearAllMocks()).

STEP 5: Verify

Run these commands and fix any failures:
  npx tsc --noEmit
  npm test
  npm run lint
  npm run format:check

If format check fails, run: npx prettier --write src/onecli-shim.ts src/onecli-shim.test.ts

NOTE: Do NOT modify container-runner.ts or index.ts in this ticket. Those files
will be reverted to upstream in a future sync after the shim is proven. This ticket
only creates the shim, the tsconfig mapping, the config export, and the tests.

Report IMPLEMENTATION_COMPLETE when done.
```

### QA Prompt

```
TICKET: nc-p4a — QA validation for OneCLI SDK shim
WORKTREE: /tmp/nanoclaw-nc-p4a

READ FIRST:
- refinement/03252026/SHARED_INSTRUCTIONS.md (QA rules, baseline checks)
- analysis/experts/onecli-design.md (interface specification)

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only expected files
    Expected files: src/onecli-shim.ts, src/onecli-shim.test.ts, tsconfig.json, src/config.ts
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

TICKET-SPECIFIC CHECKS:

[ ] SHIM INTERFACE MATCH: Verify src/onecli-shim.ts exports a class named OneCLI with:
    - constructor(options?: OneCLIOptions)
    - ensureAgent(config: { name: string; identifier: string }): Promise<EnsureAgentResult>
    - applyContainerConfig(args: string[], options?: ApplyContainerConfigOptions): Promise<boolean>
    These must match the upstream @onecli-sh/sdk interface exactly.

[ ] NAMED EXPORTS: Verify the module exports OneCLI, OneCLIOptions, EnsureAgentResult,
    and ApplyContainerConfigOptions as named exports.

[ ] NO SIDE EFFECTS IN ensureAgent: Verify ensureAgent() does NOT import or call
    registerJailToken, revokeJailToken, or any function from jail/lifecycle.ts.
    Run: grep -n 'registerJailToken\|revokeJailToken\|lifecycle' src/onecli-shim.ts
    Expected: zero matches.

[ ] NO HTTP SERVER: Verify the shim does NOT create any HTTP server.
    Run: grep -n 'createServer\|listen\|http\.' src/onecli-shim.ts
    Expected: zero matches (imports of config values are fine, but no http.createServer).

[ ] NO HTTP CALLS: Verify the shim does NOT make outbound HTTP requests.
    Run: grep -n 'fetch\|httpsRequest\|httpRequest\|axios\|got(' src/onecli-shim.ts
    Expected: zero matches.

[ ] TSCONFIG PATHS: Verify tsconfig.json contains:
    "paths": { "@onecli-sh/sdk": ["./src/onecli-shim.ts"] }
    and "baseUrl": "."

[ ] CONFIG EXPORT: Verify src/config.ts exports ONECLI_URL with a default of
    'http://localhost:10254'.

[ ] CREDENTIAL PROXY UNCHANGED: Verify src/credential-proxy.ts has zero changes.
    Run: git diff src/credential-proxy.ts
    Expected: empty.

[ ] JAIL CODE UNCHANGED: Verify no files in src/jail/ have been modified.
    Run: git diff --stat src/jail/
    Expected: empty.

[ ] TEST COVERAGE: Verify src/onecli-shim.test.ts exists and tests:
    - Constructor (with and without options)
    - ensureAgent returns { created: true }
    - applyContainerConfig injects env vars into args
    - Both api-key and oauth auth modes
    - Args preservation (existing args not clobbered)

[ ] IMPORT RESOLUTION: Verify that TypeScript can resolve @onecli-sh/sdk to the shim.
    Create a temporary test: echo 'import { OneCLI } from "@onecli-sh/sdk";' > /tmp/test-import.ts
    Run: npx tsc --noEmit --project tsconfig.json /tmp/test-import.ts
    (This may not work due to rootDir constraints — if so, verify via the paths mapping
    in tsconfig.json and the successful compilation of the shim's own test file.)

Report QA_PASS or QA_FAIL with per-check breakdown.
```

---

## Stage 4B: Extract Shared Runner Setup Code

### Ticket Header

```yaml
id: nc-p4b
title: Extract shared runner setup code (settings.json, skills sync)
priority: 2
tags: [nanoclaw, phase-4, upstream, dedup, runner]
files:
  - src/runner-setup.ts (NEW)
  - src/runner-setup.test.ts (NEW)
  - src/container-runner.ts (MODIFY — replace inline code with imports)
  - src/jail/runner.ts (MODIFY — replace inline code with imports)
dependencies: [nc-p2c, nc-p2d]
effort: ~50 lines net reduction
```

### Context

The Maintainer Report (section 3, concerns 3-4) identifies two blocks of code duplicated verbatim between the Docker and jail runners:

1. **Settings.json generation** -- `container-runner.ts` lines 113-135 and `jail/runner.ts` lines 60-76. Both independently create the Claude Code settings file with identical content (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY`).

2. **Skills sync logic** -- `container-runner.ts` lines 137-149 and `jail/runner.ts` lines 78-90. Both copy skill directories from `container/skills/` into the group's `.claude/skills/` directory with identical iteration and error handling.

When upstream changes these patterns (e.g., adding a new settings key or changing the skills sync approach), both files must be updated independently. Extracting to a shared module eliminates this drift risk.

### Developer Prompt

```
TICKET: nc-p4b — Extract shared runner setup code (settings.json, skills sync)
WORKTREE: /tmp/nanoclaw-nc-p4b

READ FIRST:
- refinement/03252026/SHARED_INSTRUCTIONS.md (environment, coding standards, rules)
- src/container-runner.ts (lines 106-149: settings.json + skills sync in buildVolumeMounts)
- src/jail/runner.ts (lines 43-90: settings.json + skills sync in buildJailMountPaths)

OBJECTIVE:
Extract the duplicated settings.json creation and skills sync logic from both
container-runner.ts and jail/runner.ts into a new shared module src/runner-setup.ts.

STEP 1: Read and compare the duplicated code

In container-runner.ts, lines 106-149 (inside buildVolumeMounts):
```typescript
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      try {
        fs.cpSync(srcDir, dstDir, { recursive: true });
      } catch {}
    }
  }
```

In jail/runner.ts, lines 43-90 (inside buildJailMountPaths):
```typescript
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );

  fs.mkdirSync(groupSessionsDir, { recursive: true });

  // Set permissions for shared host/jail access (mode 2775, group wheel)
  try {
    fs.chmodSync(groupSessionsDir, 0o2775);
    const uid = process.getuid?.() ?? 0;
    fs.chownSync(groupSessionsDir, uid, 0);
  } catch {
    // Non-fatal: permissions will be set by ensureHostDirectories in jail module
  }
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      try {
        fs.cpSync(srcDir, dstDir, { recursive: true });
      } catch {}
    }
  }
```

Note the jail version has ADDITIONAL code (chmod/chown for jail permissions) that the
Docker version does not. This must be preserved.

STEP 2: Create src/runner-setup.ts

Export two functions:

1. ensureGroupSettings(groupSessionsDir: string): void
   - Creates the directory (mkdirSync recursive)
   - Writes settings.json if it does not exist
   - The settings content is identical between both runners:
     { env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
              CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
              CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' } }

2. syncContainerSkills(groupSessionsDir: string): void
   - Copies skill directories from container/skills/ into groupSessionsDir/skills/
   - Iterates subdirectories, skips non-directories, uses fs.cpSync recursive
   - Catches and ignores errors per-directory (matching existing behavior)

Also export a helper to compute the groupSessionsDir path:

3. getGroupSessionsDir(groupFolder: string): string
   - Returns path.join(DATA_DIR, 'sessions', groupFolder, '.claude')
   - Import DATA_DIR from src/config.ts

STEP 3: Update src/container-runner.ts

In buildVolumeMounts(), replace lines 106-149 with:
```typescript
  const groupSessionsDir = getGroupSessionsDir(group.folder);
  ensureGroupSettings(groupSessionsDir);
  syncContainerSkills(groupSessionsDir);
```

Add the import at the top:
```typescript
import { getGroupSessionsDir, ensureGroupSettings, syncContainerSkills } from './runner-setup.js';
```

Remove the now-unused import of DATA_DIR from config.ts IF it is no longer used
elsewhere in the file (check first — it may still be used for other paths).

STEP 4: Update src/jail/runner.ts

In buildJailMountPaths(), replace lines 43-90 with:
```typescript
  const groupSessionsDir = getGroupSessionsDir(group.folder);
  ensureGroupSettings(groupSessionsDir);

  // Set permissions for shared host/jail access (mode 2775, group wheel)
  try {
    fs.chmodSync(groupSessionsDir, 0o2775);
    const uid = process.getuid?.() ?? 0;
    fs.chownSync(groupSessionsDir, uid, 0);
  } catch {
    // Non-fatal: permissions will be set by ensureHostDirectories in jail module
  }

  syncContainerSkills(groupSessionsDir);
```

Note: The chmod/chown block is jail-specific and stays inline. Only the settings.json
creation and skills sync are extracted.

Add the import at the top:
```typescript
import { getGroupSessionsDir, ensureGroupSettings, syncContainerSkills } from '../runner-setup.js';
```

Remove the now-unused import of DATA_DIR from config.ts IF it is no longer used
elsewhere in jail/runner.ts (check first).

STEP 5: Create src/runner-setup.test.ts

Write unit tests covering:

1. getGroupSessionsDir() returns correct path for a given group folder
2. ensureGroupSettings() creates directory if it doesn't exist
3. ensureGroupSettings() writes settings.json with correct content when file missing
4. ensureGroupSettings() does NOT overwrite existing settings.json
5. syncContainerSkills() copies skill directories from container/skills/
6. syncContainerSkills() skips non-directory entries
7. syncContainerSkills() handles missing container/skills/ directory gracefully
8. syncContainerSkills() catches and ignores per-directory copy errors

Mock fs (mkdirSync, existsSync, writeFileSync, readdirSync, statSync, cpSync).
Use vi.mock('fs') and vi.mock('./config.js').

STEP 6: Verify

Run these commands and fix any failures:
  npx tsc --noEmit
  npm test
  npm run lint
  npm run format:check

Ensure ALL existing tests still pass — the container-runner.test.ts and
jail-runtime.test.ts tests must not break from this refactor.

Report IMPLEMENTATION_COMPLETE when done.
```

### QA Prompt

```
TICKET: nc-p4b — QA validation for shared runner setup code extraction
WORKTREE: /tmp/nanoclaw-nc-p4b

READ FIRST:
- refinement/03252026/SHARED_INSTRUCTIONS.md (QA rules, baseline checks)

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only expected files
    Expected files: src/runner-setup.ts, src/runner-setup.test.ts,
    src/container-runner.ts, src/jail/runner.ts
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

TICKET-SPECIFIC CHECKS:

[ ] NO DUPLICATED CODE: Verify the settings.json creation logic does NOT appear in
    both container-runner.ts and jail/runner.ts anymore.
    Run: grep -n 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS' src/container-runner.ts src/jail/runner.ts
    Expected: zero matches in BOTH files. The string should only appear in src/runner-setup.ts.

[ ] NO DUPLICATED SKILLS SYNC: Verify the skills copy loop does NOT appear in
    both container-runner.ts and jail/runner.ts anymore.
    Run: grep -n 'fs.cpSync.*recursive' src/container-runner.ts src/jail/runner.ts
    Expected: zero matches in BOTH files. The logic should only be in src/runner-setup.ts.

[ ] SHARED MODULE EXISTS: Verify src/runner-setup.ts exists and exports:
    - getGroupSessionsDir(groupFolder: string): string
    - ensureGroupSettings(groupSessionsDir: string): void
    - syncContainerSkills(groupSessionsDir: string): void

[ ] IMPORTS CORRECT: Verify container-runner.ts imports from './runner-setup.js'
    and jail/runner.ts imports from '../runner-setup.js'.

[ ] JAIL PERMISSIONS PRESERVED: Verify jail/runner.ts still contains the chmod/chown
    block for jail-specific permissions (0o2775, group wheel).
    Run: grep -n 'chmodSync\|chownSync\|0o2775' src/jail/runner.ts
    Expected: at least 2 matches (chmod and chown calls).

[ ] SETTINGS CONTENT IDENTICAL: Verify the settings.json content in runner-setup.ts
    matches what was previously in both files:
    { env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
             CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
             CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' } }

[ ] BEHAVIORAL EQUIVALENCE: Run the existing test suites that exercise the runners:
    npx vitest run container-runner
    npx vitest run jail-runtime
    Both must pass with no modifications to test files.

[ ] TESTS EXIST: Verify src/runner-setup.test.ts exists and covers:
    - getGroupSessionsDir path construction
    - ensureGroupSettings creates/skips settings.json
    - syncContainerSkills copies directories and handles errors

Report QA_PASS or QA_FAIL with per-check breakdown.
```

---

## Stage 4C: Remove grammy from Core Dependencies

### Ticket Header

```yaml
id: nc-p4c
title: Remove grammy from core dependencies
priority: 2
tags: [nanoclaw, phase-4, upstream, dependencies, grammy]
files:
  - package.json (MODIFY — remove grammy from dependencies)
  - src/channels/telegram.ts (VERIFY — conditional import pattern)
dependencies: []
effort: Config change + verification
```

### Context

The Maintainer Report (section 4, observation 2) identifies grammy as a core dependency that should be optional: "grammy makes Telegram a core dependency rather than an optional channel. Upstream handled this by removing grammy from core and making Telegram a separate fork." The current `package.json` line 26 lists `"grammy": "^1.39.3"` in dependencies, adding ~5MB to node_modules for functionality that is optional.

Upstream explicitly removed grammy in commit `63f680d` ("chore: remove grammy and pin better-sqlite3/cron-parser versions"). The fork re-added it during a sync. Removing it from core aligns with upstream's dependency structure and reduces the install footprint for users who do not use Telegram.

### Developer Prompt

```
TICKET: nc-p4c — Remove grammy from core dependencies
WORKTREE: /tmp/nanoclaw-nc-p4c

READ FIRST:
- refinement/03252026/SHARED_INSTRUCTIONS.md (environment, coding standards, rules)
- package.json (line 26: grammy dependency)
- src/channels/telegram.ts (if it exists — check how grammy is imported)

OBJECTIVE:
Remove grammy from the core package.json dependencies. Telegram is a separate channel
fork (nanoclaw-telegram), not bundled in core. The grammy dependency should only exist
in the Telegram channel's own package.json.

STEP 1: Investigate grammy usage

Search for all imports and references to grammy in the codebase:
  grep -rn "grammy\|Grammy" src/ --include='*.ts'
  grep -rn "grammy" package.json

Identify every file that imports from grammy. Determine whether those files are:
a) Core files that always run (problem — must be refactored), or
b) Channel files that are conditionally loaded via the channel registry (safe to remove)

If grammy is imported in channel files only (loaded via dynamic import or channel
registry), the dependency can be safely removed from core package.json. The channel
fork provides its own package.json with grammy.

If grammy is imported in a core file, you must refactor that import to be conditional
(dynamic import wrapped in try/catch) before removing the dependency.

STEP 2: Remove grammy from package.json

Edit package.json to remove the grammy line from "dependencies":
  "grammy": "^1.39.3",

Do NOT remove it from devDependencies (it is not there, but verify).
Do NOT add it as an optionalDependency or peerDependency.

STEP 3: Verify build still works

Run:
  npx tsc --noEmit
  npm test
  npm run lint

If TypeScript compilation fails due to missing grammy types:
- The Telegram channel file must use dynamic import: const { Bot } = await import('grammy')
- Type annotations must use typeof patterns or be guarded with try/catch
- If the Telegram channel file is NOT part of the core build (check tsconfig.json
  include/exclude), then compilation should succeed without grammy installed.

If tests fail because they import grammy:
- Check if telegram.test.ts mocks grammy. If so, the mock should still work even
  without grammy installed, since vi.mock() intercepts the import.
- If telegram.test.ts requires grammy to be installed, add grammy to devDependencies
  instead: "grammy": "^1.39.3" under devDependencies. This keeps it out of production
  but available for testing.

STEP 4: Run npm install to regenerate package-lock.json

After modifying package.json:
  npm install

This will update the lock file to remove grammy from the dependency tree.

STEP 5: Final verification

  npx tsc --noEmit
  npm test
  npm run lint
  npm run format:check

Report IMPLEMENTATION_COMPLETE when done.
```

### QA Prompt

```
TICKET: nc-p4c — QA validation for grammy removal from core
WORKTREE: /tmp/nanoclaw-nc-p4c

READ FIRST:
- refinement/03252026/SHARED_INSTRUCTIONS.md (QA rules, baseline checks)

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only expected files
    Expected files: package.json, package-lock.json (and possibly src/channels/telegram.ts
    if import was refactored)
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

TICKET-SPECIFIC CHECKS:

[ ] GRAMMY NOT IN CORE DEPENDENCIES: Verify package.json "dependencies" does NOT
    contain "grammy".
    Run: node -e "const p=require('./package.json'); console.log(p.dependencies.grammy || 'NOT FOUND')"
    Expected: "NOT FOUND"

[ ] GRAMMY HANDLING: Verify one of:
    a) grammy is completely absent from package.json (not in dependencies or devDependencies), OR
    b) grammy is in devDependencies only (acceptable if tests require it)
    Run: grep grammy package.json
    Expected: either zero matches, or one match in devDependencies only.

[ ] NO CORE HARD IMPORTS: Verify no core source file (src/*.ts, excluding channel files)
    has a static import of grammy.
    Run: grep -rn "from 'grammy'" src/ --include='*.ts' | grep -v channels/ | grep -v '.test.ts'
    Expected: zero matches.

[ ] BUILD SUCCEEDS WITHOUT GRAMMY: Verify npm run build succeeds.
    Run: npm run build
    Expected: exit code 0, dist/ directory populated.

[ ] ALL EXISTING TESTS PASS: Run the full test suite.
    Run: npm test
    Expected: all tests pass. Any Telegram-specific tests should either pass
    (via mocks) or be skipped if grammy is not installed.

[ ] PACKAGE-LOCK UPDATED: Verify package-lock.json has been regenerated.
    Run: git diff --stat package-lock.json | head -1
    Expected: package-lock.json shows changes (grammy tree removed).

Report QA_PASS or QA_FAIL with per-check breakdown.
```

---

## Stage 4D: Sync High-Priority Upstream Features

### Ticket Header

```yaml
id: nc-p4d
title: Sync 3 high-priority upstream features (per-group triggers, timezone validation, CLAUDE.md template)
priority: 2
tags: [nanoclaw, phase-4, upstream, sync, features]
files:
  - src/index.ts (MODIFY — per-group triggers, CLAUDE.md template)
  - src/config.ts (MODIFY — timezone validation)
  - src/ipc.ts (MODIFY — CLAUDE.md template on group registration)
dependencies: [nc-p4a, nc-p4b]
effort: 2-3 hours
```

### Context

The BSD PM Report (section 7.1) identifies three upstream features that should be synced as high priority:

1. **Per-group trigger patterns** (upstream commit `0015931`): Allows different trigger words per group instead of a single global trigger. "Important usability feature."

2. **Timezone validation** (upstream commit `11847a1`): Prevents crashes from POSIX-style TZ values that the Intl API does not accept. "Safety fix that prevents crashes."

3. **CLAUDE.md template on group registration** (upstream commits `4e3189d`, `5a12ddd`): Creates CLAUDE.md from a template when registering groups via IPC, preventing empty group folders.

The Maintainer Report (section 2) lists all three among the "Features in Upstream, Missing from Fork" and confirms the fork-specific versions of these files have not integrated these changes. These features are purely additive and should merge cleanly alongside the fork's existing additions.

This ticket depends on 4A and 4B because those tickets may modify `container-runner.ts` imports and `config.ts` -- completing them first avoids merge conflicts within the phase.

### Developer Prompt

```
TICKET: nc-p4d — Sync 3 high-priority upstream features
WORKTREE: /tmp/nanoclaw-nc-p4d

READ FIRST:
- refinement/03252026/SHARED_INSTRUCTIONS.md (environment, coding standards, rules)
- src/index.ts (full file — understand the message loop and group registration)
- src/config.ts (full file — understand trigger pattern and timezone handling)
- src/ipc.ts (full file — understand group registration IPC flow)

OBJECTIVE:
Cherry-pick or manually implement three upstream features that are missing from the fork.
These are additive changes that do not conflict with jail-specific code.

IMPORTANT: Do NOT use `git cherry-pick` on the upstream commits directly — the files
have diverged too much. Instead, manually implement each feature by understanding what
upstream added and adapting it to the fork's codebase.

FEATURE 1: Per-group trigger patterns (upstream 0015931)

What upstream added:
- Groups can define a custom trigger pattern via containerConfig.triggerPattern
- The global TRIGGER_PATTERN is used as the default
- When matching incoming messages, use the group's trigger pattern if defined,
  otherwise fall back to the global one

Where to implement:
- src/config.ts: Export a helper function that builds a trigger RegExp from a string:
  export function buildTriggerPattern(name: string): RegExp {
    return new RegExp(`^@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  }
  Refactor the existing TRIGGER_PATTERN to use this helper.

- src/index.ts: In the message processing loop where TRIGGER_PATTERN is matched
  against incoming messages, check if the group has a custom triggerPattern in its
  containerConfig. If so, build a RegExp from it and use that instead of TRIGGER_PATTERN.

  Look for where messages are filtered by trigger pattern. It will be something like:
    if (TRIGGER_PATTERN.test(message.text)) { ... }
  Change to:
    const triggerPattern = group.containerConfig?.triggerPattern
      ? buildTriggerPattern(group.containerConfig.triggerPattern)
      : TRIGGER_PATTERN;
    if (triggerPattern.test(message.text)) { ... }

- src/types.ts: If ContainerConfig does not already have a triggerPattern field,
  add it as optional: triggerPattern?: string;

FEATURE 2: Timezone validation (upstream 11847a1)

What upstream added:
- POSIX-style TZ values (e.g., "EST5EDT") crash the Intl.DateTimeFormat API
- A validation function checks if the TZ value is a valid IANA timezone
- Falls back to 'UTC' if the detected timezone is invalid

Where to implement:
- src/config.ts: Add a validation wrapper around the TIMEZONE export:

  function isValidTimezone(tz: string): boolean {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }

  Then modify the TIMEZONE export:
  const rawTZ = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
  export const TIMEZONE = isValidTimezone(rawTZ) ? rawTZ : 'UTC';

  If the existing code already uses a different pattern, adapt accordingly. The key
  requirement is: invalid TZ values must fall back to 'UTC' instead of crashing.

- Check if src/timezone.test.ts exists. If so, add a test for the validation.
  If not, the existing tests should still pass.

FEATURE 3: CLAUDE.md template on group registration (upstream 4e3189d, 5a12ddd)

What upstream added:
- When a new group is registered via IPC, if the group folder does not contain
  a CLAUDE.md file, create one from a template
- The template includes the group name and basic instructions

Where to implement:
- src/ipc.ts: In the handler for group registration (look for where new groups are
  added — it will involve creating the group directory and writing initial config),
  add logic to create CLAUDE.md if it doesn't exist:

  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) {
    const template = `# ${groupName}\n\nGroup memory and instructions for ${groupName}.\n`;
    fs.writeFileSync(claudeMdPath, template);
  }

  Find the exact location where group directories are created and add this after
  the mkdirSync call.

- Also check src/index.ts for startup group registration — if groups are registered
  at startup (iterating existing group folders), the same CLAUDE.md creation should
  apply there too.

STEP-BY-STEP IMPLEMENTATION:

1. Read src/config.ts, src/index.ts, src/ipc.ts, and src/types.ts fully.
2. Implement Feature 2 (timezone validation) in config.ts — smallest, safest change.
3. Implement Feature 1 (per-group triggers) in config.ts, types.ts, and index.ts.
4. Implement Feature 3 (CLAUDE.md template) in ipc.ts and/or index.ts.
5. Run: npx tsc --noEmit && npm test && npm run lint && npm run format:check
6. Fix any failures.

IMPORTANT: These are ADDITIVE changes. Do not refactor existing code. Do not remove
fork-specific additions. Do not modify jail-specific code. Each feature should be
a small, self-contained addition.

Report IMPLEMENTATION_COMPLETE when done.
```

### QA Prompt

```
TICKET: nc-p4d — QA validation for upstream feature sync
WORKTREE: /tmp/nanoclaw-nc-p4d

READ FIRST:
- refinement/03252026/SHARED_INSTRUCTIONS.md (QA rules, baseline checks)
- reports/nanoclaw_bsd_pm_report.md (section 7.1 — feature descriptions)

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only expected files
    Expected files: src/config.ts, src/index.ts, src/ipc.ts (and possibly src/types.ts)
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

TICKET-SPECIFIC CHECKS:

FEATURE 1 — Per-group trigger patterns:
[ ] HELPER EXISTS: Verify src/config.ts exports a buildTriggerPattern function.
    Run: grep -n 'export.*buildTriggerPattern' src/config.ts
    Expected: one match.

[ ] TRIGGER REFACTORED: Verify the existing TRIGGER_PATTERN uses the new helper
    (or is still valid independently). The global trigger must still work.

[ ] PER-GROUP USAGE: Verify src/index.ts references containerConfig.triggerPattern
    or uses the per-group pattern when matching messages.
    Run: grep -n 'triggerPattern' src/index.ts
    Expected: at least one match showing per-group trigger logic.

[ ] GLOBAL FALLBACK: Verify the global TRIGGER_PATTERN is used when a group does
    not define a custom trigger.

FEATURE 2 — Timezone validation:
[ ] VALIDATION EXISTS: Verify src/config.ts contains timezone validation logic.
    Run: grep -n 'isValidTimezone\|Intl.DateTimeFormat.*timeZone' src/config.ts
    Expected: validation function present.

[ ] FALLBACK TO UTC: Verify invalid timezones fall back to 'UTC'.
    Run: grep -n 'UTC' src/config.ts
    Expected: fallback to 'UTC' visible in the TIMEZONE export logic.

[ ] NO CRASH ON POSIX TZ: Conceptually verify that a POSIX-style TZ like "EST5EDT"
    would be caught by the validation and replaced with 'UTC' (read the code logic).

FEATURE 3 — CLAUDE.md template on group registration:
[ ] TEMPLATE CREATION: Verify CLAUDE.md template creation exists in IPC handler.
    Run: grep -n 'CLAUDE.md' src/ipc.ts
    Expected: at least one match showing CLAUDE.md creation logic.

[ ] CONDITIONAL CREATION: Verify the template is only created if CLAUDE.md does
    not already exist (existsSync check before writeFileSync).
    Run: grep -A2 'CLAUDE.md' src/ipc.ts | grep 'existsSync'
    Expected: existence check present.

[ ] TEMPLATE CONTENT: Verify the template includes the group name.
    Read the template string and confirm it personalizes with the group name.

CROSS-CUTTING CHECKS:
[ ] JAIL CODE UNCHANGED: Verify no files in src/jail/ have been modified.
    Run: git diff --stat src/jail/
    Expected: empty.

[ ] EXISTING FEATURES PRESERVED: Verify fork-specific additions in config.ts are
    still present (HEALTH_ENABLED, METRICS_ENABLED, LOG_ROTATION_*, clampInt).
    Run: grep -n 'HEALTH_ENABLED\|METRICS_ENABLED\|LOG_ROTATION\|clampInt' src/config.ts
    Expected: all still present.

[ ] CREDENTIAL PROXY UNCHANGED: Verify src/credential-proxy.ts has zero changes.
    Run: git diff src/credential-proxy.ts
    Expected: empty.

Report QA_PASS or QA_FAIL with per-check breakdown.
```

---

## Phase Integration QA

After all four stage tickets (nc-p4a through nc-p4d) pass their individual QA, run this integration validation on the merged phase branch.

### Integration QA Prompt

```
PHASE 4 INTEGRATION QA — Upstream Merge Friction Reduction
BRANCH: The merged phase-4 branch containing all four stage branches.

READ FIRST:
- refinement/03252026/SHARED_INSTRUCTIONS.md (QA rules, baseline checks)
- refinement/03252026/PHASE_PLAN.md (Phase 4 acceptance criteria)

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] Build succeeds: npm run build

INTEGRATION CHECKS:

[ ] ONECLI SHIM RESOLVES: Verify that '@onecli-sh/sdk' resolves to the shim.
    The tsconfig.json paths mapping must be present and working.
    Run: npx tsc --noEmit (sufficient — if it compiles, the mapping works)

[ ] SETTINGS.JSON SINGLE SOURCE: Verify the settings.json content
    (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, etc.) appears in exactly ONE file.
    Run: grep -rn 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS' src/ --include='*.ts' | grep -v '.test.ts'
    Expected: exactly one match, in src/runner-setup.ts.

[ ] GRAMMY NOT IN PROD DEPENDENCIES: Verify grammy is not in runtime dependencies.
    Run: node -e "const p=require('./package.json'); console.log(Object.keys(p.dependencies).join(', '))"
    Expected: grammy not in the list.

[ ] PER-GROUP TRIGGERS WORK: Verify per-group trigger logic is present.
    Run: grep -n 'triggerPattern' src/index.ts src/config.ts
    Expected: matches in both files.

[ ] TIMEZONE VALIDATION WORKS: Verify timezone fallback is present.
    Run: grep -n 'isValidTimezone\|UTC' src/config.ts
    Expected: validation + UTC fallback.

[ ] CLAUDE.MD TEMPLATE WORKS: Verify template creation in IPC handler.
    Run: grep -n 'CLAUDE.md' src/ipc.ts
    Expected: template creation logic.

[ ] NO REGRESSIONS IN JAIL CODE: Verify all jail-specific tests pass.
    Run: npx vitest run jail
    Expected: all jail tests pass.

[ ] NO REGRESSIONS IN CORE: Verify all non-jail tests pass.
    Run: npx vitest run --exclude='**/jail-*'
    Expected: all core tests pass.

[ ] MERGE FRICTION REDUCTION VALIDATION: Assess the diff surface against upstream.
    The key metric: how many lines in src/container-runner.ts differ from what
    upstream would have? After 4A (shim) and 4B (shared runner code), the fork's
    container-runner.ts should have minimal fork-specific additions.
    Run: wc -l src/container-runner.ts
    Note the line count. The shim (4A) should eventually allow reverting this file
    to upstream — but that revert is a future task, not part of this phase.

[ ] FILE INVENTORY: Verify the phase created/modified only expected files:
    New files: src/onecli-shim.ts, src/onecli-shim.test.ts, src/runner-setup.ts,
              src/runner-setup.test.ts
    Modified files: tsconfig.json, package.json, package-lock.json, src/config.ts,
                    src/container-runner.ts, src/jail/runner.ts, src/index.ts,
                    src/ipc.ts (and possibly src/types.ts)
    Run: git diff --stat main
    Verify no unexpected files appear.

ACCEPTANCE CRITERIA (from PHASE_PLAN.md):
[ ] OneCLI shim passes unit tests matching upstream SDK interface
[ ] Settings.json and skills sync logic exist in one place (src/runner-setup.ts)
[ ] grammy not in core package.json dependencies
[ ] Per-group triggers work (buildTriggerPattern + per-group matching)
[ ] Timezone validation prevents crashes on POSIX TZ values
[ ] CLAUDE.md template creation works on group registration

Report QA_PASS or QA_FAIL with per-check breakdown.
```
