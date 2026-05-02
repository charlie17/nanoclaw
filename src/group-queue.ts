import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { stopContainer } from './container-runtime.js';
import { logger } from './logger.js';

/** FU-30 — closeStdin watchdog: if the container does not exit within this
 * window after the _close sentinel is written, force docker stop. Bounds the
 * bilateral cross-chat pre-empt path against SDK retry-storm scenarios where
 * the SDK is mid-Anthropic-API-call retry and won't poll _close until between
 * query iterations. */
const CLOSE_STDIN_DEADLINE_MS = 30_000;

/** FU-Single-chat retry-storm watchdog: if the container has produced no SDK
 * output within this window AND is not in idle-wait state (i.e., it should
 * be processing), force docker stop. Catches single-chat scenarios where
 * FU-30's closeStdin path is never triggered (no other chat waiting), but
 * an Anthropic 5xx retry-storm has the SDK silently retrying for many
 * minutes with the container alive but unproductive. Reset on every output;
 * cleared when container goes idle (idle is the persistent-container UX
 * win — agent finished current turn, waiting for follow-up). 5 minutes is
 * long enough for normal queries (incl. multi-tool deep-research) under
 * load but short enough that a stuck retry-storm doesn't hold the chat
 * surface for an unbounded window. */
const NO_OUTPUT_DEADLINE_MS = 5 * 60 * 1000;

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  retryCount: number;
  closeStdinDeadline: NodeJS.Timeout | null;
  noOutputDeadline: NodeJS.Timeout | null;
}

