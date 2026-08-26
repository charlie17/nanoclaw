"""Readwise Reader API client — REST v3 + hosted MCP (JSON-RPC over SSE).

python3 stdlib ONLY. Runs unchanged inside the Linux agent container and on
Windows/Claude Code. This module is a library of functions, not a CLI.

Facts this module is built to (verified by live probe 2026-08-25):

* REST  ``GET https://readwise.io/api/v3/list/?id=<doc_id>&withHtmlContent=true``
  with ``Authorization: Token <token>`` returns ``{"results": [{... "html_content": ...}]}``.
  The plain list form accepts ``category`` / ``pageCursor`` and paginates with
  ``nextPageCursor``.
* MCP  ``POST https://mcp2.readwise.io/mcp`` with ``Authorization: Token <token>``,
  ``Content-Type: application/json``, ``Accept: application/json, text/event-stream``
  AND a browser-like ``User-Agent`` — without the UA, Cloudflare answers 403.
  JSON-RPC 2.0: ``initialize`` -> ``notifications/initialized`` -> ``tools/call``.
  Responses come back as SSE frames; the frame whose ``id`` matches the request
  id is the answer. No session header is required.
* Highlight creation takes a byte-for-byte verbatim ``<p ...>...</p>`` block from
  the document's ``html_content``.
* Retry is mutation-aware. A mutating tool call is never replayed on an ambiguous
  outcome (5xx, timeout, broken body read) because the highlight may already
  exist and cannot be deleted Reader-side; the caller reconciles instead. A 429
  IS retried even for a create — the server refused before doing the work.
  Classification is an allowlist (``READ_ONLY_TOOLS``): an unknown tool name is
  assumed to mutate.
* Reader-side highlight ids are NOT deletable. The highlight syncs to classic
  Readwise under an integer id; delete there
  (``readwise_list_highlights`` -> match text -> ``readwise_delete_highlight``).

Never prints or logs a token.
"""

from __future__ import annotations

import email.utils
import http.client
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# --------------------------------------------------------------------------
# Constants
# --------------------------------------------------------------------------

REST_BASE = "https://readwise.io/api/v3"
MCP_URL = "https://mcp2.readwise.io/mcp"

#: Cloudflare in front of mcp2.readwise.io 403s requests without a browser UA.
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

MCP_PROTOCOL_VERSION = "2025-03-26"
CLIENT_INFO = {"name": "daystrom-reading", "version": "1.0.0"}

DEFAULT_TIMEOUT = 30.0
#: html_content payloads run to ~1M chars; give them room.
HTML_TIMEOUT = 180.0
MAX_RETRIES = 4
MAX_BACKOFF_S = 60.0
MAX_RETRY_AFTER_S = 300.0

#: The create-highlight endpoint throttles around 20/min. Stay under it.
MIN_CREATE_INTERVAL_S = 3.5

#: Methods whose replay cannot change anything, so an ambiguous failure may be
#: sent again.
SAFE_METHODS = ("GET", "HEAD", "OPTIONS")

#: MCP tools known to change state. Documentation only — classification runs
#: off READ_ONLY_TOOLS below, because a state-changing tool nobody remembered to
#: add to a list must not thereby become replay-safe.
MUTATING_TOOLS = (
    "reader_create_highlight",
    "reader_add_tags_to_highlight",
    "reader_remove_tags_from_highlight",
    "reader_set_highlight_notes",
    "readwise_delete_highlight",
)

#: The allowlist: MCP tools whose replay cannot change anything, so an ambiguous
#: failure may be sent again even though MCP carries reads over POST. Anything
#: NOT named here — including a tool the gateway grows after this file was
#: written — is treated as mutating and is never replayed. Fail closed: a read
#: misclassified as a mutation costs one retry, while a create replayed by
#: mistake costs a permanent duplicate highlight Reader cannot delete.
READ_ONLY_TOOLS = (
    "reader_get_document_highlights",
    "readwise_list_highlights",
)

ENV_TOKEN_VAR = "READWISE_ACCESS_TOKEN"   # container
DOTENV_TOKEN_KEY = "READWISE_TOKEN"       # ~/.env on Windows / Claude Code


class ReaderAPIError(RuntimeError):
    """Any non-retryable failure talking to Readwise."""

    def __init__(self, message, status=None, body=None):
        super().__init__(message)
        self.status = status
        self.body = body


# --------------------------------------------------------------------------
# Token resolution (never printed)
# --------------------------------------------------------------------------


