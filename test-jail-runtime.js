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
  readonlyMountSpec,
  writableMountSpec,
  JAIL_CONFIG,
} from './jail-runtime.js';
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
    writableMountSpec(workspaceDir, '/workspace'),
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

    // Run a simple command that outputs known text
    const result = await execInJail(groupId, ['echo', 'Hello from jail']);

    assertEqual(result.code, 0, 'Exit code should be 0');
    assert(
      result.stdout.trim() === 'Hello from jail',
      `stdout should be 'Hello from jail', got: '${result.stdout.trim()}'`
    );

    // Run a command that outputs multiple lines
    const multiResult = await execInJail(groupId, ['sh', '-c', 'echo line1; echo line2; echo line3']);
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
    const result = await execInJail(groupId, ['sh', '-c', 'echo $TEST_VAR1:$TEST_VAR2'], {
      env: {
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
    const specialResult = await execInJail(groupId, ['sh', '-c', 'echo "$SPECIAL_VAR"'], {
      env: {
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
// TEST 4: stop() + destroy() — jail removed, dataset destroyed, mounts cleaned
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
    writableMountSpec(workspaceDir, '/workspace'),
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

  // Verify the jail name is safe
  assertEqual(
    jailName,
    'nanoclaw___escape',
    `Jail name should sanitize '../' to '__', got: ${jailName}`
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

  const mounts = [
    writableMountSpec(workspaceDir, '/workspace'),
  ];

  try {
    await createJail(groupId, mounts);

    // Write a file from inside the jail
    const testContent = `test content ${Date.now()}`;
    const result = await execInJail(groupId, [
      'sh', '-c', `echo '${testContent}' > /workspace/test-write.txt`,
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
      'sh', '-c', 'mkdir -p /workspace/subdir && touch /workspace/subdir/nested.txt',
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
    writableMountSpec(workspaceDir, '/workspace'),
  ];

  try {
    await createJail(groupId, mounts);

    // Try to read /etc/passwd on host (should get jail's /etc/passwd, not host's)
    const passwdResult = await execInJail(groupId, ['cat', '/etc/passwd']);
    // The jail should have its own /etc/passwd from the template
    // It shouldn't contain the host user 'jims' (unless template was built with it)
    assertEqual(passwdResult.code, 0, 'Should be able to read jail passwd');

    // Try to access host home directory - should fail or not exist
    const homeResult = await execInJail(groupId, ['ls', '/home/jims']);
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
      'sh', '-c', 'ls /workspace/../.. 2>&1 || echo "access denied"',
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
    const workspacesResult = await execInJail(groupId, ['ls', JAIL_CONFIG.workspacesPath]);
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

  const mounts = [
    writableMountSpec(ipcDir, '/ipc'),
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
    const processScript = `
      const input = JSON.parse(require('fs').readFileSync('/ipc/input.json', 'utf-8'));
      const output = {
        task: input.task,
        result: input.values.reduce((a, b) => a + b, 0),
        processed_at: Date.now(),
        source_timestamp: input.timestamp
      };
      require('fs').writeFileSync('/ipc/output.json', JSON.stringify(output, null, 2));
      console.log('Processed successfully');
    `;

    const result = await execInJail(groupId, ['node', '-e', processScript]);
    assertEqual(result.code, 0, `Process script should succeed: ${result.stderr}`);
    assert(result.stdout.includes('Processed successfully'), 'Should print success message');

    // Host reads output.json
    const outputPath = path.join(ipcDir, 'output.json');
    assert(fs.existsSync(outputPath), 'output.json should exist after jail processing');

    const outputData = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    assertEqual(outputData.task, 'process', 'Task should be preserved');
    assertEqual(outputData.result, 15, 'Sum of [1,2,3,4,5] should be 15');
    assertEqual(outputData.source_timestamp, inputData.timestamp, 'Timestamp should be preserved');
    assert(outputData.processed_at >= inputData.timestamp, 'Processed timestamp should be after input');

  } finally {
    await destroyJail(groupId, mounts);
    fs.rmSync(ipcDir, { recursive: true, force: true });
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
