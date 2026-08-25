import fs from 'node:fs';
import path from 'node:path';
import http from 'http';
import type { AddressInfo } from 'net';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// ── Mocks (must precede all imports from mocked modules) ──────────────────────

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// vi.hoisted: per-test OAuth count override for AU-5
const mockOauthReturns = vi.hoisted(() => ({ counts: [] as number[] }));

vi.mock('../db.js', () => ({
  storeChatMetadata: vi.fn(),
  storeMessage: vi.fn(),
  getAllChats: vi.fn(() => []),
  getMessagesSince: vi.fn(() => []),
  getConversation: vi.fn(() => []),
  updateChatName: vi.fn(),
  setRouterState: vi.fn(),
  deleteChat: vi.fn(),
  deleteMessage: vi.fn(() => true),
  clearChatMessages: vi.fn(() => 3),
  getMessageCountForMonth: vi.fn(() => {
    const v = mockOauthReturns.counts.shift();
    return v ?? 0;
  }),
  // board-v2 SPEC §4.3 — the insight-task poke.
  getTaskById: vi.fn(() => undefined),
  updateTask: vi.fn(),
}));

// vi.hoisted: allows per-test group folder path override (same pattern as mockConfig)
const mockGroupFolder = vi.hoisted(() => ({
  path: '/tmp/test-groups/daystrom',
}));

vi.mock('../group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(() => mockGroupFolder.path),
}));

// vi.hoisted: controls execFile behavior per test (shouldFail → timeout path)
const execFileMock = vi.hoisted(() => ({
  stdout: 'container-a,running\n',
  shouldFail: false,
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (execFileMock.shouldFail) cb(new Error('Command timed out'), '', '');
      else cb(null, execFileMock.stdout, '');
    },
  ),
}));

// vi.hoisted: controls net.connect socket behavior per test (proxyUp flag)
const netMock = vi.hoisted(() => {
  const h: Record<string, Array<(...a: unknown[]) => void>> = {};
  const socket = {
    on(e: string, cb: (...a: unknown[]) => void) {
      (h[e] = h[e] || []).push(cb);
      return socket;
    },
    end: vi.fn(),
    destroy: vi.fn(),
  };
  return {
    socket,
    h,
    proxyUp: true,
    reset() {
      Object.keys(h).forEach((k) => delete h[k]);
      this.proxyUp = true;
    },
  };
});

vi.mock('net', () => ({
  default: {
    connect: vi.fn((_p: number, _ho: string) => {
      setTimeout(() => {
        if (netMock.proxyUp) (netMock.h['connect'] || []).forEach((c) => c());
        else
          (netMock.h['error'] || []).forEach((c) =>
            c(new Error('ECONNREFUSED')),
          );
      }, 0);
      return netMock.socket;
    }),
  },
}));

// mkdir/rename/rm are used by the board-v2 state-dir atomic writes.
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  statfs: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
}));

const mockConfig = vi.hoisted(() => ({
  NANOCLAW_TOKEN: 'test-secret-token',
  WIDGET_FEEDBACK_TOKEN: 'test-widget-token',
  NANOCLAW_WEB_HOST: '127.0.0.1',
  NANOCLAW_WEB_PORT: 0,
  ASSISTANT_NAME: 'Daystrom',
  CLAUDE_USAGE_PORT: 8080,
  OWUI_PORT: 8081,
}));

vi.mock('../config.js', () => ({
  get NANOCLAW_TOKEN() {
    return mockConfig.NANOCLAW_TOKEN;
  },
  get WIDGET_FEEDBACK_TOKEN() {
    return mockConfig.WIDGET_FEEDBACK_TOKEN;
  },
  get NANOCLAW_WEB_HOST() {
    return mockConfig.NANOCLAW_WEB_HOST;
  },
  get NANOCLAW_WEB_PORT() {
    return mockConfig.NANOCLAW_WEB_PORT;
  },
  get ASSISTANT_NAME() {
    return mockConfig.ASSISTANT_NAME;
  },
  get CLAUDE_USAGE_PORT() {
    return mockConfig.CLAUDE_USAGE_PORT;
  },
  get OWUI_PORT() {
    return mockConfig.OWUI_PORT;
  },
  CREDENTIAL_PROXY_PORT: 3001,
  NANOCLAW_ANTHROPIC_RATE_PER_DISPATCH: 0.2,
}));

import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import {
  clearChatMessages,
  deleteChat,
  deleteMessage as dbDeleteMessage,
  getConversation,
  getMessageCountForMonth,
  getTaskById,
  setRouterState,
  storeChatMetadata,
  storeMessage,
  updateChatName,
  updateTask,
} from '../db.js';
import { logger } from '../logger.js';
import {
  checkToken,
  isAllowedExtension,
  sanitizeFilename,
  sanitizeSid,
  TYPING_TIMEOUT_MS,
  validateBridgeConfig,
  WebChannel,
} from './web.js';
import type { ChannelOpts } from './registry.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOpts(): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
  };
}

function req(
  port: number,
  opts: http.RequestOptions,
  body?: string,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: '127.0.0.1', port, ...opts }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

// ── sanitizeSid ───────────────────────────────────────────────────────────────

describe('sanitizeSid', () => {
  it('accepts valid alphanumeric + hyphen + underscore sids', () => {
    expect(sanitizeSid('abc-123_XYZ')).toBe('abc-123_XYZ');
  });

  it('accepts sid at exactly 64 chars', () => {
    expect(sanitizeSid('a'.repeat(64))).toBe('a'.repeat(64));
  });

  it('rejects sid at 65 chars', () => {
    expect(sanitizeSid('a'.repeat(65))).toBeNull();
  });

  it('rejects sid with space', () => {
    expect(sanitizeSid('hello world')).toBeNull();
  });

  it('rejects sid with dot-dot path traversal attempt', () => {
    expect(sanitizeSid('../evil')).toBeNull();
  });

  it('rejects sid with @', () => {
    expect(sanitizeSid('local@web-abc')).toBeNull();
  });

  it('rejects empty string', () => {
    expect(sanitizeSid('')).toBeNull();
  });

  it('rejects undefined', () => {
    expect(sanitizeSid(undefined)).toBeNull();
  });

  it('rejects reserved sid "cron"', () => {
    expect(sanitizeSid('cron')).toBeNull();
  });
});

// ── validateBridgeConfig ──────────────────────────────────────────────────────

describe('validateBridgeConfig', () => {
  it('throws when non-loopback host + empty token', () => {
    expect(() => validateBridgeConfig('0.0.0.0', '')).toThrow(
      'Bridge requires NANOCLAW_TOKEN when bound to non-loopback host',
    );
  });

  it('does not throw for loopback host + empty token', () => {
    expect(() => validateBridgeConfig('127.0.0.1', '')).not.toThrow();
    expect(() => validateBridgeConfig('::1', '')).not.toThrow();
    expect(() => validateBridgeConfig('localhost', '')).not.toThrow();
  });

  it('does not throw for non-loopback host + non-empty token', () => {
    expect(() => validateBridgeConfig('0.0.0.0', 'secret')).not.toThrow();
  });
});

// ── checkToken ────────────────────────────────────────────────────────────────

describe('checkToken', () => {
  it('returns true for identical tokens', () => {
    expect(checkToken('mysecret', 'mysecret')).toBe(true);
  });

  it('returns false for mismatched tokens of same length', () => {
    expect(checkToken('mysecret', 'myfailed')).toBe(false);
  });

  it('returns false for different-length tokens without throwing', () => {
    // crypto.timingSafeEqual throws on length mismatch — checkToken must not throw
    expect(() => checkToken('short', 'muchlongertoken')).not.toThrow();
    expect(checkToken('short', 'muchlongertoken')).toBe(false);
  });
});

// ── HTTP integration tests (real server on random port) ───────────────────────

describe('WebChannel HTTP', () => {
  let channel: WebChannel;
  let port: number;

  beforeAll(async () => {
    channel = new WebChannel(makeOpts());
    await channel.connect();
    port = (
      (
        channel as unknown as { server: http.Server }
      ).server.address() as AddressInfo
    ).port;
  });

  afterAll(async () => {
    await channel.disconnect();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    mockConfig.NANOCLAW_TOKEN = 'test-secret-token';
  });

  // ── GET / — SPA (no auth required) ────────────────────────────────────────

  it('GET / returns 200 + CSP header without auth', async () => {
    const res = await req(port, { method: 'GET', path: '/' });
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toContain(
      "default-src 'self'",
    );
    expect(res.body).toContain('<!DOCTYPE html>');
  });

  // ── Auth gate ─────────────────────────────────────────────────────────────

  it('authenticated route without token returns 401', async () => {
    const res = await req(port, { method: 'GET', path: '/chat/sessions' });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('Bearer');
  });

  it('authenticated route with valid Bearer token returns 200', async () => {
    const res = await req(port, {
      method: 'GET',
      path: '/chat/sessions',
      headers: { Authorization: 'Bearer test-secret-token' },
    });
    expect(res.status).toBe(200);
  });

  it('authenticated route with wrong Bearer token returns 401', async () => {
    const res = await req(port, {
      method: 'GET',
      path: '/chat/sessions',
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('does not accept ?token= query param for auth', async () => {
    const res = await req(port, {
      method: 'GET',
      path: '/chat/sessions?token=test-secret-token',
    });
    expect(res.status).toBe(401);
  });

  it('POST /auth/login with valid token sets cookie and returns 200', async () => {
    const body = JSON.stringify({ token: 'test-secret-token' });
    const res = await req(
      port,
      {
        method: 'POST',
        path: '/auth/login',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body).toString(),
        },
      },
      body,
    );
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']?.[0]).toContain('nanoclaw_token=');
    expect(res.headers['set-cookie']?.[0]).toContain('HttpOnly');
    expect(res.headers['set-cookie']?.[0]).toContain('SameSite=Lax');
    expect(res.headers['set-cookie']?.[0]).toContain('Max-Age=15552000');
  });

  it('POST /auth/login with invalid token returns 401', async () => {
    const body = JSON.stringify({ token: 'wrong' });
    const res = await req(
      port,
      {
        method: 'POST',
        path: '/auth/login',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body).toString(),
        },
      },
      body,
    );
    expect(res.status).toBe(401);
  });

  // ── Rate-limit ────────────────────────────────────────────────────────────

  it('returns 429 after 5 consecutive failed auth attempts from same IP', async () => {
    // Use a dedicated channel so rate-limit state is isolated
    const rl = new WebChannel(makeOpts());
    await rl.connect();
    const rlPort = (
      (rl as unknown as { server: http.Server }).server.address() as AddressInfo
    ).port;

    try {
      for (let i = 0; i < 5; i++) {
        const r = await req(rlPort, {
          method: 'GET',
          path: '/chat/sessions',
          headers: { Authorization: 'Bearer wrong' },
        });
        expect(r.status).toBe(401);
      }
      const r6 = await req(rlPort, {
        method: 'GET',
        path: '/chat/sessions',
        headers: { Authorization: 'Bearer wrong' },
      });
      expect(r6.status).toBe(429);
      expect(r6.headers['retry-after']).toBe('60');
    } finally {
      await rl.disconnect();
    }
  });

  // ── V-1: SSE sid validation ────────────────────────────────────────────────

  it('GET /chat/events?sid=cron returns 400', async () => {
    const res = await req(port, {
      method: 'GET',
      path: '/chat/events?sid=cron',
      headers: { Authorization: 'Bearer test-secret-token' },
    });
    expect(res.status).toBe(400);
  });

  it('GET /chat/events with invalid sid returns 400', async () => {
    const res = await req(port, {
      method: 'GET',
      path: '/chat/events?sid=hello@world',
      headers: { Authorization: 'Bearer test-secret-token' },
    });
    expect(res.status).toBe(400);
  });

  it('GET /chat/events with no sid param opens SSE stream (200)', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const r = http.request(
        {
          hostname: '127.0.0.1',
          port,
          method: 'GET',
          path: '/chat/events',
          headers: { Authorization: 'Bearer test-secret-token' },
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.destroy();
        },
      );
      r.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'ECONNRESET') return;
        reject(e);
      });
      r.end();
    });
    expect(status).toBe(200);
  });

  // ── V-3: malformed cookie ──────────────────────────────────────────────────

  it('malformed percent-escape in cookie returns 401 not 500', async () => {
    const res = await req(port, {
      method: 'GET',
      path: '/chat/sessions',
      headers: { Cookie: 'nanoclaw_token=%E0%A4%A' },
    });
    expect(res.status).toBe(401);
  });

  // ── D-V53.B: /auth/logout ─────────────────────────────────────────────────

  it('POST /auth/logout with valid Bearer token clears cookie and returns 200', async () => {
    const res = await req(port, {
      method: 'POST',
      path: '/auth/logout',
      headers: { Authorization: 'Bearer test-secret-token' },
    });
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']?.[0]).toContain('nanoclaw_token=');
    expect(res.headers['set-cookie']?.[0]).toContain('Max-Age=0');
    expect(res.headers['set-cookie']?.[0]).toContain('SameSite=Lax');
    expect(res.headers['set-cookie']?.[0]).toContain('HttpOnly');
    const body = JSON.parse(res.body ?? '{}') as { ok?: boolean };
    expect(body.ok).toBe(true);
  });

  it('POST /auth/logout without auth returns 401', async () => {
    const res = await req(port, {
      method: 'POST',
      path: '/auth/logout',
    });
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('POST /auth/logout with valid cookie auth clears cookie and returns 200', async () => {
    const res = await req(port, {
      method: 'POST',
      path: '/auth/logout',
      headers: { Cookie: 'nanoclaw_token=test-secret-token' },
    });
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']?.[0]).toContain('nanoclaw_token=');
    expect(res.headers['set-cookie']?.[0]).toContain('Max-Age=0');
  });

  // ── D-S1d: /auth/login rate-limit ─────────────────────────────────────────

  it('/auth/login rate-limit fires on 6th bad-token attempt', async () => {
    const rl = new WebChannel(makeOpts());
    await rl.connect();
    const rlPort = (
      (rl as unknown as { server: http.Server }).server.address() as AddressInfo
    ).port;

    try {
      const loginBody = JSON.stringify({ token: 'wrong' });
      const loginOpts = {
        method: 'POST',
        path: '/auth/login',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(loginBody).toString(),
        },
      };
      for (let i = 0; i < 5; i++) {
        const r = await req(rlPort, loginOpts, loginBody);
        expect(r.status).toBe(401);
      }
      const r6 = await req(rlPort, loginOpts, loginBody);
      expect(r6.status).toBe(429);
      expect(r6.headers['retry-after']).toBe('60');
    } finally {
      await rl.disconnect();
    }
  });

  it('does not rate-limit /auth/login when NANOCLAW_TOKEN is empty', async () => {
    mockConfig.NANOCLAW_TOKEN = '';
    const noAuth = new WebChannel(makeOpts());
    await noAuth.connect();
    const naPort = (
      (
        noAuth as unknown as { server: http.Server }
      ).server.address() as AddressInfo
    ).port;

    try {
      const body = JSON.stringify({ token: 'anything' });
      const opts = {
        method: 'POST',
        path: '/auth/login',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body).toString(),
        },
      };
      for (let i = 0; i < 10; i++) {
        const r = await req(naPort, opts, body);
        expect(r.status).toBe(200);
      }
      // State assertion: no rate-limit accounting occurred
      expect(
        (noAuth as unknown as { authAttempts: Map<string, unknown> })
          .authAttempts.size,
      ).toBe(0);
    } finally {
      await noAuth.disconnect();
    }
  });
});

