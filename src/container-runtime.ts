/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 * index.ts and container-runner.ts should only call functions from this module.
 */
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { logger } from './logger.js';

export type RuntimeType = 'jail' | 'docker' | 'apple';

/** Detect the container runtime to use. */
export function getRuntime(): RuntimeType {
  const env = process.env.NANOCLAW_RUNTIME?.toLowerCase();
  if (env === 'jail' || env === 'docker' || env === 'apple') return env;
  const platform = os.platform();
  if (platform === 'freebsd') return 'jail';
  if (platform === 'darwin') return 'apple';
  return 'docker';
}

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** Hostname containers use to reach the host machine. */
export const CONTAINER_HOST_GATEWAY = 'host.docker.internal';

/**
 * Address the credential proxy binds to.
 * FreeBSD Jail: 10.99.0.1 — the jail gateway IP.
 * Docker Desktop (macOS): 127.0.0.1.
 * Docker (Linux): bind to the docker0 bridge IP.
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || detectProxyBindHost();

function detectProxyBindHost(): string {
  if (getRuntime() === 'jail') {
    const mode = process.env.NANOCLAW_JAIL_NETWORK_MODE || 'restricted';
    return mode === 'restricted' ? '10.99.0.1' : '127.0.0.1';
  }

  if (os.platform() === 'darwin') return '127.0.0.1';

  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';

  const ifaces = os.networkInterfaces();
  const docker0 = ifaces['docker0'];
  if (docker0) {
    const ipv4 = docker0.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }

  logger.error(
    'No docker0 interface found — cannot determine safe bind address for credential proxy. Set CREDENTIAL_PROXY_HOST env var.',
  );
  throw new Error(
    'Credential proxy bind address could not be determined safely. Set CREDENTIAL_PROXY_HOST explicitly.',
  );
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Returns the command and args to stop a container by name. */
export function stopContainerArgs(name: string): [string, string[]] {
  return [CONTAINER_RUNTIME_BIN, ['stop', name]];
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  const runtime = getRuntime();
  if (runtime === 'jail') {
    logger.info({ runtime }, 'Using FreeBSD jail runtime');
    return;
  }
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      '║  1. Ensure Docker is installed and running                     ║',
    );
    console.error(
      '║  2. Run: docker info                                           ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start');
  }
}

/** Kill orphaned containers/jails from previous runs. */
export function cleanupOrphans(): void {
  const runtime = getRuntime();
  if (runtime === 'jail') {
    // Lazy import avoids loading jail modules on non-FreeBSD
    import('./jail/index.js').then((jail) => jail.cleanupOrphans());
    return;
  }
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        const [cmd, args] = stopContainerArgs(name);
        execFileSync(cmd, args, { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}

/**
 * Reconnect to existing running jails after a restart.
 * No-op for Docker/Apple runtimes.
 */
export async function reconnectToRunningContainers(): Promise<void> {
  if (getRuntime() !== 'jail') return;

  try {
    const jail = await import('./jail/index.js');
    const runningJails = jail.listRunningNanoclawJails();

    if (runningJails.length === 0) {
      logger.debug('No running jails found to reconnect');
      return;
    }

    for (const jailName of runningJails) {
      jail.trackActiveJail(jailName);
    }

    logger.info(
      { count: runningJails.length, jails: runningJails },
      'Reconnected to existing running jails',
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to reconnect to running jails');
  }
}

/**
 * Clean up all containers/jails during shutdown.
 * No-op for Docker/Apple (containers are --rm).
 */
export async function cleanupAllContainers(): Promise<void> {
  if (getRuntime() !== 'jail') return;

  try {
    const jail = await import('./jail/index.js');
    await jail.cleanupAllJails();
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up jails during shutdown');
  }
}

/**
 * Start metrics/health server if applicable for this runtime.
 * Returns a server close function, or null.
 */
export async function startRuntimeMetrics(config: {
  healthEnabled: boolean;
  metricsEnabled: boolean;
  metricsPort: number;
}): Promise<{ close: () => void } | null> {
  if (getRuntime() !== 'jail') return null;

  const jail = await import('./jail/index.js');
  const { startMetricsServer, updateMetrics } = await import('./metrics.js');
  const { execFileSync } = await import('child_process');

  // Verify pf is loaded when using restricted network mode
  if (jail.JAIL_CONFIG.networkMode === 'restricted') {
    try {
      execFileSync('pfctl', ['-s', 'info'], { stdio: 'pipe' });
    } catch {
      logger.warn(
        'pf firewall does not appear to be running. Restricted network mode requires pf rules for jail connectivity. See docs/FREEBSD_JAILS.md.',
      );
    }
  }

  const poolName = jail.JAIL_CONFIG.jailsDataset.split('/')[0];
  const server = startMetricsServer(
    {
      healthEnabled: config.healthEnabled,
      metricsEnabled: config.metricsEnabled,
      port: config.metricsPort,
    },
    jail.JAIL_CONFIG.templateDataset,
    jail.JAIL_CONFIG.templateSnapshot,
    poolName,
    jail.JAIL_CONFIG.jailsPath,
  );

  // Periodic metrics updates
  let metricsInterval: ReturnType<typeof setInterval> | null = null;
  if (config.metricsEnabled) {
    metricsInterval = setInterval(async () => {
      await updateMetrics(
        jail.getActiveJailCount,
        jail.getEpairMetrics,
        poolName,
      );
    }, 30000);
  }

  return {
    close: () => {
      if (metricsInterval) clearInterval(metricsInterval);
      server?.close();
    },
  };
}

/**
 * Start periodic runtime health checks (ZFS space, template snapshot).
 * Calls `onAlert` when a critical condition is detected.
 * Returns a cleanup function to stop the interval.
 * No-op for Docker/Apple runtimes.
 */
export function startRuntimeHealthChecks(
  onAlert: (message: string) => void,
): (() => void) | null {
  if (getRuntime() !== 'jail') return null;

  const { execFileSync } = require('child_process') as typeof import('child_process');

  const interval = setInterval(async () => {
    try {
      const jail = await import('./jail/index.js');
      const poolName = jail.JAIL_CONFIG.jailsDataset.split('/')[0];

      // Check ZFS pool space
      try {
        const availOutput = execFileSync(
          'zfs',
          ['get', '-Hp', '-o', 'value', 'available', poolName],
          { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 },
        );
        const usedOutput = execFileSync(
          'zfs',
          ['get', '-Hp', '-o', 'value', 'used', poolName],
          { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 },
        );
        const avail = parseInt(availOutput.trim(), 10);
        const used = parseInt(usedOutput.trim(), 10);
        if (avail > 0 && used > 0) {
          const pctAvail = (avail / (avail + used)) * 100;
          if (pctAvail < 10) {
            onAlert(
              `ZFS pool "${poolName}" is low on space: ${pctAvail.toFixed(1)}% free (${Math.round(avail / 1024 / 1024)}MB available).`,
            );
          }
        }
      } catch {
        // ZFS check failed — skip
      }

      // Check template snapshot exists
      const snapshot = `${jail.JAIL_CONFIG.templateDataset}@${jail.JAIL_CONFIG.templateSnapshot}`;
      try {
        execFileSync('zfs', ['list', '-t', 'snapshot', '-H', snapshot], {
          stdio: 'pipe',
          timeout: 5000,
        });
      } catch {
        onAlert(
          `Template snapshot missing: ${snapshot}. New jails cannot be created.`,
        );
      }
    } catch (err) {
      logger.debug({ err }, 'Runtime health check failed');
    }
  }, 5 * 60 * 1000);

  return () => clearInterval(interval);
}
