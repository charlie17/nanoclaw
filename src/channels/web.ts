// Bridge — Daystrom's web chat channel. v2-authored per D-91 (Impl-16, 2026-04-16).
// See three-man-team/handoff/BRIDGE-BUILD-SPEC.md for the spec.
// Specific patterns lifted from rozek/nanoclaw@9311ff1 with inline attribution
// ("Pattern from rozek/nanoclaw@9311ff1 — <purpose>"). Bulk authorship is ours.

import crypto from 'crypto';
import http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import type { AddressInfo } from 'net';

import {
  ASSISTANT_NAME,
  NANOCLAW_TOKEN,
  NANOCLAW_WEB_HOST,
  NANOCLAW_WEB_PORT,
} from '../config.js';
import { getAllChats, getMessagesSince, storeChatMetadata } from '../db.js';
import type { ChatInfo } from '../db.js';
import { logger } from '../logger.js';
import { registerChannel } from './registry.js';
import type { ChannelOpts } from './registry.js';
// JT: Channel, NewMessage from src/types.ts — upstream-owned shapes
import type { Channel, NewMessage } from '../types.js';

// ── Constants ───────────────────────────────────────────────────────────────

const BODY_LIMIT = 1_048_576; // 1 MB non-upload body cap — D-S1.14
const SSE_HEARTBEAT_MS = 20_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_IP_CAP = 1000;
const TYPING_TIMEOUT_MS = 30_000;
const HISTORY_LIMIT = 500;
const SID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const RESERVED_SID = 'cron';
// D-S1.13
const CSP =
  "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:";

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
#sl{flex:1;overflow-y:auto;padding:.25rem 0}
.si{padding:.55rem .75rem;cursor:pointer;font-size:.88rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-radius:6px;margin:.1rem .3rem}
.si:hover{background:var(--in-bg)}
.si.active{background:var(--bub-u);color:#fff}
#sf{padding:.5rem .75rem;border-top:1px solid var(--bd);display:flex;justify-content:flex-end}
#dm-btn{border:none;background:none;cursor:pointer;font-size:1.1rem;padding:.2rem}
#chat{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
#msgs{flex:1;overflow-y:auto;padding:.75rem 1rem;display:flex;flex-direction:column;gap:.4rem}
.m{max-width:78%;padding:.45rem .75rem;border-radius:14px;font-size:.94rem;line-height:1.45;white-space:pre-wrap;word-break:break-word}
.m.u{align-self:flex-end;background:var(--bub-u);color:#fff;border-bottom-right-radius:4px}
.m.b{align-self:flex-start;background:var(--bub-b);color:var(--bub-bf);border-bottom-left-radius:4px}
#typing{padding:.25rem 1rem;font-size:.82rem;opacity:.55;display:none}
#ia{padding:.65rem .75rem;border-top:1px solid var(--bd);display:flex;gap:.5rem;align-items:flex-end}
#inp{flex:1;padding:.5rem .7rem;border:1px solid var(--bd);border-radius:12px;background:var(--in-bg);color:var(--fg);font-size:.95rem;resize:none;line-height:1.4;max-height:120px;font-family:inherit}
#send{padding:.5rem 1rem;border:none;border-radius:12px;background:var(--bub-u);color:#fff;cursor:pointer;font-size:.94rem;flex-shrink:0;font-weight:500}
#send:disabled,#inp:disabled{opacity:.45;cursor:default}
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
  <div id="sidebar">
    <div id="sh"><span>Chats</span><button id="new-btn" title="New chat">+</button></div>
    <div id="sl"></div>
    <div id="sf"><button id="dm-btn" title="Toggle dark mode">\u{1F319}</button></div>
  </div>
  <div id="chat">
    <div id="msgs"></div>
    <div id="typing">${ASSISTANT_NAME} is thinking\u2026</div>
    <div id="ia">
      <textarea id="inp" placeholder="Message ${ASSISTANT_NAME}\u2026" rows="2"></textarea>
      <button id="send">Send</button>
    </div>
  </div>
</div>
<script>
(function(){
'use strict';
var LS='bridge_sid',LD='bridge_dark';
var sid=localStorage.getItem(LS)||mkSid();localStorage.setItem(LS,sid);
var sse=null,reconDelay=1000,botDiv=null,busy=false;

function mkSid(){var a=new Uint8Array(8);crypto.getRandomValues(a);return Array.from(a,function(b){return b.toString(16).padStart(2,'0')}).join('');}

var dark=localStorage.getItem(LD);
if(dark==='dark'||(dark===null&&matchMedia('(prefers-color-scheme:dark)').matches))document.body.classList.add('dark');
document.getElementById('dm-btn').onclick=function(){var d=document.body.classList.toggle('dark');localStorage.setItem(LD,d?'dark':'light');};

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
  var r=await api('/chat/sessions');if(!r)return;
  var ss=await r.json();
  var el=document.getElementById('sl');el.innerHTML='';
  ss.forEach(function(s){
    var d=document.createElement('div');d.className='si'+(s.sid===sid?' active':'');
    d.textContent=s.name;d.dataset.sid=s.sid;
    d.onclick=function(){if(s.sid!==sid)switchSid(s.sid);};
    el.appendChild(d);
  });
}

function switchSid(ns){sid=ns;localStorage.setItem(LS,sid);document.getElementById('msgs').innerHTML='';botDiv=null;loadSessions();loadHistory();connectSse();}

document.getElementById('new-btn').onclick=function(){switchSid(mkSid());};

async function loadHistory(){
  var r=await api('/chat/history?sid='+sid);if(!r)return;
  var ms=await r.json(),el=document.getElementById('msgs');el.innerHTML='';botDiv=null;
  ms.forEach(function(m){addMsg(m.content,m.is_from_me?'u':'b',m.id);});
}

function addMsg(text,role,id){
  var el=document.getElementById('msgs');
  if(id){var ex=el.querySelector('[data-id="'+id+'"]');if(ex){ex.textContent=text;scrollMsgs();return;}}
  var d=document.createElement('div');d.className='m '+role;if(id)d.dataset.id=id;d.textContent=text;el.appendChild(d);scrollMsgs();
  return d;
}
function scrollMsgs(){var e=document.getElementById('msgs');e.scrollTop=e.scrollHeight;}

// Pattern from rozek/nanoclaw@9311ff1 — EventSource reconnect with exponential backoff, cap 30s
function connectSse(){
  if(sse){sse.close();sse=null;}
  var s=new EventSource('/chat/events?sid='+sid);sse=s;
  s.onopen=function(){reconDelay=1000;};
  s.onerror=function(){s.close();sse=null;reconDelay=Math.min(reconDelay*2,30000);setTimeout(connectSse,reconDelay);};
  s.addEventListener('user_message',function(e){var d=JSON.parse(e.data);addMsg(d.text,'u',d.id);});
  s.addEventListener('agent_output',function(e){
    var d=JSON.parse(e.data);
    if(botDiv){botDiv.textContent+=d.text;}else{botDiv=addMsg(d.text,'b');}
    scrollMsgs();
  });
  s.addEventListener('typing',function(e){
    var on=e.data==='true';
    document.getElementById('typing').style.display=on?'':'none';
    if(!on){botDiv=null;setBusy(false);}
    scrollMsgs();
  });
  s.addEventListener('sessions_changed',loadSessions);
}

function setBusy(v){busy=v;document.getElementById('send').disabled=v;document.getElementById('inp').disabled=v;}
document.getElementById('send').onclick=sendMsg;
document.getElementById('inp').addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg();}});
async function sendMsg(){
  if(busy)return;
  var inp=document.getElementById('inp'),txt=inp.value.trim();if(!txt)return;
  inp.value='';setBusy(true);
  var r=await api('/chat/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sid:sid,content:txt})});
  if(!r||!r.ok){setBusy(false);inp.value=txt;}
}

function init(){loadSessions();loadHistory();connectSse();}
fetch('/chat/sessions').then(function(r){r.ok?showApp():showLogin('');}).catch(function(){showLogin('');});
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
    broadcastToSession(
      this.clientsBySid,
      sid,
      'agent_output',
      JSON.stringify({ text }),
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
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // C6: All state-mutating routes are POST; GET / and static assets are unauthenticated
    if (method === 'GET' && path === '/') {
      this.handleSpa(res);
      return;
    }
    if (method === 'GET' && path === '/manifest.json') {
      this.handleManifest(res);
      return;
    }
    if (method === 'GET' && path.startsWith('/static/')) {
      this.handleStatic(path, res);
      return;
    }
    if (method === 'POST' && path === '/auth/login') {
      await this.handleAuthLogin(req, res);
      return;
    }

    if (!this.authorizeRequest(req, res)) return;

    if (method === 'GET' && path === '/chat/events') {
      this.handleSse(req, res, url);
      return;
    }
    if (method === 'POST' && path === '/chat/message') {
      await this.handlePostMessage(req, res);
      return;
    }
    if (method === 'GET' && path === '/chat/history') {
      this.handleGetHistory(res, url);
      return;
    }
    if (method === 'GET' && path === '/chat/sessions') {
      this.handleGetSessions(res);
      return;
    }

    res.writeHead(404).end('Not Found');
  }

  // ── Route handlers ────────────────────────────────────────────────────────

  private handleSpa(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': CSP, // D-S1.13
      'Cache-Control': 'no-cache',
    });
    res.end(SPA_HTML);
  }

  private handleManifest(res: ServerResponse): void {
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
    res.end(JSON.stringify(manifest));
  }

  private handleStatic(path: string, res: ServerResponse): void {
    const isIcon =
      path === '/static/icon-192.png' ||
      path === '/static/icon-512.png' ||
      path === '/static/apple-touch-icon.png';
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
    res.end(svg);
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
    if (this.isRateLimited(ip, now)) { // D-S1d.3: check before collectBody
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
    const cookieAttrs = `HttpOnly; SameSite=Strict; Path=/${isSecure ? '; Secure' : ''}`;
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': `nanoclaw_token=${encodeURIComponent(NANOCLAW_TOKEN)}; ${cookieAttrs}`,
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

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const isFirstClientForSid = !this.clientsBySid.has(sid);
    if (isFirstClientForSid) {
      this.clientsBySid.set(sid, new Set());
    }
    this.clientsBySid.get(sid)!.add(res);
    logger.debug({ sid }, '[bridge] SSE client connected');

    this.ensureSession(sid, isFirstClientForSid);

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
    const msgs = getMessagesSince(jid, '', ASSISTANT_NAME, HISTORY_LIMIT);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(msgs));
  }

  private handleGetSessions(res: ServerResponse): void {
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
      }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sessions));
  }

  // ── Session management ────────────────────────────────────────────────────

  private ensureSession(sid: string, broadcast = true): void {
    const jid = jidFromSid(sid);
    const ts = new Date().toISOString();
    // Idempotent — storeChatMetadata uses INSERT OR ... DO UPDATE (no name overwrite when undefined)
    storeChatMetadata(jid, ts, undefined, 'web', false);
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
      // D-S1.12: 30s safety timeout clears typing if agent never responds
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
