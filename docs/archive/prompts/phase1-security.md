# Phase 1: Security — Critical Fixes (Must Fix Before PR)

## Overview
These tickets address critical security vulnerabilities that must be fixed before any upstream PR.

## Tickets (Run in Parallel)

All tickets in Phase 1 have no dependencies and can be run concurrently.

| Ticket ID | Title | Effort |
|-----------|-------|--------|
| nan-z19n | Route jail API calls through credential proxy | M |
| nan-z2qc | Restrict DNS to trusted servers only | S |
| nan-ugfr | Add rctl resource limits for jails | M |
| nan-jd7e | Create restrictive devfs ruleset | S |
| nan-pue5 | Add paranoid path validation in mountNullfs | S |
| nan-042c | Fix DNS table poisoning vulnerability | S |
| nan-07jw | Validate IPC path to prevent path traversal | S |

## Subagent Prompt Template

For each ticket, spawn a subagent with the following prompt (replace `{TICKET_ID}` with the actual ticket ID):

---

```
You are implementing ticket {TICKET_ID} for the NanoClaw FreeBSD jail runtime.

## Setup

1. Read the ticket for full context:
   ```bash
   tk show {TICKET_ID}
   ```

2. Create a git worktree for this ticket:
   ```bash
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-{TICKET_ID} -b ticket/{TICKET_ID}
   cd /tmp/nanoclaw-{TICKET_ID}
   ```

3. Mark the ticket as in progress:
   ```bash
   tk start {TICKET_ID}
   ```

## Implementation

4. Read all relevant source files mentioned in the ticket
5. Implement the solution following the acceptance criteria exactly
6. Test your changes locally where possible
7. Run `npm run build` to verify TypeScript compiles

## Completion

8. Commit your changes with a descriptive message:
   ```bash
   git add -A
   git commit -m "fix({TICKET_ID}): <summary>

   - <bullet point describing change>
   - <bullet point describing change>

   Closes {TICKET_ID}"
   ```

9. Add a note to the ticket summarizing what was done:
   ```bash
   tk add-note {TICKET_ID} "Implemented <summary>. Changes: <file1>, <file2>. Tests: <pass/fail/manual>."
   ```

10. Close the ticket:
    ```bash
    tk close {TICKET_ID}
    ```

11. Push the branch:
    ```bash
    git push -u origin ticket/{TICKET_ID}
    ```

12. Clean up the worktree:
    ```bash
    cd /home/jims/code/nanoclaw/src
    git worktree remove /tmp/nanoclaw-{TICKET_ID}
    ```

## Final Report

Return a summary containing:
- Ticket ID and title
- Files modified
- Key changes made
- Any issues encountered
- Acceptance criteria status (which ones were met)
```

---

## Individual Ticket Prompts

### nan-z19n: Route jail API calls through credential proxy

```
You are implementing ticket nan-z19n for the NanoClaw FreeBSD jail runtime.

## Setup

1. Read the ticket for full context:
   tk show nan-z19n

2. Create a git worktree for this ticket:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-z19n -b ticket/nan-z19n
   cd /tmp/nanoclaw-nan-z19n

3. Mark the ticket as in progress:
   tk start nan-z19n

## Task Context
Critical security fix: Jails currently bypass the credential proxy and expose raw ANTHROPIC_API_KEY in the process environment. This is a security regression vs Docker.

Key files: container-runner.ts:390, jail-runtime.js

Solution approach:
- Extend credential proxy to listen on jail-accessible interface (10.99.0.1:8787)
- Update pf rules to allow jail -> proxy on port 8787
- Set ANTHROPIC_BASE_URL=http://10.99.0.1:8787 in jail environment
- Pass placeholder API key instead of real one

## Implementation

4. Read container-runner.ts and jail-runtime.js to understand current implementation
5. Implement the credential proxy routing for jails
6. Update pf-nanoclaw.conf to allow jail -> host:8787
7. Verify with: jexec <jail> printenv | grep ANTHROPIC shows no real key
8. Run npm run build

## Completion

9. Commit changes:
   git add -A
   git commit -m "fix(nan-z19n): route jail API calls through credential proxy

   - Extend credential proxy to listen on 10.99.0.1:8787
   - Update pf rules for jail -> proxy communication
   - Remove raw ANTHROPIC_API_KEY from jail environment
   - Pass placeholder key, mirroring Docker implementation

   Closes nan-z19n"

10. Add note and close:
    tk add-note nan-z19n "Implemented credential proxy routing. Modified: container-runner.ts, jail-runtime.js, pf-nanoclaw.conf."
    tk close nan-z19n

11. Push and cleanup:
    git push -u origin ticket/nan-z19n
    cd /home/jims/code/nanoclaw/src
    git worktree remove /tmp/nanoclaw-nan-z19n

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

### nan-z2qc: Restrict DNS to trusted servers only

```
You are implementing ticket nan-z2qc for the NanoClaw FreeBSD jail runtime.

