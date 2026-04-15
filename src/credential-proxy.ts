/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

// JT: D-90 body-inspection rule (Batch 1.1c — SA §4.3).
// JT: Regex matches normalized (trimmed, lowercased) web_search_* tool types.
// JT: Normalization closes case, whitespace, and unicode-case bypass variants.
const WEB_SEARCH_RE = /^web_search(_\w+)?$/;
// JT: Case-insensitive path match; trailing slashes stripped before test (V-4).
const MESSAGES_PATH_RE = /^\/v1\/messages(\/batches)?$/i;

interface BodyRejection {
  status: number;
  body: {
    error: { type: string; message: string };
  };
}

/**
 * Check tools[] and tool_choice in a single parsed object.
 * Used for both /v1/messages (top-level) and /v1/messages/batches (requests[i].params).
 * Returns a rejection descriptor on first hit, null to pass.
 *
 * tool.type is trimmed and lowercased before regex match so that case variants
 * (e.g. "Web_Search_20250305") and whitespace variants (" web_search_20250305 ")
 * are rejected without a separate bypass path. See V-4 decision record.
 */
function checkToolsAndChoice(
  obj: Record<string, unknown>,
  context: string,
): BodyRejection | null {
  // Check tools[]
  if (Array.isArray(obj.tools)) {
    for (const tool of obj.tools as unknown[]) {
      if (
        tool !== null &&
        typeof tool === 'object' &&
        'type' in tool &&
        typeof (tool as Record<string, unknown>).type === 'string'
      ) {
        const typeNormalized = String((tool as Record<string, unknown>).type)
          .trim()
          .toLowerCase();
        if (WEB_SEARCH_RE.test(typeNormalized)) {
          logger.warn(
            {
              context,
              tool_type: (tool as Record<string, unknown>).type,
              rule: 'D-90-web_search-reject',
            },
            'D-90: web_search tool rejected from container egress',
          );
          return {
            status: 403,
            body: {
              error: {
                type: 'policy_rejected',
                message:
                  'web_search tool not permitted from container egress — see D-90',
              },
            },
          };
        }
      }
    }
  }

  // Check tool_choice
  if (
    obj.tool_choice !== null &&
    typeof obj.tool_choice === 'object' &&
    obj.tool_choice !== undefined &&
    'type' in (obj.tool_choice as Record<string, unknown>) &&
    typeof (obj.tool_choice as Record<string, unknown>).type === 'string'
  ) {
    const typeNormalized = String(
      (obj.tool_choice as Record<string, unknown>).type,
    )
      .trim()
      .toLowerCase();
    if (WEB_SEARCH_RE.test(typeNormalized)) {
      logger.warn(
        {
          context,
          tool_choice_type: (obj.tool_choice as Record<string, unknown>).type,
          rule: 'D-90-web_search-reject',
        },
        'D-90: web_search tool_choice rejected from container egress',
      );
      return {
        status: 403,
        body: {
          error: {
            type: 'policy_rejected',
            message:
              'web_search tool_choice not permitted from container egress — see D-90',
          },
        },
      };
    }
  }

  return null;
}

/**
 * Inspect a Messages API request body for disallowed web_search_* tools.
 * Returns a rejection descriptor if the request should be blocked, null to pass.
 *
 * Rules (SA §4.3):
 *  - Only POST to /v1/messages or /v1/messages/batches is inspected.
 *    URL is parsed to extract pathname; trailing slashes stripped; case-insensitive.
 *  - Non-JSON body → 400 (malformed request to a JSON API).
 *  - /v1/messages: tools[]/tool_choice at body top level → 403 on web_search_*.
 *  - /v1/messages/batches: tools[]/tool_choice in each requests[i].params → 403.
 *  - All other requests pass through unchanged.
 */
export function inspectMessagesBody(
  method: string | undefined,
  url: string | undefined,
  rawBody: Buffer,
): BodyRejection | null {
  if (method !== 'POST') return null;
  if (!url) return null;

  // Parse pathname from the full request-target (handles query strings).
  // Strip trailing slashes for case-insensitive comparison. V-4 fix.
  const pathname = new URL(url, 'http://proxy.local').pathname.replace(
    /\/+$/,
    '',
  );
  if (!MESSAGES_PATH_RE.test(pathname)) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
  } catch {
    return {
      status: 400,
      body: {
        error: {
          type: 'invalid_request_error',
          message: 'Invalid JSON body for Messages API request',
        },
      },
    };
  }

  // Branch: /v1/messages/batches → iterate requests[].params (V-2 fix).
  const isBatches = /\/v1\/messages\/batches$/i.test(pathname);
  if (isBatches) {
    if (!Array.isArray(parsed.requests)) return null;
    for (let i = 0; i < parsed.requests.length; i++) {
      const entry = parsed.requests[i] as Record<string, unknown> | null;
      if (!entry) continue;
      const params = entry.params as Record<string, unknown> | null;
      if (!params) continue;
      const rejection = checkToolsAndChoice(params, `requests[${i}].params`);
      if (rejection !== null) return rejection;
    }
    return null;
  }

  // Non-batch /v1/messages: top-level check.
  return checkToolsAndChoice(parsed, 'body');
}

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);

        // JT: D-90 body-inspection rule (Batch 1.1c, Option 2 — SA §4.3).
        // JT: Reject any container-originated request to the Messages API whose
        // JT: tools[] contains a web_search_* type. JSON-structural parse —
        // JT: not string grep — so unicode/whitespace bypass attempts are caught.
        const bodyRejection = inspectMessagesBody(req.method, req.url, body);
        if (bodyRejection !== null) {
          res.writeHead(bodyRejection.status, {
            'content-type': 'application/json',
          });
          res.end(JSON.stringify(bodyRejection.body));
          return;
        }

        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
