"""Run native command regressions against installed SDK and runtime wheels."""

from __future__ import annotations

import os
import runpy
import sys
import tempfile
from pathlib import Path

import pytest


TEST_FILES = (
    "test_commands_runtime.py",
    "test_command_attachments_runtime.py",
    "test_goal_runtime.py",
    "test_goal_result_text_runtime.py",
    "test_plan_runtime.py",
    "test_plan_example.py",
    "test_plan_input.py",
)


class RequireExecutedTests:
    """Treat skipped collection or execution as a failed installed-wheel check."""

    def __init__(self) -> None:
        self.skipped: set[str] = set()

    def pytest_collectreport(self, report: pytest.CollectReport) -> None:
        if report.skipped:
            self.skipped.add(report.nodeid)

    def pytest_runtest_logreport(self, report: pytest.TestReport) -> None:
        if report.skipped:
            self.skipped.add(report.nodeid)

    def pytest_sessionfinish(self, session: pytest.Session) -> None:
        if self.skipped:
            print("Installed-wheel native tests skipped: " + ", ".join(sorted(self.skipped)), file=sys.stderr)
            session.exitstatus = pytest.ExitCode.TESTS_FAILED


def main() -> int:
    """Verify wheel imports, then run every selected regression without repository pytest configuration."""
    tests = Path(__file__).resolve().parent
    smoke = runpy.run_path(tests.parents[2] / "scripts/smoke-python-runtime.py")
    for name in ("PYTHONPATH", "DSH_RUNTIME_MODE", "PYTEST_ADDOPTS", "PYTEST_PLUGINS"):
        os.environ.pop(name, None)
    os.environ["DSH_COMMANDS_TEST_RUNTIME"] = "installed"
    os.environ["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"
    previous_cwd = Path.cwd()
    with tempfile.TemporaryDirectory(prefix="dsh-sdk-native-") as temporary:
        try:
            os.chdir(temporary)
            smoke["assert_installed_wheel_environment"]()
            config = Path(temporary) / "pytest.ini"
            config.write_text("[pytest]\n", encoding="utf-8")
            return pytest.main([
                "-c", str(config), "--noconftest", "--import-mode=prepend", "-ra",
                *(str(tests / name) for name in TEST_FILES),
            ], plugins=[RequireExecutedTests()])
        finally:
            os.chdir(previous_cwd)


if __name__ == "__main__":
    raise SystemExit(main())
