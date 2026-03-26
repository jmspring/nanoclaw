# Phase 7: Documentation Consolidation

**Priority**: P2 -- unlocks wider adoption
**Depends on**: Phase 2 (jail hardening changes must be settled before documenting)
**Source reports**: `reports/freebsd_user_report.md` (setup rated 6/10, documentation fragmentation), `reports/freebsd_sysadmin_report.md` (anchor config stale, env var gaps)
**Shared instructions**: All subagents MUST read `refinement/03252026/SHARED_INSTRUCTIONS.md` before starting work.

---

## Phase Context

The FreeBSD User Report rated the setup experience 6/10 and identified documentation fragmentation as the primary barrier to adoption. A new user must read across five documents (README, FREEBSD_JAILS.md, setup-freebsd.sh, TEMPLATE_SETUP.md, .env.example) to understand the full picture. The Sysadmin Report independently identified the anchor config as stale (uses `lo1` instead of epair, wrong CIDR, allows inter-jail traffic). Environment variable documentation is scattered across `.env.example`, `src/jail/config.ts`, `FREEBSD_JAILS.md`, and `CLAUDE.md`. No installation verification mechanism exists.

---

## Stage 7A: Unified "Getting Started with NanoClaw on FreeBSD" Guide

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | nc-p7a |
| **Title** | Write unified "Getting Started with NanoClaw on FreeBSD" guide |
| **Priority** | P2 |
| **Tags** | nanoclaw, phase-7, docs, freebsd |
| **Files** | `docs/GETTING_STARTED_FREEBSD.md` (new) |
| **Dependencies** | Phase 2 complete (jail hardening settled), nc-p3b complete (rc.d improvements) |

### Context

The FreeBSD User Report (Section 1, Section 8, Section 9) identified that setup information is scattered across README.md (3 lines), FREEBSD_JAILS.md (detailed but manual-steps-first), setup-freebsd.sh (automated but opaque), and TEMPLATE_SETUP.md (supplementary). The report proposed a unified getting-started outline (Section 9) that would serve as a single entry point. This ticket creates that document.

The existing FREEBSD_JAILS.md remains as the deep-dive architecture reference. The new getting-started guide is the practical "do this, then this" document that links to FREEBSD_JAILS.md for deeper context.

### Developer Prompt

```
ROLE: Developer subagent for nc-p7a
TASK: Create docs/GETTING_STARTED_FREEBSD.md -- a unified getting-started guide for FreeBSD users.

READ FIRST:
- refinement/03252026/SHARED_INSTRUCTIONS.md (all rules)
- reports/freebsd_user_report.md (Sections 1, 8, 9 for pain points and proposed outline)
- docs/FREEBSD_JAILS.md (existing deep-dive -- do NOT duplicate, link to it)
- scripts/setup-freebsd.sh (understand what it does, to describe accurately)
- scripts/setup-jail-template.sh (understand the two-script relationship)
- .env.example (for the configuration section)
- etc/rc.d/nanoclaw (for the service management section)

DOCUMENT OUTLINE (from FreeBSD User Report Section 9, adapted):

# Getting Started with NanoClaw on FreeBSD

## What Is NanoClaw?
- One paragraph: personal AI assistant that runs Claude agents in isolated
  FreeBSD jails. Messages arrive via channels (Telegram, Slack, Discord, etc.),
  route to an orchestrator, which spawns an ephemeral jail per conversation.
  Each jail has its own filesystem (ZFS clone), network stack (vnet/epair),
  and resource limits (rctl).

## Before You Begin
- FreeBSD 15.0+ with ZFS root (or ZFS pool)
- 4GB+ RAM, 2GB+ free ZFS space (breakdown: base system ~500MB,
  Node.js + npm packages ~400MB, headroom for jail clones)
- An Anthropic API key (link to console.anthropic.com)
- At least one messaging channel token (e.g., Telegram bot token)
- Internet access during setup (downloads ~700MB total)
- Node.js 24+ on the host (installed by setup script if missing)

## Quick Setup (5 Steps)
1. Clone the repo:
   git clone https://github.com/qwibitai/nanoclaw.git && cd nanoclaw/src
2. Run the bootstrap script:
   sudo ./scripts/setup-freebsd.sh
   (Interactive: prompts for username, ZFS pool, network interface.
    Safe to re-run.)
3. Configure environment:
   cp .env.example .env
   Edit .env: set ANTHROPIC_API_KEY and at least one channel token.
   Set NANOCLAW_RUNTIME=jail (or leave blank for auto-detection on FreeBSD).
4. Verify the installation:
   ./scripts/verify-install.sh
   (Created in ticket nc-p7d. If not yet available, use:
    NANOCLAW_RUNTIME=jail npx tsx src/index.ts --dry-run
    or simply start with npm run dev and watch for "Jail runtime initialized")
5. Enable the service:
   sudo sysrc nanoclaw_enable=YES
   sudo service nanoclaw start

## What the Setup Script Does
- List all 10 sections of setup-freebsd.sh with one-line descriptions:
  1. Package installation (node24, npm, git)
  2. Kernel module configuration (RACCT for rctl, if_epair for networking)
  3. User and group setup
  4. ZFS dataset hierarchy creation
  5. Base system extraction into jail template
  6. Node.js installation in template
  7. pf firewall rules installation
  8. Sudoers configuration
  9. rc.d service installation
  10. Jail template finalization (delegates to setup-jail-template.sh)
- Add a note explaining the two-script relationship:
  "setup-freebsd.sh bootstraps the entire system and calls
   setup-jail-template.sh at the end to finalize the jail template.
   You only need to run setup-jail-template.sh standalone when rebuilding
   the template after code changes (e.g., after git pull)."

## Configuration
### Minimal Configuration (Development)
- Show the 3-line .env for development:
  NANOCLAW_RUNTIME=jail
  NANOCLAW_JAIL_NETWORK_MODE=inherit
  ANTHROPIC_API_KEY=sk-ant-...
  Plus a channel token.

### Production Configuration
- Switch to restricted networking: NANOCLAW_JAIL_NETWORK_MODE=restricted
- Verify pf rules are loaded: sudo pfctl -sr | grep nanoclaw
- Link to docs/ENV_REFERENCE.md for full variable reference (nc-p7c)
- Link to docs/FREEBSD_JAILS.md Section 5 for pf details

## Adding Channels
- Explain that channels are configured via .env tokens
- For Telegram: set TELEGRAM_BOT_TOKEN in .env, restart service
- For other channels: link to README channel setup section
- Note: Claude Code on the host is NOT required for FreeBSD runtime operation,
  but can be used for interactive /setup and /add-* skill commands

## Development vs. Production
- Development: npm run dev, NANOCLAW_JAIL_NETWORK_MODE=inherit
- Production: sudo service nanoclaw start, NANOCLAW_JAIL_NETWORK_MODE=restricted
- When to switch: before exposing to untrusted users or the internet

## Updating NanoClaw
- Pull new code: git pull
- Rebuild: npm run build
- Rebuild jail template: sudo ./scripts/setup-jail-template.sh
- Restart service: sudo service nanoclaw restart

## Troubleshooting
- Top 5 most common first-run issues:
  1. API key not set -> "ANTHROPIC_API_KEY is required" error
  2. Template snapshot missing -> run setup-jail-template.sh
  3. ZFS pool full -> zfs list, check available space
  4. Sudoers not configured -> run setup-freebsd.sh again
  5. pf not loaded -> sudo pfctl -e && sudo pfctl -f /etc/pf.conf
- Log locations:
  Development: logs/nanoclaw.log (relative to project root)
  Production (rc.d): /var/log/nanoclaw.log
- Link to docs/DEBUG_CHECKLIST.md (note: FreeBSD section is under
  "FreeBSD Jails" heading, scroll past macOS/Docker section)

## Further Reading
- [FreeBSD Jails Deep Dive](FREEBSD_JAILS.md) -- architecture, security model,
  advanced configuration
- [Linux/Docker to FreeBSD Translation](LINUX_TO_FREEBSD.md) -- concept mapping
  for Docker users
- [Environment Variable Reference](ENV_REFERENCE.md) -- all configuration options
- [Template Management](TEMPLATE_SETUP.md) -- jail template rebuilds and upgrades
- [Security Model](SECURITY.md) -- mount validation, credential proxy, pf rules

ADDITIONAL REQUIRED SECTIONS (append to the getting-started outline):

## How Credentials Flow (Credential Proxy)
- Explain the credential proxy architecture for FreeBSD jails
- How API keys move from .env -> proxy -> jail (via per-jail tokens)
- Diagram or step-by-step: agent sends request -> proxy injects real key -> forwards to Anthropic
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

GUIDELINES:
- Write in second person ("you"), imperative mood for instructions
- Use fenced code blocks for all commands
- Every command must be copy-pasteable (no placeholders except where noted)
- Do NOT duplicate content from FREEBSD_JAILS.md -- link to it
- Do NOT reference jail-runtime.js (that file does not exist; the compiled
  output is dist/index.js)
- Do NOT hardcode paths like /home/jims/ -- use generic paths or variables
- Keep the document under 300 lines
- No mermaid diagrams (keep it practical, not architectural)

After writing the document, verify:
- All internal links point to files that exist (check with ls)
- No references to jail-runtime.js
- No hardcoded personal paths (/home/jims/)
- The git clone URL uses qwibitai/nanoclaw

Report IMPLEMENTATION_COMPLETE when done.
```

