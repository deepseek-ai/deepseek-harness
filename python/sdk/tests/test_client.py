from __future__ import annotations

import json
import inspect
import sys
import threading
import time
from pathlib import Path

import pytest

from deepseek_harness import DeepSeekHarness, HarnessClient, HarnessConfig, Notification, RunResult, SdkProtocolError
from deepseek_harness.errors import JsonRpcError


def test_high_level_sdk_runs_turn_and_preserves_auto_review_errors(tmp_path: Path) -> None:
    script = tmp_path / "fake_runtime.py"
    env_dump = tmp_path / "env.json"
    init_dump = tmp_path / "init.json"
    script.write_text(
        """
import json
import os
import sys

env_dump = os.environ["ENV_DUMP"]
json.dump({
    "DEEPSEEK_API_KEY": os.environ.get("DEEPSEEK_API_KEY"),
    "DEEPSEEK_BASE_URL": os.environ.get("DEEPSEEK_BASE_URL"),
    "DSH_CWD": os.environ.get("DSH_CWD"),
    "DSH_SESSION_ROOT": os.environ.get("DSH_SESSION_ROOT"),
    "DSH_CORDIS_CONFIG": os.environ.get("DSH_CORDIS_CONFIG"),
}, open(env_dump, "w"))

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        json.dump(msg.get("params"), open(os.environ["INIT_DUMP"], "w"))
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-runtime"}}}), flush=True)
    elif method == "session/prompt":
        params = msg.get("params") or {}
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": params["sessionId"], "event": {"type": "agent/inbox/spliced", "data": {"target": "next-turn", "start": 0, "inserted": [{"id": "message-1"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": params["sessionId"], "status": "running"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"messageId": "message-1"}}), flush=True)
        print(json.dumps({
            "jsonrpc": "2.0",
            "method": "session.event",
            "params": {
                "sessionId": params["sessionId"],
                "event": {
                    "type": "tool/result",
                    "data": {
                        "turn": 1,
                        "step": 1,
                        "message": {
                            "source": {"kind": "tool", "callId": "native-call"},
                            "content": [{
                                "type": "tool-result",
                                "toolCallId": "native-call",
                                "content": [{"type": "text", "text": "Error: blocked by policy"}],
                                "isError": True,
                            }],
                            "role": "user",
                            "id": "native-result",
                        },
                        "error": {
                            "name": "AutoReviewDeniedError",
                            "code": "AUTO_REVIEW_DENIED",
                            "reason": " native raw\\nreason ",
                        },
                    },
                },
            },
        }), flush=True)
        print(json.dumps({
            "jsonrpc": "2.0",
            "method": "session.event",
            "params": {
                "sessionId": params["sessionId"],
                "event": {
                    "type": "tool/ptc-dispatch-start",
                    "data": {
                        "rootCallId": "run-code-call",
                        "parentCallId": "run-code-call",
                        "subCallId": "run-code-call:ptc:1",
                        "name": "bash",
                        "arguments": {"command": "git push --force"},
                    },
                },
            },
        }), flush=True)
        print(json.dumps({
            "jsonrpc": "2.0",
            "method": "session.event",
            "params": {
                "sessionId": params["sessionId"],
                "event": {
                    "type": "tool/ptc-dispatch",
                    "data": {
                        "rootCallId": "run-code-call",
                        "parentCallId": "run-code-call",
                        "subCallId": "run-code-call:ptc:1",
                        "name": "bash",
                        "arguments": {"command": "git push --force"},
                        "isError": True,
                        "content": [{"type": "text", "text": "Error: blocked by policy"}],
                        "error": {
                            "name": "AutoReviewDeniedError",
                            "code": "AUTO_REVIEW_DENIED",
                            "reason": " ptc raw\\nreason ",
                        },
                    },
                },
            },
        }), flush=True)
        print(json.dumps({
            "jsonrpc": "2.0",
            "method": "session.event",
            "params": {
                "sessionId": params["sessionId"],
                "event": {
                    "type": "assistant/message",
                    "data": {
                        "message": {
                            "role": "assistant",
                            "content": [{"type": "text", "text": "hello from runtime"}],
                        },
                    },
                },
            },
        }), flush=True)
        print(json.dumps({
            "jsonrpc": "2.0",
            "method": "session.event",
            "params": {
                "sessionId": params["sessionId"],
                "event": {
                    "type": "turn/end",
                    "data": {"turn": 1, "reason": {"kind": "completed"}},
                },
            },
        }), flush=True)
        print(json.dumps({
            "jsonrpc": "2.0",
            "method": "session.event",
            "params": {
                "sessionId": params["sessionId"],
                "event": {
                    "type": "turn/end",
                    "data": {"turn": 2, "reason": {"kind": "max-tokens"}},
                },
            },
        }), flush=True)
        print(json.dumps({
            "jsonrpc": "2.0",
            "method": "session.status",
            "params": {"sessionId": params["sessionId"], "status": "idle"},
        }), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    with DeepSeekHarness(
        model="deepseek-v4-flash",
        reasoning_effort="max",
        max_tokens=4096,
        cwd=str(tmp_path),
        _launch_args=(sys.executable, str(script)),
        env={
            "ENV_DUMP": str(env_dump),
            "INIT_DUMP": str(init_dump),
            "DEEPSEEK_API_KEY": "env-key",
            "DEEPSEEK_BASE_URL": "http://127.0.0.1:4321",
        },
    ) as harness:
        result = harness.run("say hello", session_id="main")

    assert result.final_response == "hello from runtime"
    assert result.finish_reason == "max-tokens"
    assert result.events[-1]["type"] == "turn/end"
    projected_errors = [
        event["data"]["error"]
        for event in result.events
        if event["type"] in {"tool/result", "tool/ptc-dispatch"}
    ]
    assert projected_errors == [
        {
            "name": "AutoReviewDeniedError",
            "code": "AUTO_REVIEW_DENIED",
            "reason": " native raw\nreason ",
        },
        {
            "name": "AutoReviewDeniedError",
            "code": "AUTO_REVIEW_DENIED",
            "reason": " ptc raw\nreason ",
        },
    ]
    ptc_events = [event for event in result.events if event["type"].startswith("tool/ptc-dispatch")]
    assert [event["type"] for event in ptc_events] == ["tool/ptc-dispatch-start", "tool/ptc-dispatch"]
    for event in ptc_events:
        assert not {"description", "parameters", "schema"}.intersection(event["data"])
    dumped_env = json.loads(env_dump.read_text())
    assert dumped_env["DEEPSEEK_API_KEY"] == "env-key"
    assert dumped_env["DEEPSEEK_BASE_URL"] == "http://127.0.0.1:4321"
    assert dumped_env["DSH_CWD"] is None
    assert dumped_env["DSH_SESSION_ROOT"] is None
    assert dumped_env["DSH_CORDIS_CONFIG"] is None
    assert json.loads(init_dump.read_text()) == {
        "cwd": str(tmp_path),
        "provider": "deepseek-official",
        "model": "deepseek-v4-flash",
        "reasoningEffort": "max",
        "maxTokens": 4096,
    }


def test_session_run_invokes_notification_callback_before_returning(tmp_path: Path) -> None:
    script = tmp_path / "fake_runtime.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-runtime"}}}), flush=True)
    elif method == "session/prompt":
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": "main", "event": {"type": "agent/inbox/spliced", "data": {"target": "next-turn", "start": 0, "inserted": [{"id": "message-1"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": "main", "status": "running"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"messageId": "message-1"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "subagent.started", "params": {"parentSessionId": "main", "childSessionId": "child"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": "main", "status": "idle"}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    seen: list[str] = []
    with DeepSeekHarness(
        _launch_args=(sys.executable, str(script)),
        cwd=str(tmp_path),
    ) as harness:
        session = harness.start_session("main")
        result = session.run(
            "spawn a helper",
            on_notification=lambda notification: seen.append(notification.method),
        )

    assert seen == ["session.event", "session.status", "subagent.started", "session.status"]
    assert result.finish_reason is None


def test_high_level_sdk_rejects_turn_end_without_reason_kind(tmp_path: Path) -> None:
    script = tmp_path / "fake_runtime.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-runtime"}}}), flush=True)
    elif method == "session/prompt":
        params = msg.get("params") or {}
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": params["sessionId"], "event": {"type": "agent/inbox/spliced", "data": {"target": "next-turn", "start": 0, "inserted": [{"id": "message-1"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"messageId": "message-1"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": params["sessionId"], "event": {"type": "turn/end", "data": {"turn": 1, "reason": {}}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": params["sessionId"], "status": "idle"}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    with DeepSeekHarness(
        _launch_args=(sys.executable, str(script)),
        cwd=str(tmp_path),
    ) as harness:
        with pytest.raises(
            SdkProtocolError,
            match=r"turn/end event requires a string data\.reason\.kind",
        ):
            harness.run("reject malformed turn ending", session_id="main")


def test_relative_cwd_is_absolute_in_process_environment_and_wire(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    script = tmp_path / "capture_cwd.py"
    capture = tmp_path / "cwd.json"
    script.write_text(
        """
import json
import os
import sys

for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("method") == "initialize":
        json.dump({"process": os.getcwd(), "environment": os.environ.get("DSH_CWD"), "wire": msg["params"]["cwd"]}, open(os.environ["CAPTURE"], "w"))
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-runtime"}}}), flush=True)
    elif msg.get("method") == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )
    monkeypatch.chdir(tmp_path)

    with DeepSeekHarness(
        cwd=".",
        runtime_cwd=".",
        _launch_args=(sys.executable, str(script)),
        env={"CAPTURE": str(capture)},
    ):
        pass

    expected = str(tmp_path.resolve())
    assert json.loads(capture.read_text()) == {
        "process": expected,
        "environment": None,
        "wire": expected,
    }


