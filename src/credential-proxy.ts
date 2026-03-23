/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

/** Normalize IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1 -> 127.0.0.1) */
function normalizeIP(addr: string | undefined): string {
  if (!addr) return '';
  return addr.replace(/^::ffff:/, '');
}

/** Check whether a remote address is allowed to use the proxy. */
export function isAllowedSource(remoteAddr: string | undefined): boolean {
  const addr = normalizeIP(remoteAddr);
  if (!addr) return false;

  const mode =
    (process.env.NANOCLAW_JAIL_NETWORK_MODE as 'inherit' | 'restricted') ||
    'restricted';

  if (mode === 'restricted') {
    // Jails use 10.99.0.0/24 via vnet epair
    return addr.startsWith('10.99.0.');
  }
  // Inherit mode: only localhost
  return addr === '127.0.0.1' || addr === '::1';
}

/** Set of valid per-jail tokens. Tokens are added on jail creation and removed on destruction. */
const validTokens = new Set<string>();

export function registerJailToken(token: string): void {
  validTokens.add(token);
}

export function revokeJailToken(token: string): void {
  validTokens.delete(token);
}

const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateLimitMap = new Map<string, { count: number; windowStart: number }>();

/** Check and update rate limit for an IP. Returns true if the request is allowed. */
export function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return true;
  }

  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const remoteAddr = req.socket.remoteAddress;
      if (!isAllowedSource(remoteAddr)) {
        logger.warn({ remoteAddr, url: req.url }, 'Credential proxy: rejected unauthorized source');
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      // Per-jail token authentication (skip if no tokens registered, e.g. Docker mode)
      if (validTokens.size > 0) {
        const token = req.headers['x-jail-token'] as string | undefined;
        if (!token || !validTokens.has(token)) {
          logger.warn({ remoteAddr, url: req.url }, 'Credential proxy: invalid or missing jail token');
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
      }

      // Request path validation — only proxy known API paths
      const reqPath = req.url || '';
      if (!reqPath.startsWith('/v1/') && !reqPath.startsWith('/api/oauth/')) {
        logger.warn({ remoteAddr, url: req.url }, 'Credential proxy: rejected invalid path');
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      // Per-IP rate limiting
      const normalizedAddr = normalizeIP(remoteAddr);
      if (!checkRateLimit(normalizedAddr)) {
        logger.warn({ remoteAddr, url: req.url }, 'Credential proxy: rate limit exceeded');
        res.writeHead(429);
        res.end('Too Many Requests');
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop and internal headers that must not be forwarded
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];
        delete headers['x-jail-token'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
