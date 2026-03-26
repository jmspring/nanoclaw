# Phase 12: Platform Features and Parity

**Priority**: P3-P4
**Depends on**: Phase 8 (FreeBSD-Native Features)
**Rationale**: Chromium browser automation is the largest remaining Docker parity gap. ZFS send/receive enables template sharing without rebuilds. Blue/green automation formalizes the workflow already supported by setup-jail-template.sh. bhyve investigation informs the long-term strategy for Linux container compatibility.
**Source reports**: `reports/nanoclaw_bsd_pm_report.md`, `reports/docker_vs_jails_report.md`

**All subagents MUST read `refinement/03252026/SHARED_INSTRUCTIONS.md` before starting work.**

---

## Stage 12A: Add Chromium as Optional Jail Template Addon

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p12a` |
| **Title** | Add Chromium as optional jail template addon |
| **Priority** | P3 |
| **Tags** | `nanoclaw`, `phase-12`, `chromium`, `browser`, `feature-parity` |
| **Files** | `scripts/add-chromium-to-template.sh` (new) |
| **Dependencies** | None (within phase) |
| **Effort** | ~60 lines / Medium |

### Context

The Docker vs Jails report (`reports/docker_vs_jails_report.md`, section 4, lines 117-127) identifies browser automation as working in Docker but not jails. The Docker Dockerfile (`container/Dockerfile`, lines 6-27) installs Chromium and a suite of supporting libraries (fonts-liberation, fonts-noto-cjk, fonts-noto-color-emoji, libgbm1, libnss3, etc.), then sets env vars at lines 29-31:

```
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
```

Line 34 installs `agent-browser` globally alongside `claude-code`.

The BSD PM report (`reports/nanoclaw_bsd_pm_report.md`, section 5.3, lines 322-329) recommends making Chromium an optional addon via `pkg install chromium` and re-snapshotting the template. FreeBSD's `chromium` package installs to `/usr/local/bin/chromium`, not `/usr/bin/chromium` as in Debian. The addon is optional because Chromium adds ~500MB+ to the template size and many deployments do not need browser automation.

The script should follow the same patterns as `scripts/setup-jail-template.sh`: boot the template as a temporary jail (lines 138-149), install packages, stop the jail (lines 291-293), and re-snapshot with backup management (lines 301-376).

**Impact**: Browser automation (agent-browser) becomes available in jails, closing the largest Docker feature parity gap. Users who need browser-based research, web scraping, or Playwright testing can opt in without affecting the base template size for users who do not.

### Developer Prompt

```
ROLE: Developer subagent for nc-p12a
TICKET: Add Chromium as optional jail template addon
READ FIRST: refinement/03252026/SHARED_INSTRUCTIONS.md

CONTEXT:
Docker includes Chromium and agent-browser for browser automation (container/Dockerfile
lines 6-34). The jail template does not. This ticket creates an addon script that
installs Chromium into an existing jail template and re-snapshots it, making browser
automation available in jails.

TASK:

1. Read container/Dockerfile to see the Chromium packages and env vars (lines 6-31)
   and the agent-browser install (line 34).

2. Read scripts/setup-jail-template.sh to understand:
   - Template name arg pattern (line 32: TEMPLATE_NAME="${1:-template}")
   - Configuration variables (lines 29-43)
   - Temporary jail boot pattern (lines 138-149)
   - Snapshot backup/restore pattern (lines 301-376)
   - SHA-256 manifest generation (lines 378-396)
   - Cleanup trap pattern

