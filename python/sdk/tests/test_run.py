"""Unified blocking input, native command results and independent run observation."""
from __future__ import annotations

import json
import sys
import threading
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

import pytest
from pydantic import BaseModel, ValidationError

from deepseek_harness.models import CommandExecution
from deepseek_harness import DeepSeekHarness, Notification, RunResult, SdkProtocolError
from deepseek_harness.errors import JsonRpcError


class Ack(BaseModel):
    pass


@pytest.fixture
def peer(tmp_path: Path) -> Path:
    script = tmp_path / "queries.py"
    script.write_text('''import json
import os
import sys

serial = 0
pending_commands = []
pending_prompts = []
pending_plans = []

def send(frame):
    print(json.dumps({"jsonrpc": "2.0", **frame}), flush=True)

def event(session, type, data):
    send({"method": "session.event", "params": {"sessionId": session, "event": {"type": type, "data": data}}})

def input_text(frame):
    return "".join(block["text"] for block in frame["params"]["contentBlocks"] if block["type"] == "text")

def command(frame, number):
    session = frame["params"]["sessionId"]
    identity = "command-" + str(number)
    event(session, "command/run", {"commandId": identity})
    event(session, "command/done", {"commandId": identity, "kind": "success"})
    send({"method": "session.query.completed", "params": {"sessionId": session, "commandId": identity,
        "finalResponse": "command completed", "finishReason": "completed"}})
    send({"id": frame["id"], "result": {"kind": "command", "execution": {
        "commandId": identity, "result": {"kind": "success", "text": "command completed"}}}})

def receipt(frame, number):
    session = frame["params"]["sessionId"]
    send({"method": "session.status", "params": {"sessionId": session, "status": "idle"}})
    event(session, "agent/inbox/spliced", {"inserted": [{"id": "input-" + str(number)}]})

def finish(frame):
    session = frame["params"]["sessionId"]
    event(session, "assistant/message", {"message": {"content": [
        {"type": "text", "text": "answer for " + input_text(frame)}]}})
    event(session, "turn/end", {"turn": 1, "reason": {"kind": "completed"}})
    send({"method": "session.status", "params": {"sessionId": session, "status": "idle"}})

for line in sys.stdin:
    frame = json.loads(line)
    with open(os.environ["REQUEST_LOG"], "a", encoding="utf-8") as log:
        log.write(line)
    method = frame["method"]
    if method == "initialize":
        send({"id": frame["id"], "result": {"serverInfo": {"name": "query-peer"}}})
    elif method == "session/prompt":
        send({"id": frame["id"], "result": {"messageId": "literal-input"}})
    elif method == "session/query":
        serial += 1
        params = frame["params"]
        assert set(params) == {"sessionId", "contentBlocks"}
        text = input_text(frame)
        if text == "/plan hold":
            identity = "plan-" + str(serial)
            event(params["sessionId"], "command/run", {"commandId": identity})
            event(params["sessionId"], "command/done", {"commandId": identity, "kind": "success"})
            send({"id": frame["id"], "result": {"kind": "command", "execution": {
                "commandId": identity, "result": {"kind": "success", "text": "Plan enabled"}}}})
            pending_plans.append((frame, identity))
        elif text == "hold-command":
            pending_commands.append((frame, serial))
        elif text in ("/compact", "/plan Describe this image."):
            command(frame, serial)
        elif text in ("missing-run", "missing-done", "missing-both", "unrelated-done", "invalid-done"):
            if text not in ("missing-run", "missing-both"):
                event(params["sessionId"], "command/run", {"commandId": "silent"})
            if text == "invalid-done":
                event(params["sessionId"], "command/done", None)
            elif text not in ("missing-done", "missing-both"):
                event(params["sessionId"], "command/done", {
                    "commandId": "another-command" if text == "unrelated-done" else "silent", "kind": "success"})
            send({"method": "session.query.completed", "params": {"sessionId": params["sessionId"],
                "commandId": "silent", "finalResponse": "", "finishReason": "completed"}})
            send({"id": frame["id"], "result": {"kind": "command", "execution": {
                "commandId": "silent", "result": {"kind": "success"}}}})
        elif text == "rpc-error":
            send({"id": frame["id"], "error": {"code": -32602, "message": "query rejected"}})
        elif text == "custom-response":
            response = json.loads(os.environ["QUERY_RESPONSE"])
            execution = response.get("execution") if isinstance(response, dict) else None
            if isinstance(execution, dict) and isinstance(execution.get("result"), dict):
                event(params["sessionId"], "command/run", {"commandId": execution.get("commandId")})
                if os.environ.get("QUERY_LIFECYCLE") != "late-done":
                    event(params["sessionId"], "command/done", {"commandId": execution.get("commandId"), **execution["result"]})
                send({"method": "session.query.completed", "params": {"sessionId": params["sessionId"],
                    "commandId": execution.get("commandId"), "finalResponse": execution["result"].get("text", ""),
                    "finishReason": "error" if execution["result"].get("kind") == "error" else "completed",
                    **json.loads(os.environ.get("QUERY_COMPLETION", "{}"))}})
                if os.environ.get("QUERY_LIFECYCLE") == "late-done":
                    event(params["sessionId"], "command/done", {"commandId": execution.get("commandId"), **execution["result"]})
            send({"id": frame["id"], "result": response})
        elif text == "bad-route":
            send({"id": frame["id"], "result": {"kind": "unknown"}})
        elif text == "bad-execution":
            send({"id": frame["id"], "result": {"kind": "command", "execution": {"commandId": "c"}}})
        else:
            result = {"kind": "prompt", "messageId": "input-" + str(serial)}
            if text == "fast-prompt":
                receipt(frame, serial)
                finish(frame)
                send({"id": frame["id"], "result": result})
            else:
                send({"id": frame["id"], "result": result})
                receipt(frame, serial)
                if text == "hold-prompt":
                    pending_prompts.append(frame)
                else:
                    finish(frame)
    elif method == "release":
        for original, identity in pending_plans:
            finish(original)
            send({"method": "session.query.completed", "params": {"sessionId": original["params"]["sessionId"],
                "commandId": identity, "finalResponse": "Generated plan", "finishReason": "completed"}})
        pending_plans.clear()
        for original, number in pending_commands:
            command(original, number)
        pending_commands.clear()
        for original in pending_prompts:
            finish(original)
        pending_prompts.clear()
        send({"id": frame["id"], "result": {}})
    elif method == "barrier":
        send({"id": frame["id"], "result": {}})
    elif method == "disconnect":
        send({"id": frame["id"], "result": {}})
        break
    elif method == "shutdown":
        send({"id": frame["id"], "result": {}})
        break
    else:
        raise AssertionError(method)
''', encoding="utf-8")
    return script


