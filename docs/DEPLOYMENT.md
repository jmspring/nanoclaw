# Deployment Standard Operating Procedure

This document covers the NanoClaw-BSD deployment workflow on FreeBSD. For initial setup, see [FREEBSD_JAILS.md](FREEBSD_JAILS.md). For disaster recovery, see [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md).

## 1. Standard Deployment

```bash
cd /home/nanoclaw/code/nanoclaw/src  # or $NANOCLAW_ROOT/src
git pull
npm ci
npm run build
sudo service nanoclaw restart
```

**Limitations:**

- Not zero-downtime — restart terminates in-progress agents after the graceful shutdown window.
- The `daemon -r 5` flag in the rc.d script auto-restarts on crash, but a manual restart drops all active connections.
- Active jails are cleaned up during shutdown; orphans are reconciled on next startup.

## 2. Blue/Green Template Update

The jail template can be rebuilt without stopping running jails by using a named template:

```bash
# Build new template alongside existing one
sudo ./scripts/setup-jail-template.sh template-v2

# Update environment to use new template
# Add to .env or /etc/rc.conf:
export NANOCLAW_TEMPLATE_DATASET=zroot/nanoclaw/jails/template-v2

# Restart service to pick up new template
sudo service nanoclaw restart

# After verifying new jails work correctly, remove old template (optional)
sudo zfs destroy -r zroot/nanoclaw/jails/template
```

Running jails use ZFS clones of the old template and are unaffected. Only new jails use the updated template.

## 3. Rollback Procedure

### Code rollback

```bash
git log --oneline -5           # identify the bad commit
git revert <commit-hash>       # create a revert commit
npm ci && npm run build
sudo service nanoclaw restart
```

### Template rollback

The `setup-jail-template.sh` script automatically creates a `@base-backup` snapshot before each new `@base` snapshot:

```bash
sudo zfs rollback zroot/nanoclaw/jails/template@base-backup
```

## 4. Pre-Deploy Checklist

- [ ] Back up the database: `cp store/nanoclaw.db store/nanoclaw.db.pre-deploy`
- [ ] Check for running jails: `sudo jls | grep nanoclaw`
- [ ] Run the test suite: `npm test`
- [ ] Build succeeds: `npm run build`
- [ ] Check disk space: `zfs list -o name,used,avail | grep nanoclaw`
- [ ] Read the changelog / commit log for breaking changes

## 5. Post-Deploy Verification

- [ ] Service is running: `sudo service nanoclaw status`
- [ ] Health endpoint responds: `curl http://localhost:${METRICS_PORT:-9090}/health`
- [ ] Test a message: send a test trigger message to a registered group
- [ ] Check logs for errors: `tail -50 logs/nanoclaw.log | grep -i error`
- [ ] Verify jail creation works: check that the next triggered agent creates a jail successfully (visible in logs)
- [ ] Verify pf rules loaded: `sudo pfctl -s rules | grep jail_net`
