import { Channel } from './types.js';
import { logger } from './logger.js';

// `/widget` is host-acked on BOTH message paths (FU-2 D2/D3): the cold-start
// (spawn) path here, AND the warm pipe path in index.ts which now also calls
// startSlowSkillAck. The ack is deterministic host-side — the widget skill no
// longer emits its own building line (FU-2 D1: guarantee in code, not prose).
const SLOW_SKILL_RE =
  /^\s*\/(research|widget|wiki-ingest|wiki-lint|wiki-query|wiki-scan|moc-refresh|nightly-report|weekly-review)\b/;
const HEARTBEAT_INTERVAL_MS = 4000;
const TOPIC_MAX_LEN = 50;
const HARD_TIMEOUT_MS = 5 * 60 * 1000;

type Heartbeat = {
  timer: ReturnType<typeof setInterval>;
  hardTimeout: ReturnType<typeof setTimeout>;
};

const _heartbeats = new Map<string, Heartbeat>();

/**
 * Clear a jid's heartbeat (interval + hard-timeout) and drop it from the map.
 * Pass `only` to make it identity-scoped: a stale `stop()` closure from a call
 * that was already superseded becomes a safe no-op (it won't clear the newer
 * heartbeat). Without `only`, clears whatever heartbeat the jid currently holds
 * (used for clear-on-next-call). Tracking the hard-timeout here — not just in a
 * closure — is what stops the warm pipe path (fire-and-forget, no stop() call)
 * from leaking orphaned timeouts in _heartbeats. (FU-2 D3.)
 */
function clearHeartbeat(jid: string, only?: Heartbeat): void {
  const existing = _heartbeats.get(jid);
  if (existing === undefined) return;
  if (only !== undefined && existing !== only) return;
  clearInterval(existing.timer);
  clearTimeout(existing.hardTimeout);
  _heartbeats.delete(jid);
}

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

  // Clear any prior heartbeat for this jid before starting a new one. The warm
  // pipe path (index.ts) calls this fire-and-forget on every piped message, so
  // a stale heartbeat must never accumulate. (FU-2 D3.)
  clearHeartbeat(jid);

  if (channel.name === 'telegram') {
    void channel
      .sendMessage(jid, ack)
      .catch((err) => logger.debug({ err, jid }, 'slow-skill ack send failed'));
  }

  channel.setTyping?.(jid, true);

  const timer = setInterval(() => {
    channel.setTyping?.(jid, true);
  }, HEARTBEAT_INTERVAL_MS);

  const entry = { timer } as Heartbeat;
  entry.hardTimeout = setTimeout(
    () => clearHeartbeat(jid, entry),
    HARD_TIMEOUT_MS,
  );
  _heartbeats.set(jid, entry);

  return () => clearHeartbeat(jid, entry);
}

/** @internal — test tear-down only */
export function _clearAllHeartbeats(): void {
  for (const { timer, hardTimeout } of _heartbeats.values()) {
    clearInterval(timer);
    clearTimeout(hardTimeout);
  }
  _heartbeats.clear();
}
