import { Channel } from './types.js';
import { logger } from './logger.js';

const SLOW_SKILL_RE =
  /^\s*\/(research|wiki-ingest|wiki-lint|wiki-query|wiki-scan|moc-refresh|nightly-report|weekly-review|widget)\b/;
const HEARTBEAT_INTERVAL_MS = 4000;
const TOPIC_MAX_LEN = 50;
const HARD_TIMEOUT_MS = 5 * 60 * 1000;

const _heartbeats = new Map<string, ReturnType<typeof setInterval>>();

/**
 * Slow-skill acknowledgement + heartbeat for Daystrom Telegram inbound.
 * Fires immediate "Got it" ack on slow-skill commands and keeps Telegram's
 * typing indicator live via a 4s heartbeat until the agent responds.
 * JT Impl-31 D3 gap fix — 2+ min /research synthesis no longer silent.
 */
export function startSlowSkillAck(
  jid: string,
  channel: Channel,
  lastMessage: string,
): () => void {
  const match = SLOW_SKILL_RE.exec(lastMessage);
  if (!match) return () => {};

  const cmdName = match[1];
  const rawTopic = lastMessage
    .replace(/^\s*\/\S+\s*/, '')
    .trim()
    .slice(0, TOPIC_MAX_LEN);
  const topic = rawTopic || `your ${cmdName} request`;
  const ack = `Got it — working on ${topic} now. I'll ping back when it's ready.`;

  const existing = _heartbeats.get(jid);
  if (existing !== undefined) {
    clearInterval(existing);
    _heartbeats.delete(jid);
  }

  if (channel.name === 'telegram') {
    void channel
      .sendMessage(jid, ack)
      .catch((err) => logger.debug({ err, jid }, 'slow-skill ack send failed'));
  }

  channel.setTyping?.(jid, true);

  const timer = setInterval(() => {
    channel.setTyping?.(jid, true);
  }, HEARTBEAT_INTERVAL_MS);

  _heartbeats.set(jid, timer);

  const hardTimeout = setTimeout(() => {
    clearInterval(timer);
    _heartbeats.delete(jid);
  }, HARD_TIMEOUT_MS);

  return () => {
    clearTimeout(hardTimeout);
    clearInterval(timer);
    _heartbeats.delete(jid);
  };
}

/** @internal — test tear-down only */
export function _clearAllHeartbeats(): void {
  for (const timer of _heartbeats.values()) {
    clearInterval(timer);
  }
  _heartbeats.clear();
}
