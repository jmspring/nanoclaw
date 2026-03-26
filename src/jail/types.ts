/**
 * Type definitions for FreeBSD jail runtime.
 */
import { ChildProcess } from 'child_process';

/** Jail mount specification */
export interface JailMount {
  hostPath: string;
  jailPath: string;
  readonly: boolean;
}

/** Semantic mount paths for jail creation */
export interface JailMountPaths {
  projectPath: string | null;
  groupPath: string;
  globalPath?: string | null;
  ipcPath: string;
  claudeSessionPath: string;
  agentRunnerPath: string;
  additionalMounts?: Array<{
    hostPath: string;
    jailPath: string;
    readonly: boolean;
  }>;
}

/** Result of jail creation with paths */
export interface JailCreationResult {
  jailName: string;
  mounts: JailMount[];
  epairInfo?: EpairInfo;
}

/** Execution result from execInJail */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Options for execInJail */
export interface ExecInJailOptions {
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
}

/** Options for spawnInJail */
export interface SpawnInJailOptions {
  env?: Record<string, string>;
  cwd?: string;
}

/** Epair interface information */
export interface EpairInfo {
  epairNum: number;
  hostIface: string;
  jailIface: string;
  hostIP: string;
  jailIP: string;
  netmask: string;
}

/** Resource limits configuration */
export interface ResourceLimits {
  memoryuse: string;
  maxproc: string;
  pcpu: string;
}

/** Jail configuration */
export interface JailConfig {
  templateDataset: string;
  templateSnapshot: string;
  jailsDataset: string;
  jailsPath: string;
  workspacesPath: string;
  ipcPath: string;
  networkMode: 'inherit' | 'restricted';
  jailSubnet: string;
  jailHostIP: string;
  jailIP: string;
  jailNetmask: string;
  resourceLimits: ResourceLimits;
}

/** Result from sudoExec */
export interface SudoExecResult {
  stdout: string;
  stderr: string;
}

/** Options for sudoExec */
export interface SudoExecOptions {
  timeout?: number;
  encoding?: BufferEncoding;
  stdio?: 'pipe' | 'ignore' | 'inherit';
}

/** Type for injectable sudo executor */
export type SudoExecutor = (
  args: string[],
  options?: SudoExecOptions,
) => Promise<SudoExecResult>;

/** Type for injectable sudo executor (synchronous) */
export type SudoExecutorSync = (
  args: string[],
  options?: SudoExecOptions,
) => string;

/** Dependency injection context for testing */
export interface JailRuntimeDeps {
  sudoExec: SudoExecutor;
  sudoExecSync: SudoExecutorSync;
}
