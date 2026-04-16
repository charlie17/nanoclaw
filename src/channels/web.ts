// Bridge — Daystrom's web chat channel. v2-authored per D-91 (Impl-16, 2026-04-16).
// See three-man-team/handoff/BRIDGE-BUILD-SPEC.md for the spec.
// Specific patterns lifted from rozek/nanoclaw@9311ff1 with inline attribution
// ("Pattern from rozek/nanoclaw@9311ff1 — <purpose>"). Bulk authorship is ours.

import crypto from 'crypto';
import http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  ASSISTANT_NAME,
  NANOCLAW_TOKEN,
  NANOCLAW_WEB_HOST,
  NANOCLAW_WEB_PORT,
} from '../config.js';
import {
  clearChatMessages,
  deleteChat,
  deleteMessage,
  getAllChats,
  getMessagesSince,
  setRouterState,
  storeChatMetadata,
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
const TYPING_TIMEOUT_MS = 30_000;
const HISTORY_LIMIT = 500;
const SESSION_ORDER_MAX = 500;
const SID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const RESERVED_SID = 'cron';
// D-S1.13
const CSP =
  "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:";

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
.si{padding:.55rem .75rem;cursor:default;font-size:.88rem;border-radius:6px;margin:.1rem .3rem;display:flex;align-items:center;gap:.2rem}
.si:hover{background:var(--in-bg)}
.si.active{background:var(--bub-u);color:#fff}
.si-lbl{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;cursor:pointer}
.si-acts{display:none;flex-shrink:0;gap:.1rem}
.si:hover .si-acts,.si.active .si-acts{display:flex}
.si-btn{border:none;background:none;cursor:pointer;font-size:.75rem;padding:.15rem .25rem;opacity:.55;border-radius:3px;color:inherit;line-height:1}
.si-btn:hover{opacity:1;background:rgba(0,0,0,.1)}
.si.active .si-btn:hover{background:rgba(255,255,255,.2)}
#sf{padding:.5rem .75rem;border-top:1px solid var(--bd);display:flex;justify-content:flex-end;gap:.25rem}
#dm-btn,#ch-btn{border:none;background:none;cursor:pointer;font-size:1.1rem;padding:.2rem}
#chat{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
#msgs{flex:1;overflow-y:auto;padding:.75rem 1rem;display:flex;flex-direction:column;gap:.4rem}
.m{max-width:78%;padding:.45rem .75rem;border-radius:14px;font-size:.94rem;line-height:1.45;white-space:pre-wrap;word-break:break-word;position:relative}
.m.u{align-self:flex-end;background:var(--bub-u);color:#fff;border-bottom-right-radius:4px}
.m.b{align-self:flex-start;background:var(--bub-b);color:var(--bub-bf);border-bottom-left-radius:4px}
.m-del{position:absolute;top:-.35rem;right:-.35rem;display:none;border:none;border-radius:50%;width:1.1rem;height:1.1rem;background:var(--bd);color:var(--fg);font-size:.65rem;cursor:pointer;align-items:center;justify-content:center;padding:0;line-height:1}
.m:hover .m-del{display:flex}
#typing{padding:.25rem 1rem;font-size:.82rem;opacity:.55;display:none}
#ia{padding:.65rem .75rem;border-top:1px solid var(--bd);display:flex;gap:.5rem;align-items:flex-end}
#up-lbl{cursor:pointer;padding:.5rem .55rem;border:1px solid var(--bd);border-radius:12px;font-size:.95rem;flex-shrink:0;user-select:none;line-height:1}
#inp{flex:1;padding:.5rem .7rem;border:1px solid var(--bd);border-radius:12px;background:var(--in-bg);color:var(--fg);font-size:.95rem;resize:none;line-height:1.4;max-height:120px;font-family:inherit}
#cancel-btn{padding:.5rem .7rem;border:1px solid var(--bd);border-radius:12px;background:none;color:var(--fg);cursor:pointer;font-size:.88rem;flex-shrink:0;display:none}
#send{padding:.5rem 1rem;border:none;border-radius:12px;background:var(--bub-u);color:#fff;cursor:pointer;font-size:.94rem;flex-shrink:0;font-weight:500}
#send:disabled,#inp:disabled,#cancel-btn:disabled{opacity:.45;cursor:default}
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
    <div id="sf"><button id="ch-btn" title="Clear history">\u{1F5D1}</button><button id="dm-btn" title="Toggle dark mode">\u{1F319}</button></div>
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
</div>
<script>
(function(){
'use strict';
var LS='bridge_sid',LD='bridge_dark';
var sid=localStorage.getItem(LS)||mkSid();localStorage.setItem(LS,sid);
var sse=null,reconDelay=1000,botDiv=null,busy=false,sessionOrder=[];

function mkSid(){var a=new Uint8Array(8);crypto.getRandomValues(a);return Array.from(a,function(b){return b.toString(16).padStart(2,'0')}).join('');}

var dark=localStorage.getItem(LD);
if(dark==='dark'||(dark===null&&matchMedia('(prefers-color-scheme:dark)').matches))document.body.classList.add('dark');
document.getElementById('dm-btn').onclick=function(){var d=document.body.classList.toggle('dark');localStorage.setItem(LD,d?'dark':'light');};
document.getElementById('ch-btn').onclick=clearHistory;

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
  if(sessionOrder.length){ss.sort(function(a,b){var ia=sessionOrder.indexOf(a.sid),ib=sessionOrder.indexOf(b.sid);if(ia===-1&&ib===-1)return 0;if(ia===-1)return 1;if(ib===-1)return -1;return ia-ib;});}
  var el=document.getElementById('sl');el.innerHTML='';
  ss.forEach(function(s){
    var row=document.createElement('div');row.className='si'+(s.sid===sid?' active':'');row.dataset.sid=s.sid;
    var lbl=document.createElement('span');lbl.className='si-lbl';lbl.textContent=s.name;
    lbl.onclick=function(){if(s.sid!==sid)switchSid(s.sid);};
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

function switchSid(ns){sid=ns;localStorage.setItem(LS,sid);document.getElementById('msgs').innerHTML='';botDiv=null;loadSessions();loadHistory();connectSse();}

document.getElementById('new-btn').onclick=function(){switchSid(mkSid());};

async function loadHistory(){
  var r=await api('/chat/history?sid='+sid);if(!r)return;
  var ms=await r.json(),el=document.getElementById('msgs');el.innerHTML='';botDiv=null;
  ms.forEach(function(m){addMsg(m.content,m.is_from_me?'u':'b',m.id);});
}

function addMsg(text,role,id){
  var el=document.getElementById('msgs');
  if(id){var ex=el.querySelector('[data-id="'+id+'"]');if(ex){var xt=ex.querySelector('.mt');if(xt)xt.textContent=text;scrollMsgs();return;}}
  var d=document.createElement('div');d.className='m '+role;if(id)d.dataset.id=id;
  var t=document.createElement('span');t.className='mt';t.textContent=text;d.appendChild(t);
  if(id){var del=mk('button','m-del','\xd7');del.title='Delete';del.onclick=function(){deleteMessage(id);};d.appendChild(del);}
  el.appendChild(d);scrollMsgs();
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
    if(botDiv){var t=botDiv.querySelector('.mt');if(t)t.textContent+=d.text;else botDiv.textContent+=d.text;}
    else{botDiv=addMsg(d.text,'b');}
    scrollMsgs();
  });
  s.addEventListener('typing',function(e){
    var on=e.data==='true';
    document.getElementById('typing').style.display=on?'':'none';
    if(!on){botDiv=null;setBusy(false);}
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
    try{var d=JSON.parse(e.data);if(d.removed&&d.removed===sid){switchSid(mkSid());return;}}catch(err){}
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
  if(!r||!r.ok){setBusy(false);inp.value=txt;}
}

async function deleteSession(dsid){
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
      this.handleGetSessions(res);
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
    let parsed: { sid?: string; filename?: string; data?: string; mimeType?: string };
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
        .end(JSON.stringify({ error: 'Extension not allowed', extension: ext }));
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
      logger.warn({ sid, filename: parsed.filename }, '[bridge] Upload rejected — path resolves into quarantine');
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
        logger.error({ err: err2, sid }, '[bridge] Upload collision retry failed');
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
      res.writeHead(err instanceof BodyTooLargeError ? 413 : 400).end('Bad Request');
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
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
  }

  private async handleSessionOrder(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let parsed: { order?: unknown };
    try {
      parsed = JSON.parse(await collectBody(req, BODY_LIMIT)) as typeof parsed;
    } catch (err) {
      res.writeHead(err instanceof BodyTooLargeError ? 413 : 400).end('Bad Request');
      return;
    }
    if (!Array.isArray(parsed.order) || parsed.order.length > SESSION_ORDER_MAX) {
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
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
  }

  private async handleDeleteSession(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let parsed: { sid?: string };
    try {
      parsed = JSON.parse(await collectBody(req, BODY_LIMIT)) as typeof parsed;
    } catch (err) {
      res.writeHead(err instanceof BodyTooLargeError ? 413 : 400).end('Bad Request');
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
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
  }

  private async handleDeleteMessage(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let parsed: { sid?: string; id?: string };
    try {
      parsed = JSON.parse(await collectBody(req, BODY_LIMIT)) as typeof parsed;
    } catch (err) {
      res.writeHead(err instanceof BodyTooLargeError ? 413 : 400).end('Bad Request');
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
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
  }

  private async handleClearHistory(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let parsed: { sid?: string };
    try {
      parsed = JSON.parse(await collectBody(req, BODY_LIMIT)) as typeof parsed;
    } catch (err) {
      res.writeHead(err instanceof BodyTooLargeError ? 413 : 400).end('Bad Request');
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
      res.writeHead(err instanceof BodyTooLargeError ? 413 : 400).end('Bad Request');
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
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
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
