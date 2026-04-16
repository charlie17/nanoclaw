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

vi.mock('../db.js', () => ({
  storeChatMetadata: vi.fn(),
  getAllChats: vi.fn(() => []),
  getMessagesSince: vi.fn(() => []),
  updateChatName: vi.fn(),
  setRouterState: vi.fn(),
  deleteChat: vi.fn(),
  deleteMessage: vi.fn(() => true),
  clearChatMessages: vi.fn(() => 3),
}));

// vi.hoisted: allows per-test group folder path override (same pattern as mockConfig)
const mockGroupFolder = vi.hoisted(() => ({
  path: '/tmp/test-groups/daystrom',
}));

vi.mock('../group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(() => mockGroupFolder.path),
}));

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn(),
}));

const mockConfig = vi.hoisted(() => ({
  NANOCLAW_TOKEN: 'test-secret-token',
  NANOCLAW_WEB_HOST: '127.0.0.1',
  NANOCLAW_WEB_PORT: 0,
  ASSISTANT_NAME: 'Daystrom',
}));

vi.mock('../config.js', () => ({
  get NANOCLAW_TOKEN() {
    return mockConfig.NANOCLAW_TOKEN;
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
}));

import { writeFile } from 'node:fs/promises';
import {
  deleteMessage as dbDeleteMessage,
  updateChatName,
  setRouterState,
  deleteChat,
  clearChatMessages,
} from '../db.js';
import {
  checkToken,
  isAllowedExtension,
  sanitizeFilename,
  sanitizeSid,
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
    expect(res.headers['set-cookie']?.[0]).toContain('SameSite=Strict');
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
      (uploadChannel as unknown as { server: http.Server }).server.address() as AddressInfo
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
      { method: 'POST', path: '/chat/upload', headers: authHeaders({ 'Content-Length': Buffer.byteLength(body).toString() }) },
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
      { method: 'POST', path: '/chat/upload', headers: authHeaders({ 'Content-Length': Buffer.byteLength(body).toString() }) },
      body,
    );
    expect(r.status).toBe(200);
    expect(uploadOpts.onMessage).toHaveBeenCalledTimes(1);
    const [, msg] = vi.mocked(uploadOpts.onMessage).mock.calls[0] as [string, { content: string }];
    expect(msg.content).toMatch(/^Uploaded a file:/);
  });

  it('POST /chat/upload body too large returns 413', async () => {
    const big = JSON.stringify({ sid: 'abc123', filename: 'f.pdf', data: 'x'.repeat(10_000_001) });
    const r = await req(
      uploadPort,
      { method: 'POST', path: '/chat/upload', headers: authHeaders({ 'Content-Length': Buffer.byteLength(big).toString() }) },
      big,
    );
    expect(r.status).toBe(413);
  });

  it('POST /chat/upload quarantine path returns 403 — no write, no onMessage (C3 bulletproof)', async () => {
    // Simulate a misconfigured mount: groupDir resolves into quarantine
    mockGroupFolder.path = '/home/ubuntu/vault/groups/quarantine/uploads';
    vi.mocked(uploadOpts.registeredGroups).mockReturnValue({
      daystrom: { name: 'Daystrom', folder: 'daystrom', trigger: '', added_at: '', isMain: true },
    });
    vi.mocked(writeFile).mockResolvedValue(undefined);
    const body = uploadBody({ filename: 'receipt.pdf' });
    const r = await req(
      uploadPort,
      { method: 'POST', path: '/chat/upload', headers: authHeaders({ 'Content-Length': Buffer.byteLength(body).toString() }) },
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
      { method: 'POST', path: '/chat/upload', headers: authHeaders({ 'Content-Length': Buffer.byteLength(body).toString() }) },
      body,
    );
    expect(r.status).toBe(200);
    expect(writeFile).toHaveBeenCalledTimes(2);
    const secondCallPath = (vi.mocked(writeFile).mock.calls[1] as [string, ...unknown[]])[0];
    expect(secondCallPath).toMatch(/-\d+\.pdf$/);
  });

  // ── Session name ───────────────────────────────────────────────────────────

  it('POST /chat/session-name valid returns 200 and calls updateChatName', async () => {
    const body = JSON.stringify({ sid: 'abc123', name: 'My Notes' });
    const r = await req(
      uploadPort,
      { method: 'POST', path: '/chat/session-name', headers: authHeaders({ 'Content-Length': Buffer.byteLength(body).toString() }) },
      body,
    );
    expect(r.status).toBe(200);
    expect(updateChatName).toHaveBeenCalledWith('local@web-abc123', 'My Notes');
  });

  it('POST /chat/session-name empty-post-sanitize name returns 400', async () => {
    const body = JSON.stringify({ sid: 'abc123', name: '\x00\x01' });
    const r = await req(
      uploadPort,
      { method: 'POST', path: '/chat/session-name', headers: authHeaders({ 'Content-Length': Buffer.byteLength(body).toString() }) },
      body,
    );
    expect(r.status).toBe(400);
  });

  // ── Session order ──────────────────────────────────────────────────────────

  it('POST /chat/session-order valid array returns 200 and persists via setRouterState', async () => {
    const body = JSON.stringify({ order: ['abc123', 'def456'] });
    const r = await req(
      uploadPort,
      { method: 'POST', path: '/chat/session-order', headers: authHeaders({ 'Content-Length': Buffer.byteLength(body).toString() }) },
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
      { method: 'POST', path: '/chat/session-order', headers: authHeaders({ 'Content-Length': Buffer.byteLength(body).toString() }) },
      body,
    );
    expect(r.status).toBe(400);
  });

  // ── Delete session ─────────────────────────────────────────────────────────

  it('POST /chat/delete-session returns 200 and calls deleteChat', async () => {
    const body = JSON.stringify({ sid: 'abc123' });
    const r = await req(
      uploadPort,
      { method: 'POST', path: '/chat/delete-session', headers: authHeaders({ 'Content-Length': Buffer.byteLength(body).toString() }) },
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
      { method: 'POST', path: '/chat/delete-message', headers: authHeaders({ 'Content-Length': Buffer.byteLength(body).toString() }) },
      body,
    );
    expect(r.status).toBe(200);
  });

  it('POST /chat/delete-message not found returns 404', async () => {
    vi.mocked(dbDeleteMessage).mockReturnValue(false);
    const body = JSON.stringify({ sid: 'abc123', id: 'msg-999' });
    const r = await req(
      uploadPort,
      { method: 'POST', path: '/chat/delete-message', headers: authHeaders({ 'Content-Length': Buffer.byteLength(body).toString() }) },
      body,
    );
    expect(r.status).toBe(404);
  });

  // ── Clear history ──────────────────────────────────────────────────────────

  it('POST /chat/clear-history returns 200 and calls clearChatMessages', async () => {
    const body = JSON.stringify({ sid: 'abc123' });
    const r = await req(
      uploadPort,
      { method: 'POST', path: '/chat/clear-history', headers: authHeaders({ 'Content-Length': Buffer.byteLength(body).toString() }) },
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
      { method: 'POST', path: '/chat/cancel', headers: authHeaders({ 'Content-Length': Buffer.byteLength(body).toString() }) },
      body,
    );
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ ok: true });
  });

  // ── HEAD aliasing ──────────────────────────────────────────────────────────

  it('HEAD / returns 200 with CSP header and empty body', async () => {
    const r = await req(uploadPort, { method: 'HEAD', path: '/' });
    expect(r.status).toBe(200);
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.body).toBe('');
  });

  it('HEAD /manifest.json returns 200 with content-type application/json and empty body', async () => {
    const r = await req(uploadPort, { method: 'HEAD', path: '/manifest.json' });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/json');
    expect(r.body).toBe('');
  });
});