def _dotenv_path():
    return Path(os.path.expanduser("~")) / ".env"


def _parse_dotenv(path):
    """Return a dict of KEY -> value from a shell-style .env file.

    Tolerates ``export KEY=v``, ``#`` comments, blank lines, and single or
    double quoted values. Missing file -> empty dict.
    """
    values = {}
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            lines = fh.readlines()
    except OSError:
        return values
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if key:
            values[key] = value
    return values


def resolve_token(explicit=None):
    """Resolve the Readwise token.

    Precedence: explicit argument -> ``READWISE_ACCESS_TOKEN`` env var ->
    ``READWISE_TOKEN`` in ``~/.env``. Raises :class:`ReaderAPIError` if none
    is found. The token value is never included in any raised message.
    """
    if explicit:
        return explicit.strip()
    env_value = os.environ.get(ENV_TOKEN_VAR)
    if env_value and env_value.strip():
        return env_value.strip()
    dotenv = _parse_dotenv(_dotenv_path())
    file_value = dotenv.get(DOTENV_TOKEN_KEY)
    if file_value and file_value.strip():
        return file_value.strip()
    raise ReaderAPIError(
        "No Readwise token found: set %s in the environment or %s in ~/.env"
        % (ENV_TOKEN_VAR, DOTENV_TOKEN_KEY)
    )


def _auth_headers(token):
    return {"Authorization": "Token %s" % token}


# --------------------------------------------------------------------------
# HTTP plumbing
# --------------------------------------------------------------------------


def _sleep(seconds):
    """Indirection so tests can observe/skip backoff waits."""
    if seconds > 0:
        time.sleep(seconds)


def _header_get(headers, name):
    if headers is None:
        return None
    getter = getattr(headers, "get", None)
    if getter is None:
        return None
    return getter(name)


def _retry_after_seconds(header_value, attempt, now=None):
    """Seconds to wait before retry.

    Honors a ``Retry-After`` header in either delta-seconds or HTTP-date form.
    Falls back to capped exponential backoff (2**attempt) when the header is
    absent or unparseable. Result is always clamped to
    ``[0, MAX_RETRY_AFTER_S]``.
    """
    fallback = min(float(2 ** max(attempt, 0)), MAX_BACKOFF_S)
    if header_value is None:
        return fallback
    text = str(header_value).strip()
    if not text:
        return fallback
    if re.fullmatch(r"\d+(\.\d+)?", text):
        return max(0.0, min(float(text), MAX_RETRY_AFTER_S))
    try:
        when = email.utils.parsedate_to_datetime(text)
    except (TypeError, ValueError):
        return fallback
    if when is None:
        return fallback
    reference = now if now is not None else time.time()
    try:
        target = when.timestamp()
    except (OverflowError, OSError, ValueError):
        return fallback
    return max(0.0, min(target - reference, MAX_RETRY_AFTER_S))


def _decode(payload):
    if isinstance(payload, bytes):
        return payload.decode("utf-8", errors="replace")
    return payload


def _may_replay(status, mutating):
    """May a failed attempt be sent again?

    ``status`` is the HTTP status, or None for a transport or response-read
    failure — the genuinely ambiguous case, where the request may well have
    reached Readwise and taken effect before the wire broke.

    429 is the one unambiguous failure: the server refused the request instead
    of doing the work, so even a create may be retried. Every other ambiguous
    outcome on a mutating call is left to the caller, because a replayed
    ``reader_create_highlight`` makes a second highlight and Reader-side
    highlights cannot be deleted.
    """
    if status == 429:
        return True
    if mutating:
        return False
    return status is None or 500 <= status < 600


def _ambiguity_note(status, mutating):
    """Why a mutating call was not replayed, appended to the raised message."""
    if mutating and (status is None or 500 <= status < 600):
        return " (not retried: the request may already have taken effect)"
    return ""


