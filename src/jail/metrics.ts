/**
 * Metrics and health monitoring for NanoClaw FreeBSD jail runtime.
 * Provides /health and /metrics endpoints for external monitoring.
 */
import { execFileSync } from 'child_process';
import http from 'http';
import { logger } from '../logger.js';

/** Configuration for metrics server */
export interface MetricsConfig {
  healthEnabled: boolean;
  metricsEnabled: boolean;
  port: number;
}

/** Health check status */
interface HealthStatus {
  healthy: boolean;
  checks: {
    templateSnapshot: boolean;
    zfsPoolSpace: boolean;
    pfEnabled: boolean;
  };
  details: {
    templateSnapshot?: string;
    zfsPoolAvailBytes?: number;
    pfStatus?: string;
  };
}

/** Metrics data */
interface MetricsData {
  activeJails: number;
  jailCreateTotal: { success: number; failure: number };
  epairUsed: number;
  zfsPoolBytesAvail: number;
}

/** Per-jail rctl resource metrics */
interface RctlMetrics {
  jailName: string;
  memoryuse: number;
  maxproc: number;
  pcpu: number;
  cputime: number;
  wallclock: number;
  openfiles: number;
}

/** Per-jail rctl metrics (updated by polling) */
let perJailRctlMetrics: RctlMetrics[] = [];

/** Interval handle for rctl polling */
let rctlPollInterval: ReturnType<typeof setInterval> | null = null;

/** Global metrics counters */
const metricsData: MetricsData = {
  activeJails: 0,
  jailCreateTotal: { success: 0, failure: 0 },
  epairUsed: 0,
  zfsPoolBytesAvail: 0,
};

/** Update active jail count */
export function setActiveJailCount(count: number): void {
  metricsData.activeJails = count;
}

/** Increment jail creation counter */
export function incrementJailCreateCounter(success: boolean): void {
  if (success) {
    metricsData.jailCreateTotal.success++;
  } else {
    metricsData.jailCreateTotal.failure++;
  }
}

/** Update epair usage count */
export function setEpairUsed(count: number): void {
  metricsData.epairUsed = count;
}

/** Update ZFS pool available bytes */
export function setZfsPoolBytesAvail(bytes: number): void {
  metricsData.zfsPoolBytesAvail = bytes;
}

/**
 * Check if ZFS template snapshot exists.
 * @param templateDataset - The template dataset (e.g., zroot/nanoclaw/jails/template)
 * @param snapshotName - The snapshot name (e.g., base)
 * @returns True if snapshot exists
 */
function checkTemplateSnapshot(
  templateDataset: string,
  snapshotName: string,
): boolean {
  try {
    const snapshot = `${templateDataset}@${snapshotName}`;
    execFileSync('zfs', ['list', '-t', 'snapshot', '-H', snapshot], {
      stdio: 'pipe',
      timeout: 5000,
    });
    return true;
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return false;
  }
}

/**
 * Get ZFS pool available space in bytes.
 * @param poolName - The ZFS pool name (e.g., zroot)
 * @returns Available bytes or -1 on error
 */
function getZfsPoolAvailable(poolName: string): number {
  try {
    // zfs get -Hp available returns bytes
    const output = execFileSync(
      'zfs',
      ['get', '-Hp', '-o', 'value', 'available', poolName],
      {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 5000,
      },
    );
    const bytes = parseInt(output.trim(), 10);
    return isNaN(bytes) ? -1 : bytes;
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return -1;
  }
}

/**
 * Check if pf (packet filter) is enabled.
 * @returns True if pf is enabled
 */
function checkPfEnabled(): boolean {
  try {
    const output = execFileSync('sudo', ['pfctl', '-si'], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
    });
    // Check if output contains "Status: Enabled"
    return output.includes('Status: Enabled');
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    // pf may not be configured or pfctl not available
    return false;
  }
}

/**
 * Get current health status.
 * @param templateDataset - The template dataset
 * @param snapshotName - The snapshot name
 * @param poolName - The ZFS pool name
 * @returns Health status object
 */
function getHealthStatus(
  templateDataset: string,
  snapshotName: string,
  poolName: string,
): HealthStatus {
  const templateSnapshot = checkTemplateSnapshot(templateDataset, snapshotName);
  const zfsPoolAvailBytes = getZfsPoolAvailable(poolName);
  const zfsPoolSpace = zfsPoolAvailBytes > 0;
  const pfEnabled = checkPfEnabled();

  return {
    healthy: templateSnapshot && zfsPoolSpace,
    checks: {
      templateSnapshot,
      zfsPoolSpace,
      pfEnabled,
    },
    details: {
      templateSnapshot: templateSnapshot
        ? `${templateDataset}@${snapshotName}`
        : 'not found',
      zfsPoolAvailBytes: zfsPoolAvailBytes > 0 ? zfsPoolAvailBytes : undefined,
      pfStatus: pfEnabled ? 'enabled' : 'disabled or unavailable',
    },
  };
}

