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
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  TIMEZONE,
} from '../config.js';
import {
  resolveGroupFolderPath,
  resolveGroupIpcPath,
} from '../group-folder.js';
import { detectAuthMode } from '../credential-proxy.js';
import { validateAdditionalMounts } from '../mount-security.js';
import type { RegisteredGroup } from '../types.js';
import type { JailMountPaths } from './types.js';
import {
  handleAgentProcess,
  type ContainerInput,
  type ContainerOutput,
} from '../runner-common.js';
import { getAllowedTools } from '../container-runner.js';

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

  // Shadow .env to prevent agent from reading secrets (matches Docker runner behavior)
  let envShadowPath: string | null = null;
  if (isMain) {
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      envShadowPath = '/dev/null';
    }
  }

  return {
    projectPath: isMain ? projectRoot : null,
    groupPath: groupDir,
    ipcPath: groupIpcDir,
    claudeSessionPath: groupSessionsDir,
    agentRunnerPath: agentRunnerSrc,
    envShadowPath,
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

    // Use per-jail gateway IP for credential proxy (each jail has its own epair)
    const hostIP = result.epairInfo?.hostIP ?? jailConfig.jailHostIP;
    env.ANTHROPIC_BASE_URL = `http://${hostIP}:${CREDENTIAL_PROXY_PORT}`;

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

  return handleAgentProcess({
    proc,
    processLabel: jailName,
    runtimeLabel: 'Jail',
    groupName: group.name,
    input,
    logsDir,
    configTimeout: group.containerConfig?.timeout || CONTAINER_TIMEOUT,
    onProcess,
    onOutput,
    onTimeout: async () => {
      await jailLifecycle.stopJail(group.folder);
    },
    onClose: async () => {
      await jailLifecycle.destroyJail(group.folder, jailMounts);
    },
    onError: async () => {
      await jailLifecycle.destroyJail(group.folder, jailMounts);
    },
    traceId,
    log,
    mountLog: jailMounts.map((m) => ({
      verbose: `${m.hostPath} -> ${m.jailPath}${m.readonly ? ' (ro)' : ''}`,
      brief: `${m.jailPath}${m.readonly ? ' (ro)' : ''}`,
    })),
  });
}
