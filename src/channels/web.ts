// Bridge — Daystrom's web chat channel. v2-authored per D-91 (Impl-16, 2026-04-16).
// See three-man-team/handoff/BRIDGE-BUILD-SPEC.md for the spec.
// Specific patterns lifted from rozek/nanoclaw@9311ff1 with inline attribution
// ("Pattern from rozek/nanoclaw@9311ff1 — <purpose>"). Bulk authorship is ours.

import { execFile as execFileRaw } from 'node:child_process';
import crypto from 'crypto';
import http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import net from 'net';
import type { AddressInfo } from 'net';
import { readFile, readdir, stat, statfs, writeFile } from 'node:fs/promises';
import os from 'os';
import path from 'node:path';

import {
  ASSISTANT_NAME,
  CLAUDE_USAGE_PORT,
  CREDENTIAL_PROXY_PORT,
  NANOCLAW_ANTHROPIC_RATE_PER_DISPATCH,
  NANOCLAW_TOKEN,
  NANOCLAW_WEB_HOST,
  NANOCLAW_WEB_PORT,
} from '../config.js';
// JT: D-93 — added getConversation (display-history) + storeMessage (bot-reply persistence)
// JT: Impl-26 Batch 3.1c — added getMessageCountForMonth (OAuth monthly counter for /dash/api-usage)
import {
  clearChatMessages,
  deleteChat,
  deleteMessage,
  getAllChats,
  getConversation,
  getMessageCountForMonth,
  getMessagesSince,
  setRouterState,
  storeChatMetadata,
  ensureChatExists,
  storeMessage,
  updateChatName,
} from '../db.js';
import type { ChatInfo } from '../db.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { registerChannel } from './registry.js';
import type { ChannelOpts } from './registry.js';
// JT: Channel, NewMessage, RegisteredGroup from src/types.ts — upstream-owned shapes
import type { Channel, NewMessage } from '../types.js';

// ── Constants ───────────────────────────────────────────────────────────────

const BODY_LIMIT = 1_048_576; // 1 MB non-upload body cap — D-S1.14
const UPLOAD_BODY_LIMIT = 10_000_000; // 10 MB base64 upload cap — D-S2.2
const SSE_HEARTBEAT_MS = 20_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_IP_CAP = 1000;
// D-V52.5: 5 min — Opus /research + /brainstorm latency can reach 60-180s; matches slow-skill-ack hard cap
export const TYPING_TIMEOUT_MS = 300_000;
const HISTORY_LIMIT = 500;
const SESSION_ORDER_MAX = 500;
const SID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const RESERVED_SID = 'cron';
const DASH_CACHE_TTL_MS = 5_000; // D-S3.10
// D-S1.13
// Impl-50 fold #3: script-src adds https://cdn.jsdelivr.net for Chart.js used by the embedded
// claude-usage dashboard (D-CU2 reverse-proxy at /dash/usage). claude-usage's SPA loads
// Chart.js from CDN (`<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/...">`).
// Without this allowance the browser blocks the CDN load and chart canvases render blank.
const CSP =
  "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data:";

// D-S2.3 — extension allowlist (case-insensitive; .tar.gz checked separately via endsWith)
const ALLOWED_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.heic',
  '.pdf',
  '.md',
  '.txt',
  '.csv',
  '.json',
  '.yaml',
  '.yml',
  '.docx',
  '.pptx',
  '.xlsx',
  '.zip',
  '.tar.gz',
]);

// D-S2.6 — quarantine marker for explicit reject (C3 — belt-and-suspenders over infra exclusion)
const QUARANTINE_MARKER = path.sep + 'quarantine' + path.sep;

class BodyTooLargeError extends Error {}

// ── Exported pure helpers (tested in web.test.ts) ───────────────────────────

// Pattern from rozek/nanoclaw@9311ff1 — session-ID whitelist regex + 64-char cap
export function sanitizeSid(raw: string | undefined): string | null {
  if (!raw || !SID_RE.test(raw) || raw === RESERVED_SID) return null;
  return raw;
}

export function validateBridgeConfig(host: string, token: string): void {
  const isLoopback =
    host === '127.0.0.1' || host === '::1' || host === 'localhost';
  if (!isLoopback && !token) {
    throw new Error(
      'Bridge requires NANOCLAW_TOKEN when bound to non-loopback host',
    );
  }
}

// Pattern from rozek/nanoclaw@9311ff1 — timing-safe token comparison (avoids === timing leak)
export function checkToken(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

// Pattern from rozek/nanoclaw@9311ff1 — sanitize-name (Unicode control strip, L7)
export function sanitizeFilename(raw: string): string | null {
  let s = raw
    .replace(/\p{Cc}/gu, '') // strip Unicode control chars
    .replace(/[/\\]/g, ''); // strip path separators
  s = path.basename(s); // belt: strip any remaining directory component
  s = s.trim().replace(/\s+/g, ' '); // trim + collapse whitespace
  if (s.length > 200) s = s.slice(0, 200);
  return s.length > 0 ? s : null;
}

// D-S2.3 — extension allowlist check (C1: called before any fs op)
export function isAllowedExtension(filename: string): boolean {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.tar.gz')) return true;
  return ALLOWED_EXTENSIONS.has(path.extname(lower));
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function jidFromSid(sid: string): string {
  return `local@web-${sid}`;
}

function sidFromJid(jid: string): string | null {
  if (!jid.startsWith('local@web-')) return null;
  const sid = jid.slice('local@web-'.length);
  return sid || null;
}

// Pattern from rozek/nanoclaw@9311ff1 — body-size enforcement with drain on oversize
function collectBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.resume();
        reject(new BodyTooLargeError('Payload Too Large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => reject(err));
  });
}

// Pattern from rozek/nanoclaw@9311ff1 — broadcast to all SSE clients of a session with try/catch + prune
function broadcastToSession(
  clientsBySid: Map<string, Set<ServerResponse>>,
  sid: string,
  event: string,
  data: string,
): void {
  const clients = clientsBySid.get(sid);
  if (!clients || clients.size === 0) return;
  const payload = `event: ${event}\ndata: ${data}\n\n`;
  for (const res of [...clients]) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

function parseCookie(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null; // malformed percent-escape — treat as no cookie
      }
    }
  }
  return null;
}

// ── Dashboard metric types ────────────────────────────────────────────────────

interface Container {
  name: string;
  state: string;
}

interface HostMetrics {
  uptime_sec: number;
  load_avg: [number, number, number];
  mem: { total_bytes: number; free_bytes: number; used_pct: number };
  disk: {
    mount: string;
    total_bytes: number;
    free_bytes: number;
    used_pct: number;
  } | null;
}

interface VaultFolderEntry {
  folder: string;
  file_count: number;
  last_modified: string;
}

interface VaultStatsPayload {
  vault_root: string;
  total_files: number;
  by_folder: VaultFolderEntry[];
  collected_at: string;
  error?: string;
}

// dashCache and dashHealthLoggedOnce live on WebChannel instance — see class below

// ── Dashboard metric collectors ───────────────────────────────────────────────

function runExecFile(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileRaw(
      cmd,
      args,
      { timeout: timeoutMs, encoding: 'utf8' },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout as string);
      },
    );
  });
}

async function collectHostMetrics(): Promise<HostMetrics> {
  const load_avg = os.loadavg() as [number, number, number]; // [0,0,0] on Windows — D-S3.6
  const total_bytes = os.totalmem();
  const free_bytes = os.freemem();
  const used_pct = Math.round(((total_bytes - free_bytes) / total_bytes) * 100);
  const uptime_sec = Math.round(os.uptime());

  let disk: HostMetrics['disk'] = null;
  try {
    const sf = await statfs('/');
    const total_disk = sf.blocks * sf.bsize;
    const free_disk = sf.bavail * sf.bsize;
    if (total_disk > 0) {
      disk = {
        mount: '/',
        total_bytes: total_disk,
        free_bytes: free_disk,
        used_pct: Math.round(((total_disk - free_disk) / total_disk) * 100),
      };
    }
  } catch {
    // statfs unavailable — fall back to df -B1 / (D-S3.6)
    try {
      const dfOut = await runExecFile('df', ['-B1', '/'], 500);
      const lines = dfOut.trim().split('\n');
      if (lines.length >= 2) {
        const parts = lines[1].trim().split(/\s+/);
        if (parts.length >= 4) {
          const totalDf = parseInt(parts[1], 10);
          const usedDf = parseInt(parts[2], 10);
          const availDf = parseInt(parts[3], 10);
          if (!isNaN(totalDf) && totalDf > 0 && !isNaN(availDf)) {
            disk = {
              mount: '/',
              total_bytes: totalDf,
              free_bytes: availDf,
              used_pct: Math.round((usedDf / totalDf) * 100),
            };
          }
        }
      }
    } catch {
      disk = null; // both paths failed — D-S3.6
    }
  }

  return {
    uptime_sec,
    load_avg,
    mem: { total_bytes, free_bytes, used_pct },
    disk,
  };
}

// Returns null on timeout/error (caller maps to degraded status) — D-S3.7
async function collectContainerStatus(): Promise<Container[] | null> {
  try {
    const out = await runExecFile(
      'docker',
      ['ps', '--format', '{{.Names}},{{.State}}'],
      800,
    );
    const containers: Container[] = [];
    for (const line of out.trim().split('\n')) {
      if (!line.trim()) continue;
      const comma = line.indexOf(',');
      if (comma === -1) continue;
      const name = line.slice(0, comma).trim();
      const state = line.slice(comma + 1).trim();
      if (name) containers.push({ name, state });
    }
    return containers;
  } catch {
    logger.warn(
      '[bridge] Container inspect failed — docker ps timeout or error',
    );
    return null;
  }
}

// TCP probe only — no HTTP request to avoid triggering D-90 body-rule — D-S3.8
function probeProxyReachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 300);
    socket.on('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function countFilesRecursive(
  dir: string,
): Promise<{ count: number; maxMtimeMs: number }> {
  let count = 0;
  let maxMtimeMs = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile()) {
      count++;
      try {
        const st = await stat(fullPath);
        if (st.mtimeMs > maxMtimeMs) maxMtimeMs = st.mtimeMs;
      } catch {
        // stat failure — skip this file's mtime
      }
    } else if (entry.isDirectory()) {
      try {
        const sub = await countFilesRecursive(fullPath);
        count += sub.count;
        if (sub.maxMtimeMs > maxMtimeMs) maxMtimeMs = sub.maxMtimeMs;
      } catch {
        // inaccessible subdirectory — skip
      }
    }
  }
  return { count, maxMtimeMs };
}

