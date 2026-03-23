# NanoClaw Debug Checklist

## Known Issues (2026-02-08)

### 1. [FIXED] Resume branches from stale tree position
When agent teams spawns subagent CLI processes, they write to the same session JSONL. On subsequent `query()` resumes, the CLI reads the JSONL but may pick a stale branch tip (from before the subagent activity), causing the agent's response to land on a branch the host never receives a `result` for. **Fix**: pass `resumeSessionAt` with the last assistant message UUID to explicitly anchor each resume.

### 2. IDLE_TIMEOUT == CONTAINER_TIMEOUT (both 30 min)
Both timers fire at the same time, so containers always exit via hard SIGKILL (code 137) instead of graceful `_close` sentinel shutdown. The idle timeout should be shorter (e.g., 5 min) so containers wind down between messages, while container timeout stays at 30 min as a safety net for stuck agents.

### 3. Cursor advanced before agent succeeds
`processGroupMessages` advances `lastAgentTimestamp` before the agent runs. If the container times out, retries find no messages (cursor already past them). Messages are permanently lost on timeout.

## Quick Status Check

```bash
# 1. Is the service running?
launchctl list | grep nanoclaw
# Expected: PID  0  com.nanoclaw (PID = running, "-" = not running, non-zero exit = crashed)

# 2. Any running containers?
container ls --format '{{.Names}} {{.Status}}' 2>/dev/null | grep nanoclaw

# 3. Any stopped/orphaned containers?
container ls -a --format '{{.Names}} {{.Status}}' 2>/dev/null | grep nanoclaw

# 4. Recent errors in service log?
grep -E 'ERROR|WARN' logs/nanoclaw.log | tail -20

# 5. Is WhatsApp connected? (look for last connection event)
grep -E 'Connected to WhatsApp|Connection closed|connection.*close' logs/nanoclaw.log | tail -5

# 6. Are groups loaded?
grep 'groupCount' logs/nanoclaw.log | tail -3
```

## Session Transcript Branching

```bash
# Check for concurrent CLI processes in session debug logs
ls -la data/sessions/<group>/.claude/debug/

# Count unique SDK processes that handled messages
# Each .txt file = one CLI subprocess. Multiple = concurrent queries.

# Check parentUuid branching in transcript
python3 -c "
import json, sys
lines = open('data/sessions/<group>/.claude/projects/-workspace-group/<session>.jsonl').read().strip().split('\n')
for i, line in enumerate(lines):
  try:
    d = json.loads(line)
    if d.get('type') == 'user' and d.get('message'):
      parent = d.get('parentUuid', 'ROOT')[:8]
      content = str(d['message'].get('content', ''))[:60]
      print(f'L{i+1} parent={parent} {content}')
  except: pass
"
```

## Container Timeout Investigation

```bash
# Check for recent timeouts
grep -E 'Container timeout|timed out' logs/nanoclaw.log | tail -10

# Check container log files for the timed-out container
ls -lt groups/*/logs/container-*.log | head -10

# Read the most recent container log (replace path)
cat groups/<group>/logs/container-<timestamp>.log

# Check if retries were scheduled and what happened
grep -E 'Scheduling retry|retry|Max retries' logs/nanoclaw.log | tail -10
```

## Agent Not Responding

```bash
# Check if messages are being received from WhatsApp
grep 'New messages' logs/nanoclaw.log | tail -10

# Check if messages are being processed (container spawned)
grep -E 'Processing messages|Spawning container' logs/nanoclaw.log | tail -10

# Check if messages are being piped to active container
grep -E 'Piped messages|sendMessage' logs/nanoclaw.log | tail -10

# Check the queue state — any active containers?
grep -E 'Starting container|Container active|concurrency limit' logs/nanoclaw.log | tail -10

# Check lastAgentTimestamp vs latest message timestamp
sqlite3 store/messages.db "SELECT chat_jid, MAX(timestamp) as latest FROM messages GROUP BY chat_jid ORDER BY latest DESC LIMIT 5;"
```

## Container Mount Issues

