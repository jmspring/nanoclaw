/**
 * Jail agent runner — runs Claude Agent SDK inside a FreeBSD jail.
 * This is the jail equivalent of the Docker agent runner in container-runner.ts.
 */
import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import { logger } from '../logger.js';
import {
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from '../config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from '../group-folder.js';
import { detectAuthMode } from '../credential-proxy.js';
import { validateAdditionalMounts } from '../mount-security.js';
import { writeRotatingLog } from '../log-rotation.js';
import type { RegisteredGroup } from '../types.js';
import type { JailMountPaths } from './types.js';

// Re-import types from container-runner to avoid circular deps
// These are duplicated intentionally — they're the contract between runner and orchestrator
interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  traceId?: string;
}

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

/** Default allowed tools for all groups. */
const ALL_TOOLS = [
  'Bash',
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
  'Task', 'TaskOutput', 'TaskStop',
  'TeamCreate', 'TeamDelete', 'SendMessage',
  'TodoWrite', 'ToolSearch', 'Skill',
  'NotebookEdit',
  'mcp__nanoclaw__*',
];

/** Restricted tools for non-main groups (no shell, no team management). */
const RESTRICTED_TOOLS = ALL_TOOLS.filter(
  (t) => !['Bash', 'TeamCreate', 'TeamDelete'].includes(t),
);

function getAllowedTools(isMain: boolean): string[] {
  return isMain ? ALL_TOOLS : RESTRICTED_TOOLS;
}

/**
 * Build semantic mount paths for FreeBSD jails.
 * Unlike Docker mounts, this doesn't include /dev/null tricks or file masking.
 */
function buildJailMountPaths(
  group: RegisteredGroup,
  isMain: boolean,
): JailMountPaths {
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);
  const groupIpcDir = resolveGroupIpcPath(group.folder);

  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );

  fs.mkdirSync(groupSessionsDir, { recursive: true });

  // Set permissions for shared host/jail access (mode 2775, group wheel)
  try {
    fs.chmodSync(groupSessionsDir, 0o2775);
    const uid = process.getuid?.() ?? 0;
    fs.chownSync(groupSessionsDir, uid, 0);
  } catch {
    // Non-fatal: permissions will be set by ensureHostDirectories in jail module
  }
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      try {
        fs.cpSync(srcDir, dstDir, { recursive: true });
      } catch {}
    }
  }

  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );

  let validatedAdditionalMounts:
    | Array<{ hostPath: string; jailPath: string; readonly: boolean }>
    | undefined;
  if (group.containerConfig?.additionalMounts) {
    const dockerMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    validatedAdditionalMounts = dockerMounts.map((m) => ({
      hostPath: m.hostPath,
      jailPath: m.containerPath,
      readonly: m.readonly,
    }));
  }

  return {
    projectPath: isMain ? projectRoot : null,
    groupPath: groupDir,
    ipcPath: groupIpcDir,
    claudeSessionPath: groupSessionsDir,
    agentRunnerPath: agentRunnerSrc,
    additionalMounts: validatedAdditionalMounts,
  };
}

/**
 * Run agent in a FreeBSD jail.
 * This is the entry point called by container-runner.ts when runtime is 'jail'.
 */