def test_session_run_includes_subagent_finished_for_parent_session(tmp_path: Path) -> None:
    script = tmp_path / "fake_runtime.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-runtime"}}}), flush=True)
    elif method == "session/prompt":
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": "main", "event": {"type": "agent/inbox/spliced", "data": {"target": "next-turn", "start": 0, "inserted": [{"id": "message-1"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": "main", "status": "running"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"messageId": "message-1"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "subagent.started", "params": {"parentSessionId": "main", "childSessionId": "child"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "subagent.finished", "params": {"parentSessionId": "main", "childSessionId": "child", "status": "ok", "stopReason": "completed"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": "main", "status": "idle"}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    with DeepSeekHarness(
        _launch_args=(sys.executable, str(script)),
        cwd=str(tmp_path),
    ) as harness:
        result = harness.run("spawn a helper", session_id="main")

    assert [notification.method for notification in result.notifications] == [
        "session.event",
        "session.status",
        "subagent.started",
        "subagent.finished",
        "session.status",
    ]


def test_session_run_collects_nested_subagent_tree_without_polluting_root_events(
    tmp_path: Path,
) -> None:
    script = tmp_path / "fake_runtime.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-runtime"}}}), flush=True)
    elif method == "session/prompt":
        root = (msg.get("params") or {})["sessionId"]
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": root, "event": {"type": "agent/inbox/spliced", "data": {"target": "next-turn", "start": 0, "inserted": [{"id": "message-1"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": root, "status": "running"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"messageId": "message-1"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "subagent.started", "params": {"parentSessionId": root, "childSessionId": "child"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": "child", "event": {"type": "assistant/message", "data": {"content": [{"type": "text", "text": "child response"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "subagent.started", "params": {"parentSessionId": "child", "childSessionId": "grandchild"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": "grandchild", "event": {"type": "assistant/message", "data": {"content": [{"type": "text", "text": "grandchild response"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "subagent.finished", "params": {"parentSessionId": "child", "childSessionId": "grandchild", "status": "ok"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "subagent.finished", "params": {"parentSessionId": root, "childSessionId": "child", "status": "ok"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": root, "event": {"type": "assistant/message", "data": {"content": [{"type": "text", "text": "root response"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": root, "status": "idle"}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    seen: list[str] = []
    with DeepSeekHarness(
        _launch_args=(sys.executable, str(script)),
        cwd=str(tmp_path),
    ) as harness:
        result = harness.run(
            "delegate recursively",
            session_id="main",
            on_notification=lambda notification: seen.append(notification.method),
        )
        assert harness.client._notifications.qsize() == 0

    assert result.final_response == "root response"
    assert [event["data"]["content"][0]["text"] for event in result.events if event["type"] == "assistant/message"] == ["root response"]
    assert [notification.method for notification in result.notifications] == [
        "session.event",
        "session.status",
        "subagent.started",
        "session.event",
        "subagent.started",
        "session.event",
        "subagent.finished",
        "subagent.finished",
        "session.event",
        "session.status",
    ]
    assert seen == [notification.method for notification in result.notifications]


def test_session_run_ignores_notifications_for_other_sessions(tmp_path: Path) -> None:
    script = tmp_path / "fake_runtime.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-runtime"}}}), flush=True)
    elif method == "session/prompt":
        params = msg.get("params") or {}
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": "other", "event": {"type": "assistant/message", "data": {"content": [{"type": "text", "text": "wrong session"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": "other", "status": "idle"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": params["sessionId"], "event": {"type": "agent/inbox/spliced", "data": {"target": "next-turn", "start": 0, "inserted": [{"id": "message-1"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": params["sessionId"], "status": "running"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"messageId": "message-1"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": params["sessionId"], "event": {"type": "assistant/message", "data": {"content": [{"type": "text", "text": "right session"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": params["sessionId"], "status": "idle"}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    with DeepSeekHarness(
        _launch_args=(sys.executable, str(script)),
        cwd=str(tmp_path),
    ) as harness:
        result = harness.run("stay in your lane", session_id="main")

    assert result.final_response == "right session"
    assert [notification.payload.get("sessionId") for notification in result.notifications] == ["main"] * 4