## Setup

1. Read the ticket: tk show nan-z2qc
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-z2qc -b ticket/nan-z2qc
   cd /tmp/nanoclaw-nan-z2qc
3. Mark in progress: tk start nan-z2qc

## Task Context
Critical security fix: pf allows jails to query ANY DNS server, enabling DNS tunneling for C2/exfiltration.

Key files: pf-nanoclaw.conf:138-139

Solution: Restrict DNS queries to trusted servers (8.8.8.8, 1.1.1.1, or local resolver).

## Implementation

4. Read pf-nanoclaw.conf to understand current DNS rules
5. Update pf rules to only allow DNS to trusted servers
6. Block all other port 53 traffic from jails
7. Test: jail should only resolve via allowed servers

## Completion

8. Commit:
   git add -A
   git commit -m "fix(nan-z2qc): restrict DNS to trusted servers only

   - Update pf rules to allow DNS only to 8.8.8.8, 1.1.1.1
   - Block all other port 53 (UDP/TCP) from jail network
   - Prevents DNS tunneling for C2/exfiltration

   Closes nan-z2qc"

9. Close: tk add-note nan-z2qc "Restricted DNS. Modified: pf-nanoclaw.conf." && tk close nan-z2qc
10. Push and cleanup:
    git push -u origin ticket/nan-z2qc
    cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-z2qc

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

### nan-ugfr: Add rctl resource limits for jails

```
You are implementing ticket nan-ugfr for the NanoClaw FreeBSD jail runtime.

## Setup

1. Read the ticket: tk show nan-ugfr
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-ugfr -b ticket/nan-ugfr
   cd /tmp/nanoclaw-nan-ugfr
3. Mark in progress: tk start nan-ugfr

## Task Context
Critical fix: Jails have no memory, CPU, or process limits. A single runaway agent can crash the host.

Key files: jail-runtime.js

Solution: Add rctl resource limits (memory, CPU, maxproc) to jail creation.

## Implementation

4. Read jail-runtime.js to understand jail creation
5. Add rctl rules during jail creation:
   - rctl -a jail:<name>:memoryuse:deny=2G
   - rctl -a jail:<name>:maxproc:deny=100
   - rctl -a jail:<name>:pcpu:deny=80
6. Clean up rctl rules during jail destruction
7. Run npm run build

## Completion

8. Commit:
   git add -A
   git commit -m "fix(nan-ugfr): add rctl resource limits for jails

   - Add memory limit (2G) via rctl
   - Add process limit (100) via rctl
   - Add CPU limit (80%) via rctl
   - Clean up rctl rules on jail destruction

   Closes nan-ugfr"

9. Close: tk add-note nan-ugfr "Added rctl limits. Modified: jail-runtime.js." && tk close nan-ugfr
10. Push and cleanup:
    git push -u origin ticket/nan-ugfr
    cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-ugfr

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

### nan-jd7e: Create restrictive devfs ruleset

```
You are implementing ticket nan-jd7e for the NanoClaw FreeBSD jail runtime.

## Setup

1. Read the ticket: tk show nan-jd7e
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-jd7e -b ticket/nan-jd7e
   cd /tmp/nanoclaw-nan-jd7e
3. Mark in progress: tk start nan-jd7e

## Task Context
High security fix: Jails mount full /dev without explicit ruleset. Kernel bugs could enable jail escape via /dev/mem, /dev/bpf.

Key files: jail-runtime.js:486

Solution: Create restrictive devfs ruleset that only exposes necessary devices.

## Implementation

4. Read jail-runtime.js to find devfs mount
5. Create devfs.rules file with restrictive ruleset:
   - Allow: null, zero, random, urandom, stdin, stdout, stderr
   - Deny: mem, kmem, bpf, all others by default
6. Apply ruleset during jail devfs mount
7. Run npm run build

## Completion

8. Commit:
   git add -A
   git commit -m "fix(nan-jd7e): create restrictive devfs ruleset

   - Add devfs.rules with minimal device exposure
   - Only allow null, zero, random, urandom, std*
   - Block mem, kmem, bpf and other dangerous devices
   - Apply ruleset during jail creation

   Closes nan-jd7e"

9. Close: tk add-note nan-jd7e "Added devfs ruleset. Modified: jail-runtime.js, devfs.rules." && tk close nan-jd7e
10. Push and cleanup:
    git push -u origin ticket/nan-jd7e
    cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-jd7e

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

