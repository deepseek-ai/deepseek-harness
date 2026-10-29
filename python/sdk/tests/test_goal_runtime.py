"""Native goal rounds and state changes through the Python SDK profile."""

from __future__ import annotations

import json
import time
import threading

import pytest
from pathlib import Path

from deepseek_harness.models import CommandExecution
from deepseek_harness import RunResult, Session
from deepseek_harness.client import NotificationSubscription
from test_commands_runtime import (
    _Completion, _Runtime, _SESSION_ID, _WAIT_SECONDS, _WaitResult, _assert_request_permission,
    _command_pair, _of_type, _permission_facts, _read_events,
    _request_texts, _runtime, _text_blocks, _wait_activity,
)


def _command(runtime: _Runtime, session: Session, text: str, *, kind: str = "success") -> CommandExecution:
    result = runtime.call(runtime.harness.client._query, session.id, text)
    assert isinstance(result, CommandExecution)
    assert result.result.kind == kind, result.result.text
    return result


def _until(subscription: NotificationSubscription, event_type: str, operation: str | None = None) -> dict:
    deadline = time.monotonic() + _WAIT_SECONDS
    while True:
        notification = subscription.next(timeout_seconds=max(0, deadline - time.monotonic()))
        if notification.method != "session.event":
            continue
        event = notification.payload["event"]
        if event["type"] == event_type and (operation is None or event["data"].get("operation") == operation):
            return event["data"]


def _complete_goal(request: dict) -> tuple[str, dict]:
    results = [block for message in request["messages"] for block in message["content"]
               if block["type"] == "tool_result"]
    current = json.loads("\n".join(_text_blocks(results[-1]["content"])))
    goal = current["goal"]
    assert goal["phase"] == "active" and current["activation"] == "armed"
    return "update_goal", {"goal_id": goal["id"], "revision": goal["revision"], "action": "complete"}


def _completion_steps(final: _Completion | None = None) -> list[_Completion]:
    return [_Completion("", tool_call=("get_goal", {})), _Completion("", tool_call=_complete_goal),
            final if final is not None else _Completion("GOAL_DONE")]


def test_goal_reads_and_invalid_controls_do_not_start_model_work(tmp_path: Path) -> None:
    with _runtime(tmp_path, []) as runtime:
        session = runtime.harness.start_session(_SESSION_ID)
        executions = [_command(runtime, session, "/目标")]
        for line in ["/goal edit", "/goal edit Missing goal", "/goal pause", "/goal resume"]:
            executions.append(_command(runtime, session, line, kind="error"))
        executions.append(_command(runtime, session, "/goal clear"))
        assert runtime.model.captured() == []
    events = _read_events(runtime.logs)
    assert not _of_type(events, "goal/change") and not _of_type(events, "turn/start")
    for execution in executions:
        _command_pair(events, execution, "goal")


@pytest.mark.parametrize("clear_before_reply", [False, True])
def test_goal_continues_rounds_and_finishes_wrapup_after_completion_event(
    tmp_path: Path, clear_before_reply: bool,
) -> None:
    final = _Completion("GOAL_DONE", blocked=True)
    with _runtime(tmp_path, [_Completion("PROGRESS"), *_completion_steps(final)],
                  initial_permission="workspace-write", max_goal_rounds=3) as runtime:
        session = runtime.harness.start_session(_SESSION_ID)
        with runtime.harness.client.subscribe_session_notifications(session.id) as events:
            running = runtime.workers.submit(session.run, "/目标 Verify the small change.")
            completed = _until(events, "goal/change", "complete")
            assert completed["goal"]["phase"] == "complete" and completed["roundsStarted"] == 2
            assert final.entered.wait(_WAIT_SECONDS)
            assert not running.done()
            if clear_before_reply:
                cleared = runtime.call(session.run, "/goal clear")
                assert cleared.final_response == "Goal cleared." and cleared.finish_reason == "completed"
                assert not running.done()
            final.release.set()
            result = running.result(timeout=_WAIT_SECONDS)
            assert isinstance(result, RunResult)
            assert result.final_response == "GOAL_DONE" and result.finish_reason == "completed"
            operations = ["create", "complete", *(["clear"] if clear_before_reply else [])]
            assert [event["data"]["operation"] for event in result.events if event["type"] == "goal/change"] == operations
    _command_pair(_read_events(runtime.logs), result, "goal")


