"""POSIX terminal input and SIGINT cleanup for the plan example."""

import os
from pathlib import Path
import sys

import pytest

from test_plan_input import _run
import test_plan_input


pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX PTYs and SIGINT delivery")


def test_plan_input_preserves_terminal_feedback(tmp_path: Path) -> None:
    assert _run(tmp_path, "k\n继续检查\nd\n".encode(), terminal=True) == [
        {"answers": [{"id": "plan-review", "selected": ["Keep planning"], "custom": "继续检查"}]},
        {"cancelled": True},
    ]


def test_plan_input_preserves_reconfigured_terminal_feedback(tmp_path: Path) -> None:
    assert _run(tmp_path, "k\nréviser\nd\n".encode("latin-1"), terminal=True, stdin_encoding="latin-1") == [
        {"answers": [{"id": "plan-review", "selected": ["Keep planning"], "custom": "réviser"}]},
        {"cancelled": True},
    ]


def test_plan_input_preserves_explicit_utf8_mode_with_ascii_child(tmp_path: Path) -> None:
    env = {**os.environ, "LC_ALL": "C", "PYTHONUTF8": "0", "PYTHONCOERCECLOCALE": "0"}
    env.pop("PYTHONIOENCODING", None)
    assert _run(tmp_path, "k\n继续检查\nd\n".encode("utf-8"), python_args=("-X", "utf8"), env=env) == [
        {"answers": [{"id": "plan-review", "selected": ["Keep planning"], "custom": "继续检查"}]},
        {"cancelled": True},
    ]


@pytest.mark.parametrize("stage", ["choice", "feedback"])
def test_plan_input_interrupt_reaps_open_pipe_reader(tmp_path: Path, stage: str) -> None:
    data = b"k\npartial feedback" if stage == "feedback" else b"partial choice"
    assert _run(tmp_path, data, stage=stage, action="interrupt") == [{"cancelled": True}]
    assert not (tmp_path / "answers.jsonl").exists()


def test_plan_input_cancellation_ignores_inherited_sigterm_disposition(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    wrapper = test_plan_input._WRAPPER.replace(
        "import json\n", "import json\nimport signal\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\n", 1,
    )
    monkeypatch.setattr(test_plan_input, "_WRAPPER", wrapper)
    assert _run(tmp_path, b"partial choice", stage="choice", action="protocol") == [{"cancelled": True}]