3. CREATE: scripts/add-chromium-to-template.sh

   Structure:
   a) Shebang and header comment explaining this is an OPTIONAL addon for browser
      automation, adds ~500MB to template size.

   b) set -eu

   c) Accept optional template name arg: TEMPLATE_NAME="${1:-template}"

   d) Configuration block (same pattern as setup-jail-template.sh lines 34-42):
      - NANOCLAW_ROOT, JAILS_PATH, JAILS_DATASET, TEMPLATE_PATH, TEMPLATE_DATASET
      - SNAPSHOT_NAME="base"
      - FULL_SNAPSHOT="${TEMPLATE_DATASET}@${SNAPSHOT_NAME}"
      - TEMP_JAIL_NAME="nanoclaw_chromium_setup"

   e) Prerequisite checks:
      - Verify template dataset exists: sudo zfs list "$TEMPLATE_DATASET"
      - Verify snapshot exists: sudo zfs list -t snapshot "$FULL_SNAPSHOT"

   f) Cleanup trap that stops the temporary jail and unmounts devfs on exit:
      ```sh
      cleanup() {
          if sudo jls -j "$TEMP_JAIL_NAME" jid >/dev/null 2>&1; then
              sudo jail -r "$TEMP_JAIL_NAME"
          fi
          if mount | grep -q "${TEMPLATE_PATH}/dev"; then
              sudo umount "${TEMPLATE_PATH}/dev"
          fi
      }
      trap cleanup EXIT
      ```

   g) Boot template as temporary jail (same pattern as setup-jail-template.sh
      lines 138-149):
      ```sh
      sudo jail -c \
          name="$TEMP_JAIL_NAME" \
          path="$TEMPLATE_PATH" \
          host.hostname="$TEMP_JAIL_NAME" \
          ip4=inherit \
          ip6=inherit \
          allow.raw_sockets \
          mount.devfs \
          devfs_ruleset=10 \
          persist
      ```

   h) Install Chromium inside the jail:
      ```sh
      sudo jexec "$TEMP_JAIL_NAME" pkg install -y chromium
      ```

   i) Set browser env vars by writing to /usr/local/etc/profile.d/chromium.sh
      inside the jail (FreeBSD Chromium lives at /usr/local/bin/chromium):
      ```sh
      sudo jexec "$TEMP_JAIL_NAME" sh -c 'mkdir -p /usr/local/etc/profile.d && cat > /usr/local/etc/profile.d/chromium.sh << "ENVEOF"
      export AGENT_BROWSER_EXECUTABLE_PATH=/usr/local/bin/chromium
      export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/local/bin/chromium
      ENVEOF'
      ```

   j) Install agent-browser globally:
      ```sh
      sudo jexec "$TEMP_JAIL_NAME" npm install -g agent-browser
      ```

   k) Verify installation:
      - Check /usr/local/bin/chromium exists in jail
      - Check agent-browser is in npm global list

   l) Stop jail and unmount devfs:
      ```sh
      sudo jail -r "$TEMP_JAIL_NAME"
      if mount | grep -q "${TEMPLATE_PATH}/dev"; then
          sudo umount "${TEMPLATE_PATH}/dev"
      fi
      ```

   m) Re-snapshot using the same backup/restore pattern as setup-jail-template.sh
      lines 301-376:
      - Back up existing snapshot to @base-backup
      - Create new snapshot
      - Verify by test clone
      - On verification success, destroy backup
      - On verification failure, restore backup

   n) Regenerate SHA-256 manifest (same pattern as setup-jail-template.sh
      lines 378-396)

   o) Log completion with size increase warning:
      ```sh
      echo "Chromium addon installed. Template size increased by ~500MB."
      echo "Browser automation (agent-browser) is now available in jails."
      ```

4. Make the script executable: chmod +x scripts/add-chromium-to-template.sh

Report: IMPLEMENTATION_COMPLETE
```

### QA Prompt

```
ROLE: QA subagent for nc-p12a
TICKET: Add Chromium as optional jail template addon
READ FIRST: refinement/03252026/SHARED_INSTRUCTIONS.md

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only scripts/add-chromium-to-template.sh
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

TICKET-SPECIFIC CHECKS:

1. SCRIPT EXISTS AND IS EXECUTABLE:
   [ ] scripts/add-chromium-to-template.sh exists
   [ ] File has executable permission or chmod +x is documented

2. SCRIPT STRUCTURE:
   [ ] set -eu is present near the top
   [ ] Accepts optional template name arg with default "template"
   [ ] Configuration block derives TEMPLATE_DATASET, TEMPLATE_PATH, etc.
      from NANOCLAW_ROOT and JAILS_DATASET following the same pattern
      as setup-jail-template.sh

3. CLEANUP TRAP:
   [ ] trap cleanup EXIT is present
   [ ] Cleanup function stops the temporary jail if running
   [ ] Cleanup function unmounts devfs if mounted

4. CHROMIUM INSTALLATION:
   [ ] pkg install -y chromium is called inside the jail via jexec
   [ ] FreeBSD path /usr/local/bin/chromium is used (NOT /usr/bin/chromium)

5. ENVIRONMENT VARIABLES:
   [ ] AGENT_BROWSER_EXECUTABLE_PATH set to /usr/local/bin/chromium
   [ ] PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH set to /usr/local/bin/chromium
   [ ] Env vars are written to a persistent location inside the template
      (e.g., /usr/local/etc/profile.d/chromium.sh or similar)

6. AGENT-BROWSER:
   [ ] npm install -g agent-browser is called inside the jail

7. VERIFICATION STEP:
   [ ] Script verifies Chromium binary exists after installation
   [ ] Script verifies agent-browser is installed

8. SNAPSHOT MANAGEMENT:
   [ ] Existing snapshot is backed up before re-snapshotting
   [ ] New snapshot is created
   [ ] Snapshot is validated via test clone
   [ ] Backup is cleaned up on successful validation
   [ ] SHA-256 manifest is regenerated

9. NO SCOPE CREEP:
   [ ] No other files are modified
   [ ] No changes to setup-jail-template.sh
   [ ] No TypeScript code changes

Report each check as PASS or FAIL with details.
Final output: QA_PASS or QA_FAIL
```

---

## Stage 12B: Add ZFS Send/Receive for Template Distribution

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p12b` |
| **Title** | Add ZFS send/receive for template distribution |
| **Priority** | P3 |
| **Tags** | `nanoclaw`, `phase-12`, `zfs`, `template`, `distribution` |
| **Files** | `scripts/export-template.sh` (new), `scripts/import-template.sh` (new) |
| **Dependencies** | None (within phase) |
| **Effort** | ~50 lines / Small |

### Context

