"""Tests for scripts/readerapi.py — strictly offline, stdlib unittest only.

Every network call is mocked at the ``urllib.request.urlopen`` boundary; nothing
here touches Readwise and no real token is read.
"""

from __future__ import annotations

import contextlib
import email.message
import email.utils
import http.client
import io
import json
import os
import sys
import tempfile
import time
import unittest
import urllib.error
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import readerapi  # noqa: E402

DUMMY_TOKEN = "test-token-not-real"


def make_headers(pairs):
    message = email.message.Message()
    for key, value in (pairs or {}).items():
        message[key] = value
    return message


class FakeResponse:
    """Stand-in for http.client.HTTPResponse as urlopen returns it."""

    def __init__(self, body="", headers=None, status=200):
        self._body = body.encode("utf-8")
        self.status = status
        self.headers = make_headers(headers)

    def read(self):
        return self._body

    def getcode(self):
        return self.status

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def http_error(status, headers=None, body=""):
    return urllib.error.HTTPError(
        "https://readwise.io/api/v3/list/",
        status,
        "boom",
        make_headers(headers),
        io.BytesIO(body.encode("utf-8")),
    )


def sse(*frames):
    return "".join(
        "event: message\ndata: %s\n\n" % json.dumps(frame) for frame in frames
    )


@contextlib.contextmanager
def temp_home(dotenv_text=None, access_token=None):
    """Isolated HOME (cross-platform) with an optional ~/.env."""
    with tempfile.TemporaryDirectory() as tmp:
        env = {"HOME": tmp, "USERPROFILE": tmp, "HOMEDRIVE": "", "HOMEPATH": tmp}
        with mock.patch.dict(os.environ, env):
            if access_token is None:
                os.environ.pop(readerapi.ENV_TOKEN_VAR, None)
            else:
                os.environ[readerapi.ENV_TOKEN_VAR] = access_token
            if dotenv_text is not None:
                with open(os.path.join(tmp, ".env"), "w", encoding="utf-8") as fh:
                    fh.write(dotenv_text)
            yield Path(tmp)


# --------------------------------------------------------------------------


class TokenResolutionTests(unittest.TestCase):
    DOTENV = (
        "# secrets\n"
        "OTHER_KEY=ignored\n"
        "READWISE_TOKEN=from-dotenv\n"
    )

    def test_env_var_wins_over_dotenv(self):
        with temp_home(self.DOTENV, access_token="from-env"):
            self.assertEqual(readerapi.resolve_token(), "from-env")

    def test_dotenv_used_when_env_var_absent(self):
        with temp_home(self.DOTENV):
            self.assertEqual(readerapi.resolve_token(), "from-dotenv")

    def test_blank_env_var_falls_through_to_dotenv(self):
        with temp_home(self.DOTENV, access_token="   "):
            self.assertEqual(readerapi.resolve_token(), "from-dotenv")

    def test_explicit_argument_wins(self):
        with temp_home(self.DOTENV, access_token="from-env"):
            self.assertEqual(readerapi.resolve_token("explicit"), "explicit")

    def test_missing_everywhere_raises_without_leaking(self):
        with temp_home(dotenv_text="OTHER_KEY=x\n"):
            with self.assertRaises(readerapi.ReaderAPIError) as caught:
                readerapi.resolve_token()
        message = str(caught.exception)
        self.assertIn("READWISE_ACCESS_TOKEN", message)
        self.assertNotIn("from-dotenv", message)

    def test_no_dotenv_file_at_all(self):
        with temp_home():
            with self.assertRaises(readerapi.ReaderAPIError):
                readerapi.resolve_token()

    def test_dotenv_parser_handles_quotes_export_and_comments(self):
        text = (
            "\n"
            "# comment line\n"
            'QUOTED="double"\n'
            "SINGLE='single'\n"
            "export EXPORTED=value\n"
            "SPACED = padded \n"
            "NOEQUALS\n"
            "EMPTY=\n"
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, ".env")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(text)
            parsed = readerapi._parse_dotenv(path)
        self.assertEqual(parsed["QUOTED"], "double")
        self.assertEqual(parsed["SINGLE"], "single")
        self.assertEqual(parsed["EXPORTED"], "value")
        self.assertEqual(parsed["SPACED"], "padded")
        self.assertEqual(parsed["EMPTY"], "")
        self.assertNotIn("NOEQUALS", parsed)

    def test_dotenv_missing_file_is_empty(self):
        self.assertEqual(readerapi._parse_dotenv("/no/such/path/.env"), {})


