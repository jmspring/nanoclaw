# Prompt 2: Generate Phase Documents for Backlog Items

**Prerequisite**: Prompt 1 (`PROMPT_1_FOLD_GAPS.md`) must have been executed first. This prompt reads state that Prompt 1 created.

Use this prompt after `/clear`. Copy everything below the line and paste it.

---

## Project Context

You are working on the NanoClaw-BSD refinement project -- a FreeBSD jail fork of the NanoClaw personal AI assistant. A prior session (Prompt 1) updated the refinement plan to fold small audit gaps into existing Phases 3, 5, and 7 and added a "Known Backlog (Not Scheduled)" section to `PHASE_PLAN.md`. Your job is to promote the P2-P3 backlog items into concrete Phases 10, 11, and 12 with full implementation documents.

The project root is the current working directory. Key paths:
- `CLAUDE.md` — project conventions, key file map
- `refinement/03252026/PHASE_PLAN.md` — master phase plan (currently Phases 1-9 + Known Backlog)
- `refinement/03252026/SHARED_INSTRUCTIONS.md` — shared conventions for all prompts
- `reports/synthesis_report.md` — source of truth for all findings
- `reports/sre_report.md` — operational items (backup, DR, deployment, template versioning)
- `reports/maintainer_report.md` — code quality (index.ts tests, upstream sync)
- `reports/nanoclaw_bsd_pm_report.md` — FreeBSD features (cpuset, rctl, ZFS, Chromium, bhyve)
- `reports/docker_vs_jails_report.md` — feature parity (Chromium, user ID mapping)

## Prerequisite Verification

Before doing any work, read `refinement/03252026/PHASE_PLAN.md` and verify it contains a section titled `## Known Backlog (Not Scheduled)`. This section should list items like "index.ts tests", "Template versioning", "Off-host backup via zfs send", etc.

**If this section does NOT exist, STOP immediately and report**: "BLOCKED: PHASE_PLAN.md does not contain a 'Known Backlog' section. Prompt 1 must be executed first."

## Files This Prompt Modifies (Exactly 4)

| File | Action |
|------|--------|
| `refinement/03252026/PHASE_10_CODE_QUALITY.md` | **Create new**: 4 stages with full developer/QA prompts |
| `refinement/03252026/PHASE_11_OPERATIONAL_INFRA.md` | **Create new**: 4 stages with full developer/QA prompts |
| `refinement/03252026/PHASE_12_PLATFORM_FEATURES.md` | **Create new**: 4 stages with full developer/QA prompts |
| `refinement/03252026/PHASE_PLAN.md` | Update: add Phases 10-12 sections, update summary table, update dependency graph, update success criteria, trim Known Backlog |

Files NOT modified: PHASE_1 through PHASE_9, SHARED_INSTRUCTIONS.md, PROMPT_1_FOLD_GAPS.md, and all source code.

## Step 1: Read Files

Read ALL of the following before creating any documents:

1. `CLAUDE.md` (project conventions)
2. `refinement/03252026/PHASE_PLAN.md` (current plan — verify Known Backlog exists)
3. `refinement/03252026/SHARED_INSTRUCTIONS.md` (prompt conventions)
4. `refinement/03252026/PHASE_3_OPERATIONAL_HARDENING.md` (**format reference** — read the first 2 stages to understand the exact structure of ticket headers, context, developer prompts, QA prompts, and the Phase Integration QA at the end)
5. `reports/synthesis_report.md` (findings source)
6. `reports/sre_report.md` (Sections 6-7 for deployment, backup, DR)
7. `reports/maintainer_report.md` (Section 5 for test coverage, Section 3 for index.ts complexity)
8. `reports/nanoclaw_bsd_pm_report.md` (Sections 4.5-4.8 for FreeBSD features)
9. `reports/docker_vs_jails_report.md` (Sections 4, 9 for Chromium gap)
10. Source files needed for developer/QA prompts:
    - `src/index.ts` (for 10A — understand structure, find testable functions, note line count)
    - `scripts/setup-jail-template.sh` (for 10B — find snapshot creation point)
    - `src/jail/lifecycle.ts` (for 10B startup check, 11C cpuset, 11D rctl limits — find rctl application block)
    - `src/jail/config.ts` (for 11C, 11D — find existing env var patterns)
    - `scripts/setup-freebsd.sh` (for 11B — find cron installation point)
    - `container/Dockerfile` (for 12A — find Chromium packages)
    - `src/jail/config.ts` (for 12C — find template config vars)