The BSD PM report (`reports/nanoclaw_bsd_pm_report.md`, section 4.6, lines 248-260) recommends ZFS send/receive for template distribution. Building a template from scratch via `scripts/setup-jail-template.sh` takes several minutes (pkg installs, npm installs, compilation). ZFS send/receive allows exporting a fully-built template as a single file and importing it on another machine, skipping the entire build process.

The template build script (`scripts/setup-jail-template.sh`, lines 378-396) already generates SHA-256 manifests for template integrity verification. The export script should produce a `.zfs` stream file alongside a `.sha256` checksum file. The import script should verify the checksum before receiving.

The template dataset and snapshot naming convention follows `scripts/setup-jail-template.sh` lines 37-40:
- Dataset: `${JAILS_DATASET}/${TEMPLATE_NAME}` (default: `zroot/nanoclaw/jails/template`)
- Snapshot: `${TEMPLATE_DATASET}@base`

**Impact**: Users can share pre-built templates, avoiding the multi-minute template build process. This is particularly valuable for teams deploying to multiple machines or for disaster recovery scenarios where the template must be restored quickly.

### Developer Prompt

```
ROLE: Developer subagent for nc-p12b
TICKET: Add ZFS send/receive for template distribution
READ FIRST: refinement/03252026/SHARED_INSTRUCTIONS.md

CONTEXT:
Building a jail template from scratch takes several minutes. ZFS send/receive enables
exporting a pre-built template as a single file and importing it on another machine.
The setup-jail-template.sh script already generates SHA-256 manifests (lines 378-396).

TASK:

1. Read scripts/setup-jail-template.sh to understand:
   - Dataset/snapshot naming (lines 37-40)
   - SHA-256 manifest generation pattern (lines 378-396)

2. CREATE: scripts/export-template.sh

   Structure:
   a) Shebang and header comment explaining usage:
      ```
      # Export a NanoClaw jail template as a portable ZFS stream file.
      #
      # Usage:
      #   ./export-template.sh                    # export default "template"
      #   ./export-template.sh template-v2        # export "template-v2"
      #
      # Produces:
      #   nanoclaw-template-<name>.zfs        — ZFS stream file
      #   nanoclaw-template-<name>.zfs.sha256 — SHA-256 checksum
      ```

   b) set -eu

   c) Accept optional template name arg: TEMPLATE_NAME="${1:-template}"

   d) Configuration block:
      - JAILS_DATASET="${NANOCLAW_JAILS_DATASET:-zroot/nanoclaw/jails}"
      - TEMPLATE_DATASET="${JAILS_DATASET}/${TEMPLATE_NAME}"
      - SNAPSHOT_NAME="base"
      - FULL_SNAPSHOT="${TEMPLATE_DATASET}@${SNAPSHOT_NAME}"
      - OUTPUT_FILE="nanoclaw-template-${TEMPLATE_NAME}.zfs"
      - CHECKSUM_FILE="${OUTPUT_FILE}.sha256"

   e) Prerequisite checks:
      - Verify snapshot exists: sudo zfs list -t snapshot "$FULL_SNAPSHOT"

   f) Export via zfs send:
      ```sh
      sudo zfs send "$FULL_SNAPSHOT" > "$OUTPUT_FILE"
      ```

   g) Generate SHA-256 checksum (try sha256, fall back to sha256sum):
      ```sh
      if command -v sha256 >/dev/null 2>&1; then
          sha256 "$OUTPUT_FILE" > "$CHECKSUM_FILE"
      elif command -v sha256sum >/dev/null 2>&1; then
          sha256sum "$OUTPUT_FILE" | awk '{print $1}' > "$CHECKSUM_FILE"
      else
          echo "WARNING: sha256/sha256sum not available, skipping checksum"
      fi
      ```

   h) Log output file path, size (using du -h or ls -lh), and checksum.

3. CREATE: scripts/import-template.sh

   Structure:
   a) Shebang and header comment explaining usage:
      ```
      # Import a NanoClaw jail template from a ZFS stream file.
      #
      # Usage:
      #   ./import-template.sh nanoclaw-template-template.zfs
      #   ./import-template.sh nanoclaw-template-template.zfs template-v2
      #
      # If a .sha256 file exists alongside the .zfs file, it will be verified first.
      ```

   b) set -eu

   c) Accept required file path arg and optional template name:
      ```sh
      INPUT_FILE="${1:?Usage: import-template.sh <file.zfs> [template-name]}"
      TEMPLATE_NAME="${2:-template}"
      ```

   d) Configuration block:
      - JAILS_DATASET="${NANOCLAW_JAILS_DATASET:-zroot/nanoclaw/jails}"
      - TEMPLATE_DATASET="${JAILS_DATASET}/${TEMPLATE_NAME}"

   e) Verify input file exists

   f) SHA-256 verification if checksum file exists:
      ```sh
      CHECKSUM_FILE="${INPUT_FILE}.sha256"
      if [ -f "$CHECKSUM_FILE" ]; then
          EXPECTED=$(cat "$CHECKSUM_FILE")
          if command -v sha256 >/dev/null 2>&1; then
              ACTUAL=$(sha256 "$INPUT_FILE")
          elif command -v sha256sum >/dev/null 2>&1; then
              ACTUAL=$(sha256sum "$INPUT_FILE" | awk '{print $1}')
          else
              echo "WARNING: sha256/sha256sum not available, skipping verification"
              ACTUAL="$EXPECTED"
          fi
          if [ "$EXPECTED" != "$ACTUAL" ]; then
              echo "ERROR: SHA-256 mismatch!"
              echo "  Expected: $EXPECTED"
              echo "  Actual:   $ACTUAL"
              exit 1
          fi
          echo "SHA-256 verification passed."
      else
          echo "WARNING: No .sha256 file found, skipping verification."
      fi
      ```

   g) Check target dataset does not already have dependent clones:
      ```sh
      if sudo zfs list "$TEMPLATE_DATASET" >/dev/null 2>&1; then
          CLONES=$(sudo zfs list -H -o name -t filesystem -r "$TEMPLATE_DATASET" | wc -l)
          if [ "$CLONES" -gt 1 ]; then
              echo "ERROR: Target dataset $TEMPLATE_DATASET has dependent clones."
              echo "Destroy existing jails first or import to a different template name."
              exit 1
          fi
      fi
      ```

   h) Import via zfs receive:
      ```sh
      sudo zfs receive -F "$TEMPLATE_DATASET" < "$INPUT_FILE"
      ```

   i) Verify snapshot exists after receive:
      ```sh
      if sudo zfs list -t snapshot "${TEMPLATE_DATASET}@base" >/dev/null 2>&1; then
          echo "Template imported successfully: ${TEMPLATE_DATASET}@base"
      else
          echo "ERROR: Import completed but snapshot not found."
          exit 1
      fi
      ```

   j) Log success with dataset name.

4. Make both scripts executable.

Report: IMPLEMENTATION_COMPLETE
```

