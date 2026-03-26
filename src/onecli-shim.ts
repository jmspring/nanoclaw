/**
 * OneCLI SDK shim for upstream merge compatibility.
 *
 * Drop-in replacement for @onecli-sh/sdk that implements the OneCLI class
 * interface while delegating to the existing credential proxy internals.
 * This is a facade — same front door, completely different house behind it.
 *
 * Design constraints:
 * - Does NOT touch jail token lifecycle (handled by jail/lifecycle.ts)
 * - Does NOT start any HTTP server (credential proxy already runs one)
 * - Does NOT make HTTP calls (goes straight to in-process functions)
 * - Runs in the orchestrator process, not a separate service
 */
import { CREDENTIAL_PROXY_PORT } from './config.js';
import { CONTAINER_HOST_GATEWAY } from './container-runtime.js';
import { detectAuthMode } from './credential-proxy.js';
import { logger } from './logger.js';

export interface OneCLIOptions {
  url?: string;
  apiKey?: string;
  timeout?: number;
}

export interface EnsureAgentResult {
  created: boolean;
}

export interface ApplyContainerConfigOptions {
  addHostMapping?: boolean;
  agent?: string;
}

export class OneCLI {
  private options: OneCLIOptions;

  constructor(options?: OneCLIOptions) {
    this.options = options ?? {};
    logger.debug('OneCLI shim initialized (not the real OneCLI)');
  }

  async ensureAgent(config: {
    name: string;
    identifier: string;
  }): Promise<EnsureAgentResult> {
    logger.debug(
      { name: config.name, identifier: config.identifier },
      'OneCLI shim: ensureAgent (no-op)',
    );
    return { created: true };
  }

  async applyContainerConfig(
    args: string[],
    options?: ApplyContainerConfigOptions,
  ): Promise<boolean> {
    const baseUrl = `http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`;
    const authMode = detectAuthMode();

    // Find insertion point: before the image name (last element)
    const insertIdx = args.length > 0 ? args.length - 1 : 0;

    const envArgs = ['-e', `ANTHROPIC_BASE_URL=${baseUrl}`];
    if (authMode === 'oauth') {
      envArgs.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
    } else {
      envArgs.push('-e', 'ANTHROPIC_API_KEY=placeholder');
    }

    args.splice(insertIdx, 0, ...envArgs);

    logger.debug(
      { agent: options?.agent, authMode },
      'OneCLI shim: applyContainerConfig injected env vars',
    );
    return true;
  }
}
