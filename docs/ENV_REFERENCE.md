# Environment Variable Reference

All NanoClaw configuration is via environment variables set in a `.env` file at the project root. Copy `.env.example` to `.env` to get started. This document is the complete reference for all supported variables.

Variables marked **(FreeBSD only)** apply only when `NANOCLAW_RUNTIME=jail`.

## Core Variables

Source: `src/config.ts`

| Variable | Default | Description | Valid Values |
|----------|---------|-------------|--------------|
| `NANOCLAW_RUNTIME` | Auto-detected | Container runtime | `jail` (FreeBSD), `apple` (macOS), `docker` (Linux) |
| `CONTAINER_IMAGE` | `nanoclaw-agent:latest` | Docker/Apple container image name | Any valid image tag |
| `CONTAINER_TIMEOUT` | `1800000` (30 min) | Agent execution timeout in ms | Range: 60000–7200000 |
| `CONTAINER_MAX_OUTPUT_SIZE` | `10485760` (10 MB) | Max agent output in bytes | Range: 1048576–104857600 |
| `IDLE_TIMEOUT` | `1800000` (30 min) | Container idle timeout in ms | Range: 60000–7200000 |
| `MAX_CONCURRENT_CONTAINERS` | `5` | Max parallel containers | Range: 1–50 |
| `ASSISTANT_NAME` | `Andy` | Bot display name and trigger word | Any string |
| `ASSISTANT_HAS_OWN_NUMBER` | `false` | Whether the bot has a dedicated phone number | `true`, `false` |
| `TZ` | System default | Timezone for scheduled tasks | Any IANA timezone (e.g., `America/Los_Angeles`) |
| `ONECLI_URL` | `http://localhost:10254` | OneCLI gateway URL | Any URL |

Requires service restart to take effect.

## Credential Proxy

Source: `src/config.ts`, `src/container-runtime.ts`

| Variable | Default | Description | Valid Values |
|----------|---------|-------------|--------------|
| `CREDENTIAL_PROXY_PORT` | `3001` | Port for the credential proxy | Range: 1024–65535 |
| `CREDENTIAL_PROXY_HOST` | Auto-detected | Bind address for the proxy | Any IP address |

The bind address is auto-detected per runtime:
- **jail (restricted)**: `0.0.0.0` (listens on all jail gateway IPs)
- **jail (inherit)**: `127.0.0.1`
- **docker (Linux)**: docker0 bridge IP
- **macOS**: `127.0.0.1`

Requires service restart to take effect.

## Jail Runtime (FreeBSD Only)

### Network Configuration

Source: `src/jail/config.ts`

| Variable | Default | Description | Valid Values |
|----------|---------|-------------|--------------|
| `NANOCLAW_JAIL_NETWORK_MODE` | `restricted` | Jail network isolation mode | `restricted` (vnet + pf), `inherit` (host network) |
| `NANOCLAW_JAIL_SUBNET` | `10.99` | IP prefix for jail subnets (produces `10.99.N.0/30` per jail) | Any two-octet prefix |
| `NANOCLAW_EXT_IF` | Auto-detected | External network interface for pf NAT | e.g., `em0`, `vtnet0`, `re0` |
| `NANOCLAW_MAX_EPAIRS` | `200` | Max epair interfaces | Range: 1–255 |

`NANOCLAW_JAIL_NETWORK_MODE` and `NANOCLAW_JAIL_SUBNET` require service restart. `NANOCLAW_EXT_IF` is used by `setup-freebsd.sh` at install time.

### Resource Limits

Source: `src/jail/config.ts`

| Variable | Default | Description | Valid Values |
|----------|---------|-------------|--------------|
| `NANOCLAW_JAIL_MEMORY_LIMIT` | `2G` | rctl memory limit per jail | Any rctl size (e.g., `1G`, `512M`) |
| `NANOCLAW_JAIL_MAXPROC` | `100` | Max processes per jail | Any positive integer |
| `NANOCLAW_JAIL_PCPU` | `80` | CPU percentage limit per jail | 1–100 |
| `NANOCLAW_MAX_JAILS` | `50` | Max concurrent jails | Range: 1–100 |

Resource limits are applied at jail creation time — changing them takes effect on the next jail without a service restart.

### Path Overrides

Source: `src/jail/config.ts`

| Variable | Default | Description |
|----------|---------|-------------|
| `NANOCLAW_ROOT` | `process.cwd()` | Root path for all derived paths |
| `NANOCLAW_JAILS_PATH` | `$NANOCLAW_ROOT/jails` | Where jail filesystems live |
| `NANOCLAW_JAILS_DATASET` | `zroot/nanoclaw/jails` | ZFS dataset for jails |
| `NANOCLAW_TEMPLATE_DATASET` | `zroot/nanoclaw/jails/template` | ZFS template dataset |
| `NANOCLAW_TEMPLATE_SNAPSHOT` | `base` | Snapshot name on the template dataset |
| `NANOCLAW_WORKSPACES_PATH` | `$NANOCLAW_ROOT/workspaces` | Workspaces directory |
| `NANOCLAW_IPC_PATH` | `$NANOCLAW_ROOT/ipc` | IPC directory |

Requires service restart to take effect.

### Timeouts (milliseconds)

Source: `src/jail/config.ts`

| Variable | Default | Range | Description |
|----------|---------|-------|-------------|
| `JAIL_EXEC_TIMEOUT` | `30000` (30 s) | 5000–300000 | sudo exec operations |
| `JAIL_CREATE_TIMEOUT` | `30000` (30 s) | 5000–300000 | ZFS clone during jail creation |
| `JAIL_STOP_TIMEOUT` | `15000` (15 s) | 5000–120000 | Graceful jail stop |
| `JAIL_FORCE_STOP_TIMEOUT` | `10000` (10 s) | 5000–60000 | Force jail stop |
| `JAIL_QUICK_OP_TIMEOUT` | `5000` (5 s) | 1000–30000 | Quick ops: unmount, epair destroy |

Timeouts are read at jail creation time — changes take effect on the next jail without a service restart.

## Health and Metrics

Source: `src/jail/metrics.ts`, `.env.example`

| Variable | Default | Description | Valid Values |
|----------|---------|-------------|--------------|
| `HEALTH_ENABLED` | `true` | Enable `/health` endpoint | `true`, `false` |
| `METRICS_ENABLED` | `false` | Enable `/metrics` Prometheus endpoint | `true`, `false` |
| `METRICS_PORT` | `9090` | Port for health/metrics server | Range: 1024–65535 |

Requires service restart to take effect.

## Logging

Source: `.env.example`

| Variable | Default | Description | Valid Values |
|----------|---------|-------------|--------------|
| `LOG_LEVEL` | `info` | pino log level | `trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `LOG_ROTATION_SIZE` | `10M` | Rotate agent logs at this size | Any size string (e.g., `5M`, `100K`) |
| `LOG_ROTATION_MAX_FILES` | `5` | Rotated log files to keep | Range: 1–100 |
| `LOG_ROTATION_COMPRESS` | `true` | gzip-compress rotated logs | `true`, `false` |
| `LOG_RETENTION_DAYS` | `30` | Delete logs older than this (days) | Range: 1–365 |

## Channel Tokens

Channel tokens (`TELEGRAM_BOT_TOKEN`, `SLACK_BOT_TOKEN`, etc.) are loaded from `data/env/env` by the credential proxy / OneCLI gateway. They are **not** set in `.env` directly. See [CLAUDE.md](../CLAUDE.md) for credential management details.
