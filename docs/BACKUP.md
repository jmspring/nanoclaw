# Backup Strategy

NanoClaw uses three layers of backup protection:

1. **Daily SQLite database backup** — the built-in `backupDatabase()` function copies the database file daily.
2. **Periodic ZFS snapshots** — automatic 4-hourly snapshots for point-in-time recovery (installed via `etc/cron.d/nanoclaw-snapshots`).
3. **Off-host backup via `zfs send`** — incremental snapshots sent to a remote host or external storage for disaster recovery.

Each layer addresses a different failure mode: the SQLite backup protects against application-level corruption, ZFS snapshots protect against accidental deletions, and off-host backups protect against pool or hardware failure.

## Off-Host Backup (scripts/backup-offhost.sh)

The off-host backup script creates a ZFS snapshot of the NanoClaw dataset and sends it to a remote host via SSH or to a local file path. Subsequent runs use incremental sends, transmitting only the changes since the previous backup.

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BACKUP_TARGET` | Yes | — | Destination: file path or `ssh://host/dataset` |
| `BACKUP_DATASET` | No | `zroot/nanoclaw` | ZFS dataset to back up |
| `BACKUP_SNAP_PREFIX` | No | `backup` | Snapshot name prefix |
| `BACKUP_LOG` | No | `/var/log/nanoclaw-backup.log` | Log file path |

### Running Manually

Back up to a local directory:

```sh
BACKUP_TARGET=/mnt/external/nanoclaw ./scripts/backup-offhost.sh
```

Back up to a remote host:

```sh
BACKUP_TARGET=ssh://backup-host/tank/nanoclaw ./scripts/backup-offhost.sh
```

### Running via Cron

Add a cron entry for daily backups at 2:00 AM:

```
0 2 * * * nanoclaw BACKUP_TARGET=ssh://backup-host/tank/nanoclaw /path/to/scripts/backup-offhost.sh
```

## ZFS Snapshot Policy

Automatic recursive snapshots are taken every 4 hours via `etc/cron.d/nanoclaw-snapshots`. This covers the database, group workspaces, and all data directories.

- **Schedule**: Every 4 hours (`0 */4 * * *`)
- **Retention**: 42 snapshots (7 days at 4-hour intervals)
- **Pruning**: Daily at 03:00, oldest snapshots beyond 42 are destroyed

## Retention Summary

| Layer | Frequency | Retention | Location |
|-------|-----------|-----------|----------|
| SQLite backup | Daily | 7 copies | Same pool |
| ZFS snapshots | 4-hourly | 42 snapshots (7 days) | Same pool |
| Off-host backup | Configurable (daily recommended) | 2 snapshots | Remote host or file |

## Verification

For file-based backups, the script automatically generates SHA-256 checksums alongside each backup file. Verify integrity by comparing:

```sh
sha256 /mnt/external/nanoclaw/backup-20260328-020000.zfs
cat /mnt/external/nanoclaw/backup-20260328-020000.zfs.sha256
```

Test the restore procedure periodically to ensure backups are usable.

## Restore Procedure

### From ZFS Snapshot

Roll back to a specific snapshot on the same pool:

```sh
zfs rollback zroot/nanoclaw@<snapshot>
```

### From Off-Host Backup (File)

Receive a backup file into the dataset:

```sh
zfs recv zroot/nanoclaw < /path/to/backup.zfs
```

### From Off-Host Backup (SSH)

Pull a backup from the remote host:

```sh
ssh backup-host zfs send tank/nanoclaw-backup@latest | zfs recv zroot/nanoclaw
```

### Post-Restore Steps

After any restore, verify database integrity and restart the service:

```sh
sqlite3 store/nanoclaw.db "PRAGMA integrity_check"
sudo service nanoclaw restart
```
