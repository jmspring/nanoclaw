# Disaster Recovery Runbook

Recovery procedures for NanoClaw-BSD failure scenarios. For routine deployments, see [DEPLOYMENT.md](DEPLOYMENT.md). For initial setup, see [FREEBSD_JAILS.md](FREEBSD_JAILS.md).

## 1. ZFS Pool Degradation

Detect pool issues:

```bash
zpool status zroot    # look for DEGRADED or FAULTED
```

Recovery steps:

```bash
sudo zpool scrub zroot                              # check for silent corruption
sudo zpool replace zroot <old-device> <new-device>  # replace failed disk
zpool status zroot                                   # verify ONLINE state
```

For detailed ZFS recovery, refer to the FreeBSD Handbook chapter on ZFS administration.

## 2. Host Crash During Jail Creation

A crash during jail lifecycle leaves orphan jails, ZFS clones, and epair interfaces.

**Automatic recovery:** On restart, NanoClaw's `reconnectToRunningJails()` (in `src/jail/cleanup.ts`) re-tracks running jails and `cleanupOrphans()` removes stale resources.

**Manual cleanup** (if automatic recovery is insufficient):

```bash
# List orphan jails
sudo jls | grep nanoclaw

# Stop orphan jails
sudo jail -r <jailname>

# Find orphaned ZFS clones
sudo zfs list -t all | grep nanoclaw/jails

# Remove orphaned clones
sudo zfs destroy -r <dataset>

# Find stale epair interfaces
ifconfig -l | tr ' ' '\n' | grep epair

# Remove stale interfaces
sudo ifconfig <epairNa> destroy
```

## 3. pf Rule Corruption

**Symptoms:** Jail agents cannot reach the Anthropic API, or network is unrestricted.

```bash
# Verify current rules
sudo pfctl -s rules

# Reload standalone rules
sudo pfctl -f /etc/pf-nanoclaw.conf

# Or reload anchor rules
sudo pfctl -a nanoclaw -f etc/pf-nanoclaw-anchor.conf

# Verify after reload
sudo pfctl -s rules | grep jail_net
```

If `/etc/pf-nanoclaw.conf` is missing or corrupt, restore from the repo:

```bash
cp etc/pf-nanoclaw.conf /etc/pf-nanoclaw.conf
sudo pfctl -f /etc/pf-nanoclaw.conf
```

## 4. Template Corruption

**Option A** — restore from backup snapshot:

```bash
sudo zfs rollback zroot/nanoclaw/jails/template@base-backup
```

The `@base-backup` snapshot is created automatically by `setup-jail-template.sh` before each new `@base` snapshot.

**Option B** — full rebuild:

```bash
sudo ./scripts/setup-jail-template.sh
```

Verify after restoration:

```bash
sudo zfs list -t snapshot | grep template
```

Running jails are unaffected — they use ZFS clones, not the template directly. Only new jails use the restored/rebuilt template.

## 5. Database Corruption

Daily backups are stored in `store/backups/` (created by `backupDatabase()` in `src/db.ts`).

**WAL recovery** (SQLite WAL mode):

```bash
# SQLite automatically recovers from WAL on next open.
# If the WAL file is corrupt, remove it (data since last checkpoint is lost):
rm store/nanoclaw.db-wal
```

**Restore from backup:**

```bash
sudo service nanoclaw stop
cp store/backups/nanoclaw-<latest>.db store/nanoclaw.db
sudo service nanoclaw start
```

Verify that registered groups and messages are present. Session state is also persisted in `data/session-state.json` and will be merged on startup.

## 6. Full Rebuild from Scratch

1. Install FreeBSD 15.0-RELEASE with ZFS root.

2. Clone the repository and run the bootstrap script:

   ```bash
   sudo ./scripts/setup-freebsd.sh
   ```

   This installs packages, creates the `nanoclaw` user, sets up ZFS datasets, configures pf, and installs the rc.d service.

3. Build the jail template:

   ```bash
   sudo ./scripts/setup-jail-template.sh
   ```

4. Restore data from off-host backup (if available):

   ```bash
   # ZFS receive (full dataset):
   ssh backup-host zfs send tank/nanoclaw-backup@latest | sudo zfs recv zroot/nanoclaw

   # Or restore individual files:
   # - store/nanoclaw.db        (database)
   # - groups/                  (per-group CLAUDE.md files)
   # - .env                     (credentials)
   # - data/                    (session state, epair state, jail tokens)
   ```

5. Rebuild the application:

   ```bash
   npm ci && npm run build
   ```

6. Start the service:

   ```bash
   sudo service nanoclaw start
   ```

## 7. Credential Recovery

The `.env` file contains all API keys and channel authentication tokens.

If `.env` is lost and no backup exists:

- **Anthropic API key:** Regenerate at console.anthropic.com
- **Channel auth tokens:** Re-authenticate each channel:
  - WhatsApp: scan QR code via `/add-whatsapp`
  - Telegram: `/start` with BotFather
  - Slack: reinstall the Slack app
  - Discord: regenerate bot token in Discord developer portal
- **Other API keys:** Regenerate from respective provider dashboards

**Recommendation:** Keep an encrypted backup of `.env` off-host:

```bash
gpg -c .env  # encrypt, then upload to secure storage
```

Group registrations are stored in the SQLite database, not `.env`, so they survive credential recovery.
