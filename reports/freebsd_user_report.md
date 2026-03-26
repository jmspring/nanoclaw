# FreeBSD User Experience Report: NanoClaw with Jails Runtime

**Date:** 2026-03-25
**Perspective:** First-time FreeBSD user, technically capable, evaluating NanoClaw for production deployment with jail-based agent isolation.
**System:** FreeBSD 15.0-RELEASE amd64

---

## Executive Summary

NanoClaw's FreeBSD jail support is impressively thorough for a project that positions jails as an alternative runtime. The documentation covers architecture, security, networking, and troubleshooting in depth. The automated setup script (`scripts/setup-freebsd.sh`) handles the ten-step bootstrap well. However, there are meaningful gaps in the first-time user experience: the two-script setup relationship is confusing, the `CLAUDE.md`/README interplay assumes prior familiarity with the project, environment variable documentation is scattered, and the debugging guide still leads with macOS/Docker commands. A new FreeBSD user can get this running, but will need to piece together information from at least five different documents.

---

## 1. First-Time Setup Experience Assessment

### Step-by-Step Walkthrough

**Step 1: Discovering FreeBSD support.**
The README mentions FreeBSD in exactly two places: the "Quick Start" callout and the FAQ. The callout says:

> **FreeBSD users:** Run `scripts/setup-freebsd.sh` instead. See the [FreeBSD Jails guide](docs/FREEBSD_JAILS.md) for the full setup walkthrough.

This is adequate but slightly misleading. The Docker/macOS quick start is three lines (`fork, cd, claude, /setup`). The FreeBSD path forks immediately into a 900-line shell script that requires root, which is a fundamentally different experience. The README does not prepare you for this difference in complexity.

**Step 2: Reading FREEBSD_JAILS.md.**
This is the primary setup document. It is well-structured with a "Quick Start" section (section 3) that walks through nine steps. However, a first-time user will immediately hit confusion:

- Step 3 says `git clone https://github.com/yourorg/nanoclaw.git` -- the placeholder "yourorg" does not match the README which says `qwibitai/nanoclaw`. A user would need to reconcile these.
- Step 5 creates ZFS datasets manually, but step 6 says to run `setup-jail-template.sh`. Meanwhile, `setup-freebsd.sh` does BOTH of these things automatically. It is unclear whether you should follow the manual steps or run the script. The README says run the script; the FREEBSD_JAILS.md Quick Start gives manual steps first.
- Step 6 says the template script "fetches FreeBSD base system (base.txz)" and "installs Node.js and npm". But reading `setup-jail-template.sh`, it does neither -- it expects `base.txz` to already be extracted and Node.js to already be installed (`if [ ! -x "$TEMPLATE_PATH/usr/local/bin/node" ]; then error...`). Those steps are done by `setup-freebsd.sh`'s `setup_jail_template()` function. This is the most confusing part of the setup: the documentation for step 6 describes what `setup-freebsd.sh` does, not what `setup-jail-template.sh` does.

**Step 3: Deciding which script to run.**
There are two scripts with overlapping responsibilities:
- `scripts/setup-freebsd.sh` -- Full bootstrap (10 steps: packages, kernel, user, ZFS, template base extraction, pf, clone repo, install deps, rc.d service)
- `scripts/setup-jail-template.sh` -- Template finalization (installs npm packages, copies agent-runner, creates snapshot)

`setup-freebsd.sh` calls `setup-jail-template.sh` at the end (line 777). But `setup-jail-template.sh` can also be run standalone for updates. The relationship is not clearly documented. A user reading both scripts would need to figure out that `setup-freebsd.sh` handles the base system extraction and Node.js install, then delegates to `setup-jail-template.sh` for the npm layer.

**Step 4: Running setup-freebsd.sh.**
The script is well-written and I would generally trust running it:
- Idempotent (safe to re-run)
- 10 clearly labeled sections
- Colored output with success/skip/error indicators
- Interactive prompts with sensible defaults (username, ZFS pool, network interface)
- Validates inputs (checks interface exists, pool exists, user exists)
- Creates the sudoers file with proper validation (`visudo -cf`)