def test_high_level_session_run_does_not_accumulate_global_notifications(tmp_path: Path) -> None:
    script = tmp_path / "fake_runtime.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-runtime"}}}), flush=True)
    elif method == "session/prompt":
        params = msg.get("params") or {}
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": params["sessionId"], "event": {"type": "agent/inbox/spliced", "data": {"target": "next-turn", "start": 0, "inserted": [{"id": "message-1"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": params["sessionId"], "status": "running"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"messageId": "message-1"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": params["sessionId"], "event": {"type": "assistant/message", "data": {"content": [{"type": "text", "text": "ok"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": params["sessionId"], "status": "idle"}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    with DeepSeekHarness(_launch_args=(sys.executable, str(script)), cwd=str(tmp_path)) as harness:
        result = harness.run("one turn", session_id="main")
        assert harness.client._notifications.qsize() == 0


def test_session_run_waits_for_late_idle_without_replaying_stale_notifications(tmp_path: Path) -> None:
    script = tmp_path / "fake_runtime.py"
    script.write_text(
        """
import json
import sys
import time

turn = 0
for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-runtime"}}}), flush=True)
    elif method == "session/prompt":
        turn += 1
        params = msg.get("params") or {}
        session_id = params["sessionId"]
        message_id = f"message-{turn}"
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": session_id, "event": {"type": "agent/inbox/spliced", "data": {"target": "next-turn", "start": 0, "inserted": [{"id": message_id}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": session_id, "status": "running"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"messageId": message_id}}), flush=True)
        if turn == 1:
            print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": session_id, "event": {"type": "assistant/message", "data": {"content": [{"type": "text", "text": "first"}]}}}}), flush=True)
            print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": session_id, "status": "idle"}}), flush=True)
        else:
            time.sleep(0.05)
            print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": session_id, "event": {"type": "assistant/message", "data": {"content": [{"type": "text", "text": "second"}]}}}}), flush=True)
            print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": session_id, "status": "idle"}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    with DeepSeekHarness(_launch_args=(sys.executable, str(script)), cwd=str(tmp_path)) as harness:
        first = harness.run("first turn", session_id="main")
        second = harness.run("second turn", session_id="main")

    assert first.final_response == "first"
    assert second.final_response == "second"
    assert [notification.payload.get("sessionId") for notification in second.notifications] == ["main"] * 4


def test_client_starts_subprocess_sends_requests_and_routes_notifications(tmp_path: Path) -> None:
    script = tmp_path / "fake_bridge.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-dsh"}}}), flush=True)
    elif method == "session/prompt":
        params = msg.get("params") or {}
        print(json.dumps({"jsonrpc": "2.0", "method": "llm/request", "params": {"requestId": "req-1", "sessionId": params["sessionId"], "model": "dsagent", "messages": []}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"messageId": "message-1"}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    with HarnessClient(_launch_args=(sys.executable, str(script))) as client:
        init = client.initialize(provider="deepseek-official", cwd="/workspace", model="dsagent")
        assert init.serverInfo.name == "fake-dsh"

        client.session_prompt("main", [{"type": "text", "text": "fix it"}])
        notification = client.next_notification()
        assert notification.method == "llm/request"
        assert notification.payload["requestId"] == "req-1"
    assert notification.payload["sessionId"] == "main"


def test_client_keeps_unmatched_notifications_available_globally_while_subscribed() -> None:
    client = HarnessClient()
    with client.subscribe_session_notifications("main"):
        client._handle_message({
            "jsonrpc": "2.0",
            "method": "session.event",
            "params": {"sessionId": "other", "event": {"type": "assistant/message"}},
        })

        assert client._notifications.qsize() == 1
        notification = client._notifications.get_nowait()
        assert not isinstance(notification, BaseException)
        assert notification.method == "session.event"
        assert notification.payload["sessionId"] == "other"


def test_session_subscription_keeps_descendant_relationships_across_subscriptions() -> None:
    client = HarnessClient()
    with client.subscribe_session_notifications("main") as first:
        unknown_child = {
            "type": "subagent/catalog", "seq": 0, "time": 1,
            "data": {"version": 1, "childId": "unreadable-child", "childCreatedAt": 1, "mode": "unknown"},
        }
        client._handle_message({
            "jsonrpc": "2.0", "method": "session.event",
            "params": {"sessionId": "main", "event": unknown_child},
        })
        assert first.next().payload == {"sessionId": "main", "event": unknown_child}
        client._handle_message({
            "jsonrpc": "2.0",
            "method": "subagent.started",
            "params": {"parentSessionId": "main", "childSessionId": "child"},
        })
        assert first.next().payload["childSessionId"] == "child"

    with client.subscribe_session_notifications("main") as second:
        client._handle_message({
            "jsonrpc": "2.0",
            "method": "subagent.started",
            "params": {"parentSessionId": "child", "childSessionId": "grandchild"},
        })
        client._handle_message({
            "jsonrpc": "2.0",
            "method": "session.event",
            "params": {"sessionId": "grandchild", "event": {"type": "assistant/message"}},
        })
        assert second.next().payload["childSessionId"] == "grandchild"
        assert second.next().payload["sessionId"] == "grandchild"

    assert client._notifications.qsize() == 0


def test_session_subscription_preserves_reused_child_ancestry_after_late_finish() -> None:
    client = HarnessClient()
    old_seen: list[Notification] = []
    new_seen: list[Notification] = []
    with (
        client.subscribe_session_notifications("old-parent") as old_subscription,
        client.subscribe_session_notifications("new-parent") as new_subscription,
    ):
        client._handle_message({
            "jsonrpc": "2.0",
            "method": "subagent.started",
            "params": {"parentSessionId": "old-parent", "childSessionId": "reused-child"},
        })
        old_subscription.drain(old_seen.append)
        new_subscription.drain(new_seen.append)
        assert [notification.method for notification in old_seen] == ["subagent.started"]
        assert new_seen == []

        client._handle_message({
            "jsonrpc": "2.0",
            "method": "subagent.started",
            "params": {"parentSessionId": "new-parent", "childSessionId": "reused-child"},
        })
        old_subscription.drain(old_seen.append)
        new_subscription.drain(new_seen.append)
        assert [notification.method for notification in new_seen] == ["subagent.started"]

        client._handle_message({
            "jsonrpc": "2.0",
            "method": "subagent.finished",
            "params": {"parentSessionId": "old-parent", "childSessionId": "reused-child"},
        })
        old_subscription.drain(old_seen.append)
        new_subscription.drain(new_seen.append)
        assert [notification.method for notification in old_seen] == [
            "subagent.started",
            "subagent.finished",
        ]
        assert [notification.method for notification in new_seen] == ["subagent.started"]

        client._handle_message({
            "jsonrpc": "2.0",
            "method": "session.event",
            "params": {"sessionId": "reused-child", "event": {"type": "assistant/message"}},
        })
        old_subscription.drain(old_seen.append)
        new_subscription.drain(new_seen.append)

    assert [notification.method for notification in old_seen] == [
        "subagent.started",
        "subagent.finished",
    ]
    assert [notification.method for notification in new_seen] == [
        "subagent.started",
        "session.event",
    ]
    assert client._notifications.qsize() == 0


def test_client_contains_notification_filter_failure_to_its_subscription(tmp_path: Path) -> None:
    script = tmp_path / "fake_bridge.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-dsh"}}}), flush=True)
    elif method in {"emit-first", "emit-second"}:
        print(json.dumps({"jsonrpc": "2.0", "method": "tick", "params": {"source": method}}), flush=True)
    elif method == "session/prompt":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"messageId": "message-1"}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    def broken_filter(_notification: object) -> bool:
        raise RuntimeError("bad notification filter")

    with HarnessClient(_launch_args=(sys.executable, str(script))) as client:
        client.initialize(provider="deepseek-official", cwd="/workspace", model="dsagent")
        with (
            client.subscribe_notifications(broken_filter) as broken,
            client.subscribe_notifications(lambda notification: notification.method == "tick") as healthy,
        ):
            client.notify("emit-first")
            with pytest.raises(RuntimeError, match="bad notification filter"):
                broken.next()
            assert healthy.next().payload == {"source": "emit-first"}
            assert client._notifications.qsize() == 0

            client.session_prompt("main", [{"type": "text", "text": "reader still works"}])
            client.notify("emit-second")
            assert healthy.next().payload == {"source": "emit-second"}


def test_client_rejects_unaccepted_session_prompt_response(tmp_path: Path) -> None:
    script = tmp_path / "fake_bridge.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-dsh"}}}), flush=True)
    elif method == "session/prompt":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"accepted": False}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    with HarnessClient(_launch_args=(sys.executable, str(script))) as client:
        client.initialize(provider="deepseek-official", cwd="/workspace", model="dsagent")
        with pytest.raises(ValueError):
            client.session_prompt("main", [{"type": "text", "text": "fix it"}])


def test_client_routes_bridge_requests_and_sends_responses(tmp_path: Path) -> None:
    script = tmp_path / "fake_bridge.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-dsh"}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": "bridge-req-1", "method": "llm.request", "params": {"requestId": "req-1", "sessionId": "main", "model": "dsagent", "messages": []}}), flush=True)
    elif "id" in msg and "method" not in msg:
        print(json.dumps({"jsonrpc": "2.0", "method": "response/seen", "params": {"result": msg.get("result")}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    with HarnessClient(_launch_args=(sys.executable, str(script))) as client:
        client.initialize(provider="deepseek-official", cwd="/workspace", model="dsagent")

        request = client.next_request()
        assert request.id == "bridge-req-1"
        assert request.method == "llm.request"
        assert request.payload["requestId"] == "req-1"

        client.respond(request.id, {"content_blocks": [{"type": "text", "text": "done"}]})
        notification = client.next_notification()
        assert notification.method == "response/seen"
        assert notification.payload["result"]["content_blocks"][0]["text"] == "done"


def test_client_ignores_non_json_stdout_lines(tmp_path: Path) -> None:
    script = tmp_path / "fake_bridge.py"
    script.write_text(
        """
import json
import sys

print("node warning: experimental loader", flush=True)
for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("method") == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-dsh"}}}), flush=True)
    elif msg.get("method") == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    with HarnessClient(_launch_args=(sys.executable, str(script))) as client:
        init = client.initialize(provider="deepseek-official", cwd="/workspace", model="dsagent")
        assert init.serverInfo.name == "fake-dsh"


def test_client_request_times_out_when_bridge_does_not_respond(tmp_path: Path) -> None:
    script = tmp_path / "fake_bridge.py"
    script.write_text(
        """
import sys
import time

print("bridge is still starting", file=sys.stderr, flush=True)
time.sleep(60)
""".strip()
    )

    with HarnessClient(
        HarnessConfig(
            profile="web",
            initialize_timeout_seconds=0.1,
        ),
        _launch_args=(sys.executable, str(script)),
    ) as client:
        start = time.monotonic()
        try:
            client.initialize(provider="deepseek-official", cwd="/workspace", model="dsagent")
        except TimeoutError as exc:
            assert time.monotonic() - start < 2
            assert "bridge is still starting" in str(exc)
            assert "profile 'web'" in str(exc)
        else:
            raise AssertionError("initialize should time out")


def test_client_close_times_out_when_shutdown_does_not_respond(tmp_path: Path) -> None:
    script = tmp_path / "fake_bridge.py"
    script.write_text(
        """
import json
import signal
import sys
import time

signal.signal(signal.SIGTERM, signal.SIG_IGN)

for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("method") == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-dsh"}}}), flush=True)
    elif msg.get("method") == "shutdown":
        time.sleep(60)
""".strip()
    )

    client = HarnessClient(
        HarnessConfig(
            shutdown_timeout_seconds=0.1,
        ),
        _launch_args=(sys.executable, str(script)),
    )
    client.start()
    proc = client._proc
    assert proc is not None
    client.initialize(provider="deepseek-official", cwd="/workspace", model="dsagent")
    start = time.monotonic()
    client.close()
    assert time.monotonic() - start < 2
    assert proc.poll() is not None
    assert client._proc is None


def test_client_close_allows_eof_quiescence_after_shutdown_response(tmp_path: Path) -> None:
    script = tmp_path / "fake_runtime.py"
    marker = tmp_path / "quiesced.txt"
    script.write_text(
        """
import json
import os
from pathlib import Path
import sys
import time

for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("method") == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-dsh"}}}), flush=True)
    elif msg.get("method") == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)

time.sleep(0.05)
Path(os.environ["QUIESCED_MARKER"]).write_text("quiesced")
""".strip()
    )

    client = HarnessClient(
        HarnessConfig(
            env={"QUIESCED_MARKER": str(marker)},
            shutdown_timeout_seconds=1,
        ),
        _launch_args=(sys.executable, str(script)),
    )
    client.start()
    client.initialize(provider="deepseek-official", cwd="/workspace", model="dsagent")
    client.close()

    assert marker.read_text() == "quiesced"


def test_initialize_failure_reaps_started_runtime(tmp_path: Path) -> None:
    script = tmp_path / "rejecting_runtime.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("method") == "initialize":
        print("initialize diagnostic", file=sys.stderr, flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32000, "message": "bad initialize"}}), flush=True)
    elif msg.get("method") == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    client = HarnessClient(_launch_args=(sys.executable, str(script)))
    client.start()
    proc = client._proc
    assert proc is not None

    with pytest.raises(JsonRpcError, match="bad initialize") as excinfo:
        client.initialize(provider="deepseek-official", cwd=".", model="dsagent")

    assert excinfo.value.code == -32000
    assert "initialize diagnostic" in str(excinfo.value)
    assert proc.wait(timeout=1) is not None
    assert client._proc is None


