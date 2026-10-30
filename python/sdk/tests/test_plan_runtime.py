"""Native plan guidance, input timing and reviewed exit through the real SDK profile."""

from __future__ import annotations

import threading
from pathlib import Path

import pytest

from deepseek_harness.models import CommandExecution
from deepseek_harness import RunResult, Session, UserQuestionRequest
from test_commands_runtime import (
    _Completion, _Runtime, _SESSION_ID, _WAIT_SECONDS, _assert_request_permission,
    _command_pair, _native_result, _of_type, _permission_facts, _read_events,
    _request_texts, _runtime, _text_blocks, _wait_activity,
)

_PLAN = "# Implement the change\n\n- Inspect existing code.\n- Make the smallest change.\n- Run focused tests."
_PLAN_REVISED = "# Revised plan\n\n- Include a rollback procedure."
_GUIDANCE = "You are in plan mode."


def _command(runtime: _Runtime, session: Session, text: str) -> CommandExecution:
    result = runtime.call(runtime.harness.client._query, session.id, text)
    assert isinstance(result, CommandExecution)
    assert result.result.kind == "success", result.result.text
    return result


def _effective_system(request: dict) -> str:
    system = "\n".join(_text_blocks(request.get("system", "")))
    for message in request["messages"]:
        if message["role"] == "system":
            system = "\n".join(_text_blocks(message["content"]))
    return system


def _tool_names(request: dict) -> set[str]:
    return {tool["name"] for tool in request.get("tools", [])}


def _review(plan: str = _PLAN) -> _Completion:
    return _Completion("", tool_call=("exit_plan_mode", {"plan": plan}))


def _answer(request: UserQuestionRequest, choice: str, feedback: str | None = None) -> dict:
    [question] = request.questions
    assert question["intent"]["kind"] == "plan-review"
    item = {"id": question["id"], "selected": [choice]}
    if feedback is not None:
        item["custom"] = feedback
    return {"answers": [item]}


def test_bare_plan_and_off_change_only_plan_state_without_a_model_request(tmp_path: Path) -> None:
    with _runtime(tmp_path, [], initial_permission="workspace-write") as runtime:
        session = runtime.harness.start_session(_SESSION_ID)
        on = _command(runtime, session, " \n/计划\t ")
        off = _command(runtime, session, "/plan off")
        repeated = _command(runtime, session, "/plan off")
        assert runtime.model.captured() == []
        assert "already inactive" in repeated.result.text
        assert runtime.harness.config.env["DSH_PERMISSION_MODE"] == "workspace-write"
    events = _read_events(runtime.logs)
    for execution in [on, off, repeated]:
        _command_pair(events, execution, "plan")
    assert [e["data"] for e in _of_type(events, "plan/mode")] == [{"active": True}, {"active": False}]
    assert not _of_type(events, "turn/start")
    assert [e["data"] for e in _permission_facts(events)] == [
        {"preset": "workspace-write"}, {"mode": "workspace-write"}, {"policy": "ask"},
    ]


def test_plan_body_uses_native_input_then_off_removes_guidance_but_keeps_exit_tool(tmp_path: Path) -> None:
    with _runtime(tmp_path, [_Completion("PLAN_READY"), _Completion("AFTER_OFF")], initial_permission="workspace-write") as runtime:
        session = runtime.harness.start_session(_SESSION_ID)
        execution = _command(runtime, session, "/计划  Design this change without tools. ")
        _wait_activity(runtime, session)
        first = runtime.model.captured()[0]
        assert "Design this change without tools." in _request_texts(first)
        assert "/计划  Design this change without tools. " not in _request_texts(first)
        assert _GUIDANCE in _effective_system(first)
        assert "Do not edit or write files" in _effective_system(first)
        assert {"exit_plan_mode", "write", "edit"} <= _tool_names(first)
        _assert_request_permission(first, "workspace-write", "ask")
        _command(runtime, session, "/plan off")
        result = runtime.call(session.run, "Continue after the user changed the mode.")
        assert isinstance(result, RunResult) and result.final_response == "AFTER_OFF"
        second = runtime.model.captured()[1]
        assert _GUIDANCE not in _effective_system(second)
        assert _tool_names(first) == _tool_names(second)
        assert "The user switched this session back to the default mode." in _request_texts(second)
        _assert_request_permission(second, "workspace-write", "ask")
    events = _read_events(runtime.logs)
    _command_pair(events, execution, "plan")
    assert len(_of_type(events, "turn/start")) == 2
    assert len(_permission_facts(events)) == 3