**Concerns that would give me pause:**
1. It runs as root and modifies `/boot/loader.conf`, `/etc/sysctl.conf`, `/etc/rc.conf`, and `/etc/pf.conf`. These are system-critical files. The script appends rather than overwrites, but there is no backup step.
2. The sudoers file it creates (lines 267-301) grants the user passwordless sudo for `mkdir`, `chmod`, `chown`, `cp`, and `tee` -- very broad permissions that are not confined to NanoClaw paths. The FREEBSD_JAILS.md section 6 also shows a separate sudoers configuration that includes `NOPASSWD: /bin/sh`, which is effectively unlimited root access. The script's version is more restrictive than the docs suggest, which is good, but the discrepancy is confusing.
3. The `clone_nanoclaw` section (lines 671-783) copies files from a temporary clone into the ZFS dataset. This is unusual -- most users would expect to clone the repo normally first and then run the script from within it. The README says to clone first, but the script tries to clone too.

**Step 5: Post-setup configuration.**
After the script completes, the summary tells you to edit `.env` with API keys and start the service. This is clear. But the `.env.example` file (which does exist and is well-documented) is not mentioned in the summary output, nor in the FREEBSD_JAILS.md quick start. A new user might not know it exists.

### Setup Experience Rating: 6/10

Mechanically sound but requires reading across multiple docs and scripts to understand the full picture. The dual-script confusion is the biggest pain point.

---

## 2. Documentation Completeness and Clarity

### What Is Good

**Architecture documentation is excellent.** The mermaid diagram in FREEBSD_JAILS.md, the ASCII art for network topology, the mount layout table, and the jail lifecycle description are all clear and detailed. This is above-average technical documentation.

**The Linux-to-FreeBSD translation guide (`docs/LINUX_TO_FREEBSD.md`) is outstanding.** This is exactly what a Docker-experienced user needs. The concept translation table, command equivalents, file layout comparison, and "what is fundamentally different" section are extremely well done. This document alone would save hours of confusion.

**Security documentation is thorough.** The sudoers breakdown with risk levels, the devfs ruleset explanation, the security comparison table between Docker/Apple Container/Jails, and the detailed pf firewall rules with extensive comments all demonstrate serious security thinking.

**Troubleshooting section is comprehensive.** FREEBSD_JAILS.md section 8 covers: dataset conflicts, user issues, permission errors, devfs busy, API key problems, DNS failures, TypeScript compilation, orphaned jails, stale mounts, leaked epairs, full ZFS pools, template corruption, and a "nuclear option" full reset. This is more troubleshooting coverage than most commercial products provide.

**The pf configuration file (`etc/pf-nanoclaw.conf`) is a model of documentation.** Every rule is explained. The header includes installation instructions, verification commands, interface detection guidance, and notes about the architecture. The comments about pinned IP ranges vs. DNS resolution for security are a thoughtful touch.

### What Is Missing or Unclear

1. **No unified "Getting Started" for FreeBSD.** The information is scattered across README.md (3 lines), FREEBSD_JAILS.md (detailed but manual-first), setup-freebsd.sh (automated but opaque), and TEMPLATE_SETUP.md (supplementary). A new user has to read all four.

2. **CLAUDE.md is developer-facing, not user-facing.** It lists key files and env vars but assumes you already know the project. For a new user, it does not explain what NanoClaw actually does before diving into file lists.

3. **No "verify your installation" section.** After running setup-freebsd.sh, there is no documented smoke test. The user is told to "send a message to your configured Telegram bot" (step 9 of the quick start), but what if you have not set up Telegram yet? There should be a way to verify the jail runtime works without a channel configured -- perhaps a command to create a test jail, run a simple command in it, and tear it down.

4. **The devfs.rules file is mentioned in FREEBSD_JAILS.md step 4 but not in setup-freebsd.sh.** The setup script does not install devfs.rules. This is a security-critical file that a user must install manually, but this step is only documented in the FREEBSD_JAILS.md manual path, not flagged in the automated script's output.

