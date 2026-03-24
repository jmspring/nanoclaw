/**
 * Sudo execution helpers with dependency injection for testing.
 */
import { execFile, execFileSync } from 'child_process';
import { JAIL_EXEC_TIMEOUT } from './config.js';
import type {
  JailRuntimeDeps,
  SudoExecutor,
  SudoExecutorSync,
  SudoExecOptions,
  SudoExecResult,
} from './types.js';

/** Global dependency injection context (can be overridden for testing) */
let deps: JailRuntimeDeps | null = null;

/** Default implementation: Execute a command with sudo, returning a promise */
function defaultSudoExec(
  args: string[],
  options: SudoExecOptions = {},
): Promise<SudoExecResult> {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout || JAIL_EXEC_TIMEOUT;
    execFile('sudo', args, { timeout, ...options }, (error, stdout, stderr) => {
      if (error) {
        reject(
          new Error(
            `sudo ${args.join(' ')} failed: ${stderr || error.message}`,
          ),
        );
      } else {
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      }
    });
  });
}

/** Default implementation: Execute a command with sudo synchronously */
function defaultSudoExecSync(args: string[], options: SudoExecOptions = {}): string {
  try {
    return execFileSync('sudo', args, {
      encoding: 'utf-8',
      timeout: JAIL_EXEC_TIMEOUT,
      ...options,
    });
  } catch (error) {
    throw new Error(
      `sudo ${args.join(' ')} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Set dependency injection context for testing. */
export function setJailRuntimeDeps(newDeps: Partial<JailRuntimeDeps>): void {
  deps = {
    sudoExec: newDeps.sudoExec || defaultSudoExec,
    sudoExecSync: newDeps.sudoExecSync || defaultSudoExecSync,
  };
}

/** Reset dependency injection context to defaults. */
export function resetJailRuntimeDeps(): void {
  deps = null;
}

/** Get the current sudo executor. */
export function getSudoExec(): SudoExecutor {
  return deps?.sudoExec || defaultSudoExec;
}

/** Get the current sync sudo executor. */
export function getSudoExecSync(): SudoExecutorSync {
  return deps?.sudoExecSync || defaultSudoExecSync;
}
