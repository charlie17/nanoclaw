import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const mockEnv: Record<string, string> = {};
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { startCredentialProxy } from './credential-proxy.js';

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body = '',
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...options, hostname: '127.0.0.1', port },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('credential-proxy', () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;
  let upstreamPort: number;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;

  beforeEach(async () => {
    lastUpstreamHeaders = {};

    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  async function startProxy(env: Record<string, string>): Promise<number> {
    Object.assign(mockEnv, env, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0);
    return (proxyServer.address() as AddressInfo).port;
  }

  it('API-key mode injects x-api-key and strips placeholder', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-real-key');
  });

  it('OAuth mode replaces Authorization when container sends one', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer real-oauth-token',
    );
  });

  it('OAuth mode does not inject Authorization when container omits it', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    // Post-exchange: container uses x-api-key only, no Authorization header
    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'temp-key-from-exchange',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('temp-key-from-exchange');
    expect(lastUpstreamHeaders['authorization']).toBeUndefined();
  });

  it('strips hop-by-hop headers', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
          'transfer-encoding': 'chunked',
        },
      },
      '{}',
    );

    // Proxy strips client hop-by-hop headers. Node's HTTP client may re-add
    // its own Connection header (standard HTTP/1.1 behavior), but the client's
    // custom keep-alive and transfer-encoding must not be forwarded.
    expect(lastUpstreamHeaders['keep-alive']).toBeUndefined();
    expect(lastUpstreamHeaders['transfer-encoding']).toBeUndefined();
  });

  // ---- D-90 body-inspection rule tests (L2–L6) --------------------------------

  // L2: web_search tool type rejected with 403 + policy_rejected body
  it('D-90 L2: rejects web_search_20250305 tool with 403', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        tools: [{ type: 'web_search_20250305', name: 'ws' }],
        messages: [{ role: 'user', content: 'test' }],
      }),
    );

    expect(res.statusCode).toBe(403);
    const parsed = JSON.parse(res.body) as { error: { type: string } };
    expect(parsed.error.type).toBe('policy_rejected');
  });

  // L3: unicode bypass attempt — JSON parser normalizes \u005f to _; rule fires
  it('D-90 L3: unicode bypass attempt is caught by JSON-structural parse', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    // \u005f is '_'; after JSON parse, type === 'web_search_20250305'
    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{"tools":[{"type":"web\\u005fsearch_20250305","name":"ws"}],"model":"claude-sonnet-4-6","max_tokens":100,"messages":[{"role":"user","content":"test"}]}',
    );

    expect(res.statusCode).toBe(403);
  });

  // L4: whitespace bypass — trim() before regex; leading/trailing spaces are rejected
  it('D-90 L4: whitespace bypass attempt is caught after trim()', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        tools: [{ type: ' web_search_20250305 ', name: 'ws' }],
        messages: [{ role: 'user', content: 'test' }],
      }),
    );

    expect(res.statusCode).toBe(403);
  });

  // L5: normal request without tools passes through unchanged
  it('D-90 L5: normal request without tools passes through', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );

    expect(res.statusCode).toBe(200);
  });

  // L6: non-web-search server-side tool passes through unchanged
  it('D-90 L6: non-web-search tool (text_editor) passes through', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        tools: [{ type: 'text_editor_20250124', name: 'editor' }],
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );

    expect(res.statusCode).toBe(200);
  });

  // ---- D-90 V-2: batch endpoint coverage (L7–L10) ----------------------------

  // L7: batch payload with web_search in requests[0].params.tools[] → 403
  it('D-90 L7: batch with web_search in requests[0].params.tools rejects', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages/batches',
        headers: { 'content-type': 'application/json' },
      },
      JSON.stringify({
        requests: [
          {
            custom_id: 'req-1',
            params: {
              model: 'claude-sonnet-4-6',
              max_tokens: 100,
              tools: [{ type: 'web_search_20250305', name: 'ws' }],
              messages: [{ role: 'user', content: 'test' }],
            },
          },
        ],
      }),
    );

    expect(res.statusCode).toBe(403);
    const parsed = JSON.parse(res.body) as { error: { type: string } };
    expect(parsed.error.type).toBe('policy_rejected');
  });

  // L8: batch with web_search in requests[1] (not the first) — proves loop doesn't stop early
  it('D-90 L8: batch with web_search in requests[1].params.tools rejects', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages/batches',
        headers: { 'content-type': 'application/json' },
      },
      JSON.stringify({
        requests: [
          {
            custom_id: 'req-1',
            params: {
              model: 'claude-sonnet-4-6',
              max_tokens: 100,
              messages: [{ role: 'user', content: 'safe' }],
            },
          },
          {
            custom_id: 'req-2',
            params: {
              model: 'claude-sonnet-4-6',
              max_tokens: 100,
              tools: [{ type: 'web_search_20250305', name: 'ws' }],
              messages: [{ role: 'user', content: 'danger' }],
            },
          },
        ],
      }),
    );

    expect(res.statusCode).toBe(403);
  });

  // L9: batch payload with normal (non-web-search) tool → 200 passthrough
  it('D-90 L9: batch with non-web-search tool passes through', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages/batches',
        headers: { 'content-type': 'application/json' },
      },
      JSON.stringify({
        requests: [
          {
            custom_id: 'req-1',
            params: {
              model: 'claude-sonnet-4-6',
              max_tokens: 100,
              tools: [{ type: 'text_editor_20250124', name: 'editor' }],
              messages: [{ role: 'user', content: 'hi' }],
            },
          },
        ],
      }),
    );

    expect(res.statusCode).toBe(200);
  });

  // L10: batch with empty requests[] → 200 passthrough (degenerate but valid)
  it('D-90 L10: batch with empty requests[] passes through', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages/batches',
        headers: { 'content-type': 'application/json' },
      },
      JSON.stringify({ requests: [] }),
    );

    expect(res.statusCode).toBe(200);
  });

  // ---- D-90 V-4: path bypass coverage (L11–L15) --------------------------------

  // L11: query string bypass — /v1/messages?beta=x with web_search → 403
  it('D-90 L11: query string on path does not bypass inspection', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages?beta=x',
        headers: { 'content-type': 'application/json' },
      },
      JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        tools: [{ type: 'web_search_20250305', name: 'ws' }],
        messages: [{ role: 'user', content: 'test' }],
      }),
    );

    expect(res.statusCode).toBe(403);
  });

  // L12: trailing slash on /v1/messages/ with web_search → 403
  it('D-90 L12: trailing slash on /v1/messages/ does not bypass inspection', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages/',
        headers: { 'content-type': 'application/json' },
      },
      JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        tools: [{ type: 'web_search_20250305', name: 'ws' }],
        messages: [{ role: 'user', content: 'test' }],
      }),
    );

    expect(res.statusCode).toBe(403);
  });

  // L13: trailing slash on /v1/messages/batches/ → 403
  it('D-90 L13: trailing slash on /v1/messages/batches/ does not bypass inspection', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages/batches/',
        headers: { 'content-type': 'application/json' },
      },
      JSON.stringify({
        requests: [
          {
            custom_id: 'req-1',
            params: {
              model: 'claude-sonnet-4-6',
              max_tokens: 100,
              tools: [{ type: 'web_search_20250305', name: 'ws' }],
              messages: [{ role: 'user', content: 'test' }],
            },
          },
        ],
      }),
    );

    expect(res.statusCode).toBe(403);
  });

  // L14: case-insensitive path — /V1/Messages with web_search → 403
  it('D-90 L14: case-insensitive path /V1/Messages does not bypass inspection', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/V1/Messages',
        headers: { 'content-type': 'application/json' },
      },
      JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        tools: [{ type: 'web_search_20250305', name: 'ws' }],
        messages: [{ role: 'user', content: 'test' }],
      }),
    );

    expect(res.statusCode).toBe(403);
  });

  // L15: case + whitespace on tool type — " Web_Search_20250305 " → 403
  it('D-90 L15: whitespace + case variant tool type does not bypass inspection', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        tools: [{ type: ' Web_Search_20250305 ', name: 'ws' }],
        messages: [{ role: 'user', content: 'test' }],
      }),
    );

    expect(res.statusCode).toBe(403);
  });

  // ---- end D-90 body-inspection rule tests ------------------------------------

  it('returns 502 when upstream is unreachable', async () => {
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:59999',
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(502);
    expect(res.body).toBe('Bad Gateway');
  });
});
