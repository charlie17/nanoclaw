import { Channel } from './types.js';
import { logger } from './logger.js';

const RATE_LIMIT_ALERT_MESSAGE =
  '⏳ Anthropic rate-limited the agent — SDK is in backoff retry. ' +
  'Container is alive and waiting it out; this is not a hang. ' +
  'Watchdog tolerance is 10 min from last activity.';

export const DEFAULT_RATE_LIMIT_ALERT_DELAY_MS = 5000;

const _pendingAlerts = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Debounced rate-limit alert. JT directive 2026-05-11.
 *
 * On SDK rate_limit_event, schedule a delayed send instead of firing
 * immediately. If subsequent agent activity arrives within the window
 * (cancelPendingAlert called from the SDK-event callback), the alert
 * is cancelled — the agent is making progress, no need to spam. If the
 * window elapses with no agent activity, the alert fires: the rate-limit
 * is real and the operator wants to know they're waiting.
 *
 * The observed-SDK-event signal IS the "response is forthcoming" predictor.
 */
export function schedulePendingAlert(
  jid: string,
  channel: Channel,
  delayMs: number,
): void {
  cancelPendingAlert(jid);

  const timer = setTimeout(() => {
    _pendingAlerts.delete(jid);
    void channel
      .sendMessage(jid, RATE_LIMIT_ALERT_MESSAGE)
      .catch((err: unknown) =>
        logger.warn({ jid, err }, 'Failed to send rate-limit alert'),
      );
  }, delayMs);

  _pendingAlerts.set(jid, timer);
}

export function cancelPendingAlert(jid: string): void {
  const timer = _pendingAlerts.get(jid);
  if (timer !== undefined) {
    clearTimeout(timer);
    _pendingAlerts.delete(jid);
  }
}

/** @internal — test tear-down only */
export function _clearAllPendingAlerts(): void {
  for (const timer of _pendingAlerts.values()) {
    clearTimeout(timer);
  }
  _pendingAlerts.clear();
}

/** @internal — test introspection only */
export function _hasPendingAlert(jid: string): boolean {
  return _pendingAlerts.has(jid);
}
