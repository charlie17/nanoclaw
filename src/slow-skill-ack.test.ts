import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _clearAllHeartbeats, startSlowSkillAck } from './slow-skill-ack.js';
import type { Channel } from './types.js';

function makeTelegramChannel(): Channel & {
  sendMessage: ReturnType<typeof vi.fn>;
  setTyping: ReturnType<typeof vi.fn>;
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

function makeWebChannel(): Channel & {
  sendMessage: ReturnType<typeof vi.fn>;
  setTyping: ReturnType<typeof vi.fn>;
} {
  return {
    name: 'web' as const,
    sendMessage: vi.fn().mockResolvedValue(undefined),
    setTyping: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    ownsJid: vi.fn().mockReturnValue(false),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

describe('slow-skill-ack', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    _clearAllHeartbeats();
    vi.useRealTimers();
  });

  it('slow-skill match fires ack + starts heartbeat', async () => {
    const channel = makeTelegramChannel();
    const stop = startSlowSkillAck(
      'jid:1',
      channel,
      '/research spaced repetition',
    );

    expect(channel.sendMessage).toHaveBeenCalledOnce();
    expect(channel.sendMessage.mock.calls[0][1]).toContain(
      'working on spaced repetition now',
    );
    expect(channel.setTyping).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(8000);
    expect(channel.setTyping).toHaveBeenCalledTimes(3);

    stop();
  });

  it('non-slow message is no-op', async () => {
    const channel = makeTelegramChannel();
    const stop = startSlowSkillAck('jid:1', channel, 'hello daystrom');

    expect(channel.sendMessage).not.toHaveBeenCalled();
    expect(channel.setTyping).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(8000);
    expect(channel.setTyping).not.toHaveBeenCalled();

    stop();
  });

  it('/wiki-scan is a slow-skill (allowlist regression)', async () => {
    const channel = makeTelegramChannel();
    const stop = startSlowSkillAck('jid:1', channel, '/wiki-scan');

    expect(channel.sendMessage).toHaveBeenCalledTimes(1);
    expect(channel.sendMessage.mock.calls[0][1]).toContain(
      'working on your wiki-scan request',
    );
    expect(channel.setTyping).toHaveBeenCalledTimes(1);

    stop();
  });

  it('topic extraction and fallback', () => {
    const ch1 = makeTelegramChannel();
    startSlowSkillAck('jid:1', ch1, '/research foo bar');
    expect(ch1.sendMessage.mock.calls[0][1]).toContain(
      'working on foo bar now',
    );

    const ch2 = makeTelegramChannel();
    startSlowSkillAck('jid:2', ch2, '/research');
    expect(ch2.sendMessage.mock.calls[0][1]).toContain(
      'working on your research request now',
    );

    const ch3 = makeTelegramChannel();
    startSlowSkillAck('jid:3', ch3, `/research ${'a'.repeat(60)}`);
    const body: string = ch3.sendMessage.mock.calls[0][1];
    const extracted = body
      .replace('Got it — working on ', '')
      .replace(" now. I'll ping back when it's ready.", '');
    expect(extracted.length).toBeLessThanOrEqual(50);
  });

  it('stop() clears heartbeat', async () => {
    const channel = makeTelegramChannel();
    const stop = startSlowSkillAck('jid:1', channel, '/research something');

    stop();
    const callsAfterStop = channel.setTyping.mock.calls.length;

    await vi.advanceTimersByTimeAsync(8000);
    expect(channel.setTyping).toHaveBeenCalledTimes(callsAfterStop);
  });

  it('non-Telegram channel: heartbeat runs, ack suppressed', async () => {
    const channel = makeWebChannel();
    const stop = startSlowSkillAck('jid:1', channel, '/research something');

    expect(channel.sendMessage).not.toHaveBeenCalled();
    expect(channel.setTyping).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(8000);
    expect(channel.setTyping).toHaveBeenCalledTimes(3);

    stop();
  });

  it('hard timeout clears heartbeat without explicit stop()', async () => {
    const channel = makeTelegramChannel();
    startSlowSkillAck('jid:1', channel, '/research something');

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000);
    const callsAtTimeout = channel.setTyping.mock.calls.length;

    await vi.advanceTimersByTimeAsync(8000);
    expect(channel.setTyping).toHaveBeenCalledTimes(callsAtTimeout);
  });
});