## Step 2: Stage Format Template

Every stage in a phase document MUST follow this exact structure. This is the canonical format used by all existing phase documents:

```markdown
## Stage XX: Title

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-pXx` |
| **Title** | Short title |
| **Priority** | P2/P3/P4 |
| **Tags** | `nanoclaw`, `phase-X`, `relevant-tag` |
| **Files** | `path/to/file.ts`, `path/to/other.ts` |
| **Dependencies** | None (within phase) OR nc-pYy |
| **Effort** | ~N lines / Medium / Large |

### Context

Paragraph explaining what the issue is, which report section identified it (with
specific section name), why it matters, and what the current code looks like
(with file:line references from the source files you read in Step 1).

**Impact**: What changes with this fix/feature.

### Developer Prompt

\```
Read refinement/03252026/SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-pXx — Title
FILES: path/to/file

CONTEXT:
Brief explanation of the problem and what needs to change.

CHANGES:

1. Read path/to/file and find [specific function/section/line].

2. [Specific change with code snippets where helpful]:
   \```typescript
   // example code
   \```

3. [More numbered steps...]

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
[ ] [Check referencing specific file:line or output format]

Report each check as PASS or FAIL with details.
Final output: QA_PASS or QA_FAIL
\```
```

Each phase document also ends with a `## Phase Integration QA` section containing a single prompt that validates all stages work together. See the bottom of PHASE_3_OPERATIONAL_HARDENING.md for the format.

## Step 3: Create Phase Documents

### Phase 10: Code Quality and Testing

Write to: `refinement/03252026/PHASE_10_CODE_QUALITY.md`

**Header:**
```
# Phase 10: Code Quality and Testing

**Priority**: P2-P3
**Depends on**: Phase 4 (upstream friction reduction), Phase 5 (CI/CD)
**Source reports**: `reports/maintainer_report.md`, `reports/sre_report.md`
```

**Stages:**

| Stage | ID | Title | Source Files to Read | Key Detail |
|-------|----|-------|---------------------|------------|
| 10A | nc-p10a | Add index.ts tests | `src/index.ts` | 895 lines, zero tests. Maintainer Report Section 5 details gap. Focus on `processGroupMessages`, `runAgent`, shutdown handler. Mock channels, db, container-runner. Create `src/index.test.ts`. |
| 10B | nc-p10b | Add template versioning | `scripts/setup-jail-template.sh`, `src/jail/lifecycle.ts` | Write `/etc/nanoclaw-template-version` during template build (version, timestamp, node version). Add startup check in lifecycle.ts that warns if stale. ~30 lines. SRE Report Section 5 Operational Gaps. |
| 10C | nc-p10c | Add deployment SOP documentation | SRE Report Section 6 | Create `docs/DEPLOYMENT.md`. Cover: standard deploy (git pull, npm ci, build, restart), blue/green template updates, rollback via git, pre-deploy checklist. No code changes — document only. |
| 10D | nc-p10d | Document disaster recovery procedure | SRE Report Section 7 | Create `docs/DISASTER_RECOVERY.md`. Cover: ZFS pool degradation, host crash during jail creation, pf rule corruption, template corruption, database corruption (WAL recovery), full rebuild from scratch. No code changes — document only. |

For each stage: read the source files listed, write the developer prompt with specific file:line references from what you read, write the QA prompt with baseline + ticket-specific checks. For doc-only tickets (10C, 10D), QA checks verify file exists, all required sections present, no broken internal references.

End with Phase Integration QA.

### Phase 11: Operational Infrastructure

Write to: `refinement/03252026/PHASE_11_OPERATIONAL_INFRA.md`

**Header:**
```
# Phase 11: Operational Infrastructure

**Priority**: P3
**Depends on**: Phase 6 (operational maturity), Phase 8 (FreeBSD features)
**Source reports**: `reports/sre_report.md`, `reports/freebsd_sysadmin_report.md`
```

**Stages:**

