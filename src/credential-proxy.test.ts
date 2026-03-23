import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const mockEnv: Record<string, string> = {};
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { startCredentialProxy, isAllowedSource, registerJailToken, revokeJailToken, checkRateLimit } from './credential-proxy.js';

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body = '',
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...options, hostname: '127.0.0.1', port },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('isAllowedSource', () => {
  const originalEnv = process.env.NANOCLAW_JAIL_NETWORK_MODE;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.NANOCLAW_JAIL_NETWORK_MODE;
    } else {
      process.env.NANOCLAW_JAIL_NETWORK_MODE = originalEnv;
    }
  });

  it('restricted mode allows 10.99.0.x addresses', () => {
    process.env.NANOCLAW_JAIL_NETWORK_MODE = 'restricted';
    expect(isAllowedSource('10.99.0.2')).toBe(true);
    expect(isAllowedSource('10.99.0.254')).toBe(true);
    expect(isAllowedSource('::ffff:10.99.0.5')).toBe(true);
  });

  it('restricted mode rejects localhost and other IPs', () => {
    process.env.NANOCLAW_JAIL_NETWORK_MODE = 'restricted';
    expect(isAllowedSource('127.0.0.1')).toBe(false);
    expect(isAllowedSource('::1')).toBe(false);
    expect(isAllowedSource('192.168.1.5')).toBe(false);
  });

  it('inherit mode allows localhost', () => {
    process.env.NANOCLAW_JAIL_NETWORK_MODE = 'inherit';
    expect(isAllowedSource('127.0.0.1')).toBe(true);
    expect(isAllowedSource('::1')).toBe(true);
    expect(isAllowedSource('::ffff:127.0.0.1')).toBe(true);
  });

  it('inherit mode rejects non-localhost', () => {
    process.env.NANOCLAW_JAIL_NETWORK_MODE = 'inherit';
    expect(isAllowedSource('10.99.0.2')).toBe(false);
    expect(isAllowedSource('192.168.1.5')).toBe(false);
  });

  it('rejects undefined/empty addresses', () => {
    expect(isAllowedSource(undefined)).toBe(false);
    expect(isAllowedSource('')).toBe(false);
  });

  it('defaults to restricted mode', () => {
    delete process.env.NANOCLAW_JAIL_NETWORK_MODE;
    expect(isAllowedSource('127.0.0.1')).toBe(false);
    expect(isAllowedSource('10.99.0.2')).toBe(true);
  });
});

describe('checkRateLimit', () => {
  it('allows requests within the limit', () => {
    const ip = 'rate-test-1';
    for (let i = 0; i < 60; i++) {
      expect(checkRateLimit(ip)).toBe(true);
    }
  });

  it('rejects requests exceeding the limit', () => {
    const ip = 'rate-test-2';
    for (let i = 0; i < 60; i++) {
      checkRateLimit(ip);
    }
    expect(checkRateLimit(ip)).toBe(false);
  });

  it('tracks different IPs independently', () => {
    const ip1 = 'rate-test-3a';
    const ip2 = 'rate-test-3b';
    for (let i = 0; i < 60; i++) {
      checkRateLimit(ip1);
    }
    expect(checkRateLimit(ip1)).toBe(false);
    expect(checkRateLimit(ip2)).toBe(true);
  });
});

describe('credential-proxy', () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;
  let upstreamPort: number;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;

  beforeEach(async () => {
    // Tests connect from 127.0.0.1, so use inherit mode to pass source IP check
    process.env.NANOCLAW_JAIL_NETWORK_MODE = 'inherit';
    lastUpstreamHeaders = {};

    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
    delete process.env.NANOCLAW_JAIL_NETWORK_MODE;
  });

  async function startProxy(env: Record<string, string>): Promise<number> {
    Object.assign(mockEnv, env, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0);
    return (proxyServer.address() as AddressInfo).port;
  }

  it('API-key mode injects x-api-key and strips placeholder', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-real-key');
  });

  it('OAuth mode replaces Authorization when container sends one', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer real-oauth-token',
    );
  });

  it('OAuth mode does not inject Authorization when container omits it', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    // Post-exchange: container uses x-api-key only, no Authorization header
    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'temp-key-from-exchange',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('temp-key-from-exchange');
    expect(lastUpstreamHeaders['authorization']).toBeUndefined();
  });

  it('strips hop-by-hop headers', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
          'transfer-encoding': 'chunked',
        },
      },
      '{}',
    );

    // Proxy strips client hop-by-hop headers. Node's HTTP client may re-add
    // its own Connection header (standard HTTP/1.1 behavior), but the client's
    // custom keep-alive and transfer-encoding must not be forwarded.
    expect(lastUpstreamHeaders['keep-alive']).toBeUndefined();
    expect(lastUpstreamHeaders['transfer-encoding']).toBeUndefined();
  });

  it('returns 502 when upstream is unreachable', async () => {
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:59999',
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(502);
    expect(res.body).toBe('Bad Gateway');
  });

  it('rejects requests from unauthorized source IP', async () => {
    // Switch to restricted mode — localhost connections should be rejected
    process.env.NANOCLAW_JAIL_NETWORK_MODE = 'restricted';
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(403);
    expect(res.body).toBe('Forbidden');
  });

  it('rejects requests with missing jail token when tokens are registered', async () => {
    const token = 'valid-jail-token-123';
    registerJailToken(token);
    try {
      proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

      const res = await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/v1/messages',
          headers: { 'content-type': 'application/json' },
        },
        '{}',
      );

      expect(res.statusCode).toBe(403);
      expect(res.body).toBe('Forbidden');
    } finally {
      revokeJailToken(token);
    }
  });

  it('rejects requests with invalid jail token', async () => {
    const token = 'valid-jail-token-456';
    registerJailToken(token);
    try {
      proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

      const res = await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/v1/messages',
          headers: {
            'content-type': 'application/json',
            'x-jail-token': 'wrong-token',
          },
        },
        '{}',
      );

      expect(res.statusCode).toBe(403);
      expect(res.body).toBe('Forbidden');
    } finally {
      revokeJailToken(token);
    }
  });

  it('allows requests with valid jail token', async () => {
    const token = 'valid-jail-token-789';
    registerJailToken(token);
    try {
      proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

      const res = await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/v1/messages',
          headers: {
            'content-type': 'application/json',
            'x-jail-token': token,
          },
        },
        '{}',
      );

      expect(res.statusCode).toBe(200);
    } finally {
      revokeJailToken(token);
    }
  });

  it('does not forward x-jail-token header upstream', async () => {
    const token = 'valid-jail-token-upstream';
    registerJailToken(token);
    try {
      proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

      await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/v1/messages',
          headers: {
            'content-type': 'application/json',
            'x-jail-token': token,
          },
        },
        '{}',
      );

      expect(lastUpstreamHeaders['x-jail-token']).toBeUndefined();
    } finally {
      revokeJailToken(token);
    }
  });
});