5. **Channel setup is not documented for FreeBSD.** The README shows `/setup` runs everything for Docker users. For FreeBSD users, after the jail runtime is configured, how do you add a channel? Do you still run `claude` and use `/add-telegram`? Is Claude Code even required for FreeBSD users, or can they configure channels manually?

6. **No documentation on how the credential proxy works with jails.** The `.env.example` mentions `CREDENTIAL_PROXY_PORT` and `CREDENTIAL_PROXY_HOST`, and the pf rules allow traffic to port 3001, but there is no explanation of how credentials flow from the proxy to the jail. The CLAUDE.md mentions "jail hardening in phases 3/12H" for the credential proxy, suggesting this is still in development.

7. **Environment variable documentation is fragmented.** `.env.example` documents runtime vars. `src/jail/config.ts` defines jail-specific vars. FREEBSD_JAILS.md mentions some. CLAUDE.md lists a few. There is no single reference for all jail-relevant env vars. Key vars like `NANOCLAW_ROOT`, `NANOCLAW_JAILS_PATH`, `NANOCLAW_JAILS_DATASET`, `NANOCLAW_TEMPLATE_DATASET`, and `NANOCLAW_TEMPLATE_SNAPSHOT` are configurable via environment but only discoverable by reading the source code.

---

## 3. Prerequisites Not Documented

1. **Claude Code CLI.** The README says Claude Code is required, and the setup flow assumes you have it installed. But is it required for FreeBSD? The setup script does not install it on the host (only inside the jail template). A user might think they need Claude Code on their FreeBSD host to run `/setup`, but the FreeBSD path uses `setup-freebsd.sh` instead. This is unclear.

2. **Passwordless sudo for the setup-jail-template.sh script.** The script header says "Run as a user with passwordless sudo access" and references `docs/TEMPLATE_SETUP.md`. But during initial setup, the sudoers file has not been created yet (that is step 4 of setup-freebsd.sh). If you run setup-jail-template.sh standalone before setup-freebsd.sh, you would need pre-existing sudo access. This bootstrapping dependency is not documented.

3. **Disk space requirements.** The FREEBSD_JAILS.md says "~2GB available space" for ZFS, but does not break down what uses that space: base.txz download (~180MB), extracted base system (~500MB), Node.js and npm packages inside the template (~400MB), plus headroom for jail clones. A more precise estimate would help capacity planning.

4. **Internet connectivity during setup.** The template build downloads packages from pkg.freebsd.org and npm registry. This is obvious but not stated. Air-gapped or restricted-network setups would need guidance.

5. **Node.js version on the host vs. in the jail.** The host needs Node.js 20+ (per package.json `engines`), but the jail template installs `node24`. It is not documented whether the host and jail must use the same version or whether they can differ.

6. **The `RACCT` kernel feature.** `setup-freebsd.sh` checks for RACCT and adds it to loader.conf if missing, but states a reboot is required. The script continues without it. A user who does not reboot before starting NanoClaw will not have rctl resource limits working. This failure is silent -- the code catches the rctl error (`lifecycle.ts:148`) and logs a warning, but the user may not see it.

---

## 4. Configuration Complexity Assessment

### Minimal Configuration (Development)

The minimum `.env` for FreeBSD development is:
```
NANOCLAW_RUNTIME=jail
NANOCLAW_JAIL_NETWORK_MODE=inherit
ANTHROPIC_API_KEY=sk-ant-...
```

Plus at least one channel token (e.g., `TELEGRAM_BOT_TOKEN`). This is comparable to Docker setup complexity. **Rating: Manageable.**

### Production Configuration

For production with restricted networking, the configuration surface includes:
- `.env` with 20+ possible jail-related variables
- `/etc/pf-nanoclaw.conf` with interface and network configuration
- `/etc/devfs.rules` with device access rules
- `/usr/local/etc/sudoers.d/nanoclaw` with privilege escalation rules
- `/boot/loader.conf` with kernel module loading
- `/etc/sysctl.conf` with IP forwarding
- `/etc/rc.conf` with service and pf enablement
- ZFS dataset hierarchy with correct mountpoints and permissions