@pytest.fixture
def sdk(peer: Path, tmp_path: Path):
    with DeepSeekHarness(
        cwd=str(tmp_path), dsh_home=str(tmp_path / "home"), request_timeout_seconds=5,
        _launch_args=(sys.executable, str(peer)),
        env={"REQUEST_LOG": str(tmp_path / "requests.jsonl")},
    ) as harness:
        yield harness


def release(sdk: DeepSeekHarness) -> None:
    sdk.client.request("release", {}, response_model=Ack, timeout_seconds=5)


def assert_released(sdk: DeepSeekHarness) -> None:
    assert sdk.client._responses == {}
    assert sdk.client._notification_subscribers == {}


@pytest.mark.parametrize("entry", ["session", "harness"])
def test_run_returns_command_without_waiting_for_idle(sdk: DeepSeekHarness, entry: str) -> None:
    notifications = []
    result = (sdk.run("/compact", session_id="main", on_notification=notifications.append)
              if entry == "harness" else sdk.start_session("main").run("/compact", on_notification=notifications.append))
    assert isinstance(result, RunResult)
    assert isinstance(result, RunResult)
    assert result.session_id == "main"
    assert result.finish_reason == "completed"
    assert [notice.payload["event"]["type"] for notice in notifications if notice.method == "session.event"] == ["command/run", "command/done"]
    assert_released(sdk)


def test_top_level_command_results_identify_distinct_sessions_and_allow_continuing_one(
    sdk: DeepSeekHarness, tmp_path: Path,
) -> None:
    first = sdk.run("/compact")
    second = sdk.run("/compact")
    assert isinstance(first, RunResult) and isinstance(second, RunResult)
    assert first.session_id and second.session_id and first.session_id != second.session_id
    continued = sdk.run("continue the first session", session_id=first.session_id)
    assert isinstance(continued, RunResult)
    assert continued.session_id == first.session_id
    sent = [json.loads(line) for line in (tmp_path / "requests.jsonl").read_text(encoding="utf-8").splitlines()]
    queries = [frame["params"] for frame in sent if frame["method"] == "session/query"]
    assert [query["sessionId"] for query in queries] == [first.session_id, second.session_id, first.session_id]
    assert_released(sdk)


