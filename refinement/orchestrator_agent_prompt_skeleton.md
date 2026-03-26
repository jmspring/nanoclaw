# Orchestrator Agent Prompt Skeleton

Use this prompt after `/clear`. To run a phase, paste:

> Using `refinement/orchestrator_agent_prompt_skeleton.md` as the orchestrator, drive the implementation of `refinement/03252026/PHASE_X_NAME.md`.

The orchestrator reads the phase document, creates tickets, spawns developer and QA subagents per stage, handles retries, and creates the PR.

---

## Instructions

You are the **orchestrator agent** for the NanoClaw-BSD refinement project. Your job is to drive the implementation of a single phase document end-to-end, following the ticket lifecycle defined in `refinement/03252026/SHARED_INSTRUCTIONS.md`.

### Step 0: Read Context

Read these files before doing anything else:

1. `CLAUDE.md` — project conventions
2. `refinement/03252026/SHARED_INSTRUCTIONS.md` — coding standards, test patterns, commit conventions
3. `refinement/03252026/PHASE_PLAN.md` — phase summary, dependencies, naming conventions
4. The phase document you were given (e.g., `refinement/03252026/PHASE_1_CRITICAL_SECURITY.md`)

### Step 1: Verify Prerequisites

1. Check that the phase's dependency phases are complete. For each dependency listed in the phase header:
   - Search `git log --oneline main` for commits matching the dependency phase's ticket IDs (e.g., `nc-p1a` for Phase 1).
   - If any dependency phase tickets are missing from main, **STOP** and report: `BLOCKED: Phase {N} dependency not satisfied — missing commits for {ticket IDs}`.

2. Check that no tickets for this phase already exist:
   ```bash
   tk ready --tags phase-{N}
   ls .tickets/ | grep -i "nc-p{N}"
   ```
   If tickets already exist and are closed, check if their commits are on main. If so, report what's already done and ask the user whether to skip completed stages.

3. Confirm the working tree is clean:
   ```bash
   git status --porcelain
   ```
   If dirty, **STOP** and ask the user to commit or stash changes.

### Step 2: Parse Phase Document

Read the phase document and extract for each stage:

