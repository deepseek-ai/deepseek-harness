"""Office interruption terminates the owned process tree before returning to callers."""
from __future__ import annotations

import ntpath
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from deepseek_harness_runtime import _resources


def wait_for_file(path: Path, process: subprocess.Popen, timeout: float = 30) -> None:
    deadline = time.monotonic() + timeout
    while not path.is_file():
        if process.poll() is not None:
            raise AssertionError(f"fixture exited before {path.name}: {process.returncode}")
        if time.monotonic() >= deadline:
            raise TimeoutError(f"fixture never produced {path}")
        time.sleep(0.01)


@pytest.mark.skipif(os.name == "nt", reason="POSIX process groups and SIGINT delivery")
def test_second_interrupt_waits_for_the_entire_office_process_tree(tmp_path: Path) -> None:
    fixture = tmp_path / "office.py"
    ready, interrupted, pidfile = (tmp_path / name for name in ("ready", "interrupted", "pid"))
    fixture.write_text("""import json,os,signal,subprocess,sys
from pathlib import Path
root=Path(sys.argv[1])
(root/'pid').write_text(str(os.getpid()))
signal.signal(signal.SIGINT,lambda *_:(root/'interrupted').touch())
child=subprocess.Popen([sys.executable,'-c',
    "import signal,sys; from pathlib import Path; signal.signal(signal.SIGINT,signal.SIG_IGN); Path(sys.argv[1]).touch(); signal.pause()",str(root/'child-ready')])
(root/'ready').touch()
child.wait()
""", encoding="utf-8")
    code = ("import sys; from deepseek_harness_runtime._resources import run_office_process; "
            f"args=[sys.executable,{str(fixture)!r},{str(tmp_path)!r}]\n"
            "try: run_office_process(args)\n"
            "except KeyboardInterrupt: print('tree terminated',flush=True); sys.exit(73)\n")
    process = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               start_new_session=True, env={**os.environ,
                               "PYTHONPATH": str(Path(_resources.__file__).resolve().parents[1])})
    try:
        wait_for_file(ready, process)
        wait_for_file(tmp_path / "child-ready", process)
        os.kill(process.pid, signal.SIGINT)
        wait_for_file(interrupted, process)
        os.kill(process.pid, signal.SIGINT)
        # The grandchild inherits the captured streams; communicate can finish only after it closes them.
        stdout, stderr = process.communicate(timeout=30)
        assert process.returncode == 73, stderr
        assert stdout == b"tree terminated\n"
    finally:
        if pidfile.is_file():
            try:
                os.killpg(int(pidfile.read_text()), signal.SIGKILL)
            except ProcessLookupError as error:
                # The successful interruption path already terminated this group.
                pass
        if process.poll() is None:
            process.kill()
        process.communicate(timeout=30)


def test_windows_second_interrupt_uses_absolute_taskkill_and_waits(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []

    class Process:
        pid = 73
        returncode = -9
        attempts = 0

        def __enter__(self):
            return self

        def __exit__(self, *_):
            pass

        def communicate(self):
            self.attempts += 1
            if self.attempts < 3:
                raise KeyboardInterrupt
            return b"", b""

    process = Process()

    def popen(arguments, **options):
        assert options == {"stdin": subprocess.DEVNULL, "stdout": subprocess.PIPE,
                           "stderr": subprocess.PIPE, "start_new_session": False}
        return process

    monkeypatch.setattr(_resources, "os", SimpleNamespace(name="nt", path=ntpath, environ={"SystemRoot": r"C:\Windows"}))
    monkeypatch.setattr(_resources, "subprocess", SimpleNamespace(
        Popen=popen, DEVNULL=subprocess.DEVNULL, PIPE=subprocess.PIPE,
        run=lambda arguments, **options: calls.append((arguments, options)),
    ))
    with pytest.raises(KeyboardInterrupt):
        _resources.run_office_process(["node.exe", "cli.js"])
    assert process.attempts == 3
    assert calls == [([r"C:\Windows\System32\taskkill.exe", "/PID", "73", "/T", "/F"],
                      {"stdin": subprocess.DEVNULL, "capture_output": True, "check": False})]