### QA Prompt

```
ROLE: QA subagent for nc-p12b
TICKET: Add ZFS send/receive for template distribution
READ FIRST: refinement/03252026/SHARED_INSTRUCTIONS.md

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only
    scripts/export-template.sh and scripts/import-template.sh
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

TICKET-SPECIFIC CHECKS:

1. EXPORT SCRIPT:
   [ ] scripts/export-template.sh exists
   [ ] set -eu is present
   [ ] Accepts optional template name arg with default "template"
   [ ] Uses zfs send to export the template snapshot
   [ ] Generates SHA-256 checksum of the output file
   [ ] Handles both sha256 (FreeBSD) and sha256sum (Linux) commands
   [ ] Logs output file path and size

2. IMPORT SCRIPT:
   [ ] scripts/import-template.sh exists
   [ ] set -eu is present
   [ ] Accepts required file path arg
   [ ] Accepts optional template name arg with default "template"
   [ ] Verifies SHA-256 if .sha256 file exists alongside .zfs file
   [ ] Exits with error on SHA-256 mismatch
   [ ] Checks for dependent clones before overwriting target dataset
   [ ] Uses zfs receive to import the template
   [ ] Verifies snapshot exists after receive

3. NAMING CONSISTENCY:
   [ ] Both scripts use the same JAILS_DATASET env var (NANOCLAW_JAILS_DATASET)
   [ ] Dataset naming matches setup-jail-template.sh convention:
      ${JAILS_DATASET}/${TEMPLATE_NAME}
   [ ] Snapshot name is "base" (matching setup-jail-template.sh line 40)

4. ERROR HANDLING:
   [ ] Export script checks snapshot exists before sending
   [ ] Import script checks input file exists before receiving
   [ ] Import script reports clear error on SHA-256 mismatch
   [ ] Import script reports clear error on dependent clones

5. NO SCOPE CREEP:
   [ ] No other files are modified
   [ ] No TypeScript code changes

Report each check as PASS or FAIL with details.
Final output: QA_PASS or QA_FAIL
```

---

## Stage 12C: Implement Blue/Green Template Automation

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p12c` |
| **Title** | Implement blue/green template automation |
| **Priority** | P4 |
| **Tags** | `nanoclaw`, `phase-12`, `deployment`, `blue-green`, `automation` |
| **Files** | `scripts/blue-green-template.sh` (new) |
| **Dependencies** | nc-p12b (uses template distribution scripts) |
| **Effort** | ~80 lines / Medium |

### Context

The `scripts/setup-jail-template.sh` script already supports named templates (lines 12-19 document the blue/green workflow, line 32 accepts a template name argument). The current workflow requires manual steps:

1. Run `./setup-jail-template.sh template-v2`
2. Set `export NANOCLAW_TEMPLATE_DATASET=zroot/nanoclaw/jails/template-v2`
3. Restart NanoClaw

The `src/jail/config.ts` file (line 60) reads the `NANOCLAW_TEMPLATE_DATASET` env var to determine which template to use for new jails. The SRE report (`reports/sre_report.md`, section 6.2, lines 289-291) recommends automating this workflow and adding verification. The BSD PM report (`reports/nanoclaw_bsd_pm_report.md`, section 4.8, lines 278-295) also references blue/green template support.

This ticket automates the full blue/green workflow: build a new template, verify it, switch the active template, and optionally clean up the old one.

**Impact**: One-command template updates with automatic verification and switchover, reducing the risk of deploying a broken template and eliminating manual steps that are easy to forget.

### Developer Prompt

```
ROLE: Developer subagent for nc-p12c
TICKET: Implement blue/green template automation
READ FIRST: refinement/03252026/SHARED_INSTRUCTIONS.md

