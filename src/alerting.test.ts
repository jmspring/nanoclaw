import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

vi.mock('fs');
vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('./config.js', () => ({
  DATA_DIR: '/test/data',
}));

import {
  AlertManager,
  createChannelSink,
  createLogSink,
  type AlertSink,
} from './alerting.js';
import { logger } from './logger.js';

describe('AlertManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('fires to all registered sinks', async () => {
    const manager = new AlertManager();
    const sink1: AlertSink = { name: 'sink1', send: vi.fn() };
    const sink2: AlertSink = { name: 'sink2', send: vi.fn() };
    manager.registerSink(sink1);
    manager.registerSink(sink2);

    await manager.fire('warning', 'agent', 'test alert');

    expect(sink1.send).toHaveBeenCalledTimes(1);
    expect(sink2.send).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sink1.send).mock.calls[0][0]).toMatchObject({
      severity: 'warning',
      category: 'agent',
      title: 'test alert',
    });
  });

  it('deduplicates repeated alerts within the window', async () => {
    vi.useFakeTimers();
    const manager = new AlertManager({ dedupeWindowMs: 60000 });
    const sink: AlertSink = { name: 'test', send: vi.fn() };
    manager.registerSink(sink);

    await manager.fire('warning', 'storage', 'ZFS pool low');
    await manager.fire('warning', 'storage', 'ZFS pool low');

    expect(sink.send).toHaveBeenCalledTimes(1);
  });

  it('allows alerts after the dedupe window expires', async () => {
    vi.useFakeTimers();
    const manager = new AlertManager({ dedupeWindowMs: 60000 });
    const sink: AlertSink = { name: 'test', send: vi.fn() };
    manager.registerSink(sink);

    await manager.fire('warning', 'storage', 'ZFS pool low');
    vi.advanceTimersByTime(61000);
    await manager.fire('warning', 'storage', 'ZFS pool low');

    expect(sink.send).toHaveBeenCalledTimes(2);
  });

  it('does not deduplicate different alerts', async () => {
    const manager = new AlertManager();
    const sink: AlertSink = { name: 'test', send: vi.fn() };
    manager.registerSink(sink);

    await manager.fire('warning', 'storage', 'ZFS pool low');
    await manager.fire('critical', 'security', 'integrity mismatch');

    expect(sink.send).toHaveBeenCalledTimes(2);
  });

  it('continues to other sinks when one fails', async () => {
    const manager = new AlertManager();
    const failingSink: AlertSink = {
      name: 'failing',
      send: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const workingSink: AlertSink = { name: 'working', send: vi.fn() };
    manager.registerSink(failingSink);
    manager.registerSink(workingSink);

    await manager.fire('warning', 'agent', 'test');

    expect(failingSink.send).toHaveBeenCalledTimes(1);
    expect(workingSink.send).toHaveBeenCalledTimes(1);
  });

  it('always logs via pino even with no sinks', async () => {
    const manager = new AlertManager();

    await manager.fire('critical', 'security', 'test alert');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        alert: expect.objectContaining({ severity: 'critical' }),
      }),
      expect.stringContaining('[CRITICAL]'),
    );
  });

  it('removes sinks by name', async () => {
    const manager = new AlertManager();
    const sink: AlertSink = { name: 'removable', send: vi.fn() };
    manager.registerSink(sink);
    manager.removeSink('removable');

    await manager.fire('info', 'agent', 'test');

    expect(sink.send).not.toHaveBeenCalled();
  });
});

describe('createChannelSink', () => {
  it('formats messages with severity prefix', async () => {
    const sendFn = vi.fn();
    const sink = createChannelSink(sendFn);

    await sink.send({
      severity: 'critical',
      category: 'security',
      title: "CLAUDE.md tampered in group 'work'",
      timestamp: new Date().toISOString(),
    });

    expect(sendFn).toHaveBeenCalledWith(
      expect.stringContaining(
        "[CRITICAL] security: CLAUDE.md tampered in group 'work'",
      ),
    );
  });

  it('includes detail when present', async () => {
    const sendFn = vi.fn();
    const sink = createChannelSink(sendFn);

    await sink.send({
      severity: 'warning',
      category: 'agent',
      title: 'Failures detected',
      detail: '3 consecutive failures',
      timestamp: new Date().toISOString(),
    });

    const msg = vi.mocked(sendFn).mock.calls[0][0];
    expect(msg).toContain('[WARNING]');
    expect(msg).toContain('3 consecutive failures');
  });
});

describe('createLogSink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('appends JSON to file', async () => {
    const sink = createLogSink('/test/alerts.log');

    await sink.send({
      severity: 'info',
      category: 'agent',
      title: 'test',
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    expect(vi.mocked(fs.appendFileSync)).toHaveBeenCalledWith(
      '/test/alerts.log',
      expect.stringContaining('"severity":"info"'),
    );
  });

  it('creates directory if needed', async () => {
    const sink = createLogSink('/test/data/alerts.log');

    await sink.send({
      severity: 'info',
      category: 'agent',
      title: 'test',
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith('/test/data', {
      recursive: true,
    });
  });
});
