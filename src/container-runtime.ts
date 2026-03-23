/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
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
  // Auto-detect based on platform
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
 * FreeBSD Jail: 10.99.0.1 — the jail gateway IP (jails connect to 10.99.0.1:3001).
 * Docker Desktop (macOS): 127.0.0.1 — the VM routes host.docker.internal to loopback.
 * Docker (Linux): bind to the docker0 bridge IP so only containers can reach it.
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || detectProxyBindHost();

function detectProxyBindHost(): string {
  // FreeBSD jail: bind address depends on network mode
  if (getRuntime() === 'jail') {
    const mode = process.env.NANOCLAW_JAIL_NETWORK_MODE || 'restricted';
    return mode === 'restricted' ? '10.99.0.1' : '127.0.0.1';
  }

  if (os.platform() === 'darwin') return '127.0.0.1';

  // WSL uses Docker Desktop (same VM routing as macOS) — loopback is correct.
  // Check /proc filesystem, not env vars — WSL_DISTRO_NAME isn't set under systemd.
  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';

  // Bare-metal Linux: bind to the docker0 bridge IP
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
  // On Linux, host.docker.internal isn't built-in — add it explicitly
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
    // Jail runtime validates itself (ZFS template, jail command) when jails are created
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

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  const runtime = getRuntime();
  if (runtime === 'jail') {
    // Jail cleanup handled by jail-runtime.js
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