@pytest.mark.parametrize("result", [
    {"kind": "success"},
    {"kind": "success", "text": "Compacted.", "sourceEventSeq": 0},
    {"kind": "success", "sourceEventSeq": 2**53 - 1},
    {"kind": "error", "text": "The agent is busy."},
])
def test_run_adds_session_identity_without_changing_command_results(peer: Path, tmp_path: Path, result: dict) -> None:
    execution = {"commandId": "custom-command", "result": result}
    with DeepSeekHarness(
        cwd=str(tmp_path), dsh_home=str(tmp_path / "home"), request_timeout_seconds=5,
        _launch_args=(sys.executable, str(peer)),
        env={"REQUEST_LOG": str(tmp_path / "requests.jsonl"), "QUERY_RESPONSE": json.dumps({
            "kind": "command", "execution": execution,
        })},
    ) as sdk:
        returned = sdk.run("custom-response")
        assert isinstance(returned, RunResult)
        assert returned.session_id
        assert returned.final_response == result.get("text", "")
        assert returned.finish_reason == ("error" if result["kind"] == "error" else "completed")
        low_level = sdk.client._query(returned.session_id, "custom-response")
        assert isinstance(low_level, CommandExecution)
        assert low_level.model_dump(by_alias=True, exclude_none=True) == execution
        assert_released(sdk)


@pytest.mark.parametrize("text", ["ordinary", "fast-prompt", "/model", " /compact extra "])
def test_run_preserves_ordinary_text_and_result(sdk: DeepSeekHarness, text: str) -> None:
    notifications = []
    result = sdk.start_session("main").run(text, on_notification=notifications.append)
    assert isinstance(result, RunResult)
    assert result.final_response == "answer for " + text
    assert result.finish_reason == "completed"
    assert result.notifications == notifications
    assert notifications[0].payload["event"]["type"] == "agent/inbox/spliced"
    assert_released(sdk)


@pytest.mark.parametrize("entry,text", [
    ("harness", "/plan Describe this image."),
    ("session", "/plan Describe this image."),
    ("harness", "Explain this image."),
    ("session", "/unknown-slash"),
    ("session", ""),
])
def test_run_forwards_content_blocks_with_the_routed_result_and_notifications(
    sdk: DeepSeekHarness, tmp_path: Path, entry: str, text: str,
) -> None:
    blocks = [
        {"type": "text", "text": text},
        {"type": "image", "data": "AQ==", "mimeType": "image/png", "name": "diagram.png"},
    ]
    notifications = []
    result = (
        sdk.run(blocks, session_id="main", on_notification=notifications.append)
        if entry == "harness" else sdk.start_session("main").run(
            blocks, on_notification=notifications.append,
        )
    )
    if text == "/plan Describe this image.":
        assert isinstance(result, RunResult)
        assert [notice.payload["event"]["type"] for notice in notifications if notice.method == "session.event"] == ["command/run", "command/done"]
    else:
        assert isinstance(result, RunResult)
        assert result.final_response == "answer for " + text
        assert result.notifications == notifications
    sent = [json.loads(line) for line in (tmp_path / "requests.jsonl").read_text(encoding="utf-8").splitlines()]
    assert sent[-1]["method"] == "session/query"
    assert sent[-1]["params"] == {
        "sessionId": "main", "contentBlocks": blocks,
    }
    assert_released(sdk)


def test_run_normalizes_strings_without_changing_their_text(sdk: DeepSeekHarness, tmp_path: Path) -> None:
    result = sdk.run("  preserve whitespace  ", session_id="main")
    assert isinstance(result, RunResult)
    sent = [json.loads(line) for line in (tmp_path / "requests.jsonl").read_text(encoding="utf-8").splitlines()]
    assert sent[-1]["params"] == {
        "sessionId": "main", "contentBlocks": [{"type": "text", "text": "  preserve whitespace  "}],
    }