def test_public_signatures_omit_unsupported_wire_parameters() -> None:
    from deepseek_harness import DeepSeekHarnessConfig, Session

    assert "session_root" not in inspect.signature(HarnessClient.initialize).parameters
    assert "system_prompt" not in inspect.signature(HarnessClient.initialize).parameters
    assert "profile" not in inspect.signature(HarnessClient.session_prompt).parameters
    assert "profile" not in inspect.signature(DeepSeekHarness.run).parameters
    assert "profile" not in inspect.signature(Session.run).parameters
    assert "system_prompt" not in DeepSeekHarnessConfig.__dataclass_fields__
    assert "max_tokens" in DeepSeekHarnessConfig.__dataclass_fields__
    assert "reasoning_effort" in DeepSeekHarnessConfig.__dataclass_fields__
    assert "max_tokens" in inspect.signature(HarnessClient.initialize).parameters
    assert "reasoning_effort" in inspect.signature(HarnessClient.initialize).parameters
    assert "client_name" not in HarnessConfig.__dataclass_fields__
    assert "client_version" not in HarnessConfig.__dataclass_fields__
    assert {"dsh_bin", "profile", "patches", "dsh_home"} <= set(
        DeepSeekHarnessConfig.__dataclass_fields__
    )
    assert {"dsh_bin", "profile", "patches", "dsh_home"} <= set(
        HarnessConfig.__dataclass_fields__
    )
    assert "initialize_timeout_seconds" in DeepSeekHarnessConfig.__dataclass_fields__
    assert "initialize_timeout_seconds" in HarnessConfig.__dataclass_fields__
    assert DeepSeekHarnessConfig().initialize_timeout_seconds == 30.0
    assert HarnessConfig().initialize_timeout_seconds == 30.0
    for removed in ("cordis", "session_root", "runtime_bin", "bridge_bin", "launch_args_override"):
        assert removed not in DeepSeekHarnessConfig.__dataclass_fields__
        assert removed not in HarnessConfig.__dataclass_fields__
    assert "_launch_args" not in HarnessConfig.__dataclass_fields__
    assert "session_root" not in RunResult.__dataclass_fields__


