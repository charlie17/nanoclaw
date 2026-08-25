import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';

// Mock config to control concurrency limit
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  MAX_CONCURRENT_CONTAINERS: 2,
}));

// Mock fs operations used by sendMessage/closeStdin
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
    },
  };
});

// Mock container-runtime so the FU-30 closeStdin watchdog's stopContainer call
// is observable without invoking the real docker CLI.
// Impl-75 D1: isNoSuchContainerError is deliberately the REAL implementation —
// the watchdogs' alert/no-alert decision hinges on it, so a stub would test
// nothing. Only stopContainer is faked.
vi.mock('./container-runtime.js', async () => {
  const actual = await vi.importActual<typeof import('./container-runtime.js')>(
    './container-runtime.js',
  );
  return {
    ...actual,
    stopContainer: vi.fn(),
  };
});

describe('GroupQueue', () => {
  let queue: GroupQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new GroupQueue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Single group at a time ---

  it('only runs one container per group at a time', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const processMessages = vi.fn(async (_groupJid: string) => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      // Simulate async work
      await new Promise((resolve) => setTimeout(resolve, 100));
      concurrentCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue two messages for the same group
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');

    // Advance timers to let the first process complete
    await vi.advanceTimersByTimeAsync(200);

    // Second enqueue should have been queued, not concurrent
    expect(maxConcurrent).toBe(1);
  });

  // --- Global concurrency limit ---

  it('respects global concurrency limit', async () => {
    let activeCount = 0;
    let maxActive = 0;
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (_groupJid: string) => {
      activeCount++;
      maxActive = Math.max(maxActive, activeCount);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      activeCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue 3 groups (limit is 2)
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');

    // Let promises settle
    await vi.advanceTimersByTimeAsync(10);

    // Only 2 should be active (MAX_CONCURRENT_CONTAINERS = 2)
    expect(maxActive).toBe(2);
    expect(activeCount).toBe(2);

    // Complete one — third should start
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processMessages).toHaveBeenCalledTimes(3);
  });

  // --- Tasks prioritized over messages ---

  it('drains tasks before messages for same group', async () => {
    const executionOrder: string[] = [];
    let resolveFirst: () => void;

    const processMessages = vi.fn(async (_groupJid: string) => {
      if (executionOrder.length === 0) {
        // First call: block until we release it
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      executionOrder.push('messages');
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing messages (takes the active slot)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // While active, enqueue both a task and pending messages
    const taskFn = vi.fn(async () => {
      executionOrder.push('task');
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    queue.enqueueMessageCheck('group1@g.us');

    // Release the first processing
    resolveFirst!();
    await vi.advanceTimersByTimeAsync(10);

    // Task should have run before the second message check
    expect(executionOrder[0]).toBe('messages'); // first call
    expect(executionOrder[1]).toBe('task'); // task runs first in drain
    // Messages would run after task completes
  });

  // --- Retry with backoff on failure ---

  it('retries with exponential backoff on failure', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // failure
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // First call happens immediately
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // First retry after 5000ms (BASE_RETRY_MS * 2^0)
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(2);

    // Second retry after 10000ms (BASE_RETRY_MS * 2^1)
    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(3);
  });

  // --- Shutdown prevents new enqueues ---

  it('prevents new enqueues after shutdown', async () => {
    const processMessages = vi.fn(async () => true);
    queue.setProcessMessagesFn(processMessages);

    await queue.shutdown(1000);

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(100);

    expect(processMessages).not.toHaveBeenCalled();
  });

  // --- Max retries exceeded ---

  it('stops retrying after MAX_RETRIES and resets', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // always fail
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // Run through all 5 retries (MAX_RETRIES = 5)
    // Initial call
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // Retry 1: 5000ms, Retry 2: 10000ms, Retry 3: 20000ms, Retry 4: 40000ms, Retry 5: 80000ms
    const retryDelays = [5000, 10000, 20000, 40000, 80000];
    for (let i = 0; i < retryDelays.length; i++) {
      await vi.advanceTimersByTimeAsync(retryDelays[i] + 10);
      expect(callCount).toBe(i + 2);
    }

    // After 5 retries (6 total calls), should stop — no more retries
    const countAfterMaxRetries = callCount;
    await vi.advanceTimersByTimeAsync(200000); // Wait a long time
    expect(callCount).toBe(countAfterMaxRetries);
  });

  // --- Waiting groups get drained when slots free up ---

  it('drains waiting groups when active slots free up', async () => {
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      processed.push(groupJid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill both slots
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Queue a third
    queue.enqueueMessageCheck('group3@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(['group1@g.us', 'group2@g.us']);

    // Free up a slot
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toContain('group3@g.us');
  });

  // --- Running task dedup (Issue #138) ---

  it('rejects duplicate enqueue of a currently-running task', async () => {
    let resolveTask: () => void;
    let taskCallCount = 0;

    const taskFn = vi.fn(async () => {
      taskCallCount++;
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    // Start the task (runs immediately — slot available)
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    expect(taskCallCount).toBe(1);

    // Scheduler poll re-discovers the same task while it's running —
    // this must be silently dropped
    const dupFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', dupFn);
    await vi.advanceTimersByTimeAsync(10);

    // Duplicate was NOT queued
    expect(dupFn).not.toHaveBeenCalled();

    // Complete the original task
    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);

    // Only one execution total
    expect(taskCallCount).toBe(1);
  });

  // --- Idle preemption ---

  it('does NOT preempt active container when not idle', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing (takes the active slot)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register a process so closeStdin has a groupFolder
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );

    // Enqueue a task while container is active but NOT idle
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    // _close should NOT have been written (container is working, not idle)
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('preempts idle container when task is enqueued', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register process and mark idle
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );
    queue.notifyIdle('group1@g.us');

    // Clear previous writes, then enqueue a task
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    // _close SHOULD have been written (container is idle)
    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('sendMessage resets idleWaiting so a subsequent task enqueue does not preempt', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );

    // Container becomes idle
    queue.notifyIdle('group1@g.us');

    // A new user message arrives — resets idleWaiting
    queue.sendMessage('group1@g.us', 'hello');

    // Task enqueued after message reset — should NOT preempt (agent is working)
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('sendMessage returns false for task containers so user messages queue up', async () => {
    let resolveTask: () => void;

    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    // Start a task (sets isTaskContainer = true)
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );

    // sendMessage should return false — user messages must not go to task containers
    const result = queue.sendMessage('group1@g.us', 'hello');
    expect(result).toBe(false);

    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('preempts when idle arrives with pending tasks', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register process and enqueue a task (no idle yet — no preemption)
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    let closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    // Now container becomes idle — should preempt because task is pending
    writeFileSync.mockClear();
    queue.notifyIdle('group1@g.us');

    closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Impl-61: per-folder lock + cross-chat-waiter pre-empt ---

  const gate = () => {
    let r!: () => void;
    const p = new Promise<void>((res) => (r = res));
    p.catch(() => {});
    return { p, r };
  };
  const tick = () => vi.advanceTimersByTimeAsync(10);
  const A = 'A@g.us',
    B = 'B@g.us';
  const closeWriteCount = (wfs: any) =>
    wfs.mock.calls.filter(
      (c: any) => typeof c[0] === 'string' && c[0].endsWith('_close'),
    ).length;

  it('G2a — at most one container per folder alive (cross-chat pre-empt)', async () => {
    const wfs = vi.mocked((await import('fs')).default.writeFileSync);
    wfs.mockClear();
    const live = new Set<string>();
    let max = 0;
    const gA = gate(),
      bEnq = gate();
    wfs.mockImplementation((f: any) => {
      if (typeof f === 'string' && f.endsWith('_close')) gA.r();
    });
    queue.setProcessMessagesFn(async (jid) => {
      live.add(jid);
      max = Math.max(max, live.size);
      if (jid === A) {
        await bEnq.p;
        queue.notifyIdle(jid);
        await gA.p;
      }
      live.delete(jid);
      return true;
    });
    queue.enqueueMessageCheck(A, 'daystrom');
    await tick();
    queue.enqueueMessageCheck(B, 'daystrom');
    await tick();
    bEnq.r();
    for (let i = 0; i < 10 && live.size > 0; i++) await tick();
    expect(max).toBeLessThanOrEqual(1);
  });

  it('G2b — same-chat follow-up reuse (no pre-empt)', async () => {
    const wfs = vi.mocked((await import('fs')).default.writeFileSync);
    wfs.mockClear();
    const gA = gate();
    const pm = vi.fn(async (jid: string) => {
      queue.notifyIdle(jid);
      await gA.p;
      return true;
    });
    queue.setProcessMessagesFn(pm);
    queue.enqueueMessageCheck(A, 'daystrom');
    await tick();
    expect(queue.sendMessage(A, 'follow-up')).toBe(true);
    expect(closeWriteCount(wfs)).toBe(0);
    expect(pm).toHaveBeenCalledTimes(1);
    gA.r();
    await tick();
  });

  it('G2c — different folders never block each other', async () => {
    let maxLive = 0;
    const live = new Set<string>();
    const gA = gate(),
      gB = gate();
    queue.setProcessMessagesFn(async (jid) => {
      live.add(jid);
      maxLive = Math.max(maxLive, live.size);
      await (jid === A ? gA.p : gB.p);
      live.delete(jid);
      return true;
    });
    queue.enqueueMessageCheck(A, 'daystrom');
    queue.enqueueMessageCheck(B, 'worf');
    await tick();
    expect(maxLive).toBe(2);
    gA.r();
    gB.r();
    await tick();
  });

  it('G2d — error path releases the folder lock', async () => {
    const seen: string[] = [];
    const gB = gate();
    queue.setProcessMessagesFn(async (jid) => {
      seen.push(jid);
      if (jid === A) throw new Error('boom');
      await gB.p;
      return true;
    });
    queue.enqueueMessageCheck(A, 'daystrom');
    await tick();
    queue.enqueueMessageCheck(B, 'daystrom');
    await tick();
    expect(seen).toEqual([A, B]);
    gB.r();
    await tick();
  });

  it('G2e — drain: task acquires lock after message (no warn-skip)', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    const events: string[] = [];
    const gM = gate(),
      gT = gate();
    queue.setProcessMessagesFn(async () => {
      events.push('msg');
      await gM.p;
      return true;
    });
    queue.enqueueMessageCheck(A, 'daystrom');
    await tick();
    queue.enqueueTask(
      A,
      't1',
      async () => {
        events.push('task');
        await gT.p;
      },
      'daystrom',
    );
    gM.r();
    await tick();
    expect(events).toEqual(['msg', 'task']);
    gT.r();
    await tick();
    expect(
      warnSpy.mock.calls.filter(
        (c) =>
          typeof c[1] === 'string' &&
          (c[1] as string).includes('skipping per-folder spawn lock'),
      ),
    ).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it('single-chat retry-storm watchdog force-stops container with no output for 10 minutes when not idle', async () => {
    const { stopContainer } = await import('./container-runtime.js');
    const stopMock = vi.mocked(stopContainer);
    stopMock.mockClear();

    let resolveProcess: () => void = () => {};
    queue.setProcessMessagesFn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.enqueueMessageCheck('A@g.us', 'daystrom');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'A@g.us',
      {} as any,
      'nanoclaw-daystrom-noutout',
      'daystrom',
    );

    // Active container, no output, no idle — advance to 10 minutes
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(stopMock).toHaveBeenCalledWith('nanoclaw-daystrom-noutout');
    expect(stopMock).toHaveBeenCalledTimes(1);

    resolveProcess();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('single-chat retry-storm watchdog does NOT fire while container is in idle-wait', async () => {
    const { stopContainer } = await import('./container-runtime.js');
    const stopMock = vi.mocked(stopContainer);
    stopMock.mockClear();

    let resolveProcess: () => void = () => {};
    queue.setProcessMessagesFn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.enqueueMessageCheck('A@g.us', 'daystrom');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'A@g.us',
      {} as any,
      'nanoclaw-daystrom-idletest',
      'daystrom',
    );

    // Enter idle-wait — watchdog should NOT fire even after deadline elapses
    queue.notifyIdle('A@g.us');
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);
    expect(stopMock).not.toHaveBeenCalled();

    resolveProcess();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('single-chat retry-storm watchdog reset by markOutputReceived', async () => {
    const { stopContainer } = await import('./container-runtime.js');
    const stopMock = vi.mocked(stopContainer);
    stopMock.mockClear();

    let resolveProcess: () => void = () => {};
    queue.setProcessMessagesFn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.enqueueMessageCheck('A@g.us', 'daystrom');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'A@g.us',
      {} as any,
      'nanoclaw-daystrom-resettest',
      'daystrom',
    );

    // Advance most of the deadline, then mark output → watchdog resets
    await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
    queue.markOutputReceived('A@g.us');
    // Advance past where original deadline would have fired — watchdog should not fire
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(stopMock).not.toHaveBeenCalled();
    // Advance another 8 minutes (total 10min since reset) — now it should fire
    await vi.advanceTimersByTimeAsync(8 * 60 * 1000);
    expect(stopMock).toHaveBeenCalledWith('nanoclaw-daystrom-resettest');

    resolveProcess();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('FU-30 — closeStdin watchdog force-stops container if it does not exit within deadline', async () => {
    const { stopContainer } = await import('./container-runtime.js');
    const stopMock = vi.mocked(stopContainer);
    stopMock.mockClear();

    let resolveProcess: () => void = () => {};
    queue.setProcessMessagesFn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.enqueueMessageCheck('A@g.us', 'daystrom');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'A@g.us',
      {} as any,
      'nanoclaw-daystrom-fu30',
      'daystrom',
    );

    queue.closeStdin('A@g.us');
    expect(stopMock).not.toHaveBeenCalled(); // within deadline window

    await vi.advanceTimersByTimeAsync(30_000);
    expect(stopMock).toHaveBeenCalledWith('nanoclaw-daystrom-fu30');
    expect(stopMock).toHaveBeenCalledTimes(1);

    // Cleanup: simulate natural process exit so runForGroup completes
    resolveProcess();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Impl-75 D: no false alarms at container-close boundaries ---

  /** Reproduce docker's "already gone" failure the way execSync surfaces it. */
  function noSuchContainerError(name: string): Error {
    return new Error(
      `Command failed: docker stop -t 1 ${name}\nError response from daemon: No such container: ${name}\n`,
    );
  }

  async function startContainerFor(
    jid: string,
    containerName: string,
  ): Promise<() => void> {
    let resolveProcess: () => void = () => {};
    queue.setProcessMessagesFn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });
    queue.enqueueMessageCheck(jid, 'daystrom');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(jid, {} as any, containerName, 'daystrom');
    return () => resolveProcess();
  }

  it('D1 — FU-30 losing the race to the reaper does NOT notify the operator', async () => {
    const { stopContainer } = await import('./container-runtime.js');
    const stopMock = vi.mocked(stopContainer);
    stopMock.mockClear();
    // The 2026-07-16 sequence: the idle reaper already stopped it 1.1s earlier.
    stopMock.mockImplementation(() => {
      throw noSuchContainerError('nanoclaw-daystrom-d1');
    });

    const notify = vi.fn(async () => {});
    queue.setOperatorNotifier(notify);
    const done = await startContainerFor('A@g.us', 'nanoclaw-daystrom-d1');

    queue.closeStdin('A@g.us');
    await vi.advanceTimersByTimeAsync(30_000);

    expect(stopMock).toHaveBeenCalledWith('nanoclaw-daystrom-d1');
    // Pre-Impl-75 this Telegrammed JT about a container that was already dead.
    expect(notify).not.toHaveBeenCalled();

    done();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('D1 — no-output watchdog losing the race does NOT notify the operator', async () => {
    const { stopContainer } = await import('./container-runtime.js');
    const stopMock = vi.mocked(stopContainer);
    stopMock.mockClear();
    stopMock.mockImplementation(() => {
      throw noSuchContainerError('nanoclaw-daystrom-d1b');
    });

    const notify = vi.fn(async () => {});
    queue.setOperatorNotifier(notify);
    const done = await startContainerFor('A@g.us', 'nanoclaw-daystrom-d1b');

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 100);

    expect(stopMock).toHaveBeenCalledWith('nanoclaw-daystrom-d1b');
    expect(notify).not.toHaveBeenCalled();

    done();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('D1 — a genuine stop failure still notifies (we only suppress "already gone")', async () => {
    const { stopContainer } = await import('./container-runtime.js');
    const stopMock = vi.mocked(stopContainer);
    stopMock.mockClear();
    stopMock.mockImplementation(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    const notify = vi.fn(async () => {});
    queue.setOperatorNotifier(notify);
    const done = await startContainerFor('A@g.us', 'nanoclaw-daystrom-d1c');

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 100);

    expect(notify).toHaveBeenCalledTimes(1);

    done();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('D2 — the hang alert no longer claims an unconditional auto-retry', async () => {
    const { stopContainer } = await import('./container-runtime.js');
    const stopMock = vi.mocked(stopContainer);
    stopMock.mockClear();
    stopMock.mockImplementation(() => {});

    const notify = vi.fn(async (_jid: string, _msg: string) => {});
    queue.setOperatorNotifier(notify);
    const done = await startContainerFor('A@g.us', 'nanoclaw-daystrom-d2');

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 100);

    expect(notify).toHaveBeenCalledTimes(1);
    const alert = notify.mock.calls[0][1] as unknown as string;
    // On 2026-07-16 JT was told a recovery was underway that never happened and
    // waited 2h19m on it. The message path DOES retry, but only if the message
    // went unanswered — so the wording must be conditional, never a promise.
    expect(alert).not.toMatch(/auto-retrying/i);
    expect(alert).toMatch(/unanswered/i);

    done();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('D2 — a task container is not promised a watchdog retry it never gets', async () => {
    const { stopContainer } = await import('./container-runtime.js');
    const stopMock = vi.mocked(stopContainer);
    stopMock.mockClear();
    stopMock.mockImplementation(() => {});

    const notify = vi.fn(async (_jid: string, _msg: string) => {});
    queue.setOperatorNotifier(notify);

    let resolveTask: () => void = () => {};
    queue.enqueueTask(
      'A@g.us',
      'daystrom-board-synth-v2',
      () =>
        new Promise<void>((resolve) => {
          resolveTask = resolve;
        }),
      'daystrom',
    );
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'A@g.us',
      {} as any,
      'nanoclaw-daystrom-d2task',
      'daystrom',
    );

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 100);

    expect(notify).toHaveBeenCalledTimes(1);
    const alert = notify.mock.calls[0][1] as unknown as string;
    // runTask catches and logs; the queue schedules NO retry for tasks.
    expect(alert).not.toMatch(/auto-retrying/i);
    expect(alert).toMatch(/does not retry/i);

    resolveTask();
    await vi.advanceTimersByTimeAsync(10);
  });
});
