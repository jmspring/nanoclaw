/**
 * DTrace Integration for NanoClaw Jail Runtime
 *
 * Provides a thin wrapper around FreeBSD DTrace for observing jail activity.
 * DTrace requires root/sudo and is FreeBSD-only. All functions degrade
 * gracefully when DTrace is unavailable.
 *
 * Jail ID filtering approach: Uses curthread->td_ucred->cr_prison->pr_id
 * which is the standard FreeBSD kernel path to the jail ID. This is passed
 * to D scripts via the -D jailid=<id> macro variable.
 */
import { type ChildProcess, spawn } from 'child_process';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';

/** Path to D scripts relative to project root */
const DTRACE_SCRIPTS_DIR = path.resolve(process.cwd(), 'etc', 'dtrace');

/** Active DTrace session tracking */
export interface DTraceSession {
  jailId: number;
  script: string;
  proc: ChildProcess;
  outputPath: string;
}

/**
 * Check if DTrace is available on this system.
 * Returns false on non-FreeBSD or when dtrace binary is not found.
 */
export function isDTraceAvailable(): boolean {
  try {
    execFileSync('which', ['dtrace'], { encoding: 'utf-8', timeout: 5000 });
    return true;
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return false;
  }
}

/**
 * List available D scripts in the etc/dtrace/ directory.
 * Returns empty array if the directory doesn't exist.
 */
export function listAvailableScripts(): string[] {
  try {
    return fs
      .readdirSync(DTRACE_SCRIPTS_DIR)
      .filter((f) => f.endsWith('.d'))
      .sort();
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return [];
  }
}

/**
 * Start a DTrace trace session for a specific jail.
 *
 * Spawns `sudo dtrace -s <script> -D jailid=<id>` as a background process.
 * Output is redirected to a file in outputDir.
 *
 * Returns null if DTrace is unavailable or the script doesn't exist.
 */
export function startTrace(
  jailId: number,
  scriptName: string,
  outputDir: string,
): DTraceSession | null {
  if (!isDTraceAvailable()) {
    logger.debug('DTrace not available, skipping trace');
    return null;
  }

  const scriptPath = path.join(DTRACE_SCRIPTS_DIR, scriptName);
  if (!fs.existsSync(scriptPath)) {
    logger.warn({ scriptName }, 'DTrace script not found');
    return null;
  }

  const outputPath = path.join(
    outputDir,
    `dtrace-${scriptName.replace('.d', '')}-${jailId}-${Date.now()}.log`,
  );

  fs.mkdirSync(outputDir, { recursive: true });

  const outputStream = fs.createWriteStream(outputPath);

  const proc = spawn(
    'sudo',
    ['dtrace', '-C', '-s', scriptPath, `-D`, `jailid=${jailId}`],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  );

  proc.stdout?.pipe(outputStream);
  proc.stderr?.on('data', (data: Buffer) => {
    logger.debug(
      { script: scriptName, jailId, stderr: data.toString().trim() },
      'DTrace stderr',
    );
  });

  proc.on('error', (err) => {
    logger.warn({ err, script: scriptName, jailId }, 'DTrace process error');
  });

  logger.info(
    { script: scriptName, jailId, pid: proc.pid, outputPath },
    'DTrace trace started',
  );

  return { jailId, script: scriptName, proc, outputPath };
}

/**
 * Stop a DTrace trace session gracefully.
 *
 * Sends SIGINT to the DTrace process (which causes it to print final
 * output and exit), then waits for the process to terminate.
 *
 * Returns the output file path.
 */
export function stopTrace(session: DTraceSession): Promise<string> {
  return new Promise((resolve) => {
    if (!session.proc.pid || session.proc.killed) {
      resolve(session.outputPath);
      return;
    }

    const timeout = setTimeout(() => {
      logger.warn(
        { script: session.script, jailId: session.jailId },
        'DTrace process did not exit after SIGINT, sending SIGKILL',
      );
      session.proc.kill('SIGKILL');
      resolve(session.outputPath);
    }, 5000);

    session.proc.on('exit', () => {
      clearTimeout(timeout);
      logger.info(
        { script: session.script, jailId: session.jailId },
        'DTrace trace stopped',
      );
      resolve(session.outputPath);
    });

    session.proc.kill('SIGINT');
  });
}
