# Getting Started with NanoClaw on FreeBSD

## What Is NanoClaw?

NanoClaw is a personal AI assistant that runs Claude agents in isolated FreeBSD jails. Messages arrive via channels (Telegram, Slack, Discord, Gmail), route to an orchestrator, which spawns an ephemeral jail per conversation. Each jail has its own filesystem (ZFS clone), network stack (vnet/epair), and resource limits (rctl).

## Before You Begin

- FreeBSD 15.0+ with ZFS root (or a ZFS pool)
- 4 GB+ RAM, 2 GB+ free ZFS space (base system ~500 MB, Node.js + npm packages ~400 MB, headroom for jail clones)
- An Anthropic API key — get one at <https://console.anthropic.com>
- At least one messaging channel token (e.g., a Telegram bot token)
- Internet access during setup (downloads ~700 MB total)
- Node.js 24+ on the host (installed by the setup script if missing)

## Quick Setup

### 1. Clone the repo

```sh
git clone https://github.com/qwibitai/nanoclaw.git
cd nanoclaw/src
```

### 2. Run the bootstrap script

```sh
sudo ./scripts/setup-freebsd.sh
```

The script is interactive — it prompts for your username, ZFS pool, and network interface. It is idempotent and safe to re-run.

### 3. Configure environment

```sh
cp .env.example .env
```

Edit `.env` and set at minimum:

```sh
ANTHROPIC_API_KEY=sk-ant-...
NANOCLAW_RUNTIME=jail            # or leave blank for auto-detection on FreeBSD
NANOCLAW_JAIL_NETWORK_MODE=inherit  # use "restricted" for production
```

Add a channel token (e.g., `TELEGRAM_BOT_TOKEN=...`). See [Adding Channels](#adding-channels) below.

### 4. Verify the installation

```sh
./scripts/verify-install.sh
```

If the script is not yet available, start in development mode and watch for "Jail runtime initialized":

```sh
npm run dev
```

### 5. Enable the service

```sh
sudo sysrc nanoclaw_enable=YES
sudo service nanoclaw start
```

## What the Setup Script Does

`setup-freebsd.sh` performs 10 steps:

1. **Pre-flight checks** — verifies FreeBSD version, ZFS availability, root privileges
2. **System packages** — installs `node24`, `npm`, `git` via `pkg`
3. **Kernel modules** — configures RACCT (for `rctl` resource limits) and `if_epair` (for jail networking)
4. **User setup** — creates the `nanoclaw` user and group
5. **ZFS datasets** — creates the dataset hierarchy (`zroot/nanoclaw/jails`, template dataset)
6. **Jail template** — extracts the FreeBSD base system into the template, installs Node.js inside it
7. **pf firewall** — installs `pf-nanoclaw.conf`, detects your external interface, enables pf
8. **Clone and configure** — clones the NanoClaw repo, runs `npm install` and `npm run build`
9. **rc.d service** — installs the service script to `/usr/local/etc/rc.d/nanoclaw`
10. **Summary** — prints next steps

## Understanding the Two Setup Scripts

- **`setup-freebsd.sh`** bootstraps the entire system from scratch (runs once on a fresh machine).
- **`setup-jail-template.sh`** finalizes the jail template — installs npm packages and the agent runner inside the template, then takes the ZFS snapshot.

`setup-freebsd.sh` calls `setup-jail-template.sh` at the end. You only need to run `setup-jail-template.sh` standalone when rebuilding the template after code changes:

```sh
sudo ./scripts/setup-jail-template.sh
```

## Configuration

### Minimal (Development)

```sh
NANOCLAW_RUNTIME=jail
NANOCLAW_JAIL_NETWORK_MODE=inherit
ANTHROPIC_API_KEY=sk-ant-...
```

Plus a channel token. This gives jails full host network access — fine for local development.

### Production

Switch to restricted networking and verify the firewall:

```sh
# In .env:
NANOCLAW_JAIL_NETWORK_MODE=restricted
```

```sh
sudo pfctl -sr | grep nanoclaw
```

See [Environment Variable Reference](ENV_REFERENCE.md) for all configuration options and [FreeBSD Jails Deep Dive](FREEBSD_JAILS.md) for pf details.

## How Credentials Flow (Credential Proxy)

Jails never see your real API keys. Instead:

1. You set `ANTHROPIC_API_KEY` in `.env` on the host.
2. NanoClaw starts a credential proxy on port 3001.
3. Each jail receives a unique per-jail token at creation time.
4. When the agent inside a jail makes an API request, it sends the request to the credential proxy (at the jail's gateway IP, port 3001).
5. The proxy validates the per-jail token, injects the real API key, and forwards the request to api.anthropic.com.
6. The real key never enters the jail filesystem or environment.

## Adding Channels

Channels are configured via tokens in `.env` or `data/env/env`. Claude Code on the host is **not** required for FreeBSD runtime operation.

**Telegram** — set `TELEGRAM_BOT_TOKEN` in `.env`, then restart:

```sh
sudo service nanoclaw restart
```

**Slack, Discord, Gmail** — add the corresponding token to `.env` and restart. See the [README](../README.md) for channel-specific setup details.

If you have Claude Code installed on the host, you can also use the interactive `/add-telegram`, `/add-slack`, etc. skill commands.

## Development vs. Production

| | Development | Production |
|---|---|---|
| Start command | `npm run dev` | `sudo service nanoclaw start` |
| Network mode | `inherit` (full host network) | `restricted` (vnet + pf isolation) |
| Firewall | Optional | Required — verify with `sudo pfctl -sr` |
| When to switch | — | Before exposing to untrusted users or the internet |

## Log Locations

| Context | Path |
|---|---|
| Development (`npm run dev`) | `logs/nanoclaw.log` (relative to project root) |
| Production (`rc.d` service) | `/var/log/nanoclaw.log` (via `daemon -o`) |
| Per-group agent logs | `groups/<name>/logs/` |

## Updating NanoClaw

```sh
git pull
npm run build
sudo ./scripts/setup-jail-template.sh   # rebuild jail template
sudo service nanoclaw restart
```

## Troubleshooting

**Top 5 first-run issues:**

1. **"ANTHROPIC_API_KEY is required"** — set the key in `.env`
2. **Template snapshot missing** — run `sudo ./scripts/setup-jail-template.sh`
3. **ZFS pool full** — check with `zfs list`; free space or expand the pool
4. **Sudoers not configured** — re-run `sudo ./scripts/setup-freebsd.sh`
5. **pf not loaded** — `sudo pfctl -e && sudo pfctl -f /etc/pf.conf`

For more, see [Debug Checklist](DEBUG_CHECKLIST.md) (FreeBSD section is under the "FreeBSD Jails" heading — scroll past the macOS/Docker section or use the navigation link at the top).

## Further Reading

- [FreeBSD Jails Deep Dive](FREEBSD_JAILS.md) — architecture, security model, advanced configuration
- [Linux/Docker to FreeBSD Translation](LINUX_TO_FREEBSD.md) — concept mapping for Docker users
- [Environment Variable Reference](ENV_REFERENCE.md) — all configuration options
- [Template Management](TEMPLATE_SETUP.md) — jail template rebuilds and upgrades
- [Security Model](SECURITY.md) — mount validation, credential proxy, pf rules
