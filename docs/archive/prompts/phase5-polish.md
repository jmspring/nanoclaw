# Phase 5: Polish — Medium/Low Priority (Nice to Have)

## Overview
These tickets address polish, documentation, and lower-priority improvements.

## Dependencies

- **nan-s5yk** (network isolation tests): Depends on nan-whvd (Phase 3)
- All other tickets: No dependencies

## Tickets

| Ticket ID | Title | Effort | Priority | Depends On |
|-----------|-------|--------|----------|------------|
| nan-xnfm | Make network interface configurable | S | P2 | none |
| nan-cqy5 | Centralize timeout configuration | S | P2 | none |
| nan-s5yk | Add network isolation integration tests | M | P3 | nan-whvd |
| nan-k05n | Document sudoers requirements | S | P3 | none |
| nan-vgw5 | Pin npm package versions in template | S | P2 | none |
| nan-5b31 | Persist epair assignments for SIGKILL recovery | S | P2 | none |
| nan-jf38 | Session preservation across restarts | L | P2 | none |
| nan-jk4w | Network mode migration path | M | P2 | none |
| nan-o0h5 | Mount security validation for jail path | S | P2 | none |
| nan-tu7w | Dependency injection for unit testing | M | P2 | none |
| nan-vfsa | /tmp cleanup to prevent growth | S | P2 | none |
| nan-570i | pf table IP refresh automation | S | P3 | none |
| nan-82hf | Template setup sudo documentation | S | P3 | none |
| nan-j669 | Group name sanitization collisions | S | P3 | none |
| nan-zh1c | Unify log file naming | S | P3 | none |

---

## Individual Ticket Prompts

### nan-xnfm: Make network interface configurable

```
You are implementing ticket nan-xnfm for the NanoClaw FreeBSD jail runtime.

## Setup

1. Read the ticket: tk show nan-xnfm
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-xnfm -b ticket/nan-xnfm
   cd /tmp/nanoclaw-nan-xnfm
3. Mark in progress: tk start nan-xnfm

## Task Context
Config fix: pf config hardcodes external interface (re0). Non-portable.

Key files: pf-nanoclaw.conf:70

Solution: Make interface configurable via environment variable or config file.

## Implementation

4. Read pf-nanoclaw.conf
5. Make interface configurable:
   - Add environment variable NANOCLAW_EXT_IF
   - Default to auto-detect primary interface
   - Document configuration in comments
6. Update setup scripts to pass interface

## Completion

7. Commit:
   git add -A
   git commit -m "fix(nan-xnfm): make network interface configurable

   - Add NANOCLAW_EXT_IF environment variable
   - Auto-detect primary interface if not set
   - Document configuration options

   Closes nan-xnfm"

8. Close: tk add-note nan-xnfm "Made interface configurable. Modified: pf-nanoclaw.conf." && tk close nan-xnfm
9. Push and cleanup:
   git push -u origin ticket/nan-xnfm
   cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-xnfm

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

### nan-cqy5: Centralize timeout configuration

```
You are implementing ticket nan-cqy5 for the NanoClaw FreeBSD jail runtime.

## Setup

1. Read the ticket: tk show nan-cqy5
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-cqy5 -b ticket/nan-cqy5
   cd /tmp/nanoclaw-nan-cqy5
3. Mark in progress: tk start nan-cqy5

## Task Context
Config fix: Hardcoded timeouts (30s, 15s, 10s) scattered across files.

Key files: jail-runtime.js:67,709,716

Solution: Centralize timeout configuration in config file.

## Implementation

4. Read jail-runtime.js for hardcoded timeouts
5. Centralize timeouts:
   - Create timeouts section in config.ts
   - Define JAIL_CREATE_TIMEOUT, JAIL_DESTROY_TIMEOUT, etc.
   - Replace magic numbers with config values
   - Allow environment variable overrides
6. Run npm run build

## Completion

7. Commit:
   git add -A
   git commit -m "fix(nan-cqy5): centralize timeout configuration

   - Move hardcoded timeouts to config.ts
   - Add JAIL_CREATE_TIMEOUT, JAIL_DESTROY_TIMEOUT, etc.
   - Allow environment variable overrides

   Closes nan-cqy5"

