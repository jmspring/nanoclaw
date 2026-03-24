/**
 * Jail command execution: exec and spawn inside running jails.
 */
import { execFileSync, spawn, ChildProcess } from 'child_process';
import { logger } from '../logger.js';
import { JAIL_QUICK_OP_TIMEOUT } from './config.js';
import { getJailName, isJailRunning } from './lifecycle.js';
import type { ExecResult, ExecInJailOptions, SpawnInJailOptions } from './types.js';

/**
 * Execute a command inside a jail.
 */
export async function execInJail(
  groupId: string,
  command: string[],
  options: ExecInJailOptions = {},
): Promise<ExecResult> {
  const jailName = getJailName(groupId);
  const { env = {}, cwd, timeout, signal, onStdout, onStderr } = options;

  if (!isJailRunning(jailName)) {
    throw new Error(`Jail ${jailName} is not running`);
  }

  return new Promise((resolve, reject) => {
    const args = ['jexec', '-U', 'node'];

    if (cwd) {
      args.push('-d', cwd);
    }

    args.push(jailName);
    args.push('sh', '-c', 'umask 002; exec "$@"', '_');

    const envEntries = Object.entries(env);
    if (envEntries.length > 0) {
      args.push('env');
      for (const [key, value] of envEntries) {
        args.push(`${key}=${value}`);
      }
    }

    args.push(...command);

    logger.debug(
      { jailName, groupId, command: command.join(' '), cwd },
      'Executing in jail',
    );

    const proc = spawn('sudo', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const killJailProcesses = () => {
      try {
        execFileSync('sudo', ['jexec', jailName, 'kill', '-9', '-1'], {
          stdio: 'pipe',
          timeout: JAIL_QUICK_OP_TIMEOUT,
        });
      } catch {
        // Jail may have already stopped
      }
      proc.kill('SIGKILL');
    };

    const timeoutId = timeout
      ? setTimeout(() => {
          if (settled) return;
          timedOut = true;
          logger.warn(
            { jailName, groupId, timeout },
            'Execution timeout, killing jail processes',
          );
          killJailProcesses();
        }, timeout)
      : null;

    const abortHandler = () => {
      if (settled) return;
      aborted = true;
      logger.warn({ jailName, groupId }, 'Execution aborted via signal');
      killJailProcesses();
    };

    if (signal) {
      if (signal.aborted) {
        reject(new Error('Execution aborted'));
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      if (onStdout) onStdout(chunk);
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      if (onStderr) onStderr(chunk);
    });

    proc.on('close', (code) => {
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (signal) signal.removeEventListener('abort', abortHandler);

      if (aborted) {
        reject(new Error('Execution aborted'));
        return;
      }

      if (timedOut) {
        reject(new Error(`Execution timed out after ${timeout}ms`));
        return;
      }

      logger.debug({ jailName, groupId, code }, 'Execution completed');
      resolve({ code: code || 0, stdout, stderr });
    });

    proc.on('error', (error) => {
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (signal) signal.removeEventListener('abort', abortHandler);
      logger.error({ jailName, groupId, err: error }, 'Execution error');
      reject(error);
    });
  });
}

/**
 * Spawn an interactive process inside a jail (for streaming I/O).
 */
export function spawnInJail(
  groupId: string,
  command: string[],
  options: SpawnInJailOptions = {},
): ChildProcess {
  const jailName = getJailName(groupId);
  const { env = {}, cwd } = options;

  const args = ['jexec', '-U', 'node'];

  if (cwd) {
    args.push('-d', cwd);
  }

  args.push(jailName);
  args.push('env');
  for (const [key, value] of Object.entries(env)) {
    args.push(`${key}=${value}`);
  }

  if (command[0] === 'sh' && command[1] === '-c' && command.length >= 3) {
    args.push('sh', '-c', `umask 002; ${command[2]}`);
    args.push(...command.slice(3));
  } else {
    args.push('sh', '-c', `umask 002; exec "$@"`, '_', ...command);
  }

  logger.debug(
    { jailName, groupId, command: command.join(' '), cwd },
    'Spawning in jail',
  );

  return spawn('sudo', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