CONTEXT:
setup-jail-template.sh already supports named templates for blue/green deployment
(lines 12-19). The workflow is currently manual. This ticket automates the full
build-verify-switch workflow in a single script.

TASK:

1. Read scripts/setup-jail-template.sh to understand:
   - Blue/green workflow documentation (lines 12-19)
   - Template name argument (line 32)
   - Validation via test clone (lines 330-361)

2. Read src/jail/config.ts line 60 to understand how NANOCLAW_TEMPLATE_DATASET
   is consumed at runtime.

3. CREATE: scripts/blue-green-template.sh

   Structure:
   a) Shebang and header comment:
      ```
      # Blue/green template update for NanoClaw jails.
      #
      # Builds a new template alongside the current one, verifies it,
      # and switches the active template. Old jails continue using their
      # existing template until destroyed.
      #
      # Usage:
      #   ./blue-green-template.sh                     # auto-generate name
      #   ./blue-green-template.sh --name template-v2  # explicit name
      #   ./blue-green-template.sh --restart            # restart NanoClaw after switch
      #   ./blue-green-template.sh --cleanup            # remove old template after switch
      #
      # The script:
      #   1. Builds a new template (via setup-jail-template.sh)
      #   2. Verifies the new template by creating and destroying a test clone
      #   3. Updates the service environment to use the new template
      #   4. Optionally restarts NanoClaw
      #   5. Optionally cleans up the old template
      ```

   b) set -euo pipefail

   c) Parse arguments:
      - --name <name>: explicit new template name
      - --restart: restart NanoClaw after switching
      - --cleanup: destroy old template after verification
      - Default name: template-$(date +%Y%m%d%H%M)

   d) Configuration block:
      - NANOCLAW_ROOT, JAILS_DATASET, JAILS_PATH
      - SCRIPT_DIR: directory containing this script (for calling setup-jail-template.sh)
      - Determine current template from NANOCLAW_TEMPLATE_DATASET env var
        (default: zroot/nanoclaw/jails/template)
      - Derive current template name from the dataset path

   e) Step 1 — Build new template:
      ```sh
      echo "Step 1: Building new template: $NEW_TEMPLATE_NAME"
      "${SCRIPT_DIR}/setup-jail-template.sh" "$NEW_TEMPLATE_NAME"
      ```

   f) Step 2 — Verify new template by creating and destroying a test clone:
      ```sh
      echo "Step 2: Verifying new template..."
      NEW_DATASET="${JAILS_DATASET}/${NEW_TEMPLATE_NAME}"
      TEST_CLONE="${NEW_DATASET}_verify_$$"
      sudo zfs clone "${NEW_DATASET}@base" "$TEST_CLONE"
      # Check expected files exist
      TEST_PATH="${JAILS_PATH}/${NEW_TEMPLATE_NAME}_verify_$$"
      if [ -f "${TEST_PATH}/app/entrypoint.sh" ] && \
         [ -d "${TEST_PATH}/app/node_modules" ]; then
          echo "  Verification: PASSED"
      else
          echo "  Verification: FAILED — missing expected files"
          sudo zfs destroy "$TEST_CLONE"
          exit 1
      fi
      sudo zfs destroy "$TEST_CLONE"
      ```

   g) Step 3 — Update service environment:
      - Write the new dataset to the NanoClaw .env file or rc.conf:
        ```sh
        echo "Step 3: Switching active template to $NEW_TEMPLATE_NAME"
        ENV_FILE="${NANOCLAW_ROOT}/src/.env"
        if [ -f "$ENV_FILE" ]; then
            # Update existing .env
            if grep -q "^NANOCLAW_TEMPLATE_DATASET=" "$ENV_FILE"; then
                sed -i '' "s|^NANOCLAW_TEMPLATE_DATASET=.*|NANOCLAW_TEMPLATE_DATASET=${NEW_DATASET}|" "$ENV_FILE"
            else
                echo "NANOCLAW_TEMPLATE_DATASET=${NEW_DATASET}" >> "$ENV_FILE"
            fi
        else
            echo "NANOCLAW_TEMPLATE_DATASET=${NEW_DATASET}" > "$ENV_FILE"
        fi
        ```
      - Also update rc.conf if running as a service:
        ```sh
        if grep -q 'nanoclaw_env' /etc/rc.conf 2>/dev/null; then
            echo "NOTE: Update NANOCLAW_TEMPLATE_DATASET in /etc/rc.conf or"
            echo "      /usr/local/etc/rc.conf.d/nanoclaw if running as a service."
        fi
        ```

   h) Step 4 — Optionally restart NanoClaw:
      ```sh
      if [ "$DO_RESTART" = "true" ]; then
          echo "Step 4: Restarting NanoClaw..."
          if command -v service >/dev/null 2>&1; then
              sudo service nanoclaw restart
          else
              echo "WARNING: 'service' command not found. Restart manually."
          fi
      else
          echo "Step 4: Skipped (use --restart to restart automatically)"
      fi
      ```

   i) Step 5 — Optionally clean up old template:
      ```sh
      if [ "$DO_CLEANUP" = "true" ]; then
          echo "Step 5: Cleaning up old template: $CURRENT_TEMPLATE_NAME"
          OLD_DATASET="${JAILS_DATASET}/${CURRENT_TEMPLATE_NAME}"
          # Check no dependent clones exist
          CLONES=$(sudo zfs list -H -o name -t filesystem -r "$OLD_DATASET" | wc -l)
          if [ "$CLONES" -gt 1 ]; then
              echo "WARNING: Old template has active clones. Skipping cleanup."
              echo "         Destroy dependent jails first, then run:"
              echo "         sudo zfs destroy -r $OLD_DATASET"
          else
              sudo zfs destroy -r "$OLD_DATASET"
              echo "  Old template destroyed."
          fi
      else
          echo "Step 5: Skipped (use --cleanup to remove old template)"
      fi
      ```

   j) Log completion summary showing old and new template names.

