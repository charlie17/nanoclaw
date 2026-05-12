import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _clearAllPendingAlerts,
  _hasPendingAlert,
  cancelPendingAlert,
  schedulePendingAlert,
} from './rate-limit-alert.js';
import type { Channel } from './types.js';

function makeChannel(): Channel & {
  sendMessage: ReturnType<typeof vi.fn>;
} {
  return {
    name: 'telegram' as const,
    sendMessage: vi.fn().mockResolvedValue(undefined),
    setTyping: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    ownsJid: vi.fn().mockReturnValue(false),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

describe('rate-limit-alert', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    _clearAllPendingAlerts();
    vi.useRealTimers();
  });

  it('fires alert when window elapses with no cancellation', async () => {
    const channel = makeChannel();
    schedulePendingAlert('jid:1', channel, 5000);

    expect(channel.sendMessage).not.toHaveBeenCalled();
    expect(_hasPendingAlert('jid:1')).toBe(true);

    await vi.advanceTimersByTimeAsync(5000);

    expect(channel.sendMessage).toHaveBeenCalledOnce();
    expect(channel.sendMessage.mock.calls[0][1]).toContain(
      'Anthropic rate-limited',
    );
    expect(_hasPendingAlert('jid:1')).toBe(false);
  });

  it('cancels alert when SDK activity arrives within window', async () => {
    const channel = makeChannel();
    schedulePendingAlert('jid:1', channel, 5000);

    // Simulate SDK event after 2s — agent IS making progress
    await vi.advanceTimersByTimeAsync(2000);
    cancelPendingAlert('jid:1');

    // Window elapses but alert was cancelled
    await vi.advanceTimersByTimeAsync(10000);

    expect(channel.sendMessage).not.toHaveBeenCalled();
    expect(_hasPendingAlert('jid:1')).toBe(false);
  });

  it('replaces previous timer when re-scheduled for same jid', async () => {
    const channel = makeChannel();
    schedulePendingAlert('jid:1', channel, 5000);

    await vi.advanceTimersByTimeAsync(3000);

    // Re-schedule — should reset the timer (next 5s window starts fresh)
    schedulePendingAlert('jid:1', channel, 5000);

    await vi.advanceTimersByTimeAsync(3000);
    // 6s total elapsed but only 3s since the re-schedule; alert NOT yet
    expect(channel.sendMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);
    // Now 5s since re-schedule — alert fires
    expect(channel.sendMessage).toHaveBeenCalledOnce();
  });

  it('tracks multiple jids independently', async () => {
    const ch1 = makeChannel();
    const ch2 = makeChannel();

    schedulePendingAlert('jid:1', ch1, 5000);
    schedulePendingAlert('jid:2', ch2, 5000);

    expect(_hasPendingAlert('jid:1')).toBe(true);
    expect(_hasPendingAlert('jid:2')).toBe(true);

    // jid:1 gets cancelled (response arrived); jid:2 stays pending
    await vi.advanceTimersByTimeAsync(2000);
    cancelPendingAlert('jid:1');

    await vi.advanceTimersByTimeAsync(5000);

    expect(ch1.sendMessage).not.toHaveBeenCalled();
    expect(ch2.sendMessage).toHaveBeenCalledOnce();
  });

  it('cancelPendingAlert is a no-op when no timer is pending', () => {
    expect(() => cancelPendingAlert('jid:nothing')).not.toThrow();
    expect(_hasPendingAlert('jid:nothing')).toBe(false);
  });

  it('respects custom delay parameter', async () => {
    const channel = makeChannel();
    schedulePendingAlert('jid:1', channel, 3000);

    await vi.advanceTimersByTimeAsync(2999);
    expect(channel.sendMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(channel.sendMessage).toHaveBeenCalledOnce();
  });
});
