/**
 * Live background-task count from the SDK's `background_tasks_changed` level
 * signal. Each payload is the full set of live tasks (replace, never pair the
 * task_started/task_notification edges), and ambient housekeeping tasks are
 * not work the agent is waiting on, so they are excluded.
 *
 * Returns null for any other message, so the caller keeps its last count. The
 * level is per CLI process, so the caller starts each query() at zero.
 */
export function backgroundTaskLevel(message: unknown): number | null {
  if (typeof message !== 'object' || message === null) return null;
  const m = message as { type?: unknown; subtype?: unknown; tasks?: unknown };
  if (m.type !== 'system' || m.subtype !== 'background_tasks_changed') {
    return null;
  }
  if (!Array.isArray(m.tasks)) return null;
  return m.tasks.filter(
    (t) =>
      typeof t === 'object' &&
      t !== null &&
      (t as { ambient?: unknown }).ambient !== true,
  ).length;
}
