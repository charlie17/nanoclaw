import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'TZ',
  'NANOCLAW_WEB_PORT',
  'NANOCLAW_WEB_HOST',
  'NANOCLAW_TOKEN',
  'WIDGET_FEEDBACK_TOKEN',
  'NANOCLAW_ANTHROPIC_RATE_PER_DISPATCH',
  'RATE_LIMIT_ALERT_DELAY_MS',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Rate-limit alert debounce window. On SDK rate_limit_event, defer sending
// the operator alert by this many ms; if any subsequent SDK activity arrives
// from the agent within the window, cancel the alert (the agent is making
// progress, no need to spam). If the window elapses with no activity, fire
// the alert — the rate-limit is real. Default 5000ms per JT directive
// 2026-05-11. Override via RATE_LIMIT_ALERT_DELAY_MS in .env.
export const RATE_LIMIT_ALERT_DELAY_MS = parseInt(
  process.env.RATE_LIMIT_ALERT_DELAY_MS ||
    envConfig.RATE_LIMIT_ALERT_DELAY_MS ||
    '5000',
  10,
);

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();

// Explicit ET timezone for one-shot reminder scheduling (Impl-74).
// Intentionally separate from TIMEZONE — TIMEZONE resolves to UTC on this
// VPS (host clock UTC, no TZ env var), which is correct for cron expressions
// that are hand-authored in UTC. One-shot reminders receive naive ET
// wall-clock strings from the skill and must be converted deterministically
// using this fixed zone — never via TIMEZONE.
export const REMINDER_TIMEZONE = 'America/New_York';

// JT: Batch 2.3 D-CU4 — claude-usage dashboard port (localhost-only; Bridge reverse-proxies to it per D-CU2)
export const CLAUDE_USAGE_PORT = parseInt(
  process.env.CLAUDE_USAGE_PORT || '8080',
  10,
);

// JT: Batch 2.5 D-2.5.3 — Open WebUI port (localhost-only; Bridge reverse-proxies at /dash/private)
export const OWUI_PORT = parseInt(process.env.OWUI_PORT || '8081', 10);

// Bridge web channel — spec §5.5 (D-91, Impl-16, 2026-04-16)
export const NANOCLAW_WEB_PORT = parseInt(
  process.env.NANOCLAW_WEB_PORT || envConfig.NANOCLAW_WEB_PORT || '3099',
  10,
);
export const NANOCLAW_WEB_HOST =
  process.env.NANOCLAW_WEB_HOST || envConfig.NANOCLAW_WEB_HOST || '127.0.0.1';
export const NANOCLAW_TOKEN =
  process.env.NANOCLAW_TOKEN || envConfig.NANOCLAW_TOKEN || '';
// Impl-73 Step 3 — Bridge-process auth secret for POST /widget/feedback (Plane C).
// Host-side only (like NANOCLAW_TOKEN above): never injected into a container — so it
// belongs here, not in the credential proxy. Empty ⇒ the feedback route fails closed (503).
export const WIDGET_FEEDBACK_TOKEN =
  process.env.WIDGET_FEEDBACK_TOKEN || envConfig.WIDGET_FEEDBACK_TOKEN || '';
// JT: Impl-26 Batch 3.1c — dual-usage $ rate for /dash/api-usage display.
// Source: V6 Impl-25/26 scoped-key billing (2 dispatches × ~$0.20/dispatch observed).
// Tune via .env as runtime data accumulates.
export const NANOCLAW_ANTHROPIC_RATE_PER_DISPATCH = parseFloat(
  process.env.NANOCLAW_ANTHROPIC_RATE_PER_DISPATCH ||
    envConfig.NANOCLAW_ANTHROPIC_RATE_PER_DISPATCH ||
    '0.20',
);
