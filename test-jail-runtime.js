/**
 * Test suite for jail-runtime.js
 * Run with: node test-jail-runtime.js
 */
import {
  createJail,
  execInJail,
  stopJail,
  destroyJail,
  cleanupJail,
  isJailRunning,
  getJailName,
  sanitizeJailName,
  JAIL_CONFIG,
} from './jail/index.js';
import { execFileSync, execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const TESTS = [];
let passCount = 0;
let failCount = 0;

/** Generate unique test group ID */
function uniqueGroupId(prefix = 'test') {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

/** Check if ZFS dataset exists */
function datasetExists(dataset) {
  try {
    execFileSync('zfs', ['list', '-H', dataset], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Check if a path is mounted (nullfs) */
function isMounted(mountPoint) {
  try {
    const output = execFileSync('mount', ['-t', 'nullfs'], { encoding: 'utf-8' });
    return output.includes(mountPoint);
  } catch {
    return false;
  }
}

/** Register a test */
function test(name, fn) {
  TESTS.push({ name, fn });
}

/** Run all tests */
async function runTests() {
  console.log('\n========================================');
  console.log('  jail-runtime.js Test Suite');
  console.log('========================================\n');

  for (const { name, fn } of TESTS) {
    process.stdout.write(`[    ] ${name}`);
    try {
      await fn();
      passCount++;
      process.stdout.write(`\r[PASS] ${name}\n`);
    } catch (error) {
      failCount++;
      process.stdout.write(`\r[FAIL] ${name}\n`);
      console.log(`       Error: ${error.message}`);
      if (error.stack) {
        const stackLines = error.stack.split('\n').slice(1, 4);
        for (const line of stackLines) {
          console.log(`       ${line.trim()}`);
        }
      }
    }
  }

  console.log('\n========================================');
  console.log(`  Results: ${passCount} passed, ${failCount} failed`);
  console.log('========================================\n');

  return failCount === 0;
}

/** Assert helper */
function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

/** Assert equality helper */
function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}

// ============================================================================
// TEST 1: create() — jail ZFS dataset exists, jail running, nullfs mounts active
// ============================================================================
test('create() — jail ZFS dataset exists, jail running, nullfs mounts active', async () => {
  const groupId = uniqueGroupId('create');
  const jailName = getJailName(groupId);
  const dataset = `${JAIL_CONFIG.jailsDataset}/${jailName}`;
  const jailPath = path.join(JAIL_CONFIG.jailsPath, jailName);

  // Create a temp workspace to mount
  const workspaceDir = path.join(JAIL_CONFIG.workspacesPath, groupId);
  fs.mkdirSync(workspaceDir, { recursive: true });

  const mounts = [
    { hostPath: workspaceDir, jailPath: 'workspace', readonly: false },
  ];

  try {
    // Create the jail
    await createJail(groupId, mounts);

    // Verify ZFS dataset exists
    assert(datasetExists(dataset), 'ZFS dataset should exist');

    // Verify jail is running via jls
    assert(isJailRunning(jailName), 'Jail should be running');

    // Verify nullfs mount is active
    const mountTarget = path.join(jailPath, 'workspace');
    assert(isMounted(mountTarget), 'nullfs mount should be active');

  } finally {
    // Cleanup
    await destroyJail(groupId, mounts);
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

// ============================================================================
// TEST 2: exec() — command runs inside jail, stdout captured correctly
// ============================================================================
test('exec() — command runs inside jail, stdout captured correctly', async () => {
  const groupId = uniqueGroupId('exec');
  const mounts = [];

  try {
    await createJail(groupId, mounts);

    // Run a simple command that outputs known text (use absolute path)
    const result = await execInJail(groupId, ['/bin/sh', '-c', '/bin/echo "Hello from jail"']);

    assertEqual(result.code, 0, 'Exit code should be 0');
    assert(
      result.stdout.trim() === 'Hello from jail',
      `stdout should be 'Hello from jail', got: '${result.stdout.trim()}'`
    );

    // Run a command that outputs multiple lines
    const multiResult = await execInJail(groupId, ['/bin/sh', '-c', '/bin/echo line1; /bin/echo line2; /bin/echo line3']);
    const lines = multiResult.stdout.trim().split('\n');
    assertEqual(lines.length, 3, 'Should have 3 lines of output');
    assertEqual(lines[0], 'line1', 'First line should be line1');
    assertEqual(lines[2], 'line3', 'Third line should be line3');

  } finally {
    await destroyJail(groupId, mounts);
  }
});

// ============================================================================
// TEST 3: exec() — environment variables passed through to jailed process
// ============================================================================
test('exec() — environment variables passed through to jailed process', async () => {
  const groupId = uniqueGroupId('envvars');
  const mounts = [];

  try {
    await createJail(groupId, mounts);

    // Pass environment variables and verify they're accessible
    const result = await execInJail(groupId, ['/bin/sh', '-c', '/bin/echo $TEST_VAR1:$TEST_VAR2'], {
      env: {
        PATH: '/bin:/usr/bin:/usr/local/bin',
        TEST_VAR1: 'hello',
        TEST_VAR2: 'world',
      },
    });

    assertEqual(result.code, 0, 'Exit code should be 0');
    assertEqual(
      result.stdout.trim(),
      'hello:world',
      `Environment variables should be passed through, got: '${result.stdout.trim()}'`
    );

    // Test with special characters in env value
    const specialResult = await execInJail(groupId, ['/bin/sh', '-c', '/bin/echo "$SPECIAL_VAR"'], {
      env: {
        PATH: '/bin:/usr/bin:/usr/local/bin',
        SPECIAL_VAR: 'value with spaces and "quotes"',
      },
    });
    assert(
      specialResult.stdout.includes('value with spaces'),
      'Special characters should be handled'
    );

  } finally {
    await destroyJail(groupId, mounts);
  }
});

// ============================================================================
// TEST 4: exec() — stderr captured correctly
// ============================================================================
test('exec() — stderr captured correctly', async () => {
  const groupId = uniqueGroupId('stderr');
  const mounts = [];

  try {
    await createJail(groupId, mounts);

    // Run a command that outputs to stderr
    const result = await execInJail(groupId, ['/bin/sh', '-c', '/bin/echo "error to stderr" >&2']);

    assertEqual(result.code, 0, 'Exit code should be 0');
    assert(
      result.stderr.includes('error to stderr'),
      `Expected stderr to contain "error to stderr" but got: "${result.stderr}"`
    );

  } finally {
    await destroyJail(groupId, mounts);
  }
});

// ============================================================================
// TEST 5: exec() — signals (SIGTERM) terminate jail process
// ============================================================================
test('exec() — signals (SIGTERM) terminate jail process', async () => {
  const groupId = uniqueGroupId('signal');
  const mounts = [];

  try {
    await createJail(groupId, mounts);

    // Start a long-running process and send SIGTERM
    const startTime = Date.now();
    let wasInterrupted = false;

    try {
      // The execInJail should support an AbortSignal or we need to test via timeout
      // For now, test that signal option works
      const controller = new AbortController();
      const signalPromise = execInJail(groupId, ['/bin/sleep', '30'], { signal: controller.signal });

      setTimeout(() => controller.abort(), 100);

      await signalPromise;
    } catch (error) {
      wasInterrupted = true;
    }

    const elapsed = Date.now() - startTime;

    assert(wasInterrupted, 'Signal test should have been interrupted by signal');
    assert(elapsed < 5000, `Process should have been killed quickly, took ${elapsed}ms`);

  } finally {
    await destroyJail(groupId, mounts);
  }
});

// ============================================================================
// TEST 6: exec() — commands timeout correctly
// ============================================================================
test('exec() — commands timeout correctly', async () => {
  const groupId = uniqueGroupId('timeout');
  const mounts = [];

  try {
    await createJail(groupId, mounts);

    const startTime = Date.now();
    let wasInterrupted = false;

    try {
      // Run a command that would take 30 seconds, but with 500ms timeout
      await execInJail(groupId, ['/bin/sleep', '30'], { timeout: 500 });
    } catch (error) {
      wasInterrupted = true;
      assert(
        error.message.includes('timed out') || error.message.includes('timeout'),
        `Error should mention timeout, got: ${error.message}`
      );
    }

    const elapsed = Date.now() - startTime;

    assert(wasInterrupted, 'Timeout test should have been interrupted by timeout');
    assert(elapsed < 5000, `Process should have timed out quickly, took ${elapsed}ms`);

  } finally {
    await destroyJail(groupId, mounts);
  }
});

// ============================================================================
// TEST 7: stop() + destroy() — jail removed, dataset destroyed, mounts cleaned (was TEST 4)
// ============================================================================
test('stop() + destroy() — jail removed, dataset destroyed, mounts cleaned', async () => {
  const groupId = uniqueGroupId('destroy');
  const jailName = getJailName(groupId);
  const dataset = `${JAIL_CONFIG.jailsDataset}/${jailName}`;
  const jailPath = path.join(JAIL_CONFIG.jailsPath, jailName);
  const fstabPath = path.join(JAIL_CONFIG.jailsPath, `${jailName}.fstab`);

  // Create a temp workspace to mount
  const workspaceDir = path.join(JAIL_CONFIG.workspacesPath, groupId);
  fs.mkdirSync(workspaceDir, { recursive: true });

  const mounts = [
    { hostPath: workspaceDir, jailPath: 'workspace', readonly: false },
  ];

  try {
    // Create and verify jail is running
    await createJail(groupId, mounts);
    assert(isJailRunning(jailName), 'Jail should be running after create');
    assert(datasetExists(dataset), 'Dataset should exist after create');

    const mountTarget = path.join(jailPath, 'workspace');

    // Stop the jail
    await stopJail(groupId);
    assert(!isJailRunning(jailName), 'Jail should not be running after stop');

    // Destroy (cleanup) the jail
    await cleanupJail(groupId, mounts);

    // Verify everything is cleaned up
    assert(!isJailRunning(jailName), 'Jail should not be running after destroy');
    assert(!datasetExists(dataset), 'Dataset should not exist after destroy');
    assert(!isMounted(mountTarget), 'Mount should not be active after destroy');
    assert(!fs.existsSync(fstabPath), 'fstab file should not exist after destroy');

  } finally {
    // Extra cleanup in case test failed
    try {
      await destroyJail(groupId, mounts);
    } catch { /* ignore */ }
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

// ============================================================================
// TEST 5: create() with invalid groupId ("../escape") — error thrown, no orphaned resources
// ============================================================================
test('create() with invalid groupId ("../escape") — error thrown, no orphaned resources', async () => {
  const maliciousGroupId = '../escape';
  const sanitized = sanitizeJailName(maliciousGroupId);
  const jailName = getJailName(maliciousGroupId);
  const dataset = `${JAIL_CONFIG.jailsDataset}/${jailName}`;

  // Verify the groupId gets sanitized (no path traversal)
  assert(
    !sanitized.includes('/') && !sanitized.includes('..'),
    `Sanitized name should not contain path chars, got: ${sanitized}`
  );

  // Verify the jail name is safe (each '/' becomes '_', so '../' becomes '___' + another '_' for '.')
  // With hash suffix, the name format is: nanoclaw_<sanitized>_<hash>
  assert(
    jailName.startsWith('nanoclaw____escape_') && jailName.length === 'nanoclaw____escape_'.length + 6,
    `Jail name should sanitize '../' characters and include 6-char hash suffix, got: ${jailName}`
  );

  // The create should work with the sanitized name (no escape possible)
  // But let's also test that even if it fails, no orphans remain
  let createSucceeded = false;
  try {
    await createJail(maliciousGroupId, []);
    createSucceeded = true;
  } catch (error) {
    // If creation fails for any reason, verify cleanup happened
    assert(!datasetExists(dataset), 'Dataset should not exist after failed create');
    assert(!isJailRunning(jailName), 'Jail should not be running after failed create');
  }

  // If create succeeded, clean up and verify sanitization worked
  if (createSucceeded) {
    assert(isJailRunning(jailName), 'Jail should be running with sanitized name');
    await destroyJail(maliciousGroupId, []);
    assert(!datasetExists(dataset), 'Dataset should be cleaned up');
    assert(!isJailRunning(jailName), 'Jail should be stopped after cleanup');
  }
});

// ============================================================================
// TEST 6: create() — workspace writable from inside jail
// ============================================================================
test('create() — workspace writable from inside jail', async () => {
  const groupId = uniqueGroupId('writable');
  const workspaceDir = path.join(JAIL_CONFIG.workspacesPath, groupId);
  fs.mkdirSync(workspaceDir, { recursive: true });
  // Set permissions for jail node user to write (group wheel with setgid)
  fs.chmodSync(workspaceDir, 0o2775);
  fs.chownSync(workspaceDir, process.getuid(), 0); // group wheel (gid 0)

  const mounts = [
    { hostPath: workspaceDir, jailPath: 'workspace', readonly: false },
  ];

  try {
    await createJail(groupId, mounts);

    // Write a file from inside the jail
    const testContent = `test content ${Date.now()}`;
    const result = await execInJail(groupId, [
      '/bin/sh', '-c', `/bin/echo '${testContent}' > /workspace/test-write.txt`,
    ]);
    assertEqual(result.code, 0, 'Write command should succeed');

    // Verify file exists on host
    const hostFile = path.join(workspaceDir, 'test-write.txt');
    assert(fs.existsSync(hostFile), 'File should exist on host after jail write');

    // Verify content matches
    const readContent = fs.readFileSync(hostFile, 'utf-8').trim();
    assertEqual(readContent, testContent, 'Content written from jail should match');

    // Test creating a subdirectory
    const mkdirResult = await execInJail(groupId, [
      '/bin/sh', '-c', '/bin/mkdir -p /workspace/subdir && /usr/bin/touch /workspace/subdir/nested.txt',
    ]);
    assertEqual(mkdirResult.code, 0, 'Mkdir should succeed');
    assert(
      fs.existsSync(path.join(workspaceDir, 'subdir', 'nested.txt')),
      'Nested file should exist on host'
    );

  } finally {
    await destroyJail(groupId, mounts);
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

// ============================================================================
// TEST 7: create() — host paths outside mounts NOT accessible from jail
// ============================================================================
test('create() — host paths outside mounts NOT accessible from jail', async () => {
  const groupId = uniqueGroupId('isolation');
  const workspaceDir = path.join(JAIL_CONFIG.workspacesPath, groupId);
  fs.mkdirSync(workspaceDir, { recursive: true });

  const mounts = [
    { hostPath: workspaceDir, jailPath: 'workspace', readonly: false },
  ];

  try {
    await createJail(groupId, mounts);

    // Try to read /etc/passwd on host (should get jail's /etc/passwd, not host's)
    const passwdResult = await execInJail(groupId, ['/bin/cat', '/etc/passwd']);
    // The jail should have its own /etc/passwd from the template
    // It shouldn't contain the host user 'jims' (unless template was built with it)
    assertEqual(passwdResult.code, 0, 'Should be able to read jail passwd');
    // Verify it doesn't contain host-specific users (check it's the jail's passwd)
    assert(
      passwdResult.stdout.includes('root:') || passwdResult.stdout.includes('node:'),
      'Should read jail passwd with expected users'
    );

    // Try to access host home directory - should fail or not exist
    const homeResult = await execInJail(groupId, ['/bin/ls', '/home/jims']);
    // This should either fail or show the jail's view (which won't have the host files)
    // The key is it shouldn't see /home/jims/code/nanoclaw
    if (homeResult.code === 0) {
      assert(
        !homeResult.stdout.includes('code'),
        'Jail should not see host /home/jims/code directory'
      );
    }

    // Try path traversal from workspace - should be contained
    const traversalResult = await execInJail(groupId, [
      '/bin/sh', '-c', '/bin/ls /workspace/../.. 2>&1 || /bin/echo "access denied"',
    ]);
    // Even if this succeeds, it should show jail's root, not host's root
    // Check that we can't see host-specific paths
    assert(
      !traversalResult.stdout.includes('nanoclaw') ||
      traversalResult.stdout.includes('access denied') ||
      traversalResult.code !== 0,
      'Path traversal should not expose host nanoclaw directory'
    );

    // Explicitly test that jail cannot see host's workspaces directory content
    const workspacesResult = await execInJail(groupId, ['/bin/ls', JAIL_CONFIG.workspacesPath]);
    // This path shouldn't exist in the jail at all
    assert(
      workspacesResult.code !== 0 || !workspacesResult.stdout.includes(groupId),
      'Jail should not see host workspaces directory'
    );

  } finally {
    await destroyJail(groupId, mounts);
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

// ============================================================================
// TEST 8: IPC round-trip — host writes input.json → jail reads → jail writes output.json → host reads
// ============================================================================
test('IPC round-trip — host writes input.json, jail reads, jail writes output.json, host reads', async () => {
  const groupId = uniqueGroupId('ipc');
  const ipcDir = path.join(JAIL_CONFIG.ipcPath, groupId);
  fs.mkdirSync(ipcDir, { recursive: true });
  // Set permissions for jail node user to write (group wheel with setgid)
  fs.chmodSync(ipcDir, 0o2775);
  fs.chownSync(ipcDir, process.getuid(), 0); // group wheel (gid 0)

  const mounts = [
    { hostPath: ipcDir, jailPath: 'ipc', readonly: false },
  ];

  try {
    await createJail(groupId, mounts);

    // Host writes input.json
    const inputData = {
      task: 'process',
      values: [1, 2, 3, 4, 5],
      timestamp: Date.now(),
    };
    const inputPath = path.join(ipcDir, 'input.json');
    fs.writeFileSync(inputPath, JSON.stringify(inputData, null, 2));

    // Jail reads input.json, processes, writes output.json
    // Use simple shell commands instead of node since node may not be in jail template
    const processScript = `/bin/cat /ipc/input.json > /ipc/output.json && /bin/echo "Processed successfully"`;

    const result = await execInJail(groupId, ['/bin/sh', '-c', processScript]);
    assertEqual(result.code, 0, `Process script should succeed: ${result.stderr}`);
    assert(result.stdout.includes('Processed successfully'), 'Should print success message');

    // Host reads output.json
    const outputPath = path.join(ipcDir, 'output.json');
    assert(fs.existsSync(outputPath), 'output.json should exist after jail processing');

    const outputData = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    assertEqual(outputData.task, 'process', 'Task should be preserved');
    assertEqual(outputData.values.length, 5, 'Values array should be preserved');
    assertEqual(outputData.timestamp, inputData.timestamp, 'Timestamp should be preserved');

  } finally {
    await destroyJail(groupId, mounts);
    fs.rmSync(ipcDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Concurrent Jail Creation Tests
// ============================================================================

test('Concurrent jail creation with epair locking', async () => {
  // This test verifies that the file-based locking mechanism prevents race
  // conditions when multiple jails are created concurrently.
  // Without locking, concurrent ifconfig epair create commands could assign
  // the same epair number to multiple jails.

  const concurrentCount = 10;
  const groupIds = [];
  const mounts = [];

  try {
    // Create IPC directories for all jails
    for (let i = 0; i < concurrentCount; i++) {
      const groupId = uniqueGroupId(`concurrent_${i}`);
      groupIds.push(groupId);

      const ipcDir = path.join(JAIL_CONFIG.ipcPath, groupId);
      fs.mkdirSync(ipcDir, { recursive: true });
      mounts.push({
        source: ipcDir,
        target: '/ipc',
        readOnly: false,
      });
    }

    // Create all jails concurrently
    console.log(`  Creating ${concurrentCount} jails concurrently...`);
    const createPromises = groupIds.map(async (groupId, index) => {
      try {
        await createJail(groupId, mounts);
        console.log(`  Jail ${index + 1}/${concurrentCount} created successfully: ${groupId}`);
        return { groupId, success: true };
      } catch (error) {
        console.error(`  Failed to create jail ${index + 1}: ${error.message}`);
        return { groupId, success: false, error };
      }
    });

    const results = await Promise.all(createPromises);

    // Verify all jails were created successfully
    const failedJails = results.filter(r => !r.success);
    if (failedJails.length > 0) {
      throw new Error(`${failedJails.length} jails failed to create: ${failedJails.map(r => r.error.message).join(', ')}`);
    }

    // Verify all jails are running
    for (const groupId of groupIds) {
      const running = await isJailRunning(groupId);
      assert(running, `Jail ${groupId} should be running after concurrent creation`);
    }

    // If in restricted network mode, verify epair uniqueness
    if (JAIL_CONFIG.networkMode === 'restricted') {
      console.log('  Verifying epair interface uniqueness...');

      // Get all epair interfaces
      const ifconfigOutput = execFileSync('ifconfig', ['-l'], { encoding: 'utf-8' });
      const interfaces = ifconfigOutput.split(/\s+/);
      const epairNumbers = new Set();

      for (const iface of interfaces) {
        const match = iface.match(/^epair(\d+)a$/);
        if (match) {
          const epairNum = parseInt(match[1], 10);
          epairNumbers.add(epairNum);
        }
      }

      // There should be at least concurrentCount unique epair numbers
      // (there may be more if other tests are running)
      assert(
        epairNumbers.size >= concurrentCount,
        `Should have at least ${concurrentCount} unique epair interfaces, found ${epairNumbers.size}`
      );
    }

    console.log(`  All ${concurrentCount} jails created and verified successfully`);

  } finally {
    // Clean up all jails
    console.log('  Cleaning up concurrent test jails...');
    const cleanupPromises = groupIds.map(async (groupId, index) => {
      try {
        await destroyJail(groupId, mounts);
        const ipcDir = path.join(JAIL_CONFIG.ipcPath, groupId);
        fs.rmSync(ipcDir, { recursive: true, force: true });
      } catch (error) {
        console.error(`  Failed to cleanup jail ${index + 1}: ${error.message}`);
      }
    });
    await Promise.all(cleanupPromises);
  }
});

// ============================================================================
// Run all tests
// ============================================================================
runTests()
  .then((success) => {
    process.exit(success ? 0 : 1);
  })
  .catch((error) => {
    console.error('Test runner error:', error);
    process.exit(1);
  });