### QA Prompt

```
ROLE: QA subagent for nc-p7a
TASK: Validate docs/GETTING_STARTED_FREEBSD.md

READ FIRST:
- refinement/03252026/SHARED_INSTRUCTIONS.md (QA rules)
- reports/freebsd_user_report.md (Section 9 for the proposed outline)

CHECKS:

[ ] File exists: docs/GETTING_STARTED_FREEBSD.md
[ ] Document length: under 300 lines
[ ] All required sections present (from outline):
    - What Is NanoClaw?
    - Before You Begin
    - Quick Setup
    - What the Setup Script Does
    - Configuration (minimal + production)
    - Adding Channels
    - Development vs. Production
    - Updating NanoClaw
    - Troubleshooting
    - Further Reading
[ ] Two-script relationship explained (setup-freebsd.sh calls setup-jail-template.sh)
[ ] Credential proxy flow documented:
    Run: grep -c 'credential proxy\|Credential Proxy' docs/GETTING_STARTED_FREEBSD.md (must be >= 1)
    The document must explain how API keys flow from .env through the proxy to jails.
[ ] Channel setup section present:
    Run: grep -c 'Adding Channels\|Channel Setup\|adding channels' docs/GETTING_STARTED_FREEBSD.md (must be >= 1)
    Must explain how to add channels on FreeBSD and note Claude Code CLI is not required.
[ ] Log locations documented:
    Run: grep -c 'nanoclaw.log' docs/GETTING_STARTED_FREEBSD.md (must be >= 1)
    Must list both development (logs/nanoclaw.log) and production (/var/log/nanoclaw.log) paths.
[ ] Two-script relationship explained:
    Run: grep -c 'setup-jail-template' docs/GETTING_STARTED_FREEBSD.md (must be >= 1)
    Must explain when to run each script independently.
[ ] No broken internal links: every [link](path.md) target exists in docs/
    Run: grep -oP '\]\(([^)]+\.md)' docs/GETTING_STARTED_FREEBSD.md | sed 's/\](//' | while read f; do test -f "docs/$f" || echo "BROKEN: $f"; done
[ ] No references to jail-runtime.js:
    Run: grep -c 'jail-runtime' docs/GETTING_STARTED_FREEBSD.md (must be 0)
[ ] No hardcoded personal paths:
    Run: grep -c '/home/jims' docs/GETTING_STARTED_FREEBSD.md (must be 0)
[ ] Git clone URL uses qwibitai/nanoclaw (not yourorg)
[ ] Top 5 troubleshooting issues listed
[ ] Log locations documented (both dev and production paths)
[ ] .env.example referenced in configuration section
[ ] No mermaid diagrams
[ ] Commands are copy-pasteable (no unexplained placeholders)
[ ] Channel setup section does NOT require Claude Code on host
[ ] NANOCLAW_RUNTIME=jail mentioned in configuration

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only docs/GETTING_STARTED_FREEBSD.md
[ ] No secrets or credentials in diff

Report QA_PASS or QA_FAIL with per-check breakdown.
```

---

## Stage 7B: Fix Anchor Config for vnet/epair Architecture

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | nc-p7b |
| **Title** | Fix anchor config for vnet/epair architecture |
| **Priority** | P2 |
| **Tags** | nanoclaw, phase-7, pf, security, freebsd |
| **Files** | `etc/pf-nanoclaw-anchor.conf` |
| **Dependencies** | nc-p1a complete (standalone pf CIDR fix), nc-p1d complete (epair destination restrictions) |

### Context