This is significantly more complex than Docker, where production setup adds approximately zero configuration beyond the basic `.env`. **Rating: Complex but well-documented.** The pf rules file alone is 300 lines of well-commented configuration. The complexity is inherent to FreeBSD jails, not artificially introduced.

### Configuration Pain Points

1. **The `ext_if` placeholder in pf-nanoclaw.conf.** The file ships with `ext_if = "NANOCLAW_EXT_IF_PLACEHOLDER"` which will not work if loaded directly. The setup script substitutes it, but if a user copies the file manually (as the FREEBSD_JAILS.md manual steps suggest), they might not realize they need to change it.

2. **ZFS dataset naming is hardcoded in multiple places.** `zroot/nanoclaw/jails` appears in the setup scripts, jail config defaults, pf rules documentation, and troubleshooting commands. If a user's pool is not named `zroot`, they must update all of these. The config.ts uses environment variables for this, but the documentation examples all use `zroot`.

3. **The rc.d service script hardcodes the username.** Line 22: `${nanoclaw_user:="jims"}`. This is the project creator's username. A new user must override this in `/etc/rc.conf` with `nanoclaw_user="theirname"`. The setup script does handle this, but if someone installs the rc.d script manually, they get a broken default.

---

## 5. Troubleshooting Guidance Availability

### Strengths

- **FREEBSD_JAILS.md section 8** covers eight distinct failure scenarios with explicit commands.
- **DEBUG_CHECKLIST.md** has a dedicated "FreeBSD Jails" section with quick status checks, networking diagnostics, mount inspection, and orphan cleanup.
- **Recovery procedures** include graduated options: manual cleanup, orphan detection, full reset.
- **Error messages in code are actionable.** Examples:
  - `"Cannot create jail: maximum concurrent jail limit reached (50). Currently active: 48. Configure NANOCLAW_MAX_JAILS to adjust limit."` -- tells you what happened, what the limit is, and how to fix it.
  - `"FATAL: Jail runtime requirements not met. Ensure ZFS is available, template snapshot exists, and jail(8) is in PATH"` -- gives three things to check.
  - `"Security: jail mount hostPath matches blocked pattern '.ssh'"` -- explains the security policy violation.

### Weaknesses

- **DEBUG_CHECKLIST.md leads with macOS/Docker commands.** The "Quick Status Check" section at the top uses `launchctl` and `container ls`. A FreeBSD user must scroll past 125 lines of irrelevant content to reach the jail section. There should be a note at the top directing FreeBSD users to the right section.
- **No log location is documented.** Where do logs go? `logs/nanoclaw.log` is referenced in DEBUG_CHECKLIST.md, but the rc.d script sends output to `/var/log/nanoclaw.log` (line 27). Which is it? For development (`npm run dev`) vs. production (`service nanoclaw start`), the log locations differ.
- **pf debugging requires knowledge of pf.** The troubleshooting section says "watch blocked packets" with `tcpdump -n -e -ttt -i pflog0`, but does not explain how to interpret the output. A user who has never used pf would not know what to look for.
- **No "common first-run failures" section.** The most likely first-run failures are: API key not set, template snapshot not created, ZFS pool full, sudoers not configured. These should be front-and-center, not buried in a general troubleshooting list.

---

## 6. Error Message Quality Assessment

### Good Error Messages

From `src/jail/mounts.ts`:
```
Security: jail mount hostPath must be absolute: "/relative/path"
Security: jail mount hostPath does not exist: "/nonexistent/path"
```
These are clear, include the offending value, and categorize as security issues.

From `src/jail/lifecycle.ts`:
```
Cannot create jail: maximum concurrent jail limit reached (50).
Currently active: 48. Configure NANOCLAW_MAX_JAILS to adjust limit.
```
States the problem, gives numbers, and suggests a fix.

From `src/jail/network.ts`:
```
Epair pool exhausted (200/200). Wait for jails to complete.
```
Concise, includes current/max counts, gives actionable advice.