4. Make the script executable.

Report: IMPLEMENTATION_COMPLETE
```

### QA Prompt

```
ROLE: QA subagent for nc-p12c
TICKET: Implement blue/green template automation
READ FIRST: refinement/03252026/SHARED_INSTRUCTIONS.md

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only scripts/blue-green-template.sh
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

TICKET-SPECIFIC CHECKS:

1. SCRIPT EXISTS AND IS EXECUTABLE:
   [ ] scripts/blue-green-template.sh exists
   [ ] File has executable permission or chmod +x is documented

2. SCRIPT STRUCTURE:
   [ ] set -euo pipefail is present near the top
   [ ] Accepts --name, --restart, and --cleanup flags
   [ ] Default template name uses date-based naming

3. BUILD STEP:
   [ ] Script calls setup-jail-template.sh with the new template name
   [ ] setup-jail-template.sh is referenced by relative path from the script directory

4. VERIFICATION STEP:
   [ ] Creates a test clone from the new template snapshot
   [ ] Checks for expected files (app/entrypoint.sh, app/node_modules)
   [ ] Destroys test clone after verification
   [ ] Exits with error if verification fails

5. TEMPLATE SWITCHING:
   [ ] References NANOCLAW_TEMPLATE_DATASET env var
   [ ] Updates .env file or equivalent configuration
   [ ] Handles both existing and new .env files

6. RESTART:
   [ ] --restart flag triggers service restart
   [ ] Uses service nanoclaw restart (FreeBSD convention)
   [ ] Without --restart, prints a reminder to restart manually

7. CLEANUP:
   [ ] --cleanup flag triggers old template destruction
   [ ] Checks for dependent clones before destroying old template
   [ ] Warns and skips cleanup if active clones exist

8. CURRENT TEMPLATE DETECTION:
   [ ] Reads current template from NANOCLAW_TEMPLATE_DATASET env var
   [ ] Falls back to default "template" if env var is not set

9. NO SCOPE CREEP:
   [ ] No other files are modified
   [ ] No changes to setup-jail-template.sh
   [ ] No changes to src/jail/config.ts
   [ ] No TypeScript code changes

Report each check as PASS or FAIL with details.
Final output: QA_PASS or QA_FAIL
```

---

## Stage 12D: Investigate bhyve Runtime for Linux Container Compatibility

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p12d` |
| **Title** | Investigate bhyve runtime for Linux container compatibility |
| **Priority** | P4 |
| **Tags** | `nanoclaw`, `phase-12`, `bhyve`, `research`, `investigation` |
| **Files** | `docs/BHYVE_INVESTIGATION.md` (new) |
| **Dependencies** | None (within phase) |
| **Effort** | New document / Research ticket |

### Context

The BSD PM report (`reports/nanoclaw_bsd_pm_report.md`, section 4.5, lines 231-246) identifies bhyve as a potential way to run the upstream Docker image (node:24-slim + Chromium) directly on FreeBSD for full Linux binary compatibility. This avoids the need to maintain a separate FreeBSD jail template that replicates Docker functionality package by package.

However, bhyve VMs have fundamentally different performance characteristics than jails:
- Jails share the host kernel with near-zero overhead and sub-100ms creation time
- bhyve VMs boot a full guest kernel with multi-second startup and per-VM memory overhead
- Mount sharing requires 9pfs or virtio-fs instead of nullfs

This is a **RESEARCH TICKET**. The deliverable is a document with a clear go/no-go recommendation, NOT code. The goal is an informed decision on whether bhyve is worth pursuing as an alternative runtime alongside jails.

**Impact**: An informed, documented decision on whether bhyve is a viable path for full Linux container compatibility on FreeBSD, preventing wasted engineering effort on a dead-end approach or missing a valuable capability.

### Developer Prompt