The Sysadmin Report (Section 9, "Anchor config") identified three critical problems with `etc/pf-nanoclaw-anchor.conf`:

1. **Uses `lo1` instead of epair interfaces.** The anchor config references `lo1` as the jail interface, but the actual vnet/epair networking model uses per-jail `epairNb` interfaces. Traffic flows through epair interfaces, not `lo1`. The anchor rules match nothing.

2. **Uses `/24` CIDR instead of `/16`.** The addressing scheme uses `10.99.N.0/30` where N ranges 0-255, spanning `10.99.0.0/16`. The anchor uses `10.99.0.0/24` which only covers `10.99.0.0` through `10.99.0.255`.

3. **Allows all inter-jail traffic.** Two rules (`pass quick on lo1 from 10.99.0.0/24 to 10.99.0.0/24`) allow unrestricted communication between jails, defeating isolation.

4. **Redundant rules.** Lines 46 and 53 are essentially the same rule.

5. **Hardcoded personal path.** Line 28 references `/home/jims/code/nanoclaw/src/etc/pf-nanoclaw-anchor.conf`.

The anchor config must be rewritten to match the vnet/epair architecture used by the standalone `pf-nanoclaw.conf` (which was fixed in Phase 1).

### Developer Prompt

```
ROLE: Developer subagent for nc-p7b
TASK: Rewrite etc/pf-nanoclaw-anchor.conf to match the vnet/epair architecture.

READ FIRST:
- refinement/03252026/SHARED_INSTRUCTIONS.md (all rules, especially pf rules section)
- etc/pf-nanoclaw-anchor.conf (current file -- this is what you are rewriting)
- etc/pf-nanoclaw.conf (the standalone config -- this is the REFERENCE for correct rules)
- reports/freebsd_sysadmin_report.md (Section 2: Network Isolation, Section 9: pf Rules Analysis)
- src/jail/network.ts (epair creation, addressing scheme)
- src/jail/config.ts (jail subnet, IP addressing)

CHANGES REQUIRED:

1. HEADER COMMENT UPDATES:
   - Change prerequisite macros from lo1-based to epair-based:
     * nanoclaw_net = "10.99.0.0/16"  (was /24)
     * Remove nanoclaw_if = "lo1" (not used in epair model)
   - Change the NAT rule in the prerequisites to use the correct subnet:
     * nat on egress from $nanoclaw_net to any -> (egress:0)
   - Remove the hardcoded path /home/jims/... from the load anchor example.
     Use a generic path: /usr/local/etc/pf-nanoclaw-anchor.conf
     or <nanoclaw_install_path>/etc/pf-nanoclaw-anchor.conf

2. TABLE AND MACRO DEFINITIONS:
   - Keep: table <anthropic_api> persist { 160.79.104.0/21, 2607:6bc0::/48 }
   - Keep: trusted_dns = "{ 8.8.8.8, 1.1.1.1 }"
   - These are correct and match the standalone config.

3. REPLACE ALL lo1 RULES WITH EPAIR RULES:
   The vnet/epair model means:
   - Each jail gets its own epairNa/epairNb interface pair
   - Traffic between jail and host flows through epairNa (host side) / epairNb (jail side)
   - There is NO lo1 involvement
   - pf rules should match on "epair*" interface group or on egress

   Replace the lo1 rules with these epair rules (matching the standalone config pattern):

   # --- Epair Interface Rules (jail <-> host gateway) ---

   # Block all epair traffic by default, then allow specific services
   block on epair all

   # Allow credential proxy traffic (jail -> host gateway on port 3001)
   pass quick on epair proto tcp to port 3001 keep state

   # Allow DNS to trusted servers only
   pass quick on epair proto { tcp, udp } to $trusted_dns port 53 keep state

   # Allow HTTPS to Anthropic API only (NOT to any port 443 destination)
   pass quick on epair proto tcp to <anthropic_api> port 443 keep state

4. EGRESS RULES (jail -> internet):
   # DNS to trusted servers
   pass out quick on egress proto { tcp, udp } from 10.99.0.0/16 to $trusted_dns port 53 keep state

   # HTTPS to Anthropic API only
   pass out quick on egress proto tcp from 10.99.0.0/16 to <anthropic_api> port 443 keep state

   # Block and log everything else from jail subnet
   block log quick on egress from 10.99.0.0/16 to any

5. REMOVE INTER-JAIL PASS RULES:
   - Delete: pass quick on lo1 from 10.99.0.0/24 to 10.99.0.0/24
   - Delete: pass quick on lo1 proto { tcp, udp } from 10.99.0.0/24 to 10.99.0.0/24
   - Delete: pass quick on lo1 from any to 10.99.0.0/24 keep state
   - Inter-jail isolation is enforced by vnet: each jail has its own network
     stack and cannot see other jails' epair interfaces. No explicit inter-jail
     block rule is needed in the anchor (vnet provides isolation by design).

6. FINAL BLOCK RULE:
   # Block anything not explicitly allowed from jail subnet on epair
   block log quick on epair from 10.99.0.0/16 to any

7. COMMENTS:
   - Every rule must have a comment explaining its purpose
   - Add a note at the top explaining the vnet/epair model briefly:
     "Each jail gets a dedicated epair interface pair. The host side (epairNa)
      is in the host's network stack. The jail side (epairNb) is in the jail's
      vnet. pf rules on epair interfaces control jail traffic."

VALIDATION:
After writing the file, verify pf syntax:
  sudo pfctl -nf etc/pf-nanoclaw-anchor.conf
If sudo is not available, note that the syntax check should be run manually.

Verify the file has NO references to:
- lo1 (except possibly in a comment explaining the migration)
- /24 CIDR for jail_net (must be /16)
- /home/jims/
- Inter-jail pass rules

Report IMPLEMENTATION_COMPLETE when done.
```

### QA Prompt