/**
 * Update metrics from jail runtime (called periodically).
 * @param getActiveJailCount - Function to get active jail count
 * @param getEpairMetrics - Function to get epair metrics
 * @param poolName - The ZFS pool name
 */
export async function updateMetrics(
  getActiveJailCount: () => number,
  getEpairMetrics: () => {
    current: number;
    max: number;
    warningThreshold: number;
  },
  poolName: string,
): Promise<void> {
  try {
    metricsData.activeJails = getActiveJailCount();
    metricsData.epairUsed = getEpairMetrics().current;
    metricsData.zfsPoolBytesAvail = getZfsPoolAvailable(poolName);
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (err) {
    logger.warn({ err }, 'Failed to update metrics');
  }
}

/**
 * Poll rctl for resource usage of all active nanoclaw jails.
 * Stores results in perJailRctlMetrics for Prometheus export.
 */
export async function pollRctlMetrics(): Promise<void> {
  try {
    const output = execFileSync('sudo', ['rctl', '-u', 'jail:'], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
    });

    const byJail = new Map<string, Partial<RctlMetrics>>();

    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      // Format: jail:<name>:<resource>=<value>
      const match = line.match(/^jail:([^:]+):(\w+)=(\d+)$/);
      if (!match) continue;

      const [, jailName, resource, valueStr] = match;
      if (!jailName.startsWith('nanoclaw_')) continue;

      if (!byJail.has(jailName)) {
        byJail.set(jailName, { jailName });
      }
      const entry = byJail.get(jailName)!;
      const value = parseInt(valueStr, 10);

      switch (resource) {
        case 'memoryuse':
          entry.memoryuse = value;
          break;
        case 'maxproc':
          entry.maxproc = value;
          break;
        case 'pcpu':
          entry.pcpu = value;
          break;
        case 'cputime':
          entry.cputime = value;
          break;
        case 'wallclock':
          entry.wallclock = value;
          break;
        case 'openfiles':
          entry.openfiles = value;
          break;
      }
    }

    perJailRctlMetrics = [...byJail.values()].map((entry) => ({
      jailName: entry.jailName!,
      memoryuse: entry.memoryuse ?? 0,
      maxproc: entry.maxproc ?? 0,
      pcpu: entry.pcpu ?? 0,
      cputime: entry.cputime ?? 0,
      wallclock: entry.wallclock ?? 0,
      openfiles: entry.openfiles ?? 0,
    }));
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    // rctl may not be available (RACCT not enabled in kernel) — not an error
    logger.debug('rctl polling failed — RACCT may not be enabled');
    perJailRctlMetrics = [];
  }
}

/** Start periodic rctl polling. */
export function startRctlPolling(intervalMs: number = 15000): void {
  if (rctlPollInterval) return;
  logger.info({ intervalMs }, 'Starting rctl polling');
  pollRctlMetrics();
  rctlPollInterval = setInterval(() => {
    pollRctlMetrics();
  }, intervalMs);
}

/** Stop rctl polling. */
export function stopRctlPolling(): void {
  if (rctlPollInterval) {
    clearInterval(rctlPollInterval);
    rctlPollInterval = null;
  }
}

/**
 * Format metrics in Prometheus text format.
 * @returns Prometheus-formatted metrics string
 */