- **Stage ID** (e.g., `nc-p1a`)
- **Title** (from ticket header)
- **Priority** (from ticket header)
- **Tags** (from ticket header)
- **Files** (from ticket header)
- **Dependencies** (within-phase dependencies, e.g., `nc-p12c` depends on `nc-p12b`)
- **Developer Prompt** (the full content inside the ` ``` ` block under `### Developer Prompt`)
- **QA Prompt** (the full content inside the ` ``` ` block under `### QA Prompt`)
- **Phase Integration QA Prompt** (from the final section)

Create a task list tracking each stage.

### Step 3: Execute Stages

For each stage (respecting within-phase dependencies), run the following lifecycle. **Stages without dependencies on each other may be run in parallel** using background subagents — check the Dependencies field in each ticket header.

#### 3a. Create Ticket

```bash
tk create '<Title>' --type task --priority <N> --tags nanoclaw,phase-<N>,<additional-tags> -d '<one-line description>'
```

Record the ticket ID returned by `tk`. It will be used for the branch name and commit.

#### 3b. Create Worktree

```bash
git worktree add /tmp/nanoclaw-<ticket-id> -b refinement/p<phase>-<stage>-<short-description> main
```

Use the branch naming convention from PHASE_PLAN.md: `refinement/p{phase}-{stage}-{short-description}`.

#### 3c. Run Developer Subagent

Spawn a subagent (using the Agent tool) with:

- **Working directory**: The worktree at `/tmp/nanoclaw-<ticket-id>`
- **Prompt**: The Developer Prompt extracted from the phase document
- **Isolation**: Use `isolation: "worktree"` is NOT needed — we already created one. Instead, instruct the agent to `cd` to the worktree path.

The developer prompt already includes `Read SHARED_INSTRUCTIONS.md` at the top and ends with `IMPLEMENTATION_COMPLETE`.

**Subagent prompt template:**

```
You are a developer subagent working in worktree /tmp/nanoclaw-<ticket-id>.

All file reads and writes MUST happen in /tmp/nanoclaw-<ticket-id>.
Run all commands (npm test, tsc, lint) from /tmp/nanoclaw-<ticket-id>.

<paste the Developer Prompt content here>
```

Wait for the subagent to complete. Check its output for `IMPLEMENTATION_COMPLETE`.

- If the subagent reports `IMPLEMENTATION_COMPLETE`, proceed to QA.
- If the subagent errors or does not report completion, log the error and proceed to QA anyway (QA will catch issues).

#### 3d. Run QA Subagent

Spawn a separate subagent with:

- **Working directory**: Same worktree
- **Prompt**: The QA Prompt extracted from the phase document

**Subagent prompt template:**

```
You are a QA subagent validating work in worktree /tmp/nanoclaw-<ticket-id>.

All file reads and command execution MUST happen in /tmp/nanoclaw-<ticket-id>.
You must NEVER modify any files. You are read-only.

<paste the QA Prompt content here>
```

Wait for the subagent to complete. Parse its output for `QA_PASS` or `QA_FAIL`.

#### 3e. Handle QA Result

**On QA_PASS:**

1. Commit in the worktree:
   ```bash
   cd /tmp/nanoclaw-<ticket-id>
   git add -A
   git commit -m "<type>(nc-<ticket>): <short description>

   Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
   ```
   Use the commit type from SHARED_INSTRUCTIONS.md: `fix` for bugs, `feat` for features, `docs` for documentation, `test` for tests, `chore` for maintenance.

2. Close the ticket:
   ```bash
   tk close <ticket-id>
   ```

3. Mark the stage as TICKET_COMPLETE in your task list.

**On QA_FAIL (retry up to 2 times):**

1. Extract the specific failures from the QA output.

2. Spawn the developer subagent again with the failures prepended:

   ```
   You are a developer subagent working in worktree /tmp/nanoclaw-<ticket-id>.

   PREVIOUS QA FAILED. Fix ONLY the following failures:

   <paste QA_FAIL output with per-check results>

   Do not rewrite working code. Fix only the listed failures.
   Run all checks after fixing.
   Report FIXES_COMPLETE when done.
   ```

3. After fixes, re-run the QA subagent (full QA, not just failed checks).

4. If QA passes on retry, commit and close as above.

5. After 3 total QA failures (initial + 2 retries), mark as **TICKET_BLOCKED**:
   ```bash
   tk add-note <ticket-id> "BLOCKED after 3 QA failures. Worktree at /tmp/nanoclaw-<ticket-id>"
   ```
   Report the blockage to the user and continue with other stages.

### Step 4: Merge Stage Branches

After all stages complete (or are blocked):

1. If any stage is TICKET_BLOCKED, report to the user and ask whether to:
   - Continue with a partial phase PR (excluding blocked stages)
   - Stop and wait for manual resolution

2. Create a phase integration branch:
   ```bash
   git checkout -b refinement/phase-<N>-integration main
   ```

3. Merge each completed stage branch:
   ```bash
   git merge --no-ff refinement/p<phase>-<stage>-<description>
   ```
   If merge conflicts occur, resolve them. For trivial conflicts (package-lock.json, adjacent line changes), resolve automatically. For non-trivial conflicts, report to the user.

4. Run baseline checks on the merged result:
   ```bash
   npm test && npx tsc --noEmit && npm run lint && npm run format:check
   ```
   If any fail, investigate and fix before proceeding.

### Step 5: Phase Integration QA

Run the Phase Integration QA prompt (from the bottom of the phase document) as a subagent:

```
You are a QA subagent running Phase Integration QA on the merged phase branch.

Working directory: the main repo (on branch refinement/phase-<N>-integration).
You must NEVER modify any files. You are read-only.

<paste the Phase Integration QA Prompt content here>
```

**On QA_PASS:** Proceed to PR creation.

**On QA_FAIL:** Report failures to the user. Attempt to fix if the failures are straightforward (e.g., missed merge conflict). Re-run integration QA. If it fails again, stop and report.

### Step 6: Create PR

```bash
git push -u origin refinement/phase-<N>-integration

gh pr create \
  --base main \
  --title "Phase <N>: <Phase Name>" \
  --body "$(cat <<'EOF'
## Summary

Phase <N> implementation: <Phase Name>

### Tickets
- [ ] nc-p<N>a: <Title> — <status>
- [ ] nc-p<N>b: <Title> — <status>
- [ ] nc-p<N>c: <Title> — <status>
- [ ] nc-p<N>d: <Title> — <status>

### Integration QA
- [x] All baseline checks pass
- [x] Cross-ticket integration checks pass

### Source
- Phase document: refinement/03252026/PHASE_<N>_<NAME>.md
- Reports: <list source reports from phase header>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Report the PR URL to the user.

### Step 7: Cleanup

After the PR is merged (or if the user requests cleanup):

```bash
# Remove worktrees
git worktree list | grep '/tmp/nanoclaw-' | awk '{print $1}' | while read wt; do
  git worktree remove "$wt" 2>/dev/null || echo "Could not remove $wt"
done

# Delete local stage branches
git branch | grep 'refinement/p<phase>-' | xargs git branch -d

# Delete integration branch (if merged)
git branch -d refinement/phase-<N>-integration
```

Do NOT run cleanup automatically. Only clean up when:
- The user explicitly asks, OR
- The PR has been merged to main

---

## Parallelism Rules

- **Independent stages** (no within-phase dependencies): Run developer subagents in parallel using background agents. Wait for all to complete, then run QA subagents in parallel.
- **Dependent stages** (e.g., 12C depends on 12B): Run the dependency first. Only start the dependent stage after its dependency's QA passes.
- **QA is always sequential per stage**: Developer must finish before QA starts for that stage.
- **Never run two subagents in the same worktree simultaneously.**

## Error Handling

| Situation | Action |
|-----------|--------|
| Subagent timeout or crash | Retry once. If it fails again, mark TICKET_BLOCKED. |
| `tk create` fails | Check if ticket exists. If so, reuse it. If not, report error. |
| Worktree already exists | Check if it has uncommitted work. If clean, remove and recreate. If dirty, report to user. |
| Merge conflict during integration | Resolve trivial conflicts automatically. Report complex conflicts to user. |
| `git push` fails | Check if branch exists on remote. If so, force-push only after confirming with user. |
| npm test fails in worktree | Include in QA failure report. Do not commit. |
| Phase dependency not met | STOP immediately. Do not create tickets or worktrees. |

## Progress Reporting

After each stage completes (pass or fail), print a status table:

```
Phase <N> Progress:
| Stage | Ticket | Status | QA Attempts | Branch |
|-------|--------|--------|-------------|--------|
| <A>   | nc-p<N>a | COMPLETE | 1/3 | refinement/p<N>-a-... |
| <B>   | nc-p<N>b | IN_PROGRESS | 0/3 | refinement/p<N>-b-... |
| <C>   | nc-p<N>c | PENDING | 0/3 | — |
| <D>   | nc-p<N>d | BLOCKED | 3/3 | refinement/p<N>-d-... |
```

At the end, print a final summary:

```
Phase <N> Summary:
  Completed: X/Y stages
  Blocked: Z stages
  PR: <URL or "not created">
  Cleanup: <pending or done>
```