8. Close: tk add-note nan-cqy5 "Centralized timeouts. Modified: jail-runtime.js, config.ts." && tk close nan-cqy5
9. Push and cleanup:
   git push -u origin ticket/nan-cqy5
   cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-cqy5

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

### nan-s5yk: Add network isolation integration tests

```
You are implementing ticket nan-s5yk for the NanoClaw FreeBSD jail runtime.

## Prerequisites Check

BEFORE starting, verify dependency is closed:
  tk show nan-whvd  # must be closed

If dependency is still open, STOP and report.

## Setup

1. Read the ticket: tk show nan-s5yk
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-s5yk -b ticket/nan-s5yk
   cd /tmp/nanoclaw-nan-s5yk
3. Merge ticket/nan-whvd branch
4. Mark in progress: tk start nan-s5yk

## Task Context
Test gap: Restricted mode (vnet + pf) has zero automated tests.

Key files: pf-nanoclaw.conf, tests/

Solution: Add integration tests for network isolation.

## Implementation

4. Read existing test setup
5. Add network isolation tests:
   - Test: jail can reach api.anthropic.com:443
   - Test: jail can reach allowed DNS servers
   - Test: jail CANNOT reach arbitrary internet hosts
   - Test: jail CANNOT reach other jails
   - Test: jail CANNOT reach host services (except allowed)
6. Run tests to verify

## Completion

7. Commit:
   git add -A
   git commit -m "test(nan-s5yk): add network isolation integration tests

   - Test allowed outbound: api.anthropic.com, DNS servers
   - Test blocked: arbitrary hosts, inter-jail, host services
   - Verify pf rules work as expected

   Closes nan-s5yk"

8. Close: tk add-note nan-s5yk "Added network tests. Modified: tests/." && tk close nan-s5yk
9. Push and cleanup:
   git push -u origin ticket/nan-s5yk
   cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-s5yk

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

### nan-k05n: Document sudoers requirements

```
You are implementing ticket nan-k05n for the NanoClaw FreeBSD jail runtime.

## Setup

1. Read the ticket: tk show nan-k05n
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-k05n -b ticket/nan-k05n
   cd /tmp/nanoclaw-nan-k05n
3. Mark in progress: tk start nan-k05n

## Task Context
Documentation: Sudoers scope documentation needed for jail operations.

Solution: Document all sudo requirements clearly.

## Implementation

4. Audit all sudo calls in jail-runtime.js
5. Document sudoers requirements:
   - List all commands requiring sudo
   - Provide sample sudoers.d entry
   - Explain principle of least privilege
   - Include security considerations
6. Add to docs/ or README

## Completion

7. Commit:
   git add -A
   git commit -m "docs(nan-k05n): document sudoers requirements for jail operations

   - List all commands requiring sudo
   - Provide sample sudoers.d configuration
   - Explain security considerations

   Closes nan-k05n"

8. Close: tk add-note nan-k05n "Added sudoers docs." && tk close nan-k05n
9. Push and cleanup:
   git push -u origin ticket/nan-k05n
   cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-k05n

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

### nan-vgw5: Pin npm package versions in template

```
You are implementing ticket nan-vgw5 for the NanoClaw FreeBSD jail runtime.

## Setup

1. Read the ticket: tk show nan-vgw5
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-vgw5 -b ticket/nan-vgw5
   cd /tmp/nanoclaw-nan-vgw5
3. Mark in progress: tk start nan-vgw5

## Task Context
Supply chain security: npm packages installed without pinning or checksums.

Key files: setup-jail-template.sh

Solution: Pin package versions in template.

## Implementation

4. Read setup-jail-template.sh
5. Pin npm packages:
   - Generate package-lock.json with exact versions
   - Use npm ci instead of npm install
   - Consider adding integrity checksums
6. Document package update procedure

## Completion

7. Commit:
   git add -A
   git commit -m "fix(nan-vgw5): pin npm package versions in template

   - Use npm ci with package-lock.json
   - Pin exact versions for reproducibility
   - Document package update procedure

   Closes nan-vgw5"

8. Close: tk add-note nan-vgw5 "Pinned packages. Modified: setup-jail-template.sh." && tk close nan-vgw5
9. Push and cleanup:
   git push -u origin ticket/nan-vgw5
   cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-vgw5

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

### nan-5b31: Persist epair assignments for SIGKILL recovery

```
You are implementing ticket nan-5b31 for the NanoClaw FreeBSD jail runtime.