### Error Messages That Could Be Improved

From `src/jail/cleanup.ts`:
```
Jail runtime requirements not met
```
This is thrown after a fatal-level log message with more detail, but the thrown Error itself is too sparse. If this bubbles up to a user who does not have structured logging visible, they get no guidance.

From `src/jail/exec.ts`:
```
Jail nanoclaw_test is not running
```
This could suggest: "Check if the jail was created successfully with `sudo jls -N | grep nanoclaw_test`, or verify the template snapshot exists."

From `src/jail/network.ts`:
```
Unexpected epair name format: epair
```
This would confuse a user. It should explain what format was expected and suggest checking `ifconfig` output.

### Overall Error Message Quality: 7/10

Most errors are clear and actionable. The structured logging with `pino` includes context objects (jail name, group ID, error details), which is excellent for debugging. The main gap is that thrown Error messages are sometimes terse while the associated log messages are detailed -- if a user only sees the thrown error (e.g., in a crash), they miss the diagnostic information.

---

## 7. Comparison: FreeBSD Setup vs. Docker Setup

| Aspect | Docker Setup | FreeBSD Jail Setup |
|--------|-------------|-------------------|
| **Initial command** | `claude` then `/setup` | `sudo ./scripts/setup-freebsd.sh` |
| **Time to first run** | ~5 minutes | ~15-30 minutes |
| **Requires root** | No (Docker group) | Yes (sudo for jails, ZFS, pf) |
| **Files modified** | `.env`, launchd/systemd | `.env`, loader.conf, sysctl.conf, rc.conf, pf.conf, devfs.rules, sudoers |
| **Reboot required** | No | Possibly (for RACCT if rctl desired) |
| **Networking setup** | Automatic | Manual (pf rules, IP forwarding) or script |
| **Template management** | `docker pull` (implicit) | `setup-jail-template.sh` (explicit) |
| **Ongoing maintenance** | Docker updates | Template rebuilds, pf rule updates, ZFS monitoring |
| **Documentation needed** | README + /setup | README + FREEBSD_JAILS.md + LINUX_TO_FREEBSD.md + TEMPLATE_SETUP.md + DEBUG_CHECKLIST.md |
| **Rollback story** | `docker rmi` + `docker pull` | ZFS snapshot rollback (well-supported) |

**Verdict:** FreeBSD setup is 3-5x more complex than Docker. This is inherent to the technology (jails require explicit configuration that Docker abstracts away) and largely unavoidable. The documentation does a good job explaining the "why" behind each step. The `setup-freebsd.sh` script reduces the practical complexity significantly, but a user still needs to understand more about their system to debug issues.

---

## 8. Specific Documentation Improvements Needed

### High Priority

1. **Unify the setup path.** The FREEBSD_JAILS.md "Quick Start" should lead with `setup-freebsd.sh` and describe what it does, rather than presenting manual steps that the script automates. Keep the manual steps as an appendix for users who want fine control.

2. **Document the two-script relationship.** Add a clear note:
   > `setup-freebsd.sh` bootstraps the entire system (packages, ZFS, kernel, template base, pf, service). It calls `setup-jail-template.sh` at the end to finalize the jail template. You only need to run `setup-jail-template.sh` standalone when updating the template after code changes.

3. **Add a "Verify Installation" section.** After setup, provide a test command:
   ```sh
   # Quick smoke test: create a jail, run a command, destroy it
   cd /path/to/nanoclaw/src
   NANOCLAW_RUNTIME=jail npm run dev  # Start once, Ctrl+C after "Jail runtime verified"
   ```

4. **Fix the rc.d default username.** Change `${nanoclaw_user:="jims"}` to a generic default like `${nanoclaw_user:="nanoclaw"}` or document the override prominently.

5. **Add devfs.rules installation to setup-freebsd.sh.** The script configures pf, sudoers, kernel modules, and the rc.d service, but does not install the devfs.rules file. This is a security-relevant omission.