# --------------------------------------------------------------------------


class SseParsingTests(unittest.TestCase):
    def test_picks_the_frame_whose_id_matches(self):
        payload = (
            "event: message\n"
            'data: {"jsonrpc":"2.0","id":1,"result":{"first":true}}\n'
            "\n"
            "event: message\n"
            'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n'
            "\n"
            "event: message\n"
            'data: {"jsonrpc":"2.0","id":2,"result":{"second":true}}\n'
            "\n"
        )
        frames = readerapi.parse_sse_frames(payload)
        self.assertEqual(len(frames), 3)
        self.assertEqual(readerapi.pick_frame(frames, 2)["result"], {"second": True})
        self.assertEqual(readerapi.pick_frame(frames, 1)["result"], {"first": True})
        self.assertIsNone(readerapi.pick_frame(frames, 99))

    def test_multiline_data_field_is_joined(self):
        payload = 'data: {"jsonrpc":"2.0","id":7,\ndata: "result":{"ok":1}}\n\n'
        frames = readerapi.parse_sse_frames(payload)
        self.assertEqual(readerapi.pick_frame(frames, 7)["result"], {"ok": 1})

    def test_done_and_garbage_frames_are_skipped(self):
        payload = (
            "data: [DONE]\n\n"
            "data: not json at all\n\n"
            ": a comment line\n\n"
            'data: {"id":3,"result":{}}\n\n'
        )
        frames = readerapi.parse_sse_frames(payload)
        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0]["id"], 3)

    def test_crlf_framing(self):
        payload = 'data: {"id":5,"result":{"a":1}}\r\n\r\ndata: {"id":6}\r\n\r\n'
        frames = readerapi.parse_sse_frames(payload)
        self.assertEqual([f["id"] for f in frames], [5, 6])

    def test_extract_frames_accepts_plain_json(self):
        body = json.dumps({"jsonrpc": "2.0", "id": 4, "result": {"ok": True}})
        frames = readerapi._extract_frames(body, "application/json")
        self.assertEqual(readerapi.pick_frame(frames, 4)["result"], {"ok": True})

    def test_extract_frames_falls_back_to_sse_on_wrong_content_type(self):
        body = sse({"jsonrpc": "2.0", "id": 8, "result": {}})
        frames = readerapi._extract_frames(body, "application/json")
        self.assertEqual(frames[0]["id"], 8)


# --------------------------------------------------------------------------


class RetryAfterMathTests(unittest.TestCase):
    def test_delta_seconds(self):
        self.assertEqual(readerapi._retry_after_seconds("12", 0), 12.0)
        self.assertEqual(readerapi._retry_after_seconds(" 1.5 ", 3), 1.5)

    def test_http_date(self):
        when = datetime.now(timezone.utc) + timedelta(seconds=30)
        header = email.utils.format_datetime(when, usegmt=True)
        wait = readerapi._retry_after_seconds(header, 0, now=time.time())
        self.assertGreater(wait, 25)
        self.assertLessEqual(wait, 31)

    def test_http_date_in_the_past_clamps_to_zero(self):
        when = datetime.now(timezone.utc) - timedelta(seconds=90)
        header = email.utils.format_datetime(when, usegmt=True)
        self.assertEqual(readerapi._retry_after_seconds(header, 0, now=time.time()), 0.0)

    def test_absent_header_uses_exponential_backoff(self):
        self.assertEqual(readerapi._retry_after_seconds(None, 0), 1.0)
        self.assertEqual(readerapi._retry_after_seconds(None, 1), 2.0)
        self.assertEqual(readerapi._retry_after_seconds(None, 2), 4.0)
        self.assertEqual(readerapi._retry_after_seconds("", 3), 8.0)

    def test_backoff_is_capped(self):
        self.assertEqual(readerapi._retry_after_seconds(None, 20), readerapi.MAX_BACKOFF_S)

    def test_absurd_retry_after_is_clamped(self):
        self.assertEqual(
            readerapi._retry_after_seconds("99999", 0), readerapi.MAX_RETRY_AFTER_S
        )

    def test_garbage_header_falls_back(self):
        self.assertEqual(readerapi._retry_after_seconds("soon-ish", 1), 2.0)


