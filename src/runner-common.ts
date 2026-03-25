/**
 * Shared runner logic for Docker and jail agent runners.
 *
 * Both runners spawn a ChildProcess, feed it input via stdin, collect
 * stdout/stderr with truncation, parse output markers, handle timeouts,
 * write logs, and return a ContainerOutput. This module captures that
 * shared contract so each runner only needs to provide the spawn, kill,
 * and cleanup callbacks.
 */
import { ChildProcess } from 'child_process';
import pino from 'pino';

import { CONTAINER_MAX_OUTPUT_SIZE, IDLE_TIMEOUT } from './config.js';
import { writeRotatingLog } from './log-rotation.js';

// Sentinel markers for robust output parsing (must match agent-runner)
export const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  traceId?: string;
}

/** Description of a mount for logging purposes. */
export interface MountLogEntry {
  /** Verbose format: "hostPath -> targetPath (ro)" */
  verbose: string;
  /** Brief format: "targetPath (ro)" */
  brief: string;
}

export interface AgentProcessOptions {
  /** The spawned child process. */
  proc: ChildProcess;
  /** Display name for logs (container name or jail name). */
  processLabel: string;
  /** Runner kind for log messages (e.g. "Container" or "Jail"). */
  runtimeLabel: string;
  /** Group name for log context. */
  groupName: string;
  /** The input being sent to the agent. */
  input: ContainerInput;
  /** Directory to write rotating logs. */
  logsDir: string;
  /** Per-group timeout from config (before the IDLE_TIMEOUT grace floor). */
  configTimeout: number;
  /** Called after process is registered for tracking. */
  onProcess: (proc: ChildProcess, name: string) => void;
  /** Streaming output callback (optional). */
  onOutput?: (output: ContainerOutput) => Promise<void>;
  /** Called when the timeout fires. Must stop the process. */
  onTimeout: () => Promise<void>;
  /** Called when the process closes (for cleanup like jail destruction). */
  onClose: () => Promise<void>;
  /** Called when the process emits 'error' (for cleanup). */
  onError: () => Promise<void>;
  /** Trace ID to include in error responses. */
  traceId?: string;
  /** Logger instance. */
  log: pino.Logger;
  /** Mount descriptions for log output. */
  mountLog?: MountLogEntry[];
  /** Extra log lines to append in verbose/error mode (e.g. container args). */
  extraVerboseLogLines?: string[];
}

/**
 * Handle the full lifecycle of an agent process: stdin, stdout/stderr
 * buffering, marker parsing, timeout, logging, and result resolution.
 *
 * Returns a Promise<ContainerOutput> that resolves when the process exits
 * (or times out).
 */