def test_client_close_is_idempotent_before_and_after_start(tmp_path: Path) -> None:
    HarnessClient().close()

    script = tmp_path / "fake_bridge.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("method") == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-dsh"}}}), flush=True)
    elif msg.get("method") == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    client = HarnessClient(_launch_args=(sys.executable, str(script)))
    client.start()
    client.initialize(provider="deepseek-official", cwd="/workspace", model="dsagent")
    client.close()
    client.close()


def test_runtime_closed_error_includes_stderr_tail(tmp_path: Path) -> None:
    script = tmp_path / "crashing_runtime.py"
    script.write_text(
        """
import sys

print("fatal bridge exploded", file=sys.stderr, flush=True)
sys.exit(42)
""".strip()
    )

    with HarnessClient(
        HarnessConfig(
            request_timeout_seconds=2,
        ),
        _launch_args=(sys.executable, str(script)),
    ) as client:
        with pytest.raises(Exception, match="fatal bridge exploded"):
            client.initialize(provider="deepseek-official", cwd="/workspace", model="dsagent")


def test_client_serializes_concurrent_writes(tmp_path: Path) -> None:
    script = tmp_path / "fake_bridge.py"
    output = tmp_path / "seen.jsonl"
    script.write_text(
        """
import json
import os
import sys

with open(os.environ["SEEN"], "w") as seen:
    for line in sys.stdin:
        seen.write(line)
        seen.flush()
        msg = json.loads(line)
        if "id" in msg and msg.get("method") == "initialize":
            print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-dsh"}}}), flush=True)
        elif "id" in msg and msg.get("method") == "shutdown":
            print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
            break
""".strip()
    )

    with HarnessClient(
        HarnessConfig(
            env={"SEEN": str(output)},
        ),
        _launch_args=(sys.executable, str(script)),
    ) as client:
        client.initialize(provider="deepseek-official", cwd="/workspace", model="dsagent")
        threads = [
            threading.Thread(target=client.notify, args=(f"notice-{index}", {"index": index}))
            for index in range(50)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

    for line in output.read_text().splitlines():
        json.loads(line)


def _install_fake_bundled_dsh(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Install a fake runtime package that records dsh argv and serves lifecycle calls."""
    runtime = tmp_path / "dsh.py"
    runtime.write_text(
        """
import json
import os
import sys

json.dump({
    "argv": sys.argv[1:],
    "DSH_HOME": os.environ.get("DSH_HOME"),
    "DSH_CORDIS_CONFIG": os.environ.get("DSH_CORDIS_CONFIG"),
}, open(os.environ["ENV_DUMP"], "w"))
for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("method") == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "bundled-runtime"}}}), flush=True)
    elif msg.get("method") == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    module_dir = tmp_path / "deepseek_harness_runtime"
    module_dir.mkdir()
    (module_dir / "__init__.py").write_text(
        f"""
def resolve_bundled_launch_args(mode=None):
    return ({sys.executable!r}, {str(runtime)!r})
""".strip()
    )

    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.delitem(sys.modules, "deepseek_harness_runtime", raising=False)