6. **Create a consolidated environment variable reference** for jail-relevant configuration, either in FREEBSD_JAILS.md or as a standalone file. Include all variables from `.env.example` plus the undocumented path overrides (`NANOCLAW_ROOT`, `NANOCLAW_JAILS_PATH`, etc.).

### Medium Priority

7. **Add FreeBSD section marker to DEBUG_CHECKLIST.md header.** At the top, add: "FreeBSD/Jail users: jump to [FreeBSD Jails section](#freebsd-jails-nanoclaw_runtimejail)."

8. **Document log file locations.** Development: `logs/nanoclaw.log` (relative to cwd). Production via rc.d: `/var/log/nanoclaw.log`. Make this explicit in both FREEBSD_JAILS.md and DEBUG_CHECKLIST.md.

9. **Fix the git clone URL in FREEBSD_JAILS.md.** Change `yourorg` to `qwibitai` to match the README, or use a placeholder with a clear note.

10. **Add a "What NanoClaw Does" section to the top of FREEBSD_JAILS.md.** The document jumps straight into architecture. A one-paragraph summary of what NanoClaw is and why you would use it on FreeBSD would help users who arrive at this page directly.

11. **Document channel setup for FreeBSD.** After the jail runtime is configured, explain how to add channels. If Claude Code is needed on the host, say so. If channels can be configured by editing `.env` directly (e.g., setting `TELEGRAM_BOT_TOKEN`), document that as the FreeBSD path.

### Low Priority

12. **The `setup-jail-template.sh` header references `docs/TEMPLATE_SETUP.md` for "detailed sudo requirements"** but the document's sudo section just repeats the same information. Consider consolidating.

13. **The pf-nanoclaw.conf MANUAL SETUP section (line 55) hardcodes `/home/jims/code/nanoclaw/src/etc/pf-nanoclaw.conf`.** This should use a generic path or placeholder.

14. **Add ZFS space usage estimates** to the requirements section: base.txz (~180MB), extracted template (~500MB), Node.js + npm packages (~400MB), per-jail COW overhead (~5-50MB depending on activity).

---

## 9. Proposed "Getting Started with NanoClaw on FreeBSD" Outline

This is a proposed single-document guide that would replace the current multi-document setup path:

```
# Getting Started with NanoClaw on FreeBSD

## What Is NanoClaw?
- One paragraph: personal AI assistant, agents in isolated jails, channel-based messaging

## Before You Begin
- FreeBSD 15.0+ with ZFS root
- 4GB+ RAM, 2GB+ ZFS free space
- An Anthropic API key (https://console.anthropic.com)
- A messaging channel (Telegram bot token, or similar)
- Internet access during setup (downloads ~700MB)

## Quick Setup (Automated)
1. Clone: `git clone https://github.com/qwibitai/nanoclaw.git && cd nanoclaw/src`
2. Run: `sudo ./scripts/setup-freebsd.sh`
3. Configure: `cp .env.example .env && vi .env` (set API key and channel token)
4. Test: `npm run dev` (watch for "Jail runtime verified")
5. Enable service: `sudo service nanoclaw start`

## What the Setup Script Does
- [List of 10 sections with one-line descriptions]
- Relationship to setup-jail-template.sh

## Verify Your Installation
- Smoke test commands
- Expected output
- Common first-run errors and fixes

## Adding Channels
- How to add Telegram, Slack, Discord
- Where to put tokens
- Testing channel connectivity

## Development vs. Production
- Network modes (inherit vs. restricted)
- When to switch to restricted mode
- pf configuration overview

## Updating
- How to update NanoClaw code
- How to rebuild the jail template
- Blue/green template upgrades

## Troubleshooting
- Top 5 most common issues with fixes
- Where to find logs
- How to get help