async function collectVaultStats(
  vaultRoot: string,
): Promise<VaultStatsPayload> {
  const collected_at = new Date().toISOString();

  let topFolders: string[];
  try {
    const entries = await readdir(vaultRoot, { withFileTypes: true });
    topFolders = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return {
      vault_root: vaultRoot,
      total_files: 0,
      by_folder: [],
      collected_at,
      error: 'vault root not found',
    };
  }

  const by_folder: VaultFolderEntry[] = [];
  let total_files = 0;

  for (const folder of topFolders) {
    const folderPath = path.join(vaultRoot, folder);
    try {
      const { count, maxMtimeMs } = await countFilesRecursive(folderPath);
      total_files += count;
      by_folder.push({
        folder,
        file_count: count,
        last_modified: maxMtimeMs > 0 ? new Date(maxMtimeMs).toISOString() : '',
      });
    } catch {
      // missing folder — omit row per D-S3.4
    }
  }

  return { vault_root: vaultRoot, total_files, by_folder, collected_at };
}

let rateLimitFirstReadLogged = false; // D-S4.20 once-on-first-read guard

// D-S4.15: reads ~/daystrom-ops/state/rate-limit-state.json written by laforge-rate-watch
async function collectRateLimit(): Promise<{
  state: string;
  since: string;
  last_hit_at: string | null;
} | null> {
  const statePath = path.join(
    os.homedir(),
    'daystrom-ops',
    'state',
    'rate-limit-state.json',
  );
  let raw: string;
  try {
    raw = await readFile(statePath, 'utf8');
  } catch {
    return null;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    logger.warn(
      '[bridge] /dash/health: rate-limit state file JSON parse error',
    );
    return null;
  }
  if (
    (parsed['state'] !== 'ok' && parsed['state'] !== 'rate-limited') ||
    typeof parsed['since'] !== 'string' ||
    !Number.isFinite(Date.parse(parsed['since'] as string))
  ) {
    return null;
  }
  const lastHitAtRaw = parsed['last_hit_at'];
  const lastHitAt =
    typeof lastHitAtRaw === 'string' &&
    Number.isFinite(Date.parse(lastHitAtRaw))
      ? lastHitAtRaw
      : null;
  if (!rateLimitFirstReadLogged) {
    rateLimitFirstReadLogged = true;
    logger.info(
      '[bridge] /dash/health: rate-limit state file first successful read',
    );
  }
  logger.debug('[bridge] /dash/health: rate_limit populated from state file');
  return {
    state: parsed['state'] as string,
    since: parsed['since'] as string,
    last_hit_at: lastHitAt,
  };
}

// ── SPA HTML ─────────────────────────────────────────────────────────────────

