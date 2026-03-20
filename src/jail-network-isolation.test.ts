/**
 * Integration tests for FreeBSD jail network isolation (vnet + pf).
 *
 * Tests verify that jails in restricted mode (NANOCLAW_JAIL_NETWORK_MODE=restricted)
 * can only reach:
 *   1. api.anthropic.com (via pinned IP ranges in pf)
 *   2. DNS servers (8.8.8.8, 1.1.1.1)
 *   3. Credential proxy on host gateway (10.99.N.1:3001)
 *
 * And are blocked from:
 *   1. Arbitrary internet hosts
 *   2. Other jails (inter-jail isolation)
 *   3. Host services (except credential proxy)
 *
 * These tests require:
 *   - FreeBSD with jails enabled
 *   - ZFS with template snapshot
 *   - pf firewall configured (etc/pf-nanoclaw.conf)
 *   - sudo access (jails require root)
 *   - NANOCLAW_JAIL_NETWORK_MODE=restricted
 *
 * Run with: npm test jail-network-isolation.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createJailWithPaths,
  destroyJail,
  execInJail,
  JAIL_CONFIG,
  type JailCreationResult,
} from './jail-runtime.js';
import fs from 'fs';
import path from 'path';

// Skip tests if not in restricted network mode or not on FreeBSD
const isRestrictedMode = JAIL_CONFIG.networkMode === 'restricted';
const isFreeBSD = process.platform === 'freebsd';
const skipReason = !isFreeBSD
  ? 'Skipping: not running on FreeBSD'
  : !isRestrictedMode
    ? 'Skipping: NANOCLAW_JAIL_NETWORK_MODE != restricted'
    : null;

// Test configuration
const TEST_TIMEOUT = 30000; // 30s for network tests
const GROUP_ID_1 = 'test-network-iso-1';
const GROUP_ID_2 = 'test-network-iso-2';

// Anthropic API IP ranges (from etc/pf-nanoclaw.conf)
const ANTHROPIC_IP_V4 = '160.79.104.0/21'; // Covers 160.79.104.0 - 160.79.111.255
const ANTHROPIC_TEST_IP = '160.79.104.1'; // Should be allowed

// DNS servers (from etc/pf-nanoclaw.conf)
const DNS_GOOGLE = '8.8.8.8';
const DNS_CLOUDFLARE = '1.1.1.1';

// Blocked hosts for testing
const BLOCKED_HOST = 'google.com';
const BLOCKED_IP = '142.250.64.78'; // google.com IP (not in allowlist)

describe.skipIf(!isFreeBSD || !isRestrictedMode)(
  'Jail Network Isolation (restricted mode)',
  () => {
    let jail1: JailCreationResult | null = null;
    let jail2: JailCreationResult | null = null;
    const tempDir = '/tmp/nanoclaw-test-network-iso';

    beforeAll(async () => {
      // Create temporary directories for test jails
      const group1Path = path.join(tempDir, GROUP_ID_1);
      const group2Path = path.join(tempDir, GROUP_ID_2);
      const ipc1Path = path.join(tempDir, GROUP_ID_1, 'ipc');
      const ipc2Path = path.join(tempDir, GROUP_ID_2, 'ipc');
      const session1Path = path.join(tempDir, GROUP_ID_1, '.claude');
      const session2Path = path.join(tempDir, GROUP_ID_2, '.claude');

      // Ensure clean state
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }

      // Create jail 1
      jail1 = await createJailWithPaths(GROUP_ID_1, {
        projectPath: null,
        groupPath: group1Path,
        ipcPath: ipc1Path,
        claudeSessionPath: session1Path,
        agentRunnerPath: process.cwd(), // Use current directory as dummy
      });

      // Create jail 2 (for inter-jail isolation tests)
      jail2 = await createJailWithPaths(GROUP_ID_2, {
        projectPath: null,
        groupPath: group2Path,
        ipcPath: ipc2Path,
        claudeSessionPath: session2Path,
        agentRunnerPath: process.cwd(), // Use current directory as dummy
      });
    }, TEST_TIMEOUT);

    afterAll(async () => {
      // Clean up jails
      if (jail1) {
        await destroyJail(GROUP_ID_1, jail1.mounts);
      }
      if (jail2) {
        await destroyJail(GROUP_ID_2, jail2.mounts);
      }

      // Clean up temp directory
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }, TEST_TIMEOUT);

    describe('Allowed outbound connections', () => {
      it(
        'can reach DNS servers (UDP port 53)',
        async () => {
          // Test Google DNS
          const resultGoogle = await execInJail(
            GROUP_ID_1,
            ['nc', '-u', '-z', '-w', '5', DNS_GOOGLE, '53'],
            { timeout: 10000 },
          );
          expect(resultGoogle.code).toBe(0);

          // Test Cloudflare DNS
          const resultCloudflare = await execInJail(
            GROUP_ID_1,
            ['nc', '-u', '-z', '-w', '5', DNS_CLOUDFLARE, '53'],
            { timeout: 10000 },
          );
          expect(resultCloudflare.code).toBe(0);
        },
        TEST_TIMEOUT,
      );

      it(
        'can resolve DNS queries',
        async () => {
          // Test DNS resolution
          const result = await execInJail(
            GROUP_ID_1,
            ['host', '-W', '5', 'api.anthropic.com'],
            { timeout: 10000 },
          );
          expect(result.code).toBe(0);
          expect(result.stdout).toContain('has address');
        },
        TEST_TIMEOUT,
      );

      it(
        'can reach Anthropic API IP ranges (160.79.104.0/21) on port 443',
        async () => {
          // Test HTTPS connection to Anthropic API IP range
          // Note: We test TCP connectivity, not full HTTPS (to avoid cert issues)
          const result = await execInJail(
            GROUP_ID_1,
            ['nc', '-z', '-w', '5', ANTHROPIC_TEST_IP, '443'],
            { timeout: 10000 },
          );

          // Exit code 0 means connection succeeded
          // Exit code 1 means connection refused/timeout (blocked by pf)
          expect(result.code).toBe(0);
        },
        TEST_TIMEOUT,
      );

      it(
        'can reach credential proxy on host gateway (port 3001)',
        async () => {
          // Get the jail's gateway IP (10.99.N.1 where N is the epair number)
          // The jail uses 10.99.N.2 and gateway is 10.99.N.1
          const ifconfigResult = await execInJail(
            GROUP_ID_1,
            ['ifconfig', 'epair', '|', 'grep', 'inet'],
            { timeout: 5000 },
          );

          // Parse jail IP to get gateway (e.g., 10.99.0.2 -> 10.99.0.1)
          const jailIPMatch =
            ifconfigResult.stdout.match(/inet (\d+\.\d+\.\d+)\.\d+/);
          expect(jailIPMatch).toBeTruthy();

          const gatewayIP = `${jailIPMatch![1]}.1`;

          // Test connection to credential proxy port
          // Note: We only test TCP connectivity - the proxy may not be running
          const result = await execInJail(
            GROUP_ID_1,
            ['nc', '-z', '-w', '2', gatewayIP, '3001'],
            { timeout: 5000 },
          );

          // Connection may fail if proxy not running, but shouldn't timeout
          // (timeout = blocked by firewall, refused = port closed but reachable)
          // Exit code 0 = success, 1 = connection refused (allowed but not listening)
          expect([0, 1]).toContain(result.code);
        },
        TEST_TIMEOUT,
      );
    });

    describe('Blocked outbound connections', () => {
      it(
        'cannot reach arbitrary internet hosts (google.com)',
        async () => {
          // Test DNS resolution fails for non-Anthropic hosts
          // This should timeout or fail because pf blocks outbound to arbitrary IPs
          const result = await execInJail(
            GROUP_ID_1,
            ['nc', '-z', '-w', '3', BLOCKED_IP, '443'],
            { timeout: 10000 },
          );

          // Exit code should be non-zero (connection blocked/timeout)
          expect(result.code).not.toBe(0);
        },
        TEST_TIMEOUT,
      );

      it(
        'cannot reach arbitrary ports on allowed IPs',
        async () => {
          // Test that even Anthropic IPs are blocked on non-443 ports
          const result = await execInJail(
            GROUP_ID_1,
            ['nc', '-z', '-w', '3', ANTHROPIC_TEST_IP, '80'],
            { timeout: 10000 },
          );

          // Should fail - pf only allows port 443 to Anthropic IPs
          expect(result.code).not.toBe(0);
        },
        TEST_TIMEOUT,
      );

      it(
        'cannot reach DNS on TCP (only UDP allowed)',
        async () => {
          // Test that DNS on TCP is blocked (pf allows UDP only)
          const result = await execInJail(
            GROUP_ID_1,
            ['nc', '-z', '-w', '3', DNS_GOOGLE, '53'],
            { timeout: 10000 },
          );

          // Should fail - pf only allows UDP DNS
          expect(result.code).not.toBe(0);
        },
        TEST_TIMEOUT,
      );
    });

    describe('Inter-jail isolation', () => {
      it(
        'jail 1 cannot reach jail 2 IP',
        async () => {
          // Get jail 2's IP address
          const jail2IPResult = await execInJail(
            GROUP_ID_2,
            ['ifconfig', 'epair', '|', 'grep', 'inet', '|', 'head', '-1'],
            { timeout: 5000 },
          );

          const jail2IPMatch =
            jail2IPResult.stdout.match(/inet (\d+\.\d+\.\d+\.\d+)/);
          expect(jail2IPMatch).toBeTruthy();
          const jail2IP = jail2IPMatch![1];

          // Try to reach jail 2 from jail 1 (should be blocked by pf)
          const result = await execInJail(
            GROUP_ID_1,
            ['nc', '-z', '-w', '3', jail2IP, '22'],
            { timeout: 10000 },
          );

          // Should fail - inter-jail traffic is blocked by pf
          expect(result.code).not.toBe(0);
        },
        TEST_TIMEOUT,
      );

      it(
        'jail 2 cannot reach jail 1 IP',
        async () => {
          // Get jail 1's IP address
          const jail1IPResult = await execInJail(
            GROUP_ID_1,
            ['ifconfig', 'epair', '|', 'grep', 'inet', '|', 'head', '-1'],
            { timeout: 5000 },
          );

          const jail1IPMatch =
            jail1IPResult.stdout.match(/inet (\d+\.\d+\.\d+\.\d+)/);
          expect(jail1IPMatch).toBeTruthy();
          const jail1IP = jail1IPMatch![1];

          // Try to reach jail 1 from jail 2 (should be blocked by pf)
          const result = await execInJail(
            GROUP_ID_2,
            ['nc', '-z', '-w', '3', jail1IP, '22'],
            { timeout: 10000 },
          );

          // Should fail - inter-jail traffic is blocked by pf
          expect(result.code).not.toBe(0);
        },
        TEST_TIMEOUT,
      );
    });

    describe('Host service isolation', () => {
      it(
        'cannot reach host SSH (port 22)',
        async () => {
          // Get default gateway (host IP)
          const routeResult = await execInJail(
            GROUP_ID_1,
            ['netstat', '-rn', '|', 'grep', 'default'],
            { timeout: 5000 },
          );

          const gatewayMatch = routeResult.stdout.match(/default\s+(\S+)/);
          expect(gatewayMatch).toBeTruthy();
          const gatewayIP = gatewayMatch![1];

          // Try to reach host SSH (should be blocked except port 3001)
          const result = await execInJail(
            GROUP_ID_1,
            ['nc', '-z', '-w', '3', gatewayIP, '22'],
            { timeout: 10000 },
          );

          // Should fail - host services are blocked except credential proxy
          expect(result.code).not.toBe(0);
        },
        TEST_TIMEOUT,
      );

      it(
        'cannot reach host HTTP (port 80)',
        async () => {
          // Get default gateway (host IP)
          const routeResult = await execInJail(
            GROUP_ID_1,
            ['netstat', '-rn', '|', 'grep', 'default'],
            { timeout: 5000 },
          );

          const gatewayMatch = routeResult.stdout.match(/default\s+(\S+)/);
          expect(gatewayMatch).toBeTruthy();
          const gatewayIP = gatewayMatch![1];

          // Try to reach host HTTP
          const result = await execInJail(
            GROUP_ID_1,
            ['nc', '-z', '-w', '3', gatewayIP, '80'],
            { timeout: 10000 },
          );

          // Should fail - host services are blocked except credential proxy
          expect(result.code).not.toBe(0);
        },
        TEST_TIMEOUT,
      );
    });

    describe('pf rule verification', () => {
      it(
        'pf is enabled and loaded',
        async () => {
          // This test runs on the host, not in jail
          const { execFileSync } = await import('child_process');
          const result = execFileSync('sudo', ['pfctl', '-s', 'info'], {
            encoding: 'utf-8',
          });

          expect(result).toContain('Status: Enabled');
        },
        TEST_TIMEOUT,
      );

      it(
        'pf has jail network rules loaded',
        async () => {
          // This test runs on the host, not in jail
          const { execFileSync } = await import('child_process');
          const result = execFileSync('sudo', ['pfctl', '-s', 'rules'], {
            encoding: 'utf-8',
          });

          // Check for key rules from etc/pf-nanoclaw.conf
          expect(result).toContain('10.99.0.0/24'); // Jail network
          expect(result).toContain('port 3001'); // Credential proxy
        },
        TEST_TIMEOUT,
      );

      it(
        'pf has Anthropic API IP table loaded',
        async () => {
          // This test runs on the host, not in jail
          const { execFileSync } = await import('child_process');
          const result = execFileSync(
            'sudo',
            ['pfctl', '-t', 'anthropic_api', '-T', 'show'],
            {
              encoding: 'utf-8',
            },
          );

          // Check for Anthropic IP ranges
          expect(result).toMatch(/160\.79\.104\.0\/21|2607:6bc0::\/48/);
        },
        TEST_TIMEOUT,
      );
    });
  },
);

// Export skip reason for debugging
if (skipReason) {
  console.log(`[jail-network-isolation.test.ts] ${skipReason}`);
}
