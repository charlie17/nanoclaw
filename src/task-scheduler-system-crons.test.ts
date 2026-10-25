import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { computeNextRun } from './task-scheduler.js';

// Mirrors the VPS, where TIMEZONE resolves to UTC, so host-installed system
// tasks (schedule_tz NULL) are pinned independently of the test machine's zone.
vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  TIMEZONE: 'UTC',
}));

vi.mock('./container-runner.js', () => ({
  runContainerAgent: vi.fn(),
  writeTasksSnapshot: vi.fn(),
}));

const systemTask = (schedule_value: string) => ({
  id: 'daystrom-system-task',
  group_folder: 'daystrom',
  chat_jid: 'tg:1',
  prompt: 'system',
  schedule_type: 'cron' as const,
  schedule_value,
  schedule_tz: null,
  context_mode: 'isolated' as const,
  next_run: null,
  last_run: null,
  last_result: null,
  status: 'active' as const,
  created_at: '2026-01-01T00:00:00.000Z',
});

describe('live system cron values (schedule_tz NULL, TIMEZONE UTC)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('next runs land on their authored UTC times', () => {
    vi.setSystemTime(new Date('2026-10-23T12:00:00.000Z')); // Friday
    expect(computeNextRun(systemTask('0 5 * * *'))).toBe(
      '2026-10-24T05:00:00.000Z',
    );
    expect(computeNextRun(systemTask('30 5 * * 6'))).toBe(
      '2026-10-24T05:30:00.000Z',
    );
    expect(computeNextRun(systemTask('0 6 * * *'))).toBe(
      '2026-10-24T06:00:00.000Z',
    );
    expect(computeNextRun(systemTask('15 6 * * *'))).toBe(
      '2026-10-24T06:15:00.000Z',
    );
    expect(computeNextRun(systemTask('30 9 * * *'))).toBe(
      '2026-10-24T09:30:00.000Z',
    );
  });

  it('US DST changes do not move them', () => {
    vi.setSystemTime(new Date('2026-11-01T00:00:00.000Z')); // Sunday, fall-back day
    expect(computeNextRun(systemTask('0 5 * * *'))).toBe(
      '2026-11-01T05:00:00.000Z',
    );
    expect(computeNextRun(systemTask('30 5 * * 6'))).toBe(
      '2026-11-07T05:30:00.000Z',
    );
    expect(computeNextRun(systemTask('0 6 * * *'))).toBe(
      '2026-11-01T06:00:00.000Z',
    );
    expect(computeNextRun(systemTask('15 6 * * *'))).toBe(
      '2026-11-01T06:15:00.000Z',
    );
    expect(computeNextRun(systemTask('30 9 * * *'))).toBe(
      '2026-11-01T09:30:00.000Z',
    );
  });
});
