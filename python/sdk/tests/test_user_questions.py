from __future__ import annotations

import sys
import threading
from pathlib import Path

import pytest
from pydantic import BaseModel

from deepseek_harness import DeepSeekHarness, HarnessClient, HarnessConfig, UserQuestionRequest
from deepseek_harness.errors import TransportClosedError


class Response(BaseModel):
    answer: dict | None = None
    error: dict | None = None
    cancelled: bool = False
    replies: int = 0
    capabilities: dict | None = None


@pytest.fixture
def runtime(tmp_path: Path) -> Path:
    path = tmp_path / "questions.py"
    path.write_text('''
import json
import sys

pending = {}
replies = 0
capabilities = None
serial = 0

def send(frame):
    print(json.dumps({'jsonrpc': '2.0', **frame}), flush=True)

for line in sys.stdin:
    frame = json.loads(line)
    method = frame.get('method')
    params = frame.get('params') or {}
    if method is None:
        replies += 1
        original = pending.pop(frame['id'], None)
        if original is not None:
            send({'id': original, 'result': {'answer': frame.get('result'), 'error': frame.get('error')}})
    elif method == 'initialize':
        capabilities = params.get('capabilities')
        send({'id': frame['id'], 'result': {'serverInfo': {'name': 'question-peer', 'version': '1'}}})
    elif method == 'ask':
        serial += 1
        wire_id = 'host-' + str(serial)
        pending[wire_id] = frame['id']
        send({'id': wire_id, 'method': 'user-question/ask', 'params': {
            'requestId': params.get('requestId', wire_id), 'sessionId': 'main',
            'questions': params.get('questions', [{'id': 'format', 'question': 'Which format?', 'detail': 'Plan to review',
                'options': [{'label': 'CSV'}], 'intent': {'kind': 'plan-review', 'approve': 'CSV'}}])}})
    elif method == 'cancel':
        send({'method': 'user-question.cancelled', 'params': {'requestId': params['requestId'], 'sessionId': 'main'}})
        for original in pending.values():
            send({'id': original, 'result': {'cancelled': True}})
        pending.clear()
        send({'id': frame['id'], 'result': {}})
    elif method == 'disconnect':
        break
    elif method == 'stats':
        send({'id': frame['id'], 'result': {'replies': replies, 'capabilities': capabilities}})
    elif method == 'shutdown':
        send({'id': frame['id'], 'result': {}})
        break
''')
    return path


def config(callback=None) -> HarnessConfig:
    return HarnessConfig(on_user_question=callback, request_timeout_seconds=5)


def initialize(client: HarnessClient, root: Path) -> None:
    client.initialize(cwd=str(root), provider="mock", model="mock")


def test_callback_preserves_question_metadata_and_answers_without_blocking_reader(runtime: Path, tmp_path: Path) -> None:
    def answer(request: UserQuestionRequest, cancelled: threading.Event):
        assert request.session_id == "main"
        assert request.questions[0]["intent"] == {"kind": "plan-review", "approve": "CSV"}
        assert request.questions[0]["detail"] == "Plan to review"
        assert not cancelled.is_set()
        # Reentrant RPC proves the reader keeps processing while the host decides.
        assert client.request("stats", {}, response_model=Response).capabilities == {"userQuestions": True}
        return {"answers": [{"id": "format", "selected": ["CSV"]}]}

    with HarnessClient(config(answer), _launch_args=(sys.executable, str(runtime))) as client:
        initialize(client, tmp_path)
        result = client.request("ask", {}, response_model=Response)
        assert result.answer == {"answers": [{"id": "format", "selected": ["CSV"]}]}
        assert result.error is None


def test_missing_callback_does_not_advertise_question_support(runtime: Path, tmp_path: Path) -> None:
    with HarnessClient(config(), _launch_args=(sys.executable, str(runtime))) as client:
        initialize(client, tmp_path)
        assert client.request("stats", {}, response_model=Response).capabilities is None


