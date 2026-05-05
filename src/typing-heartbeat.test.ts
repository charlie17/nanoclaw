import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _clearAllTypingHeartbeats,
  startTypingHeartbeat,
} from './typing-heartbeat.js';
import type { Channel } from './types.js';

function makeChannel(name: 'telegram' | 'web' = 'telegram'): Channel & {
  sendMessage: ReturnType<typeof vi.fn>;
  setTyping: ReturnType<typeof vi.fn>;
} {
  return {
    name,
    sendMessage: vi.fn().mockResolvedValue(undefined),
    setTyping: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    ownsJid: vi.fn().mockReturnValue(false),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

describe('typing-heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    _clearAllTypingHeartbeats();
    vi.useRealTimers();
  });

  it('fires immediately + every 4s until stopped', async () => {
    const channel = makeChannel();
    const stop = startTypingHeartbeat('jid:1', channel);

    expect(channel.setTyping).toHaveBeenCalledTimes(1);
    expect(channel.setTyping).toHaveBeenLastCalledWith('jid:1', true);

    await vi.advanceTimersByTimeAsync(4000);
    expect(channel.setTyping).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(8000);
    expect(channel.setTyping).toHaveBeenCalledTimes(4);

    stop();
    await vi.advanceTimersByTimeAsync(20000);
    expect(channel.setTyping).toHaveBeenCalledTimes(4);
  });

  it('runs through long agent windows up to the 30-min hard cap', async () => {
    const channel = makeChannel();
    const stop = startTypingHeartbeat('jid:1', channel);

    // Simulate 25 min of agent work — well past slow-skill-ack 5-min cap.
    await vi.advanceTimersByTimeAsync(25 * 60 * 1000);
    // 1 immediate + 25*60/4 = 375 refreshes during 25 min.
    expect(channel.setTyping).toHaveBeenCalledTimes(376);

    stop();
  });

  it('hard-timeout cleans up after 30 min if stop is never called', async () => {
    const channel = makeChannel();
    startTypingHeartbeat('jid:1', channel);

    // Just past the 30-min cap.
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1000);
    const callsAfterCap = channel.setTyping.mock.calls.length;

    // No further calls should fire after the hard-timeout.
    await vi.advanceTimersByTimeAsync(20000);
    expect(channel.setTyping).toHaveBeenCalledTimes(callsAfterCap);
  });

  it('clobbers a prior heartbeat for the same jid', async () => {
    const channel = makeChannel();
    const stop1 = startTypingHeartbeat('jid:1', channel);
    expect(channel.setTyping).toHaveBeenCalledTimes(1);

    // Second start without stop1 — should clear timer and start fresh.
    const stop2 = startTypingHeartbeat('jid:1', channel);
    expect(channel.setTyping).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(4000);
    // Only one timer should be active — 1 more refresh, not 2.
    expect(channel.setTyping).toHaveBeenCalledTimes(3);

    stop1();
    stop2();
  });

  it('is a no-op for channels without setTyping', () => {
    const channel: Channel = {
      name: 'telegram',
      sendMessage: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
      isConnected: vi.fn().mockReturnValue(true),
      ownsJid: vi.fn().mockReturnValue(false),
      disconnect: vi.fn().mockResolvedValue(undefined),
      // setTyping deliberately omitted
    };
    const stop = startTypingHeartbeat('jid:1', channel);
    expect(typeof stop).toBe('function');
    // Just confirm calling stop doesn't throw.
    stop();
  });
});
