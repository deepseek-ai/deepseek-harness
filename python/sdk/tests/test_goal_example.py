"""Goal observation deadlines and runtime cleanup through the runnable example."""

from __future__ import annotations

import json
import runpy
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from deepseek_harness import DeepSeekHarness


_EXAMPLE = Path(__file__).resolve().parents[1] / "examples/goal.py"


@pytest.mark.parametrize("pending", ["command", "activity", "complete", "error", "interrupt"])
def test_goal_example_bounds_the_whole_run_and_reaps_runtime(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], pending: str,
) -> None:
    peer = tmp_path / "goal-peer.py"
    observed = tmp_path / "observed.jsonl"
    peer.write_text('''import json
import sys
from pathlib import Path

pending, observed = sys.argv[1:]

def send(frame):
    print(json.dumps({"jsonrpc": "2.0", **frame}), flush=True)

for line in sys.stdin:
    frame = json.loads(line)
    with Path(observed).open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(frame) + "\\n")
    method = frame["method"]
    if method == "initialize":
        send({"id": frame["id"], "result": {"serverInfo": {"name": "goal-example-peer"}}})
    elif method == "session/query":
        assert frame["params"]["contentBlocks"] == [{"type": "text", "text": "/goal Finish this task"}]
        if pending == "command":
            continue
        session = frame["params"]["sessionId"]
        for kind in ("command/run", "command/done"):
            send({"method": "session.event", "params": {"sessionId": session, "event": {
                "type": kind, "data": {"commandId": "goal-command"}}}})
        send({"id": frame["id"], "result": {"kind": "command", "execution": {
            "commandId": "goal-command", "result": {"kind": "success", "text": "Goal set"}}}})
        if pending in ("activity", "interrupt"):
            continue
        if pending == "complete":
            send({"method": "session.event", "params": {"sessionId": session, "event": {
                "type": "goal/change", "data": {"operation": "complete"}}}})
            send({"method": "session.event", "params": {"sessionId": session, "event": {
                "type": "assistant/message", "data": {"message": {
                    "content": [{"type": "text", "text": "Closing reply"}]}}}}})
        send({"method": "session.query.completed", "params": {"sessionId": session,
            "commandId": "goal-command", "finalResponse": "Closing reply" if pending == "complete" else "Goal stopped",
            "finishReason": "completed" if pending == "complete" else "error"}})
    elif method == "shutdown":
        send({"id": frame["id"], "result": {}})
        break
    else:
        raise AssertionError(method)
''', encoding="utf-8")
    example = runpy.run_path(str(_EXAMPLE))
    harnesses: list[DeepSeekHarness] = []

    def configured_harness(**options: object) -> DeepSeekHarness:
        harness = DeepSeekHarness(
            **options, _launch_args=(sys.executable, str(peer), pending, str(observed)),
            initialize_timeout_seconds=10, shutdown_timeout_seconds=10,
        )
        harnesses.append(harness)
        return harness

    monkeypatch.setitem(example["main"].__globals__, "DeepSeekHarness", configured_harness)
    if pending == "interrupt":
        entered = threading.Event()
        display = example["display"]
        def observe(notice):
            if notice.method == "session.event" and notice.payload["event"]["type"] == "command/done":
                entered.set()
            return display(notice)
        class InterruptedExecutor(ThreadPoolExecutor):
            def submit(self, *args, **kwargs):
                future = super().submit(*args, **kwargs)
                def interrupt(timeout=None):
                    assert entered.wait(10), "command must be observed before interrupting its wait"
                    raise KeyboardInterrupt
                monkeypatch.setattr(future, "result", interrupt)
                return future
        monkeypatch.setitem(example["main"].__globals__, "display", observe)
        monkeypatch.setitem(example["main"].__globals__, "ThreadPoolExecutor", InterruptedExecutor)
    timeout = "1" if pending in {"command", "activity"} else "10"
    monkeypatch.setattr(sys, "argv", [str(_EXAMPLE), "--dsh-home", str(tmp_path / "home"),
                                     "--workspace", str(tmp_path), "--timeout-seconds", timeout, "Finish this task"])
    with ThreadPoolExecutor(max_workers=1) as workers:
        execution = workers.submit(example["main"])
        try:
            if pending in {"command", "activity"}:
                with pytest.raises(TimeoutError, match="Goal observation timed out"):
                    execution.result(timeout=30)
            elif pending == "interrupt":
                with pytest.raises(KeyboardInterrupt):
                    execution.result(timeout=30)
            elif pending == "error":
                with pytest.raises(RuntimeError, match="Goal stopped"):
                    execution.result(timeout=30)
            else:
                execution.result(timeout=30)
        finally:
            for harness in harnesses:
                harness.close()
    [harness] = harnesses
    assert harness.client._proc is None
    frames = [json.loads(line) for line in observed.read_text(encoding="utf-8").splitlines()]
    assert [frame["method"] for frame in frames] == ["initialize", "session/query", "shutdown"]
    if pending == "complete":
        output = capsys.readouterr().out
        assert "Goal: complete" in output
        assert "Closing reply" in output


@pytest.mark.parametrize("timeout", ["0", "-1", "nan", "inf", "-inf"])
def test_goal_example_rejects_unbounded_or_nonpositive_timeout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], timeout: str,
) -> None:
    example = runpy.run_path(str(_EXAMPLE))
    monkeypatch.setattr(sys, "argv", [str(_EXAMPLE), "--dsh-home", str(tmp_path / "home"),
                                     f"--timeout-seconds={timeout}", "Finish this task"])
    with pytest.raises(SystemExit) as error:
        example["main"]()
    assert error.value.code == 2
    assert "timeout-seconds must be finite and positive" in capsys.readouterr().err
