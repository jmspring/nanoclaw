/**
 * Metrics and health monitoring for NanoClaw FreeBSD jail runtime.
 * Provides /health and /metrics endpoints for external monitoring.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import { logger } from './logger.js';

/** Configuration for metrics server */
export interface MetricsConfig {
  enabled: boolean;
  port: number;
}

/** Health check status */
interface HealthStatus {
  healthy: boolean;
  checks: {
    templateSnapshot: boolean;
    templateIntegrity: boolean;
    zfsPoolSpace: boolean;
    pfEnabled: boolean;
  };
  details: {
    templateSnapshot?: string;
    templateIntegrity?: string;
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

/** Global metrics counters */
let metricsData: MetricsData = {
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
  } catch {
    return false;
  }
}

/**
 * Verify template integrity by comparing current SHA-256 against stored manifest.
 * @param templateDataset - The template dataset (e.g., zroot/nanoclaw/jails/template)
 * @param snapshotName - The snapshot name (e.g., base)
 * @param jailsPath - Path to the jails directory
 * @returns Object with ok flag and detail message
 */
function verifyTemplateIntegrity(
  templateDataset: string,
  snapshotName: string,
  jailsPath: string,
): { ok: boolean; detail: string } {
  const templateName = templateDataset.split('/').pop() || 'template';
  const manifestPath = `${jailsPath}/${templateName}.sha256`;

  try {
    if (!fs.existsSync(manifestPath)) {
      return { ok: true, detail: 'no manifest (skipped)' };
    }

    const expectedHash = fs.readFileSync(manifestPath, 'utf-8').trim();
    if (!expectedHash) {
      return { ok: true, detail: 'empty manifest (skipped)' };
    }

    const snapshot = `${templateDataset}@${snapshotName}`;
    // Compute current hash via zfs send | sha256
    const currentHash = execFileSync(
      'sh',
      ['-c', `sudo zfs send "${snapshot}" | sha256`],
      { encoding: 'utf-8', stdio: 'pipe', timeout: 30000 },
    ).trim();

    if (currentHash === expectedHash) {
      return { ok: true, detail: 'verified' };
    }
    return {
      ok: false,
      detail: `mismatch: expected ${expectedHash.slice(0, 16)}..., got ${currentHash.slice(0, 16)}...`,
    };
  } catch (err) {
    logger.warn({ err, manifestPath }, 'Template integrity check failed');
    return { ok: true, detail: 'check failed (skipped)' };
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
 * @param jailsPath - Path to the jails directory (for integrity manifest)
 * @returns Health status object
 */
function getHealthStatus(
  templateDataset: string,
  snapshotName: string,
  poolName: string,
  jailsPath: string,
): HealthStatus {
  const templateSnapshot = checkTemplateSnapshot(templateDataset, snapshotName);
  const integrity = verifyTemplateIntegrity(templateDataset, snapshotName, jailsPath);
  const zfsPoolAvailBytes = getZfsPoolAvailable(poolName);
  const zfsPoolSpace = zfsPoolAvailBytes > 0;
  const pfEnabled = checkPfEnabled();

  return {
    healthy: templateSnapshot && zfsPoolSpace && integrity.ok,
    checks: {
      templateSnapshot,
      templateIntegrity: integrity.ok,
      zfsPoolSpace,
      pfEnabled,
    },
    details: {
      templateSnapshot: templateSnapshot
        ? `${templateDataset}@${snapshotName}`
        : 'not found',
      templateIntegrity: integrity.detail,
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
  } catch (err) {
    logger.warn({ err }, 'Failed to update metrics');
  }
}

/**
 * Format metrics in Prometheus text format.
 * @returns Prometheus-formatted metrics string
 */
function formatPrometheusMetrics(): string {
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

  return lines.join('\n');
}

/**
 * Start the metrics HTTP server.
 * @param config - Metrics configuration
 * @param templateDataset - The template dataset
 * @param snapshotName - The snapshot name
 * @param poolName - The ZFS pool name
 * @param jailsPath - Path to jails directory (for integrity manifest)
 * @returns HTTP server instance
 */
export function startMetricsServer(
  config: MetricsConfig,
  templateDataset: string,
  snapshotName: string,
  poolName: string,
  jailsPath?: string,
): http.Server | null {
  if (!config.enabled) {
    logger.info('Metrics server disabled');
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
    if (req.url === '/health') {
      const health = getHealthStatus(templateDataset, snapshotName, poolName, jailsPath || '');
      const statusCode = health.healthy ? 200 : 503;

      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health, null, 2) + '\n');
    } else if (req.url === '/metrics') {
      const metrics = formatPrometheusMetrics();

      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(metrics);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found\n');
    }
  });

  server.listen(config.port, '127.0.0.1', () => {
    logger.info(
      { port: config.port },
      'Metrics server listening on http://127.0.0.1:' + config.port,
    );
  });

  return server;
}
