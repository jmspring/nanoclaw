import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { execFileSync } from 'child_process';
import {
  pollRctlMetrics,
  formatPrometheusMetrics,
  startRctlPolling,
  stopRctlPolling,
} from './jail/metrics.js';

describe('rctl metrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stopRctlPolling();
  });

  afterEach(() => {
    stopRctlPolling();
  });

  describe('pollRctlMetrics', () => {
    it('parses multi-jail rctl output correctly', async () => {
      const rctlOutput = [
        'jail:nanoclaw_group1_abc:memoryuse=167772160',
        'jail:nanoclaw_group1_abc:maxproc=12',
        'jail:nanoclaw_group1_abc:pcpu=23',
        'jail:nanoclaw_group1_abc:cputime=142',
        'jail:nanoclaw_group1_abc:wallclock=300',
        'jail:nanoclaw_group1_abc:openfiles=47',
        'jail:nanoclaw_group2_def:memoryuse=83886080',
        'jail:nanoclaw_group2_def:maxproc=5',
        'jail:nanoclaw_group2_def:pcpu=10',
        'jail:nanoclaw_group2_def:cputime=50',
        'jail:nanoclaw_group2_def:wallclock=120',
        'jail:nanoclaw_group2_def:openfiles=22',
      ].join('\n');

      vi.mocked(execFileSync).mockReturnValue(rctlOutput);

      await pollRctlMetrics();

      const output = formatPrometheusMetrics();
      expect(output).toContain(
        'nanoclaw_jail_memory_usage_bytes{jail="nanoclaw_group1_abc"} 167772160',
      );
      expect(output).toContain(
        'nanoclaw_jail_process_count{jail="nanoclaw_group2_def"} 5',
      );
      expect(output).toContain(
        'nanoclaw_jail_cpu_percent{jail="nanoclaw_group1_abc"} 23',
      );
      expect(output).toContain(
        'nanoclaw_jail_cputime_seconds_total{jail="nanoclaw_group1_abc"} 142',
      );
      expect(output).toContain(
        'nanoclaw_jail_wallclock_seconds_total{jail="nanoclaw_group2_def"} 120',
      );
      expect(output).toContain(
        'nanoclaw_jail_open_files{jail="nanoclaw_group1_abc"} 47',
      );
    });

    it('handles empty output gracefully', async () => {
      vi.mocked(execFileSync).mockReturnValue('');

      await pollRctlMetrics();

      const output = formatPrometheusMetrics();
      // Headers should still be present
      expect(output).toContain('# HELP nanoclaw_jail_memory_usage_bytes');
      // But no data lines
      expect(output).not.toContain('{jail=');
    });

    it('handles rctl not available (command fails)', async () => {
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('rctl: not available');
      });

      // Should not throw
      await pollRctlMetrics();

      const output = formatPrometheusMetrics();
      expect(output).toContain('# HELP nanoclaw_jail_memory_usage_bytes');
      expect(output).not.toContain('{jail=');
    });

    it('filters out non-nanoclaw jails', async () => {
      const rctlOutput = [
        'jail:otherjail:memoryuse=100',
        'jail:nanoclaw_mygroup_abc:memoryuse=200',
      ].join('\n');

      vi.mocked(execFileSync).mockReturnValue(rctlOutput);

      await pollRctlMetrics();

      const output = formatPrometheusMetrics();
      expect(output).not.toContain('otherjail');
      expect(output).toContain('nanoclaw_mygroup_abc');
    });
  });

  describe('formatPrometheusMetrics', () => {
    it('includes existing metrics unchanged', () => {
      const output = formatPrometheusMetrics();
      expect(output).toContain('# HELP nanoclaw_active_jails');
      expect(output).toContain('# HELP nanoclaw_jail_create_total');
      expect(output).toContain('# HELP nanoclaw_epair_used');
      expect(output).toContain('# HELP nanoclaw_zfs_pool_bytes_avail');
    });

    it('emits rctl metric headers even with no data', () => {
      const output = formatPrometheusMetrics();
      expect(output).toContain('# HELP nanoclaw_jail_memory_usage_bytes');
      expect(output).toContain('# TYPE nanoclaw_jail_memory_usage_bytes gauge');
      expect(output).toContain('# HELP nanoclaw_jail_process_count');
      expect(output).toContain('# TYPE nanoclaw_jail_process_count gauge');
      expect(output).toContain('# HELP nanoclaw_jail_cpu_percent');
      expect(output).toContain('# TYPE nanoclaw_jail_cpu_percent gauge');
      expect(output).toContain('# HELP nanoclaw_jail_cputime_seconds_total');
      expect(output).toContain(
        '# TYPE nanoclaw_jail_cputime_seconds_total counter',
      );
      expect(output).toContain('# HELP nanoclaw_jail_wallclock_seconds_total');
      expect(output).toContain(
        '# TYPE nanoclaw_jail_wallclock_seconds_total counter',
      );
      expect(output).toContain('# HELP nanoclaw_jail_open_files');
      expect(output).toContain('# TYPE nanoclaw_jail_open_files gauge');
    });
  });

  describe('rctl polling lifecycle', () => {
    it('startRctlPolling calls pollRctlMetrics immediately', () => {
      vi.mocked(execFileSync).mockReturnValue('');
      startRctlPolling(60000);
      expect(execFileSync).toHaveBeenCalledWith(
        'sudo',
        ['rctl', '-u', 'jail:'],
        expect.any(Object),
      );
      stopRctlPolling();
    });

    it('stopRctlPolling clears the interval', () => {
      vi.mocked(execFileSync).mockReturnValue('');
      startRctlPolling(60000);
      stopRctlPolling();
      // Starting again should work (interval was cleared)
      startRctlPolling(60000);
      stopRctlPolling();
    });
  });
});