def test_concurrent_runs_keep_their_own_results(sdk: DeepSeekHarness) -> None:
    session = sdk.start_session("main")
    entered = threading.Event()
    with ThreadPoolExecutor(max_workers=2) as workers:
        first = workers.submit(session.run, "hold-prompt", on_notification=lambda notice: entered.set())
        try:
            assert entered.wait(5), "the first run must observe its receipt"
            second = workers.submit(session.run, "/compact")
            assert isinstance(second.result(timeout=5), RunResult)
        finally:
            release(sdk)
        result = first.result(timeout=5)
    assert isinstance(result, RunResult)
    assert result.final_response == "answer for hold-prompt"
    assert_released(sdk)


@pytest.mark.parametrize("text", ["missing-run", "missing-done", "missing-both", "unrelated-done", "invalid-done"])
def test_command_result_rejects_incomplete_lifecycle(sdk: DeepSeekHarness, text: str) -> None:
    session = sdk.start_session("main")
    with pytest.raises(SdkProtocolError, match="lifecycle"):
        session.run(text)
    assert_released(sdk)
    assert session.run("after").final_response == "answer for after"
    assert_released(sdk)


def test_failure_completion_can_precede_handler_settlement(peer: Path, tmp_path: Path) -> None:
    with DeepSeekHarness(
        cwd=str(tmp_path), dsh_home=str(tmp_path / "home"), request_timeout_seconds=5,
        _launch_args=(sys.executable, str(peer)),
        env={"REQUEST_LOG": str(tmp_path / "requests.jsonl"), "QUERY_LIFECYCLE": "late-done",
             "QUERY_RESPONSE": json.dumps({"kind": "command", "execution": {
                 "commandId": "early-failure", "result": {"kind": "success"}}}),
             "QUERY_COMPLETION": json.dumps({"finalResponse": "goal service unloaded", "finishReason": "error"})},
    ) as sdk:
        result = sdk.start_session("main").run("custom-response")
        assert result.final_response == "goal service unloaded" and result.finish_reason == "error"
        assert [event["type"] for event in result.events] == ["command/run", "command/done"]
        assert_released(sdk)


@pytest.mark.parametrize("text,error", [("rpc-error", JsonRpcError), ("bad-route", SdkProtocolError), ("bad-execution", SdkProtocolError)])
def test_run_reports_routing_failures_without_retry(sdk: DeepSeekHarness, text: str, error: type[Exception]) -> None:
    session = sdk.start_session("main")
    with pytest.raises(error):
        session.run(text)
    assert_released(sdk)
    assert isinstance(session.run("/compact"), RunResult)


@pytest.mark.parametrize("text", ["ordinary", "/compact"])
def test_observer_error_releases_run_subscription(sdk: DeepSeekHarness, text: str) -> None:
    def reject(_notice: Notification) -> None:
        raise RuntimeError("observer failed")
    with pytest.raises(RuntimeError, match="observer failed"):
        sdk.start_session("main").run(text, on_notification=reject)
    assert_released(sdk)
    assert isinstance(sdk.start_session("main").run("after observer"), RunResult)


def test_command_timeout_keeps_runtime_responsive(sdk: DeepSeekHarness) -> None:
    sdk.client.config.request_timeout_seconds = 0.05
    with pytest.raises(TimeoutError, match="session/query timed out"):
        sdk.start_session("main").run("hold-command")
    sdk.client.config.request_timeout_seconds = 5
    assert_released(sdk)
    release(sdk)
    assert isinstance(sdk.start_session("main").run("/compact"), RunResult)


@pytest.mark.parametrize("response", [
    None, [], {"kind": "unknown"}, {"kind": "prompt"}, {"kind": "prompt", "messageId": ""},
    {"kind": "prompt", "messageId": 4},
    {"kind": "command", "execution": {"commandId": "c"}},
    {"kind": "command", "execution": {"commandId": "c", "result": {"kind": "success", "sourceEventSeq": True}}},
])
def test_run_rejects_invalid_routing_responses_as_protocol_errors(peer: Path, tmp_path: Path, response: object) -> None:
    with DeepSeekHarness(
        cwd=str(tmp_path), dsh_home=str(tmp_path / "home"), request_timeout_seconds=5,
        _launch_args=(sys.executable, str(peer)),
        env={"REQUEST_LOG": str(tmp_path / "requests.jsonl"), "QUERY_RESPONSE": json.dumps(response)},
    ) as sdk:
        with pytest.raises(SdkProtocolError) as raised:
            sdk.start_session("main").run("custom-response")
        if isinstance(response, dict) and response.get("kind") == "command":
            assert isinstance(raised.value.__cause__, ValidationError)
        assert_released(sdk)
        assert isinstance(sdk.start_session("main").run("/compact"), RunResult)