### nan-pue5: Add paranoid path validation in mountNullfs

```
You are implementing ticket nan-pue5 for the NanoClaw FreeBSD jail runtime.

## Setup

1. Read the ticket: tk show nan-pue5
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-pue5 -b ticket/nan-pue5
   cd /tmp/nanoclaw-nan-pue5
3. Mark in progress: tk start nan-pue5

## Task Context
Security fix: Low-level mount functions trust inputs without canonicalization. Future refactoring could bypass validation.

Key files: jail-runtime.js:324-344

Solution: Add paranoid path validation in mountNullfs to prevent jail escape via path traversal.

## Implementation

4. Read jail-runtime.js mountNullfs function
5. Add path validation:
   - Use realpath() to canonicalize paths
   - Verify source path is within allowed directories
   - Verify target path is within jail boundary
   - Reject any path containing '..' after canonicalization
6. Run npm run build

## Completion

8. Commit:
   git add -A
   git commit -m "fix(nan-pue5): add paranoid path validation in mountNullfs

   - Canonicalize paths with realpath()
   - Verify paths within allowed boundaries
   - Reject path traversal attempts
   - Defense in depth against jail escape

   Closes nan-pue5"

9. Close: tk add-note nan-pue5 "Added path validation. Modified: jail-runtime.js." && tk close nan-pue5
10. Push and cleanup:
    git push -u origin ticket/nan-pue5
    cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-pue5

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

### nan-042c: Fix DNS table poisoning vulnerability

```
You are implementing ticket nan-042c for the NanoClaw FreeBSD jail runtime.

## Setup

1. Read the ticket: tk show nan-042c
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-042c -b ticket/nan-042c
   cd /tmp/nanoclaw-nan-042c
3. Mark in progress: tk start nan-042c

## Task Context
Security fix: <anthropic_api> table resolves DNS at load time. Compromised DNS can poison the table, enabling MitM.

Key files: pf-nanoclaw.conf:84

Solution: Pin actual IP ranges instead of DNS names.

## Implementation

4. Read pf-nanoclaw.conf to find table definition
5. Replace DNS-resolved table with pinned IPs:
   - Research current api.anthropic.com IP ranges
   - Use CIDR notation for IP blocks
   - Document table maintenance procedure
6. Add comments explaining why IPs are pinned

## Completion

8. Commit:
   git add -A
   git commit -m "fix(nan-042c): fix DNS table poisoning vulnerability

   - Replace DNS name with pinned IP ranges in <anthropic_api> table
   - Document table maintenance procedure
   - Prevent MitM via DNS poisoning

   Closes nan-042c"

9. Close: tk add-note nan-042c "Pinned IPs. Modified: pf-nanoclaw.conf." && tk close nan-042c
10. Push and cleanup:
    git push -u origin ticket/nan-042c
    cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-042c

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

### nan-07jw: Validate IPC path to prevent path traversal

```
You are implementing ticket nan-07jw for the NanoClaw FreeBSD jail runtime.

## Setup

1. Read the ticket: tk show nan-07jw
2. Create worktree:
   cd /home/jims/code/nanoclaw/src
   git worktree add /tmp/nanoclaw-nan-07jw -b ticket/nan-07jw
   cd /tmp/nanoclaw-nan-07jw
3. Mark in progress: tk start nan-07jw

## Task Context
Security fix: If resolveGroupIpcPath lacks validation, malicious groupId could write to host /etc via IPC mount.

Key files: container-runner.ts:266, jail-runtime.js:40-46

Solution: Add paranoid path validation to prevent path traversal.

## Implementation

4. Read container-runner.ts and jail-runtime.js
5. Add path validation to resolveGroupIpcPath:
   - Use path.resolve() then path.relative()
   - Verify result doesn't start with '..'
   - Verify result isn't absolute path
   - Throw error on path traversal attempt
6. Add test for path traversal vectors
7. Run npm run build

## Completion

8. Commit:
   git add -A
   git commit -m "fix(nan-07jw): validate IPC path to prevent path traversal

   - Add paranoid validation to resolveGroupIpcPath
   - Reject paths that escape base directory
   - Add test for traversal vectors

   Closes nan-07jw"

9. Close: tk add-note nan-07jw "Added IPC path validation. Modified: container-runner.ts." && tk close nan-07jw
10. Push and cleanup:
    git push -u origin ticket/nan-07jw
    cd /home/jims/code/nanoclaw/src && git worktree remove /tmp/nanoclaw-nan-07jw

## Final Report
Return: ticket ID, files modified, changes made, acceptance criteria status.
```

---

## Execution Command

To run all Phase 1 tickets in parallel, spawn 7 subagents simultaneously with the individual prompts above.
