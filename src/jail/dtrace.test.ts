import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import { EventEmitter } from 'events';

vi.mock('child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('child_process')>();
  return {
    ...orig,
    execFileSync: vi.fn(),
    spawn: vi.fn(),
  };
});
vi.mock('fs');
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  isDTraceAvailable,
  listAvailableScripts,
  startTrace,
  stopTrace,
} from './dtrace.js';
import { spawn } from 'child_process';

function createMockProcess(): EventEmitter & {
  pid: number;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
  stdout: EventEmitter;
  stderr: EventEmitter;
} {
  const proc = new EventEmitter() as EventEmitter & {
    pid: number;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.pid = 12345;
  proc.killed = false;
  proc.kill = vi.fn();
  proc.stdout = new EventEmitter();
  (proc.stdout as NodeJS.ReadableStream).pipe = vi.fn();
  proc.stderr = new EventEmitter();
  (proc.stderr as NodeJS.ReadableStream).on = vi.fn().mockReturnThis();
  return proc;
}

describe('isDTraceAvailable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false when dtrace binary not found', () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('not found');
    });

    expect(isDTraceAvailable()).toBe(false);
  });

  it('returns true when dtrace binary exists', () => {
    vi.mocked(execFileSync).mockReturnValue('/usr/sbin/dtrace\n');

    expect(isDTraceAvailable()).toBe(true);
  });
});

describe('listAvailableScripts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns script names from etc/dtrace/', () => {
    (
      vi.mocked(fs.readdirSync) as unknown as ReturnType<typeof vi.fn>
    ).mockReturnValue([
      'nanoclaw-io.d',
      'nanoclaw-net.d',
      'nanoclaw-proc.d',
      'README.md',
    ]);

    const scripts = listAvailableScripts();

    expect(scripts).toEqual([
      'nanoclaw-io.d',
      'nanoclaw-net.d',
      'nanoclaw-proc.d',
    ]);
  });

  it('returns empty array when directory does not exist', () => {
    vi.mocked(fs.readdirSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(listAvailableScripts()).toEqual([]);
  });
});

describe('startTrace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when DTrace is unavailable', () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('not found');
    });

    const session = startTrace(5, 'nanoclaw-io.d', '/tmp/logs');

    expect(session).toBeNull();
  });

  it('spawns dtrace with correct arguments', () => {
    vi.mocked(execFileSync).mockReturnValue('/usr/sbin/dtrace\n');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.createWriteStream).mockReturnValue({} as fs.WriteStream);

    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(
      mockProc as unknown as ReturnType<typeof spawn>,
    );

    const session = startTrace(5, 'nanoclaw-io.d', '/tmp/logs');

    expect(session).not.toBeNull();
    expect(session!.jailId).toBe(5);
    expect(session!.script).toBe('nanoclaw-io.d');
    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      'sudo',
      expect.arrayContaining([
        'dtrace',
        '-s',
        expect.stringContaining('nanoclaw-io.d'),
        '-D',
        'jailid=5',
      ]),
      expect.any(Object),
    );
  });

  it('passes jail ID as DTrace macro variable', () => {
    vi.mocked(execFileSync).mockReturnValue('/usr/sbin/dtrace\n');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.createWriteStream).mockReturnValue({} as fs.WriteStream);

    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(
      mockProc as unknown as ReturnType<typeof spawn>,
    );

    startTrace(42, 'nanoclaw-net.d', '/tmp/logs');

    const spawnArgs = vi.mocked(spawn).mock.calls[0][1];
    expect(spawnArgs).toContain('-D');
    expect(spawnArgs).toContain('jailid=42');
  });
});

describe('stopTrace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends SIGINT and waits for exit', async () => {
    const mockProc = createMockProcess();
    const session = {
      jailId: 5,
      script: 'nanoclaw-io.d',
      proc: mockProc as unknown as import('child_process').ChildProcess,
      outputPath: '/tmp/logs/dtrace-io-5.log',
    };

    mockProc.kill.mockImplementation(() => {
      process.nextTick(() => mockProc.emit('exit', 0));
      return true;
    });

    const result = await stopTrace(session);

    expect(mockProc.kill).toHaveBeenCalledWith('SIGINT');
    expect(result).toBe('/tmp/logs/dtrace-io-5.log');
  });

  it('handles already-killed process', async () => {
    const mockProc = createMockProcess();
    mockProc.killed = true;
    const session = {
      jailId: 5,
      script: 'nanoclaw-io.d',
      proc: mockProc as unknown as import('child_process').ChildProcess,
      outputPath: '/tmp/logs/dtrace-io-5.log',
    };

    const result = await stopTrace(session);

    expect(result).toBe('/tmp/logs/dtrace-io-5.log');
    expect(mockProc.kill).not.toHaveBeenCalled();
  });
});