def test_plan_run_waits_for_model_output_after_the_command_receipt(sdk: DeepSeekHarness) -> None:
    admitted = threading.Event()
    session = sdk.start_session("plan")
    def observe(notice: Notification) -> None:
        if notice.method == "session.event" and notice.payload["event"]["type"] == "command/done":
            admitted.set()
    with ThreadPoolExecutor(max_workers=1) as workers:
        running = workers.submit(session.run, "/plan hold", on_notification=observe)
        try:
            assert admitted.wait(5)
            assert not running.done()
        finally:
            release(sdk)
        result = running.result(timeout=5)
    assert isinstance(result, RunResult)
    assert result.final_response == "Generated plan" and result.finish_reason == "completed"
    assert_released(sdk)


@pytest.mark.parametrize("completion", [{"commandId": None}, {"finalResponse": 1}, {"finishReason": None}, {"finishReason": ""}])
def test_run_rejects_malformed_completion_and_releases_its_subscription(
    peer: Path, tmp_path: Path, completion: dict,
) -> None:
    with DeepSeekHarness(
        cwd=str(tmp_path), dsh_home=str(tmp_path / "home"),
        _launch_args=(sys.executable, str(peer)),
        env={"REQUEST_LOG": str(tmp_path / "requests.jsonl"),
             "QUERY_COMPLETION": json.dumps(completion),
             "QUERY_RESPONSE": json.dumps({"kind": "command", "execution": {
                 "commandId": "c", "result": {"kind": "success"}}})},
    ) as sdk:
        with pytest.raises(SdkProtocolError):
            sdk.run("custom-response")
        assert_released(sdk)


@pytest.mark.parametrize("execution", [
    {},
    {"commandId": "command-1"},
    {"commandId": "", "result": {"kind": "success"}},
    {"commandId": "command-1", "result": {"kind": "unknown"}},
    {"commandId": "command-1", "result": {"kind": "error"}},
    {"commandId": "command-1", "result": {"kind": "error", "text": ""}},
    {"commandId": "command-1", "result": {"kind": "error", "text": " \t\n"}},
    {"commandId": "command-1", "result": {"kind": "success", "text": None}},
    {"commandId": "command-1", "result": {"kind": "success", "sourceEventSeq": None}},
    {"commandId": "command-1", "result": {"kind": "success", "sourceEventSeq": "4"}},
    {"commandId": "command-1", "result": {"kind": "success", "sourceEventSeq": True}},
    {"commandId": "command-1", "result": {"kind": "success", "sourceEventSeq": -1}},
    {"commandId": "command-1", "result": {"kind": "success", "sourceEventSeq": 2**53}},
])
def test_run_rejects_malformed_native_results(peer: Path, tmp_path: Path, execution: dict) -> None:
    with DeepSeekHarness(
        cwd=str(tmp_path), dsh_home=str(tmp_path / "home"),
        _launch_args=(sys.executable, str(peer)),
        env={"REQUEST_LOG": str(tmp_path / "requests.jsonl"), "QUERY_RESPONSE": json.dumps({
            "kind": "command", "execution": execution,
        })},
    ) as sdk:
        with pytest.raises(SdkProtocolError) as raised:
            sdk.run("custom-response")
        assert isinstance(raised.value.__cause__, ValidationError)
        assert_released(sdk)


def test_low_level_prompt_keeps_slash_text_as_an_ordinary_prompt(sdk: DeepSeekHarness, tmp_path: Path) -> None:
    blocks = [{"type": "text", "text": "/compact"}]
    assert sdk.client.session_prompt("main", blocks) == "literal-input"
    sent = [json.loads(line) for line in (tmp_path / "requests.jsonl").read_text(encoding="utf-8").splitlines()]
    assert sent[-1]["method"] == "session/prompt"
    assert sent[-1]["params"] == {"sessionId": "main", "contentBlocks": blocks}
