"""Encoded command images retain desktop command rules through the shipped SDK profile."""

from __future__ import annotations

import base64
import hashlib
import threading
from pathlib import Path

import pytest

from deepseek_harness.models import CommandExecution
from deepseek_harness import RunResult
from deepseek_harness.errors import JsonRpcError
from test_commands_runtime import (
    _Completion, _SESSION_ID, _WAIT_SECONDS, _command_pair, _native_result, _of_type,
    _read_events, _request_texts, _runtime, _wait_activity,
)
from test_goal_runtime import _command, _until
from test_plan_runtime import _GUIDANCE, _effective_system


_IMAGE_MODEL = "deepseek-flash"
_RED = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="
_BLUE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg=="


def _image(name: str = "reference.png", data: str = _RED) -> dict:
    return {"type": "image", "data": data, "mimeType": "image/png", "name": name}


def _request_images(request: dict) -> list[dict]:
    return [block for message in request["messages"] for block in message["content"]
            if block["type"] == "image"]


def _assert_request_images(request: dict, *images: dict) -> None:
    assert _request_images(request) == [
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": image["data"]}}
        for image in images
    ]


def _image_messages(events: list[dict]) -> list[dict]:
    return [event for event in _of_type(events, "user/message")
            if any(block["type"] == "image" for block in event["data"]["content"])]


def _assert_durable_image(block: dict, image: dict) -> None:
    data = base64.b64decode(image["data"])
    assert block == {"type": "image", "attachment": {
        "attachmentId": "sha256:" + hashlib.sha256(data).hexdigest(),
        "mediaType": "image/png", "width": 1, "height": 1,
        "bytes": len(data), "name": image["name"],
    }}


@pytest.mark.parametrize("line,body,image_first", [
    ("/plan Describe this picture.", "Describe this picture.", False), ("/plan", "", True),
])
def test_plan_image_reaches_the_model_and_persists_as_a_reference(
    tmp_path: Path, line: str, body: str, image_first: bool,
) -> None:
    picture = _image()
    text = {"type": "text", "text": line}
    content = [picture, text] if image_first else [text, picture]
    with _runtime(tmp_path, [_Completion("IMAGE_PLAN_READY")], model=_IMAGE_MODEL) as runtime:
        session = runtime.harness.start_session(_SESSION_ID)
        execution = runtime.call(session.run, content)
        assert isinstance(execution, RunResult)
        assert execution.finish_reason == "completed" and execution.final_response == "IMAGE_PLAN_READY"
        _wait_activity(runtime, session)
        [request] = runtime.model.captured()
        _assert_request_images(request, picture)
        assert _GUIDANCE in _effective_system(request)
        assert line not in _request_texts(request)
        if body:
            assert body in _request_texts(request)
    events = _read_events(runtime.logs)
    _command_pair(events, execution, "plan")
    assert [event["data"] for event in _of_type(events, "plan/mode")] == [{"active": True}]
    [message] = _image_messages(events)
    content = message["data"]["content"]
    _assert_durable_image(content[0], picture)
    assert content[1:] == ([{"type": "text", "text": body}] if body else [])
    digest = content[0]["attachment"]["attachmentId"].removeprefix("sha256:")
    stored = tmp_path / "home" / "attachments" / "v1" / "objects" / digest[:2] / digest
    assert stored.read_bytes() == base64.b64decode(picture["data"])


def test_plan_off_compact_and_permission_reject_images_without_applying_the_command(tmp_path: Path) -> None:
    picture = _image()
    with _runtime(tmp_path, [], model=_IMAGE_MODEL, initial_permission="workspace-write") as runtime:
        session = runtime.harness.start_session(_SESSION_ID)
        _command(runtime, session, "/plan")
        executions = []
        for line in ["/plan off", "/compact", "/permission danger-full-access"]:
            execution = runtime.call(session.run, [{"type": "text", "text": line}, picture])
            assert isinstance(execution, RunResult)
            assert execution.finish_reason == "error"
            execution = _native_result(execution)
            assert "attachment" in execution.result.text.lower()
            executions.append((line.split()[0][1:], execution))
        assert "Plan mode off" in _command(runtime, session, "/plan off").result.text
        assert runtime.model.captured() == []
    events = _read_events(runtime.logs)
    for name, execution in executions:
        _command_pair(events, execution, name)
        start = next(event["seq"] for event in _of_type(events, "command/run")
                     if event["data"]["commandId"] == execution.command_id)
        done = next(event["seq"] for event in _of_type(events, "command/done")
                    if event["data"]["commandId"] == execution.command_id)
        assert events[start + 1:done] == []
    assert [event["data"] for event in _of_type(events, "plan/mode")] == [{"active": True}, {"active": False}]
    assert [event["data"] for event in _of_type(events, "permission/preset")] == [{"preset": "workspace-write"}]
    assert not _image_messages(events) and not _of_type(events, "turn/start")