## Setup

1. Read the ticket: tk show nan-5b31
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-5b31 -b ticket/nan-5b31
   cd /tmp/nanoclaw-nan-5b31
3. Mark in progress: tk start nan-5b31

## Task Context
Tech debt: In-memory epair Map lost on crash. Orphaned epairs not recovered.

Key files: jail-runtime.js:30

Solution: Persist epair assignments to disk.

## Implementation

4. Read jail-runtime.js epair tracking
5. Persist epair state:
   - Write assignments to /var/run/nanoclaw/epairs.json
   - Load state on startup
   - Reconcile with actual system state (ifconfig -l)
   - Clean up orphans found on startup
6. Run npm run build

## Completion

7. Commit:
   git add -A
   git commit -m "fix(nan-5b31): persist epair assignments for SIGKILL recovery

   - Write epair state to /var/run/nanoclaw/epairs.json
   - Reconcile with system state on startup
   - Clean up orphaned epairs

   Closes nan-5b31"

8. Close: tk add-note nan-5b31 "Persisted epair state. Modified: jail-runtime.js." && tk close nan-5b31
9. Push and cleanup:
   git push -u origin ticket/nan-5b31
   cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-5b31

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

### nan-jf38: Session preservation across NanoClaw restarts

```
You are implementing ticket nan-jf38 for the NanoClaw FreeBSD jail runtime.

## Setup

1. Read the ticket: tk show nan-jf38
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-jf38 -b ticket/nan-jf38
   cd /tmp/nanoclaw-nan-jf38
3. Mark in progress: tk start nan-jf38

## Task Context
Deployment: Restarting NanoClaw destroys all active sessions. No graceful handoff.

Key files: index.ts:489-509

Solution: Preserve session state across restarts.

## Implementation

4. Read index.ts session management
5. Implement session preservation:
   - Serialize active sessions to disk before shutdown
   - Reload sessions on startup
   - Handle graceful shutdown signal (SIGTERM)
   - Reconnect to existing jails if still running
6. Run npm run build

## Completion

7. Commit:
   git add -A
   git commit -m "feat(nan-jf38): add session preservation across NanoClaw restarts

   - Serialize sessions to disk on shutdown
   - Reload sessions on startup
   - Reconnect to existing jails

   Closes nan-jf38"

8. Close: tk add-note nan-jf38 "Added session preservation. Modified: index.ts." && tk close nan-jf38
9. Push and cleanup:
   git push -u origin ticket/nan-jf38
   cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-jf38

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

### nan-jk4w: Network mode migration path

```
You are implementing ticket nan-jk4w for the NanoClaw FreeBSD jail runtime.

## Setup

1. Read the ticket: tk show nan-jk4w
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-jk4w -b ticket/nan-jk4w
   cd /tmp/nanoclaw-nan-jk4w
3. Mark in progress: tk start nan-jk4w

## Task Context
Tech debt: Switching inherit<->restricted requires manual pf changes, no validation.

Key files: jail-runtime.js:19

Solution: Add migration path with validation.

## Implementation

4. Read jail-runtime.js network mode handling
5. Add migration path:
   - Validate pf configuration matches network mode
   - Provide clear error if mismatch
   - Add script to switch modes safely
   - Document migration procedure
6. Run npm run build

## Completion

7. Commit:
   git add -A
   git commit -m "fix(nan-jk4w): add network mode migration path with validation

   - Validate pf config matches network mode
   - Clear error messages on mismatch
   - Add mode switching script

   Closes nan-jk4w"

8. Close: tk add-note nan-jk4w "Added migration path. Modified: jail-runtime.js." && tk close nan-jk4w
9. Push and cleanup:
   git push -u origin ticket/nan-jk4w
   cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-jk4w

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

### nan-o0h5: Mount security validation for jail path