```bash
# Check mount validation logs (shows on container spawn)
grep -E 'Mount validated|Mount.*REJECTED|mount' logs/nanoclaw.log | tail -10

# Verify the mount allowlist is readable
cat ~/.config/nanoclaw/mount-allowlist.json

# Check group's container_config in DB
sqlite3 store/messages.db "SELECT name, container_config FROM registered_groups;"

# Test-run a container to check mounts (dry run)
# Replace <group-folder> with the group's folder name
container run -i --rm --entrypoint ls nanoclaw-agent:latest /workspace/extra/
```

## WhatsApp Auth Issues

```bash
# Check if QR code was requested (means auth expired)
grep 'QR\|authentication required\|qr' logs/nanoclaw.log | tail -5

# Check auth files exist
ls -la store/auth/

# Re-authenticate if needed
npm run auth
```

## FreeBSD Jails (NANOCLAW_RUNTIME=jail)

### Quick Status Check (Jails)

```bash
# 1. Is the NanoClaw process running?
pgrep -f 'dist/index.js'

# 2. List running jails
sudo jls -N | grep nanoclaw_

# 3. Recent errors in service log?
grep -E 'FATAL|ERROR' logs/nanoclaw.log | tail -20

# 4. Check ZFS pool space
zfs list -o name,used,avail,refer zroot/nanoclaw

# 5. Verify template snapshot exists
zfs list -t snapshot zroot/nanoclaw/jails/template@base

# 6. Are groups loaded?
grep 'groupCount' logs/nanoclaw.log | tail -3
```

### Jail Networking (Restricted Mode)

```bash
# Check active network connections from jails
sudo pfctl -s state | grep 10.99

# List pf firewall rules
sudo pfctl -s rules

# View NAT rules
sudo pfctl -s nat

# Watch blocked packets in real time
sudo tcpdump -n -e -ttt -i pflog0

# List active epair interfaces
ifconfig -l | tr ' ' '\n' | grep epair

# Check IP forwarding is enabled
sysctl net.inet.ip.forwarding

# Verify Anthropic API IPs in pf table
sudo pfctl -t anthropic_api -T show
```

### Jail Logs and Storage

```bash
# Check jail-specific agent logs
ls -lt groups/*/logs/jail-*.log | head -10

# Read the most recent jail log (replace group name)
cat groups/<group>/logs/jail-*.log | tail -50

# Check ZFS dataset usage per jail
zfs list -r -o name,used,refer zroot/nanoclaw/jails | sort -k2 -h

# Check for orphaned ZFS datasets (jails without running processes)
zfs list -r zroot/nanoclaw/jails | grep -v template

# Check cleanup audit log
tail -20 jails/cleanup-audit.log
```

### Jail Mount Issues

```bash
# List all nullfs mounts for a jail
mount | grep nanoclaw_

# Check devfs is mounted in a running jail
sudo jexec <jailname> ls -la /dev

# Verify mount points exist inside jail clone
ls /path/to/jail/workspace/project /path/to/jail/workspace/group /path/to/jail/workspace/ipc
```

### Orphaned Jails and Cleanup

```bash
# Find orphaned jails (running jails with no NanoClaw process managing them)
sudo jls -N | grep nanoclaw_

# Stop an orphaned jail
sudo jail -r nanoclaw_<groupname>

# Force unmount all filesystems for a jail
sudo umount -f /path/to/jail/dev
sudo umount -f /path/to/jail/workspace/project
sudo umount -f /path/to/jail/workspace/group
sudo umount -f /path/to/jail/workspace/ipc
sudo umount -f /path/to/jail/home/node/.claude
sudo umount -f /path/to/jail/app/src

# Destroy the orphaned ZFS dataset
sudo zfs destroy -r zroot/nanoclaw/jails/nanoclaw_<groupname>

# Check for leaked epair interfaces (should match running jails)
ifconfig -l | tr ' ' '\n' | grep epair
```

See [FreeBSD Jails Troubleshooting](FREEBSD_JAILS.md#8-troubleshooting) for full recovery procedures.

## Service Management

```bash
# Restart the service
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# View live logs
tail -f logs/nanoclaw.log

# Stop the service (careful — running containers are detached, not killed)
launchctl bootout gui/$(id -u)/com.nanoclaw

# Start the service
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nanoclaw.plist

# Rebuild after code changes
npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```
