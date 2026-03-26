# Prompt 1: Fold Audit Gaps into Existing Phases

Use this prompt after `/clear`. Copy everything below the line and paste it.

---

## Project Context

You are working on the NanoClaw-BSD refinement project -- a FreeBSD jail fork of the NanoClaw personal AI assistant. The project has a 9-phase refinement plan in `refinement/03252026/` with detailed phase implementation documents. A coverage audit found gaps: items from the synthesis report (`reports/synthesis_report.md`) that are missing from the phase plan. Your job is to fold these gaps into the existing phases by updating the plan and the phase documents.

The project root is the current working directory. Key paths:
- `CLAUDE.md` — project conventions, key file map
- `refinement/03252026/PHASE_PLAN.md` — master phase plan (9 phases, ~34 tickets)
- `refinement/03252026/SHARED_INSTRUCTIONS.md` — shared conventions for all prompts
- `refinement/03252026/PHASE_3_OPERATIONAL_HARDENING.md` — Phase 3 doc (you will append to this)
- `refinement/03252026/PHASE_5_CI_CD.md` — Phase 5 doc (you will append to this)
- `refinement/03252026/PHASE_7_DOCUMENTATION.md` — Phase 7 doc (you will modify and append to this)
- `reports/synthesis_report.md` — source of truth for all findings

## Files This Prompt Modifies (Exactly 4)

| File | Action |
|------|--------|
| `refinement/03252026/PHASE_PLAN.md` | Update: add stage rows to Phases 3/5/7, update summary table, update acceptance criteria, add Known Backlog section |
| `refinement/03252026/PHASE_3_OPERATIONAL_HARDENING.md` | Update: append stages 3E and 3F at the end (before the Phase Integration QA section) |
| `refinement/03252026/PHASE_5_CI_CD.md` | Update: append stage 5D at the end (before the Phase Integration QA section) |
| `refinement/03252026/PHASE_7_DOCUMENTATION.md` | Update: expand the nc-p7a developer prompt; append stage 7E at the end (before the Phase Integration QA section) |

Files NOT modified: PHASE_1, PHASE_2, PHASE_4, PHASE_6, PHASE_8, PHASE_9, SHARED_INSTRUCTIONS.md, and all source code.

## Step 1: Read Files

Read ALL of the following before making any changes:

1. `CLAUDE.md` (project conventions)
2. `refinement/03252026/PHASE_PLAN.md` (current plan)
3. `refinement/03252026/SHARED_INSTRUCTIONS.md` (prompt conventions)
4. `reports/synthesis_report.md` (findings source)
5. `refinement/03252026/PHASE_3_OPERATIONAL_HARDENING.md` (format reference AND target)
6. `refinement/03252026/PHASE_5_CI_CD.md` (target)
7. `refinement/03252026/PHASE_7_DOCUMENTATION.md` (target)
8. Source files needed for developer/QA prompts:
   - `scripts/setup-freebsd.sh` (for 3E — find devfs.rules insertion point)
   - `etc/devfs.rules` (for 3E — understand what's installed)
   - `etc/pf-nanoclaw.conf` (for 3F — find hardcoded paths)
   - `vitest.config.ts` (for 5D — current coverage config)
   - `eslint.config.mjs` (for 5D — current no-catch-all rule)
   - `.github/workflows/ci.yml` (for 5D — current CI steps)
   - `docs/DEBUG_CHECKLIST.md` (for 7E — current structure)

## Step 2: Understand the Stage Format

Every stage in a phase document follows this exact structure (taken from PHASE_3 stage 3A as the canonical example):

```markdown
## Stage XX: Title

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-pXx` |
| **Title** | Short title |
| **Priority** | P0/P1/P2 |
| **Tags** | `nanoclaw`, `phase-X`, `relevant-tag` |
| **Files** | `path/to/file.ts` |
| **Dependencies** | None (within phase) |
| **Effort** | ~N lines |

### Context

Paragraph explaining what the issue is, which report section identified it (with
specific section name and line references), why it matters, and what the current
code looks like (with file:line references from the source files you read in Step 1).

### Developer Prompt

\```
Read refinement/03252026/SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-pXx — Title
FILES: path/to/file

CONTEXT:
Brief explanation of the problem.

CHANGES:

1. Read path/to/file and find [specific thing].
2. Make [specific change] at [specific location].
3. [More steps with exact code snippets where helpful.]
4. Run: npm test
5. Run: npx tsc --noEmit
6. Run: npm run lint
7. Run: npm run format:check

IMPLEMENTATION_COMPLETE
\```

### QA Prompt

\```
Read refinement/03252026/SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-pXx — Title
FILES TO VALIDATE: path/to/file

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only expected files
[ ] No secrets or credentials in diff

TICKET-SPECIFIC CHECKS:

[ ] [Specific check with exact expected content/behavior]
[ ] [Another specific check]

Report each check as PASS or FAIL with details.
Final output: QA_PASS or QA_FAIL
\```
```

**Important**: When appending new stages to an existing phase document, insert them BEFORE the `## Phase Integration QA` section at the bottom. Then update the Phase Integration QA to include checks for the new stages.

## Step 3: Add New Stages

### 3E: Install devfs.rules in setup-freebsd.sh (add to PHASE_3)

**Source**: Synthesis Section 4 UX pain point 5; Section 7 Short-Term P1; Appendix B (User + Sysadmin)

After reading `scripts/setup-freebsd.sh`, find the section where pf rules are installed and the section where the rc.d script is installed. The devfs.rules installation should go between them. After reading `etc/devfs.rules`, note the ruleset number (10) referenced by `src/jail/lifecycle.ts` in the jail.conf `devfs_ruleset` parameter.

Write the developer prompt to:
- Copy `etc/devfs.rules` to `/etc/devfs.rules`
- Add the copy as a new function in the setup script matching the existing function pattern
- Reload devfs rules with `service devfs restart` if devfs is running
- Be idempotent (check if already installed, skip if identical)

Write the QA prompt to verify:
- The new function exists in setup-freebsd.sh
- It copies etc/devfs.rules to /etc/devfs.rules
- It is called in the correct order (after pf, before rc.d)
- The ruleset number matches what lifecycle.ts expects

### 3F: Parameterize hardcoded path in pf config (add to PHASE_3)

**Source**: Synthesis Section 4 UX pain point 4; FreeBSD User Report Section 4 (hardcoded `/home/jims/code/nanoclaw/src/`)

After reading `etc/pf-nanoclaw.conf`, find all instances of `/home/jims/code/nanoclaw/src/` or `/home/jims/`. These appear in the MANUAL SETUP comment section.

Write the developer prompt to:
- Replace hardcoded paths with a placeholder like `NANOCLAW_SRC_DIR_PLACEHOLDER` or generic `/path/to/nanoclaw/src`
- Add a comment noting that `setup-freebsd.sh` substitutes the actual path during installation
- Verify `setup-freebsd.sh` already does the sed substitution (it uses `NANOCLAW_EXT_IF_PLACEHOLDER` substitution — confirm the path substitution pattern)

Write the QA prompt to verify:
- No instances of `/home/jims/` remain in `etc/pf-nanoclaw.conf`
- The placeholder is documented with a comment
- `pfctl -nf etc/pf-nanoclaw.conf` still parses without syntax errors (the hardcoded path is in comments, so this should always pass, but verify)

### 5D: Coverage enforcement + ESLint no-catch-all promotion (add to PHASE_5)

**Source**: Synthesis Section 3 CI/CD Gaps (coverage); Section 3 Maintainability #3 (empty catch blocks)

After reading `vitest.config.ts`, `eslint.config.mjs`, and `.github/workflows/ci.yml`:

Write the developer prompt to make two changes:
1. In `vitest.config.ts`: add coverage configuration with thresholds (e.g., statements: 50, branches: 40, functions: 40, lines: 50 — conservative to start, matching current levels)
2. In `eslint.config.mjs`: find the `no-catch-all` rule and change its severity from `warn` to `error`
3. In `.github/workflows/ci.yml`: add `--coverage` flag to the vitest run step

Write the QA prompt to verify:
- vitest.config.ts has coverage thresholds defined
- eslint.config.mjs has `no-catch-all` set to `error` (not `warn`)
- CI workflow includes `--coverage`
- `npm test` still passes (if existing empty catch blocks fail the promoted lint rule, the developer must fix them first)
- `npm run lint` still passes (same — if empty catches now error, they must be addressed)

### Expand nc-p7a in PHASE_7 (modify existing stage)

**Source**: Synthesis Section 4 Documentation Gaps #3, #6, #7; UX pain point 1

Find the existing nc-p7a developer prompt in `PHASE_7_DOCUMENTATION.md`. It describes writing a "Getting Started with NanoClaw on FreeBSD" guide. Append these additional required sections to the developer prompt's outline:

```
ADDITIONAL REQUIRED SECTIONS (append to the getting-started outline):

## How Credentials Flow (Credential Proxy)
- Explain the credential proxy architecture for FreeBSD jails
- How API keys move from .env → proxy → jail (via per-jail tokens)
- Diagram or step-by-step: agent sends request → proxy injects real key → forwards to Anthropic
- Reference: reports/synthesis_report.md Section 4, Documentation Gap #6

## Adding Channels
- How to add Telegram, Slack, Discord, Gmail on FreeBSD
- Whether Claude Code CLI is needed on the host for channel setup
- Alternative: editing .env directly with channel tokens
- Reference: reports/synthesis_report.md Section 4, Documentation Gap #3

## Log Locations
- Development: logs/nanoclaw.log (relative to cwd, via pino rotating-file-stream)
- Production via rc.d: /var/log/nanoclaw.log (via daemon -o flag)
- Per-group agent logs: groups/*/logs/
- Reference: reports/synthesis_report.md Section 4, Documentation Gap #7

## Understanding the Two Setup Scripts
- setup-freebsd.sh: full bootstrap (10 steps, runs once on fresh system)
- setup-jail-template.sh: template finalization (runs after code updates)
- Relationship: setup-freebsd.sh calls setup-jail-template.sh at the end
- When to run each one independently
- Reference: reports/synthesis_report.md Section 4, UX pain point 1
```

Also update the nc-p7a QA prompt to add checks for these 4 new sections existing in the guide.

### 7E: Update DEBUG_CHECKLIST.md for FreeBSD-first ordering (add to PHASE_7)

**Source**: Synthesis Section 4 Documentation Gap #5

After reading `docs/DEBUG_CHECKLIST.md`, note the current structure (macOS/Docker commands first, FreeBSD section further down).

Write the developer prompt to:
- Add a navigation note at the very top: "**FreeBSD/Jail users**: Jump to [FreeBSD Jails section](#freebsd-jails)."
- Optionally reorder sections so FreeBSD comes before macOS (use judgment based on the document structure — if reordering would break the flow, the navigation note alone is sufficient)

Write the QA prompt to verify:
- A navigation note for FreeBSD users exists in the first 10 lines
- The FreeBSD section anchor link works (the target heading exists)
- No content was deleted or corrupted during editing

## Step 4: Update PHASE_PLAN.md

After all phase documents are updated, make these changes to `PHASE_PLAN.md`:

1. **Phase Summary table**: Update ticket counts — Phase 3: 4→6, Phase 5: 3→4, Phase 7: 4→5
2. **Phase 3 stage table**: Add rows for 3E and 3F
3. **Phase 5 stage table**: Add row for 5D
4. **Phase 7 stage table**: Add row for 7E
5. **Phase 3 Acceptance criteria**: Add "devfs.rules installed by setup script. No hardcoded paths in pf config."
6. **Phase 5 Acceptance criteria**: Add "Coverage thresholds enforced in CI. ESLint no-catch-all set to error."
7. **Phase 7 Acceptance criteria**: Add "Getting-started guide covers credential proxy, channel setup, log locations, and two-script relationship. DEBUG_CHECKLIST.md has FreeBSD navigation note."
8. **Add new section** at the bottom called `## Known Backlog (Not Scheduled)` with this content:

```markdown
## Known Backlog (Not Scheduled)

Items from `reports/synthesis_report.md` intentionally deferred. These may be promoted
to Phases 10+ in a future planning session.

### P2-P3 Operational (candidates for Phase 10-12)
- `index.ts` tests and refactoring (P3 Medium-Term, Maintainer)
- Template versioning — write version file during template build (P2, PM)
- Deployment SOP documentation (P2 Operational Gap, SRE)
- DR procedure documentation (P3, SRE)
- Off-host backup via zfs send (P3, SRE)
- ZFS snapshot cron for data directories (P3, SRE)

### P3 FreeBSD Features (candidates for Phase 11-12)
- cpuset pinning for jails (P3, Sysadmin)
- Additional rctl limits: readbps, writebps, openfiles, wallclock (P3, Sysadmin)
- Chromium as optional jail template addon (P3, Comparison)
- ZFS send/receive for template distribution (P3, BSD PM)
- Blue/green template automation (P4, PM/SRE)

### P4 Long-Term / Speculative
- bhyve runtime for Linux container compatibility (P4, BSD PM)
- Web dashboard (P4, PM)
- IPFW support as pf alternative (P4, BSD PM)
- MAC framework integration (P4, Sysadmin)
- auditd integration for OS-level audit trails (P4, Sysadmin)

### Not Ticketable
- Submit upstream PR src-e9mq (intentionally manual per CLAUDE.md)
- User ID mapping gap — jail uses uid 1000 vs Docker host UID (Low priority)
- Upstream sync cadence strategy (ongoing process decision)
- Anthropic SDK vendor lock-in (unavoidable, monitor)
```

## Step 5: Update Phase Integration QA Sections

After adding new stages to each phase document, update the Phase Integration QA section at the bottom of each modified file to include validation checks for the new stages:

- **PHASE_3**: Add checks for devfs.rules installation order and pf config having no hardcoded paths
- **PHASE_5**: Add check that coverage + lint rule changes don't break existing tests
- **PHASE_7**: Add checks that the getting-started guide covers all 4 new documentation gap topics and that DEBUG_CHECKLIST.md navigation note exists

## Step 6: Verify Consistency

After all changes are complete, verify:
- Every stage row in PHASE_PLAN.md Phase 3 table has a matching `## Stage 3X` section in PHASE_3_OPERATIONAL_HARDENING.md
- Every stage row in PHASE_PLAN.md Phase 5 table has a matching `## Stage 5X` section in PHASE_5_CI_CD.md
- Every stage row in PHASE_PLAN.md Phase 7 table has a matching `## Stage 7X` section in PHASE_7_DOCUMENTATION.md
- The Phase Summary table ticket counts match the actual number of stages in each phase section
- Report any inconsistencies found

## Execution

You may use subagents to parallelize the phase document updates since they touch different files:
- Subagent 1: Update PHASE_3_OPERATIONAL_HARDENING.md (stages 3E, 3F + integration QA)
- Subagent 2: Update PHASE_5_CI_CD.md (stage 5D + integration QA)
- Subagent 3: Update PHASE_7_DOCUMENTATION.md (expand 7A, add 7E + integration QA)

After all subagents complete, update PHASE_PLAN.md (Step 4) and run verification (Step 6) yourself.

Do not create any new files. Do not modify any source code files. Only update the 4 refinement planning documents listed in the file manifest.