def test_client_default_launch_uses_bundled_dsh_sdk_profile_and_explicit_home(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env_dump = tmp_path / "env.json"
    home = tmp_path / "home"
    patch = tmp_path / "sdk.patch.yml"
    patch.write_text("[]\n")
    _install_fake_bundled_dsh(tmp_path, monkeypatch)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DSH_HOME", str(tmp_path / "ambient-home"))
    monkeypatch.delenv("DSH_CORDIS_CONFIG", raising=False)

    with HarnessClient(HarnessConfig(
        profile="sdk",
        patches=("sdk.patch.yml",),
        dsh_home=str(home),
        env={"ENV_DUMP": str(env_dump), "DSH_HOME": str(tmp_path / "env-home")},
    )) as client:
        init = client.initialize(provider="deepseek-official", cwd="/workspace", model="deepseek-v4-pro")

    assert init.serverInfo.name == "bundled-runtime"
    assert json.loads(env_dump.read_text()) == {
        "argv": ["--profile", "sdk", "--patch", str(patch)],
        "DSH_HOME": str(home),
        "DSH_CORDIS_CONFIG": None,
    }


def test_client_accepts_explicit_environment_dsh_home(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env_dump = tmp_path / "env.json"
    home = tmp_path / "environment-home"
    _install_fake_bundled_dsh(tmp_path, monkeypatch)

    with HarnessClient(
        HarnessConfig(profile="custom", env={"ENV_DUMP": str(env_dump), "DSH_HOME": str(home)})
    ) as client:
        client.initialize(provider="deepseek-official", cwd="/workspace", model="deepseek-v4-pro")

    assert json.loads(env_dump.read_text()) == {
        "argv": ["--profile", "custom"],
        "DSH_HOME": str(home),
        "DSH_CORDIS_CONFIG": None,
    }


def test_client_rejects_an_implicit_default_dsh_home(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _install_fake_bundled_dsh(tmp_path, monkeypatch)
    monkeypatch.delenv("DSH_HOME", raising=False)

    with pytest.raises(ValueError, match="explicit dsh_home or non-empty DSH_HOME"):
        HarnessClient(HarnessConfig(env={})).start()


def test_client_reports_missing_bundled_runtime_dependency(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delitem(sys.modules, "deepseek_harness_runtime", raising=False)
    monkeypatch.setattr(sys, "path", [])

    with pytest.raises(FileNotFoundError, match="Install deepseek-harness-runtime-bin"):
        HarnessClient(HarnessConfig(dsh_home="/explicit/home")).start()
