import { describe, it, expect } from 'vitest';

import { backgroundTaskLevel } from '../src/background-tasks.js';

const changed = (tasks: unknown) => ({
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks,
  uuid: 'u',
  session_id: 's',
});

describe('backgroundTaskLevel', () => {
  it('counts every live task in the payload', () => {
    expect(
      backgroundTaskLevel(
        changed([
          { task_id: 'a', task_type: 'local_agent', description: 'x' },
          { task_id: 'b', task_type: 'local_bash', description: 'y' },
        ]),
      ),
    ).toBe(2);
  });

  it('returns zero for an empty set, so a finished task clears the hold', () => {
    expect(backgroundTaskLevel(changed([]))).toBe(0);
  });

  it('excludes ambient tasks', () => {
    expect(
      backgroundTaskLevel(
        changed([
          { task_id: 'a', task_type: 'local_agent', description: 'x' },
          {
            task_id: 'w',
            task_type: 'monitor',
            description: 'w',
            ambient: true,
          },
        ]),
      ),
    ).toBe(1);
  });

  it('returns null for any other message, leaving the count unchanged', () => {
    for (const m of [
      { type: 'system', subtype: 'task_started', task_id: 'a' },
      { type: 'system', subtype: 'task_notification', task_id: 'a' },
      { type: 'result', subtype: 'success' },
      { type: 'system', subtype: 'background_tasks_changed' },
      null,
      'background_tasks_changed',
    ]) {
      expect(backgroundTaskLevel(m)).toBeNull();
    }
  });
});
