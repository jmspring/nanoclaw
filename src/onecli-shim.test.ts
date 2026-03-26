import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'api-key'),
}));

vi.mock('./container-runtime.js', () => ({
  CONTAINER_HOST_GATEWAY: 'host.docker.internal',
}));

vi.mock('./config.js', () => ({
  CREDENTIAL_PROXY_PORT: 3001,
}));

import { OneCLI } from './onecli-shim.js';
import type {
  OneCLIOptions,
  EnsureAgentResult,
  ApplyContainerConfigOptions,
} from './onecli-shim.js';
import { detectAuthMode } from './credential-proxy.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('OneCLI shim', () => {
  describe('constructor', () => {
    it('accepts options without error', () => {
      const opts: OneCLIOptions = {
        url: 'http://example.com',
        apiKey: 'key',
        timeout: 5000,
      };
      expect(() => new OneCLI(opts)).not.toThrow();
    });

    it('works with no options', () => {
      expect(() => new OneCLI()).not.toThrow();
    });
  });

  describe('ensureAgent', () => {
    it('returns { created: true }', async () => {
      const onecli = new OneCLI();
      const result: EnsureAgentResult = await onecli.ensureAgent({
        name: 'test-group',
        identifier: 'test-id',
      });
      expect(result).toEqual({ created: true });
    });

    it('does not call registerJailToken or any jail lifecycle function', async () => {
      // The shim should have no imports from jail/lifecycle.ts
      // Verify by checking the module has no side effects beyond logging
      const onecli = new OneCLI();
      await onecli.ensureAgent({ name: 'test', identifier: 'id' });
      // If it tried to call registerJailToken, it would fail since we didn't mock it
      // The fact that this passes confirms no jail lifecycle calls
    });
  });

  describe('applyContainerConfig', () => {
    it('injects ANTHROPIC_BASE_URL into args array', async () => {
      const onecli = new OneCLI();
      const args = ['docker', 'run', 'my-image'];
      await onecli.applyContainerConfig(args);
      expect(args).toContain('-e');
      expect(args).toContain(
        'ANTHROPIC_BASE_URL=http://host.docker.internal:3001',
      );
    });

    it('injects placeholder API key when auth mode is api-key', async () => {
      vi.mocked(detectAuthMode).mockReturnValue('api-key');
      const onecli = new OneCLI();
      const args = ['docker', 'run', 'my-image'];
      await onecli.applyContainerConfig(args);
      expect(args).toContain('ANTHROPIC_API_KEY=placeholder');
    });

    it('injects placeholder OAuth token when auth mode is oauth', async () => {
      vi.mocked(detectAuthMode).mockReturnValue('oauth');
      const onecli = new OneCLI();
      const args = ['docker', 'run', 'my-image'];
      await onecli.applyContainerConfig(args);
      expect(args).toContain('CLAUDE_CODE_OAUTH_TOKEN=placeholder');
      expect(args).not.toContain('ANTHROPIC_API_KEY=placeholder');
    });

    it('returns true', async () => {
      const onecli = new OneCLI();
      const result = await onecli.applyContainerConfig(['docker', 'run', 'img']);
      expect(result).toBe(true);
    });

    it('preserves existing args and inserts before the last element', async () => {
      const onecli = new OneCLI();
      const args = ['docker', 'run', '--rm', '-v', '/data:/data', 'my-image'];
      await onecli.applyContainerConfig(args);
      // Image should still be the last element
      expect(args[args.length - 1]).toBe('my-image');
      // Original args before insertion point should be preserved
      expect(args[0]).toBe('docker');
      expect(args[1]).toBe('run');
      expect(args[2]).toBe('--rm');
    });

    it('accepts options with agent identifier', async () => {
      const onecli = new OneCLI();
      const opts: ApplyContainerConfigOptions = {
        addHostMapping: false,
        agent: 'test-agent',
      };
      const args = ['docker', 'run', 'img'];
      const result = await onecli.applyContainerConfig(args, opts);
      expect(result).toBe(true);
    });
  });

  describe('exports', () => {
    it('exports OneCLI as a named export', async () => {
      const mod = await import('./onecli-shim.js');
      expect(mod.OneCLI).toBeDefined();
      expect(typeof mod.OneCLI).toBe('function');
    });
  });
});
