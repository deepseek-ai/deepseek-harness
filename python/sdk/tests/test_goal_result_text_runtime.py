"""Goal run results preserve empty assistant text through the shipped SDK profile."""

from pathlib import Path

from test_commands_runtime import _Completion, _runtime, _SESSION_ID
from test_goal_runtime import _completion_steps


def test_completed_goal_without_assistant_text_returns_empty_result(tmp_path: Path) -> None:
    with _runtime(tmp_path, _completion_steps(_Completion("")),
                  initial_permission="workspace-write") as runtime:
        session = runtime.harness.start_session(_SESSION_ID)
        result = runtime.call(session.run, "/goal Finish the task.")
        assert result.final_response == "" and result.finish_reason == "completed"
        assert any(event["type"] == "goal/change" and event["data"]["operation"] == "complete"
                   for event in result.events)
        cleared = runtime.call(session.run, "/goal clear")
        assert cleared.final_response == "Goal cleared." and cleared.finish_reason == "completed"
        assert len(runtime.model.captured()) == 3


def test_blocked_goal_without_assistant_text_returns_empty_result(tmp_path: Path) -> None:
    with _runtime(tmp_path, [_Completion("")], max_goal_rounds=1) as runtime:
        session = runtime.harness.start_session(_SESSION_ID)
        result = runtime.call(session.run, "/goal Finish the task.")
        assert result.final_response == "" and result.finish_reason == "error"
        assert any(event["type"] == "goal/change" and event["data"]["goal"]["phase"] == "blocked"
                   for event in result.events)
        assert len(runtime.model.captured()) == 1