```
ROLE: QA subagent for nc-p7b
TASK: Validate etc/pf-nanoclaw-anchor.conf rewrite

READ FIRST:
- refinement/03252026/SHARED_INSTRUCTIONS.md (QA rules, pf rules section)
- etc/pf-nanoclaw.conf (standalone config -- anchor should be consistent)
- reports/freebsd_sysadmin_report.md (Section 9 for the problems being fixed)

CHECKS:

[ ] File exists: etc/pf-nanoclaw-anchor.conf
[ ] No references to lo1 as an active interface:
    Run: grep -n 'on lo1' etc/pf-nanoclaw-anchor.conf (must be 0 matches in active rules;
    a comment explaining migration is acceptable)
[ ] Correct CIDR: all jail subnet references use 10.99.0.0/16 (not /24):
    Run: grep -n '10.99.0.0' etc/pf-nanoclaw-anchor.conf
    Every match must show /16, never /24
[ ] No hardcoded personal paths:
    Run: grep -c '/home/jims' etc/pf-nanoclaw-anchor.conf (must be 0)
[ ] No inter-jail pass rules:
    No rule that passes traffic FROM jail_net TO jail_net (the old lo1 pass-all rules)
[ ] Epair rules present:
    - block on epair all (default deny)
    - pass on epair to port 3001 (credential proxy)
    - pass on epair to trusted_dns port 53 (DNS)
    - pass on epair to <anthropic_api> port 443 (API -- restricted destination, NOT any 443)
[ ] Egress rules present:
    - pass out on egress from 10.99.0.0/16 to trusted_dns port 53
    - pass out on egress from 10.99.0.0/16 to <anthropic_api> port 443
    - block log on egress from 10.99.0.0/16 to any
[ ] anthropic_api table defined:
    Run: grep 'table.*anthropic_api' etc/pf-nanoclaw-anchor.conf (must match)
[ ] trusted_dns macro defined:
    Run: grep 'trusted_dns' etc/pf-nanoclaw-anchor.conf (must match)
[ ] Every active rule has a comment (line above or inline)
[ ] pf syntax validation (SKIP if sudo unavailable):
    Run: sudo pfctl -nf etc/pf-nanoclaw-anchor.conf
    Must exit 0 with no errors.
[ ] Header comments explain:
    - When to use anchor vs standalone config
    - Prerequisites for /etc/pf.conf (NAT anchor, filter anchor, macro definitions)
    - The vnet/epair networking model
[ ] Consistency with standalone config:
    - Same anthropic_api table contents (160.79.104.0/21, 2607:6bc0::/48)
    - Same trusted_dns servers (8.8.8.8, 1.1.1.1)
    - Port 443 restricted to <anthropic_api> (not open to any destination)

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit (should be unaffected)
[ ] All tests pass: npm test (should be unaffected)
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only etc/pf-nanoclaw-anchor.conf
[ ] No secrets or credentials in diff

Report QA_PASS or QA_FAIL with per-check breakdown.
```

---

## Stage 7C: Consolidated Environment Variable Reference

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | nc-p7c |
| **Title** | Create consolidated environment variable reference |
| **Priority** | P2 |
| **Tags** | nanoclaw, phase-7, docs, configuration |
| **Files** | `docs/ENV_REFERENCE.md` (new) |
| **Dependencies** | Phase 2 complete (new env vars from 2C/2D settled) |

### Context

The FreeBSD User Report (Section 2, item 7) identified that environment variable documentation is fragmented across four locations:

- `.env.example` -- documents runtime vars with inline comments
- `src/jail/config.ts` -- defines jail-specific vars with defaults, clamping, and env var names
- `docs/FREEBSD_JAILS.md` -- mentions some vars in context
- `CLAUDE.md` -- lists a few key vars

Several important variables are only discoverable by reading source code:
- `NANOCLAW_ROOT` (override project root path)
- `NANOCLAW_JAILS_PATH` (override jails directory)
- `NANOCLAW_JAILS_DATASET` (override ZFS dataset for jails)
- `NANOCLAW_TEMPLATE_DATASET` (override template ZFS dataset)
- `NANOCLAW_TEMPLATE_SNAPSHOT` (override template snapshot name)
- `NANOCLAW_WORKSPACES_PATH` (override workspaces directory)
- `NANOCLAW_IPC_PATH` (override IPC directory)
- `NANOCLAW_JAIL_SUBNET` (override subnet prefix, default 10.99)
- `NANOCLAW_EXT_IF` (external network interface for pf)

This ticket creates a single reference document listing every environment variable with its type, default, valid range, and which component uses it.

### Developer Prompt

```
ROLE: Developer subagent for nc-p7c
TASK: Create docs/ENV_REFERENCE.md -- a consolidated environment variable reference.

READ FIRST:
- refinement/03252026/SHARED_INSTRUCTIONS.md (all rules)
- .env.example (primary source of documented vars)
- src/jail/config.ts (jail-specific vars with defaults and clamping ranges)
- src/config.ts (core config vars)
- src/container-runtime.ts (runtime detection, proxy host)
- src/credential-proxy.ts (proxy port, host)
- src/jail/metrics.ts (health/metrics vars)
- reports/freebsd_user_report.md (Section 2, item 7 for the gap analysis)

DOCUMENT STRUCTURE:

# Environment Variable Reference

Brief intro: all configuration is via environment variables in .env file.
Copy .env.example to .env to get started. This document is the complete
reference for all supported variables.

## Core Variables
Table format with columns: Variable | Default | Description | Valid Values

Include:
- NANOCLAW_RUNTIME (auto-detected: jail, apple, docker)
- CONTAINER_IMAGE (nanoclaw-agent:latest)
- CONTAINER_TIMEOUT (1800000ms, min 60000, max 7200000)
- CONTAINER_MAX_OUTPUT_SIZE (10485760 bytes, min 1MB, max 100MB)
- IDLE_TIMEOUT (1800000ms)
- MAX_CONCURRENT_CONTAINERS (5, min 1, max 50)
- ASSISTANT_NAME (Andy)
- ASSISTANT_HAS_OWN_NUMBER (false)
- TZ (system default)

## Credential Proxy
- CREDENTIAL_PROXY_PORT (3001, min 1024, max 65535)
- CREDENTIAL_PROXY_HOST (auto-detected per runtime)

## Jail Runtime (FreeBSD Only)

### Network Configuration
- NANOCLAW_JAIL_NETWORK_MODE (restricted | inherit)
- NANOCLAW_JAIL_SUBNET (10.99 -- prefix for jail IPs, produces 10.99.N.0/30 per jail)
- NANOCLAW_EXT_IF (auto-detected -- external network interface for pf NAT)
- NANOCLAW_MAX_EPAIRS (200, min 1, max 255)

### Resource Limits
- NANOCLAW_JAIL_MEMORY_LIMIT (2G -- rctl memoryuse limit per jail)
- NANOCLAW_JAIL_MAXPROC (100 -- max processes per jail)
- NANOCLAW_JAIL_PCPU (80 -- CPU percentage limit per jail)
- NANOCLAW_MAX_JAILS (50, min 1, max 100)

### Path Overrides
- NANOCLAW_ROOT (process.cwd() -- root path for all derived paths)
- NANOCLAW_JAILS_PATH ($NANOCLAW_ROOT/jails -- where jail filesystems live)
- NANOCLAW_JAILS_DATASET (zroot/nanoclaw/jails -- ZFS dataset for jails)
- NANOCLAW_TEMPLATE_DATASET (zroot/nanoclaw/jails/template -- ZFS template dataset)
- NANOCLAW_TEMPLATE_SNAPSHOT (base -- snapshot name on template dataset)
- NANOCLAW_WORKSPACES_PATH ($NANOCLAW_ROOT/workspaces)
- NANOCLAW_IPC_PATH ($NANOCLAW_ROOT/ipc)

### Timeouts (milliseconds)
- JAIL_EXEC_TIMEOUT (30000, min 5000, max 300000)
- JAIL_CREATE_TIMEOUT (30000, min 5000, max 300000)
- JAIL_STOP_TIMEOUT (15000, min 5000, max 120000)
- JAIL_FORCE_STOP_TIMEOUT (10000, min 5000, max 60000)
- JAIL_QUICK_OP_TIMEOUT (5000, min 1000, max 30000)

## Health and Metrics
- HEALTH_ENABLED (true)
- METRICS_ENABLED (false)
- METRICS_PORT (9090, min 1024, max 65535)

## Logging
- LOG_LEVEL (info -- trace, debug, info, warn, error, fatal)
- LOG_ROTATION_SIZE (10M)
- LOG_ROTATION_MAX_FILES (5, min 1, max 100)
- LOG_ROTATION_COMPRESS (true)
- LOG_RETENTION_DAYS (30, min 1, max 365)

## Channel Tokens
- Note: channel tokens (TELEGRAM_BOT_TOKEN, etc.) are loaded from data/env/env
  by the credential proxy / OneCLI gateway. They are NOT set in .env directly.
  See CLAUDE.md for credential management details.

FORMAT GUIDELINES:
- Use markdown tables for each section
- Include the source file where each variable is read (e.g., "Source: src/jail/config.ts")
- For clamped values, show the range: "Default: 30000 (range: 5000-300000)"
- Mark FreeBSD-only variables clearly
- Note which variables require a service restart vs. which are read on each
  jail creation
- Do NOT include any actual API keys or tokens as examples
- Keep the document factual -- no opinions or recommendations (those belong
  in FREEBSD_JAILS.md)

VERIFICATION:
- Cross-check every variable against its source file to ensure accuracy
  of defaults and ranges
- Verify no variable from .env.example is missing from this document
- Verify no variable from src/jail/config.ts is missing from this document

Report IMPLEMENTATION_COMPLETE when done.
```

