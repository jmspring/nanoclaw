/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, execFile, spawn } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  getGroupSessionsDir,
  ensureGroupSettings,
  syncContainerSkills,
} from './runner-setup.js';
import pino from 'pino';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  getRuntime,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainerArgs,
} from './container-runtime.js';
import { detectAuthMode } from './credential-proxy.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';
import {
  handleAgentProcess,
  type ContainerInput,
  type ContainerOutput,
} from './runner-common.js';

// Re-export types from runner-common so existing consumers don't break
export type { ContainerInput, ContainerOutput } from './runner-common.js';

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Credentials are injected by the credential proxy, never exposed to containers.
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = getGroupSessionsDir(group.folder);
  ensureGroupSettings(groupSessionsDir);
  syncContainerSkills(groupSessionsDir);
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (!fs.existsSync(groupAgentRunnerDir) && fs.existsSync(agentRunnerSrc)) {
    fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: true,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

/** Default allowed tools for all groups. */
const ALL_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
  'mcp__nanoclaw__*',
];

/** Restricted tools for non-main groups (no shell, no team management). */
const RESTRICTED_TOOLS = ALL_TOOLS.filter(
  (t) => !['Bash', 'TeamCreate', 'TeamDelete'].includes(t),
);

export function getAllowedTools(isMain: boolean): string[] {
  return isMain ? ALL_TOOLS : RESTRICTED_TOOLS;
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  isMain: boolean,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Route API traffic through the credential proxy (containers never see real secrets)
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
  );

  // Mirror the host's auth method with a placeholder value.
  // API key mode: SDK sends x-api-key, proxy replaces with real key.
  // OAuth mode:   SDK exchanges placeholder token for temp API key,
  //               proxy injects real OAuth token on that exchange request.
  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  } else {
    args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
  }

  // Per-group tool restrictions
  args.push('-e', `ALLOWED_TOOLS=${getAllowedTools(isMain).join(',')}`);

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

/** Compute SHA-256 hash of a file, or null if the file doesn't exist. */
export function hashFile(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath);
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  traceId?: string,
  tracedLogger?: pino.Logger,
): Promise<ContainerOutput> {
  const log = tracedLogger || logger;
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // Integrity check: snapshot CLAUDE.md hash before agent run
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
  const preHash = hashFile(claudeMdPath);

  // Check runtime FIRST — jail path is completely independent from Docker.
  const runtime = getRuntime();
  let result: ContainerOutput;
  if (runtime === 'jail') {
    const { runJailAgent } = await import('./jail/runner.js');
    result = await runJailAgent(
      group,
      input,
      logsDir,
      onProcess,
      onOutput,
      traceId,
      tracedLogger,
    );
  } else {
    // Docker path only below this point
    const mounts = buildVolumeMounts(group, input.isMain);
    const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
    const containerName = `nanoclaw-${safeName}-${Date.now()}`;
    const containerArgs = buildContainerArgs(
      mounts,
      containerName,
      input.isMain,
    );

    log.debug(
      {
        group: group.name,
        containerName,
        mounts: mounts.map(
          (m) =>
            `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
        ),
        containerArgs: containerArgs.join(' '),
      },
      'Container mount configuration',
    );

    log.info(
      {
        group: group.name,
        containerName,
        mountCount: mounts.length,
        isMain: input.isMain,
      },
      'Spawning container agent',
    );

    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    result = await handleAgentProcess({
      proc: container,
      processLabel: containerName,
      runtimeLabel: 'Container',
      groupName: group.name,
      input,
      logsDir,
      configTimeout: group.containerConfig?.timeout || CONTAINER_TIMEOUT,
      onProcess,
      onOutput,
      onTimeout: () =>
        new Promise<void>((resolve, reject) => {
          execFile(
            ...stopContainerArgs(containerName),
            { timeout: 15000 },
            (err) => {
              if (err) reject(err);
              else resolve();
            },
          );
        }),
      onClose: async () => {
        // Docker containers are --rm, no cleanup needed
      },
      onError: async () => {
        // Docker containers are --rm, no cleanup needed
      },
      traceId,
      log,
      mountLog: mounts.map((m) => ({
        verbose: `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
        brief: `${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      })),
      extraVerboseLogLines: [`=== Container Args ===`, containerArgs.join(' ')],
    });
  }

  // Integrity check: compare CLAUDE.md hash after agent run
  const postHash = hashFile(claudeMdPath);
  if (preHash !== null && postHash !== null && preHash !== postHash) {
    log.warn(
      { group: group.name, folder: group.folder, preHash, postHash },
      'CLAUDE.md was modified during agent run',
    );
  }

  return result;
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    script?: string | null;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