def _request(url, method="GET", headers=None, body=None, timeout=DEFAULT_TIMEOUT,
             max_retries=MAX_RETRIES, mutating=None):
    """Perform one HTTP request with method-aware 429/5xx retry.

    Returns ``(status, headers, text)``. Raises :class:`ReaderAPIError` on a
    non-retryable HTTP error or after retries are exhausted.

    ``mutating`` defaults to "any method that is not safe" and can be set
    explicitly: MCP sends reads over POST too, and those stay retryable.
    """
    data = body.encode("utf-8") if isinstance(body, str) else body
    if mutating is None:
        mutating = str(method).upper() not in SAFE_METHODS
    attempt = 0
    while True:
        request = urllib.request.Request(url, data=data, method=method)
        for key, value in (headers or {}).items():
            request.add_header(key, value)
        failure = None
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                status = getattr(response, "status", None)
                if status is None:
                    status = response.getcode()
                try:
                    payload = response.read()
                except (OSError, http.client.HTTPException) as err:
                    # The body died mid-read. urlopen already succeeded, so this
                    # is not a URLError and would otherwise escape both the retry
                    # policy and this function's ReaderAPIError contract.
                    failure = err
                else:
                    return status, response.headers, _decode(payload)
        except urllib.error.HTTPError as err:
            status = err.code
            try:
                text = _decode(err.read())
            except Exception:  # pragma: no cover - defensive
                text = ""
            retryable = (
                (status == 429 or 500 <= status < 600)
                and _may_replay(status, mutating)
            )
            if not retryable or attempt >= max_retries:
                raise ReaderAPIError(
                    "HTTP %s from %s%s"
                    % (status, _safe_url(url), _ambiguity_note(status, mutating)),
                    status=status,
                    body=text[:2000],
                )
            wait = _retry_after_seconds(_header_get(err.headers, "Retry-After"), attempt)
            _sleep(wait)
            attempt += 1
            continue
        except urllib.error.URLError as err:
            failure = err

        # Transport or read-time failure: ambiguous, so one policy covers both.
        if not _may_replay(None, mutating) or attempt >= max_retries:
            raise ReaderAPIError(
                "Network error contacting %s: %s%s"
                % (_safe_url(url), getattr(failure, "reason", failure),
                   _ambiguity_note(None, mutating))
            )
        _sleep(min(float(2 ** attempt), MAX_BACKOFF_S))
        attempt += 1


def _safe_url(url):
    """URLs here never carry the token, but strip the query anyway."""
    return url.split("?", 1)[0]


# --------------------------------------------------------------------------
# REST v3
# --------------------------------------------------------------------------


def _list_page(params, token=None, timeout=DEFAULT_TIMEOUT):
    token = resolve_token(token)
    query = {k: v for k, v in params.items() if v is not None}
    url = "%s/list/?%s" % (REST_BASE, urllib.parse.urlencode(query))
    _status, _headers, text = _request(
        url, headers=_auth_headers(token), timeout=timeout
    )
    try:
        return json.loads(text)
    except ValueError as err:
        raise ReaderAPIError("Non-JSON response from /v3/list/: %s" % err)


def get_document(doc_id, with_html=False, token=None):
    """Fetch one Reader document by id.

    Returns the document dict (including ``html_content`` when
    ``with_html=True``) or ``None`` when the id is unknown.
    """
    params = {"id": doc_id}
    if with_html:
        params["withHtmlContent"] = "true"
    payload = _list_page(
        params, token=token, timeout=HTML_TIMEOUT if with_html else DEFAULT_TIMEOUT
    )
    results = payload.get("results") or []
    return results[0] if results else None


def find_documents(title_substring=None, category=None, token=None, max_pages=50):
    """List documents, optionally filtered client-side by title substring.

    ``category`` (e.g. ``"epub"``, ``"pdf"``, ``"article"``) is passed to the
    API; ``title_substring`` is matched case-insensitively against the document
    title locally, because the API has no title query.
    """
    needle = title_substring.lower() if title_substring else None
    cursor = None
    found = []
    pages = 0
    while pages < max_pages:
        payload = _list_page(
            {"category": category, "pageCursor": cursor}, token=token
        )
        for doc in payload.get("results") or []:
            if needle is None or needle in (doc.get("title") or "").lower():
                found.append(doc)
        cursor = payload.get("nextPageCursor")
        pages += 1
        if not cursor:
            break
    return found


# --------------------------------------------------------------------------
# MCP transport: JSON-RPC 2.0 over POST, replies as SSE
# --------------------------------------------------------------------------

_MCP_STATE = {"initialized": False, "next_id": 1}


def reset_mcp_state():
    """Drop the cached handshake (tests, or after an auth change)."""
    _MCP_STATE["initialized"] = False
    _MCP_STATE["next_id"] = 1


def _next_request_id():
    request_id = _MCP_STATE["next_id"]
    _MCP_STATE["next_id"] = request_id + 1
    return request_id