### QA Prompt

```
ROLE: QA subagent for nc-p7c
TASK: Validate docs/ENV_REFERENCE.md

READ FIRST:
- refinement/03252026/SHARED_INSTRUCTIONS.md (QA rules)
- .env.example (all vars here must appear in the reference)
- src/jail/config.ts (all vars here must appear in the reference)

CHECKS:

[ ] File exists: docs/ENV_REFERENCE.md
[ ] All .env.example variables present:
    Extract var names from .env.example:
      grep -oP '^#?\s*[A-Z_]+=' .env.example | sed 's/^#\s*//' | sed 's/=//'
    Each must appear in ENV_REFERENCE.md:
      for var in $(above); do grep -c "$var" docs/ENV_REFERENCE.md || echo "MISSING: $var"; done
[ ] All jail/config.ts variables present:
    The following must all appear in ENV_REFERENCE.md:
    - NANOCLAW_ROOT
    - NANOCLAW_JAILS_PATH
    - NANOCLAW_JAILS_DATASET
    - NANOCLAW_TEMPLATE_DATASET
    - NANOCLAW_TEMPLATE_SNAPSHOT
    - NANOCLAW_WORKSPACES_PATH
    - NANOCLAW_IPC_PATH
    - NANOCLAW_JAIL_SUBNET
    - NANOCLAW_JAIL_NETWORK_MODE
    - NANOCLAW_JAIL_MEMORY_LIMIT
    - NANOCLAW_JAIL_MAXPROC
    - NANOCLAW_JAIL_PCPU
    - NANOCLAW_MAX_EPAIRS
    - NANOCLAW_MAX_JAILS
    - JAIL_EXEC_TIMEOUT
    - JAIL_CREATE_TIMEOUT
    - JAIL_STOP_TIMEOUT
    - JAIL_FORCE_STOP_TIMEOUT
    - JAIL_QUICK_OP_TIMEOUT
[ ] Default values are accurate:
    Spot-check at least 5 variables against their source files:
    - JAIL_EXEC_TIMEOUT: default 30000, min 5000, max 300000 (src/jail/config.ts)
    - NANOCLAW_MAX_EPAIRS: default 200, min 1, max 255 (src/jail/config.ts)
    - NANOCLAW_MAX_JAILS: default 50, min 1, max 100 (src/jail/config.ts)
    - NANOCLAW_JAIL_SUBNET: default "10.99" (src/jail/config.ts)
    - NANOCLAW_TEMPLATE_DATASET: default "zroot/nanoclaw/jails/template" (src/jail/config.ts)
[ ] Required sections present:
    - Core Variables
    - Credential Proxy
    - Jail Runtime (FreeBSD Only)
    - Health and Metrics
    - Logging
    - Channel Tokens (or equivalent explanation)
[ ] No actual API keys or tokens in file:
    Run: grep -ciE '(sk-ant-|xoxb-|bot[0-9]+:)' docs/ENV_REFERENCE.md (must be 0)
[ ] No references to jail-runtime.js:
    Run: grep -c 'jail-runtime' docs/ENV_REFERENCE.md (must be 0)
[ ] No hardcoded personal paths:
    Run: grep -c '/home/jims' docs/ENV_REFERENCE.md (must be 0)
[ ] FreeBSD-only variables clearly marked
[ ] Table format used (consistent columns)
[ ] Source file references present for at least the jail config section

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only docs/ENV_REFERENCE.md
[ ] No secrets or credentials in diff

Report QA_PASS or QA_FAIL with per-check breakdown.
```

---

## Stage 7D: Installation Verification Smoke Test

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | nc-p7d |
| **Title** | Add installation verification smoke test script |
| **Priority** | P2 |
| **Tags** | nanoclaw, phase-7, testing, freebsd, shell |
| **Files** | `scripts/verify-install.sh` (new) |
| **Dependencies** | Phase 2 complete (jail features stable), nc-p7a ideally (references this script) |

### Context