export function formatPrometheusMetrics(): string {
  const lines: string[] = [];

  lines.push('# HELP nanoclaw_active_jails Number of active jails');
  lines.push('# TYPE nanoclaw_active_jails gauge');
  lines.push(`nanoclaw_active_jails ${metricsData.activeJails}`);
  lines.push('');

  lines.push('# HELP nanoclaw_jail_create_total Total jail creation attempts');
  lines.push('# TYPE nanoclaw_jail_create_total counter');
  lines.push(
    `nanoclaw_jail_create_total{status="success"} ${metricsData.jailCreateTotal.success}`,
  );
  lines.push(
    `nanoclaw_jail_create_total{status="failure"} ${metricsData.jailCreateTotal.failure}`,
  );
  lines.push('');

  lines.push('# HELP nanoclaw_epair_used Number of epair interfaces in use');
  lines.push('# TYPE nanoclaw_epair_used gauge');
  lines.push(`nanoclaw_epair_used ${metricsData.epairUsed}`);
  lines.push('');

  lines.push(
    '# HELP nanoclaw_zfs_pool_bytes_avail ZFS pool available space in bytes',
  );
  lines.push('# TYPE nanoclaw_zfs_pool_bytes_avail gauge');
  lines.push(`nanoclaw_zfs_pool_bytes_avail ${metricsData.zfsPoolBytesAvail}`);
  lines.push('');

  // Per-jail rctl metrics
  lines.push(
    '# HELP nanoclaw_jail_memory_usage_bytes Current memory usage per jail in bytes',
  );
  lines.push('# TYPE nanoclaw_jail_memory_usage_bytes gauge');
  for (const m of perJailRctlMetrics) {
    lines.push(
      `nanoclaw_jail_memory_usage_bytes{jail="${m.jailName}"} ${m.memoryuse}`,
    );
  }
  lines.push('');

  lines.push(
    '# HELP nanoclaw_jail_process_count Current number of processes per jail',
  );
  lines.push('# TYPE nanoclaw_jail_process_count gauge');
  for (const m of perJailRctlMetrics) {
    lines.push(
      `nanoclaw_jail_process_count{jail="${m.jailName}"} ${m.maxproc}`,
    );
  }
  lines.push('');

  lines.push(
    '# HELP nanoclaw_jail_cpu_percent Current CPU usage percentage per jail',
  );
  lines.push('# TYPE nanoclaw_jail_cpu_percent gauge');
  for (const m of perJailRctlMetrics) {
    lines.push(`nanoclaw_jail_cpu_percent{jail="${m.jailName}"} ${m.pcpu}`);
  }
  lines.push('');

  lines.push(
    '# HELP nanoclaw_jail_cputime_seconds_total Total CPU time consumed per jail',
  );
  lines.push('# TYPE nanoclaw_jail_cputime_seconds_total counter');
  for (const m of perJailRctlMetrics) {
    lines.push(
      `nanoclaw_jail_cputime_seconds_total{jail="${m.jailName}"} ${m.cputime}`,
    );
  }
  lines.push('');

  lines.push(
    '# HELP nanoclaw_jail_wallclock_seconds_total Wall-clock time per jail',
  );
  lines.push('# TYPE nanoclaw_jail_wallclock_seconds_total counter');
  for (const m of perJailRctlMetrics) {
    lines.push(
      `nanoclaw_jail_wallclock_seconds_total{jail="${m.jailName}"} ${m.wallclock}`,
    );
  }
  lines.push('');

  lines.push(
    '# HELP nanoclaw_jail_open_files Current open file descriptors per jail',
  );
  lines.push('# TYPE nanoclaw_jail_open_files gauge');
  for (const m of perJailRctlMetrics) {
    lines.push(`nanoclaw_jail_open_files{jail="${m.jailName}"} ${m.openfiles}`);
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Start the health/metrics HTTP server.
 * Health endpoint is served when healthEnabled is true (default).
 * Metrics endpoint is served only when metricsEnabled is true (opt-in).
 * @param config - Server configuration
 * @param templateDataset - The template dataset
 * @param snapshotName - The snapshot name
 * @param poolName - The ZFS pool name
 * @returns HTTP server instance
 */
export function startMetricsServer(
  config: MetricsConfig,
  templateDataset: string,
  snapshotName: string,
  poolName: string,
): http.Server | null {
  if (!config.healthEnabled && !config.metricsEnabled) {
    logger.info('Health and metrics server disabled');
    return null;
  }

  const server = http.createServer((req, res) => {
    // Only allow GET requests
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed\n');
      return;
    }

    // Route handling
    if (req.url === '/health' && config.healthEnabled) {
      const health = getHealthStatus(templateDataset, snapshotName, poolName);
      const statusCode = health.healthy ? 200 : 503;

      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health, null, 2) + '\n');
    } else if (req.url === '/metrics' && config.metricsEnabled) {
      const metrics = formatPrometheusMetrics();

      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(metrics);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found\n');
    }
  });

  const endpoints = [
    config.healthEnabled ? '/health' : null,
    config.metricsEnabled ? '/metrics' : null,
  ].filter(Boolean);

  server.listen(config.port, '127.0.0.1', () => {
    logger.info(
      { port: config.port, endpoints },
      'Health/metrics server listening on http://127.0.0.1:' + config.port,
    );
    if (config.metricsEnabled) {
      startRctlPolling();
    }
  });

  return server;
}