/** Per-folder mutex; getWaiterCount excludes the current holder. */
class FolderLock {
  private chain: Promise<void> = Promise.resolve();
  private waiters = 0;
  private holderJid: string | null = null;
  getWaiterCount(): number {
    return this.waiters;
  }
  getHolderJid(): string | null {
    return this.holderJid;
  }
  async acquire(jid: string): Promise<() => void> {
    this.waiters++;
    const prior = this.chain;
    let unlock!: () => void;
    this.chain = new Promise<void>((r) => (unlock = r));
    await prior;
    this.waiters--;
    this.holderJid = jid;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.holderJid = null;
      unlock();
    };
  }
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private folderLocks = new Map<string, FolderLock>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  // JT: Optional operator-notification callback. Wired by the orchestrator at
  // JT: startup so that watchdog kills surface to the user immediately via the
  // JT: same channel they're chatting on, instead of leaving them in silence.
  private operatorNotify:
    | ((groupJid: string, message: string) => Promise<void>)
    | null = null;
  private shuttingDown = false;

  private async acquireForState(
    state: GroupState,
    ctx: Record<string, unknown>,
    groupJid: string,
  ): Promise<() => void> {
    const folder = state.groupFolder;
    if (!folder) {
      logger.warn(ctx, 'No groupFolder known, skipping per-folder spawn lock');
      return () => {};
    }
    let lock = this.folderLocks.get(folder);
    if (!lock) this.folderLocks.set(folder, (lock = new FolderLock()));
    // Bilateral pre-empt: if the current holder is idle-waiting, signal it to
    // exit now so we don't wait the full IDLE_TIMEOUT (30 min). notifyIdle's
    // own waiter check handles the case where the holder enters idle AFTER we
    // enqueue; this branch handles the inverse — we enqueue AFTER the holder
    // already entered idle and notifyIdle has already returned.
    const holderJid = lock.getHolderJid();
    if (holderJid && holderJid !== groupJid) {
      const holderState = this.groups.get(holderJid);
      if (holderState?.idleWaiting) this.closeStdin(holderJid);
    }
    return lock.acquire(groupJid);
  }

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        retryCount: 0,
        closeStdinDeadline: null,
        noOutputDeadline: null,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  setOperatorNotifier(
    fn: (groupJid: string, message: string) => Promise<void>,
  ): void {
    this.operatorNotify = fn;
  }

  // Fire-and-forget operator alert. Wraps in try/catch so a notify failure
  // (Telegram down, channel gone, etc.) never bubbles up into the watchdog
  // path that called it. The watchdog still does its real work either way.
  private notifyOperator(groupJid: string, message: string): void {
    if (!this.operatorNotify) return;
    this.operatorNotify(groupJid, message).catch((err) => {
      logger.warn({ groupJid, err }, 'operatorNotify failed (non-fatal)');
    });
  }

  enqueueMessageCheck(groupJid: string, groupFolder?: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);
    if (groupFolder) state.groupFolder = groupFolder;

    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ groupJid }, 'Container active, message queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(groupJid, 'messages').catch((err) =>
      logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(
    groupJid: string,
    taskId: string,
    fn: () => Promise<void>,
    groupFolder?: string,
  ): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);
    if (groupFolder) state.groupFolder = groupFolder;

    // Prevent double-queuing: check both pending and currently-running task
    if (state.runningTaskId === taskId) {
      logger.debug({ groupJid, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (state.idleWaiting) {
        this.closeStdin(groupJid);
      }
      logger.debug({ groupJid, taskId }, 'Container active, task queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Run immediately
    this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) =>
      logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
  ): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
    this.armNoOutputWatchdog(state, groupJid);
  }

  /** Called from the host's onOutput callback when the container emits an SDK
   * result. Resets the no-output watchdog. */
  markOutputReceived(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.active) return;
    this.armNoOutputWatchdog(state, groupJid);
  }

  private armNoOutputWatchdog(state: GroupState, groupJid: string): void {
    this.clearNoOutputWatchdog(state);
    if (!state.containerName) return;
    const containerName = state.containerName;
    state.noOutputDeadline = setTimeout(() => {
      state.noOutputDeadline = null;
      if (!state.active || state.containerName !== containerName) return;
      // Skip if the container is in legitimate idle-wait — that's the
      // persistent-container UX win, not a stuck retry-storm.
      if (state.idleWaiting) return;
      logger.warn(
        {
          groupJid,
          containerName,
          deadlineMs: NO_OUTPUT_DEADLINE_MS,
        },
        'Container produced no SDK output within deadline; forcing docker stop (single-chat retry-storm watchdog)',
      );
      try {
        stopContainer(containerName);
      } catch (err) {
        logger.error(
          { groupJid, containerName, err },
          'No-output watchdog: stopContainer threw',
        );
      }
      // JT: Surface to operator immediately. Without this, the user just sees
      // JT: silence — container is dead, no retry happening, but they have no
      // JT: signal anything went wrong. See post-mortem 2026-05-02.
      // JT: Phrasing is context-agnostic: works for both interactive chats
      // JT: and scheduled-task hangs (operator may be JT either way).
      const minutes = Math.round(NO_OUTPUT_DEADLINE_MS / 60000);
      this.notifyOperator(
        groupJid,
        `⚠️ Container hung (no SDK output for ${minutes} min). Killed by watchdog; auto-retrying with backoff. Only the in-flight reply is lost — conversation continues. If silence persists past ~30s, send a follow-up to nudge.`,
      );
    }, NO_OUTPUT_DEADLINE_MS);
  }

  private clearNoOutputWatchdog(state: GroupState): void {
    if (state.noOutputDeadline) {
      clearTimeout(state.noOutputDeadline);
      state.noOutputDeadline = null;
    }
  }

  /**
   * Mark container idle-waiting. Pre-empt via closeStdin if (a) tasks are
   * pending OR (b) another chat is queued for the same folder (Impl-61 D-V61.4).
   */
  notifyIdle(groupJid: string): void {
    const state = this.getGroup(groupJid);
    state.idleWaiting = true;
    // No-output watchdog applies only to actively-processing containers.
    // Clear when entering idle-wait; re-armed by sendMessage's idleWaiting=false.
    this.clearNoOutputWatchdog(state);
    const lock = state.groupFolder
      ? this.folderLocks.get(state.groupFolder)
      : null;
    if (state.pendingTasks.length > 0 || (lock && lock.getWaiterCount() > 0)) {
      this.closeStdin(groupJid);
    }
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(groupJid: string, text: string): boolean {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder || state.isTaskContainer)
      return false;
    state.idleWaiting = false; // Agent is about to receive work, no longer idle
    // Re-arm the no-output watchdog: container is processing again.
    this.armNoOutputWatchdog(state, groupJid);

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signal the active container to wind down by writing a close sentinel.
   * Also arms a watchdog (FU-30): if the container doesn't exit within
   * CLOSE_STDIN_DEADLINE_MS, force docker stop. SDK retry-storms (e.g.,
   * Anthropic 5xx outages) can hold a container alive past the _close
   * sentinel because the agent-runner only polls the sentinel between
   * SDK query iterations — an in-flight retry is uninterruptible.
   */
  closeStdin(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder) return;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }

    if (state.closeStdinDeadline || !state.containerName) return;
    const containerName = state.containerName;
    state.closeStdinDeadline = setTimeout(() => {
      state.closeStdinDeadline = null;
      if (!state.active || state.containerName !== containerName) return;
      logger.warn(
        { groupJid, containerName },
        'Container did not exit within deadline of closeStdin; forcing docker stop (FU-30 watchdog)',
      );
      try {
        stopContainer(containerName);
      } catch (err) {
        logger.error(
          { groupJid, containerName, err },
          'FU-30 watchdog: stopContainer threw',
        );
      }
      // JT: Surface to operator. FU-30 fires when the SDK is in an
      // JT: ungraceful retry-storm state past closeStdin. Same UX
      // JT: principle as the no-output watchdog. Context-agnostic.
      this.notifyOperator(
        groupJid,
        `⚠️ Container failed to exit gracefully after closeStdin. Force-killed by FU-30 watchdog; auto-retrying. Only the in-flight reply is lost — conversation continues.`,
      );
    }, CLOSE_STDIN_DEADLINE_MS);
  }

  /**
   * FU-27a fold — for /model switch: immediately stop the active container.
   * `closeStdin` is graceful (writes _close sentinel; SDK exits between query
   * iterations) and races against subsequent messages from the same chat,
   * which can be IPC-piped into the still-alive container before it exits —
   * causing the user-perceived "I just switched to Sonnet but the agent
   * still claims Opus" bug. Force-stop is correct for /model because the
   * agent has finished its last turn (notifyIdle has fired by definition
   * if the user is typing /model), and we want the new env var to take
   * effect on the very next message regardless of timing.
   */
  forceStopActiveContainer(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.containerName) return;
    const containerName = state.containerName;
    try {
      stopContainer(containerName);
    } catch (err) {
      logger.warn(
        { groupJid, containerName, err },
        'forceStopActiveContainer: stopContainer threw',
      );
    }
  }

  /** Clear the closeStdin watchdog when the container exits naturally. */
  private clearCloseStdinDeadline(state: GroupState): void {
    if (state.closeStdinDeadline) {
      clearTimeout(state.closeStdinDeadline);
      state.closeStdinDeadline = null;
    }
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;
    this.activeCount++;

    logger.debug(
      { groupJid, reason, activeCount: this.activeCount },
      'Starting container for group',
    );

    const release = await this.acquireForState(
      state,
      { groupJid, reason },
      groupJid,
    );
    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(groupJid, state);
        }
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages for group');
      this.scheduleRetry(groupJid, state);
    } finally {
      this.clearCloseStdinDeadline(state);
      this.clearNoOutputWatchdog(state);
      release();
      state.active = false;
      state.process = null;
      state.containerName = null;
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;
    this.activeCount++;

    logger.debug(
      { groupJid, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );

    const release = await this.acquireForState(
      state,
      { groupJid, taskId: task.id },
      groupJid,
    );
    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      this.clearCloseStdinDeadline(state);
      this.clearNoOutputWatchdog(state);
      release();
      state.active = false;
      state.isTaskContainer = false;
      state.runningTaskId = null;
      state.process = null;
      state.containerName = null;
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupJid, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid);
      }
    }, delayMs);
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task).catch((err) =>
        logger.error(
          { groupJid, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      this.runForGroup(groupJid, 'drain').catch((err) =>
        logger.error(
          { groupJid, err },
          'Unhandled error in runForGroup (drain)',
        ),
      );
      return;
    }

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextJid = this.waitingGroups.shift()!;
      const state = this.getGroup(nextJid);

      // Prioritize tasks over messages
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextJid, task).catch((err) =>
          logger.error(
            { groupJid: nextJid, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      } else if (state.pendingMessages) {
        this.runForGroup(nextJid, 'drain').catch((err) =>
          logger.error(
            { groupJid: nextJid, err },
            'Unhandled error in runForGroup (waiting)',
          ),
        );
      }
      // If neither pending, skip this group
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // Count active containers but don't kill them — they'll finish on their own
    // via idle timeout or container timeout. The --rm flag cleans them up on exit.
    // This prevents WhatsApp reconnection restarts from killing working agents.
    const activeContainers: string[] = [];
    for (const [_jid, state] of this.groups) {
      if (state.process && !state.process.killed && state.containerName) {
        activeContainers.push(state.containerName);
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}