The FreeBSD User Report (Section 2, item 3) identified the lack of an installation verification mechanism:

> "After running setup-freebsd.sh, there is no documented smoke test. The user is told to 'send a message to your configured Telegram bot' (step 9 of the quick start), but what if you have not set up Telegram yet? There should be a way to verify the jail runtime works without a channel configured -- perhaps a command to create a test jail, run a simple command in it, and tear it down."

This ticket creates a shell script that validates the jail runtime is correctly configured by performing a sequence of checks and optionally creating/destroying a test jail.

### Developer Prompt

```
ROLE: Developer subagent for nc-p7d
TASK: Create scripts/verify-install.sh -- an installation verification smoke test.

READ FIRST:
- refinement/03252026/SHARED_INSTRUCTIONS.md (all rules, especially shell script standards)
- scripts/setup-freebsd.sh (for style reference: colored output, section labels, idempotent checks)
- src/jail/config.ts (for default paths and dataset names to verify)
- src/jail/lifecycle.ts (for understanding jail creation flow)
- etc/pf-nanoclaw.conf (for pf verification)
- reports/freebsd_user_report.md (Section 2, item 3 for the requirement)

SCRIPT REQUIREMENTS:

The script performs graduated verification in 3 tiers:

## Tier 1: Static Checks (no privileges required)
These verify that prerequisites are in place without modifying anything.

1. Node.js version check:
   - node --version exists and is >= 24
   - npm --version exists

2. Project build check:
   - dist/index.js exists (project has been compiled)
   - If not: suggest "npm run build"

3. Configuration check:
   - .env file exists
   - NANOCLAW_RUNTIME is set to "jail" (or auto-detects FreeBSD)
   - ANTHROPIC_API_KEY is set (check .env, do NOT print the value)

4. ZFS checks:
   - zfs command exists
   - Template dataset exists: zfs list zroot/nanoclaw/jails/template
     (use NANOCLAW_TEMPLATE_DATASET from .env if set, else default)
   - Template snapshot exists: zfs list -t snapshot zroot/nanoclaw/jails/template@base
     (use NANOCLAW_TEMPLATE_SNAPSHOT from .env if set, else "base")

5. Package checks:
   - jail(8) exists
   - jexec(8) exists
   - jls(8) exists

## Tier 2: Privileged Checks (requires sudo)
These verify system configuration. Skip with a warning if sudo is not available.

6. pf check:
   - pfctl -si succeeds (pf is enabled and running)
   - pfctl -sr | grep -q 'nanoclaw\|10.99' (nanoclaw rules loaded)

7. Sudoers check:
   - sudo -l lists jail, jexec, zfs commands (sudoers configured)

8. Kernel module check:
   - kldstat | grep -q if_epair (epair module loaded)
   - sysctl security.jail.allow_raw_sockets exists (jail subsystem active)

## Tier 3: Live Smoke Test (optional, requires --smoke-test flag)
This actually creates and destroys a test jail to verify the full lifecycle.

9. Create test jail:
   - Use the existing jail lifecycle to create a jail named "nanoclaw_verify_test"
   - Run a simple command inside: echo "NanoClaw jail runtime OK"
   - Verify the output matches expected
   - Destroy the test jail
   - Clean up all resources (ZFS clone, mounts, epair)
   - Report success or failure with diagnostic output

   Implementation: since the jail lifecycle is in TypeScript, the smoke test
   should invoke a small TypeScript snippet:
     npx tsx -e '
       import { createJail, destroyJail } from "./src/jail/lifecycle.js";
       import { execInJail } from "./src/jail/exec.js";
       // ... create, exec "echo ok", destroy
     '
   OR simply run:
     NANOCLAW_RUNTIME=jail node -e "..." (using compiled dist/)

   If the TypeScript approach is too complex, use direct system commands:
     sudo zfs clone zroot/nanoclaw/jails/template@base zroot/nanoclaw/jails/verify_test
     sudo jail -c name=nanoclaw_verify_test path=/path/to/jails/verify_test ...
     sudo jexec nanoclaw_verify_test echo "NanoClaw jail runtime OK"
     sudo jail -r nanoclaw_verify_test
     sudo zfs destroy zroot/nanoclaw/jails/verify_test

SCRIPT STANDARDS:
- set -euo pipefail at the top
- Colored output matching setup-freebsd.sh style (green PASS, red FAIL, yellow SKIP/WARN)
- Usage/help with --help flag
- --smoke-test flag enables Tier 3 (disabled by default)
- --quiet flag suppresses PASS messages, only shows FAIL/SKIP
- Exit code: 0 if all run checks pass, 1 if any FAIL
- Each check prints: [PASS] description, [FAIL] description + fix suggestion, or [SKIP] reason
- Trap handler to clean up test jail on script interruption (Tier 3 only)
- Script must be idempotent and safe to run multiple times
- Do NOT hardcode paths -- read from .env if available, fall back to defaults from config.ts
- Do NOT print API keys or secrets
- Make executable: the script should have #!/bin/sh header

OUTPUT EXAMPLE:
  NanoClaw Installation Verification
  ===================================

  --- Tier 1: Static Checks ---
  [PASS] Node.js v24.1.0
  [PASS] npm 10.9.2
  [PASS] dist/index.js exists
  [PASS] .env file exists
  [PASS] NANOCLAW_RUNTIME=jail
  [PASS] ANTHROPIC_API_KEY is set
  [PASS] ZFS template dataset exists
  [PASS] ZFS template snapshot exists
  [PASS] jail(8) available
  [PASS] jexec(8) available

  --- Tier 2: Privileged Checks ---
  [PASS] pf is running
  [PASS] NanoClaw pf rules loaded
  [PASS] Sudoers configured for jail operations
  [PASS] if_epair kernel module loaded

  --- Summary ---
  14 passed, 0 failed, 0 skipped

  Installation looks good. Run with --smoke-test to verify jail lifecycle.

Report IMPLEMENTATION_COMPLETE when done.
```

### QA Prompt

