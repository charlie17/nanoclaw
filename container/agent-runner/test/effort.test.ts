import { describe, it, expect, vi } from 'vitest';

import { resolveEffort } from '../src/effort.js';

describe('resolveEffort', () => {
  it('passes every SDK level through without warning', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const warn = vi.fn();
      expect(resolveEffort(level, warn)).toBe(level);
      expect(warn).not.toHaveBeenCalled();
    }
  });

  it('omits and warns once on an invalid value', () => {
    for (const raw of ['HIGH', 'ultra', ' high', '3']) {
      const warn = vi.fn();
      expect(resolveEffort(raw, warn)).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    }
  });

  it('omits silently when absent or empty', () => {
    const warn = vi.fn();
    expect(resolveEffort(undefined, warn)).toBeUndefined();
    expect(resolveEffort('', warn)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
