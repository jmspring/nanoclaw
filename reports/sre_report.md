# NanoClaw SRE Assessment Report

**Date:** 2026-03-25
**Reviewer:** SRE Audit (GitHub + FreeBSD Focus)
**Branch:** main (commit 6122b16)
**Platform:** FreeBSD 15.0-RELEASE, jail runtime

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Build Automation Assessment](#2-build-automation-assessment)
3. [Reliability Concerns](#3-reliability-concerns)
4. [Monitoring and Observability](#4-monitoring-and-observability)
5. [Service Management and Process Supervision](#5-service-management-and-process-supervision)
6. [Deployment and Upgrade Strategies](#6-deployment-and-upgrade-strategies)
7. [Backup and Disaster Recovery](#7-backup-and-disaster-recovery)
8. [Network Security and Firewall Configuration](#8-network-security-and-firewall-configuration)
9. [FreeBSD-Specific Reliability Improvements](#9-freebsd-specific-reliability-improvements)
10. [Logging and Audit Trail Assessment](#10-logging-and-audit-trail-assessment)
11. [CI/CD Pipeline Recommendations](#11-cicd-pipeline-recommendations)
12. [Prioritized Recommendations](#12-prioritized-recommendations)

---

## 1. Executive Summary

NanoClaw is a well-architected single-process Node.js application with a mature FreeBSD jail runtime. The codebase demonstrates strong security fundamentals: pinned API IP ranges in pf rules, per-jail credential proxy tokens, restrictive devfs rulesets, rctl resource limits, and ZFS filesystem isolation. The error handling in jail lifecycle code uses retry-with-backoff and audit logging, and graceful shutdown is properly handled.

However, from an SRE perspective, several areas need attention:

- **CI/CD covers only lint/typecheck/test** -- no integration tests, no FreeBSD-specific testing, no container image validation.
- **No WAL mode on SQLite** -- risks database corruption on crash.
- **rc.d service script is minimal** -- no health check integration, no restart policy, no watchdog.
- **Metrics are opt-in and in-process** -- no external scraping configured, no alerting.
- **No automated ZFS snapshot policy** for the data directory.
- **Credential proxy has no TLS** between proxy and jails.
- **Rate limit state is in-memory** -- lost on restart, no persistence.

The system is well-suited for its single-user personal assistant use case, but the following recommendations would significantly improve reliability for any long-running FreeBSD deployment.

---

## 2. Build Automation Assessment

### 2.1 CI/CD Pipeline (GitHub Actions)

**Current state:** Six workflow files in `.github/workflows/`:

| Workflow | Trigger | Purpose | Assessment |
|----------|---------|---------|------------|
| `ci.yml` | PR to main | Format check, typecheck, vitest | Adequate but minimal |
| `bump-version.yml` | Push to main (src/container changes) | Auto-patch version | Good automation |
| `label-pr.yml` | PR open/edit | Auto-label by type | Good hygiene |
| `fork-sync-skills.yml` | Dispatch + schedule (6h) + push | Sync upstream + merge skill branches | Sophisticated, well-designed |
| `merge-forward-skills.yml` | Push to main (upstream only) | Merge main into skill branches | Mirrors fork-sync for upstream |
| `update-tokens.yml` | Push to main | Badge update | Non-critical |

**Gaps identified:**

1. **No FreeBSD CI runner.** The `ci.yml` runs on `ubuntu-latest`. All jail-related code paths (`src/jail/*.ts`) are exercised only via unit tests that mock system calls. There is no integration test that verifies actual jail creation, ZFS cloning, epair networking, or pf rule loading on FreeBSD.

2. **No container/jail template build validation.** Neither `container/build.sh` nor `scripts/setup-jail-template.sh` is tested in CI. A regression in the Dockerfile or template script would not be caught until manual deployment.

3. **No security scanning.** No `npm audit`, no SAST, no dependency vulnerability scanning in CI.

4. **No deployment workflow.** No CD pipeline to deploy to the FreeBSD host. Deployment is manual (`git pull && npm run build && service nanoclaw restart`).

5. **The `ci.yml` does not run the ESLint step.** It runs `npm run format:check` and `npx tsc --noEmit` and `npx vitest run`, but omits `npm run lint`. The `eslint-plugin-no-catch-all` dependency suggests there are lint rules that could catch bugs (empty catch blocks, etc.) but they are not enforced in CI.

### 2.2 Build Scripts

**`container/build.sh`** (24 lines): Simple wrapper around `docker build`. Supports custom tag and runtime override. No multi-platform build, no layer caching optimization, no image signing or vulnerability scanning.

**`scripts/setup-freebsd.sh`** (~760 lines): Comprehensive and idempotent. Handles pre-flight checks, package installation, kernel module loading, user/sudoers setup, ZFS datasets, jail template creation, pf configuration, NanoClaw cloning/building, devfs rules, and rc.d service installation. Well-structured with colored output and proper error handling.

**`scripts/setup-jail-template.sh`** (~417 lines): Excellent build hygiene:
- Uses `npm ci` (not `npm install`) for reproducible builds with integrity verification.
- Pins global package versions (`typescript@5.7.3`, `@anthropic-ai/claude-code@0.2.76`).
- Validates the snapshot by creating and verifying a test clone.
- Generates SHA-256 manifest for template integrity verification.
- Supports blue/green template deployment (pass template name as argument).
- Has proper cleanup trap for the temporary jail.

**Concern in `setup-freebsd.sh`:** The entrypoint script created at line 505 does NOT use the pre-compiled TypeScript optimization that `setup-jail-template.sh` later adds. This is fine if users always run both scripts, but could cause confusion.

### 2.3 Reproducibility

**Strengths:**
- `package-lock.json` required and enforced via `npm ci`.
- Global npm packages pinned to specific versions in `setup-jail-template.sh`.
- Template snapshot provides a consistent base for all jails.
- SHA-256 manifest for template integrity.

**Weaknesses:**
- `setup-freebsd.sh` installs packages via `pkg install -y node24 npm-node24` without version pinning (gets latest from pkg repo).
- No lockfile or hash verification for `base.txz` download from FreeBSD mirrors.
- `container/build.sh` does not pin the base image or verify its digest.

---

## 3. Reliability Concerns

### 3.1 Database (SQLite) -- `src/db.ts`

**Critical: No WAL mode enabled.** The database is opened with default journal mode (DELETE). In a crash scenario (power loss, OOM kill, SIGKILL), this risks:
- Database corruption if a write was in progress.
- Readers blocking writers (or vice versa) during concurrent access from the main loop, IPC watcher, and scheduler.

The database does use `better-sqlite3` which provides some protection via serialization, but WAL mode is the standard recommendation for single-writer, multi-reader SQLite deployments.

**Recommendation:** Add after `db = new Database(DB_PATH)`:
```typescript
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
```

**Schema migrations:** Handled via try/catch `ALTER TABLE` -- functional but fragile. No version tracking. If a migration partially applies and crashes, there is no way to detect the inconsistent state.

**Backup:** `backupDatabase()` runs daily via `setInterval`, keeping 7 most recent copies. This is good. However:
- Backups are stored in the same filesystem (`store/backups/`). A ZFS pool failure loses both primary and backup.
- No backup verification (restored backup is never tested).
- The backup runs inside the main event loop; a very large database could cause latency.

### 3.2 Error Handling Patterns

**Jail lifecycle (`src/jail/lifecycle.ts`):** Strong error handling:
- `createJail()` catches errors and calls `cleanupJail()` to undo partial creation.
- `cleanupJail()` collects errors during multi-step teardown and logs them without short-circuiting. Uses `retryWithBackoff()` for stop, epair release, and dataset destroy operations.
- Token revocation happens in a `finally` block, ensuring credentials are cleaned up even if cleanup fails.
- Concurrent jail limit enforced (`MAX_CONCURRENT_JAILS`).

**Jail exec (`src/jail/exec.ts`):** Well-structured:
- Supports timeout, abort signal, and streaming output.
- Timeout handler kills all jail processes via `jexec kill -9 -1` before killing the spawn.
- Settled flag prevents double-resolve/reject.

**Concern -- `stopJail()` escalation:** The graceful-to-force escalation in `stopJail()` (lines 395-430) catches the graceful stop error but swallows the `.catch(() => {})` on the kill command. If the jail is already stopped when kill is attempted, this is fine. But if kill fails for a different reason (e.g., permission denied), that failure is silently lost.

**Concern -- `cleanupByJailName()` derives groupId incorrectly:** At line 630, `const groupId = jailName.replace(/^nanoclaw_/, '')` strips the `nanoclaw_` prefix. But `getJailName()` generates names as `nanoclaw_${sanitizedGroupId}_${hash}`. So `cleanupByJailName` passes `${sanitizedGroupId}_${hash}` as the groupId, which will then be re-hashed by `getJailName()` inside `cleanupJail()`, producing a DIFFERENT jail name. This means orphan cleanup via `cleanupByJailName` could target the wrong dataset. However, `cleanupJail()` discovers nullfs mounts by inspecting the actual mount table when no mounts are provided (lines 450-473), which mitigates the worst case.

### 3.3 Credential Proxy (`src/credential-proxy.ts`)

**Strengths:**
- Per-jail token authentication prevents jail A from using jail B's proxy session.
- Source IP validation restricts access to jail subnet or localhost.
- Path validation restricts proxied URLs to `/v1/` and `/api/oauth/`.
- Per-IP rate limiting (60 requests per 60 seconds per IP).
- Hop-by-hop and internal headers stripped before forwarding.

**Concerns:**
- **No TLS between jail and proxy.** Traffic between the jail (10.99.N.2) and the credential proxy (10.99.N.1:3001) travels over the epair unencrypted. On a single host this is acceptable (no physical network exposure), but a compromised jail could potentially sniff traffic from another jail's epair if kernel-level vnet isolation is bypassed.
- **Rate limit state is in-memory.** Lost on process restart. An attacker could restart-storm the proxy to reset rate limits. Given this is a single-user system, this is low risk.
- **No request body size limit.** A malicious jail could send arbitrarily large request bodies to the proxy, potentially exhausting memory. The proxy buffers the entire request body (`chunks.push(c)`) before forwarding.

### 3.4 Graceful Shutdown (`src/index.ts`)

**Well-implemented.** The shutdown handler:
1. Saves session state.
2. Closes credential proxy server.
3. Closes metrics server.
4. Drains the group queue with 10-second timeout.
5. Disconnects all channels.
6. Cleans up all jails (via `jail.shutdownAllJails()`).
7. Closes rotating log streams.
8. Clears intervals (health checks, session save, log cleanup, DB backup).
9. Exits with code 0.

**Concern:** The `shuttingDown` flag prevents re-entrant shutdown, but `process.exit(0)` at line 650 will not wait for async cleanup to complete if Node.js's event loop has already drained. Consider using `process.exitCode = 0` and letting the event loop exit naturally after all cleanup completes.

**Concern:** Admin alert failure counter (`consecutiveAgentFailures`) resets on any successful agent run. If failures happen across different groups, the counter will be inflated (correct) but there is no per-group isolation of failure tracking.

---

## 4. Monitoring and Observability

### 4.1 Health Check Endpoint

**Present and well-designed** (`src/jail/metrics.ts`):
- `/health` (enabled by default): Checks template snapshot existence, ZFS pool space, and pf status.
- Returns 200 (healthy) or 503 (unhealthy) with JSON body.
- Binds to `127.0.0.1` only (not exposed externally).

**Gaps:**
- Health check does not verify database accessibility.
- Health check does not verify credential proxy is responding.
- Health check does not verify that any messaging channel is connected.
- No external health check integration (no watchdog, no load balancer to consume the endpoint).

### 4.2 Metrics Endpoint

**Present but opt-in** (`METRICS_ENABLED=false` by default):
- Prometheus text format on `/metrics`.
- Tracks: active jails, jail creation success/failure counters, epair usage, ZFS pool available bytes.

**Gaps:**
- **No Prometheus scraper configured.** The metrics endpoint exists but nothing collects from it.
- **No alerting rules.** No thresholds for ZFS space exhaustion, jail creation failure rate, or epair pool exhaustion.
- **Missing metrics:** No message processing latency, no queue depth, no channel connection status, no credential proxy request count/latency, no agent execution duration histogram.
- **Metrics are in-process.** If the NanoClaw process crashes, historical metrics are lost. No pushgateway integration.
- **Counters reset on restart** (in-memory only). This means Prometheus `rate()` calculations will show artificial spikes after restart.

### 4.3 Structured Logging

**Good foundation** (`src/logger.ts`):
- Uses `pino` with structured JSON output to file and pretty console.
- Rotating file stream (10MB, daily rotation, gzip compression, 5 file max).
- Trace ID support via `createTracedLogger()` for request correlation.
- `uncaughtException` and `unhandledRejection` handlers log to pino before exit.

**Gaps:**
- No log aggregation or shipping (no syslog, no Loki, no ELK).
- Log level defaults to `info`; jail operations at `debug` level will not be visible unless explicitly configured.
- The `cleanupOrphanEpairs()` function at `src/jail/cleanup.ts:127` has an empty catch block that silently swallows errors during interface listing. This could mask systemic issues.

---

## 5. Service Management and Process Supervision

### 5.1 rc.d Service Script (`etc/rc.d/nanoclaw`)

The script is minimal (30 lines) and relies on `daemon(8)` for process supervision:

```sh
command="/usr/sbin/daemon"
command_args="-f -p ${pidfile} -u ${nanoclaw_user} -o /var/log/nanoclaw.log /usr/local/bin/node ${nanoclaw_dir}/dist/index.js"
```

**Strengths:**
- Uses `daemon -f` for proper daemonization with PID file.
- Redirects stdout/stderr to `/var/log/nanoclaw.log`.
- Configurable user and directory.

**Weaknesses:**

1. **No automatic restart on crash.** `daemon(8)` does not respawn the process on exit. If NanoClaw crashes, it stays down until manually restarted. FreeBSD's `daemon -r` flag enables respawning.

   **Fix:** Change `command_args` to include `-r 5` (restart after 5-second delay):
   ```sh
   command_args="-f -r 5 -p ${pidfile} -u ${nanoclaw_user} -o /var/log/nanoclaw.log /usr/local/bin/node ${nanoclaw_dir}/dist/index.js"
   ```

2. **No readiness check.** The service is considered "started" as soon as the process is forked, not when the health endpoint returns 200. This means `service nanoclaw status` can report success even if the application failed to initialize.

3. **No resource limits in rc.d.** The daemon runs with whatever limits the user has. Consider adding `limits(1)` or `rctl` for the daemon process itself.

4. **Log output goes to a single non-rotated file** (`/var/log/nanoclaw.log`). The application has its own rotating log in `logs/nanoclaw.log`, so `/var/log/nanoclaw.log` will accumulate stdout/stderr indefinitely.

   **Fix:** Add log rotation via `newsyslog.conf`:
   ```
   /var/log/nanoclaw.log   nanoclaw:wheel 640 7 * @T00 JC
   ```

5. **Hardcoded user default** (`jims`). Should default to a generic `nanoclaw` user or require explicit configuration.

6. **No `required_modules`** declaration. Should declare `required_modules="zfs"` since the jail runtime requires ZFS.

7. **No pre-start hook** to verify template snapshot exists before starting.

### 5.2 Process Supervision Comparison

| Feature | Current (daemon -f) | daemon -r | supervisord | native rc.d |
|---------|---------------------|-----------|-------------|-------------|
| Auto-restart | No | Yes | Yes | No |
| Health check restart | No | No | Yes | No |
| Backoff on crash loop | No | Fixed delay | Configurable | No |
| Resource limits | No | No | Yes | Via rctl |
| Log management | Manual | Manual | Built-in | newsyslog |

**Recommendation:** At minimum, use `daemon -r 5` for auto-restart. For production, consider adding a health-check-based restart mechanism (a cron job that checks `/health` and restarts if unhealthy).

---

## 6. Deployment and Upgrade Strategies

### 6.1 Current Deployment Process

1. `git pull` to get latest code.
2. `npm ci && npm run build` to rebuild.
3. `sudo service nanoclaw restart` to restart.
4. (Optional) `./scripts/setup-jail-template.sh` if jail template needs updating.

**Issues:**
- **No zero-downtime deployment.** Service restart drops all active connections and aborts in-progress agent runs. The graceful shutdown handler waits 10 seconds for the queue to drain, but long-running agents (up to 30 minutes) will be killed.
- **No rollback mechanism.** If the new version is broken, the operator must manually `git revert` and rebuild.
- **Template updates require stopping all jails.** The setup-jail-template.sh script checks for dependent clones and fails if any exist, meaning all agents must be stopped first.

### 6.2 Recommendations

1. **Blue/green template deployment** is already supported (`./setup-jail-template.sh template-v2` + `NANOCLAW_TEMPLATE_DATASET` env var). Document a standard operating procedure and consider automating it.

2. **Canary deployment:** Since there is only one Node.js process, true canary deployment is not possible without a second instance. Consider a deployment script that:
   - Builds the new version to a staging directory.
   - Runs the test suite against the staging build.
   - Swaps the `dist/` symlink atomically.
   - Restarts the service.

3. **Rollback:** Tag releases in git. Keep the previous `dist/` build as `dist.prev/`. Add a rollback script.

---

## 7. Backup and Disaster Recovery

### 7.1 What is Backed Up

| Data | Backup Method | Frequency | Retention | Off-host? |
|------|---------------|-----------|-----------|-----------|
| SQLite DB | `backupDatabase()` | Daily | 7 copies | No |
| Group CLAUDE.md files | None (git-tracked) | N/A | Git history | If pushed |
| Session state | `session-state.json` | Every 5 min | 1 copy | No |
| ZFS template snapshot | `@base` snapshot | Manual | 1 + 1 backup | No |
| Epair state | `data/epairs.json` | On change | 1 copy | No |
| .env (credentials) | None | N/A | N/A | No |

### 7.2 Gaps

1. **No off-host backup.** All backups are on the same ZFS pool. A pool failure (unlikely but possible) loses everything. Consider `zfs send` to a remote host or `rclone`/`restic` to object storage.

2. **No ZFS snapshot policy for the data directory.** The `store/` and `groups/` directories contain the database and group workspaces but have no periodic ZFS snapshots. A `zfs snapshot -r` cron job would provide point-in-time recovery.

3. **No credential backup.** The `.env` file with API keys is not backed up and has no documented recovery procedure.

4. **No documented DR procedure.** If the host is destroyed, there is no runbook for rebuilding from scratch.

### 7.3 Recommendations

1. Add a ZFS snapshot cron job:
   ```sh
   # /etc/cron.d/nanoclaw-snapshots
   0 */4 * * * root zfs snapshot -r zroot/nanoclaw@auto-$(date +\%Y\%m\%d-\%H\%M)
   # Prune snapshots older than 7 days
   0 3 * * * root zfs list -t snapshot -o name -H | grep '@auto-' | head -n -42 | xargs -I{} zfs destroy {}
   ```

2. Add `zfs send` to a remote host or file:
   ```sh
   0 2 * * * nanoclaw zfs send -i zroot/nanoclaw@prev zroot/nanoclaw@latest | ssh backup-host zfs recv tank/nanoclaw-backup
   ```

3. Document the DR procedure in `docs/DISASTER_RECOVERY.md`.

---

## 8. Network Security and Firewall Configuration

### 8.1 pf Configuration (`etc/pf-nanoclaw.conf`)

**Strengths -- this is well above average:**

- **Pinned IP ranges** for api.anthropic.com (`160.79.104.0/21`, `2607:6bc0::/48`) via persistent pf table, preventing DNS poisoning attacks. Documentation explicitly warns against using DNS resolution in pf rules.
- **Trusted DNS restriction** to Google (8.8.8.8) and Cloudflare (1.1.1.1) only, preventing DNS tunneling via arbitrary resolvers.
- **Inter-jail isolation** via `block drop quick from $jail_net to $jail_net` with a preceding allow for credential proxy (port 3001). One jail cannot reach another.
- **Epair-level blocking** (`block on epair all` with specific port allows) prevents bypass via state table pollution.
- **Scrub rules** for packet normalization.
- **Logging** of blocked packets to pflog0 for auditing.
- **Comprehensive comments** explaining every rule, the architecture, and verification commands.

**Concerns:**

1. **`pass on $ext_if all`** (line 212) passes ALL non-jail traffic on the external interface. This is intentional (to avoid breaking host networking), but means the host has no inbound firewall. For a server exposed to the internet, this is a risk.

   **Recommendation for production:** Replace with:
   ```
   # Allow established connections
   pass in on $ext_if proto tcp from any to any established
   # Allow SSH
   pass in on $ext_if proto tcp to port 22
   # Block unexpected inbound
   block in on $ext_if
   # Allow all outbound from host
   pass out on $ext_if
   ```

2. **IPv6 coverage is incomplete.** The `anthropic_api` table includes the IPv6 range, but jail traffic rules only reference `$jail_net` which is IPv4 (`10.99.0.0/24`). If a jail manages to get IPv6 connectivity, it could bypass the firewall. Since jails are configured with `ip4=inherit` or vnet without IPv6, this is currently mitigated but should be explicitly blocked:
   ```
   block quick inet6 from $jail_net to any
   ```

3. **Credential proxy rule is broad.** `pass quick proto tcp from $jail_net to $jail_net port 3001` allows any IP in the jail subnet to reach port 3001 on any other IP in the subnet. This is needed because the proxy binds to `10.99.0.1` and each jail has its own gateway IP (`10.99.N.1`). But if a jail somehow gets a `.1` address, it could listen on port 3001 and intercept other jails' API traffic. The jail's vnet isolation makes this unlikely but the rule could be tightened.

### 8.2 Anchor Configuration (`etc/pf-nanoclaw-anchor.conf`)

Provides the same rules as an anchor for systems with existing pf configuration. Uses `egress` keyword for the external interface (auto-detected). Properly documented installation procedure.

### 8.3 devfs Ruleset (`etc/devfs.rules`)

Correctly inherits `$devfsrules_jail` (which hides most devices) and then explicitly unhides only the minimum needed. The ruleset number (10) is referenced in jail creation code and the template setup script consistently.

### 8.4 Sudoers Configuration

Generated by `setup-freebsd.sh` with command-specific NOPASSWD entries. However:

- `jexec *` is too broad -- allows execution inside ANY jail, not just nanoclaw ones. Should be restricted:
  ```
  NANOCLAW_USER ALL=(ALL) NOPASSWD: /usr/sbin/jexec nanoclaw_*
  ```
- `ifconfig` without arguments allows any interface manipulation. Should be restricted to epair operations if possible.
- `umount` without arguments allows unmounting any filesystem. Should be restricted to nanoclaw jail paths.

---

## 9. FreeBSD-Specific Reliability Improvements

### 9.1 ZFS

**Current usage is excellent:**
- Template-based cloning for instant jail creation.
- `quota=1G` per jail dataset prevents runaway disk usage.
- `setuid=off` on jail datasets.
- `compression=lz4` and `atime=off` on jails dataset.
- Snapshot validation after template build.

**Recommendations:**

1. **Periodic ZFS scrub.** Add to cron:
   ```sh
   0 3 * * 0 root zpool scrub zroot
   ```
   And monitor scrub results in the health check.

2. **ZFS pool health in metrics.** Add a metric for `zpool status` (ONLINE/DEGRADED/FAULTED). The current health check only checks available space, not pool health.

3. **Snapshot-based backup before template rebuild.** The setup-jail-template.sh already renames the old snapshot to `@base-backup`, but this should be documented as part of a standard upgrade procedure.

### 9.2 rctl Resource Limits

**Currently applied** (memory 2G, maxproc 100, pcpu 80%). Applied after jail creation via `rctl -a`. Removed during cleanup. Configurable via environment variables.

**Concerns:**

1. **RACCT must be enabled** (`kern.racct.enable=1` in `/boot/loader.conf`). The setup script checks for this but only warns if it's missing -- it does not abort. The jail will run without resource limits if RACCT is not enabled.

   **Recommendation:** Add a startup check in `ensureJailRuntimeRunning()` that logs a fatal error if RACCT is not enabled and network mode is restricted (production):
   ```typescript
   if (JAIL_CONFIG.networkMode === 'restricted') {
     try {
       const racct = execFileSync('sysctl', ['-n', 'kern.racct.enable'], { encoding: 'utf-8' }).trim();
       if (racct !== '1') {
         logger.fatal('RACCT not enabled. Resource limits will not work. Add kern.racct.enable=1 to /boot/loader.conf and reboot.');
       }
     } catch { /* sysctl may not be available */ }
   }
   ```

2. **No wallclock limit.** `pcpu` limits CPU percentage but does not limit total execution time at the rctl level. The application-level timeout (`CONTAINER_TIMEOUT`, default 30 minutes) handles this, but a belt-and-suspenders rctl wallclock limit would protect against process hangs that do not consume CPU.

3. **No disk I/O limits.** A jail could saturate disk I/O. Consider adding `writebps` or `readbps` rctl limits for production.

### 9.3 Jail Security

**Current hardening is good:**
- `securelevel = 3` (maximum security level).
- `enforce_statfs = 2` (jail can only see its own mounts).
- `devfs_ruleset = 10` (restrictive device access).
- Per-jail `jail.conf` generated at runtime.
- Non-root execution (`-U node`).

**Recommendations:**

1. **Add `children.max = 0`** to jail.conf to prevent jails from creating sub-jails.
2. **Add `allow.raw_sockets = 0`** explicitly (it's the default, but being explicit is better for auditing). Note: the template setup jail uses `allow.raw_sockets` which is correct for that context but should not leak into production jail configs.
3. **Consider `allow.mount = 0`** explicitly.

---

## 10. Logging and Audit Trail Assessment

### 10.1 Application Logging

**Pino structured logging** with:
- Console output (colorized via pino-pretty).
- Rotating file output (10MB, daily, gzip, 5 files).
- Trace ID correlation for request tracking.
- Per-group rotating logs for agent output.

**Adequate for single-user operation.** Insufficient for compliance or forensic analysis due to:
- No log shipping to an immutable store.
- No structured audit events for security-relevant actions (group registration, credential proxy access, jail creation/destruction).

### 10.2 Audit Logging

**Opt-in via `NANOCLAW_AUDIT_LOG=true`** (`src/jail/cleanup.ts`):
- Logs cleanup operations (start, stop, unmount, destroy, fstab removal) to `cleanup-audit.log`.
- Simple append-only text file with timestamps.
- Only covers cleanup operations, not creation or exec.

**Gaps:**
- No audit log for jail creation.
- No audit log for credential proxy access (which API keys were used, which jails accessed them).
- No audit log for pf rule changes or blocked traffic summaries.
- Audit log file is writable by the NanoClaw user -- could be tampered with.

### 10.3 Recommendations

1. **Enable audit logging by default** for the jail runtime.
2. **Extend audit logging** to cover jail creation, credential proxy requests, and group registration.
3. **Send audit events to syslog** for tamper-resistant storage:
   ```typescript
   import { SyslogStream } from 'pino-syslog'; // or similar
   ```
4. **Add pflog rotation** via newsyslog.conf.

---

## 11. CI/CD Pipeline Recommendations

### 11.1 Immediate Improvements (Low Effort)

1. **Add ESLint to CI:**
   ```yaml
   - name: Lint
     run: npm run lint
   ```

2. **Add `npm audit` to CI:**
   ```yaml
   - name: Security audit
     run: npm audit --audit-level=moderate
   ```

3. **Add coverage reporting:**
   ```yaml
   - name: Tests with coverage
     run: npx vitest run --coverage
   - uses: codecov/codecov-action@v4
   ```

### 11.2 Medium-Term Improvements

4. **FreeBSD integration test workflow** using a FreeBSD VM on Cirrus CI or a self-hosted runner:
   ```yaml
   name: FreeBSD Integration Tests
   on:
     pull_request:
       paths: ['src/jail/**', 'scripts/**', 'etc/**']
   jobs:
     test:
       runs-on: freebsd-15  # Cirrus CI or self-hosted
       steps:
         - uses: actions/checkout@v4
         - run: pkg install -y node24 npm-node24
         - run: npm ci && npm run build
         - run: npm test
         - run: |
             # Integration test: create and destroy a test jail
             ./scripts/setup-jail-template.sh test-template
             # ... run integration tests ...
   ```

5. **Container image build and scan:**
   ```yaml
   - name: Build container
     run: docker build -t nanoclaw-agent:test container/
   - name: Scan for vulnerabilities
     uses: aquasecurity/trivy-action@master
     with:
       image-ref: nanoclaw-agent:test
   ```

6. **Dependency update automation** via Dependabot or Renovate:
   ```yaml
   # .github/dependabot.yml
   version: 2
   updates:
     - package-ecosystem: npm
       directory: /
       schedule:
         interval: weekly
       open-pull-requests-limit: 5
   ```

### 11.3 Long-Term Improvements

7. **Automated deployment pipeline:**
   ```
   PR merged -> CI passes -> Build artifact -> Deploy to staging -> Health check -> Promote to production
   ```

8. **Release tagging and changelog generation** via semantic-release or similar.

9. **Infrastructure as Code** for the FreeBSD host configuration (Ansible playbooks or similar).

---

## 12. Prioritized Recommendations

### P0 -- Critical (Fix ASAP)

| # | Issue | Impact | Effort | Files |
|---|-------|--------|--------|-------|
| 1 | **Enable SQLite WAL mode** | Data loss risk on crash | 2 lines | `src/db.ts` |
| 2 | **Add `daemon -r 5` to rc.d script** | Service stays down after crash | 1 line | `etc/rc.d/nanoclaw` |
| 3 | **Fix `cleanupByJailName` groupId derivation** | Orphan cleanup may target wrong dataset | 10 lines | `src/jail/lifecycle.ts` |

### P1 -- High (Fix This Sprint)

| # | Issue | Impact | Effort | Files |
|---|-------|--------|--------|-------|
| 4 | Add ESLint and npm audit to CI | Catches bugs and vulnerabilities | 10 lines | `.github/workflows/ci.yml` |
| 5 | Add log rotation for `/var/log/nanoclaw.log` | Disk space exhaustion | 1 line | `/etc/newsyslog.conf` |
| 6 | Add ZFS snapshot cron job for data directory | Point-in-time recovery | 3 lines | cron.d |
| 7 | Tighten sudoers (`jexec`, `umount`) | Privilege escalation risk | 5 lines | `scripts/setup-freebsd.sh` |
| 8 | Add request body size limit to credential proxy | Memory exhaustion | 15 lines | `src/credential-proxy.ts` |
| 9 | Add `children.max = 0` to jail.conf | Jail escape prevention | 1 line | `src/jail/lifecycle.ts` |
| 10 | Verify RACCT at startup in restricted mode | Resource limits silently disabled | 10 lines | `src/jail/cleanup.ts` |

### P2 -- Medium (Plan for Next Cycle)

| # | Issue | Impact | Effort | Files |
|---|-------|--------|--------|-------|
| 11 | Add database health to `/health` endpoint | Incomplete health signal | 20 lines | `src/jail/metrics.ts` |
| 12 | Add channel connection status to `/health` | Silent communication failure | 30 lines | `src/jail/metrics.ts`, `src/index.ts` |
| 13 | Add message latency and queue depth metrics | No performance visibility | 40 lines | `src/jail/metrics.ts`, `src/index.ts` |
| 14 | Enable audit logging by default | No forensic trail | 5 lines | `src/jail/cleanup.ts` |
| 15 | Add ZFS pool health to metrics and health check | Silent pool degradation | 20 lines | `src/jail/metrics.ts` |
| 16 | Add FreeBSD CI runner (Cirrus CI) | No integration testing | 50 lines | `.cirrus.yml` |
| 17 | Add off-host backup (zfs send or restic) | Single point of failure | 30 lines | cron + script |
| 18 | Document DR procedure | No recovery runbook | 100 lines | `docs/DISASTER_RECOVERY.md` |
| 19 | Add host inbound firewall rules | Host exposed to network | 10 lines | `etc/pf-nanoclaw.conf` |

### P3 -- Low (Backlog)

| # | Issue | Impact | Effort | Files |
|---|-------|--------|--------|-------|
| 20 | Pin `base.txz` download with hash verification | Supply chain risk | 20 lines | `scripts/setup-freebsd.sh` |
| 21 | Add Dependabot/Renovate for dependency updates | Stale dependencies | 10 lines | `.github/dependabot.yml` |
| 22 | Schema migration versioning system | Migration state tracking | 100 lines | `src/db.ts` |
| 23 | Container image scanning in CI | Unknown image vulnerabilities | 20 lines | `.github/workflows/ci.yml` |
| 24 | Add disk I/O rctl limits | I/O saturation from jails | 5 lines | `src/jail/lifecycle.ts` |
| 25 | Replace `process.exit(0)` with `process.exitCode` | Clean async shutdown | 2 lines | `src/index.ts` |

---

## Appendix: Key File Paths Referenced

| File | Purpose |
|------|---------|
| `/home/jims/code/nanoclaw/src/.github/workflows/ci.yml` | CI pipeline |
| `/home/jims/code/nanoclaw/src/etc/rc.d/nanoclaw` | FreeBSD service script |
| `/home/jims/code/nanoclaw/src/etc/pf-nanoclaw.conf` | Standalone pf firewall rules |
| `/home/jims/code/nanoclaw/src/etc/pf-nanoclaw-anchor.conf` | Anchor-mode pf rules |
| `/home/jims/code/nanoclaw/src/etc/devfs.rules` | Jail device access restrictions |
| `/home/jims/code/nanoclaw/src/scripts/setup-freebsd.sh` | FreeBSD bootstrap script |
| `/home/jims/code/nanoclaw/src/scripts/setup-jail-template.sh` | Jail template build script |
| `/home/jims/code/nanoclaw/src/src/db.ts` | SQLite database operations |
| `/home/jims/code/nanoclaw/src/src/credential-proxy.ts` | API credential proxy |
| `/home/jims/code/nanoclaw/src/src/jail/lifecycle.ts` | Jail create/stop/destroy |
| `/home/jims/code/nanoclaw/src/src/jail/exec.ts` | Jail command execution |
| `/home/jims/code/nanoclaw/src/src/jail/network.ts` | Epair networking |
| `/home/jims/code/nanoclaw/src/src/jail/cleanup.ts` | Orphan cleanup and audit |
| `/home/jims/code/nanoclaw/src/src/jail/metrics.ts` | Health and metrics endpoints |
| `/home/jims/code/nanoclaw/src/src/jail/config.ts` | Jail configuration |
| `/home/jims/code/nanoclaw/src/src/jail/runner.ts` | Jail agent runner |
| `/home/jims/code/nanoclaw/src/src/config.ts` | Application configuration |
| `/home/jims/code/nanoclaw/src/src/logger.ts` | Logging setup |
| `/home/jims/code/nanoclaw/src/src/log-rotation.ts` | Log rotation utilities |
| `/home/jims/code/nanoclaw/src/src/index.ts` | Main orchestrator |
| `/home/jims/code/nanoclaw/src/src/container-runtime.ts` | Runtime abstraction |
| `/home/jims/code/nanoclaw/src/container/build.sh` | Container image build |
| `/home/jims/code/nanoclaw/src/package.json` | Project dependencies and scripts |