```
ROLE: QA subagent for nc-p7d
TASK: Validate scripts/verify-install.sh

READ FIRST:
- refinement/03252026/SHARED_INSTRUCTIONS.md (QA rules, shell script standards)

CHECKS:

[ ] File exists: scripts/verify-install.sh
[ ] File is executable:
    Run: test -x scripts/verify-install.sh && echo "executable" || echo "not executable"
[ ] Shebang line present: first line is #!/bin/sh or #!/usr/bin/env sh
[ ] set -euo pipefail present (or equivalent for /bin/sh: set -eu)
    Note: pipefail is a bash-ism. If #!/bin/sh is used, set -eu is correct.
    If #!/bin/bash is used, set -euo pipefail is correct.
[ ] --help flag works:
    Run: scripts/verify-install.sh --help (should print usage and exit 0)
[ ] --smoke-test flag documented in help output
[ ] --quiet flag documented in help output
[ ] Trap handler present for cleanup:
    Run: grep -c 'trap' scripts/verify-install.sh (must be >= 1)
[ ] No hardcoded personal paths:
    Run: grep -c '/home/jims' scripts/verify-install.sh (must be 0)
[ ] No secrets printed:
    Run: grep -n 'ANTHROPIC_API_KEY' scripts/verify-install.sh
    Verify it checks existence but never echoes the value
[ ] API key check does not print the key value:
    The script must use something like: grep -q ANTHROPIC_API_KEY .env
    NOT: echo $ANTHROPIC_API_KEY or cat .env | grep ANTHROPIC
[ ] All variables quoted (no unquoted $variable expansions in command arguments):
    Run: shellcheck scripts/verify-install.sh (if available, SKIP if not)
    Or manually spot-check for unquoted variables
[ ] Tier 1 checks present (at least):
    - Node.js version
    - dist/index.js existence
    - .env existence
    - ZFS template dataset
    - ZFS template snapshot
    - jail(8) command existence
[ ] Tier 2 checks present (at least):
    - pf running
    - pf rules loaded
    - sudoers configured
[ ] Tier 3 (smoke test) gated behind --smoke-test flag:
    Running without --smoke-test must NOT create any jails
[ ] Exit codes correct:
    - Script exits 0 on all-pass
    - Script exits non-zero on any failure
[ ] Colored output uses standard terminal escape codes (not tput if /bin/sh)
[ ] Fallback defaults match src/jail/config.ts:
    - Template dataset: zroot/nanoclaw/jails/template
    - Template snapshot: base
    - Jail subnet: 10.99
[ ] No references to jail-runtime.js
[ ] Script does not modify any system state in Tier 1 or Tier 2

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only scripts/verify-install.sh
[ ] No secrets or credentials in diff

Report QA_PASS or QA_FAIL with per-check breakdown.
```

---

## Stage 7E: Update DEBUG_CHECKLIST.md for FreeBSD-First Navigation

### Ticket Header

| Field | Value |
|-------|-------|
| **ID** | `nc-p7e` |
| **Title** | Add FreeBSD navigation note to DEBUG_CHECKLIST.md |
| **Priority** | P2 |
| **Tags** | `nanoclaw`, `phase-7`, `docs`, `freebsd` |
| **Files** | `docs/DEBUG_CHECKLIST.md` |
| **Dependencies** | None (within phase) |
| **Effort** | ~3 lines |

### Context