class RequestRetryTests(unittest.TestCase):
    def setUp(self):
        self.slept = []
        patcher = mock.patch.object(readerapi, "_sleep", self.slept.append)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_429_is_retried_honoring_retry_after(self):
        responses = [
            http_error(429, {"Retry-After": "7"}),
            http_error(429, {"Retry-After": "1.5"}),
            FakeResponse('{"ok":true}', {"Content-Type": "application/json"}),
        ]

        def fake_urlopen(request, timeout=None):
            item = responses.pop(0)
            if isinstance(item, Exception):
                raise item
            return item

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            status, _headers, text = readerapi._request("https://readwise.io/api/v3/list/")
        self.assertEqual(status, 200)
        self.assertEqual(text, '{"ok":true}')
        self.assertEqual(self.slept, [7.0, 1.5])

    def test_429_without_header_uses_exponential_backoff(self):
        responses = [
            http_error(429),
            http_error(429),
            FakeResponse("{}", {"Content-Type": "application/json"}),
        ]

        def fake_urlopen(request, timeout=None):
            item = responses.pop(0)
            if isinstance(item, Exception):
                raise item
            return item

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            readerapi._request("https://readwise.io/api/v3/list/")
        self.assertEqual(self.slept, [1.0, 2.0])

    def test_retries_are_exhausted_and_then_raise(self):
        def fake_urlopen(request, timeout=None):
            raise http_error(429, {"Retry-After": "2"})

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            with self.assertRaises(readerapi.ReaderAPIError) as caught:
                readerapi._request("https://readwise.io/api/v3/list/", max_retries=2)
        self.assertEqual(caught.exception.status, 429)
        self.assertEqual(self.slept, [2.0, 2.0])

    def test_5xx_is_retried(self):
        responses = [http_error(503), FakeResponse("{}")]

        def fake_urlopen(request, timeout=None):
            item = responses.pop(0)
            if isinstance(item, Exception):
                raise item
            return item

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            readerapi._request("https://readwise.io/api/v3/list/")
        self.assertEqual(self.slept, [1.0])

    def test_404_raises_immediately(self):
        def fake_urlopen(request, timeout=None):
            raise http_error(404, body="nope")

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            with self.assertRaises(readerapi.ReaderAPIError) as caught:
                readerapi._request("https://readwise.io/api/v3/list/")
        self.assertEqual(caught.exception.status, 404)
        self.assertEqual(self.slept, [])

    def test_error_message_drops_the_query_string(self):
        def fake_urlopen(request, timeout=None):
            raise http_error(403)

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            with self.assertRaises(readerapi.ReaderAPIError) as caught:
                readerapi._request("https://readwise.io/api/v3/list/?id=secretish")
        self.assertNotIn("secretish", str(caught.exception))


