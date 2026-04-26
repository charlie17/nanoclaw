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

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  statfs: vi.fn(),
}));

const mockConfig = vi.hoisted(() => ({
  NANOCLAW_TOKEN: 'test-secret-token',
  NANOCLAW_WEB_HOST: '127.0.0.1',
  NANOCLAW_WEB_PORT: 0,
  ASSISTANT_NAME: 'Daystrom',
  CLAUDE_USAGE_PORT: 8080,
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
  get CLAUDE_USAGE_PORT() {
    return mockConfig.CLAUDE_USAGE_PORT;
  },
  CREDENTIAL_PROXY_PORT: 3001,
  NANOCLAW_ANTHROPIC_RATE_PER_DISPATCH: 0.2,
}));

import { readFile, readdir, stat, statfs, writeFile } from 'node:fs/promises';
import {
  clearChatMessages,
  deleteChat,
  deleteMessage as dbDeleteMessage,
  getConversation,
  getMessageCountForMonth,
  setRouterState,
  storeChatMetadata,
  storeMessage,
  updateChatName,
} from '../db.js';
import { logger } from '../logger.js';
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
    await new Promise<void>((resolve) => mockUpstream.listen(0, '127.0.0.1', resolve));
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
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    vi.mocked(statfs).mockResolvedValue({ bsize: 4096, blocks: 10000, bavail: 5000, bfree: 5100, ffree: 1000, files: 2000, favail: 900, f_frsize: 4096, namemax: 255, type: 0 } as unknown as Awaited<ReturnType<typeof statfs>>);
    vi.mocked(readdir).mockResolvedValue([] as unknown as Awaited<ReturnType<typeof readdir>>);
    proxyChannel = new WebChannel(makeOpts());
    await proxyChannel.connect();
    proxyPort = ((proxyChannel as unknown as { server: http.Server }).server.address() as AddressInfo).port;
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
