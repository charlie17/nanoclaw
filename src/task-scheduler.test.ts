import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, createTask, getTaskById } from './db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  startSchedulerLoop,
} from './task-scheduler.js';

vi.mock('./container-runner.js', () => ({
  runContainerAgent: vi.fn(),
  writeTasksSnapshot: vi.fn(),
}));

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });

  describe('backfill missing next_run on startup', () => {
    it('populates next_run for active cron tasks that have NULL next_run', async () => {
      // Insert a cron task with NULL next_run (simulates a manual SQL INSERT
      // path that bypassed the IPC handler's CronExpressionParser computation
      // — exact pattern that left wiki-lint + moc-refresh dormant from
      // 2026-04-30 deploy until 2026-05-03 diagnosis).
      createTask({
        id: 'broken-cron-task',
        group_folder: 'daystrom',
        chat_jid: 'tg:8669367924',
        prompt: '/wiki-lint',
        schedule_type: 'cron',
        schedule_value: '0 6 * * *',
        context_mode: 'isolated',
        next_run: null as unknown as string, // simulating NULL in DB
        status: 'active',
        created_at: new Date().toISOString(),
      });

      // Sanity: row exists with null next_run.
      const before = getTaskById('broken-cron-task');
      expect(before?.next_run).toBeFalsy();

      // Start the scheduler — backfill runs synchronously at startup.
      const mockQueue = {
        enqueueTask: vi.fn(),
      } as unknown as Parameters<typeof startSchedulerLoop>[0]['queue'];
      startSchedulerLoop({
        registeredGroups: () => ({}),
        getSessions: () => ({}),
        queue: mockQueue,
        onProcess: () => {},
        sendMessage: async () => {},
      });

      // After backfill: next_run should be populated with a valid future
      // ISO timestamp matching the cron expression's next occurrence.
      const after = getTaskById('broken-cron-task');
      expect(after?.next_run).toBeTruthy();
      expect(new Date(after!.next_run!).getTime()).toBeGreaterThan(Date.now());
    });

    it('leaves once-tasks alone (only fills cron tasks)', async () => {
      // Once-tasks with NULL next_run shouldn't be backfilled — computeNextRun
      // returns null for once-tasks by design.
      createTask({
        id: 'once-no-nextrun',
        group_folder: 'daystrom',
        chat_jid: 'tg:8669367924',
        prompt: 'test',
        schedule_type: 'once',
        schedule_value: '2026-12-31T00:00:00.000Z',
        context_mode: 'isolated',
        next_run: null as unknown as string,
        status: 'active',
        created_at: new Date().toISOString(),
      });

      const mockQueue = {
        enqueueTask: vi.fn(),
      } as unknown as Parameters<typeof startSchedulerLoop>[0]['queue'];
      startSchedulerLoop({
        registeredGroups: () => ({}),
        getSessions: () => ({}),
        queue: mockQueue,
        onProcess: () => {},
        sendMessage: async () => {},
      });

      const after = getTaskById('once-no-nextrun');
      expect(after?.next_run).toBeFalsy();
    });
  });

  describe('system-task retry policy', () => {
    const makeSystemTask = (id = 'daystrom-test-task') => {
      createTask({
        id,
        group_folder: 'daystrom',
        chat_jid: 'tg:8669367924',
        prompt: '/nightly-report',
        schedule_type: 'cron',
        schedule_value: '0 5 * * *',
        context_mode: 'isolated',
        next_run: new Date(Date.now() - 1000).toISOString(),
        status: 'active',
        created_at: new Date().toISOString(),
      });
    };

    const makeUserTask = (id = 'task-user-remind-1') => {
      createTask({
        id,
        group_folder: 'daystrom',
        chat_jid: 'tg:8669367924',
        prompt: '/remind test',
        schedule_type: 'once',
        schedule_value: new Date(Date.now() - 1000).toISOString(),
        context_mode: 'isolated',
        next_run: new Date(Date.now() - 1000).toISOString(),
        status: 'active',
        created_at: new Date().toISOString(),
      });
    };

    const makeDeps = () => ({
      registeredGroups: () => ({
        'tg:8669367924': {
          jid: 'tg:8669367924',
          name: 'Daystrom',
          folder: 'daystrom',
          triggerPattern: '@Daystrom',
          requiresTrigger: false,
          isMain: true,
          containerConfig: {},
        } as any,
      }),
      getSessions: () => ({}),
      queue: {
        enqueueTask: vi.fn(
          (_jid: string, _taskId: string, fn: () => Promise<void>) => {
            void fn();
          },
        ),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      onProcess: vi.fn(),
      sendMessage: vi.fn(async () => {}),
    });

    it('system task error → retry scheduled at now+120s, does not advance cron', async () => {
      const { runContainerAgent } = await import('./container-runner.js');
      vi.mocked(runContainerAgent).mockResolvedValue({
        status: 'error',
        error: 'Container exited with code 137',
        result: null,
      });
      makeSystemTask();
      startSchedulerLoop(makeDeps() as any);
      await vi.advanceTimersByTimeAsync(50);

      const task = getTaskById('daystrom-test-task');
      expect(task?.retry_count).toBe(1);
      const nextRun = new Date(task!.next_run!).getTime();
      const expected = Date.now() + 120_000;
      expect(Math.abs(nextRun - expected)).toBeLessThan(5000);
    });

    it('system task retry failure → retry_count resets, next_run advances to cron', async () => {
      const { runContainerAgent } = await import('./container-runner.js');
      vi.mocked(runContainerAgent).mockResolvedValue({
        status: 'error',
        error: 'Container exited with code 137',
        result: null,
      });
      makeSystemTask('daystrom-double-fail');
      startSchedulerLoop(makeDeps() as any);
      await vi.advanceTimersByTimeAsync(50);

      const afterFirst = getTaskById('daystrom-double-fail');
      expect(afterFirst?.retry_count).toBe(1);

      // Simulate retry tick: reset loop, manually set next_run to past, fire again
      _resetSchedulerLoopForTests();
      // The scheduler reads next_run from DB; advance time past the retry window
      await vi.advanceTimersByTimeAsync(121_000);
      await vi.advanceTimersByTimeAsync(50);

      const afterSecond = getTaskById('daystrom-double-fail');
      expect(afterSecond?.retry_count ?? 0).toBe(0);
      // next_run should now be a future cron fire, not another +120s
      const nextRun = new Date(afterSecond!.next_run!).getTime();
      expect(nextRun).toBeGreaterThan(Date.now() + 60_000);
    });

    it('user /remind task error → no retry, once-task completes', async () => {
      const { runContainerAgent } = await import('./container-runner.js');
      vi.mocked(runContainerAgent).mockResolvedValue({
        status: 'error',
        error: 'Some error',
        result: null,
      });
      makeUserTask();
      startSchedulerLoop(makeDeps() as any);
      await vi.advanceTimersByTimeAsync(50);

      const task = getTaskById('task-user-remind-1');
      expect(task?.retry_count ?? 0).toBe(0);
      expect(task?.status).toBe('completed');
    });

    it('system task success → no retry, retry_count stays 0, next_run advances to cron', async () => {
      const { runContainerAgent } = await import('./container-runner.js');
      vi.mocked(runContainerAgent).mockResolvedValue({
        status: 'success',
        result: 'Done',
      });
      makeSystemTask('daystrom-success-task');
      startSchedulerLoop(makeDeps() as any);
      await vi.advanceTimersByTimeAsync(50);

      const task = getTaskById('daystrom-success-task');
      expect(task?.retry_count ?? 0).toBe(0);
      const nextRun = new Date(task!.next_run!).getTime();
      expect(nextRun).toBeGreaterThan(Date.now() + 60_000);
    });

    it('non-system task success → retry_count stays 0', async () => {
      const { runContainerAgent } = await import('./container-runner.js');
      vi.mocked(runContainerAgent).mockResolvedValue({
        status: 'success',
        result: 'Done',
      });
      makeUserTask('task-user-success-1');
      startSchedulerLoop(makeDeps() as any);
      await vi.advanceTimersByTimeAsync(50);

      const task = getTaskById('task-user-success-1');
      expect(task?.retry_count ?? 0).toBe(0);
    });

    it('system task first failure → last_run + last_result reflect failed attempt (SF-5)', async () => {
      const { runContainerAgent } = await import('./container-runner.js');
      vi.mocked(runContainerAgent).mockResolvedValue({
        status: 'error',
        error: 'Container exited with code 137',
        result: null,
      });
      makeSystemTask('daystrom-sf5-task');
      startSchedulerLoop(makeDeps() as any);
      await vi.advanceTimersByTimeAsync(50);

      const task = getTaskById('daystrom-sf5-task');
      expect(task?.retry_count).toBe(1);
      expect(task?.last_run).not.toBeNull();
      expect(task?.last_result).toBe('Error: Container exited with code 137');
    });

    it('system task with interval schedule → no retry on error (SF-6)', async () => {
      const { runContainerAgent } = await import('./container-runner.js');
      vi.mocked(runContainerAgent).mockResolvedValue({
        status: 'error',
        error: 'Some error',
        result: null,
      });
      createTask({
        id: 'daystrom-interval-task',
        group_folder: 'daystrom',
        chat_jid: 'tg:8669367924',
        prompt: '/some-skill',
        schedule_type: 'interval',
        schedule_value: '3600000',
        context_mode: 'isolated',
        next_run: new Date(Date.now() - 1000).toISOString(),
        status: 'active',
        created_at: new Date().toISOString(),
      });
      startSchedulerLoop(makeDeps() as any);
      await vi.advanceTimersByTimeAsync(50);

      const task = getTaskById('daystrom-interval-task');
      // Interval tasks must NOT retry — retry_count stays 0
      expect(task?.retry_count ?? 0).toBe(0);
      // next_run should be the next interval fire (not now+120s)
      const nextRun = new Date(task!.next_run!).getTime();
      expect(nextRun).toBeGreaterThan(Date.now() + 60_000);
    });
  });
});