```
You are implementing ticket nan-o0h5 for the NanoClaw FreeBSD jail runtime.

## Setup

1. Read the ticket: tk show nan-o0h5
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-o0h5 -b ticket/nan-o0h5
   cd /tmp/nanoclaw-nan-o0h5
3. Mark in progress: tk start nan-o0h5

## Task Context
Tech debt: Jail path doesn't call validateAdditionalMounts. Potential security bypass.

Key files: container-runner.ts:301

Solution: Add mount security validation to jail path.

## Implementation

4. Read container-runner.ts mount handling
5. Add validation:
   - Call validateAdditionalMounts for jail path
   - Ensure parity with Docker mount validation
   - Add tests for malicious mount paths
6. Run npm run build

## Completion

7. Commit:
   git add -A
   git commit -m "fix(nan-o0h5): add mount security validation for jail path

   - Call validateAdditionalMounts for jails
   - Parity with Docker mount validation
   - Add tests for malicious paths

   Closes nan-o0h5"

8. Close: tk add-note nan-o0h5 "Added mount validation. Modified: container-runner.ts." && tk close nan-o0h5
9. Push and cleanup:
   git push -u origin ticket/nan-o0h5
   cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-o0h5

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

### nan-tu7w: Dependency injection for unit testing without root

```
You are implementing ticket nan-tu7w for the NanoClaw FreeBSD jail runtime.

## Setup

1. Read the ticket: tk show nan-tu7w
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-tu7w -b ticket/nan-tu7w
   cd /tmp/nanoclaw-nan-tu7w
3. Mark in progress: tk start nan-tu7w

## Task Context
Testability: All jail functions call sudo. No dependency injection for mocking.

Key files: jail-runtime.js

Solution: Add dependency injection seams for testing.

## Implementation

4. Read jail-runtime.js sudo calls
5. Add DI seams:
   - Create sudoExec wrapper function
   - Allow injection of mock executor in tests
   - Add factory function for jail runtime
   - Write unit tests using mocks
6. Run npm run build && npm test

## Completion

7. Commit:
   git add -A
   git commit -m "test(nan-tu7w): add dependency injection for unit testing without root

   - Create injectable sudoExec wrapper
   - Add factory function for jail runtime
   - Write unit tests with mocked sudo

   Closes nan-tu7w"

8. Close: tk add-note nan-tu7w "Added DI for testing. Modified: jail-runtime.js, tests/." && tk close nan-tu7w
9. Push and cleanup:
   git push -u origin ticket/nan-tu7w
   cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-tu7w

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

### nan-vfsa: /tmp cleanup to prevent growth

```
You are implementing ticket nan-vfsa for the NanoClaw FreeBSD jail runtime.

## Setup

1. Read the ticket: tk show nan-vfsa
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-vfsa -b ticket/nan-vfsa
   cd /tmp/nanoclaw-nan-vfsa
3. Mark in progress: tk start nan-vfsa

## Task Context
Resources: Per-jail TypeScript compilation leaves ~10MB per run. Long sessions accumulate GBs.

Key files: agent-runner/index.ts:432

Solution: Clean up /tmp after each session.

## Implementation

4. Read index.ts for temp file handling
5. Implement cleanup:
   - Track temp files created per session
   - Clean up on session end
   - Add periodic cleanup for orphaned temp files
   - Log cleanup actions
6. Run npm run build

## Completion

7. Commit:
   git add -A
   git commit -m "fix(nan-vfsa): add /tmp cleanup to prevent growth over time

   - Track temp files per session
   - Clean up on session end
   - Periodic cleanup for orphans

   Closes nan-vfsa"

8. Close: tk add-note nan-vfsa "Added tmp cleanup. Modified: index.ts." && tk close nan-vfsa
9. Push and cleanup:
   git push -u origin ticket/nan-vfsa
   cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-vfsa

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

### nan-570i: pf table IP refresh automation

```
You are implementing ticket nan-570i for the NanoClaw FreeBSD jail runtime.

## Setup

1. Read the ticket: tk show nan-570i
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-570i -b ticket/nan-570i
   cd /tmp/nanoclaw-nan-570i
3. Mark in progress: tk start nan-570i

## Task Context
Ops: pf table IPs need periodic refresh if using DNS.

Key files: pf-nanoclaw.conf

Solution: Add cron job for table refresh.

## Implementation

4. Read pf-nanoclaw.conf table definitions
5. Create refresh script:
   - Script to update <anthropic_api> table
   - Verify IPs before adding
   - Log changes
   - Add cron entry (weekly)
6. Document in setup instructions

## Completion