def test_plan_body_steers_the_next_step_of_a_running_turn(tmp_path: Path) -> None:
    first = _Completion("FIRST_REPLY", blocked=True)
    with _runtime(tmp_path, [first, _Completion("PLANNING_REPLY")], initial_permission="workspace-write") as runtime:
        session = runtime.harness.start_session(_SESSION_ID)
        observing = runtime.workers.submit(session.run, "Start this task without tools.")
        assert first.entered.wait(_WAIT_SECONDS)
        execution = _command(runtime, session, "/plan Design a smaller change.")
        assert not first.release.is_set() and not observing.done()
        first.release.set()
        result = observing.result(timeout=_WAIT_SECONDS)
        assert isinstance(result, RunResult) and result.final_response == "PLANNING_REPLY"
        a, b = runtime.model.captured()
        assert _GUIDANCE not in _effective_system(a)
        assert _GUIDANCE in _effective_system(b)
        assert "Design a smaller change." in _request_texts(b)
        _assert_request_permission(b, "workspace-write", "ask")
    events = _read_events(runtime.logs)
    _command_pair(events, execution, "plan")
    assert [e["data"] for e in _of_type(events, "step/start")] == [{"turn": 1, "step": 1}, {"turn": 1, "step": 2}]
    assert len(_of_type(events, "turn/start")) == 1


@pytest.mark.parametrize("cancel", [False, True])
def test_running_bare_selection_does_not_force_a_step_and_can_be_cancelled(tmp_path: Path, cancel: bool) -> None:
    first = _Completion("FIRST_REPLY", blocked=True)
    with _runtime(tmp_path, [first, _Completion("NEXT_REPLY")], initial_permission="workspace-write") as runtime:
        session = runtime.harness.start_session(_SESSION_ID)
        observing = runtime.workers.submit(session.run, "Start without tools.")
        assert first.entered.wait(_WAIT_SECONDS)
        _command(runtime, session, "/plan")
        if cancel:
            cancelled = _command(runtime, session, "/plan off")
            assert "cancelled" in cancelled.result.text
        assert len(runtime.model.captured()) == 1
        first.release.set()
        assert isinstance(observing.result(timeout=_WAIT_SECONDS), RunResult)
        assert len(runtime.model.captured()) == 1
        assert isinstance(runtime.call(session.run, "Inspect the next task without tools."), RunResult)
        assert (_GUIDANCE in _effective_system(runtime.model.captured()[1])) is (not cancel)
    events = _read_events(runtime.logs)
    assert len(_of_type(events, "turn/start")) == 2
    assert len(_of_type(events, "step/start")) == 2
    assert [e["data"] for e in _of_type(events, "plan/mode")] == ([] if cancel else [{"active": True}])


@pytest.mark.parametrize("first_choice", ["Approve", "Keep planning", "dismiss"])
def test_review_approval_feedback_and_dismissal_keep_native_model_behavior(tmp_path: Path, first_choice: str) -> None:
    seen: list[str] = []
    def answer(request: UserQuestionRequest, cancelled: threading.Event):
        assert not cancelled.is_set()
        seen.append(request.questions[0]["detail"])
        if len(seen) == 1:
            if first_choice == "dismiss":
                return {"cancelled": True}
            return _answer(request, first_choice, "Include rollback." if first_choice == "Keep planning" else None)
        return _answer(request, "Approve")
    completions = [_review()]
    if first_choice == "Keep planning":
        completions.append(_review(_PLAN_REVISED))
    if first_choice != "dismiss":
        completions.append(_Completion("AFTER_APPROVAL"))
    with _runtime(tmp_path, completions, initial_permission="workspace-write", on_user_question=answer) as runtime:
        session = runtime.harness.start_session(_SESSION_ID)
        _command(runtime, session, "/plan Prepare a plan and present it for review.")
        _wait_activity(runtime, session)
        requests = runtime.model.captured()
        assert seen == ([_PLAN, _PLAN_REVISED] if first_choice == "Keep planning" else [_PLAN])
        assert _GUIDANCE in _effective_system(requests[0])
        if first_choice == "Keep planning":
            assert _GUIDANCE in _effective_system(requests[1])
            assert "Include rollback." in str(requests[1]["messages"])
        if first_choice != "dismiss":
            assert _GUIDANCE not in _effective_system(requests[-1])
            assert _tool_names(requests[0]) == _tool_names(requests[-1])
        else:
            assert len(requests) == 1, "dismissal started another model request"
        for request in requests:
            _assert_request_permission(request, "workspace-write", "ask")
    events = _read_events(runtime.logs)
    assert [e["data"]["active"] for e in _of_type(events, "plan/mode")] == ([True] if first_choice == "dismiss" else [True, False])
    assert len(_of_type(events, "turn/start")) == len(_of_type(events, "turn/end")) == 1
    assert len(_permission_facts(events)) == 3
    if first_choice == "dismiss":
        results = _of_type(events, "tool/result")
        assert len(results) == 1
        assert "The user dismissed the plan review" in str(results[0]["data"])


