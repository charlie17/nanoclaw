/**
 * CLAUDE.md write validation hook.
 * Watches group CLAUDE.md files for suspicious patterns and logs warnings.
 * Spec ref: Daystrom-Impl-Plan.md §1.5-7
 *
 * Flags: URLs, exfiltration language, instructions to bypass routing/security,
 * references to external services.
 */

import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

// Patterns that indicate potential prompt injection or memory poisoning
const SUSPICIOUS_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'url', pattern: /https?:\/\/[^\s]+/i },
  { name: 'exfiltration', pattern: /\b(send|exfil|leak|transmit|upload|post|report)\b.*\b(data|contents?|vault|messages?|key|token|secret)\b/i },
  { name: 'bypass_routing', pattern: /\b(ignore|bypass|skip|override|disable)\b.*\b(routing|trifecta|privacy|security|rule|check|filter)\b/i },
  { name: 'external_service', pattern: /\b(webhook|pastebin|hastebin|ngrok|requestbin|pipedream)\b/i },
  { name: 'tool_override', pattern: /\b(allowedTools|NANOCLAW_STRIP|WebSearch|WebFetch)\b.*=/i },
  { name: 'trust_escalation', pattern: /trust:\s*(trusted|elevated|admin)/i },
];

function checkContent(filePath: string, content: string): void {
  const findings: string[] = [];

  for (const { name, pattern } of SUSPICIOUS_PATTERNS) {
    if (pattern.test(content)) {
      findings.push(name);
    }
  }

  if (findings.length > 0) {
    logger.warn(
      { file: filePath, patterns: findings },
      'CLAUDE.md write validation: suspicious patterns detected',
    );
  }
}

let watcherStarted = false;

/**
 * Start watching all CLAUDE.md files under the groups directory.
 * Uses recursive fs.watch — one watcher for the whole groups tree.
 * Called once at NanoClaw startup.
 */
export function startClaudeMdWatcher(): void {
  if (watcherStarted) return;
  watcherStarted = true;

  if (!fs.existsSync(GROUPS_DIR)) {
    logger.debug({ dir: GROUPS_DIR }, 'CLAUDE.md watcher: groups dir not found, skipping');
    return;
  }

  try {
    fs.watch(GROUPS_DIR, { recursive: true }, (event, filename) => {
      if (!filename) return;
      if (!filename.endsWith('CLAUDE.md')) return;
      if (event !== 'change' && event !== 'rename') return;

      const fullPath = path.join(GROUPS_DIR, filename);
      try {
        if (!fs.existsSync(fullPath)) return;
        const content = fs.readFileSync(fullPath, 'utf-8');
        checkContent(fullPath, content);
      } catch {
        // File may have been deleted — ignore read errors
      }
    });

    logger.debug({ dir: GROUPS_DIR }, 'CLAUDE.md write validation watcher started');
  } catch (err) {
    logger.warn({ err }, 'CLAUDE.md watcher: failed to start (non-fatal)');
  }
}