// ── sanitizeFilename ──────────────────────────────────────────────────────────

describe('sanitizeFilename', () => {
  it('strips Unicode control characters', () => {
    expect(sanitizeFilename('\x00hello.txt')).toBe('hello.txt');
  });

  it('strips forward slash', () => {
    expect(sanitizeFilename('foo/bar.txt')).toBe('foobar.txt');
  });

  it('strips backslash', () => {
    expect(sanitizeFilename('foo\\bar.txt')).toBe('foobar.txt');
  });

  it('path.basename belt removes leading traversal after sep-strip', () => {
    // After sep-strip, '../etc/passwd.txt' -> '....etcpasswd.txt'; basename is a no-op there.
    // Absolute path '/etc/passwd.txt' -> 'etcpasswd.txt' after sep-strip.
    const result = sanitizeFilename('/etc/passwd.txt');
    expect(result).not.toBeNull();
    expect(result).not.toContain('/');
    expect(result).not.toContain('\\');
  });

  it('trims and collapses whitespace', () => {
    expect(sanitizeFilename('  hello   world.txt  ')).toBe('hello world.txt');
  });

  it('caps at 200 characters', () => {
    const long = 'a'.repeat(201) + '.txt';
    const result = sanitizeFilename(long);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(200);
  });

  it('returns null on empty post-sanitize', () => {
    expect(sanitizeFilename('\x00\x01\x02')).toBeNull();
  });

  it('passes normal filename unchanged', () => {
    expect(sanitizeFilename('receipt-2026.pdf')).toBe('receipt-2026.pdf');
  });
});

// ── isAllowedExtension ────────────────────────────────────────────────────────

describe('isAllowedExtension', () => {
  it.each([
    'photo.jpg',
    'photo.jpeg',
    'image.png',
    'animation.gif',
    'picture.webp',
    'photo.heic',
    'doc.pdf',
    'notes.md',
    'readme.txt',
    'data.csv',
    'config.json',
    'settings.yaml',
    'settings.yml',
    'report.docx',
    'slides.pptx',
    'sheet.xlsx',
    'archive.zip',
  ])('allows %s', (filename) => {
    expect(isAllowedExtension(filename)).toBe(true);
  });

  it('allows .tar.gz two-dot extension', () => {
    expect(isAllowedExtension('archive.tar.gz')).toBe(true);
  });

  it('is case-insensitive (.PDF, .JPEG)', () => {
    expect(isAllowedExtension('report.PDF')).toBe(true);
    expect(isAllowedExtension('photo.JPEG')).toBe(true);
  });

  it('rejects .exe', () => {
    expect(isAllowedExtension('malware.exe')).toBe(false);
  });

  it('rejects .sh', () => {
    expect(isAllowedExtension('script.sh')).toBe(false);
  });

  it('rejects .js', () => {
    expect(isAllowedExtension('code.js')).toBe(false);
  });

  it('rejects .env', () => {
    expect(isAllowedExtension('.env')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isAllowedExtension('')).toBe(false);
  });
});

// ── Upload + session affordance integration tests ─────────────────────────────