| Stage | ID | Title | Source Files to Read | Key Detail |
|-------|----|-------|---------------------|------------|
| 11A | nc-p11a | Add off-host backup via zfs send | SRE Report Section 7 | Create `scripts/backup-offhost.sh` using `zfs send` with incremental snapshots. Create `docs/BACKUP.md` covering strategy, retention, verification, restore. SRE Report Section 7.2 for specific gaps. |
| 11B | nc-p11b | Add ZFS snapshot cron job for data directories | SRE Report Section 7.3, `scripts/setup-freebsd.sh` | Create `etc/cron.d/nanoclaw-snapshots` with 4-hourly `zfs snapshot -r`. Add installation to setup-freebsd.sh. Include pruning (keep 42 = 7 days). ~15 lines. |
| 11C | nc-p11c | Add cpuset pinning for jails | `src/jail/lifecycle.ts`, `src/jail/config.ts` | After rctl limits are applied in lifecycle.ts, add optional `cpuset -l <cpus> -j <jailname>`. Add `NANOCLAW_JAIL_CPUSET` env var. Follow existing `clampInt()` config pattern. FreeBSD Sysadmin Report Section 10.1. ~20 lines. |
| 11D | nc-p11d | Add additional rctl limits | `src/jail/lifecycle.ts` lines 130-163, `src/jail/config.ts` | Add `readbps`, `writebps`, `openfiles`, `wallclock` to rctl block. Follow existing pattern: env var → `clampInt()` → `rctl -a`. FreeBSD Sysadmin Report Section 10.2. ~30 lines. |

For each stage: read the source files listed, find the exact insertion points and existing patterns, write developer and QA prompts with file:line references.

End with Phase Integration QA. Integration QA should verify cpuset and rctl additions don't conflict and that backup/cron scripts are installable.

### Phase 12: Platform Features and Parity

Write to: `refinement/03252026/PHASE_12_PLATFORM_FEATURES.md`

**Header:**
```
# Phase 12: Platform Features and Parity

**Priority**: P3-P4
**Depends on**: Phase 8 (FreeBSD features)
**Source reports**: `reports/nanoclaw_bsd_pm_report.md`, `reports/docker_vs_jails_report.md`
```

**Stages:**

| Stage | ID | Title | Source Files to Read | Key Detail |
|-------|----|-------|---------------------|------------|
| 12A | nc-p12a | Add Chromium as optional jail template addon | `container/Dockerfile` (see Chromium packages), BSD PM Report Section 5.3 | Create `scripts/add-chromium-to-template.sh`. Boot template jail, `pkg install chromium`, re-snapshot. Document as optional (~500MB size increase). |
| 12B | nc-p12b | Add ZFS send/receive for template distribution | BSD PM Report Section 4.6 | Create `scripts/export-template.sh` and `scripts/import-template.sh`. Use `zfs send template@base > file` and `zfs receive < file`. SHA-256 verification. |
| 12C | nc-p12c | Implement blue/green template automation | `scripts/setup-jail-template.sh` (already supports template name arg), `src/jail/config.ts` | Automate full workflow: build new template → verify → switch `NANOCLAW_TEMPLATE_NAME` → clean up old. BSD PM Report Section 4.8, SRE Report Section 6.2. |
| 12D | nc-p12d | Investigate bhyve runtime for Linux container compatibility | BSD PM Report Section 4.5 | **Research ticket**: deliverable is `docs/BHYVE_INVESTIGATION.md`, NOT code. Cover: bhyve feasibility, performance overhead, 9pfs/virtio-fs mounts, go/no-go recommendation. Developer prompt must note implementation is out of scope. |

For each stage: read the source files listed, write developer and QA prompts. For 12D (research), QA checks verify the investigation doc exists and covers all required topics.

End with Phase Integration QA.

## Step 4: Update PHASE_PLAN.md

After all 3 phase documents are created, make these changes to `refinement/03252026/PHASE_PLAN.md`:

### 4a. Phase Summary Table

Add 3 rows:

| Phase | Name | Focus | Tickets | Dependencies |
|-------|------|-------|---------|-------------|
| 10 | Code Quality and Testing | index.ts tests, template versioning, deployment/DR docs | 4 | Phases 4, 5 |
| 11 | Operational Infrastructure | Off-host backup, ZFS snapshot cron, cpuset, additional rctl limits | 4 | Phases 6, 8 |
| 12 | Platform Features and Parity | Chromium addon, ZFS send/receive, blue/green automation, bhyve investigation | 4 | Phase 8 |

### 4b. Phase Sections

Add full sections for Phases 10, 11, 12 matching the format of Phases 1-9 (stage table, acceptance criteria, dependencies).

### 4c. Dependency Graph

Replace the existing dependency graph with an updated version including Phases 10-12:

```
Phase 1 (Critical Security)
  |
  +---> Phase 2 (Jail Hardening)
  |       |
  |       +---> Phase 4 (Upstream Friction) --+
  |       +---> Phase 7 (Documentation)       |
  |                                           +--> Phase 10 (Code Quality)
  +---> Phase 3 (Operational Hardening)       |
          |                                   |
          +---> Phase 5 (CI/CD) -------------+
          +---> Phase 6 (Ops Maturity) --+--> Phase 9 (Advanced)
                  |                      |
                  +---> Phase 8 (FreeBSD Features) --+--> Phase 11 (Ops Infra)
                                                     +--> Phase 12 (Platform)
```

### 4d. Success Criteria

Add rows:

| Metric | Current | Target |
|--------|---------|--------|
| Test coverage (index.ts) | 0% | >50% (after Phase 10) |
| Operational documentation | Partial | Complete (after Phase 10) |
| Backup/recovery automation | None | Automated (after Phase 11) |
| Feature parity with Docker | 90% | 95% (after Phase 12) |

### 4e. Trim Known Backlog

Remove all items from the Known Backlog section that are now covered by Phases 10-12. The remaining Known Backlog should contain ONLY:

```markdown
## Known Backlog (Not Scheduled)

Items intentionally deferred. No concrete implementation plan.

### P4 Long-Term / Speculative
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

## Step 5: Verify Consistency

After all changes are complete, verify:

1. Every stage row in PHASE_PLAN.md Phase 10 table has a matching `## Stage 10X` section in PHASE_10_CODE_QUALITY.md
2. Every stage row in PHASE_PLAN.md Phase 11 table has a matching `## Stage 11X` section in PHASE_11_OPERATIONAL_INFRA.md
3. Every stage row in PHASE_PLAN.md Phase 12 table has a matching `## Stage 12X` section in PHASE_12_PLATFORM_FEATURES.md
4. The Phase Summary table ticket counts match the actual number of stages
5. All items removed from Known Backlog have a corresponding ticket in Phases 10-12
6. The dependency graph is acyclic and all referenced phases exist
7. Report any inconsistencies found

## Execution

Use subagents to create the 3 phase documents in parallel, then update PHASE_PLAN.md last:

1. **Subagent 1**: Create PHASE_10_CODE_QUALITY.md
   - Read: `src/index.ts`, `scripts/setup-jail-template.sh`, `src/jail/lifecycle.ts`, `reports/sre_report.md` (Sections 6-7), `reports/maintainer_report.md` (Section 5)
   - Write the complete phase document with all 4 stages + Phase Integration QA

2. **Subagent 2**: Create PHASE_11_OPERATIONAL_INFRA.md
   - Read: `src/jail/lifecycle.ts` (lines 130-163 for rctl), `src/jail/config.ts`, `scripts/setup-freebsd.sh`, `reports/sre_report.md` (Section 7)
   - Write the complete phase document with all 4 stages + Phase Integration QA

3. **Subagent 3**: Create PHASE_12_PLATFORM_FEATURES.md
   - Read: `container/Dockerfile`, `scripts/setup-jail-template.sh`, `src/jail/config.ts`, `reports/nanoclaw_bsd_pm_report.md` (Sections 4.5-4.8), `reports/docker_vs_jails_report.md` (Sections 4, 9)
   - Write the complete phase document with all 4 stages + Phase Integration QA

4. After all 3 subagents complete: Update PHASE_PLAN.md (Steps 4a-4e) and run verification (Step 5) yourself.

Do not modify PHASE_1 through PHASE_9 documents or SHARED_INSTRUCTIONS.md. Only create the 3 new phase docs and update PHASE_PLAN.md.