class MutationRetryTests(unittest.TestCase):
    """A create that may already have committed must never be replayed."""

    def setUp(self):
        self.slept = []
        patcher = mock.patch.object(readerapi, "_sleep", self.slept.append)
        patcher.start()
        self.addCleanup(patcher.stop)
        readerapi.reset_mcp_state()
        readerapi.reset_pacing()
        self.addCleanup(readerapi.reset_mcp_state)
        self.addCleanup(readerapi.reset_pacing)
        env = mock.patch.dict(os.environ, {readerapi.ENV_TOKEN_VAR: DUMMY_TOKEN})
        env.start()
        self.addCleanup(env.stop)

    def _post(self, responses, **kwargs):
        calls = []

        def fake_urlopen(request, timeout=None):
            calls.append(request)
            item = responses.pop(0)
            if isinstance(item, Exception):
                raise item
            return item

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            result = readerapi._request(
                readerapi.MCP_URL, method="POST", body="{}", **kwargs
            )
        return calls, result

    def test_a_mutating_post_is_not_replayed_after_a_5xx(self):
        calls = []

        def fake_urlopen(request, timeout=None):
            calls.append(request)
            raise http_error(503)

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            with self.assertRaises(readerapi.ReaderAPIError) as caught:
                readerapi._request(readerapi.MCP_URL, method="POST", body="{}")
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.slept, [])
        self.assertIn("may already have taken effect", str(caught.exception))

    def test_a_mutating_post_is_not_replayed_after_a_transport_timeout(self):
        calls = []

        def fake_urlopen(request, timeout=None):
            calls.append(request)
            raise urllib.error.URLError(TimeoutError("timed out"))

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            with self.assertRaises(readerapi.ReaderAPIError) as caught:
                readerapi._request(readerapi.MCP_URL, method="POST", body="{}")
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.slept, [])
        self.assertIn("may already have taken effect", str(caught.exception))

    def test_a_mutating_post_is_still_retried_on_429(self):
        # The server refused before doing the work, so nothing was committed.
        calls, (status, _headers, _text) = self._post(
            [http_error(429, {"Retry-After": "2"}), FakeResponse("{}")]
        )
        self.assertEqual(len(calls), 2)
        self.assertEqual(status, 200)
        self.assertEqual(self.slept, [2.0])

    def test_a_read_carried_over_post_is_still_retried(self):
        calls, _result = self._post(
            [http_error(503), FakeResponse("{}")], mutating=False
        )
        self.assertEqual(len(calls), 2)
        self.assertEqual(self.slept, [1.0])

    def test_only_the_state_changing_tools_are_classified_as_mutating(self):
        self.assertTrue(readerapi.is_mutating_tool("reader_create_highlight"))
        self.assertTrue(readerapi.is_mutating_tool("readwise_delete_highlight"))
        self.assertFalse(readerapi.is_mutating_tool("reader_get_document_highlights"))
        self.assertFalse(readerapi.is_mutating_tool("readwise_list_highlights"))

    def test_every_known_mutating_tool_is_off_the_read_only_allowlist(self):
        for name in readerapi.MUTATING_TOOLS:
            self.assertTrue(readerapi.is_mutating_tool(name), name)

    def test_an_unknown_tool_is_classified_as_mutating(self):
        # [R5] the old membership test failed OPEN: a state-changing tool added
        # to the gateway later was replayed after an ambiguous failure.
        self.assertTrue(readerapi.is_mutating_tool("reader_invent_something_new"))

    def _tool_call_attempts(self, name, responder, **kwargs):
        """Run call_tool against a 5xx-first fake server; return tool attempts."""
        attempts = []

        def fake_urlopen(request, timeout=None):
            body = json.loads(request.data.decode("utf-8"))
            if "id" not in body:
                return FakeResponse("", {"Content-Type": "application/json"}, status=202)
            if body["method"] == "initialize":
                return FakeResponse(
                    sse({"jsonrpc": "2.0", "id": body["id"], "result": {}}),
                    {"Content-Type": "text/event-stream"},
                )
            attempts.append(body["params"]["name"])
            return responder(body, len(attempts))

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            payload = readerapi.call_tool(name, {}, **kwargs)
        return attempts, payload

    def test_an_unknown_tool_is_not_replayed_after_a_5xx(self):
        attempts = []

        def fake_urlopen(request, timeout=None):
            body = json.loads(request.data.decode("utf-8"))
            if "id" not in body:
                return FakeResponse("", {"Content-Type": "application/json"}, status=202)
            if body["method"] == "initialize":
                return FakeResponse(
                    sse({"jsonrpc": "2.0", "id": body["id"], "result": {}}),
                    {"Content-Type": "text/event-stream"},
                )
            attempts.append(body["params"]["name"])
            raise http_error(500)

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            with self.assertRaises(readerapi.ReaderAPIError) as caught:
                readerapi.call_tool("reader_invent_something_new", {})
        self.assertEqual(attempts, ["reader_invent_something_new"])
        self.assertEqual(self.slept, [])
        self.assertIn("may already have taken effect", str(caught.exception))

    def test_an_allowlisted_read_tool_is_still_replayed(self):
        def responder(body, attempt):
            if attempt == 1:
                raise http_error(503)
            return FakeResponse(
                sse({
                    "jsonrpc": "2.0",
                    "id": body["id"],
                    "result": {"content": [{"type": "text", "text": "[]"}]},
                }),
                {"Content-Type": "text/event-stream"},
            )

        attempts, payload = self._tool_call_attempts(
            "readwise_list_highlights", responder
        )
        self.assertEqual(len(attempts), 2)
        self.assertEqual(payload, [])

    def test_a_caller_may_declare_an_unknown_tool_replay_safe(self):
        def responder(body, attempt):
            if attempt == 1:
                raise http_error(503)
            return FakeResponse(
                sse({
                    "jsonrpc": "2.0",
                    "id": body["id"],
                    "result": {"content": [{"type": "text", "text": "[]"}]},
                }),
                {"Content-Type": "text/event-stream"},
            )

        attempts, payload = self._tool_call_attempts(
            "reader_invent_something_new", responder, mutating=False
        )
        self.assertEqual(len(attempts), 2)
        self.assertEqual(payload, [])

    def test_a_create_tool_call_reaches_the_transport_as_a_mutation(self):
        attempts = []

        def fake_urlopen(request, timeout=None):
            body = json.loads(request.data.decode("utf-8"))
            if "id" not in body:
                return FakeResponse("", {"Content-Type": "application/json"}, status=202)
            if body["method"] == "initialize":
                return FakeResponse(
                    sse({"jsonrpc": "2.0", "id": body["id"], "result": {}}),
                    {"Content-Type": "text/event-stream"},
                )
            attempts.append(body["params"]["name"])
            raise http_error(500)

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            with self.assertRaises(readerapi.ReaderAPIError):
                readerapi.create_highlight(
                    "doc-1", "<p>a</p>", tags=["daystrom-claim"]
                )
        self.assertEqual(attempts, ["reader_create_highlight"])

    def test_a_read_tool_call_is_still_replayed(self):
        attempts = []

        def fake_urlopen(request, timeout=None):
            body = json.loads(request.data.decode("utf-8"))
            if "id" not in body:
                return FakeResponse("", {"Content-Type": "application/json"}, status=202)
            if body["method"] == "initialize":
                return FakeResponse(
                    sse({"jsonrpc": "2.0", "id": body["id"], "result": {}}),
                    {"Content-Type": "text/event-stream"},
                )
            attempts.append(body["params"]["name"])
            if len(attempts) == 1:
                raise http_error(503)
            return FakeResponse(
                sse({
                    "jsonrpc": "2.0",
                    "id": body["id"],
                    "result": {"content": [{"type": "text", "text": "[]"}]},
                }),
                {"Content-Type": "text/event-stream"},
            )

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            payload = readerapi.get_document_highlights("doc-1")
        self.assertEqual(payload, [])
        self.assertEqual(len(attempts), 2)