describe('WebChannel HTTP — upload + affordances', () => {
  let uploadChannel: WebChannel;
  let uploadOpts: ChannelOpts;
  let uploadPort: number;

  beforeAll(async () => {
    uploadOpts = {
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: vi.fn(() => ({
        daystrom: {
          name: 'Daystrom',
          folder: 'daystrom',
          trigger: '',
          added_at: '',
          isMain: true,
        },
      })),
    };
    uploadChannel = new WebChannel(uploadOpts);
    await uploadChannel.connect();
    uploadPort = (
      (
        uploadChannel as unknown as { server: http.Server }
      ).server.address() as AddressInfo
    ).port;
  });

  afterAll(async () => {
    await uploadChannel.disconnect();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGroupFolder.path = '/tmp/test-groups/daystrom';
    // Re-apply registeredGroups mock (cleared by clearAllMocks)
    vi.mocked(uploadOpts.registeredGroups).mockReturnValue({
      daystrom: {
        name: 'Daystrom',
        folder: 'daystrom',
        trigger: '',
        added_at: '',
        isMain: true,
      },
    });
    vi.mocked(dbDeleteMessage).mockReturnValue(true);
    vi.mocked(clearChatMessages).mockReturnValue(3);
  });

  afterEach(() => {
    mockGroupFolder.path = '/tmp/test-groups/daystrom';
  });

  function authHeaders(extra?: Record<string, string>) {
    return {
      Authorization: 'Bearer test-secret-token',
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  function uploadBody(opts: {
    sid?: string;
    filename?: string;
    data?: string;
  }) {
    return JSON.stringify({
      sid: opts.sid ?? 'abc123',
      filename: opts.filename ?? 'receipt.pdf',
      data: opts.data ?? Buffer.from('hello').toString('base64'),
    });
  }

  // ── Upload ─────────────────────────────────────────────────────────────────

  it('POST /chat/upload disallowed extension returns 400 with extension field', async () => {
    vi.mocked(writeFile).mockResolvedValue(undefined);
    const body = uploadBody({ filename: 'malware.exe' });
    const r = await req(
      uploadPort,
      {
        method: 'POST',
        path: '/chat/upload',
        headers: authHeaders({
          'Content-Length': Buffer.byteLength(body).toString(),
        }),
      },
      body,
    );
    expect(r.status).toBe(400);
    const parsed = JSON.parse(r.body) as { error: string; extension: string };
    expect(parsed.error).toBe('Extension not allowed');
    expect(parsed.extension).toBe('.exe');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('POST /chat/upload valid file returns 200 and synthesizes NewMessage (D-83)', async () => {
    vi.mocked(writeFile).mockResolvedValue(undefined);
    const body = uploadBody({ filename: 'receipt.pdf' });
    const r = await req(
      uploadPort,
      {
        method: 'POST',
        path: '/chat/upload',
        headers: authHeaders({
          'Content-Length': Buffer.byteLength(body).toString(),
        }),
      },
      body,
    );
    expect(r.status).toBe(200);
    expect(uploadOpts.onMessage).toHaveBeenCalledTimes(1);
    const [, msg] = vi.mocked(uploadOpts.onMessage).mock.calls[0] as [
      string,
      { content: string },
    ];
    expect(msg.content).toMatch(/^Uploaded a file:/);
  });

  it('POST /chat/upload body too large returns 413', async () => {
    const big = JSON.stringify({
      sid: 'abc123',
      filename: 'f.pdf',
      data: 'x'.repeat(10_000_001),
    });
    const r = await req(
      uploadPort,
      {
        method: 'POST',
        path: '/chat/upload',
        headers: authHeaders({
          'Content-Length': Buffer.byteLength(big).toString(),
        }),
      },
      big,
    );
    expect(r.status).toBe(413);
  });

  it('POST /chat/upload quarantine path returns 403 — no write, no onMessage (C3 bulletproof)', async () => {
    // Simulate a misconfigured mount: groupDir resolves into quarantine
    mockGroupFolder.path = '/home/ubuntu/vault/groups/quarantine/uploads';
    vi.mocked(uploadOpts.registeredGroups).mockReturnValue({
      daystrom: {
        name: 'Daystrom',
        folder: 'daystrom',
        trigger: '',
        added_at: '',
        isMain: true,
      },
    });
    vi.mocked(writeFile).mockResolvedValue(undefined);
    const body = uploadBody({ filename: 'receipt.pdf' });
    const r = await req(
      uploadPort,
      {
        method: 'POST',
        path: '/chat/upload',
        headers: authHeaders({
          'Content-Length': Buffer.byteLength(body).toString(),
        }),
      },
      body,
    );
    expect(r.status).toBe(403);
    expect(writeFile).not.toHaveBeenCalled(); // no fs write
    expect(uploadOpts.onMessage).not.toHaveBeenCalled(); // no IPC synthesis
  });

  it('POST /chat/upload EEXIST collision retries with timestamp suffix', async () => {
    const eexist = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    vi.mocked(writeFile)
      .mockRejectedValueOnce(eexist)
      .mockResolvedValueOnce(undefined);
    const body = uploadBody({ filename: 'receipt.pdf' });
    const r = await req(
      uploadPort,
      {
        method: 'POST',
        path: '/chat/upload',
        headers: authHeaders({
          'Content-Length': Buffer.byteLength(body).toString(),
        }),
      },
      body,
    );
    expect(r.status).toBe(200);
    expect(writeFile).toHaveBeenCalledTimes(2);
    const secondCallPath = (
      vi.mocked(writeFile).mock.calls[1] as [string, ...unknown[]]
    )[0];
    expect(secondCallPath).toMatch(/-\d+\.pdf$/);
  });

  // ── Session name ───────────────────────────────────────────────────────────

  it('POST /chat/session-name valid returns 200 and calls updateChatName', async () => {
    const body = JSON.stringify({ sid: 'abc123', name: 'My Notes' });
    const r = await req(
      uploadPort,
      {
        method: 'POST',
        path: '/chat/session-name',
        headers: authHeaders({
          'Content-Length': Buffer.byteLength(body).toString(),
        }),
      },
      body,
    );
    expect(r.status).toBe(200);
    expect(updateChatName).toHaveBeenCalledWith('local@web-abc123', 'My Notes');
  });

  it('POST /chat/session-name empty-post-sanitize name returns 400', async () => {
    const body = JSON.stringify({ sid: 'abc123', name: '\x00\x01' });
    const r = await req(
      uploadPort,
      {
        method: 'POST',
        path: '/chat/session-name',
        headers: authHeaders({
          'Content-Length': Buffer.byteLength(body).toString(),
        }),
      },
      body,
    );
    expect(r.status).toBe(400);
  });

  // ── Session order ──────────────────────────────────────────────────────────

  it('POST /chat/session-order valid array returns 200 and persists via setRouterState', async () => {
    const body = JSON.stringify({ order: ['abc123', 'def456'] });
    const r = await req(
      uploadPort,
      {
        method: 'POST',
        path: '/chat/session-order',
        headers: authHeaders({
          'Content-Length': Buffer.byteLength(body).toString(),
        }),
      },
      body,
    );
    expect(r.status).toBe(200);
    expect(setRouterState).toHaveBeenCalledWith(
      'web_session_order',
      JSON.stringify(['abc123', 'def456']),
    );
  });

  it('POST /chat/session-order invalid sid in array returns 400', async () => {
    const body = JSON.stringify({ order: ['abc123', 'bad sid!'] });
    const r = await req(
      uploadPort,
      {
        method: 'POST',
        path: '/chat/session-order',
        headers: authHeaders({
          'Content-Length': Buffer.byteLength(body).toString(),
        }),
      },
      body,
    );
    expect(r.status).toBe(400);
  });

  // ── Delete session ─────────────────────────────────────────────────────────

  it('POST /chat/delete-session returns 200 and calls deleteChat', async () => {
    const body = JSON.stringify({ sid: 'abc123' });
    const r = await req(
      uploadPort,
      {
        method: 'POST',
        path: '/chat/delete-session',
        headers: authHeaders({
          'Content-Length': Buffer.byteLength(body).toString(),
        }),
      },
      body,
    );
    expect(r.status).toBe(200);
    expect(deleteChat).toHaveBeenCalledWith('local@web-abc123');
  });

  // ── Delete message ─────────────────────────────────────────────────────────

  it('POST /chat/delete-message found returns 200', async () => {
    vi.mocked(dbDeleteMessage).mockReturnValue(true);
    const body = JSON.stringify({ sid: 'abc123', id: 'msg-001' });
    const r = await req(
      uploadPort,
      {
        method: 'POST',
        path: '/chat/delete-message',
        headers: authHeaders({
          'Content-Length': Buffer.byteLength(body).toString(),
        }),
      },
      body,
    );
    expect(r.status).toBe(200);
  });

  it('POST /chat/delete-message not found returns 404', async () => {
    vi.mocked(dbDeleteMessage).mockReturnValue(false);
    const body = JSON.stringify({ sid: 'abc123', id: 'msg-999' });
    const r = await req(
      uploadPort,
      {
        method: 'POST',
        path: '/chat/delete-message',
        headers: authHeaders({
          'Content-Length': Buffer.byteLength(body).toString(),
        }),
      },
      body,
    );
    expect(r.status).toBe(404);
  });

  // ── Clear history ──────────────────────────────────────────────────────────

  it('POST /chat/clear-history returns 200 and calls clearChatMessages', async () => {
    const body = JSON.stringify({ sid: 'abc123' });
    const r = await req(
      uploadPort,
      {
        method: 'POST',
        path: '/chat/clear-history',
        headers: authHeaders({
          'Content-Length': Buffer.byteLength(body).toString(),
        }),
      },
      body,
    );
    expect(r.status).toBe(200);
    expect(clearChatMessages).toHaveBeenCalledWith('local@web-abc123');
  });

  // ── Cancel ─────────────────────────────────────────────────────────────────

  it('POST /chat/cancel returns 200', async () => {
    const body = JSON.stringify({ sid: 'abc123' });
    const r = await req(
      uploadPort,
      {
        method: 'POST',
        path: '/chat/cancel',
        headers: authHeaders({
          'Content-Length': Buffer.byteLength(body).toString(),
        }),
      },
      body,
    );
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ ok: true });
  });

  // ── HEAD aliasing ──────────────────────────────────────────────────────────

  it('HEAD / returns 200 with CSP header and empty body', async () => {
    const r = await req(uploadPort, { method: 'HEAD', path: '/' });
    expect(r.status).toBe(200);
    expect(r.headers['content-security-policy']).toContain(
      "default-src 'self'",
    );
    expect(r.body).toBe('');
  });

  it('HEAD /manifest.json returns 200 with content-type application/json and empty body', async () => {
    const r = await req(uploadPort, { method: 'HEAD', path: '/manifest.json' });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/json');
    expect(r.body).toBe('');
  });
});

// ── Dashboard surface integration tests (Batch 2.2 Step 3) ───────────────────

describe('WebChannel HTTP — dashboard surface', () => {
  let dashChannel: WebChannel;
  let dashPort: number;
  let dashOpts: ChannelOpts;

  // Fresh server per test — avoids module-level dashCache cross-contamination
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(readFile).mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
    netMock.reset();
    execFileMock.stdout = 'container-a,running\n';
    execFileMock.shouldFail = false;
    // statfs: plain-number disk stats — nit 2 (D-S3.6, no BigInt)
    vi.mocked(statfs).mockResolvedValue({
      bsize: 4096,
      blocks: 10000,
      bavail: 5000,
      bfree: 5100,
      ffree: 1000,
      files: 2000,
      favail: 900,
      f_frsize: 4096,
      namemax: 255,
      type: 0,
    } as unknown as Awaited<ReturnType<typeof statfs>>);
    vi.mocked(readdir).mockResolvedValue(
      [] as unknown as Awaited<ReturnType<typeof readdir>>,
    );
    dashOpts = makeOpts();
    dashChannel = new WebChannel(dashOpts);
    await dashChannel.connect();
    dashPort = (
      (
        dashChannel as unknown as { server: http.Server }
      ).server.address() as AddressInfo
    ).port;
  });

  afterEach(async () => {
    await dashChannel.disconnect();
  });

  afterEach(() => {
    mockOauthReturns.counts = [];
  });

  function authH(extra?: Record<string, string>) {
    return { Authorization: 'Bearer test-secret-token', ...extra };
  }

  // ── Auth gate: unauthenticated × 3 ───────────────────────────────────────────

  it('GET /dash/health: unauthenticated → 401', async () => {
    const r = await req(dashPort, { method: 'GET', path: '/dash/health' });
    expect(r.status).toBe(401);
  });

  it('GET /dash/vault-stats: unauthenticated → 401', async () => {
    const r = await req(dashPort, { method: 'GET', path: '/dash/vault-stats' });
    expect(r.status).toBe(401);
  });

  it('GET /dash/cost: unauthenticated → 401', async () => {
    const r = await req(dashPort, { method: 'GET', path: '/dash/cost' });
    expect(r.status).toBe(401);
  });

  // ── /dash/health: authed + all healthy → ok ──────────────────────────────────

  it('GET /dash/health: authed + healthy → 200 + D-S3.3 shape + status ok', async () => {
    const r = await req(dashPort, {
      method: 'GET',
      path: '/dash/health',
      headers: authH(),
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(typeof body.uptime_sec).toBe('number');
    expect(Array.isArray(body.load_avg)).toBe(true);
    expect(body.mem).toBeTruthy();
    expect(body.proxy_reachable).toBe(true);
    expect(body.rate_limit).toBeNull();
    expect(body.last_anthropic_round_trip).toBeNull();
    expect(body.last_readwise_round_trip).toBeNull();
    expect('collected_at' in body).toBe(true);
  });

  // ── /dash/health: container-inspect timeout → degraded ───────────────────────

  it('GET /dash/health: container-inspect timeout → 200 + containers [] + degraded', async () => {
    execFileMock.shouldFail = true;
    const r = await req(dashPort, {
      method: 'GET',
      path: '/dash/health',
      headers: authH(),
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as Record<string, unknown>;
    expect(body.status).toBe('degraded');
    expect(body.containers).toEqual([]);
  });

  // ── /dash/health: proxy unreachable → degraded ───────────────────────────────

  it('GET /dash/health: proxy unreachable → 200 + proxy_reachable false + degraded', async () => {
    netMock.proxyUp = false;
    const r = await req(dashPort, {
      method: 'GET',
      path: '/dash/health',
      headers: authH(),
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as Record<string, unknown>;
    expect(body.proxy_reachable).toBe(false);
    expect(body.status).toBe('degraded');
  });

  // ── /dash/vault-stats: authed + vault populated ───────────────────────────────

  it('GET /dash/vault-stats: authed + vault populated → 200 + D-S3.4 shape', async () => {
    vi.mocked(readdir)
      .mockResolvedValueOnce([
        {
          name: 'general',
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => false,
        } as unknown,
      ] as unknown as Awaited<ReturnType<typeof readdir>>)
      .mockResolvedValueOnce([
        {
          name: 'note.md',
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
        } as unknown,
      ] as unknown as Awaited<ReturnType<typeof readdir>>);
    vi.mocked(stat).mockResolvedValue({
      mtimeMs: 1_700_000_000_000,
    } as unknown as Awaited<ReturnType<typeof stat>>);

    const r = await req(dashPort, {
      method: 'GET',
      path: '/dash/vault-stats',
      headers: authH(),
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as Record<string, unknown>;
    expect(typeof body.vault_root).toBe('string');
    expect(Array.isArray(body.by_folder)).toBe(true);
    expect(body.total_files).toBe(1);
    expect('collected_at' in body).toBe(true);
  });

  // ── /dash/vault-stats: missing vault root → graceful 200 ─────────────────────

  it('GET /dash/vault-stats: vault root missing → 200 + by_folder [] + error field', async () => {
    vi.mocked(readdir).mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
    const r = await req(dashPort, {
      method: 'GET',
      path: '/dash/vault-stats',
      headers: authH(),
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as Record<string, unknown>;
    expect(body.by_folder).toEqual([]);
    expect(typeof body.error).toBe('string');
  });

  // ── /dash/cost: authed → D-71 stub shape ─────────────────────────────────────

  it('GET /dash/cost: authed → 200 + D-71 skip-with-notice shape', async () => {
    const r = await req(dashPort, {
      method: 'GET',
      path: '/dash/cost',
      headers: authH(),
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as Record<string, unknown>;
    expect(body.available).toBe(false);
    expect(typeof body.reason).toBe('string');
    expect(Array.isArray(body.spec_refs)).toBe(true);
    expect('collected_at' in body).toBe(true);
    expect('spend' in body).toBe(false);
  });

  // ── /dash/cost: D-71 regression gate ─────────────────────────────────────────

  it('GET /dash/cost: available is unconditionally false (D-71 regression gate)', async () => {
    const r = await req(dashPort, {
      method: 'GET',
      path: '/dash/cost',
      headers: authH(),
    });
    const body = JSON.parse(r.body) as { available: unknown };
    expect(body.available).toBe(false);
  });

  // ── collectRateLimit: RL-1 through RL-5 (D-S4.15) ───────────────────────────

  it('GET /dash/health: RL-1 — readFile ENOENT → rate_limit null', async () => {
    vi.mocked(readFile).mockRejectedValue(
      Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }),
    );
    const r = await req(dashPort, {
      method: 'GET',
      path: '/dash/health',
      headers: authH(),
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as Record<string, unknown>;
    expect(body.rate_limit).toBeNull();
  });

  it('GET /dash/health: RL-2 — readFile returns invalid JSON → rate_limit null', async () => {
    vi.mocked(readFile).mockResolvedValue('not valid json' as never);
    const r = await req(dashPort, {
      method: 'GET',
      path: '/dash/health',
      headers: authH(),
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as Record<string, unknown>;
    expect(body.rate_limit).toBeNull();
  });

  it('GET /dash/health: RL-3 — state file missing state field → rate_limit null', async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        since: '2026-04-17T14:06:10Z',
        collected_at: '2026-04-17T14:06:10Z',
      }) as never,
    );
    const r = await req(dashPort, {
      method: 'GET',
      path: '/dash/health',
      headers: authH(),
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as Record<string, unknown>;
    expect(body.rate_limit).toBeNull();
  });

  it('GET /dash/health: RL-4 — valid ok state → rate_limit populated', async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        state: 'ok',
        since: '2026-04-17T14:06:10Z',
        last_hit_at: null,
        last_signature: null,
        last_notify_transition_since: null,
        collected_at: '2026-04-17T14:06:10Z',
      }) as never,
    );
    const r = await req(dashPort, {
      method: 'GET',
      path: '/dash/health',
      headers: authH(),
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as Record<string, unknown>;
    const rl = body.rate_limit as Record<string, unknown>;
    expect(rl).not.toBeNull();
    expect(rl['state']).toBe('ok');
    expect(rl['since']).toBe('2026-04-17T14:06:10Z');
    expect(rl['last_hit_at']).toBeNull();
  });

  it('GET /dash/health: RL-5 — valid rate-limited state → rate_limit populated', async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        state: 'rate-limited',
        since: '2026-04-17T14:06:10Z',
        last_hit_at: '2026-04-17T14:06:10Z',
        last_signature: 'rate_limit_error',
        last_notify_transition_since: '2026-04-17T14:06:10Z',
        collected_at: '2026-04-17T14:06:10Z',
      }) as never,
    );
    const r = await req(dashPort, {
      method: 'GET',
      path: '/dash/health',
      headers: authH(),
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as Record<string, unknown>;
    const rl = body.rate_limit as Record<string, unknown>;
    expect(rl).not.toBeNull();
    expect(rl['state']).toBe('rate-limited');
    expect(rl['since']).toBe('2026-04-17T14:06:10Z');
    expect(rl['last_hit_at']).toBe('2026-04-17T14:06:10Z');
  });

  // ── RL-6: fmtRl formatter render paths (D-S3.13 / D-S4.14) ─────────────────────

  it('fmtRl formatter: null → unknown, ok → OK, rate-limited with age + null fallback', () => {
    // Mirror of the SPA fmtRl(rl) function defined in web.ts template
    function fmtRl(
      rl: { state: string; last_hit_at: string | null } | null,
    ): string {
      if (rl == null) return 'unknown';
      if (rl.state === 'ok') return 'OK';
      if (!rl.last_hit_at) return 'rate-limited';
      const m = Math.floor(
        (Date.now() - new Date(rl.last_hit_at).getTime()) / 60000,
      );
      return 'rate-limited ' + (m < 1 ? '<1m' : m + 'm') + ' ago';
    }
    expect(fmtRl(null)).toBe('unknown');
    expect(fmtRl({ state: 'ok', last_hit_at: null })).toBe('OK');
    expect(fmtRl({ state: 'rate-limited', last_hit_at: null })).toBe(
      'rate-limited',
    );
    const threeMinAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    expect(fmtRl({ state: 'rate-limited', last_hit_at: threeMinAgo })).toBe(
      'rate-limited 3m ago',
    );
    const justNow = new Date(Date.now() - 30 * 1000).toISOString();
    expect(fmtRl({ state: 'rate-limited', last_hit_at: justNow })).toBe(
      'rate-limited <1m ago',
    );
  });

  it('fmtRl production mirror: SPA_HTML contains the expected fmtRl body verbatim', async () => {
    const source = await fs.promises.readFile(
      path.join(import.meta.dirname, 'web.ts'),
      'utf8',
    );
    expect(source).toContain(
      "function fmtRl(rl){if(rl==null)return'unknown';if(rl.state==='ok')return'OK';if(!rl.last_hit_at)return'rate-limited';var m=Math.floor((Date.now()-new Date(rl.last_hit_at).getTime())/60000);return'rate-limited '+(m<1?'<1m':m+'m')+' ago';}",
    );
  });

  // ── C13: /dash/health is strictly read-only ───────────────────────────────────

  it('GET /dash/health: C13 — zero mutating db calls + zero onMessage (bulletproof)', async () => {
    await req(dashPort, {
      method: 'GET',
      path: '/dash/health',
      headers: authH(),
    });
    // no FS writes
    expect(writeFile).not.toHaveBeenCalled();
    // no onMessage
    expect(dashOpts.onMessage).not.toHaveBeenCalled();
    // no mutating db exports (Step 6 adds storeMessage to web.ts; still zero calls on dash/health)
    expect(storeMessage).not.toHaveBeenCalled();
    expect(storeChatMetadata).not.toHaveBeenCalled();
    expect(updateChatName).not.toHaveBeenCalled();
    expect(setRouterState).not.toHaveBeenCalled();
    expect(deleteChat).not.toHaveBeenCalled();
    expect(dbDeleteMessage).not.toHaveBeenCalled();
    expect(clearChatMessages).not.toHaveBeenCalled();
  });

  // ── AU-1: /dash/api-usage unauthenticated → 401 ──────────────────────────────

  it('AU-1: GET /dash/api-usage unauthenticated → 401', async () => {
    const r = await req(dashPort, { method: 'GET', path: '/dash/api-usage' });
    expect(r.status).toBe(401);
  });

  // ── AU-2: all 4 month files ENOENT → 200 + zeroed payload, no warn logs ──────

  it('AU-2: GET /dash/api-usage all months ENOENT → 200 + 4 zeroed months + no warn', async () => {
    // readFile already mocked to ENOENT in beforeEach
    const r = await req(dashPort, {
      method: 'GET',
      path: '/dash/api-usage',
      headers: authH(),
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as {
      months: Array<{
        api_count: number;
        oauth_count: number;
        est_usd: number;
      }>;
      rate_per_dispatch: number;
    };
    expect(body.months).toHaveLength(4);
    body.months.forEach((m) => {
      expect(m.api_count).toBe(0);
      expect(m.oauth_count).toBe(0);
      expect(m.est_usd).toBe(0);
    });
    expect(typeof body.rate_per_dispatch).toBe('number');
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });

  // ── AU-3: current month file present {count:7}, prior 3 ENOENT ───────────────

  it('AU-3: GET /dash/api-usage current month count=7 + prior 3 ENOENT → months[0].api_count=7', async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce(
        JSON.stringify({ count: 7 }) as unknown as Awaited<
          ReturnType<typeof readFile>
        >,
      )
      .mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );
    const r = await req(dashPort, {
      method: 'GET',
      path: '/dash/api-usage',
      headers: authH(),
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as {
      months: Array<{ api_count: number; est_usd: number }>;
    };
    expect(body.months[0].api_count).toBe(7);
    expect(body.months[0].est_usd).toBe(Math.round(7 * 0.2 * 100) / 100);
    expect(body.months[1].api_count).toBe(0);
    expect(body.months[2].api_count).toBe(0);
    expect(body.months[3].api_count).toBe(0);
  });

  // ── AU-4: all 4 months populated, ordering descending from current ────────────

  it('AU-4: GET /dash/api-usage counts [7,12,0,3] → months array in that order', async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce(
        JSON.stringify({ count: 7 }) as unknown as Awaited<
          ReturnType<typeof readFile>
        >,
      )
      .mockResolvedValueOnce(
        JSON.stringify({ count: 12 }) as unknown as Awaited<
          ReturnType<typeof readFile>
        >,
      )
      .mockResolvedValueOnce(
        JSON.stringify({ count: 0 }) as unknown as Awaited<
          ReturnType<typeof readFile>
        >,
      )
      .mockResolvedValueOnce(
        JSON.stringify({ count: 3 }) as unknown as Awaited<
          ReturnType<typeof readFile>
        >,
      );
    const r = await req(dashPort, {
      method: 'GET',
      path: '/dash/api-usage',
      headers: authH(),
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as {
      months: Array<{ api_count: number }>;
    };
    expect(body.months[0].api_count).toBe(7);
    expect(body.months[1].api_count).toBe(12);
    expect(body.months[2].api_count).toBe(0);
    expect(body.months[3].api_count).toBe(3);
  });

  // ── AU-5: OAuth counts from db flow through to payload ───────────────────────

  it('AU-5: GET /dash/api-usage OAuth counts [45,60,80,100] → oauth_count flows through', async () => {
    mockOauthReturns.counts = [45, 60, 80, 100];
    const r = await req(dashPort, {
      method: 'GET',
      path: '/dash/api-usage',
      headers: authH(),
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as {
      months: Array<{ oauth_count: number }>;
    };
    expect(body.months[0].oauth_count).toBe(45);
    expect(body.months[1].oauth_count).toBe(60);
    expect(body.months[2].oauth_count).toBe(80);
    expect(body.months[3].oauth_count).toBe(100);
    expect(vi.mocked(getMessageCountForMonth)).toHaveBeenCalledTimes(4);
    // Pin the month-prefix contract: calls must use descending UTC YYYY-MM strings
    const expectedMonths = Array.from({ length: 4 }, (_, i) => {
      const d = new Date(
        Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - i, 1),
      );
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    });
    expect(
      vi.mocked(getMessageCountForMonth).mock.calls.map((c) => c[0]),
    ).toEqual(expectedMonths);
  });

  // ── AU-6: $ computation accuracy ─────────────────────────────────────────────

  it('AU-6: est_usd computation: rate=0.20 count=7 → 1.40; rate in payload', async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce(
        JSON.stringify({ count: 7 }) as unknown as Awaited<
          ReturnType<typeof readFile>
        >,
      )
      .mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );
    const r = await req(dashPort, {
      method: 'GET',
      path: '/dash/api-usage',
      headers: authH(),
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as {
      months: Array<{ est_usd: number }>;
      rate_per_dispatch: number;
    };
    // 7 × 0.20 = 1.40 exactly, no floating-point drift past 2 decimals
    expect(body.months[0].est_usd).toBe(1.4);
    expect(body.rate_per_dispatch).toBe(0.2);
  });
});

// ── D-93: sendMessage persistence + handleGetHistory cls shape ─────────────────

// Helper: open SSE for a sid, trigger sendMessage, return first agent_output payload.
// Client is registered before sendMessage fires because the response callback
// fires only after the server has already called flushHeaders() + clientsBySid.add().
function sendAndCaptureSse(
  channel: WebChannel,
  port: number,
  sid: string,
  text: string,
): Promise<{ text: string; id: string }> {
  return new Promise<{ text: string; id: string }>((resolve, reject) => {
    const r = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'GET',
        path: `/chat/events?sid=${sid}`,
        headers: { Authorization: 'Bearer test-secret-token' },
      },
      (res) => {
        let buf = '';
        res.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          const m = buf.match(/data: ({[^\n]+})/);
          if (m) {
            try {
              resolve(JSON.parse(m[1]) as { text: string; id: string });
              res.destroy();
            } catch {}
          }
        });
        res.on('error', (e: NodeJS.ErrnoException) => {
          if (e.code !== 'ECONNRESET') reject(e);
        });
        void channel.sendMessage(`local@web-${sid}`, text).catch(reject);
      },
    );
    r.on('error', reject);
    r.end();
  });
}

describe('WebChannel HTTP — sendMessage + history (D-93)', () => {
  let d93Channel: WebChannel;
  let d93Port: number;

  beforeAll(async () => {
    d93Channel = new WebChannel(makeOpts());
    await d93Channel.connect();
    d93Port = (
      (
        d93Channel as unknown as { server: http.Server }
      ).server.address() as AddressInfo
    ).port;
  });
  afterAll(async () => {
    await d93Channel.disconnect();
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sendMessage persists bot reply to DB before broadcast (C23)', async () => {
    let storeCalledBeforeSse = false;
    vi.mocked(storeMessage).mockImplementation(() => {
      storeCalledBeforeSse = true;
    });

    const sseData = await sendAndCaptureSse(
      d93Channel,
      d93Port,
      's6t1',
      'bot reply',
    );

    expect(storeCalledBeforeSse).toBe(true); // flag set inside storeMessage mock before SSE event arrived
    expect(vi.mocked(storeMessage)).toHaveBeenCalledWith(
      expect.objectContaining({
        is_bot_message: true,
        is_from_me: false,
        sender: 'Daystrom',
        sender_name: 'Daystrom',
        chat_jid: 'local@web-s6t1',
        content: 'bot reply',
      }),
    );
    expect(sseData.text).toBe('bot reply');
  });

  it('sendMessage broadcast payload includes id field matching web-bot pattern', async () => {
    const sseData = await sendAndCaptureSse(
      d93Channel,
      d93Port,
      's6t2',
      'hello',
    );
    expect(sseData.text).toBe('hello');
    expect(sseData.id).toMatch(/^web-bot-\d+-[a-z0-9]{7}$/);
  });

  it('sendMessage tolerates storeMessage throw — logger.warn fires, broadcast still proceeds', async () => {
    vi.mocked(storeMessage).mockImplementation(() => {
      throw new Error('db failure');
    });
    // sendMessage must not reject; catch block fires logger.warn then proceeds to broadcastToSession
    await expect(
      d93Channel.sendMessage('local@web-s6t3', 'resilience'),
    ).resolves.toBeUndefined();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ jid: 'local@web-s6t3' }),
      '[bridge] sendMessage: failed to persist bot message',
    );
  });

  it('handleGetHistory returns {text, cls, id} shape with OR-guard cls (C24)', async () => {
    vi.mocked(getConversation).mockReturnValue([
      {
        id: 'u1',
        content: 'user msg',
        is_from_me: false,
        is_bot_message: false,
        chat_jid: 'local@web-s6h',
        sender: 'user',
        sender_name: 'You',
        timestamp: '2026-01-01T00:00:01.000Z',
      } as ReturnType<typeof getConversation>[number],
      {
        id: 'b1',
        content: 'bot msg',
        is_from_me: false,
        is_bot_message: true,
        chat_jid: 'local@web-s6h',
        sender: 'Daystrom',
        sender_name: 'Daystrom',
        timestamp: '2026-01-01T00:00:02.000Z',
      } as ReturnType<typeof getConversation>[number],
      {
        id: 'l1',
        content: 'legacy user',
        is_from_me: true,
        is_bot_message: false,
        chat_jid: 'local@web-s6h',
        sender: 'user',
        sender_name: 'You',
        timestamp: '2026-01-01T00:00:03.000Z',
      } as ReturnType<typeof getConversation>[number],
    ]);
    const res = await req(d93Port, {
      method: 'GET',
      path: '/chat/history?sid=s6h',
      headers: { Authorization: 'Bearer test-secret-token' },
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as Array<{
      text: string;
      cls: string;
      id: string;
    }>;
    expect(body).toHaveLength(3);
    expect(body[0]).toEqual({ text: 'user msg', cls: 'user', id: 'u1' });
    expect(body[1]).toEqual({ text: 'bot msg', cls: 'bot', id: 'b1' });
    expect(body[2]).toEqual({ text: 'legacy user', cls: 'bot', id: 'l1' }); // OR-guard: is_from_me:true → 'bot'
  });
});

// ── claude-usage reverse-proxy (Batch 2.3 D-CU2) ─────────────────────────────

describe('WebChannel HTTP — claude-usage proxy (/dash/usage)', () => {
  let proxyChannel: WebChannel;
  let proxyPort: number;
  let mockUpstream: http.Server;
  let mockUpstreamPort: number;

  beforeAll(async () => {
    // Spin up a real upstream server; proxy will connect to it for UP-2 and UP-3
    mockUpstream = http.createServer((upReq, upRes) => {
      upRes.writeHead(200, { 'content-type': 'text/html' });
      upRes.end(`<html>claude-usage path=${upReq.url}</html>`);
    });
    await new Promise<void>((resolve) =>
      mockUpstream.listen(0, '127.0.0.1', resolve),
    );
    mockUpstreamPort = (mockUpstream.address() as AddressInfo).port;
    mockConfig.CLAUDE_USAGE_PORT = mockUpstreamPort;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => mockUpstream.close(() => resolve()));
    mockConfig.CLAUDE_USAGE_PORT = 8080;
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    netMock.reset();
    execFileMock.stdout = 'container-a,running\n';
    execFileMock.shouldFail = false;
    vi.mocked(readFile).mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
    vi.mocked(statfs).mockResolvedValue({
      bsize: 4096,
      blocks: 10000,
      bavail: 5000,
      bfree: 5100,
      ffree: 1000,
      files: 2000,
      favail: 900,
      f_frsize: 4096,
      namemax: 255,
      type: 0,
    } as unknown as Awaited<ReturnType<typeof statfs>>);
    vi.mocked(readdir).mockResolvedValue(
      [] as unknown as Awaited<ReturnType<typeof readdir>>,
    );
    proxyChannel = new WebChannel(makeOpts());
    await proxyChannel.connect();
    proxyPort = (
      (
        proxyChannel as unknown as { server: http.Server }
      ).server.address() as AddressInfo
    ).port;
  });

  afterEach(async () => {
    await proxyChannel.disconnect();
  });

  // ── UP-1: unauthenticated → 401 ──────────────────────────────────────────────

  it('UP-1: GET /dash/usage unauthenticated → 401', async () => {
    const r = await req(proxyPort, { method: 'GET', path: '/dash/usage' });
    expect(r.status).toBe(401);
  });

  // ── UP-2: authenticated → 200 + proxied content + SAMEORIGIN header ──────────

  it('UP-2: GET /dash/usage authed → 200 + proxied content + x-frame-options: SAMEORIGIN', async () => {
    const r = await req(proxyPort, {
      method: 'GET',
      path: '/dash/usage',
      headers: { Authorization: 'Bearer test-secret-token' },
    });
    expect(r.status).toBe(200);
    expect(r.body).toContain('claude-usage');
    expect(r.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  // ── UP-3: sub-path proxy pass-through + path rewrite ─────────────────────────

  it('UP-3: GET /dash/usage/sub/path authed → 200 + path rewritten to /sub/path upstream', async () => {
    const r = await req(proxyPort, {
      method: 'GET',
      path: '/dash/usage/sub/path',
      headers: { Authorization: 'Bearer test-secret-token' },
    });
    expect(r.status).toBe(200);
    expect(r.body).toContain('path=/sub/path');
  });

  // ── UP-4: upstream down → 502 ─────────────────────────────────────────────────

  it('UP-4: GET /dash/usage → 502 when claude-usage server is down', async () => {
    const savedPort = mockConfig.CLAUDE_USAGE_PORT;
    mockConfig.CLAUDE_USAGE_PORT = 19997; // deliberately non-listening port
    try {
      const r = await req(proxyPort, {
        method: 'GET',
        path: '/dash/usage',
        headers: { Authorization: 'Bearer test-secret-token' },
      });
      expect(r.status).toBe(502);
    } finally {
      mockConfig.CLAUDE_USAGE_PORT = savedPort;
    }
  });
});

// ── Batch 2.5 — Open WebUI proxy (/dash/private) ──────────────────────────────

describe('WebChannel HTTP — Open WebUI proxy (/dash/private)', () => {
  let proxyChannel: WebChannel;
  let proxyPort: number;
  let mockUpstream: http.Server;
  let mockUpstreamPort: number;

  beforeAll(async () => {
    mockUpstream = http.createServer((upReq, upRes) => {
      upRes.writeHead(200, { 'content-type': 'text/html' });
      upRes.end(`<html>owui method=${upReq.method} path=${upReq.url}</html>`);
    });
    await new Promise<void>((resolve) =>
      mockUpstream.listen(0, '127.0.0.1', resolve),
    );
    mockUpstreamPort = (mockUpstream.address() as AddressInfo).port;
    mockConfig.OWUI_PORT = mockUpstreamPort;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => mockUpstream.close(() => resolve()));
    mockConfig.OWUI_PORT = 8081;
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    netMock.reset();
    execFileMock.stdout = 'container-a,running\n';
    execFileMock.shouldFail = false;
    vi.mocked(readFile).mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
    vi.mocked(statfs).mockResolvedValue({
      bsize: 4096,
      blocks: 10000,
      bavail: 5000,
      bfree: 5100,
      ffree: 1000,
      files: 2000,
      favail: 900,
      f_frsize: 4096,
      namemax: 255,
      type: 0,
    } as unknown as Awaited<ReturnType<typeof statfs>>);
    vi.mocked(readdir).mockResolvedValue(
      [] as unknown as Awaited<ReturnType<typeof readdir>>,
    );
    proxyChannel = new WebChannel(makeOpts());
    await proxyChannel.connect();
    proxyPort = (
      (
        proxyChannel as unknown as { server: http.Server }
      ).server.address() as AddressInfo
    ).port;
  });

  afterEach(async () => {
    await proxyChannel.disconnect();
  });

  // PV-1: unauthenticated proxied path → 401 (covers brief §C.2 case 1)
  it('PV-1: GET /dash/private unauthenticated → 401', async () => {
    const r = await req(proxyPort, { method: 'GET', path: '/dash/private' });
    expect(r.status).toBe(401);
  });

  // PV-2: wrapper page authed → 200 + red banner + iframe + CSP frame-src 'self'
  // (covers brief §C.2 case 5 — CSP includes OWUI's required directives)
  it('PV-2: GET /dash/private authed → 200 + banner + iframe + CSP frame-src self', async () => {
    const r = await req(proxyPort, {
      method: 'GET',
      path: '/dash/private',
      headers: { Authorization: 'Bearer test-secret-token' },
    });
    expect(r.status).toBe(200);
    expect(r.body).toContain('PRIVATE');
    expect(r.body).toContain('Local-Only');
    expect(r.body).toContain('src="/dash/private/"');
    expect(r.body).toContain(
      'sandbox="allow-scripts allow-forms allow-same-origin"',
    );
    expect(r.headers['content-security-policy']).toContain("frame-src 'self'");
  });

  // PV-3: sub-path proxy + path rewrite + query string preserved
  // (covers brief §C.2 cases 2 + 3 — forwards to OWUI loopback, path stripped, query preserved)
  it('PV-3: GET /dash/private/api/foo?q=1 authed → path /api/foo?q=1 upstream', async () => {
    const r = await req(proxyPort, {
      method: 'GET',
      path: '/dash/private/api/foo?q=1',
      headers: { Authorization: 'Bearer test-secret-token' },
    });
    expect(r.status).toBe(200);
    expect(r.body).toContain('path=/api/foo?q=1');
  });

  // PV-4: POST passes through with method preserved (OWUI uses POST for chat ops)
  it('PV-4: POST /dash/private/api/chat authed → 200 + method=POST upstream', async () => {
    const r = await req(
      proxyPort,
      {
        method: 'POST',
        path: '/dash/private/api/chat',
        headers: {
          Authorization: 'Bearer test-secret-token',
          'Content-Type': 'application/json',
        },
      },
      JSON.stringify({ msg: 'hi' }),
    );
    expect(r.status).toBe(200);
    expect(r.body).toContain('method=POST');
  });

  // PV-5: WebSocket upgrade outside /dash/private/* rejected (covers brief §C.2 case 4)
  it('PV-5: WebSocket upgrade to /chat/events rejected (allowlist guard)', async () => {
    await new Promise<void>((resolve) => {
      const r = http.request({
        hostname: '127.0.0.1',
        port: proxyPort,
        path: '/chat/events',
        method: 'GET',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
          Cookie: 'nanoclaw_token=test-secret-token',
        },
      });
      let upgraded = false;
      r.on('upgrade', () => {
        upgraded = true;
      });
      r.on('close', () => {
        expect(upgraded).toBe(false);
        resolve();
      });
      r.on('error', () => {
        expect(upgraded).toBe(false);
        resolve();
      });
      r.end();
    });
  });

  // PV-6: WS upgrade to /dash/private/* WITHOUT cookie → 401 + socket destroyed.
  // Vera iter-1 Should Fix #3: regression-pin the auth gate on the WS path. Mirrors PV-5
  // structure but flips the path to /dash/private/foo and drops the cookie. Asserts that the
  // upgrade is NOT honored (no 'upgrade' event) AND that the server wrote a 401 status line
  // before destroying the socket.
  it('PV-6: WS upgrade to /dash/private/foo unauth → 401 + socket destroyed', async () => {
    await new Promise<void>((resolve) => {
      const r = http.request({
        hostname: '127.0.0.1',
        port: proxyPort,
        path: '/dash/private/foo',
        method: 'GET',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
          // deliberately NO Cookie + NO Authorization headers
        },
      });
      let upgraded = false;
      let sawUnauthorized = false;
      r.on('upgrade', () => {
        upgraded = true;
      });
      // socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n') is emitted as a synthetic response;
      // node's http client may surface it as a 'response' (statusCode 401) before the socket
      // is destroyed. Capture either signal as proof of the auth-gate firing.
      r.on('response', (resp) => {
        if (resp.statusCode === 401) sawUnauthorized = true;
      });
      r.on('close', () => {
        expect(upgraded).toBe(false);
        expect(sawUnauthorized).toBe(true);
        resolve();
      });
      r.on('error', () => {
        // close handler is the canonical assertion site; error path covers socket-destroyed-pre-response
        expect(upgraded).toBe(false);
        resolve();
      });
      r.end();
    });
  });

  // CSP-snapshot regression test (Vera iter-1 Should Fix #2): pin every directive so a
  // future maintainer can't silently re-introduce the ws:/wss: wildcard. One assertion per
  // directive — exact-match string compare on the wrapper page CSP header.
  it('CSP snapshot — every directive pinned (no ws:/wss: wildcard)', async () => {
    const r = await req(proxyPort, {
      method: 'GET',
      path: '/dash/private',
      headers: { Authorization: 'Bearer test-secret-token' },
    });
    expect(r.status).toBe(200);
    const csp = r.headers['content-security-policy'] ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain('ws:');
    expect(csp).not.toContain('wss:');
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain(
      "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    );
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("frame-src 'self'");
  });
});

// ── TYPING_TIMEOUT_MS constant (D-V52.5) ──────────────────────────────────────

// Regression guard: Opus /research + /brainstorm can run 60-180s; the safety
// timeout must not fire mid-agent and clear the Bridge thinking indicator.
// 300_000 (5 min) matches the slow-skill-ack hard cap from Impl-32.
it('TYPING_TIMEOUT_MS is 300_000ms (5 min)', () => {
  expect(TYPING_TIMEOUT_MS).toBe(300_000);
});

// ── /widget/feedback — Plane C (Impl-73 Step 3) ───────────────────────────────

const WIDGET_ORIGIN = 'https://widgets.crystaldatalabs.com';

describe('WebChannel HTTP — /widget/feedback (Plane C)', () => {
  let fbChannel: WebChannel;
  let fbOpts: ChannelOpts;
  let fbPort: number;

  beforeAll(async () => {
    fbOpts = {
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: vi.fn(() => ({})),
    };
    fbChannel = new WebChannel(fbOpts);
    await fbChannel.connect();
    fbPort = (
      (
        fbChannel as unknown as { server: http.Server }
      ).server.address() as AddressInfo
    ).port;
  });

  afterAll(async () => {
    await fbChannel.disconnect();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    mockConfig.WIDGET_FEEDBACK_TOKEN = 'test-widget-token';
  });

  function fbHeaders(extra?: Record<string, string>) {
    return {
      Authorization: 'Bearer test-widget-token',
      'Content-Type': 'application/json',
      Origin: WIDGET_ORIGIN,
      ...extra,
    };
  }

  function fbBody(o: { type?: string; widgetId?: string; state?: unknown }) {
    return JSON.stringify({
      type: o.type ?? 'conversational',
      widgetId: o.widgetId ?? 'test-widget-1',
      state: 'state' in o ? o.state : { count: 3 },
    });
  }

  function post(body: string, headers?: Record<string, string>) {
    return req(
      fbPort,
      {
        method: 'POST',
        path: '/widget/feedback',
        headers: {
          ...fbHeaders(headers),
          'Content-Length': Buffer.byteLength(body).toString(),
        },
      },
      body,
    );
  }

  // ── CORS ────────────────────────────────────────────────────────────────────

  it('preflight OPTIONS returns 204 with ACAO + methods/headers', async () => {
    const res = await req(fbPort, {
      method: 'OPTIONS',
      path: '/widget/feedback',
      headers: { Origin: WIDGET_ORIGIN },
    });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(WIDGET_ORIGIN);
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-headers']).toContain(
      'Authorization',
    );
  });

  it('rejected origin gets NO ACAO header (but still processes)', async () => {
    const body = fbBody({});
    const res = await req(
      fbPort,
      {
        method: 'POST',
        path: '/widget/feedback',
        headers: {
          Authorization: 'Bearer test-widget-token',
          'Content-Type': 'application/json',
          Origin: 'https://evil.example.com',
          'Content-Length': Buffer.byteLength(body).toString(),
        },
      },
      body,
    );
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  // ── Auth ──────────────────────────────────────────────────────────────────

  it('empty WIDGET_FEEDBACK_TOKEN → 503 (fail closed), still carries ACAO', async () => {
    mockConfig.WIDGET_FEEDBACK_TOKEN = '';
    const res = await post(fbBody({}));
    expect(res.status).toBe(503);
    // Hardening ask A — CORS-first, so even the disabled-route response is readable.
    expect(res.headers['access-control-allow-origin']).toBe(WIDGET_ORIGIN);
  });

  it('bad bearer token → 401, still carries ACAO', async () => {
    const res = await post(fbBody({}), { Authorization: 'Bearer wrong-token' });
    expect(res.status).toBe(401);
    expect(res.headers['access-control-allow-origin']).toBe(WIDGET_ORIGIN);
    expect(fbOpts.onMessage).not.toHaveBeenCalled();
  });

  it('returns 429 after 5 failed token attempts from same IP', async () => {
    const rl = new WebChannel(makeOpts());
    await rl.connect();
    const rlPort = (
      (rl as unknown as { server: http.Server }).server.address() as AddressInfo
    ).port;
    const body = fbBody({});
    try {
      for (let i = 0; i < 5; i++) {
        const r = await req(
          rlPort,
          {
            method: 'POST',
            path: '/widget/feedback',
            headers: {
              Authorization: 'Bearer wrong-token',
              'Content-Type': 'application/json',
              Origin: WIDGET_ORIGIN,
              'Content-Length': Buffer.byteLength(body).toString(),
            },
          },
          body,
        );
        expect(r.status).toBe(401);
      }
      const r6 = await req(
        rlPort,
        {
          method: 'POST',
          path: '/widget/feedback',
          headers: {
            Authorization: 'Bearer wrong-token',
            'Content-Type': 'application/json',
            Origin: WIDGET_ORIGIN,
            'Content-Length': Buffer.byteLength(body).toString(),
          },
        },
        body,
      );
      expect(r6.status).toBe(429);
      expect(r6.headers['retry-after']).toBe('60');
    } finally {
      await rl.disconnect();
    }
  });

  // ── Type discriminator + synthesis ────────────────────────────────────────

  it('conversational → 200, synthesizes onMessage to tg JID with the envelope; onChatMetadata NOT called', async () => {
    const res = await post(
      fbBody({ widgetId: 'hvac-quotes-1', state: { pick: 'B' } }),
    );
    expect(res.status).toBe(200);
    expect(fbOpts.onMessage).toHaveBeenCalledTimes(1);
    const [jid, msg] = vi.mocked(fbOpts.onMessage).mock.calls[0] as [
      string,
      { content: string; chat_jid: string; is_from_me?: boolean },
    ];
    // F divergence — onMessage-only to the main-group Telegram JID.
    expect(jid).toBe('tg:8669367924');
    expect(msg.chat_jid).toBe('tg:8669367924');
    expect(msg.is_from_me).toBe(false);
    expect(msg.content).toContain('===WIDGET-FEEDBACK-ENVELOPE-v1===');
    expect(msg.content).toContain('hvac-quotes-1');
    // onChatMetadata must NOT be called (would re-stamp the main group's channel as 'web').
    expect(fbOpts.onChatMetadata).not.toHaveBeenCalled();
    // CORS present on the success response.
    expect(res.headers['access-control-allow-origin']).toBe(WIDGET_ORIGIN);
  });

  it('write-back → 202 deferred, no synthesis', async () => {
    const res = await post(fbBody({ type: 'write-back' }));
    expect(res.status).toBe(202);
    const parsed = JSON.parse(res.body) as { deferred: boolean; type: string };
    expect(parsed.deferred).toBe(true);
    expect(parsed.type).toBe('write-back');
    expect(fbOpts.onMessage).not.toHaveBeenCalled();
  });

  it('refresh → 202 deferred, no synthesis', async () => {
    const res = await post(fbBody({ type: 'refresh' }));
    expect(res.status).toBe(202);
    const parsed = JSON.parse(res.body) as { deferred: boolean; type: string };
    expect(parsed.deferred).toBe(true);
    expect(parsed.type).toBe('refresh');
    expect(fbOpts.onMessage).not.toHaveBeenCalled();
  });

  it('unknown type → 400', async () => {
    const res = await post(fbBody({ type: 'frobnicate' }));
    expect(res.status).toBe(400);
    expect(fbOpts.onMessage).not.toHaveBeenCalled();
  });

  // ── Body validation ─────────────────────────────────────────────────────────

  it('bad JSON → 400', async () => {
    const res = await post('{not valid json');
    expect(res.status).toBe(400);
    expect(fbOpts.onMessage).not.toHaveBeenCalled();
  });

  it('body over 1 MB → 413', async () => {
    const body = JSON.stringify({
      type: 'conversational',
      widgetId: 'big-1',
      state: { blob: 'x'.repeat(1_100_000) },
    });
    const res = await post(body);
    expect(res.status).toBe(413);
    expect(fbOpts.onMessage).not.toHaveBeenCalled();
  });

  // ── Field validation (Vera Step-3 Should-Fix #2) ──────────────────────────────

  it('invalid widgetId charset → 400, before synthesis', async () => {
    // widgetId is interpolated into the synthesized content — reject non-slug chars.
    const res = await post(fbBody({ widgetId: 'bad id!' }));
    expect(res.status).toBe(400);
    expect(fbOpts.onMessage).not.toHaveBeenCalled();
  });

  it('missing state → 400', async () => {
    // fbBody omits the state key entirely when passed `state: undefined`.
    const res = await post(fbBody({ state: undefined }));
    expect(res.status).toBe(400);
    expect(fbOpts.onMessage).not.toHaveBeenCalled();
  });
});

// ── GET /widget/data/<id> — auth ladder ───────────────────────────────────────
//
// The shared gate in front of every /widget/data GET: CORS-absolute-first
// preflight, fail-closed token, constant-time bearer, id charset validation,
// and the 404 for any id that is not board-v2. Deliberately board-agnostic —
// none of these cases reach a snapshot build, so no fs wiring is needed. The
// v2 payload/routing cases live in the v2 suite below.

describe('WebChannel HTTP — GET /widget/data (auth ladder)', () => {
  let dataChannel: WebChannel;
  let dataOpts: ChannelOpts;
  let dataPort: number;

  beforeAll(async () => {
    dataOpts = makeOpts();
    dataChannel = new WebChannel(dataOpts);
    await dataChannel.connect();
    dataPort = (
      (
        dataChannel as unknown as { server: http.Server }
      ).server.address() as AddressInfo
    ).port;
  });

  afterAll(async () => {
    await dataChannel.disconnect();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.WIDGET_FEEDBACK_TOKEN = 'test-widget-token';
  });

  function get(pathSuffix: string, headers?: Record<string, string>) {
    return req(dataPort, {
      method: 'GET',
      path: `/widget/data/${pathSuffix}`,
      headers: {
        Authorization: 'Bearer test-widget-token',
        Origin: WIDGET_ORIGIN,
        ...headers,
      },
    });
  }

  it('preflight OPTIONS → 204 with ACAO + GET in allow-methods', async () => {
    const res = await req(dataPort, {
      method: 'OPTIONS',
      path: `/widget/data/${V2_ID}`,
      headers: { Origin: WIDGET_ORIGIN },
    });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(WIDGET_ORIGIN);
    expect(res.headers['access-control-allow-methods']).toContain('GET');
    expect(res.headers['access-control-allow-headers']).toContain(
      'Authorization',
    );
  });

  it('no/bad bearer token → 401, still carries ACAO', async () => {
    const res = await get(V2_ID, { Authorization: 'Bearer wrong-token' });
    expect(res.status).toBe(401);
    expect(res.headers['access-control-allow-origin']).toBe(WIDGET_ORIGIN);
  });

  it('empty WIDGET_FEEDBACK_TOKEN → 503 (fail closed)', async () => {
    mockConfig.WIDGET_FEEDBACK_TOKEN = '';
    const res = await get(V2_ID);
    expect(res.status).toBe(503);
    expect(res.headers['access-control-allow-origin']).toBe(WIDGET_ORIGIN);
  });

  it('invalid id charset → 400', async () => {
    const res = await get('has~tilde');
    expect(res.status).toBe(400);
  });

  it('unknown (but valid-charset) id → 404 after auth', async () => {
    const res = await get('some-other-widget');
    expect(res.status).toBe(404);
  });

  it('the retired v1 board id → 404 (board-v2 is the only served board)', async () => {
    const res = await get('projects-board');
    expect(res.status).toBe(404);
    expect(dataOpts.onMessage).not.toHaveBeenCalled();
  });
});

// ── Projects Board v2 — data / state / insights-regen (SPEC §4) ───────────────
//
// Same division of labour as the auth-ladder suite above: the auth/CORS/
// validation/routing layer is covered here (node:fs/promises mocked), while the
// deep parser/snapshot/overlay semantics live in src/widget/board-v2/*.test.ts
// against real temp dirs.

const V2_ID = 'projects-board-v2';
const V2_TASK_ID = 'daystrom-board-synth-v2';

// Shaped after the live daystrom/next.md (capture 2026-08-18): an R1 card with
// a child and an R2 card that splits on its first colon.
const V2_NEXT_MD = [
  '---',
  'type: project',
  'project: daystrom',
  'status: active',
  '---',
  '1. Path to v3',
  '\t- Come back to build this Claude native when the time is right',
  '2. Server hardening + backup steps: Identified Fri 7/3/26 - just run it w him',
  '',
].join('\n');

// Files the fake state dir currently holds; anything absent throws ENOENT, the
// shape of a freshly deployed host. `v2TmpWrites` holds bodies parked at a tmp
// path by writeFile until rename publishes them.
const v2StateFiles = new Map<string, string>();
const v2TmpWrites = new Map<string, string>();

function enoent(): NodeJS.ErrnoException {
  const err = new Error('ENOENT') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

function wireV2Fs(): void {
  vi.mocked(readdir).mockResolvedValue([
    { name: 'daystrom', isDirectory: () => true },
  ] as never);
  vi.mocked(readFile).mockImplementation((async (p: unknown) => {
    const file = String(p);
    if (file.endsWith('next.md')) return V2_NEXT_MD;
    for (const [name, body] of v2StateFiles) {
      if (file.endsWith(name)) return body;
    }
    throw enoent();
  }) as never);
}

interface V2DataBody {
  snapshot: {
    version: number;
    widgetId: string;
    projects: { folder: string; cards: { key: string; titleText: string }[] }[];
    emptyProjects: string[];
    insights: { asOf: string | null; running: boolean; stale: boolean };
    parseFlags: string[];
  };
  overlay: {
    placements: Record<string, string>;
    updatedAt: string;
    ui: Record<string, unknown>;
  } | null;
}

describe('WebChannel HTTP — Projects Board v2 routes', () => {
  let v2Channel: WebChannel;
  let v2Opts: ChannelOpts;
  let v2Port: number;

  beforeAll(async () => {
    v2Opts = makeOpts();
    v2Channel = new WebChannel(v2Opts);
    await v2Channel.connect();
    v2Port = (
      (
        v2Channel as unknown as { server: http.Server }
      ).server.address() as AddressInfo
    ).port;
  });

  afterAll(async () => {
    await v2Channel.disconnect();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.WIDGET_FEEDBACK_TOKEN = 'test-widget-token';
    v2StateFiles.clear();
    wireV2Fs();
    vi.mocked(mkdir).mockResolvedValue(undefined as never);
    vi.mocked(stat).mockRejectedValue(enoent() as never);
    vi.mocked(getTaskById).mockReturnValue(undefined);
    vi.mocked(updateTask).mockImplementation(() => {});
    // tmp+rename is modelled faithfully (write parks the body under the tmp
    // path, rename publishes it under the target's basename) so read-back paths
    // — notably the ownership-guarded regen rollback — see what was written.
    v2TmpWrites.clear();
    vi.mocked(writeFile).mockImplementation((async (
      p: unknown,
      data: unknown,
    ) => {
      v2TmpWrites.set(String(p), String(data));
    }) as never);
    vi.mocked(rename).mockImplementation((async (
      from: unknown,
      to: unknown,
    ) => {
      const body = v2TmpWrites.get(String(from));
      v2TmpWrites.delete(String(from));
      if (body !== undefined) v2StateFiles.set(path.basename(String(to)), body);
    }) as never);
    vi.mocked(rm).mockImplementation((async (p: unknown) => {
      v2TmpWrites.delete(String(p));
      v2StateFiles.delete(path.basename(String(p)));
    }) as never);
  });

  function call(
    method: string,
    urlPath: string,
    body?: string,
    headers?: Record<string, string>,
  ) {
    return req(
      v2Port,
      {
        method,
        path: urlPath,
        headers: {
          Authorization: 'Bearer test-widget-token',
          Origin: WIDGET_ORIGIN,
          ...headers,
        },
      },
      body,
    );
  }

  // ── GET /widget/data/projects-board-v2 ─────────────────────────────────────

  it('GET → 200 { snapshot, overlay } with the v2 schema header', async () => {
    const res = await call('GET', `/widget/data/${V2_ID}`);
    expect(res.status).toBe(200);
    const { snapshot, overlay } = JSON.parse(res.body) as V2DataBody;
    expect(snapshot.version).toBe(1);
    expect(snapshot.widgetId).toBe(V2_ID);
    expect(snapshot.projects[0].folder).toBe('daystrom');
    expect(snapshot.projects[0].cards.map((c) => c.titleText)).toEqual([
      'Path to v3',
      'Server hardening + backup steps',
    ]);
    expect(overlay).toBeNull();
    expect(v2Opts.onMessage).not.toHaveBeenCalled();
  });

  it('GET → the stored overlay rides along in the same round-trip', async () => {
    v2StateFiles.set(
      'overlay.json',
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: '2026-08-18T14:22:31.000Z',
        placements: { 'daystrom␟Path to v3': 'active' },
      }),
    );
    const { overlay } = JSON.parse(
      (await call('GET', `/widget/data/${V2_ID}`)).body,
    ) as V2DataBody;
    expect(overlay?.placements).toEqual({ 'daystrom␟Path to v3': 'active' });
  });

  it('GET → a corrupt overlay degrades to null + a parse flag, not a 500', async () => {
    v2StateFiles.set('overlay.json', '{{{ not json');
    const res = await call('GET', `/widget/data/${V2_ID}`);
    expect(res.status).toBe(200);
    const { snapshot, overlay } = JSON.parse(res.body) as V2DataBody;
    expect(overlay).toBeNull();
    expect(snapshot.parseFlags.some((f) => f.includes('overlay.json'))).toBe(
      true,
    );
  });

  it('GET → insights running state is derived from the state dir', async () => {
    v2StateFiles.set(
      'regen-request.json',
      JSON.stringify({ mode: 'full', requestedAt: new Date().toISOString() }),
    );
    const { snapshot } = JSON.parse(
      (await call('GET', `/widget/data/${V2_ID}`)).body,
    ) as V2DataBody;
    expect(snapshot.insights).toMatchObject({ running: true, stale: false });
  });

  it('GET → a vault-read failure is a generic 500 (no raw error leak)', async () => {
    vi.mocked(readdir).mockRejectedValue(new Error('boom /home/ubuntu/secret'));
    const res = await call('GET', `/widget/data/${V2_ID}`);
    expect(res.status).toBe(500);
    expect(res.body).not.toContain('secret');
  });

  // ── POST /widget/state/projects-board-v2 ───────────────────────────────────

  const OVERLAY = {
    schemaVersion: 1,
    updatedAt: '1999-01-01T00:00:00.000Z',
    placements: { 'daystrom␟Path to v3': 'active' },
    order: { active: ['daystrom␟Path to v3'], 'col:daystrom': [] },
    expanded: { 'daystrom␟Path to v3': true },
    placedHash: { 'daystrom␟Path to v3': 'a1b2c3d4e5f6' },
    ui: { theme: 'dark', collapsedColumns: ['podvast'] },
  };

  it('state: preflight OPTIONS → 204 with ACAO + POST in allow-methods', async () => {
    const res = await req(v2Port, {
      method: 'OPTIONS',
      path: `/widget/state/${V2_ID}`,
      headers: { Origin: WIDGET_ORIGIN },
    });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(WIDGET_ORIGIN);
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });

  it('state: bad bearer → 401, still carries ACAO', async () => {
    const res = await call('POST', `/widget/state/${V2_ID}`, '{}', {
      Authorization: 'Bearer wrong-token',
    });
    expect(res.status).toBe(401);
    expect(res.headers['access-control-allow-origin']).toBe(WIDGET_ORIGIN);
  });

  it('state: empty WIDGET_FEEDBACK_TOKEN → 503 (fail closed)', async () => {
    mockConfig.WIDGET_FEEDBACK_TOKEN = '';
    const res = await call('POST', `/widget/state/${V2_ID}`, '{}');
    expect(res.status).toBe(503);
    expect(res.headers['access-control-allow-origin']).toBe(WIDGET_ORIGIN);
  });

  it('state: invalid id charset → 400; unknown id → 404', async () => {
    expect((await call('POST', '/widget/state/has~tilde', '{}')).status).toBe(
      400,
    );
    expect(
      (await call('POST', '/widget/state/projects-board', '{}')).status,
    ).toBe(404);
  });

  it('state: a valid overlay is written atomically, host-stamped', async () => {
    const res = await call(
      'POST',
      `/widget/state/${V2_ID}`,
      JSON.stringify(OVERLAY),
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; updatedAt: string };
    expect(body.ok).toBe(true);
    // The client's updatedAt is ignored — the host is the ordering authority.
    expect(body.updatedAt).not.toBe(OVERLAY.updatedAt);
    expect(Number.isNaN(Date.parse(body.updatedAt))).toBe(false);

    // tmp + rename, both inside the v2 state dir.
    const [tmpPath, payload] = vi.mocked(writeFile).mock.calls[0];
    const [from, to] = vi.mocked(rename).mock.calls[0];
    expect(String(tmpPath)).toContain(path.join('board-cache', 'v2'));
    expect(String(tmpPath)).toContain('.overlay.json.tmp-');
    expect(String(from)).toBe(String(tmpPath));
    expect(String(to)).toBe(path.join(String(tmpPath), '..', 'overlay.json'));
    const written = JSON.parse(String(payload)) as { updatedAt: string };
    expect(written.updatedAt).toBe(body.updatedAt);
  });

  it('state: rejects unknown fields, a bad schemaVersion and a bad theme (400)', async () => {
    const bad = async (mutate: (o: Record<string, unknown>) => void) => {
      const body = JSON.parse(JSON.stringify(OVERLAY)) as Record<
        string,
        unknown
      >;
      mutate(body);
      return (
        await call('POST', `/widget/state/${V2_ID}`, JSON.stringify(body))
      ).status;
    };
    expect(await bad((o) => (o.sneaky = 1))).toBe(400);
    expect(await bad((o) => (o.schemaVersion = 2))).toBe(400);
    expect(
      await bad((o) => ((o.ui as Record<string, unknown>).theme = 'neon')),
    ).toBe(400);
    expect(vi.mocked(rename)).not.toHaveBeenCalled();
  });

  it('state: ui.fontScale saves and comes back on the next GET', async () => {
    const body = JSON.parse(JSON.stringify(OVERLAY)) as Record<string, unknown>;
    (body.ui as Record<string, unknown>).fontScale = 'l';
    expect(
      (await call('POST', `/widget/state/${V2_ID}`, JSON.stringify(body)))
        .status,
    ).toBe(200);

    const { overlay } = JSON.parse(
      (await call('GET', `/widget/data/${V2_ID}`)).body,
    ) as V2DataBody;
    expect(overlay?.ui).toEqual({
      theme: 'dark',
      collapsedColumns: ['podvast'],
      fontScale: 'l',
    });
  });

  it('state: a bogus ui.fontScale rejects the whole save (400)', async () => {
    const body = JSON.parse(JSON.stringify(OVERLAY)) as Record<string, unknown>;
    (body.ui as Record<string, unknown>).fontScale = 'xl';
    const res = await call(
      'POST',
      `/widget/state/${V2_ID}`,
      JSON.stringify(body),
    );
    expect(res.status).toBe(400);
    expect(res.body).toContain('s|m|l');
    expect(vi.mocked(rename)).not.toHaveBeenCalled();
  });

  it('state: malformed JSON → 400', async () => {
    expect(
      (await call('POST', `/widget/state/${V2_ID}`, '{ nope')).status,
    ).toBe(400);
  });

  it('state: a body over 64 KB is refused before parsing', async () => {
    const res = await call(
      'POST',
      `/widget/state/${V2_ID}`,
      JSON.stringify({ schemaVersion: 1, expanded: {} }) + ' '.repeat(70_000),
    );
    expect(res.status).toBe(413);
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
  });

  it('state: a write failure is a generic 500', async () => {
    vi.mocked(writeFile).mockRejectedValue(new Error('ENOSPC /home/ubuntu'));
    const res = await call(
      'POST',
      `/widget/state/${V2_ID}`,
      JSON.stringify(OVERLAY),
    );
    expect(res.status).toBe(500);
    expect(res.body).not.toContain('ubuntu');
  });

  // ── POST /widget/insights-regen/projects-board-v2 ──────────────────────────

  it('regen: bad bearer → 401; unknown id → 404', async () => {
    expect(
      (
        await call(
          'POST',
          `/widget/insights-regen/${V2_ID}`,
          '{"mode":"full"}',
          { Authorization: 'Bearer wrong-token' },
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await call(
          'POST',
          '/widget/insights-regen/projects-board',
          '{"mode":"full"}',
        )
      ).status,
    ).toBe(404);
  });

  it('regen: an unknown mode → 400, nothing written, nothing poked', async () => {
    const res = await call(
      'POST',
      `/widget/insights-regen/${V2_ID}`,
      '{"mode":"sideways"}',
    );
    expect(res.status).toBe(400);
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
    expect(vi.mocked(updateTask)).not.toHaveBeenCalled();
  });

  it('regen: a missing task row is LOUD — 503 + logger.error, no request file', async () => {
    const res = await call(
      'POST',
      `/widget/insights-regen/${V2_ID}`,
      '{"mode":"full"}',
    );
    expect(res.status).toBe(503);
    expect(vi.mocked(logger.error)).toHaveBeenCalled();
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
    expect(vi.mocked(updateTask)).not.toHaveBeenCalled();
  });

  it('regen: writes the mode file, then pokes next_run + status together', async () => {
    vi.mocked(getTaskById).mockReturnValue({ id: V2_TASK_ID } as never);
    const res = await call(
      'POST',
      `/widget/insights-regen/${V2_ID}`,
      '{"mode":"new-only"}',
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, started: true });

    const [tmpPath, payload] = vi.mocked(writeFile).mock.calls[0];
    expect(String(tmpPath)).toContain('.regen-request.json.tmp-');
    const request = JSON.parse(String(payload)) as {
      mode: string;
      requestedAt: string;
    };
    expect(request.mode).toBe('new-only');

    // Both fields, together: a `once` task is left next_run=NULL AND
    // status='completed' after each run, so either alone re-arms nothing.
    expect(vi.mocked(updateTask)).toHaveBeenCalledTimes(1);
    const [taskId, updates] = vi.mocked(updateTask).mock.calls[0];
    expect(taskId).toBe(V2_TASK_ID);
    expect(updates.status).toBe('active');
    expect(updates.next_run).toBe(request.requestedAt);
  });

  it('regen: an in-flight run short-circuits to alreadyRunning (no second poke)', async () => {
    vi.mocked(getTaskById).mockReturnValue({ id: V2_TASK_ID } as never);
    v2StateFiles.set(
      'regen-request.json',
      JSON.stringify({
        mode: 'full',
        requestedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    const res = await call(
      'POST',
      `/widget/insights-regen/${V2_ID}`,
      '{"mode":"full"}',
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, alreadyRunning: true });
    expect(vi.mocked(updateTask)).not.toHaveBeenCalled();
  });

  it('regen: a run older than the staleness window is re-pokeable', async () => {
    vi.mocked(getTaskById).mockReturnValue({ id: V2_TASK_ID } as never);
    v2StateFiles.set(
      'regen-request.json',
      JSON.stringify({
        mode: 'full',
        requestedAt: new Date(Date.now() - 45 * 60_000).toISOString(),
      }),
    );
    const res = await call(
      'POST',
      `/widget/insights-regen/${V2_ID}`,
      '{"mode":"full"}',
    );
    expect(JSON.parse(res.body)).toEqual({ ok: true, started: true });
    expect(vi.mocked(updateTask)).toHaveBeenCalledTimes(1);
  });

  // ── Vera follow-up round ───────────────────────────────────────────────────

  // SF3 — the request file must not outlive a failed poke, or the board reports
  // running:true for 30 minutes with nothing actually running.
  it('regen: a failed poke rolls the request file back and 500s', async () => {
    vi.mocked(getTaskById).mockReturnValue({ id: V2_TASK_ID } as never);
    vi.mocked(updateTask).mockImplementation(() => {
      throw new Error('SQLITE_BUSY /home/ubuntu/nanoclaw.db');
    });
    const res = await call(
      'POST',
      `/widget/insights-regen/${V2_ID}`,
      '{"mode":"full"}',
    );
    expect(res.status).toBe(500);
    expect(res.body).not.toContain('ubuntu');
    // The request file was written, then removed again.
    expect(vi.mocked(rename)).toHaveBeenCalled();
    const removed = vi
      .mocked(rm)
      .mock.calls.map(([p]) => String(p))
      .filter((p) => p.endsWith('regen-request.json'));
    expect(removed).toHaveLength(1);
  });

  it('regen: the rollback leaves a CONCURRENT request file alone', async () => {
    vi.mocked(getTaskById).mockReturnValue({ id: V2_TASK_ID } as never);
    const otherRequest = JSON.stringify({
      mode: 'new-only',
      requestedAt: new Date(Date.now() + 1_000).toISOString(),
    });
    // Model the race: a second POST's request lands (and its poke succeeds)
    // just as this one's poke throws.
    vi.mocked(updateTask).mockImplementation(() => {
      v2StateFiles.set('regen-request.json', otherRequest);
      throw new Error('SQLITE_BUSY');
    });
    const res = await call(
      'POST',
      `/widget/insights-regen/${V2_ID}`,
      '{"mode":"full"}',
    );
    expect(res.status).toBe(500);
    // The other request must survive — deleting it would report idle mid-run.
    expect(v2StateFiles.get('regen-request.json')).toBe(otherRequest);
    expect(
      vi
        .mocked(rm)
        .mock.calls.map(([p]) => String(p))
        .filter((p) => p.endsWith('regen-request.json')),
    ).toEqual([]);
  });

  // Vera round-3 SF1 — stat must precede the content read, so the worst race
  // outcome is fresh-items-still-"updating…" rather than a stale list stamped
  // done.
  it('GET: insights.json is STATted before its content is read', async () => {
    v2StateFiles.set(
      'insights.json',
      JSON.stringify({ asOf: '2026-08-18T11:00:00.000Z', items: [] }),
    );
    await call('GET', `/widget/data/${V2_ID}`);

    const statCalls = vi.mocked(stat).mock.calls.map(([p]) => String(p));
    expect(statCalls.some((p) => p.endsWith('insights.json'))).toBe(true);

    const readIdx = vi
      .mocked(readFile)
      .mock.calls.findIndex(([p]) => String(p).endsWith('insights.json'));
    expect(readIdx).toBeGreaterThanOrEqual(0);
    expect(vi.mocked(stat).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(readFile).mock.invocationCallOrder[readIdx],
    );
  });

  // SF1 — a pid+timestamp tmp name collides when two devices save in the same
  // millisecond; a UUID cannot.
  it('state: the tmp filename carries a UUID and differs across saves', async () => {
    await call('POST', `/widget/state/${V2_ID}`, JSON.stringify(OVERLAY));
    await call('POST', `/widget/state/${V2_ID}`, JSON.stringify(OVERLAY));
    const tmps = vi.mocked(writeFile).mock.calls.map(([p]) => String(p));
    expect(tmps).toHaveLength(2);
    for (const tmp of tmps) {
      expect(tmp).toMatch(
        /\.overlay\.json\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
    expect(tmps[0]).not.toBe(tmps[1]);
  });

  // SF2 — a mid-write failure must not litter the state dir the agent reads.
  it('state: a writeFile failure unlinks the tmp file', async () => {
    vi.mocked(writeFile).mockRejectedValue(new Error('ENOSPC'));
    const res = await call(
      'POST',
      `/widget/state/${V2_ID}`,
      JSON.stringify(OVERLAY),
    );
    expect(res.status).toBe(500);
    const tmp = String(vi.mocked(writeFile).mock.calls[0][0]);
    expect(vi.mocked(rm).mock.calls.map(([p]) => String(p))).toEqual([tmp]);
    expect(vi.mocked(rename)).not.toHaveBeenCalled();
  });

  it('state: a rename failure also unlinks the tmp file', async () => {
    vi.mocked(rename).mockRejectedValue(new Error('EXDEV'));
    const res = await call(
      'POST',
      `/widget/state/${V2_ID}`,
      JSON.stringify(OVERLAY),
    );
    expect(res.status).toBe(500);
    const tmp = String(vi.mocked(writeFile).mock.calls[0][0]);
    expect(vi.mocked(rm).mock.calls.map(([p]) => String(p))).toEqual([tmp]);
  });

  // Vera named gap — prototype-pollution shape. JSON.parse makes `__proto__` an
  // OWN property, so it reaches the validator; pinning the behaviour so a
  // future refactor can't turn "silently dropped" into "written through".
  it('state: a nested __proto__ key is accepted and silently dropped', async () => {
    const body = JSON.stringify({
      schemaVersion: 1,
      placements: { __proto__: 'active', 'daystrom␟Path to v3': 'active' },
      expanded: { __proto__: true },
    });
    const res = await call('POST', `/widget/state/${V2_ID}`, body);
    expect(res.status).toBe(200);
    const written = JSON.parse(
      String(vi.mocked(writeFile).mock.calls[0][1]),
    ) as {
      placements: Record<string, string>;
      expanded: Record<string, boolean>;
    };
    expect(Object.keys(written.placements)).toEqual(['daystrom␟Path to v3']);
    expect(Object.keys(written.expanded)).toEqual([]);
    // …and nothing was polluted along the way.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it('state: a TOP-LEVEL __proto__ key is rejected as an unknown field', async () => {
    const res = await call(
      'POST',
      `/widget/state/${V2_ID}`,
      '{"schemaVersion":1,"__proto__":{"polluted":true}}',
    );
    expect(res.status).toBe(400);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  // Vera named gap — the shared failed-auth throttle must cover the two new
  // POST routes, not just the v1 GET/feedback ones.
  it.each([
    ['state', `/widget/state/${V2_ID}`],
    ['insights-regen', `/widget/insights-regen/${V2_ID}`],
  ])('%s: 429 after 5 failed auth attempts from one IP', async (_n, route) => {
    // Dedicated channel so the rate-limit state is isolated from other tests.
    const rl = new WebChannel(makeOpts());
    await rl.connect();
    const rlPort = (
      (rl as unknown as { server: http.Server }).server.address() as AddressInfo
    ).port;
    try {
      const opts = {
        method: 'POST',
        path: route,
        headers: { Authorization: 'Bearer wrong', Origin: WIDGET_ORIGIN },
      };
      for (let i = 0; i < 5; i++) {
        expect((await req(rlPort, opts, '{}')).status).toBe(401);
      }
      const r6 = await req(rlPort, opts, '{}');
      expect(r6.status).toBe(429);
      expect(r6.headers['retry-after']).toBe('60');
      expect(r6.headers['access-control-allow-origin']).toBe(WIDGET_ORIGIN);
    } finally {
      await rl.disconnect();
    }
  });
});