def parse_sse_frames(text):
    """Parse an SSE body into a list of decoded JSON frames.

    Frames are separated by a blank line; ``data:`` lines within a frame are
    joined with newlines per the SSE spec. Non-JSON and ``[DONE]`` payloads are
    skipped rather than raising.
    """
    frames = []
    for chunk in re.split(r"(?:\r\n|\r|\n){2,}", text):
        data_lines = []
        for line in chunk.splitlines():
            if not line.startswith("data:"):
                continue
            value = line[len("data:"):]
            if value.startswith(" "):
                value = value[1:]
            data_lines.append(value)
        if not data_lines:
            continue
        payload = "\n".join(data_lines).strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            frames.append(json.loads(payload))
        except ValueError:
            continue
    return frames


def pick_frame(frames, request_id):
    """Return the frame whose JSON-RPC ``id`` matches, else ``None``."""
    for frame in frames:
        if isinstance(frame, dict) and frame.get("id") == request_id:
            return frame
    return None


def _extract_frames(text, content_type):
    if content_type and "text/event-stream" in content_type.lower():
        return parse_sse_frames(text)
    stripped = (text or "").strip()
    if not stripped:
        return []
    try:
        decoded = json.loads(stripped)
    except ValueError:
        # Some gateways answer with SSE framing but a JSON content type.
        return parse_sse_frames(text)
    if isinstance(decoded, list):
        return [f for f in decoded if isinstance(f, dict)]
    return [decoded] if isinstance(decoded, dict) else []


def _mcp_post(payload, token, timeout=DEFAULT_TIMEOUT, mutating=False):
    headers = _auth_headers(token)
    headers["Content-Type"] = "application/json"
    headers["Accept"] = "application/json, text/event-stream"
    headers["User-Agent"] = USER_AGENT
    body = json.dumps(payload)
    status, response_headers, text = _request(
        MCP_URL, method="POST", headers=headers, body=body, timeout=timeout,
        mutating=mutating,
    )
    return status, _header_get(response_headers, "Content-Type"), text


def _mcp_notify(method, params, token):
    _mcp_post({"jsonrpc": "2.0", "method": method, "params": params or {}}, token)


def _mcp_call(method, params, token, timeout=DEFAULT_TIMEOUT, mutating=False):
    request_id = _next_request_id()
    payload = {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": method,
        "params": params or {},
    }
    _status, content_type, text = _mcp_post(
        payload, token, timeout=timeout, mutating=mutating
    )
    frame = pick_frame(_extract_frames(text, content_type), request_id)
    if frame is None:
        raise ReaderAPIError(
            "No JSON-RPC frame with id %s in MCP response to %s" % (request_id, method)
        )
    if "error" in frame:
        error = frame["error"] or {}
        raise ReaderAPIError(
            "MCP error on %s: %s (code %s)"
            % (method, error.get("message"), error.get("code"))
        )
    return frame.get("result")


def _ensure_handshake(token):
    """Run initialize + initialized once per process."""
    if _MCP_STATE["initialized"]:
        return
    _mcp_call(
        "initialize",
        {
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": CLIENT_INFO,
        },
        token,
    )
    _mcp_notify("notifications/initialized", {}, token)
    _MCP_STATE["initialized"] = True


def tool_result_payload(result):
    """Unwrap an MCP ``tools/call`` result into usable Python data.

    Readwise returns ``{"content": [{"type": "text", "text": "<json>"}]}``.
    Returns the decoded JSON when the text parses, otherwise the raw text.
    Raises when ``isError`` is set.
    """
    if not isinstance(result, dict):
        return result
    if result.get("isError"):
        raise ReaderAPIError("MCP tool reported an error: %s" % _content_text(result))
    if "structuredContent" in result and result["structuredContent"] is not None:
        return result["structuredContent"]
    text = _content_text(result)
    if text is None:
        return result
    try:
        return json.loads(text)
    except ValueError:
        return text


def _content_text(result):
    parts = []
    for item in result.get("content") or []:
        if isinstance(item, dict) and item.get("type") == "text":
            parts.append(item.get("text") or "")
    if not parts:
        return None
    return "\n".join(parts)


def is_mutating_tool(name):
    """True unless *name* is on the :data:`READ_ONLY_TOOLS` allowlist.

    Deliberately the pessimistic direction: an unrecognised tool is assumed to
    change something. The old membership test against ``MUTATING_TOOLS`` failed
    OPEN — every tool not on that list, including ones added to the gateway
    later, was replayed after an ambiguous 5xx or timeout.
    """
    return name not in READ_ONLY_TOOLS