The Synthesis Report (Section 4, Documentation Gap #5) identifies that `docs/DEBUG_CHECKLIST.md` leads with macOS/Docker commands. The current structure is:

- Lines 1-12: Known Issues
- Lines 14-35: Quick Status Check (macOS `launchctl` commands)
- Lines 37-94: Session/Container/Agent debugging (Docker-centric)
- Lines 96-124: Container Mount Issues, WhatsApp Auth
- Lines 126-231: FreeBSD Jails section (starts at line 126 with `## FreeBSD Jails (NANOCLAW_RUNTIME=jail)`)
- Lines 233-250: Service Management (macOS `launchctl` commands again)

A FreeBSD user must scroll past ~125 lines of macOS/Docker content to find relevant debugging commands. Adding a navigation note at the top solves this without restructuring the entire document.

**Impact**: UX improvement for FreeBSD users of the debug checklist.

### Developer Prompt

```
Read refinement/03252026/SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-p7e — Add FreeBSD navigation note to DEBUG_CHECKLIST.md
FILES: docs/DEBUG_CHECKLIST.md

CONTEXT:
The debug checklist leads with macOS/Docker commands. FreeBSD users must scroll
past ~125 lines to find relevant content. Adding a navigation note at the top
helps FreeBSD users jump directly to the relevant section.

CHANGES:

1. Read docs/DEBUG_CHECKLIST.md.

2. After the title line (# NanoClaw Debug Checklist) and before the first
   content section (## Known Issues), add a navigation note:

   > **FreeBSD/Jail users**: Jump to [FreeBSD Jails](#freebsd-jails-nanoclaw_runtimejail) for jail-specific debugging.

   Note: The anchor link must match the actual heading. The FreeBSD section
   heading is "## FreeBSD Jails (NANOCLAW_RUNTIME=jail)" which generates the
   anchor "#freebsd-jails-nanoclaw_runtimejail" in GitHub-flavored markdown
   (lowercase, spaces to hyphens, special chars removed).

3. Verify the anchor target exists by confirming the heading
   "## FreeBSD Jails (NANOCLAW_RUNTIME=jail)" exists in the file.

4. Do NOT reorder any existing sections. Do NOT delete any content.
   Only add the navigation note.

5. Run: npm test
6. Run: npx tsc --noEmit
7. Run: npm run lint
8. Run: npm run format:check

IMPLEMENTATION_COMPLETE
```

### QA Prompt

```
Read refinement/03252026/SHARED_INSTRUCTIONS.md before starting.

TICKET: nc-p7e — Add FreeBSD navigation note to DEBUG_CHECKLIST.md
FILES TO VALIDATE: docs/DEBUG_CHECKLIST.md

BASELINE CHECKS:
[ ] TypeScript compiles: npx tsc --noEmit
[ ] All tests pass: npm test
[ ] Lint passes: npm run lint
[ ] Format check passes: npm run format:check
[ ] No unintended file changes: git diff --stat shows only docs/DEBUG_CHECKLIST.md
[ ] No secrets or credentials in diff: git diff does not contain API keys, tokens, passwords

TICKET-SPECIFIC CHECKS:

[ ] Navigation note exists: A note mentioning "FreeBSD" or "Jail" appears in
    the first 10 lines of docs/DEBUG_CHECKLIST.md, directing users to the
    FreeBSD section.

[ ] Anchor link works: The navigation note contains a markdown link to a
    heading that exists in the document. Verify the target heading
    "## FreeBSD Jails (NANOCLAW_RUNTIME=jail)" exists in the file.

[ ] No content deleted: The total line count of docs/DEBUG_CHECKLIST.md has
    increased (new lines added) or stayed the same — never decreased.
    Compare: wc -l docs/DEBUG_CHECKLIST.md against the original (~251 lines).

[ ] No sections reordered: The order of ## headings is preserved. The headings
    should still be: Known Issues, Quick Status Check, Session Transcript
    Branching, Container Timeout Investigation, Agent Not Responding,
    Container Mount Issues, WhatsApp Auth Issues, FreeBSD Jails, Service
    Management (in that order, with the navigation note before Known Issues).

[ ] Existing content unchanged: No existing lines were modified or deleted.
    The only change should be the addition of the navigation note.

Report each check as PASS or FAIL with details.
Final output: QA_PASS or QA_FAIL
```

---

## Phase Integration QA

After all five stage tickets (7A, 7B, 7C, 7D, 7E) pass individual QA, run this integration QA before creating the Phase 7 PR.

### Integration QA Prompt

```
ROLE: Phase Integration QA subagent
TASK: Validate Phase 7 as a cohesive whole before PR creation.

READ FIRST:
- refinement/03252026/SHARED_INSTRUCTIONS.md
- refinement/03252026/PHASE_PLAN.md (Phase 7 acceptance criteria)

PHASE 7 ACCEPTANCE CRITERIA (from PHASE_PLAN.md):
"Single getting-started doc covers prerequisites through first message.
 Anchor config uses epair (not lo1) and /16 CIDR.
 All jail env vars documented in one file.
 Smoke test script validates jail runtime works.
 Getting-started guide covers credential proxy, channel setup, log locations,
 and two-script relationship. DEBUG_CHECKLIST.md has FreeBSD navigation note."

INTEGRATION CHECKS:

[ ] All five files exist:
    - docs/GETTING_STARTED_FREEBSD.md (7A)
    - etc/pf-nanoclaw-anchor.conf (7B -- modified, not new)
    - docs/ENV_REFERENCE.md (7C)
    - scripts/verify-install.sh (7D)
    - docs/DEBUG_CHECKLIST.md (7E -- modified, not new)

[ ] Cross-references are consistent:
    - GETTING_STARTED_FREEBSD.md links to ENV_REFERENCE.md:
      Run: grep -c 'ENV_REFERENCE' docs/GETTING_STARTED_FREEBSD.md (must be >= 1)
    - GETTING_STARTED_FREEBSD.md references verify-install.sh:
      Run: grep -c 'verify-install' docs/GETTING_STARTED_FREEBSD.md (must be >= 1)
    - ENV_REFERENCE.md does not contradict .env.example defaults:
      Spot-check 3 variables for matching defaults

[ ] Anchor config consistency with standalone config:
    - Both use /16 CIDR for jail subnet:
      Run: grep '10.99.0.0' etc/pf-nanoclaw.conf etc/pf-nanoclaw-anchor.conf
      Both must show /16
    - Both restrict port 443 to <anthropic_api>:
      Run: grep 'port 443' etc/pf-nanoclaw.conf etc/pf-nanoclaw-anchor.conf
      Both must reference <anthropic_api>, neither should allow port 443 to any
    - Both define same anthropic_api table:
      Run: grep 'anthropic_api.*persist' etc/pf-nanoclaw.conf etc/pf-nanoclaw-anchor.conf
      IP ranges must match
    - Both define same trusted_dns:
      Run: grep 'trusted_dns' etc/pf-nanoclaw.conf etc/pf-nanoclaw-anchor.conf
      Must both list 8.8.8.8 and 1.1.1.1

[ ] Getting-started guide covers all documentation gap topics (7A expansion):
    Run: grep -c 'credential proxy\|Credential Proxy' docs/GETTING_STARTED_FREEBSD.md (must be >= 1)
    Run: grep -c 'Adding Channels\|Channel Setup' docs/GETTING_STARTED_FREEBSD.md (must be >= 1)
    Run: grep -c 'nanoclaw.log' docs/GETTING_STARTED_FREEBSD.md (must be >= 1)
    Run: grep -c 'setup-jail-template' docs/GETTING_STARTED_FREEBSD.md (must be >= 1)

[ ] DEBUG_CHECKLIST.md has FreeBSD navigation note (7E):
    Run: head -10 docs/DEBUG_CHECKLIST.md | grep -c 'FreeBSD\|Jail' (must be >= 1)
    The navigation note must appear before the first ## heading.

[ ] No stale references across all Phase 7 files:
    Run: grep -r 'jail-runtime\.js' docs/GETTING_STARTED_FREEBSD.md docs/ENV_REFERENCE.md scripts/verify-install.sh docs/DEBUG_CHECKLIST.md (must be 0)
    Run: grep -r '/home/jims' docs/GETTING_STARTED_FREEBSD.md docs/ENV_REFERENCE.md scripts/verify-install.sh etc/pf-nanoclaw-anchor.conf docs/DEBUG_CHECKLIST.md (must be 0)
    Run: grep -r 'lo1' etc/pf-nanoclaw-anchor.conf (no active rules on lo1)

[ ] Documentation does not contradict code:
    - ENV_REFERENCE.md NANOCLAW_JAIL_SUBNET default matches src/jail/config.ts:
      config.ts says: process.env.NANOCLAW_JAIL_SUBNET || '10.99'
      ENV_REFERENCE.md must say default is "10.99"
    - ENV_REFERENCE.md MAX_EPAIRS range matches src/jail/config.ts:
      config.ts says: Math.min(255, Math.max(1, ...))
      ENV_REFERENCE.md must say min 1, max 255

[ ] verify-install.sh defaults match ENV_REFERENCE.md:
    The script's fallback defaults for template dataset, snapshot name, and subnet
    must match what ENV_REFERENCE.md documents as defaults.

[ ] Build and test integrity:
    Run: npx tsc --noEmit (TypeScript compiles)
    Run: npm test (all tests pass)
    Run: npm run lint (lint passes)
    Run: npm run format:check (format passes)

[ ] Only expected files changed:
    Run: git diff --stat
    Expected: docs/GETTING_STARTED_FREEBSD.md (new), etc/pf-nanoclaw-anchor.conf (modified),
    docs/ENV_REFERENCE.md (new), scripts/verify-install.sh (new),
    docs/DEBUG_CHECKLIST.md (modified)
    No other files should be modified.

[ ] No secrets or credentials in any diff:
    Run: git diff | grep -ciE '(sk-ant-|xoxb-|bot[0-9]+:)' (must be 0)

FINAL VERDICT:
Report INTEGRATION_QA_PASS or INTEGRATION_QA_FAIL with per-check breakdown.
If FAIL, list exactly which checks failed and what needs to be fixed.
```