@pytest.mark.parametrize("action", ["cancel", "disconnect", "close"])
def test_cancellation_stops_cooperative_host_work_and_suppresses_late_answer(runtime: Path, tmp_path: Path, action: str) -> None:
    entered = threading.Event()
    stopped = threading.Event()
    errors: list[BaseException] = []

    def answer(request: UserQuestionRequest, cancelled: threading.Event):
        entered.set()
        assert cancelled.wait(5), "callback did not receive cancellation"
        stopped.set()
        return {"answers": [{"id": "format", "selected": ["late"]}]}

    with HarnessClient(config(answer), _launch_args=(sys.executable, str(runtime))) as client:
        initialize(client, tmp_path)

        def ask():
            try:
                client.request("ask", {"requestId": "pending"}, response_model=Response)
            except BaseException as error:
                errors.append(error)

        caller = threading.Thread(target=ask, daemon=True)
        caller.start()
        try:
            assert entered.wait(5)
            with client._lock:
                workers = [thread for _cancelled, thread in client._question_tasks.values()]
            if action == "close":
                client.close()
            else:
                try:
                    client.request(action, {"requestId": "pending"}, response_model=Response)
                except TransportClosedError:
                    assert action == "disconnect"
            assert stopped.wait(5)
            for worker in workers:
                worker.join(5)
                assert not worker.is_alive()
            caller.join(5)
            assert not caller.is_alive()
            if action == "cancel":
                assert client.request("stats", {}, response_model=Response).replies == 0
                assert errors == []
            else:
                assert len(errors) == 1 and isinstance(errors[0], TransportClosedError)
        finally:
            client.close()
            caller.join(5)


def test_callback_failure_is_returned_to_runtime_and_reader_remains_usable(runtime: Path, tmp_path: Path) -> None:
    def answer(_request: UserQuestionRequest, _cancelled: threading.Event):
        raise ValueError("answer service unavailable")

    with HarnessClient(config(answer), _launch_args=(sys.executable, str(runtime))) as client:
        initialize(client, tmp_path)
        result = client.request("ask", {}, response_model=Response)
        assert result.error == {"code": -32603, "message": "answer service unavailable"}
        assert client.request("stats", {}, response_model=Response).replies == 1


def test_high_level_config_installs_the_same_native_callback(runtime: Path, tmp_path: Path) -> None:
    with DeepSeekHarness(
        cwd=str(tmp_path), _launch_args=(sys.executable, str(runtime)),
        on_user_question=lambda _request, _cancelled: {"answers": [{"id": "format", "selected": [], "custom": "JSON"}]},
    ) as harness:
        result = harness.client.request("ask", {}, response_model=Response)
        assert result.answer == {"answers": [{"id": "format", "selected": [], "custom": "JSON"}]}


def test_late_callback_cannot_answer_or_remove_a_new_process_question(runtime: Path, tmp_path: Path) -> None:
    old_entered = threading.Event()
    release_old = threading.Event()
    new_entered = threading.Event()
    stopped = threading.Event()

    def old_answer(_request, cancelled):
        old_entered.set()
        assert release_old.wait(5)
        assert cancelled.is_set()
        return {"answers": [{"id": "format", "selected": ["old"]}]}

    def new_answer(_request, cancelled):
        new_entered.set()
        assert cancelled.wait(5)
        stopped.set()
        return {"answers": [{"id": "format", "selected": ["new"]}]}

    failures = []
    settings = config(old_answer)
    with HarnessClient(settings, _launch_args=(sys.executable, str(runtime))) as client:
        initialize(client, tmp_path)

        def ask():
            try:
                client.request("ask", {"requestId": "reused"}, response_model=Response)
            except TransportClosedError as error:
                failures.append(error)

        old_caller = threading.Thread(target=ask, daemon=True)
        new_caller = threading.Thread(target=ask, daemon=True)
        old_caller.start()
        try:
            assert old_entered.wait(5)
            with client._lock:
                old_worker = client._question_tasks["reused"][1]
            client.close()
            old_caller.join(5)
            assert not old_caller.is_alive()
            settings.on_user_question = new_answer
            client.start()
            initialize(client, tmp_path)
            new_caller.start()
            assert new_entered.wait(5)
            release_old.set()
            old_worker.join(5)
            assert not old_worker.is_alive()
            assert client.request("stats", {}, response_model=Response).replies == 0
            client.request("cancel", {"requestId": "reused"}, response_model=Response)
            assert stopped.wait(5)
            new_caller.join(5)
            assert not new_caller.is_alive()
            assert len(failures) == 1
        finally:
            release_old.set()
            client.close()
            old_caller.join(5)
            if new_caller.ident is not None:
                new_caller.join(5)
