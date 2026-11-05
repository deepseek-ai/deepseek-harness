"""Run the plan example against the SDK profile with controlled model replies."""

from __future__ import annotations

import json
import runpy
import sys
from pathlib import Path

import pytest

from deepseek_harness import DeepSeekHarness, Notification
import test_commands_runtime as runtime_helpers
from test_commands_runtime import _Completion, _ModelServer, _dsh_bin, _of_type, _read_events


_EXAMPLE = Path(__file__).resolve().parents[1] / "examples/plan.py"
_PLAN = "# Small change\n\n- Inspect the code.\n- Implement after approval."


@pytest.mark.parametrize("outcome", ["max-tokens", "dismiss"])
def test_plan_example_reports_truncation_and_accepts_explicit_dismissal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], outcome: str,
) -> None:
    example = runpy.run_path(str(_EXAMPLE))
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    logs = tmp_path / "sessions"
    patch = tmp_path / "persistence.yml"
    patch.write_text(
        "- id: session-persistence-jsonl\n  config:\n    root: " + json.dumps(str(logs))
        + "\n    compression: none\n", encoding="utf-8",
    )
    completion = (_Completion("PARTIAL_PLAN") if outcome == "max-tokens"
                  else _Completion("", tool_call=("exit_plan_mode", {"plan": _PLAN})))
    if outcome == "max-tokens":
        response = runtime_helpers._messages_response

        def truncated_response(*args: object) -> bytes:
            return response(*args).replace(b'"stop_reason": "end_turn"', b'"stop_reason": "max_tokens"')

        monkeypatch.setattr(runtime_helpers, "_messages_response", truncated_response)
    terminal_input = tmp_path / "stdin.txt"
    terminal_input.write_text("d\n", encoding="utf-8")
    monkeypatch.setenv("DSH_TELEMETRY_DISABLED", "1")
    monkeypatch.setenv("DSH_TOOLS_MODE", "native")
    monkeypatch.setattr(sys, "argv", [str(_EXAMPLE), "--dsh-home", str(tmp_path / "home"),
                                     "--workspace", str(workspace), "Plan a small change."])
    with terminal_input.open(encoding="utf-8") as terminal, _ModelServer([completion]) as model:
        monkeypatch.setattr(sys, "stdin", terminal)
        def configured_harness(**options: object) -> DeepSeekHarness:
            return DeepSeekHarness(
                **options, dsh_bin=_dsh_bin(), patches=(str(patch),),
                base_url=model.url, api_key="keyless-plan-example",
                initialize_timeout_seconds=30, request_timeout_seconds=20, shutdown_timeout_seconds=20,
            )

        monkeypatch.setitem(example["main"].__globals__, "DeepSeekHarness", configured_harness)
        if outcome == "max-tokens":
            with pytest.raises(RuntimeError, match="max-tokens"):
                example["main"]()
        else:
            example["main"]()
        assert len(model.captured()) == 1
    [log] = logs.rglob("session*.jsonl")
    session_id = json.loads(log.read_text(encoding="utf-8").splitlines()[0])["id"]
    events = _read_events(logs, session_id=session_id)
    assert [event["data"]["reason"]["kind"] for event in _of_type(events, "turn/end")] == [
        "max-tokens" if outcome == "max-tokens" else "completed",
    ]
    assert [event["data"] for event in _of_type(events, "plan/mode")] == [{"active": True}]
    output = capsys.readouterr().out
    assert ("[a] Approve" in output) == (outcome == "dismiss")
    assert ("PARTIAL_PLAN" if outcome == "max-tokens" else _PLAN) in output


def test_plan_display_rejects_root_abort_without_rejecting_descendant_abort() -> None:
    display = runpy.run_path(str(_EXAMPLE))["display"]
    event = {"type": "turn/end", "data": {"turn": 1, "reason": {"kind": "aborted"}}}
    display(Notification(method="session.event", payload={"sessionId": "child", "event": event}), "root")
    with pytest.raises(RuntimeError, match="aborted"):
        display(Notification(method="session.event", payload={"sessionId": "root", "event": event}), "root")