def test_pause_aborts_then_edit_and_resume_use_revised_goal_without_changing_other_sessions(tmp_path: Path) -> None:
    first = _Completion("CANCELLED_RESPONSE", blocked=True, allow_disconnect=True)
    with _runtime(tmp_path, [first, *_completion_steps(), _Completion("RAW_GOAL_TEXT")]) as runtime:
        session = runtime.harness.start_session(_SESSION_ID)
        with runtime.harness.client.subscribe_session_notifications(session.id) as events:
            _command(runtime, session, "/goal Original objective")
            assert first.entered.wait(_WAIT_SECONDS)
            _command(runtime, session, "/goal Duplicate objective", kind="error")
            _command(runtime, session, "/goal edit", kind="error")
            _command(runtime, session, "/goal resume", kind="error")
            _command(runtime, session, "/goal PAUSE")
            assert _until(events, "turn/end")["reason"]["kind"] == "aborted"
            assert not first.release.is_set()
            _command(runtime, session, "/goal edit Revised objective")
            assert len(runtime.model.captured()) == 1
            other = runtime.harness.start_session("goal-other")
            assert "No goal is currently set" in _command(runtime, other, "/goal").result.text
            _command(runtime, session, "/goal resume")
            _until(events, "goal/change", "complete")
            _wait_activity(runtime, session)
            assert 'Objective: "Revised objective"' in "\n".join(_request_texts(runtime.model.captured()[1]))
            _command(runtime, session, "/goal clear")
            _command(runtime, session, "/goal clear")
            runtime.call(runtime.harness.client.session_prompt, session.id, [{"type": "text", "text": "/goal Plain text objective"}])
            _wait_activity(runtime, session)
            assert "/goal Plain text objective" in _request_texts(runtime.model.captured()[-1])
    changes = _of_type(_read_events(runtime.logs), "goal/change")
    assert [e["data"]["operation"] for e in changes] == ["create", "pause", "edit", "resume", "complete", "clear"]
    assert not _of_type(_read_events(runtime.logs, session_id="goal-other"), "goal/change")


def test_clear_keeps_current_request_and_stops_further_goal_rounds(tmp_path: Path) -> None:
    first = _Completion("CURRENT_ROUND_FINISHED", blocked=True)
    with _runtime(tmp_path, [first]) as runtime:
        session = runtime.harness.start_session(_SESSION_ID)
        with runtime.harness.client.subscribe_session_notifications(session.id) as events:
            _command(runtime, session, "/goal Work until cleared")
            assert first.entered.wait(_WAIT_SECONDS)
            _command(runtime, session, "/goal clear")
            first.release.set()
            _wait_activity(runtime, session)
            assert _until(events, "turn/end")["reason"]["kind"] == "completed"
        assert len(runtime.model.captured()) == 1
    events = _read_events(runtime.logs)
    assert len(_of_type(events, "assistant/message")) == 1
    assert [e["data"]["operation"] for e in _of_type(events, "goal/change")] == ["create", "clear"]


def test_round_limit_blocks_and_rejects_resume_without_another_request(tmp_path: Path) -> None:
    with _runtime(tmp_path, [_Completion("ONE"), _Completion("TWO")], max_goal_rounds=2) as runtime:
        session = runtime.harness.start_session(_SESSION_ID)
        with runtime.harness.client.subscribe_session_notifications(session.id) as events:
            _command(runtime, session, "/goal An unfinished objective")
            blocked = _until(events, "goal/change", "block")
            assert blocked["goal"]["blockedReason"]["code"] == "round-limit"
            assert blocked["roundsStarted"] == 2
            _command(runtime, session, "/goal resume", kind="error")
            _wait_activity(runtime, session)
        assert len(runtime.model.captured()) == 2


def test_restored_active_goal_waits_for_explicit_resume(tmp_path: Path) -> None:
    first = _Completion("INTERRUPTED", blocked=True, allow_disconnect=True)
    with _runtime(tmp_path, [first], max_goal_rounds=3) as runtime:
        session = runtime.harness.start_session(_SESSION_ID)
        runtime.call(runtime.harness.client.session_prompt, session.id, [{"type": "text", "text": "Start an ordinary task"}])
        assert first.entered.wait(_WAIT_SECONDS)
        _command(runtime, session, "/goal Persisted objective")
        runtime.harness.close()
    with _runtime(tmp_path, _completion_steps()) as runtime:
        session = runtime.call(runtime.harness.resume_session, _SESSION_ID)
        shown = _command(runtime, session, "/goal")
        assert "Status: active" in shown.result.text and "Activation: disarmed" in shown.result.text
        assert runtime.model.captured() == []
        with runtime.harness.client.subscribe_session_notifications(session.id) as events:
            _command(runtime, session, "/goal resume")
            _until(events, "goal/change", "complete")
            _wait_activity(runtime, session)
        assert 'Objective: "Persisted objective"\nRound: 1/3' in "\n".join(_request_texts(runtime.model.captured()[0]))