def test_goal_create_and_edit_images_reach_following_requests_as_durable_references(tmp_path: Path) -> None:
    original = _image("original.png")
    revised = _image("revised.png", _BLUE)
    first = _Completion("ORIGINAL_GOAL_IMAGE", blocked=True)
    second = _Completion("REVISED_GOAL_IMAGE", blocked=True)
    with _runtime(tmp_path, [first, second], model=_IMAGE_MODEL) as runtime:
        session = runtime.harness.start_session(_SESSION_ID)
        created = runtime.call(runtime.harness.client._query, session.id, [original, {"type": "text", "text": "/goal Inspect the original picture."}])
        assert isinstance(created, CommandExecution) and created.result.kind == "success"
        assert first.entered.wait(_WAIT_SECONDS), runtime.model.failures
        edited = runtime.call(runtime.harness.client._query, session.id, [revised, {"type": "text", "text": "/goal edit Inspect the revised picture."}])
        assert isinstance(edited, CommandExecution) and edited.result.kind == "success"
        _command(runtime, session, "/goal clear")
        assert not first.release.is_set()
        first.release.set()
        assert second.entered.wait(_WAIT_SECONDS), runtime.model.failures
        second.release.set()
        _wait_activity(runtime, session)
        before, after = runtime.model.captured()
        _assert_request_images(before, original)
        _assert_request_images(after, original, revised)
        assert "Reference attachments for the goal objective." in _request_texts(before)
        assert "Reference attachments for the goal objective." in _request_texts(after)
    events = _read_events(runtime.logs)
    _command_pair(events, created, "goal")
    _command_pair(events, edited, "goal")
    changes = _of_type(events, "goal/change")
    assert [event["data"]["operation"] for event in changes] == ["create", "edit", "clear"]
    assert changes[1]["data"]["goal"]["objective"] == "Inspect the revised picture."
    messages = _image_messages(events)
    assert len(messages) == 2
    for message, picture in zip(messages, [original, revised]):
        _assert_durable_image(message["data"]["content"][0], picture)
        assert message["data"]["content"][1:] == [{
            "type": "text", "text": "Reference attachments for the goal objective.",
        }]


def test_cleared_goal_waits_for_its_image_input_queued_during_compaction(tmp_path: Path) -> None:
    picture = _image()
    summary = _Completion("Retain the earlier task.", blocked=True)
    reply = _Completion("REFERENCE_INPUT_REPLY", blocked=True)
    with _runtime(tmp_path, [_Completion("EARLIER_REPLY"), summary, reply], model=_IMAGE_MODEL) as runtime:
        session = runtime.harness.start_session(_SESSION_ID)
        runtime.call(session.run, "Retain this earlier task. " * 256)
        compacting = runtime.workers.submit(session.run, "/compact")
        assert summary.entered.wait(_WAIT_SECONDS), runtime.model.failures
        with runtime.harness.client.subscribe_session_notifications(session.id) as notices:
            running = runtime.workers.submit(session.run, [
                {"type": "text", "text": "/goal Inspect the reference."}, picture,
            ])
            _until(notices, "goal/change", "create")
            cleared = session.run("/goal clear")
            assert cleared.finish_reason == "completed" and cleared.final_response == "Goal cleared."
            summary.release.set()
            assert compacting.result(timeout=_WAIT_SECONDS).finish_reason == "completed"
            assert reply.entered.wait(_WAIT_SECONDS), runtime.model.failures
            assert not running.done()
            _assert_request_images(runtime.model.captured()[-1], picture)
            reply.release.set()
            result = running.result(timeout=_WAIT_SECONDS)
            assert result.finish_reason == "aborted" and result.final_response == "REFERENCE_INPUT_REPLY"
    events = _read_events(runtime.logs)
    _command_pair(events, result, "goal")
    assert [event["data"]["operation"] for event in _of_type(events, "goal/change")] == ["create", "clear"]


def test_goal_controls_with_images_leave_the_active_request_and_goal_unchanged(tmp_path: Path) -> None:
    first = _Completion("CURRENT_GOAL_REQUEST_FINISHED", blocked=True)
    with _runtime(tmp_path, [first], model=_IMAGE_MODEL) as runtime:
        session = runtime.harness.start_session(_SESSION_ID)
        with runtime.harness.client.subscribe_session_notifications(session.id) as notices:
            _command(runtime, session, "/goal Keep the current goal.")
            assert first.entered.wait(_WAIT_SECONDS), runtime.model.failures
            rejected = []
            for line in ["/goal", "/goal pause", "/goal resume", "/goal clear", "/goal edit", "/goal Duplicate goal"]:
                execution = runtime.call(session.run, [{"type": "text", "text": line}, _image()])
                assert isinstance(execution, RunResult) and execution.finish_reason == "error"
                execution = _native_result(execution)
                rejected.append(execution)
            assert "Status: active" in _command(runtime, session, "/goal").result.text
            assert not first.release.is_set() and len(runtime.model.captured()) == 1
            _command(runtime, session, "/goal clear")
            first.release.set()
            _wait_activity(runtime, session)
            assert _until(notices, "turn/end")["reason"]["kind"] == "completed"
        assert len(runtime.model.captured()) == 1
    events = _read_events(runtime.logs)
    for execution in rejected:
        _command_pair(events, execution, "goal")
    assert [event["data"]["operation"] for event in _of_type(events, "goal/change")] == ["create", "clear"]
    assert not _image_messages(events)