class ResponseReadFailureTests(unittest.TestCase):
    """A body that dies mid-read is a transport failure, not an escape hatch."""

    def setUp(self):
        self.slept = []
        patcher = mock.patch.object(readerapi, "_sleep", self.slept.append)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _breaking_response(self, error):
        class BreakingResponse(FakeResponse):
            def read(self):
                raise error

        return BreakingResponse("", {"Content-Type": "application/json"})

    def test_a_read_timeout_on_a_get_is_retried_then_succeeds(self):
        responses = [
            self._breaking_response(TimeoutError("timed out")),
            self._breaking_response(TimeoutError("timed out")),
            FakeResponse('{"ok":true}', {"Content-Type": "application/json"}),
        ]

        def fake_urlopen(request, timeout=None):
            return responses.pop(0)

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            status, _headers, text = readerapi._request(
                "https://readwise.io/api/v3/list/"
            )
        self.assertEqual(status, 200)
        self.assertEqual(text, '{"ok":true}')
        self.assertEqual(self.slept, [1.0, 2.0])

    def test_an_incomplete_read_is_wrapped_once_retries_run_out(self):
        def fake_urlopen(request, timeout=None):
            return self._breaking_response(http.client.IncompleteRead(b"partial"))

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            with self.assertRaises(readerapi.ReaderAPIError) as caught:
                readerapi._request("https://readwise.io/api/v3/list/", max_retries=1)
        self.assertIn("Network error", str(caught.exception))
        self.assertEqual(len(self.slept), 1)

    def test_a_read_timeout_on_a_mutation_is_wrapped_not_replayed(self):
        calls = []

        def fake_urlopen(request, timeout=None):
            calls.append(request)
            return self._breaking_response(TimeoutError("timed out"))

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            with self.assertRaises(readerapi.ReaderAPIError) as caught:
                readerapi._request(readerapi.MCP_URL, method="POST", body="{}")
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.slept, [])
        self.assertIn("may already have taken effect", str(caught.exception))


# --------------------------------------------------------------------------