def test_no_review_provider_keeps_plan_mode_and_reports_tool_failure(tmp_path: Path) -> None:
    with _runtime(tmp_path, [_review(), _Completion("REVIEW_UNAVAILABLE")], initial_permission="workspace-write") as runtime:
        session = runtime.harness.start_session(_SESSION_ID)
        _command(runtime, session, "/plan Prepare a plan.")
        _wait_activity(runtime, session)
        first, second = runtime.model.captured()
        assert _GUIDANCE in _effective_system(first) and _GUIDANCE in _effective_system(second)
        assert "no user-questions answerer accepted the request" in str(second["messages"])
        _command(runtime, session, "/plan off")
    events = _read_events(runtime.logs)
    [result] = _of_type(events, "tool/result")
    assert result["data"]["message"]["isError"] is True
    assert result["data"]["error"]["code"] == "NO_PROVIDER"
    assert len(_permission_facts(events)) == 3


def test_plan_state_survives_resume_without_changing_permissions(tmp_path: Path) -> None:
    with _runtime(tmp_path, [], initial_permission="workspace-write") as runtime:
        session = runtime.harness.start_session(_SESSION_ID)
        _command(runtime, session, "/plan")
    with _runtime(tmp_path, [_Completion("RESTORED_PLAN")], initial_permission="workspace-write") as resumed:
        session = resumed.call(resumed.harness.resume_session, _SESSION_ID)
        assert isinstance(resumed.call(session.run, "Continue planning without tools."), RunResult)
        [request] = resumed.model.captured()
        assert _GUIDANCE in _effective_system(request)
        _assert_request_permission(request, "workspace-write", "ask")
    events = _read_events(resumed.logs)
    assert [e["data"] for e in _of_type(events, "plan/mode")] == [{"active": True}]


def test_top_level_plan_result_identifies_the_session_for_wait_continue_and_resume(tmp_path: Path) -> None:
    first = _Completion("PLAN_READY", blocked=True)
    with _runtime(tmp_path, [first, _Completion("CONTINUED_PLAN")], initial_permission="workspace-write") as runtime:
        running = runtime.workers.submit(runtime.harness.run, "/plan Design this change without tools.")
        assert first.entered.wait(_WAIT_SECONDS), runtime.model.failures
        assert not running.done()
        first.release.set()
        execution = running.result(timeout=_WAIT_SECONDS)
        assert isinstance(execution, RunResult)
        assert execution.finish_reason == "completed" and execution.final_response == "PLAN_READY"
        session = runtime.harness.start_session(execution.session_id)
        continued = runtime.call(runtime.harness.run, "Continue this plan without tools.", session_id=execution.session_id)
        assert isinstance(continued, RunResult)
        assert continued.session_id == execution.session_id
        assert continued.final_response == "CONTINUED_PLAN"
        assert "Design this change without tools." in _request_texts(runtime.model.captured()[1])
    with _runtime(tmp_path, [_Completion("RESTORED_PLAN")], initial_permission="workspace-write") as resumed:
        session = resumed.call(resumed.harness.resume_session, execution.session_id)
        result = resumed.call(session.run, "Finish reviewing this plan without tools.")
        assert isinstance(result, RunResult) and result.session_id == execution.session_id
        assert result.final_response == "RESTORED_PLAN"
        [request] = resumed.model.captured()
        assert _GUIDANCE in _effective_system(request)
        assert "Design this change without tools." in _request_texts(request)
        assert "Continue this plan without tools." in _request_texts(request)
    events = _read_events(resumed.logs, session_id=execution.session_id)
    _command_pair(events, execution, "plan")
    assert len(_of_type(events, "turn/start")) == 3


def test_plan_state_is_local_and_literal_prompts_do_not_toggle_it(tmp_path: Path) -> None:
    with _runtime(tmp_path, [_Completion("OTHER"), _Completion("PLANNING"), _Completion("RAW_INPUT")],
                  initial_permission="workspace-write") as runtime:
        session = runtime.harness.start_session(_SESSION_ID)
        _command(runtime, session, "/plan")
        other = runtime.harness.start_session("plan-other")
        assert isinstance(runtime.call(other.run, "Inspect your own task without tools."), RunResult)
        assert isinstance(runtime.call(session.run, "Inspect the plan without tools."), RunResult)
        runtime.call(runtime.harness.client.session_prompt, session.id, [{"type": "text", "text": "/plan off"}])
        _wait_activity(runtime, session)
        first, second, third = runtime.model.captured()
        assert _GUIDANCE not in _effective_system(first)
        assert _GUIDANCE in _effective_system(second)
        assert _GUIDANCE in _effective_system(third)
        assert "/plan off" in _request_texts(third)
    assert not _of_type(_read_events(runtime.logs, session_id="plan-other"), "plan/mode")
    assert [e["data"] for e in _of_type(_read_events(runtime.logs), "plan/mode")] == [{"active": True}]
