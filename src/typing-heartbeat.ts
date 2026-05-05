import type { Channel } from './types.js';
import { logger } from './logger.js';

/**
 * Telegram's `sendChatAction("typing")` renders "Daystrom is typing..."
 * for ~5 seconds. Single-shot calls die mid-run. This module refreshes
 * the indicator every 4 seconds for the full agent lifecycle so JT
 * never sees silent waiting on long-running messages.
 *
 * Independent of slow-skill-ack — that module owns the immediate ack
 * message + its own heartbeat for slow-skill commands. This module
 * covers everything else (regular Q&A, replies, etc.). Parallel timers
 * during slow-skill commands are harmless: sendChatAction is idempotent
 * server-side, and the cost is one extra API call per 4s for the
 * duration of slow-skill runs.
 */

const HEARTBEAT_INTERVAL_MS = 4000;
// 30-min hard cap defends against leak if the caller forgets to invoke
// the returned stop fn. Generous enough for a real /wiki-ingest run
// (20-40 min observed) without dropping the indicator mid-run on healthy
// long jobs.
const HARD_TIMEOUT_MS = 30 * 60 * 1000;

const _heartbeats = new Map<string, ReturnType<typeof setInterval>>();
const _hardTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Start a typing-indicator heartbeat for `jid` on `channel`. Returns a
 * stop function the caller MUST invoke at agent-finish. Safe to call
 * multiple times for the same jid — clobbers any prior heartbeat.
 *
 * No-op if the channel doesn't implement `setTyping` (web channel
 * currently does, telegram channel does, hypothetical future channels
 * may opt out).
 */
export function startTypingHeartbeat(
  jid: string,
  channel: Channel,
): () => void {
  if (!channel.setTyping) return () => {};

  const prev = _heartbeats.get(jid);
  if (prev !== undefined) {
    clearInterval(prev);
    _heartbeats.delete(jid);
  }
  const prevHard = _hardTimeouts.get(jid);
  if (prevHard !== undefined) {
    clearTimeout(prevHard);
    _hardTimeouts.delete(jid);
  }

  // Fire immediately so the indicator appears without 4s of latency.
  void channel
    .setTyping(jid, true)
    .catch((err) => logger.debug({ jid, err }, 'typing heartbeat send failed'));

  const timer = setInterval(() => {
    void channel
      .setTyping?.(jid, true)
      .catch((err) =>
        logger.debug({ jid, err }, 'typing heartbeat send failed'),
      );
  }, HEARTBEAT_INTERVAL_MS);
  _heartbeats.set(jid, timer);

  const hardTimeout = setTimeout(() => {
    clearInterval(timer);
    _heartbeats.delete(jid);
    _hardTimeouts.delete(jid);
  }, HARD_TIMEOUT_MS);
  _hardTimeouts.set(jid, hardTimeout);

  return () => {
    clearTimeout(hardTimeout);
    clearInterval(timer);
    _heartbeats.delete(jid);
    _hardTimeouts.delete(jid);
  };
}

/** @internal — test tear-down only */
export function _clearAllTypingHeartbeats(): void {
  for (const timer of _heartbeats.values()) {
    clearInterval(timer);
  }
  for (const timer of _hardTimeouts.values()) {
    clearTimeout(timer);
  }
  _heartbeats.clear();
  _hardTimeouts.clear();
}