```
ROLE: Developer subagent for nc-p12d
TICKET: Investigate bhyve runtime for Linux container compatibility
READ FIRST: refinement/03252026/SHARED_INSTRUCTIONS.md

THIS IS A RESEARCH TICKET. Do NOT write any code.
The deliverable is docs/BHYVE_INVESTIGATION.md.

CONTEXT:
The BSD PM report recommends investigating bhyve as a way to run the upstream Docker
image directly. This ticket produces a feasibility assessment document with a clear
go/no-go recommendation.

TASK:

1. Read the following for context:
   - reports/nanoclaw_bsd_pm_report.md section 4.5 (lines 231-246) for the bhyve recommendation
   - container/Dockerfile for the Docker image contents (71 lines)
   - src/jail/config.ts for jail configuration (113 lines)
   - src/jail/lifecycle.ts for jail creation flow
   - src/jail/runner.ts for agent runner integration

2. CREATE: docs/BHYVE_INVESTIGATION.md

   The document MUST contain all of the following sections:

   ## 1. Executive Summary
   - One-paragraph overview
   - Clear GO or NO-GO recommendation with rationale
   - If GO: estimated effort and timeline
   - If NO-GO: recommended alternatives

   ## 2. bhyve Overview on FreeBSD 15
   - What bhyve provides (Type 2 hypervisor, VirtIO, UEFI boot)
   - Current state on FreeBSD 15.0-RELEASE
   - Key capabilities relevant to NanoClaw

   ## 3. Feasibility Assessment for NanoClaw
   - Can bhyve run the Docker image (node:24-slim base + Chromium)?
     Discuss converting Docker images to VM disk images (e.g., docker export
     to raw disk, or using cloud-init with a minimal Linux distro)
   - Startup time overhead vs jails (<100ms) and Docker (1-3s)
     bhyve cold boot is typically 3-10s. Compare with jail creation time.
   - Memory overhead per VM vs per jail
     Each bhyve VM needs its own kernel memory. Jails share the host kernel.
     Estimate overhead for a typical NanoClaw workload (2GB memory limit).
   - Concurrent instance limits
     How many bhyve VMs can run simultaneously vs jails?

   ## 4. Mount Strategy
   - 9pfs: current state, performance characteristics, limitations
   - virtio-fs: availability on FreeBSD 15, performance vs 9pfs
   - How workspace, group, and IPC directories would be shared with VMs
   - Performance comparison with nullfs (jail mounts)

   ## 5. Network Integration
   - How to route jail-style pf rules to bhyve VMs
   - tap interfaces vs epair interfaces
   - NAT and port forwarding considerations
   - Impact on existing pf-nanoclaw.conf rules

   ## 6. Credential Proxy Integration
   - How VMs would reach the host credential proxy
   - Network path: tap interface -> host bridge -> proxy
   - Token injection and authentication flow
   - Comparison with current jail approach (epair -> host IP)

   ## 7. Implementation Estimate
   - New files required (src/bhyve/ modules)
   - Integration points with existing code
   - Estimated lines of code
   - Estimated development effort (days/weeks)
   - Testing requirements (bhyve requires hardware virtualization support)

   ## 8. Alternatives to bhyve
   - FreeBSD Linuxulator (linux binary compatibility layer)
     Can it run Node.js 24 + Chromium in a jail?
   - Jail with Linux pkg repositories
   - Maintaining FreeBSD-native equivalents (current approach)
   - Hybrid approach: jails for most workloads, bhyve only for browser automation

   ## 9. Go/No-Go Recommendation
   - Summarize pros and cons in a table
   - Clear recommendation with rationale
   - If GO: proposed implementation phases
   - If NO-GO: what would change the recommendation in the future

3. The document should be factual and balanced. Cite FreeBSD documentation,
   man pages, or known performance benchmarks where possible.

4. The document should be 200-400 lines. Not a thin stub, not an encyclopedia.

Report: IMPLEMENTATION_COMPLETE
```

### QA Prompt

```
ROLE: QA subagent for nc-p12d
TICKET: Investigate bhyve runtime for Linux container compatibility
READ FIRST: refinement/03252026/SHARED_INSTRUCTIONS.md

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only docs/BHYVE_INVESTIGATION.md
[ ] No secrets or credentials in diff

TICKET-SPECIFIC CHECKS:

1. DOCUMENT EXISTS:
   [ ] docs/BHYVE_INVESTIGATION.md exists

2. ALL 9 SECTIONS PRESENT:
   [ ] Section 1: Executive Summary — present and contains a clear GO or NO-GO
   [ ] Section 2: bhyve Overview on FreeBSD 15 — present
   [ ] Section 3: Feasibility Assessment — covers Docker image compatibility,
       startup time comparison, memory overhead, concurrent instance limits
   [ ] Section 4: Mount Strategy — covers 9pfs, virtio-fs, workspace sharing
   [ ] Section 5: Network Integration — covers tap interfaces, pf rules
   [ ] Section 6: Credential Proxy Integration — covers VM-to-proxy communication
   [ ] Section 7: Implementation Estimate — covers new files, LOC, effort
   [ ] Section 8: Alternatives to bhyve — covers Linuxulator, at least 2 other alternatives
   [ ] Section 9: Go/No-Go Recommendation — contains explicit GO or NO-GO,
       contains pros/cons table or comparison

3. DOCUMENT QUALITY:
   [ ] Executive summary is a single coherent paragraph (not a list)
   [ ] Go/no-go recommendation is clearly stated (not ambiguous)
   [ ] Startup time comparison includes concrete numbers or ranges
   [ ] Memory overhead comparison includes concrete numbers or ranges
   [ ] Document is between 200 and 400 lines

4. NO CODE:
   [ ] No TypeScript, JavaScript, or shell script files were created
   [ ] The document does not contain implementation code (pseudocode is acceptable)
   [ ] No changes to any existing source files

5. NO SCOPE CREEP:
   [ ] Only docs/BHYVE_INVESTIGATION.md was created
   [ ] No other files were modified

Report each check as PASS or FAIL with details.
Final output: QA_PASS or QA_FAIL
```