class PacingTests(unittest.TestCase):
    def setUp(self):
        readerapi.reset_pacing()
        readerapi.reset_mcp_state()
        self.addCleanup(readerapi.reset_pacing)

    def test_first_call_never_waits(self):
        self.assertEqual(readerapi._pace_wait_seconds(None, 1000.0), 0.0)

    def test_wait_is_the_remainder_of_the_interval(self):
        self.assertAlmostEqual(readerapi._pace_wait_seconds(100.0, 101.0), 2.5)
        self.assertAlmostEqual(readerapi._pace_wait_seconds(100.0, 100.0), 3.5)

    def test_no_wait_once_the_interval_has_elapsed(self):
        self.assertEqual(readerapi._pace_wait_seconds(100.0, 103.5), 0.0)
        self.assertEqual(readerapi._pace_wait_seconds(100.0, 200.0), 0.0)

    def test_interval_is_below_the_20_per_minute_ceiling(self):
        self.assertGreaterEqual(readerapi.MIN_CREATE_INTERVAL_S * 20, 60.0)

    def test_consecutive_creates_are_paced(self):
        slept = []
        clock = iter([100.0, 100.0, 101.0, 103.5])
        with mock.patch.object(readerapi, "_sleep", slept.append), \
                mock.patch.object(readerapi.time, "monotonic", lambda: next(clock)), \
                mock.patch.object(readerapi, "call_tool", return_value={"id": "x"}):
            readerapi.create_highlight("doc", "<p>a</p>")
            readerapi.create_highlight("doc", "<p>b</p>")
        self.assertEqual(slept, [2.5])


# --------------------------------------------------------------------------


class FakeMcpServer:
    """Canned MCP endpoint: records every JSON-RPC body it receives."""

    def __init__(self, tool_payload=None):
        self.bodies = []
        self.requests = []
        self.tool_payload = tool_payload if tool_payload is not None else {"ok": True}

    def __call__(self, request, timeout=None):
        body = json.loads(request.data.decode("utf-8"))
        self.bodies.append(body)
        self.requests.append(request)
        if "id" not in body:
            return FakeResponse("", {"Content-Type": "application/json"}, status=202)
        if body["method"] == "initialize":
            result = {
                "protocolVersion": readerapi.MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "serverInfo": {"name": "readwise"},
            }
        else:
            result = {
                "content": [{"type": "text", "text": json.dumps(self.tool_payload)}]
            }
        return FakeResponse(
            sse({"jsonrpc": "2.0", "id": body["id"], "result": result}),
            {"Content-Type": "text/event-stream"},
        )

    def methods(self):
        return [b["method"] for b in self.bodies]

    def headers_of(self, index):
        return {k.lower(): v for k, v in self.requests[index].header_items()}


