import http from 'http';
import type { AddressInfo } from 'net';
import {
  afterAll,
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
}));

vi.mock('../config.js', () => ({
  NANOCLAW_TOKEN: 'test-secret-token',
  NANOCLAW_WEB_HOST: '127.0.0.1',
  NANOCLAW_WEB_PORT: 0,
  ASSISTANT_NAME: 'Daystrom',
}));

import {
  checkToken,
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
});