/* eslint-disable no-useless-escape */
const SPA_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<title>Bridge \u2014 ${ASSISTANT_NAME}</title>
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/static/apple-touch-icon.png">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#fff;--fg:#111;--sb:#f4f4f5;--bub-u:#0a84ff;--bub-b:#e9e9eb;--bub-bf:#111;--in-bg:#f0f0f0;--bd:#ddd}
@media(prefers-color-scheme:dark){:root{--bg:#1c1c1e;--fg:#f2f2f7;--sb:#2c2c2e;--bub-b:#3a3a3c;--bub-bf:#f2f2f7;--in-bg:#2c2c2e;--bd:#444}}
body.dark{--bg:#1c1c1e;--fg:#f2f2f7;--sb:#2c2c2e;--bub-b:#3a3a3c;--bub-bf:#f2f2f7;--in-bg:#2c2c2e;--bd:#444}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--fg);height:100dvh;display:flex;flex-direction:column;overflow:hidden}
#login-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:100}
.lcard{background:var(--bg);border-radius:14px;padding:2rem;width:min(320px,90vw);display:flex;flex-direction:column;gap:.75rem;box-shadow:0 8px 32px rgba(0,0,0,.25)}
.lcard h2{font-size:1.15rem;text-align:center;font-weight:600}
.lcard input{padding:.6rem .8rem;border:1px solid var(--bd);border-radius:8px;background:var(--in-bg);color:var(--fg);font-size:1rem;width:100%}
.lcard button{padding:.65rem;border:none;border-radius:8px;background:var(--bub-u);color:#fff;font-size:1rem;cursor:pointer;font-weight:500}
.lerr{color:#ff3b30;font-size:.85rem;min-height:1.1rem}
#app{flex:1;display:none;overflow:hidden;flex-direction:row}
#app.show{display:flex}
#sidebar{width:220px;background:var(--sb);border-right:1px solid var(--bd);display:flex;flex-direction:column;flex-shrink:0}
#sh{display:flex;align-items:center;justify-content:space-between;padding:.7rem .75rem;border-bottom:1px solid var(--bd);font-weight:600;font-size:.9rem}
#new-btn{border:none;background:none;color:var(--bub-u);font-size:1.5rem;cursor:pointer;line-height:1;padding:0 .1rem}
#sa-btn{border:none;background:none;color:var(--fg);font-size:.85rem;cursor:pointer;line-height:1;padding:0 .3rem;opacity:.55}
#sa-btn.active{color:var(--bub-u);opacity:1}
#sl{flex:1;overflow-y:auto;padding:.25rem 0}
.si{padding:.55rem .75rem;cursor:default;font-size:.88rem;border-radius:6px;margin:.1rem .3rem;display:flex;align-items:center;gap:.2rem}
.si:hover{background:var(--in-bg)}
.si.active{background:var(--bub-u);color:#fff}
.si-lbl{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;cursor:pointer}
.si-acts{display:flex;visibility:hidden;flex-shrink:0;gap:.1rem}
.si:hover .si-acts,.si.active .si-acts{visibility:visible}
.si-btn{border:none;background:none;cursor:pointer;font-size:.75rem;padding:.15rem .25rem;opacity:.55;border-radius:3px;color:inherit;line-height:1}
.si-btn:hover{opacity:1;background:rgba(0,0,0,.1)}
.si.active .si-btn:hover{background:rgba(255,255,255,.2)}
#sf{padding:.5rem .75rem;border-top:1px solid var(--bd);display:flex;justify-content:space-between;gap:.25rem}
#dm-btn,#lo-btn{border:none;background:none;cursor:pointer;font-size:1.1rem;padding:.2rem;color:inherit}
#chat{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
#msgs{flex:1;overflow-y:auto;padding:.75rem 1rem;display:flex;flex-direction:column;gap:.4rem;max-width:880px;width:100%;margin-inline:auto;box-sizing:border-box}
.m{max-width:78%;padding:.45rem .75rem;border-radius:14px;font-size:.94rem;line-height:1.45;white-space:pre-wrap;word-break:break-word;position:relative}
.m code{background:rgba(0,0,0,.08);padding:.05rem .3rem;border-radius:4px;font-family:ui-monospace,'SF Mono',Consolas,monospace;font-size:.88em}
.m pre{background:rgba(0,0,0,.08);padding:.5rem;border-radius:6px;overflow-x:auto;margin:.4rem 0;white-space:pre}
.m pre code{background:none;padding:0;font-size:.85em}
.m a{color:inherit;text-decoration:underline}
body.dark .m code,body.dark .m pre{background:rgba(255,255,255,.1)}
.m.u{align-self:flex-end;background:var(--bub-u);color:#fff;border-bottom-right-radius:4px}
.m.b{align-self:flex-start;background:var(--bub-b);color:var(--bub-bf);border-bottom-left-radius:4px}
.m-del{position:absolute;top:-.35rem;right:-.35rem;display:none;border:none;border-radius:50%;width:1.1rem;height:1.1rem;background:var(--bd);color:var(--fg);font-size:.65rem;cursor:pointer;align-items:center;justify-content:center;padding:0;line-height:1}
.m:hover .m-del{display:flex}
#typing{padding:.35rem 1rem;font-size:.95rem;font-style:italic;opacity:.8;display:none}
#ia{padding:.65rem .75rem .9rem;border-top:1px solid var(--bd);display:flex;gap:.5rem;align-items:flex-end;max-width:880px;width:100%;margin-inline:auto;box-sizing:border-box}
#up-lbl{cursor:pointer;padding:.5rem .55rem;border:1px solid var(--bd);border-radius:12px;font-size:.95rem;flex-shrink:0;user-select:none;line-height:1}
#inp{flex:1;padding:.5rem .7rem;border:1px solid var(--bd);border-radius:12px;background:var(--in-bg);color:var(--fg);font-size:.95rem;resize:none;line-height:1.4;max-height:120px;font-family:inherit}
#cancel-btn{padding:.5rem .7rem;border:1px solid var(--bd);border-radius:12px;background:none;color:var(--fg);cursor:pointer;font-size:.88rem;flex-shrink:0;display:none}
#send{padding:.5rem 1rem;border:none;border-radius:12px;background:var(--bub-u);color:#fff;cursor:pointer;font-size:.94rem;flex-shrink:0;font-weight:500}
#send:disabled,#inp:disabled,#cancel-btn:disabled{opacity:.45;cursor:default}
#app.show{display:flex;flex-direction:column}
#tnav{display:flex;gap:.35rem;padding:.35rem .6rem;border-bottom:1px solid var(--bd);flex-shrink:0}
.nb{border:none;background:none;cursor:pointer;font-size:.85rem;padding:.25rem .65rem;border-radius:6px;color:var(--fg);opacity:.55;font-weight:500}
.nb.active{background:var(--bub-u);color:#fff;opacity:1}
#ca{flex:1;display:flex;flex-direction:row;overflow:hidden;min-width:0}
#app.view-dash #ca{display:none}
#dash-panel{flex:1;overflow-y:auto;padding:1rem;display:none;max-width:880px;width:100%;margin-inline:auto;box-sizing:border-box}
#app.view-dash #dash-panel{display:block}
.dc{background:var(--sb);border:1px solid var(--bd);border-radius:10px;margin:0 auto .75rem;max-width:520px}
.dch{padding:.55rem .85rem;font-weight:600;font-size:.88rem;border-bottom:1px solid var(--bd)}
.dcb{padding:.7rem .85rem;font-size:.85rem;line-height:1.55}
.dcf{padding:.3rem .85rem;font-size:.76rem;opacity:.5;border-top:1px solid var(--bd)}
.dr{display:grid;grid-template-columns:auto 1fr;gap:1.5rem;padding:.1rem 0;align-items:baseline}
.dr>:nth-child(2){text-align:right}
.dk{opacity:.65}
.dcb a{color:inherit}
#sb-scrim{display:none}
#sb-toggle{display:none;border:none;background:none;cursor:pointer;font-size:1.2rem;padding:.25rem .5rem;color:var(--fg)}
#msgs>.m:first-child{margin-top:auto}
@media(max-width:768px){
#sidebar{position:absolute;top:0;bottom:0;left:0;width:80vw;max-width:280px;transform:translateX(-100%);transition:transform .25s;z-index:50}
#sidebar.open{transform:translateX(0)}
#sb-scrim{display:none;position:absolute;inset:0;background:rgba(0,0,0,.45);z-index:40}
#sidebar.open~#sb-scrim{display:block}
#sb-toggle{display:inline-block;min-width:44px;min-height:44px;font-size:1.5rem;padding:.5rem}
#ca{position:relative}
.si{min-height:44px;align-items:center}
.si-acts{visibility:visible}
.si-btn{min-width:44px;min-height:44px;display:inline-flex;align-items:center;justify-content:center;font-size:1rem;padding:.4rem}
.si-acts .si-btn:nth-child(1),.si-acts .si-btn:nth-child(2){display:none}
#dm-btn,#lo-btn{min-width:44px;min-height:44px;font-size:1.3rem;padding:.5rem}
#sf{padding:.5rem .5rem;gap:.4rem}
.nb{min-height:44px;font-size:1rem;padding:.5rem 1rem}
}
</style>
</head>
<body>
<div id="login-overlay">
  <div class="lcard">
    <h2>Bridge \u2014 ${ASSISTANT_NAME}</h2>
    <input type="password" id="tok" placeholder="Access token" autocomplete="current-password">
    <button id="sign-in">Sign in</button>
    <p class="lerr" id="lerr"></p>
  </div>
</div>
<div id="app">
  <div id="tnav">
    <button id="sb-toggle" title="Menu">☰</button>
    <button class="nb active" id="nav-chat">Chat</button>
    <button class="nb" id="nav-dash">Dash</button>
  </div>
  <div id="ca">
    <div id="sidebar">
      <div id="sh"><span>Chats</span><button id="sa-btn" title="Toggle archived chats — auto-hidden when default-named (Chat xxxx) and inactive 7+ days. Renamed chats always visible.">⊕</button><button id="new-btn" title="New chat">+</button></div>
      <div id="sl"></div>
      <div id="sf"><button id="lo-btn" title="Logout">Logout</button><button id="dm-btn" title="Toggle dark mode">\u{1F31E}</button></div>
    </div>
    <div id="chat">
      <div id="msgs"></div>
      <div id="typing">${ASSISTANT_NAME} is thinking\u2026</div>
      <div id="ia">
        <label id="up-lbl" title="Attach file">\u{1F4CE}<input type="file" id="file-inp" style="display:none" accept=".jpg,.jpeg,.png,.gif,.webp,.heic,.pdf,.md,.txt,.csv,.json,.yaml,.yml,.docx,.pptx,.xlsx,.zip"></label>
        <textarea id="inp" placeholder="Message ${ASSISTANT_NAME}\u2026" rows="2"></textarea>
        <button id="cancel-btn">Cancel</button>
        <button id="send">Send</button>
      </div>
    </div>
    <div id="sb-scrim"></div>
  </div>
  <div id="dash-panel">
    <div class="dc" id="dc-health"><div class="dch">Health</div><div class="dcb" id="dc-health-body">Loading\u2026</div><div class="dcf" id="dc-health-foot"></div></div>
    <div class="dc" id="dc-vault"><div class="dch">Vault Stats</div><div class="dcb" id="dc-vault-body">Loading\u2026</div><div class="dcf" id="dc-vault-foot"></div></div>
    <div class="dc" id="dc-cost"><div class="dch">Cost</div><div class="dcb" id="dc-cost-body">Loading\u2026</div><div class="dcf" id="dc-cost-foot"></div></div>
    <div class="dc" id="dc-api-usage"><div class="dch">API Usage</div><div class="dcb" id="dc-api-usage-body">Loading\u2026</div><div class="dcf" id="dc-api-usage-foot"></div></div>
    <div class="dc" id="dc-usage-link"><div class="dch">Usage (detail)</div><div class="dcb"><a href="/dash/usage" target="_blank" rel="noreferrer" style="font-size:1.1em">&#8594; Open dashboard</a></div><div class="dcf">Token detail by model &amp; session</div></div>
  </div>
</div>
<script>
(function(){
'use strict';
var LS='bridge_sid',LD='bridge_dark';
var sid=localStorage.getItem(LS)||mkSid();localStorage.setItem(LS,sid);
var sse=null,reconDelay=1000,botDiv=null,busy=false,sessionOrder=[],showAllSessions=false;

function mkSid(){var a=new Uint8Array(8);crypto.getRandomValues(a);return Array.from(a,function(b){return b.toString(16).padStart(2,'0')}).join('');}

var dark=localStorage.getItem(LD);
if(dark==='dark'||(dark===null&&matchMedia('(prefers-color-scheme:dark)').matches))document.body.classList.add('dark');
document.getElementById('dm-btn').onclick=function(){var d=document.body.classList.toggle('dark');localStorage.setItem(LD,d?'dark':'light');};
document.getElementById('lo-btn').onclick=async function(){if(!confirm('Log out of Bridge? You will need to re-enter your access token to sign back in.'))return;var r=await fetch('/auth/logout',{method:'POST'});if(r.ok){localStorage.removeItem(LS);location.reload();}else{alert('Logout failed');}};
var sb=document.getElementById('sidebar'),scrim=document.getElementById('sb-scrim');
document.getElementById('sb-toggle').onclick=function(){sb.classList.toggle('open');};
scrim.onclick=function(){sb.classList.remove('open');};


var overlay=document.getElementById('login-overlay'),app=document.getElementById('app');
function showApp(){overlay.style.display='none';app.classList.add('show');init();}
function showLogin(m){overlay.style.display='';app.classList.remove('show');document.getElementById('lerr').textContent=m||'';}

document.getElementById('sign-in').onclick=async function(){
  var t=document.getElementById('tok').value.trim();if(!t)return;
  var r=await fetch('/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:t})});
  r.ok?showApp():showLogin('Invalid token');
};
document.getElementById('tok').addEventListener('keydown',function(e){if(e.key==='Enter')document.getElementById('sign-in').click();});

async function api(url,opts){var r=await fetch(url,opts);if(r&&r.status===401){showLogin('Session expired \u2014 please sign in again.');return null;}return r;}

async function loadSessions(){
  var r=await api('/chat/sessions'+(showAllSessions?'?showAll=1':''));if(!r)return;
  var ss=await r.json();
  if(sessionOrder.length){ss.sort(function(a,b){var ia=sessionOrder.indexOf(a.sid),ib=sessionOrder.indexOf(b.sid);if(ia===-1&&ib===-1)return 0;if(ia===-1)return 1;if(ib===-1)return -1;return ia-ib;});}
  var el=document.getElementById('sl');el.innerHTML='';
  ss.forEach(function(s){
    var row=document.createElement('div');row.className='si'+(s.sid===sid?' active':'');row.dataset.sid=s.sid;
    var lbl=document.createElement('span');lbl.className='si-lbl';lbl.textContent=displayName(s);
    lbl.onclick=function(){if(sb.classList.contains('open'))sb.classList.remove('open');if(s.sid!==sid)switchSid(s.sid);};
    lbl.ondblclick=function(e){e.stopPropagation();startRename(row,s.sid,s.name);};
    var acts=document.createElement('span');acts.className='si-acts';
    var upBtn=mk('button','si-btn','\u2191');upBtn.title='Move up';upBtn.onclick=function(e){e.stopPropagation();moveSession(s.sid,-1);};
    var dnBtn=mk('button','si-btn','\u2193');dnBtn.title='Move down';dnBtn.onclick=function(e){e.stopPropagation();moveSession(s.sid,1);};
    var delBtn=mk('button','si-btn','\xd7');delBtn.title='Delete chat';delBtn.onclick=function(e){e.stopPropagation();deleteSession(s.sid);};
    acts.appendChild(upBtn);acts.appendChild(dnBtn);acts.appendChild(delBtn);
    row.appendChild(lbl);row.appendChild(acts);el.appendChild(row);
  });
}

function mk(tag,cls,txt){var e=document.createElement(tag);e.className=cls;e.textContent=txt;return e;}

function displayName(s){
  if(/^Chat [0-9a-f]{16}$/.test(s.name)){
    var t=s.last_message_time?new Date(s.last_message_time):new Date();
    var h=t.getHours()%12||12,mm=String(t.getMinutes()).padStart(2,'0');
    return 'New chat — '+h+':'+mm+' '+(t.getHours()<12?'AM':'PM');
  }
  return s.name;
}

function maybeAutoRename(text){
  var row=document.querySelector('#sl .si[data-sid="'+sid+'"] .si-lbl');
  if(!row)return;
  if(!row.textContent.startsWith('New chat — '))return;
  var snippet=text.trim().replace(/\\s+/g,' ').slice(0,32);
  var lastSp=snippet.lastIndexOf(' ');
  if(lastSp>15)snippet=snippet.slice(0,lastSp);
  if(!snippet)return;
  api('/chat/session-name',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sid:sid,name:snippet})});
}

function startRename(row,rsid,cur){
  var lbl=row.querySelector('.si-lbl');
  var inp=document.createElement('input');inp.value=cur;
  inp.style.cssText='flex:1;min-width:0;font-size:.88rem;border:1px solid var(--bd);border-radius:4px;padding:.1rem .3rem;background:var(--in-bg);color:var(--fg)';
  lbl.replaceWith(inp);inp.focus();inp.select();
  function done(){var nm=inp.value.trim();if(!nm){inp.replaceWith(lbl);return;}
    api('/chat/session-name',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sid:rsid,name:nm})});
    lbl.textContent=nm;inp.replaceWith(lbl);}
  inp.onblur=done;
  inp.onkeydown=function(e){if(e.key==='Enter'){e.preventDefault();done();}if(e.key==='Escape'){inp.replaceWith(lbl);}};
}

function moveSession(msid,dir){
  var items=Array.from(document.querySelectorAll('#sl .si'));
  var order=items.map(function(d){return d.dataset.sid;});
  var idx=order.indexOf(msid);if(idx===-1)return;
  var ni=idx+dir;if(ni<0||ni>=order.length)return;
  order.splice(idx,1);order.splice(ni,0,msid);
  sessionOrder=order;
  loadSessions();
  api('/chat/session-order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({order:order})});
}

function setActiveSid(ns){document.querySelectorAll('#sl .si').forEach(function(row){if(row.dataset.sid===ns)row.classList.add('active');else row.classList.remove('active');});}
function switchSid(ns){sid=ns;localStorage.setItem(LS,sid);document.getElementById('msgs').innerHTML='';botDiv=null;setActiveSid(ns);loadSessions();loadHistory();connectSse();setTimeout(loadSessions,300);}

document.getElementById('sa-btn').onclick=function(){showAllSessions=!showAllSessions;this.classList.toggle('active');loadSessions();};
document.getElementById('new-btn').onclick=function(){switchSid(mkSid());};

async function loadHistory(){
  var r=await api('/chat/history?sid='+sid);if(!r)return;
  var ms=await r.json(),el=document.getElementById('msgs');el.innerHTML='';botDiv=null;
  // JT: D-93 — render from server-side cls field; eliminates pre-existing display inversion (D-S6.4)
  ms.forEach(function(m){addMsg(m.text,m.cls==='bot'?'b':'u',m.id);});
}

function escHtml(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
function md(s){
  var h=escHtml(s);
  h=h.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g,function(_,c){return '<pre><code>'+c+'</code></pre>';});
  h=h.replace(/\`([^\`\\n]+)\`/g,'<code>$1</code>');
  h=h.replace(/\\*\\*([^*\\n]+)\\*\\*/g,'<strong>$1</strong>');
  h=h.replace(/(^|[^*\\w])\\*([^*\\n]+)\\*(?!\\w)/g,'$1<em>$2</em>');
  h=h.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g,'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return h;
}
function setMtContent(t,text,role){if(role==='b')t.innerHTML=md(text);else t.textContent=text;}
function addMsg(text,role,id){
  var el=document.getElementById('msgs');
  if(id){var ex=el.querySelector('[data-id="'+id+'"]');if(ex){var xt=ex.querySelector('.mt');if(xt){setMtContent(xt,text,role);if(role==='b')ex.dataset.raw=text;}scrollMsgs();return;}}
  var d=document.createElement('div');d.className='m '+role;if(id)d.dataset.id=id;
  if(role==='b')d.dataset.raw=text;
  var t=document.createElement('span');t.className='mt';setMtContent(t,text,role);d.appendChild(t);
  if(id){var del=mk('button','m-del','\xd7');del.title='Delete';del.onclick=function(){deleteMessage(id);};d.appendChild(del);}
  el.appendChild(d);scrollMsgs();
  return d;
}
function scrollMsgs(){var e=document.getElementById('msgs');e.scrollTop=e.scrollHeight;}

// JT: D-93 — sseEverConnected: loadHistory on reconnect surfaces persisted bot replies (C25, D-S6.8 manual-D8-retest)
// Pattern from rozek/nanoclaw@9311ff1 — reconnect-aware onopen guard (§6 L12)
var sseEverConnected=false;
// Pattern from rozek/nanoclaw@9311ff1 — EventSource reconnect with exponential backoff, cap 30s
function connectSse(){
  if(sse){sse.onerror=null;sse.close();sse=null;reconDelay=1000;}
  var s=new EventSource('/chat/events?sid='+sid);sse=s;
  s.onopen=function(){var wasConnected=sseEverConnected;sseEverConnected=true;reconDelay=1000;loadSessions();if(wasConnected){setBusy(false);loadHistory();}};
  s.onerror=function(){s.close();sse=null;reconDelay=Math.min(reconDelay*2,30000);setTimeout(connectSse,reconDelay);};
  s.addEventListener('user_message',function(e){var d=JSON.parse(e.data);addMsg(d.text,'u',d.id);loadSessions();});
  s.addEventListener('agent_output',function(e){
    var d=JSON.parse(e.data);
    if(botDiv){
      botDiv.dataset.raw=(botDiv.dataset.raw||'')+d.text;
      var t=botDiv.querySelector('.mt');
      if(t)t.innerHTML=md(botDiv.dataset.raw);else botDiv.innerHTML=md(botDiv.dataset.raw);
    } else {botDiv=addMsg(d.text,'b');}
    scrollMsgs();
  });
  s.addEventListener('typing',function(e){
    var on=e.data==='true';
    document.getElementById('typing').style.display=on?'block':'none';
    if(!on){botDiv=null;setBusy(false);loadSessions();}
    scrollMsgs();
  });
  s.addEventListener('upload',function(e){var d=JSON.parse(e.data);addMsg('Uploaded a file: '+d.path,'u',d.id);});
  s.addEventListener('session_renamed',function(e){
    var d=JSON.parse(e.data);
    var lbl=document.querySelector('#sl .si[data-sid="'+d.sid+'"] .si-lbl');
    if(lbl)lbl.textContent=d.name;
  });
  s.addEventListener('session_ordered',function(e){var d=JSON.parse(e.data);sessionOrder=d.order;loadSessions();});
  s.addEventListener('message_deleted',function(e){var d=JSON.parse(e.data);var m=document.querySelector('[data-id="'+d.id+'"]');if(m)m.remove();});
  s.addEventListener('history_cleared',function(){document.getElementById('msgs').innerHTML='';botDiv=null;});
  s.addEventListener('sessions_changed',function(e){
    try{var d=JSON.parse(e.data);if(d.removed&&d.removed===sid){
      // Current chat was deleted: switch to the most recent surviving chat
      // instead of minting a new sid (which would create a phantom new chat).
      api('/chat/sessions').then(function(rr){if(!rr)return;rr.json().then(function(ss){
        var first=ss[0];if(first&&first.sid)switchSid(first.sid);else switchSid(mkSid());
      });});
      return;
    }}catch(err){}
    loadSessions();
  });
  s.addEventListener('cancelled',function(){botDiv=null;setBusy(false);});
}

function setBusy(v){
  busy=v;
  document.getElementById('send').disabled=v;
  document.getElementById('inp').disabled=v;
  document.getElementById('cancel-btn').style.display=v?'':'none';
  var ul=document.getElementById('up-lbl');ul.style.pointerEvents=v?'none':'';ul.style.opacity=v?'.45':'';
}
document.getElementById('send').onclick=sendMsg;
document.getElementById('inp').addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg();}});
document.getElementById('cancel-btn').onclick=function(){
  api('/chat/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sid:sid})});
};
document.getElementById('file-inp').onchange=function(){
  var f=this.files&&this.files[0];if(!f)return;this.value='';
  var rd=new FileReader();
  rd.onload=function(ev){
    var b64=ev.target.result.split(',')[1];
    api('/chat/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sid:sid,filename:f.name,data:b64,mimeType:f.type})});
  };
  rd.readAsDataURL(f);
};
async function sendMsg(){
  if(busy)return;
  var inp=document.getElementById('inp'),txt=inp.value.trim();if(!txt)return;
  inp.value='';setBusy(true);
  var r=await api('/chat/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sid:sid,content:txt})});
  if(!r||!r.ok){setBusy(false);inp.value=txt;return;}
  maybeAutoRename(txt);
}

async function deleteSession(dsid){
  if(!confirm('Delete this chat permanently? Messages will be lost.'))return;
  var r=await api('/chat/delete-session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sid:dsid})});
  if(r&&r.ok)loadSessions();
}
function deleteMessage(mid){
  api('/chat/delete-message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sid:sid,id:mid})});
}
function clearHistory(){
  if(!confirm('Clear all messages in this chat?'))return;
  api('/chat/clear-history',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sid:sid})});
}

function init(){loadSessions();loadHistory();connectSse();}
// JT: D-93 — wake-from-sleep recovery: unlocks input + re-fetches history + reconnects SSE (D-S6.5, D-S6.8 manual-D8-retest)
// Pattern from rozek/nanoclaw@9311ff1 — visibilitychange recovery (§6 L11)
document.addEventListener('visibilitychange',function(){
  if(document.visibilityState!=='visible')return;
  setBusy(false);
  loadHistory();
  if(!sse)connectSse();
});
fetch('/chat/sessions').then(function(r){r.ok?showApp():showLogin('');}).catch(function(){showLogin('');});

// ── Dashboard — D-S3.11/D-S3.12/D-S3.13/D-S3.14 ──────────────────────────────
var dashTimer=null;
var hBody=document.getElementById('dc-health-body'),hFoot=document.getElementById('dc-health-foot');
var vBody=document.getElementById('dc-vault-body'),vFoot=document.getElementById('dc-vault-foot');
var cBody=document.getElementById('dc-cost-body'),cFoot=document.getElementById('dc-cost-foot');
var aBody=document.getElementById('dc-api-usage-body'),aFoot=document.getElementById('dc-api-usage-foot');

function tsAgo(iso){if(!iso)return'';var d=Math.round((Date.now()-new Date(iso).getTime())/1000);return d<2?'just now':d+'s ago';}
function fmtRl(rl){if(rl==null)return'unknown';if(rl.state==='ok')return'OK';if(!rl.last_hit_at)return'rate-limited';var m=Math.floor((Date.now()-new Date(rl.last_hit_at).getTime())/60000);return'rate-limited '+(m<1?'<1m':m+'m')+' ago';}

function renderHealth(d){
  hBody.innerHTML='';
  var rows=[
    ['Status',d.status],
    ['Uptime',Math.floor(d.uptime_sec/3600)+'h '+Math.floor((d.uptime_sec%3600)/60)+'m'],
    ['Load avg',(d.load_avg||[0,0,0]).map(function(v){return v.toFixed(2);}).join(', ')],
    ['Memory',d.mem?Math.round((d.mem.total_bytes-d.mem.free_bytes)/1048576)+'MB / '+Math.round(d.mem.total_bytes/1048576)+'MB':'—'],
    ['Disk',d.disk?Math.round(d.disk.free_bytes/1073741824)+'GB free':'—'],
    ['Proxy',d.proxy_reachable?'reachable':'unreachable'],
    ['Rate limit',fmtRl(d.rate_limit)],
  ];
  if(d.containers&&d.containers.length){rows.push(['Containers',d.containers.map(function(c){return c.name+'='+c.state;}).join('; ')]);}
  rows.forEach(function(r){var row=mk('div','dr','');row.appendChild(mk('span','dk',r[0]));row.appendChild(mk('span','',r[1]));hBody.appendChild(row);});
  hFoot.textContent='Updated '+tsAgo(d.collected_at);
}

function renderVault(d){
  vBody.innerHTML='';
  if(d.error){vBody.textContent=d.error;vFoot.textContent='';return;}
  var tot=mk('div','dr','');tot.appendChild(mk('span','dk','Total files'));tot.appendChild(mk('span','',String(d.total_files)));vBody.appendChild(tot);
  (d.by_folder||[]).forEach(function(f){var row=mk('div','dr','');row.appendChild(mk('span','dk',f.folder));row.appendChild(mk('span','',f.file_count+' files'));vBody.appendChild(row);});
  vFoot.textContent='Updated '+tsAgo(d.collected_at);
}

function renderCost(d){
  cBody.innerHTML='';
  var av=mk('div','dr','');av.appendChild(mk('span','dk','Available'));av.appendChild(mk('span','',d.available?'yes':'no'));cBody.appendChild(av);
  if(!d.available&&d.reason){var rr=mk('div','dr','');rr.appendChild(mk('span','dk','Reason'));rr.appendChild(mk('span','',d.reason));cBody.appendChild(rr);}
  cFoot.textContent='Updated '+tsAgo(d.collected_at);
}

function renderApiUsage(d){
  aBody.innerHTML='';
  var rows=[];
  d.months.forEach(function(m){
    rows.push([m.month+' \u00b7 OAuth interactive',m.oauth_count+' msgs']);
    rows.push([m.month+' \u00b7 API billable',m.api_count+' dispatches \u00b7 $'+m.est_usd.toFixed(2)]);
  });
  rows.push(['Rate per dispatch','$'+(d.rate_per_dispatch||0).toFixed(3)]);
  rows.forEach(function(r){var row=mk('div','dr','');row.appendChild(mk('span','dk',r[0]));row.appendChild(mk('span','',r[1]));aBody.appendChild(row);});
}

function setCardErr(body,foot){
  var prev=body.innerHTML;body.innerHTML='';
  if(prev){var s=document.createElement('del');s.innerHTML=prev;body.appendChild(s);}
  body.appendChild(mk('span','','Unavailable \u2014 retrying in 15s'));
  foot.textContent='';
}

async function loadDash(){
  try{var rh=await api('/dash/health');if(rh&&rh.ok){renderHealth(await rh.json());}else{setCardErr(hBody,hFoot);}}catch(e){setCardErr(hBody,hFoot);}
  try{var rv=await api('/dash/vault-stats');if(rv&&rv.ok){renderVault(await rv.json());}else{setCardErr(vBody,vFoot);}}catch(e){setCardErr(vBody,vFoot);}
  try{var rc=await api('/dash/cost');if(rc&&rc.ok){renderCost(await rc.json());}else{setCardErr(cBody,cFoot);}}catch(e){setCardErr(cBody,cFoot);}
  try{var ra=await api('/dash/api-usage');if(ra&&ra.ok){renderApiUsage(await ra.json());}else{setCardErr(aBody,aFoot);}}catch(e){setCardErr(aBody,aFoot);}
}

function handleDashVis(){
  if(document.visibilityState==='hidden'){if(dashTimer){clearInterval(dashTimer);dashTimer=null;}}
  else{loadDash();if(!dashTimer)dashTimer=setInterval(loadDash,15000);}
}

function startDashPoll(){
  if(dashTimer)clearInterval(dashTimer);
  loadDash();
  dashTimer=setInterval(loadDash,15000);
  document.addEventListener('visibilitychange',handleDashVis);
}

function stopDashPoll(){
  if(dashTimer){clearInterval(dashTimer);dashTimer=null;}
  document.removeEventListener('visibilitychange',handleDashVis);
}

function setView(v){
  var a=document.getElementById('app');
  a.classList.toggle('view-dash',v==='dash');
  document.getElementById('nav-chat').classList.toggle('active',v!=='dash');
  document.getElementById('nav-dash').classList.toggle('active',v==='dash');
  if(v==='dash')startDashPoll();else stopDashPoll();
}

window.addEventListener('hashchange',function(){setView(location.hash==='#/dash'?'dash':'chat');});
document.getElementById('nav-chat').onclick=function(){location.hash='#/';};
document.getElementById('nav-dash').onclick=function(){location.hash='#/dash';};
if(location.hash==='#/dash')setView('dash');
})();
</script>
</body>
</html>`;
/* eslint-enable no-useless-escape */

// ── WebChannel class ──────────────────────────────────────────────────────────

export class WebChannel implements Channel {
  // JT: Channel interface from src/types.ts — upstream-owned
  name = 'web';

  private opts: ChannelOpts; // JT: ChannelOpts from src/channels/registry.ts — upstream-owned
  private server: http.Server | null = null;
  private clientsBySid = new Map<string, Set<ServerResponse>>();
  private typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private authAttempts = new Map<string, { count: number; resetAt: number }>();
  // D-S3.10: per-instance cache so test isolation works (module-level cache crosses instances)
  private dashCache = new Map<
    string,
    { payload: unknown; expiresAt: number }
  >();
  private dashHealthLoggedOnce = false;
  private dashApiUsageLoggedOnce = false;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    try {
      validateBridgeConfig(NANOCLAW_WEB_HOST, NANOCLAW_TOKEN); // D-S1.1
    } catch (err) {
      logger.warn(
        { host: NANOCLAW_WEB_HOST },
        '[bridge] Refusing to start: NANOCLAW_TOKEN required on non-loopback bind',
      );
      throw err;
    }
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err: unknown) => {
        logger.error({ err }, '[bridge] Unhandled request error');
        if (!res.headersSent) res.writeHead(500).end('Internal Server Error');
      });
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(NANOCLAW_WEB_PORT, NANOCLAW_WEB_HOST, () => {
        const addr = this.server!.address() as AddressInfo;
        logger.info(
          { host: NANOCLAW_WEB_HOST, port: addr.port },
          '[bridge] Bridge listening',
        );
        resolve();
      });
    });
    logger.info('[bridge] Bridge channel registered');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // JT: jid format is local@web-<sid> per spec §5.1; NewMessage delivered via onMessage callback
    const sid = sidFromJid(jid);
    if (!sid) {
      logger.warn({ jid }, '[bridge] sendMessage: cannot extract sid from jid');
      return;
    }
    // D-S1.12: clear typing on first agent output chunk
    if (this.typingTimers.has(sid)) {
      this.setTypingForSid(sid, false);
    }
    // JT: D-93 — persist bot reply before broadcast so history survives reload (C23)
    // Pattern from rozek/nanoclaw@9311ff1 — persist bot reply before broadcast (§6 L10)
    const botMsgId = `web-bot-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const botMsg: NewMessage = {
      id: botMsgId,
      chat_jid: jid,
      sender: ASSISTANT_NAME,
      sender_name: ASSISTANT_NAME,
      content: text,
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: true,
    };
    try {
      storeMessage(botMsg);
      storeChatMetadata(jid, botMsg.timestamp, undefined, 'web', false);
    } catch (err) {
      logger.warn(
        { err, jid },
        '[bridge] sendMessage: failed to persist bot message',
      );
    }
    broadcastToSession(
      this.clientsBySid,
      sid,
      'agent_output',
      JSON.stringify({ text, id: botMsgId }),
    );
  }

  isConnected(): boolean {
    return this.server !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('local@web-');
  }

  async disconnect(): Promise<void> {
    for (const clients of this.clientsBySid.values()) {
      for (const res of clients) {
        try {
          res.end();
        } catch {}
      }
    }
    this.clientsBySid.clear();
    for (const t of this.typingTimers.values()) clearTimeout(t);
    this.typingTimers.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
      logger.info('[bridge] Bridge stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const sid = sidFromJid(jid);
    if (sid) this.setTypingForSid(sid, isTyping);
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  private authorizeRequest(req: IncomingMessage, res: ServerResponse): boolean {
    if (!NANOCLAW_TOKEN) return true; // loopback-only trust model — D-S1.1
    const ip = req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    if (this.isRateLimited(ip, now)) {
      res.writeHead(429, { 'Retry-After': '60' }).end('Too Many Requests');
      return false;
    }

    // Extract token from header or cookie — C5: ?token= param never accepted
    const auth = req.headers.authorization;
    let provided: string | null = null;
    if (auth?.startsWith('Bearer ')) {
      provided = auth.slice(7);
    } else {
      const cookie = req.headers.cookie ?? '';
      provided = parseCookie(cookie, 'nanoclaw_token');
    }

    if (provided && checkToken(provided, NANOCLAW_TOKEN)) {
      this.authAttempts.delete(ip); // clear on success
      return true;
    }

    this.recordFailedAuth(ip, now);
    res
      .writeHead(401, { 'WWW-Authenticate': 'Bearer realm="NanoClaw"' })
      .end('Unauthorized');
    logger.info({ ip }, '[bridge] Auth failed');
    return false;
  }

  private isRateLimited(ip: string, now: number): boolean {
    const rec = this.authAttempts.get(ip);
    return !!(rec && now < rec.resetAt && rec.count >= RATE_LIMIT_MAX);
  }

  private recordFailedAuth(ip: string, now: number): void {
    // Pattern from rozek/nanoclaw@9311ff1 — in-memory bad-auth rate limiter with LRU cap
    const rec = this.authAttempts.get(ip);
    if (rec) {
      if (now >= rec.resetAt) {
        rec.count = 1;
        rec.resetAt = now + RATE_LIMIT_WINDOW_MS;
      } else {
        rec.count++;
      }
    } else {
      if (this.authAttempts.size >= RATE_LIMIT_IP_CAP) {
        const oldest = this.authAttempts.keys().next().value;
        if (oldest !== undefined) this.authAttempts.delete(oldest);
      }
      this.authAttempts.set(ip, {
        count: 1,
        resetAt: now + RATE_LIMIT_WINDOW_MS,
      });
    }
  }

  // ── Request router ────────────────────────────────────────────────────────

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    );
    const urlPath = url.pathname;
    const method = req.method ?? 'GET';

    // D-S2.17: HEAD aliasing for public read-only routes only
    const readMethod = method === 'HEAD' ? 'GET' : method;
    const headOnly = method === 'HEAD';

    // C6: All state-mutating routes are POST; GET / and static assets are unauthenticated
    if (readMethod === 'GET' && urlPath === '/') {
      this.handleSpa(res, headOnly);
      return;
    }
    if (readMethod === 'GET' && urlPath === '/manifest.json') {
      this.handleManifest(res, headOnly);
      return;
    }
    if (readMethod === 'GET' && urlPath.startsWith('/static/')) {
      this.handleStatic(urlPath, res, headOnly);
      return;
    }
    if (method === 'POST' && urlPath === '/auth/login') {
      await this.handleAuthLogin(req, res);
      return;
    }

    if (!this.authorizeRequest(req, res)) return;

    // D-V53.B5: POST /auth/logout — requires auth (gate above); D-V53.B6 rationale
    if (method === 'POST' && urlPath === '/auth/logout') {
      this.handleAuthLogout(req, res);
      return;
    }

    // D-S3.1: /dash/* routes — GET-only, read-only, no mutation — D-S3.2 shared auth gate above
    if (method === 'GET' && urlPath === '/dash/health') {
      await this.handleDashHealth(res);
      return;
    }
    if (method === 'GET' && urlPath === '/dash/vault-stats') {
      await this.handleDashVaultStats(res);
      return;
    }
    if (method === 'GET' && urlPath === '/dash/cost') {
      await this.handleDashCost(res);
      return;
    }
    if (method === 'GET' && urlPath === '/dash/api-usage') {
      await this.handleDashApiUsage(req, res);
      return;
    }
    // D-CU2: /dash/usage reverse-proxy to claude-usage dashboard server (localhost:8080)
    if (
      method === 'GET' &&
      (urlPath === '/dash/usage' || urlPath.startsWith('/dash/usage/'))
    ) {
      await this.handleDashUsageProxy(req, res);
      return;
    }

    if (method === 'GET' && urlPath === '/chat/events') {
      this.handleSse(req, res, url);
      return;
    }
    if (method === 'POST' && urlPath === '/chat/message') {
      await this.handlePostMessage(req, res);
      return;
    }
    if (method === 'GET' && urlPath === '/chat/history') {
      this.handleGetHistory(res, url);
      return;
    }
    if (method === 'GET' && urlPath === '/chat/sessions') {
      this.handleGetSessions(req, res);
      return;
    }
    if (method === 'POST' && urlPath === '/chat/upload') {
      await this.handleUpload(req, res);
      return;
    }
    if (method === 'POST' && urlPath === '/chat/session-name') {
      await this.handleSessionName(req, res);
      return;
    }
    if (method === 'POST' && urlPath === '/chat/session-order') {
      await this.handleSessionOrder(req, res);
      return;
    }
    if (method === 'POST' && urlPath === '/chat/delete-session') {
      await this.handleDeleteSession(req, res);
      return;
    }
    if (method === 'POST' && urlPath === '/chat/delete-message') {
      await this.handleDeleteMessage(req, res);
      return;
    }
    if (method === 'POST' && urlPath === '/chat/clear-history') {
      await this.handleClearHistory(req, res);
      return;
    }
    if (method === 'POST' && urlPath === '/chat/cancel') {
      await this.handleCancel(req, res);
      return;
    }

    res.writeHead(404).end('Not Found');
  }

  // ── Route handlers ────────────────────────────────────────────────────────

  private handleSpa(res: ServerResponse, headOnly = false): void {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': CSP, // D-S1.13
      'Cache-Control': 'no-cache',
    });
    headOnly ? res.end() : res.end(SPA_HTML);
  }

  private handleManifest(res: ServerResponse, headOnly = false): void {
    // Pattern from rozek/nanoclaw@9311ff1 — PWA manifest JSON shape
    const manifest = {
      name: `Bridge \u2014 ${ASSISTANT_NAME}`,
      short_name: 'Bridge',
      start_url: '/',
      display: 'standalone',
      background_color: '#ffffff',
      theme_color: '#0a84ff',
      icons: [
        { src: '/static/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/static/icon-512.png', sizes: '512x512', type: 'image/png' },
        {
          src: '/static/apple-touch-icon.png',
          sizes: '180x180',
          type: 'image/png',
        },
      ],
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    headOnly ? res.end() : res.end(JSON.stringify(manifest));
  }

  private handleStatic(
    urlPath: string,
    res: ServerResponse,
    headOnly = false,
  ): void {
    const isIcon =
      urlPath === '/static/icon-192.png' ||
      urlPath === '/static/icon-512.png' ||
      urlPath === '/static/apple-touch-icon.png';
    if (!isIcon) {
      res.writeHead(404).end('Not Found');
      return;
    }
    // Stub SVG icon — replace with real PNGs in Step 4 polish
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#0a84ff"/><text x="50" y="68" font-size="58" text-anchor="middle" fill="#fff">B</text></svg>`;
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'max-age=86400',
    });
    headOnly ? res.end() : res.end(svg);
  }

  // ── Upload ────────────────────────────────────────────────────────────────

  private async handleUpload(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let body: string;
    try {
      body = await collectBody(req, UPLOAD_BODY_LIMIT);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        res.writeHead(413).end('Payload Too Large');
        return;
      }
      throw err;
    }
    let parsed: {
      sid?: string;
      filename?: string;
      data?: string;
      mimeType?: string;
    };
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      res.writeHead(400).end('Bad Request');
      return;
    }

    const sid = sanitizeSid(parsed.sid);
    if (!sid) {
      res.writeHead(400).end('Invalid or missing sid');
      return;
    }

    const sanitized = sanitizeFilename(parsed.filename ?? '');
    if (!sanitized) {
      res.writeHead(400).end('Invalid or missing filename');
      return;
    }

    // C1: extension allowlist BEFORE any filesystem operation
    if (!isAllowedExtension(sanitized)) {
      const ext = sanitized.toLowerCase().endsWith('.tar.gz')
        ? '.tar.gz'
        : path.extname(sanitized).toLowerCase();
      res
        .writeHead(400, { 'Content-Type': 'application/json' })
        .end(
          JSON.stringify({ error: 'Extension not allowed', extension: ext }),
        );
      return;
    }

    // Resolve main group
    // JT: RegisteredGroup from src/types.ts — upstream-owned
    const groups = this.opts.registeredGroups();
    const main = Object.values(groups).find((g) => g.isMain === true);
    if (!main) {
      res.writeHead(503).end('No main group registered');
      return;
    }
    const groupDir = path.resolve(resolveGroupFolderPath(main.folder));

    // L2: sandbox-clamp — belt-and-suspenders basename, then containment check
    // Pattern from rozek/nanoclaw@9311ff1 — upload sandbox-clamp (L2)
    const safe = path.basename(sanitized);
    const target = path.resolve(groupDir, safe);

    // C3: D-90 quarantine explicit reject BEFORE clamp (defense-in-depth over infra exclusion)
    if (target.toLowerCase().includes(QUARANTINE_MARKER)) {
      logger.warn(
        { sid, filename: parsed.filename },
        '[bridge] Upload rejected — path resolves into quarantine',
      );
      res.writeHead(403).end('Forbidden \u2014 quarantine path');
      return;
    }

    if (!target.startsWith(groupDir + path.sep) && target !== groupDir) {
      res.writeHead(400).end('Invalid filename');
      return;
    }

    const rawData = parsed.data ?? '';
    let buf: Buffer;
    try {
      buf = Buffer.from(rawData, 'base64');
    } catch {
      res.writeHead(400).end('Invalid base64 data');
      return;
    }

    // Collision-safe write with single-retry on EEXIST — D-S2.8
    let finalTarget = target;
    let finalSafe = safe;
    try {
      await writeFile(target, buf, { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const ext = safe.toLowerCase().endsWith('.tar.gz')
        ? '.tar.gz'
        : path.extname(safe);
      const stem = safe.slice(0, safe.length - ext.length);
      finalSafe = `${stem}-${Date.now()}${ext}`;
      finalTarget = path.resolve(groupDir, finalSafe);
      try {
        await writeFile(finalTarget, buf, { flag: 'wx' });
      } catch (err2) {
        logger.error(
          { err: err2, sid },
          '[bridge] Upload collision retry failed',
        );
        res.writeHead(500).end('Internal Server Error');
        return;
      }
    }

    // D-83 IPC synthesis — plain NewMessage through existing onMessage pipeline
    // JT: NewMessage from src/types.ts — upstream-owned shape
    const jid = jidFromSid(sid);
    const ts = new Date().toISOString();
    const msgId = `web-upload-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const relPath = path.relative(groupDir, finalTarget);
    const msg: NewMessage = {
      id: msgId,
      chat_jid: jid,
      sender: 'user',
      sender_name: 'You',
      content: `Uploaded a file: ${relPath}`,
      timestamp: ts,
      is_from_me: false,
      is_bot_message: false,
    };
    this.opts.onChatMetadata(jid, ts, undefined, 'web', false);
    broadcastToSession(
      this.clientsBySid,
      sid,
      'upload',
      JSON.stringify({ path: relPath, filename: finalSafe, id: msgId }),
    );
    this.setTypingForSid(sid, true);
    this.opts.onMessage(jid, msg);

    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ ok: true, path: relPath, id: msgId }));
  }

  // ── Session affordances ───────────────────────────────────────────────────

  private async handleSessionName(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let parsed: { sid?: string; name?: string };
    try {
      parsed = JSON.parse(await collectBody(req, BODY_LIMIT)) as typeof parsed;
    } catch (err) {
      res
        .writeHead(err instanceof BodyTooLargeError ? 413 : 400)
        .end('Bad Request');
      return;
    }
    const sid = sanitizeSid(parsed.sid);
    if (!sid) {
      res.writeHead(400).end('Invalid or missing sid');
      return;
    }
    const name = sanitizeFilename(parsed.name ?? '');
    if (!name) {
      res.writeHead(400).end('Invalid or empty name');
      return;
    }
    const jid = jidFromSid(sid);
    updateChatName(jid, name);
    for (const [otherSid] of this.clientsBySid) {
      broadcastToSession(
        this.clientsBySid,
        otherSid,
        'session_renamed',
        JSON.stringify({ sid, name }),
      );
    }
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end('{"ok":true}');
  }

  private async handleSessionOrder(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let parsed: { order?: unknown };
    try {
      parsed = JSON.parse(await collectBody(req, BODY_LIMIT)) as typeof parsed;
    } catch (err) {
      res
        .writeHead(err instanceof BodyTooLargeError ? 413 : 400)
        .end('Bad Request');
      return;
    }
    if (
      !Array.isArray(parsed.order) ||
      parsed.order.length > SESSION_ORDER_MAX
    ) {
      res.writeHead(400).end('Invalid order');
      return;
    }
    const order: string[] = [];
    for (const raw of parsed.order) {
      const s = sanitizeSid(typeof raw === 'string' ? raw : undefined);
      if (!s) {
        res.writeHead(400).end('Invalid sid in order');
        return;
      }
      order.push(s);
    }
    setRouterState('web_session_order', JSON.stringify(order));
    for (const [otherSid] of this.clientsBySid) {
      broadcastToSession(
        this.clientsBySid,
        otherSid,
        'session_ordered',
        JSON.stringify({ order }),
      );
    }
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end('{"ok":true}');
  }

  private async handleDeleteSession(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let parsed: { sid?: string };
    try {
      parsed = JSON.parse(await collectBody(req, BODY_LIMIT)) as typeof parsed;
    } catch (err) {
      res
        .writeHead(err instanceof BodyTooLargeError ? 413 : 400)
        .end('Bad Request');
      return;
    }
    const sid = sanitizeSid(parsed.sid);
    if (!sid) {
      res.writeHead(400).end('Invalid or missing sid');
      return;
    }
    const jid = jidFromSid(sid);
    deleteChat(jid);

    // Close all SSE connections for this sid
    const clients = this.clientsBySid.get(sid);
    if (clients) {
      for (const r of [...clients]) {
        try {
          r.end();
        } catch {}
      }
      this.clientsBySid.delete(sid);
    }
    const timer = this.typingTimers.get(sid);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.typingTimers.delete(sid);
    }

    for (const [otherSid] of this.clientsBySid) {
      broadcastToSession(
        this.clientsBySid,
        otherSid,
        'sessions_changed',
        JSON.stringify({ removed: sid }),
      );
    }
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end('{"ok":true}');
  }

  private async handleDeleteMessage(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let parsed: { sid?: string; id?: string };
    try {
      parsed = JSON.parse(await collectBody(req, BODY_LIMIT)) as typeof parsed;
    } catch (err) {
      res
        .writeHead(err instanceof BodyTooLargeError ? 413 : 400)
        .end('Bad Request');
      return;
    }
    const sid = sanitizeSid(parsed.sid);
    if (!sid) {
      res.writeHead(400).end('Invalid or missing sid');
      return;
    }
    const id = (parsed.id ?? '').trim();
    if (!id) {
      res.writeHead(400).end('Missing message id');
      return;
    }
    const jid = jidFromSid(sid);
    // Cross-chat-jid guard is load-bearing — DB enforces WHERE id = ? AND chat_jid = ?
    const deleted = deleteMessage(id, jid);
    if (!deleted) {
      res
        .writeHead(404, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: 'message not found' }));
      return;
    }
    broadcastToSession(
      this.clientsBySid,
      sid,
      'message_deleted',
      JSON.stringify({ id }),
    );
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end('{"ok":true}');
  }

  private async handleClearHistory(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let parsed: { sid?: string };
    try {
      parsed = JSON.parse(await collectBody(req, BODY_LIMIT)) as typeof parsed;
    } catch (err) {
      res
        .writeHead(err instanceof BodyTooLargeError ? 413 : 400)
        .end('Bad Request');
      return;
    }
    const sid = sanitizeSid(parsed.sid);
    if (!sid) {
      res.writeHead(400).end('Invalid or missing sid');
      return;
    }
    const jid = jidFromSid(sid);
    const count = clearChatMessages(jid);
    broadcastToSession(
      this.clientsBySid,
      sid,
      'history_cleared',
      JSON.stringify({ sid, count }),
    );
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ ok: true, count }));
  }

  private async handleCancel(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let parsed: { sid?: string };
    try {
      parsed = JSON.parse(await collectBody(req, BODY_LIMIT)) as typeof parsed;
    } catch (err) {
      res
        .writeHead(err instanceof BodyTooLargeError ? 413 : 400)
        .end('Bad Request');
      return;
    }
    const sid = sanitizeSid(parsed.sid);
    if (!sid) {
      res.writeHead(400).end('Invalid or missing sid');
      return;
    }
    // D-S2.16: channel-side UI-only cancel — agent continues to completion
    this.setTypingForSid(sid, false);
    broadcastToSession(
      this.clientsBySid,
      sid,
      'cancelled',
      JSON.stringify({ sid }),
    );
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end('{"ok":true}');
  }

  private async handleAuthLogin(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!NANOCLAW_TOKEN) {
      // Auth disabled — cookie not needed
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end('{"ok":true}');
      return;
    }
    const ip = req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    if (this.isRateLimited(ip, now)) {
      // D-S1d.3: check before collectBody
      res.writeHead(429, { 'Retry-After': '60' }).end('Too Many Requests');
      return;
    }
    let body: string;
    try {
      body = await collectBody(req, BODY_LIMIT);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        res.writeHead(413).end('Payload Too Large');
        return;
      }
      throw err;
    }
    let parsed: { token?: string };
    try {
      parsed = JSON.parse(body) as { token?: string };
    } catch {
      res.writeHead(400).end('Bad Request');
      return;
    }

    const provided = parsed.token ?? '';
    if (!checkToken(provided, NANOCLAW_TOKEN)) {
      this.recordFailedAuth(ip, now);
      logger.info({ ip }, '[bridge] Auth failed (login)');
      res.writeHead(401).end('Unauthorized');
      return;
    }

    // Pattern from rozek/nanoclaw@9311ff1 — cookie attribute set
    // JT: req.socket.encrypted is tls.TLSSocket-specific; cast needed
    const isSecure =
      (req.socket as unknown as { encrypted?: boolean }).encrypted === true ||
      req.headers['x-forwarded-proto'] === 'https';
    // D-V53.B1: Max-Age=15552000 = 180d persistence (survive browser/PWA process kill)
    // D-V53.B2: SameSite=Lax — CSRF-safe under POST-with-token-body; allows PWA top-level navigations
    const cookieAttrs = `Max-Age=15552000; HttpOnly; SameSite=Lax; Path=/${isSecure ? '; Secure' : ''}`;
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': `nanoclaw_token=${encodeURIComponent(NANOCLAW_TOKEN)}; ${cookieAttrs}`,
    });
    res.end('{"ok":true}');
  }

  private handleAuthLogout(req: IncomingMessage, res: ServerResponse): void {
    // D-V53.B6: authorizeRequest already ran upstream (see route registration)
    // D-V53.B7: clear cookie via Max-Age=0; same name/path/attributes as the login set
    const isSecure =
      (req.socket as unknown as { encrypted?: boolean }).encrypted === true ||
      req.headers['x-forwarded-proto'] === 'https';
    const clearAttrs = `Max-Age=0; HttpOnly; SameSite=Lax; Path=/${isSecure ? '; Secure' : ''}`;
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': `nanoclaw_token=; ${clearAttrs}`,
    });
    res.end('{"ok":true}');
  }

  private handleSse(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const raw = url.searchParams.get('sid');
    const sid = raw === null ? 'default' : sanitizeSid(raw);
    if (sid === null) {
      res.writeHead(400).end('Invalid or reserved sid');
      return;
    }

    // Impl-56 fold #12: ensureSession MUST run before writeHead+flushHeaders.
    // Browser's EventSource fires onopen when SSE headers arrive; SPA's onopen
    // handler now calls loadSessions() (fold #11) which races against this
    // ensureSession if it runs after the headers flush. Race symptom: clicking
    // + creates the new chat row only AFTER the first /chat/sessions response
    // returned, so sidebar didn't show the new chat until next chat-switch.
    const isFirstClientForSid = !this.clientsBySid.has(sid);
    this.ensureSession(sid, isFirstClientForSid);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    if (isFirstClientForSid) {
      this.clientsBySid.set(sid, new Set());
    }
    this.clientsBySid.get(sid)!.add(res);
    logger.debug({ sid }, '[bridge] SSE client connected');

    // Pattern from rozek/nanoclaw@9311ff1 — SSE 20s heartbeat; keeps iOS Safari + flaky networks alive
    const heartbeat = setInterval(() => {
      try {
        res.write(':\n\n');
      } catch {
        // disconnected — cleaned up on close
      }
    }, SSE_HEARTBEAT_MS);

    req.on('close', () => {
      clearInterval(heartbeat);
      const set = this.clientsBySid.get(sid);
      if (set) {
        set.delete(res);
        if (set.size === 0) this.clientsBySid.delete(sid);
      }
      logger.debug({ sid }, '[bridge] SSE client disconnected');
    });
  }

  private async handlePostMessage(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let body: string;
    try {
      body = await collectBody(req, BODY_LIMIT);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        res.writeHead(413).end('Payload Too Large');
        return;
      }
      throw err;
    }
    let parsed: { sid?: string; content?: string };
    try {
      parsed = JSON.parse(body) as { sid?: string; content?: string };
    } catch {
      res.writeHead(400).end('Bad Request');
      return;
    }

    const sid = sanitizeSid(parsed.sid);
    if (!sid) {
      res.writeHead(400).end('Invalid or missing sid');
      return;
    }

    const content = (parsed.content ?? '').trim();
    if (!content) {
      res.writeHead(400).end('Missing content');
      return;
    }

    const jid = jidFromSid(sid);
    const ts = new Date().toISOString();
    const msgId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    // JT: NewMessage shape from src/types.ts — upstream-owned
    const msg: NewMessage = {
      id: msgId,
      chat_jid: jid,
      sender: 'user',
      sender_name: 'You',
      content,
      timestamp: ts,
      is_from_me: false,
      is_bot_message: false,
    };

    this.opts.onChatMetadata(jid, ts, undefined, 'web', false); // JT: OnChatMetadata from src/types.ts
    broadcastToSession(
      this.clientsBySid,
      sid,
      'user_message',
      JSON.stringify({ text: content, id: msgId }),
    );
    this.setTypingForSid(sid, true); // D-S1.12
    this.opts.onMessage(jid, msg); // JT: OnInboundMessage from src/types.ts — routes to agent

    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ ok: true, id: msgId }));
  }

  private handleGetHistory(res: ServerResponse, url: URL): void {
    const sid = sanitizeSid(url.searchParams.get('sid') ?? undefined);
    if (!sid) {
      res.writeHead(400).end('Invalid or missing sid');
      return;
    }
    const jid = jidFromSid(sid);
    // JT: D-93 — swap to getConversation (returns both sides) replacing getMessagesSince (C24)
    // Pattern from rozek/nanoclaw@9311ff1 — /history cls shape with OR-guard for backward compat (§6 L10)
    const rows = getConversation(jid, HISTORY_LIMIT);
    const history = rows.map((m) => ({
      text: m.content,
      cls: m.is_bot_message || m.is_from_me ? 'bot' : 'user',
      id: m.id,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(history));
  }

  private handleGetSessions(req: IncomingMessage, res: ServerResponse): void {
    const reqUrl = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    );
    const showAll = reqUrl.searchParams.get('showAll') === '1';
    const cutoffMs = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    // T-S1.1 RESOLVED: filter is server-side in handler, not browser-side
    const all: ChatInfo[] = getAllChats();
    const sessions = all
      .filter((c) => c.channel === 'web')
      .map((c) => ({
        sid: c.jid.replace('local@web-', ''),
        jid: c.jid,
        name: c.name.startsWith('local@web-')
          ? c.name.replace('local@web-', 'Chat ')
          : c.name,
        last_message_time: c.last_message_time,
      }))
      .filter((s) => {
        if (showAll) return true;
        const isDefaultName = /^Chat [0-9a-f]{16}$/.test(s.name);
        if (!isDefaultName) return true;
        const lastMs = s.last_message_time
          ? Date.parse(s.last_message_time)
          : 0;
        return now - lastMs < cutoffMs;
      });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sessions));
  }

  // ── Session management ────────────────────────────────────────────────────

  private ensureSession(sid: string, broadcast = true): void {
    const jid = jidFromSid(sid);
    // INSERT OR IGNORE: create row if absent, but do NOT bump last_message_time
    // on existing rows. Without this, every SSE-connect (i.e. every chat-switch)
    // updates the chat's timestamp to NOW, and getAllChats() ORDER BY
    // last_message_time DESC bubbles the clicked chat to the top. Real new
    // messages still update the timestamp via storeMessage. (Impl-56 fold #5
    // root-cause fix per JT live-fire video; pre-existing bug exposed by the
    // FU-23b/d auto-derive + auto-archive making rearrange visually obvious.)
    ensureChatExists(jid, 'web');
    if (!broadcast) return;
    // Broadcast to other sessions' clients that a session is now available
    for (const [otherSid] of this.clientsBySid) {
      if (otherSid !== sid) {
        broadcastToSession(
          this.clientsBySid,
          otherSid,
          'sessions_changed',
          JSON.stringify({ added: sid }),
        );
      }
    }
  }

  // ── Dashboard helpers ─────────────────────────────────────────────────────────

  private async getOrCollect<T>(
    key: string,
    collector: () => Promise<T>,
  ): Promise<T> {
    const now = Date.now();
    const hit = this.dashCache.get(key);
    if (hit && now < hit.expiresAt) return hit.payload as T;
    const payload = await collector();
    this.dashCache.set(key, { payload, expiresAt: now + DASH_CACHE_TTL_MS });
    return payload;
  }

  // ── Dashboard handlers — D-S3.1/D-S3.15: read-only, no writes, no broadcasts ──

  private async handleDashHealth(res: ServerResponse): Promise<void> {
    logger.debug('[bridge] GET /dash/health');
    let payload: object;
    try {
      payload = await this.getOrCollect('health', async () => {
        const [host, containerResult, proxyReachable, rateLimit] =
          await Promise.all([
            collectHostMetrics(),
            collectContainerStatus(),
            probeProxyReachable(CREDENTIAL_PROXY_PORT),
            collectRateLimit(),
          ]);
        const containers = containerResult ?? [];
        const containerFailed = containerResult === null;
        const allRunning =
          !containerFailed && containers.every((c) => c.state === 'running');
        const status: 'ok' | 'degraded' | 'unreachable' =
          containerFailed || !allRunning || !proxyReachable ? 'degraded' : 'ok';

        if (!this.dashHealthLoggedOnce) {
          this.dashHealthLoggedOnce = true;
          logger.info(
            '[bridge] /dash/health: first successful collection after start',
          );
        }

        return {
          status,
          uptime_sec: host.uptime_sec,
          load_avg: host.load_avg,
          mem: host.mem,
          disk: host.disk,
          containers,
          proxy_reachable: proxyReachable,
          last_anthropic_round_trip: null,
          last_readwise_round_trip: null,
          rate_limit: rateLimit,
          collected_at: new Date().toISOString(),
        };
      });
    } catch {
      logger.warn('[bridge] /dash/health: host metrics unavailable');
      payload = {
        status: 'unreachable',
        uptime_sec: 0,
        load_avg: [0, 0, 0],
        mem: { total_bytes: 0, free_bytes: 0, used_pct: 0 },
        disk: null,
        containers: [],
        proxy_reachable: false,
        last_anthropic_round_trip: null,
        last_readwise_round_trip: null,
        rate_limit: null,
        collected_at: new Date().toISOString(),
      };
    }
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify(payload));
  }

  private async handleDashVaultStats(res: ServerResponse): Promise<void> {
    logger.debug('[bridge] GET /dash/vault-stats');
    const vaultRoot = path.join(os.homedir(), 'vault'); // D-S3.9
    const payload = await this.getOrCollect('vault-stats', () =>
      collectVaultStats(vaultRoot),
    );
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify(payload));
  }

  private async handleDashCost(res: ServerResponse): Promise<void> {
    logger.debug('[bridge] GET /dash/cost');
    // D-S3.17/D-71: static skip-with-notice stub — never fabricate values
    const payload = await this.getOrCollect('cost', async () => ({
      available: false as const,
      reason: 'cost telemetry source not yet wired (D-71)',
      spec_refs: ['SA §3e', 'SA §12.3', 'SA §12.4'],
      collected_at: new Date().toISOString(),
    }));
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify(payload));
  }

  // JT: Impl-26 Batch 3.1c — returns YYYY-MM strings for current + prior n-1 UTC months.
  private monthsBackUTC(n: number): string[] {
    const now = new Date();
    const months: string[] = [];
    for (let i = 0; i < n; i++) {
      const d = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1),
      );
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      months.push(`${y}-${m}`);
    }
    return months;
  }

  // JT: Impl-26 Batch 3.1c — reads 4 monthly api-usage state files + OAuth db counts.
  // C-gate C31: each month file read is independent; ENOENT → count:0, no warning (C32).
  private async collectApiUsage(): Promise<{
    months: Array<{
      month: string;
      api_count: number;
      oauth_count: number;
      est_usd: number;
    }>;
    rate_per_dispatch: number;
  }> {
    const months = this.monthsBackUTC(4);
    const stateDir = path.join(os.homedir(), 'daystrom-ops', 'state');
    const out: Array<{
      month: string;
      api_count: number;
      oauth_count: number;
      est_usd: number;
    }> = [];
    for (const ym of months) {
      let apiCount = 0;
      try {
        const raw = await readFile(
          path.join(stateDir, `api-usage-${ym}.json`),
          'utf-8',
        );
        const parsed = JSON.parse(raw) as { count?: unknown };
        apiCount = typeof parsed?.count === 'number' ? parsed.count : 0;
      } catch (e: unknown) {
        const err = e as { code?: string };
        if (err?.code !== 'ENOENT') {
          logger.warn(
            { month: ym, err: String(e) },
            '[bridge] /dash/api-usage read error',
          );
        }
      }
      const oauthCount = getMessageCountForMonth(ym);
      out.push({
        month: ym,
        api_count: apiCount,
        oauth_count: oauthCount,
        est_usd:
          Math.round(apiCount * NANOCLAW_ANTHROPIC_RATE_PER_DISPATCH * 100) /
          100,
      });
    }
    return {
      months: out,
      rate_per_dispatch: NANOCLAW_ANTHROPIC_RATE_PER_DISPATCH,
    };
  }

  // JT: Impl-26 Batch 3.1c — /dash/api-usage handler. C-gate C26: read-only, no writes.
  private async handleDashApiUsage(
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const payload = await this.getOrCollect('api-usage', () =>
        this.collectApiUsage(),
      );
      if (!this.dashApiUsageLoggedOnce) {
        this.dashApiUsageLoggedOnce = true;
        logger.info(
          '[bridge] /dash/api-usage: first successful collection after start',
        );
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    } catch (e: unknown) {
      logger.error({ err: String(e) }, '[bridge] /dash/api-usage failed');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'collection_failed' }));
    }
  }

  // JT: Batch 2.3 D-CU2 — reverse-proxy GET requests to claude-usage dashboard server.
  // Auth is enforced by authorizeRequest() before this handler is reached.
  // Path rewrite: /dash/usage[/sub/path][?q] → /[sub/path][?q] on 127.0.0.1:CLAUDE_USAGE_PORT.
  private handleDashUsageProxy(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const proxyPath =
      (req.url ?? '/dash/usage').slice('/dash/usage'.length) || '/';
    return new Promise<void>((resolve) => {
      const proxyReq = http.request(
        {
          hostname: '127.0.0.1',
          port: CLAUDE_USAGE_PORT,
          path: proxyPath,
          method: 'GET',
        },
        (proxyRes) => {
          const headers: http.OutgoingHttpHeaders = {};
          for (const [k, v] of Object.entries(proxyRes.headers)) {
            if (
              k !== 'transfer-encoding' &&
              k !== 'connection' &&
              v !== undefined
            ) {
              headers[k] = v;
            }
          }
          headers['x-frame-options'] = 'SAMEORIGIN';
          res.writeHead(proxyRes.statusCode ?? 200, headers);
          proxyRes.pipe(res, { end: true });
          proxyRes.on('end', resolve);
        },
      );
      proxyReq.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain' });
          res.end('Usage dashboard unavailable');
        }
        resolve();
      });
      proxyReq.end();
    });
  }

  // ── Typing indicator ──────────────────────────────────────────────────────

  private setTypingForSid(sid: string, isTyping: boolean): void {
    const existing = this.typingTimers.get(sid);
    if (existing !== undefined) {
      clearTimeout(existing);
      this.typingTimers.delete(sid);
    }
    broadcastToSession(
      this.clientsBySid,
      sid,
      'typing',
      isTyping ? 'true' : 'false',
    );
    if (isTyping) {
      // D-S1.12 / D-V52.5: safety timeout — clears typing if agent never responds (5 min cap)
      const timer = setTimeout(() => {
        this.typingTimers.delete(sid);
        broadcastToSession(this.clientsBySid, sid, 'typing', 'false');
      }, TYPING_TIMEOUT_MS);
      this.typingTimers.set(sid, timer);
    }
  }
}

// ── Channel registration ──────────────────────────────────────────────────────

// JT: registerChannel + ChannelOpts from src/channels/registry.ts — upstream-owned
registerChannel('web', (opts: ChannelOpts) => new WebChannel(opts));