export function handleAgentProcess(
  opts: AgentProcessOptions,
): Promise<ContainerOutput> {
  const {
    proc,
    processLabel,
    runtimeLabel,
    groupName,
    input,
    logsDir,
    configTimeout,
    onProcess,
    onOutput,
    onTimeout,
    onClose,
    onError,
    traceId,
    log,
    mountLog,
    extraVerboseLogLines,
  } = opts;

  const startTime = Date.now();

  return new Promise((resolve) => {
    onProcess(proc, processLabel);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Write input via stdin
    const stdin = proc.stdin;
    if (stdin) {
      stdin.write(JSON.stringify(input));
      stdin.end();
    }

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    let hadStreamingOutput = false;

    let timedOut = false;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = async () => {
      timedOut = true;
      log.error(
        { group: groupName, [runtimeLabel.toLowerCase()]: processLabel },
        `${runtimeLabel} timeout, stopping`,
      );
      try {
        await onTimeout();
      } catch (err) {
        log.warn(
          { group: groupName, [runtimeLabel.toLowerCase()]: processLabel, err },
          'Graceful stop failed, force killing',
        );
        proc.kill('SIGKILL');
      }
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    // --- stdout handler ---
    const stdoutStream = proc.stdout;
    if (stdoutStream) {
      stdoutStream.on('data', (data: Buffer) => {
        const chunk = data.toString();

        // Always accumulate for logging
        if (!stdoutTruncated) {
          const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
          if (chunk.length > remaining) {
            stdout += chunk.slice(0, remaining);
            stdoutTruncated = true;
            log.warn(
              { group: groupName, size: stdout.length },
              `${runtimeLabel} stdout truncated due to size limit`,
            );
          } else {
            stdout += chunk;
          }
        }

        // Stream-parse for output markers
        if (onOutput) {
          parseBuffer += chunk;
          let startIdx: number;
          while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
            const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
            if (endIdx === -1) break; // Incomplete pair, wait for more data

            const jsonStr = parseBuffer
              .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
              .trim();
            parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

            try {
              const parsed: ContainerOutput = JSON.parse(jsonStr);
              if (parsed.newSessionId) {
                newSessionId = parsed.newSessionId;
              }
              hadStreamingOutput = true;
              // Activity detected — reset the hard timeout
              resetTimeout();
              // Call onOutput for all markers (including null results)
              // so idle timers start even for "silent" query completions.
              outputChain = outputChain.then(() => onOutput(parsed));
            } catch (err) {
              log.warn(
                { group: groupName, error: err },
                'Failed to parse streamed output chunk',
              );
            }
          }
        }
      });
    }

    // --- stderr handler ---
    const stderrStream = proc.stderr;
    if (stderrStream) {
      stderrStream.on('data', (data: Buffer) => {
        const chunk = data.toString();
        const lines = chunk.trim().split('\n');
        for (const line of lines) {
          if (line)
            log.debug({ [runtimeLabel.toLowerCase()]: groupName }, line);
        }
        // Don't reset timeout on stderr — SDK writes debug logs continuously.
        // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
        if (stderrTruncated) return;
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
        if (chunk.length > remaining) {
          stderr += chunk.slice(0, remaining);
          stderrTruncated = true;
          log.warn(
            { group: groupName, size: stderr.length },
            `${runtimeLabel} stderr truncated due to size limit`,
          );
        } else {
          stderr += chunk;
        }
      });
    }

    // --- close handler ---
    proc.on('close', async (code: number | null) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      // Run cleanup (e.g. jail destruction) before processing result
      try {
        await onClose();
      } catch (err) {
        log.warn(
          { group: groupName, err },
          `Failed to clean up ${runtimeLabel.toLowerCase()}`,
        );
      }

      if (timedOut) {
        const logContent = [
          `=== ${runtimeLabel} Run Log (TIMEOUT) ===`,
          `Timestamp: ${new Date().toISOString()}`,
          `Group: ${groupName}`,
          `${runtimeLabel}: ${processLabel}`,
          `Duration: ${duration}ms`,
          `Exit Code: ${code}`,
          `Had Streaming Output: ${hadStreamingOutput}`,
        ].join('\n');
        writeRotatingLog(logsDir, 'nanoclaw', logContent);

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // process being reaped after the idle period expired.
        if (hadStreamingOutput) {
          log.info(
            {
              group: groupName,
              [runtimeLabel.toLowerCase()]: processLabel,
              duration,
              code,
            },
            `${runtimeLabel} timed out after output (idle cleanup)`,
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        log.error(
          {
            group: groupName,
            [runtimeLabel.toLowerCase()]: processLabel,
            duration,
            code,
          },
          `${runtimeLabel} timed out with no output`,
        );

        resolve({
          status: 'error',
          result: null,
          error: `${runtimeLabel} timed out after ${configTimeout}ms`,
          traceId,
        });
        return;
      }

      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== ${runtimeLabel} Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${groupName}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        // On error, log input metadata only — not the full prompt.
        // Full input is only included at verbose level to avoid
        // persisting user conversation content on every non-zero exit.
        if (isVerbose) {
          logLines.push(`=== Input ===`, JSON.stringify(input, null, 2), ``);
        } else {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            `Session ID: ${input.sessionId || 'new'}`,
            ``,
          );
        }
        if (extraVerboseLogLines) {
          logLines.push(...extraVerboseLogLines, ``);
        }
        logLines.push(
          `=== Mounts ===`,
          (mountLog || []).map((m) => m.verbose).join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          (mountLog || []).map((m) => m.brief).join('\n'),
          ``,
        );
      }

      writeRotatingLog(logsDir, 'nanoclaw', logLines.join('\n'));
      log.debug({ logsDir, verbose: isVerbose }, `${runtimeLabel} log written`);

      if (code !== 0) {
        log.error(
          {
            group: groupName,
            code,
            duration,
            stderr,
            stdout,
            logsDir,
          },
          `${runtimeLabel} exited with error`,
        );

        resolve({
          status: 'error',
          result: null,
          error: `${runtimeLabel} exited with code ${code}: ${stderr.slice(-200)}`,
          traceId,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          log.info(
            { group: groupName, duration, newSessionId },
            `${runtimeLabel} completed (streaming mode)`,
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        log.info(
          {
            group: groupName,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          `${runtimeLabel} completed`,
        );

        resolve(output);
      } catch (err) {
        log.error(
          {
            group: groupName,
            stdout,
            stderr,
            error: err,
          },
          `Failed to parse ${runtimeLabel.toLowerCase()} output`,
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse ${runtimeLabel.toLowerCase()} output: ${err instanceof Error ? err.message : String(err)}`,
          traceId,
        });
      }
    });

    // --- error handler ---
    proc.on('error', async (err: Error) => {
      clearTimeout(timeout);
      log.error(
        {
          group: groupName,
          [runtimeLabel.toLowerCase()]: processLabel,
          error: err,
        },
        `${runtimeLabel} spawn error`,
      );

      try {
        await onError();
      } catch (cleanupErr) {
        log.warn(
          { group: groupName, cleanupErr },
          `Failed to clean up ${runtimeLabel.toLowerCase()} after error`,
        );
      }

      resolve({
        status: 'error',
        result: null,
        error: `${runtimeLabel} spawn error: ${err.message}`,
        traceId,
      });
    });
  });
}