class McpTests(unittest.TestCase):
    def setUp(self):
        readerapi.reset_mcp_state()
        readerapi.reset_pacing()
        self.addCleanup(readerapi.reset_mcp_state)
        self.addCleanup(readerapi.reset_pacing)
        patcher = mock.patch.dict(
            os.environ, {readerapi.ENV_TOKEN_VAR: DUMMY_TOKEN}
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_handshake_runs_once_per_process(self):
        server = FakeMcpServer()
        with mock.patch("urllib.request.urlopen", server):
            readerapi.call_tool("reader_get_document_highlights", {"document_id": "d"})
            readerapi.call_tool("reader_get_document_highlights", {"document_id": "d"})
        self.assertEqual(
            server.methods(),
            [
                "initialize",
                "notifications/initialized",
                "tools/call",
                "tools/call",
            ],
        )

    def test_required_headers_are_present(self):
        server = FakeMcpServer()
        with mock.patch("urllib.request.urlopen", server):
            readerapi.call_tool("reader_get_document_highlights", {"document_id": "d"})
        headers = server.headers_of(0)
        # Without a browser UA, Cloudflare 403s the MCP endpoint.
        self.assertEqual(headers["user-agent"], readerapi.USER_AGENT)
        self.assertEqual(headers["accept"], "application/json, text/event-stream")
        self.assertEqual(headers["content-type"], "application/json")
        self.assertEqual(headers["authorization"], "Token %s" % DUMMY_TOKEN)
        self.assertEqual(server.requests[0].full_url, readerapi.MCP_URL)

    def test_initialize_sends_the_pinned_protocol_version(self):
        server = FakeMcpServer()
        with mock.patch("urllib.request.urlopen", server):
            readerapi.call_tool("tools/noop", {})
        self.assertEqual(
            server.bodies[0]["params"]["protocolVersion"],
            readerapi.MCP_PROTOCOL_VERSION,
        )
        self.assertEqual(server.bodies[0]["jsonrpc"], "2.0")
        self.assertNotIn("id", server.bodies[1])

    def test_create_highlight_shape_and_result(self):
        server = FakeMcpServer(
            {
                "id": "01hz",
                "location": "0.42",
                "url": "https://read.readwise.io/read/01hz",
            }
        )
        with mock.patch("urllib.request.urlopen", server), \
                mock.patch.object(readerapi, "_sleep", lambda s: None):
            result = readerapi.create_highlight(
                "doc-1", '<p id="b7">verbatim</p>', note="stance", tags=["daystrom-claim"]
            )
        call = server.bodies[-1]
        self.assertEqual(call["method"], "tools/call")
        self.assertEqual(call["params"]["name"], "reader_create_highlight")
        self.assertEqual(
            call["params"]["arguments"],
            {
                "document_id": "doc-1",
                "html_content": '<p id="b7">verbatim</p>',
                "note": "stance",
                "tags": ["daystrom-claim"],
            },
        )
        self.assertEqual(result["url"], "https://read.readwise.io/read/01hz")

    def test_create_highlight_omits_empty_optionals(self):
        server = FakeMcpServer({"id": "x"})
        with mock.patch("urllib.request.urlopen", server), \
                mock.patch.object(readerapi, "_sleep", lambda s: None):
            readerapi.create_highlight("doc-1", "<p>a</p>")
        arguments = server.bodies[-1]["params"]["arguments"]
        self.assertEqual(set(arguments), {"document_id", "html_content"})

    def test_classic_delete_uses_integer_id(self):
        server = FakeMcpServer({"deleted": True})
        with mock.patch("urllib.request.urlopen", server):
            readerapi.delete_classic_highlight("12345")
        call = server.bodies[-1]["params"]
        self.assertEqual(call["name"], "readwise_delete_highlight")
        self.assertEqual(call["arguments"], {"highlight_id": 12345})

    def test_classic_list_passes_page_size(self):
        server = FakeMcpServer({"results": []})
        with mock.patch("urllib.request.urlopen", server):
            readerapi.list_classic_highlights(page_size=5)
        self.assertEqual(
            server.bodies[-1]["params"]["arguments"], {"page_size": 5}
        )

    def test_tag_and_note_helpers(self):
        server = FakeMcpServer({"ok": True})
        with mock.patch("urllib.request.urlopen", server):
            readerapi.add_tags_to_highlight("h1", ["daystrom-claim"])
            readerapi.remove_tags_from_highlight("h1", ["daystrom-claim"])
            readerapi.set_highlight_notes("h1", "note text")
            readerapi.get_document_highlights("d1")
        names = [b["params"]["name"] for b in server.bodies if b.get("method") == "tools/call"]
        self.assertEqual(
            names,
            [
                "reader_add_tags_to_highlight",
                "reader_remove_tags_from_highlight",
                "reader_set_highlight_notes",
                "reader_get_document_highlights",
            ],
        )

    def test_jsonrpc_error_frame_raises(self):
        def fake_urlopen(request, timeout=None):
            body = json.loads(request.data.decode("utf-8"))
            if "id" not in body:
                return FakeResponse("", status=202)
            if body["method"] == "initialize":
                return FakeResponse(
                    sse({"jsonrpc": "2.0", "id": body["id"], "result": {}}),
                    {"Content-Type": "text/event-stream"},
                )
            return FakeResponse(
                sse({
                    "jsonrpc": "2.0",
                    "id": body["id"],
                    "error": {"code": -32602, "message": "bad args"},
                }),
                {"Content-Type": "text/event-stream"},
            )

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            with self.assertRaises(readerapi.ReaderAPIError) as caught:
                readerapi.call_tool("reader_create_highlight", {})
        self.assertIn("bad args", str(caught.exception))

    def test_missing_matching_frame_raises(self):
        def fake_urlopen(request, timeout=None):
            return FakeResponse(
                sse({"jsonrpc": "2.0", "id": 999, "result": {}}),
                {"Content-Type": "text/event-stream"},
            )

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            with self.assertRaises(readerapi.ReaderAPIError) as caught:
                readerapi.call_tool("whatever", {})
        self.assertIn("No JSON-RPC frame", str(caught.exception))


class ToolResultTests(unittest.TestCase):
    def test_json_text_content_is_decoded(self):
        result = {"content": [{"type": "text", "text": '{"id":"abc"}'}]}
        self.assertEqual(readerapi.tool_result_payload(result), {"id": "abc"})

    def test_plain_text_content_passes_through(self):
        result = {"content": [{"type": "text", "text": "just words"}]}
        self.assertEqual(readerapi.tool_result_payload(result), "just words")

    def test_structured_content_preferred(self):
        result = {"structuredContent": {"a": 1}, "content": [{"type": "text", "text": "x"}]}
        self.assertEqual(readerapi.tool_result_payload(result), {"a": 1})

    def test_is_error_raises(self):
        result = {"isError": True, "content": [{"type": "text", "text": "no such doc"}]}
        with self.assertRaises(readerapi.ReaderAPIError) as caught:
            readerapi.tool_result_payload(result)
        self.assertIn("no such doc", str(caught.exception))


# --------------------------------------------------------------------------


class RestTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.dict(os.environ, {readerapi.ENV_TOKEN_VAR: DUMMY_TOKEN})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_get_document_with_html(self):
        seen = {}

        def fake_urlopen(request, timeout=None):
            seen["url"] = request.full_url
            seen["headers"] = {k.lower(): v for k, v in request.header_items()}
            seen["timeout"] = timeout
            return FakeResponse(
                json.dumps({"results": [{"id": "d1", "html_content": "<p>x</p>"}]}),
                {"Content-Type": "application/json"},
            )

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            document = readerapi.get_document("d1", with_html=True)
        self.assertEqual(document["html_content"], "<p>x</p>")
        self.assertIn("id=d1", seen["url"])
        self.assertIn("withHtmlContent=true", seen["url"])
        self.assertEqual(seen["headers"]["authorization"], "Token %s" % DUMMY_TOKEN)
        self.assertEqual(seen["timeout"], readerapi.HTML_TIMEOUT)

    def test_get_document_without_html_omits_the_flag(self):
        seen = {}

        def fake_urlopen(request, timeout=None):
            seen["url"] = request.full_url
            return FakeResponse(json.dumps({"results": [{"id": "d1"}]}))

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            readerapi.get_document("d1")
        self.assertNotIn("withHtmlContent", seen["url"])

    def test_get_document_missing_returns_none(self):
        with mock.patch(
            "urllib.request.urlopen",
            lambda request, timeout=None: FakeResponse(json.dumps({"results": []})),
        ):
            self.assertIsNone(readerapi.get_document("nope"))

    def test_find_documents_paginates_and_filters_by_title(self):
        pages = [
            {
                "results": [
                    {"id": "1", "title": "The Wine-Dark Sea"},
                    {"id": "2", "title": "Something Else"},
                ],
                "nextPageCursor": "cursor-2",
            },
            {
                "results": [{"id": "3", "title": "wine tasting notes"}],
                "nextPageCursor": None,
            },
        ]
        urls = []

        def fake_urlopen(request, timeout=None):
            urls.append(request.full_url)
            return FakeResponse(json.dumps(pages[len(urls) - 1]))

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            found = readerapi.find_documents(title_substring="wine", category="epub")
        self.assertEqual([d["id"] for d in found], ["1", "3"])
        self.assertEqual(len(urls), 2)
        self.assertIn("category=epub", urls[0])
        self.assertNotIn("pageCursor", urls[0])
        self.assertIn("pageCursor=cursor-2", urls[1])

    def test_find_documents_without_filter_returns_everything(self):
        page = {"results": [{"id": "1", "title": "a"}, {"id": "2", "title": "b"}]}
        with mock.patch(
            "urllib.request.urlopen",
            lambda request, timeout=None: FakeResponse(json.dumps(page)),
        ):
            self.assertEqual(len(readerapi.find_documents()), 2)

    def test_non_json_body_raises(self):
        with mock.patch(
            "urllib.request.urlopen",
            lambda request, timeout=None: FakeResponse("<html>maintenance</html>"),
        ):
            with self.assertRaises(readerapi.ReaderAPIError):
                readerapi.get_document("d1")


if __name__ == "__main__":
    unittest.main()