## Further Reading
- Links to FREEBSD_JAILS.md (deep dive)
- Links to LINUX_TO_FREEBSD.md (Docker users)
- Links to SECURITY.md (security model)
- Links to TEMPLATE_SETUP.md (template management)
```

---

## 10. What Would Make Me Confident to Run This in Production?

### Already Confident About

- **Security model is sound.** ZFS clones, nullfs mounts, restrictive devfs rules, per-jail vnet, pf egress filtering, rctl resource limits. This is defense in depth.
- **Code quality is high.** The jail modules are well-structured, errors are caught and logged, mount paths are validated against a blocklist, jail names are sanitized.
- **Cleanup is robust.** Orphan detection on startup, cleanup-on-failure in lifecycle management, the "nuclear option" reset procedure.
- **The pf rules are production-grade.** Pinned IP ranges instead of DNS resolution, inter-jail isolation, trusted DNS whitelist, logged blocked packets.

### Would Need Before Production

1. **A documented backup strategy.** What to back up (groups/, data/, .env), how to restore, whether ZFS snapshots of the data datasets are recommended.

2. **Monitoring and alerting guidance.** The health/metrics endpoint exists (`HEALTH_ENABLED`, `METRICS_ENABLED` in .env.example) but is not documented in the FreeBSD guide. How to integrate with Prometheus/Grafana, what metrics are exposed, what alerts to set up.

3. **Log rotation configuration.** The `.env.example` shows `LOG_ROTATION_SIZE=10M` and `LOG_ROTATION_MAX_FILES=5`, but the rc.d service sends daemon output to `/var/log/nanoclaw.log` without newsyslog integration. Production systems need proper log rotation.

4. **Upgrade procedures tested end-to-end.** The blue/green template upgrade is documented but complex. I would want to test: pull new code, build new template, switch, verify, rollback.

5. **A documented disaster recovery runbook.** Beyond the "nuclear option": what if the ZFS pool degrades? What if the host crashes mid-jail-creation? What if pf rules get corrupted?

6. **The credential proxy should be documented.** How secrets flow from the host to jails is security-critical. The current state ("jail hardening in phases 3/12H") suggests this is still being developed.

7. **The `/bin/sh` sudoers entry should be eliminated.** The FREEBSD_JAILS.md sudoers section includes `NOPASSWD: /bin/sh` which effectively grants full root access. The `setup-freebsd.sh` version is more restrictive but still grants broad permissions for `/bin/mkdir`, `/bin/chmod`, `/usr/sbin/chown`, `/bin/cp`, and `/usr/bin/tee` without path restrictions. Production hardening should restrict these to NanoClaw-specific paths.

---

## Appendix: File Reference

| File | Assessment |
|------|-----------|
| `/home/jims/code/nanoclaw/src/README.md` | Good overview, adequate FreeBSD pointers |
| `/home/jims/code/nanoclaw/src/docs/FREEBSD_JAILS.md` | Comprehensive but needs unified setup path |
| `/home/jims/code/nanoclaw/src/docs/LINUX_TO_FREEBSD.md` | Excellent translation guide |
| `/home/jims/code/nanoclaw/src/docs/TEMPLATE_SETUP.md` | Good template management reference |
| `/home/jims/code/nanoclaw/src/docs/SUDOERS.md` | Detailed privilege documentation |
| `/home/jims/code/nanoclaw/src/docs/SECURITY.md` | Solid security model overview |
| `/home/jims/code/nanoclaw/src/docs/DEBUG_CHECKLIST.md` | Useful but macOS-first ordering |
| `/home/jims/code/nanoclaw/src/scripts/setup-freebsd.sh` | Well-structured bootstrap script |
| `/home/jims/code/nanoclaw/src/scripts/setup-jail-template.sh` | Solid template builder with validation |
| `/home/jims/code/nanoclaw/src/etc/pf-nanoclaw.conf` | Production-grade firewall rules |
| `/home/jims/code/nanoclaw/src/etc/devfs.rules` | Properly restrictive device ruleset |
| `/home/jims/code/nanoclaw/src/etc/rc.d/nanoclaw` | Functional but hardcodes author's username |
| `/home/jims/code/nanoclaw/src/.env.example` | Well-documented with comments |
| `/home/jims/code/nanoclaw/src/src/jail/config.ts` | Clean configuration with env var overrides |
| `/home/jims/code/nanoclaw/src/CONTRIBUTING.md` | Clear skill taxonomy, good PR guidelines |