export async function runJailAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  logsDir: string,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  traceId?: string,
  tracedLogger?: pino.Logger,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const log = tracedLogger || logger;

  const { JAIL_CONFIG: jailConfig } = await import('./config.js');
  const jailLifecycle = await import('./lifecycle.js');
  const jailExec = await import('./exec.js');

  const mountPaths = buildJailMountPaths(group, input.isMain);

  const env: Record<string, string> = {
    TZ: TIMEZONE,
    HOME: '/home/node',
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    ANTHROPIC_BASE_URL: `http://${jailConfig.jailHostIP}:${CREDENTIAL_PROXY_PORT}`,
  };

  env.ALLOWED_TOOLS = getAllowedTools(input.isMain).join(',');

  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    env.ANTHROPIC_API_KEY = 'placeholder';
  } else {
    env.CLAUDE_CODE_OAUTH_TOKEN = 'placeholder';
  }

  log.info(
    { group: group.name, mountPaths },
    'Creating jail with semantic paths',
  );

  let jailName: string;
  let jailMounts: Array<{
    hostPath: string;
    jailPath: string;
    readonly: boolean;
  }>;
  try {
    const result = await jailLifecycle.createJailWithPaths(
      group.folder,
      mountPaths,
      traceId,
      tracedLogger,
    );
    jailName = result.jailName;
    jailMounts = result.mounts;

    jailLifecycle.trackJailTempFile(group.folder, '/tmp/dist');
    jailLifecycle.trackJailTempFile(group.folder, '/tmp/input.json');

    const jailToken = jailLifecycle.getJailToken(group.folder);
    if (jailToken) {
      env.CREDENTIAL_PROXY_TOKEN = jailToken;
    }
  } catch (err) {
    log.error({ group: group.name, err }, 'Failed to create jail');
    return {
      status: 'error',
      result: null,
      error: `Failed to create jail: ${err instanceof Error ? err.message : String(err)}`,
      traceId,
    };
  }

  return new Promise((resolve) => {
    const entrypointScript = `
      set -e
      if [ -f /app/entrypoint.sh ]; then
        exec /app/entrypoint.sh
      else
        cd /app
        npx tsc --outDir /tmp/dist 2>&1 >&2
        ln -sf /app/node_modules /tmp/dist/node_modules
        cat > /tmp/input.json
        exec node /tmp/dist/index.js < /tmp/input.json
      fi
    `;
    const proc = jailExec.spawnInJail(
      group.folder,
      ['sh', '-c', entrypointScript],
      { env },
    );

    onProcess(proc, jailName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    proc.stdin?.write(JSON.stringify(input));
    proc.stdin?.end();

    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    let hadStreamingOutput = false;

    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);
    let timedOut = false;

    const killJail = async () => {
      timedOut = true;
      log.error({ group: group.name, jailName }, 'Jail timeout, stopping');
      try {
        await jailLifecycle.stopJail(group.folder);
      } catch (err) {
        log.warn({ group: group.name, err }, 'Failed to stop jail');
        proc.kill('SIGKILL');
      }
    };

    let timeout = setTimeout(killJail, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killJail, timeoutMs);
    };

    proc.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString();

      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          log.warn(
            { group: group.name, size: stdout.length },
            'Jail stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break;

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
            resetTimeout();
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            log.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) log.debug({ jail: group.folder }, line);
      }
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        log.warn(
          { group: group.name, size: stderr.length },
          'Jail stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    proc.on('close', async (code: number | null) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      try {
        await jailLifecycle.destroyJail(group.folder, jailMounts);
      } catch (err) {
        log.warn({ group: group.name, err }, 'Failed to destroy jail');
      }

      if (timedOut) {
        const logContent = [
          `=== Jail Run Log (TIMEOUT) ===`,
          `Timestamp: ${new Date().toISOString()}`,
          `Group: ${group.name}`,
          `Jail: ${jailName}`,
          `Duration: ${duration}ms`,
          `Exit Code: ${code}`,
          `Had Streaming Output: ${hadStreamingOutput}`,
        ].join('\n');
        writeRotatingLog(logsDir, 'nanoclaw', logContent);

        if (hadStreamingOutput) {
          log.info(
            { group: group.name, jailName, duration, code },
            'Jail timed out after output (idle cleanup)',
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
          { group: group.name, jailName, duration, code },
          'Jail timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Jail timed out after ${configTimeout}ms`,
          traceId,
        });
        return;
      }

      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Jail Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Mounts ===`,
          jailMounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.jailPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
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
          jailMounts
            .map((m) => `${m.jailPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      writeRotatingLog(logsDir, 'nanoclaw', logLines.join('\n'));
      log.debug({ logsDir, verbose: isVerbose }, 'Jail log written');

      if (code !== 0) {
        log.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logsDir,
          },
          'Jail exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Jail exited with code ${code}: ${stderr.slice(-200)}`,
          traceId,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle
      if (onOutput) {
        outputChain.then(() => {
          log.info(
            { group: group.name, duration, newSessionId },
            'Jail completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair
      try {
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        log.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Jail completed',
        );

        resolve(output);
      } catch (err) {
        log.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse jail output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse jail output: ${err instanceof Error ? err.message : String(err)}`,
          traceId,
        });
      }
    });

    proc.on('error', async (err: Error) => {
      clearTimeout(timeout);
      log.error(
        { group: group.name, jailName, error: err },
        'Jail spawn error',
      );

      try {
        await jailLifecycle.destroyJail(group.folder, jailMounts);
      } catch (cleanupErr) {
        log.warn(
          { group: group.name, cleanupErr },
          'Failed to destroy jail after error',
        );
      }

      resolve({
        status: 'error',
        result: null,
        error: `Jail spawn error: ${err.message}`,
        traceId,
      });
    });
  });
}