7. Commit:
   git add -A
   git commit -m "ops(nan-570i): automate pf table IP refresh via cron

   - Add table refresh script
   - Verify IPs before updating
   - Weekly cron job

   Closes nan-570i"

8. Close: tk add-note nan-570i "Added table refresh cron." && tk close nan-570i
9. Push and cleanup:
   git push -u origin ticket/nan-570i
   cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-570i

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

### nan-82hf: Template setup sudo documentation

```
You are implementing ticket nan-82hf for the NanoClaw FreeBSD jail runtime.

## Setup

1. Read the ticket: tk show nan-82hf
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-82hf -b ticket/nan-82hf
   cd /tmp/nanoclaw-nan-82hf
3. Mark in progress: tk start nan-82hf

## Task Context
Documentation: Template setup sudo documentation needed.

Key files: setup-jail-template.sh

Solution: Document sudo requirements for template setup.

## Implementation

4. Audit setup-jail-template.sh for sudo calls
5. Add documentation:
   - List all sudo commands used
   - Explain why each requires sudo
   - Provide minimal sudoers config
6. Add to setup script header or separate doc

## Completion

7. Commit:
   git add -A
   git commit -m "docs(nan-82hf): document template setup sudo requirements

   - List all sudo commands in setup
   - Provide minimal sudoers config
   - Explain privilege requirements

   Closes nan-82hf"

8. Close: tk add-note nan-82hf "Added template sudo docs." && tk close nan-82hf
9. Push and cleanup:
   git push -u origin ticket/nan-82hf
   cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-82hf

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

### nan-j669: Group name sanitization collisions

```
You are implementing ticket nan-j669 for the NanoClaw FreeBSD jail runtime.

## Setup

1. Read the ticket: tk show nan-j669
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-j669 -b ticket/nan-j669
   cd /tmp/nanoclaw-nan-j669
3. Mark in progress: tk start nan-j669

## Task Context
Input validation: Group name sanitization causes collisions.

Key files: jail-runtime.js

Solution: Improve sanitization to prevent collisions.

## Implementation

4. Read jail-runtime.js sanitizeJailName function
5. Improve sanitization:
   - Add hash suffix to prevent collisions
   - Or preserve more characters
   - Add collision detection
   - Log warning on collision
6. Run npm run build

## Completion

7. Commit:
   git add -A
   git commit -m "fix(nan-j669): prevent group name sanitization collisions

   - Add hash suffix for uniqueness
   - Detect and warn on potential collisions
   - Preserve more characters in sanitization

   Closes nan-j669"

8. Close: tk add-note nan-j669 "Fixed name collisions. Modified: jail-runtime.js." && tk close nan-j669
9. Push and cleanup:
   git push -u origin ticket/nan-j669
   cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-j669

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

### nan-zh1c: Unify log file naming

```
You are implementing ticket nan-zh1c for the NanoClaw FreeBSD jail runtime.

## Setup

1. Read the ticket: tk show nan-zh1c
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-zh1c -b ticket/nan-zh1c
   cd /tmp/nanoclaw-nan-zh1c
3. Mark in progress: tk start nan-zh1c

## Task Context
Code quality: Log naming inconsistent (jail- vs container-).

Key files: container-runner.ts, jail-runtime.js

Solution: Unify log file naming convention.

## Implementation

4. Find all log file name references
5. Unify naming:
   - Choose consistent prefix (recommend: nanoclaw-)
   - Update all log file paths
   - Document naming convention
6. Run npm run build

## Completion

7. Commit:
   git add -A
   git commit -m "fix(nan-zh1c): unify log file naming convention

   - Use consistent nanoclaw- prefix
   - Update all log file paths
   - Document naming convention

   Closes nan-zh1c"

8. Close: tk add-note nan-zh1c "Unified log naming." && tk close nan-zh1c
9. Push and cleanup:
   git push -u origin ticket/nan-zh1c
   cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-zh1c

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

---

## Execution Order Summary

**Wave 1 (no dependencies)**: Run all in parallel except nan-s5yk
- nan-xnfm, nan-cqy5, nan-k05n, nan-vgw5, nan-5b31, nan-jf38, nan-jk4w, nan-o0h5, nan-tu7w, nan-vfsa, nan-570i, nan-82hf, nan-j669, nan-zh1c

**Wave 2 (after nan-whvd from Phase 3)**:
- nan-s5yk