---

## Phase 12 Integration QA

After all four stage tickets (12A, 12B, 12C, 12D) have individually passed QA and been committed to their respective branches, run the following integration QA on the merged result.

### Integration QA Prompt

```
ROLE: Phase Integration QA subagent
PHASE: Phase 12 -- Platform Features and Parity
READ FIRST: refinement/03252026/SHARED_INSTRUCTIONS.md

CONTEXT:
All four Phase 12 stages have been implemented and merged into a single branch.
This integration QA verifies that the deliverables are present, consistent, and
do not interfere with each other or with existing functionality.

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check

INTEGRATION CHECKS:

1. ALL DELIVERABLES PRESENT:
   [ ] scripts/add-chromium-to-template.sh exists and is executable
   [ ] scripts/export-template.sh exists and is executable
   [ ] scripts/import-template.sh exists and is executable
   [ ] scripts/blue-green-template.sh exists and is executable
   [ ] docs/BHYVE_INVESTIGATION.md exists

2. SCRIPT CONSISTENCY:
   [ ] All four scripts use the same JAILS_DATASET env var (NANOCLAW_JAILS_DATASET)
   [ ] All four scripts use the same default dataset path (zroot/nanoclaw/jails)
   [ ] All four scripts accept an optional template name argument with the same
       default ("template")
   [ ] Template name argument follows the same pattern as setup-jail-template.sh
       line 32: TEMPLATE_NAME="${1:-template}"
   [ ] Snapshot naming uses "base" consistently (matching setup-jail-template.sh
       line 40)

3. CHROMIUM ADDON (12A):
   [ ] scripts/add-chromium-to-template.sh references pkg install chromium
   [ ] Sets AGENT_BROWSER_EXECUTABLE_PATH to /usr/local/bin/chromium (FreeBSD path)
   [ ] Sets PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to /usr/local/bin/chromium
   [ ] Has cleanup trap for jail stop and devfs unmount
   [ ] Has snapshot backup/restore pattern

4. TEMPLATE DISTRIBUTION (12B):
   [ ] scripts/export-template.sh uses zfs send
   [ ] scripts/import-template.sh uses zfs receive
   [ ] SHA-256 verification is present in import script
   [ ] Import script checks for dependent clones before overwriting

5. BLUE/GREEN AUTOMATION (12C):
   [ ] scripts/blue-green-template.sh calls setup-jail-template.sh
   [ ] References NANOCLAW_TEMPLATE_DATASET env var
   [ ] Has verification step (test clone creation and destruction)
   [ ] Has --restart and --cleanup flags
   [ ] Does NOT modify src/jail/config.ts (reads env var at runtime, script
       only modifies .env or rc.conf)

6. BHYVE INVESTIGATION (12D):
   [ ] docs/BHYVE_INVESTIGATION.md contains a clear GO or NO-GO recommendation
   [ ] Document has all 9 required sections
   [ ] No code was produced (research ticket only)

7. NO CONFLICTING CHANGES:
   [ ] No two scripts define the same function names that could conflict if sourced
   [ ] No scripts modify setup-jail-template.sh (they call it, not modify it)
   [ ] No changes to any TypeScript files (all deliverables are shell scripts
       and documentation)
   [ ] No changes to package.json or package-lock.json

8. NO REGRESSIONS:
   [ ] git diff against the phase-8 merge base shows only expected new files
   [ ] No existing files are modified
   [ ] All existing test files pass: src/jail-runtime.test.ts,
       src/jail-mount-security.test.ts, src/jail-network-isolation.test.ts,
       src/jail-stress.test.ts, src/jail-snapshots.test.ts,
       src/jail-rctl-metrics.test.ts, src/jail-persistence.test.ts

9. SHELL SCRIPT QUALITY:
   [ ] All scripts use set -eu or set -euo pipefail
   [ ] All scripts have header comments explaining usage
   [ ] All scripts validate inputs before acting
   [ ] No hardcoded paths to /home/jims (all use NANOCLAW_ROOT or env vars)

Report: QA_PASS or QA_FAIL with per-check breakdown.
If QA_FAIL, identify which stage(s) caused the failure and what needs to be fixed.
```