def call_tool(name, arguments, token=None, timeout=DEFAULT_TIMEOUT, mutating=None):
    """Call an MCP tool by name and return its unwrapped payload.

    A mutating tool is never replayed by the transport on an ambiguous outcome
    (see :func:`_may_replay`); the caller reconciles instead.

    *mutating* defaults to the allowlist verdict (:func:`is_mutating_tool`).
    Pass ``False`` to declare a tool this module has never heard of replay-safe;
    that is the only way an unlisted tool gets retried.
    """
    token = resolve_token(token)
    _ensure_handshake(token)
    result = _mcp_call(
        "tools/call", {"name": name, "arguments": arguments or {}}, token,
        timeout=timeout,
        mutating=is_mutating_tool(name) if mutating is None else bool(mutating),
    )
    return tool_result_payload(result)


def list_tools(token=None):
    """Return the MCP server's tool descriptors (diagnostics)."""
    token = resolve_token(token)
    _ensure_handshake(token)
    result = _mcp_call("tools/list", {}, token)
    if isinstance(result, dict):
        return result.get("tools") or []
    return []


# --------------------------------------------------------------------------
# Pacing guard for highlight creation
# --------------------------------------------------------------------------

_LAST_CREATE_AT = None


def _pace_wait_seconds(last_at, now, interval=MIN_CREATE_INTERVAL_S):
    """Seconds still owed before the next create call may go out."""
    if last_at is None:
        return 0.0
    remaining = interval - (now - last_at)
    return remaining if remaining > 0 else 0.0


def _await_create_slot():
    global _LAST_CREATE_AT
    wait = _pace_wait_seconds(_LAST_CREATE_AT, time.monotonic())
    if wait > 0:
        _sleep(wait)
    _LAST_CREATE_AT = time.monotonic()


def reset_pacing():
    """Clear the create-call pacing clock (tests)."""
    global _LAST_CREATE_AT
    _LAST_CREATE_AT = None


# --------------------------------------------------------------------------
# Public Reader highlight operations
# --------------------------------------------------------------------------


def create_highlight(doc_id, html_block, note=None, tags=None, token=None):
    """Create one anchor highlight on a Reader document.

    ``html_block`` MUST be a byte-for-byte verbatim ``<p ...>...</p>`` block
    taken from that document's ``html_content`` — anything else fails to anchor.
    Returns the tool payload, normally
    ``{"id": ..., "location": ..., "url": "https://read.readwise.io/read/<id>"}``.
    Calls are paced to at least ``MIN_CREATE_INTERVAL_S`` apart.

    A raised error is NOT proof that nothing was created: the transport refuses
    to replay this call precisely because an ambiguous failure may follow a
    successful commit. Reconcile against the document's existing highlights
    before creating again.
    """
    arguments = {"document_id": doc_id, "html_content": html_block}
    if note:
        arguments["note"] = note
    if tags:
        arguments["tags"] = list(tags)
    _await_create_slot()
    return call_tool("reader_create_highlight", arguments, token=token)


def get_document_highlights(doc_id, token=None):
    """All highlights currently on a Reader document."""
    return call_tool(
        "reader_get_document_highlights", {"document_id": doc_id}, token=token
    )


def add_tags_to_highlight(highlight_id, tags, token=None):
    return call_tool(
        "reader_add_tags_to_highlight",
        {"highlight_id": highlight_id, "tags": list(tags)},
        token=token,
    )


def remove_tags_from_highlight(highlight_id, tags, token=None):
    return call_tool(
        "reader_remove_tags_from_highlight",
        {"highlight_id": highlight_id, "tags": list(tags)},
        token=token,
    )


def set_highlight_notes(highlight_id, note, token=None):
    return call_tool(
        "reader_set_highlight_notes",
        {"highlight_id": highlight_id, "notes": note},
        token=token,
    )


# --------------------------------------------------------------------------
# Classic Readwise — the only deletion path
# --------------------------------------------------------------------------


def list_classic_highlights(page_size=20, token=None):
    """Recent classic-Readwise highlights (these carry integer ids)."""
    return call_tool(
        "readwise_list_highlights", {"page_size": page_size}, token=token
    )


def delete_classic_highlight(int_id, token=None):
    """Delete a highlight by its classic integer id.

    Reader-side ids cannot be deleted; a Reader highlight syncs to classic
    Readwise where it gains an integer id. Find it with
    :func:`list_classic_highlights` and delete it here.
    """
    return call_tool(
        "readwise_delete_highlight", {"highlight_id": int(int_id)}, token=token
    )