@pytest.mark.parametrize("image_first", [False, True])
def test_prompt_images_queue_during_an_active_turn(tmp_path: Path, image_first: bool) -> None:
    picture = _image()
    text = {"type": "text", "text": "Inspect the image."}
    content = [picture, text] if image_first else [text, picture]
    first = _Completion("BEFORE_IMAGE", blocked=True)
    with _runtime(tmp_path, [first, _Completion("IMAGE_RECEIVED")], model=_IMAGE_MODEL) as runtime:
        session = runtime.harness.start_session(_SESSION_ID)
        running = runtime.workers.submit(session.run, "Start without an image.")
        assert first.entered.wait(_WAIT_SECONDS), runtime.model.failures
        accepted = threading.Event()
        following = runtime.workers.submit(
            session.run, content,
            on_notification=lambda _notification: accepted.set(),
        )
        assert accepted.wait(_WAIT_SECONDS), "image prompt did not reach its inbox receipt"
        assert not first.release.is_set() and not following.done()
        first.release.set()
        assert isinstance(running.result(timeout=_WAIT_SECONDS), RunResult)
        result = following.result(timeout=_WAIT_SECONDS)
        assert isinstance(result, RunResult) and result.final_response == "IMAGE_RECEIVED"
        before, after = runtime.model.captured()
        _assert_request_images(before)
        _assert_request_images(after, picture)
    events = _read_events(runtime.logs)
    [message] = _image_messages(events)
    recorded = message["data"]["content"]
    _assert_durable_image(next(block for block in recorded if block["type"] == "image"), picture)
    assert [block["type"] for block in recorded] == [block["type"] for block in content]
    assert [block for block in recorded if block["type"] == "text"] == [text]
    assert not _of_type(events, "command/run")
    assert [event["data"] for event in _of_type(events, "step/start")] == [
        {"turn": 1, "step": 1}, {"turn": 2, "step": 1},
    ]


def test_top_level_run_accepts_an_image_without_text(tmp_path: Path) -> None:
    picture = _image()
    with _runtime(tmp_path, [_Completion("IMAGE_ONLY_REPLY")], model=_IMAGE_MODEL) as runtime:
        result = runtime.call(runtime.harness.run, [picture], session_id=_SESSION_ID)
        assert isinstance(result, RunResult) and result.final_response == "IMAGE_ONLY_REPLY"
        [request] = runtime.model.captured()
        _assert_request_images(request, picture)
    [message] = _image_messages(_read_events(runtime.logs))
    [block] = message["data"]["content"]
    _assert_durable_image(block, picture)


def test_invalid_image_batch_cannot_enter_plan_mode_or_deliver_a_partial_prompt(tmp_path: Path) -> None:
    images = [_image(), _image("invalid.png", "not canonical base64")]
    with _runtime(tmp_path, [], model=_IMAGE_MODEL) as runtime:
        session = runtime.harness.start_session(_SESSION_ID)
        with pytest.raises(JsonRpcError) as ambiguous:
            runtime.call(session.run, [
                {"type": "text", "text": "/plan off"}, _image(),
                {"type": "text", "text": "This is separate text, not another command argument."},
            ])
        assert "command" in str(ambiguous.value).lower()
        rejected = runtime.call(session.run, [{"type": "text", "text": "/plan Inspect the pictures."}, *images])
        assert isinstance(rejected, RunResult) and rejected.finish_reason == "error"
        rejected = _native_result(rejected)
        assert "base64" in rejected.result.text
        with pytest.raises(JsonRpcError, match="base64"):
            runtime.call(session.run, [*images, {"type": "text", "text": "Inspect the pictures."}])
        assert "already inactive" in _command(runtime, session, "/plan off").result.text
        assert runtime.model.captured() == []
    events = _read_events(runtime.logs)
    _command_pair(events, rejected, "plan")
    assert len(_of_type(events, "command/run")) == 2
    assert not _of_type(events, "plan/mode")
    assert not _of_type(events, "agent/inbox/spliced")
    assert not _of_type(events, "turn/start")
    assert not _image_messages(events)
