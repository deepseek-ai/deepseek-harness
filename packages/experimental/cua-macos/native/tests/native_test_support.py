"""Owned JSONL helper processes shared by opt-in macOS application checks."""
import json
from contextlib import ExitStack
import os
import platform
import shutil
from pathlib import Path
import select
import signal
import subprocess
import time
from typing import Callable

ROOT = Path(__file__).resolve().parents[1]
def default_binary():
    """Resolve the application produced by native/build_app.py for this host."""
    architecture = "arm64" if platform.machine() == "arm64" else "x64"
    directory = ROOT / "bin" / f"darwin-{architecture}"
    receipt = json.loads((directory / "current.json").read_text())
    return directory / receipt["bundle"] / "DSH Computer Use.app/Contents/MacOS/dsh-cua-native"


def copy_helper(binary, destination):
    """Retain the app signature; bare reference binaries remain usable for old-version comparisons."""
    binary = binary.resolve(strict=True)
    application = binary.parent.parent.parent
    if application.suffix == ".app":
        copied = destination / application.name
        shutil.copytree(application, copied)
        return copied / "Contents/MacOS" / binary.name
    copied = destination / "helper"
    shutil.copy2(binary, copied)
    return copied


def unregister_helper(binary):
    """Remove LaunchServices registrations before deleting an owned test application."""
    application = binary.parent.parent.parent
    if application.suffix == ".app":
        subprocess.run(["/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
                        "-u", str(application)], check=True, capture_output=True, timeout=10)


def run_cleanup(*actions: Callable[[], None]) -> None:
    """Attempt every cleanup in order and preserve chained cleanup failures."""
    with ExitStack() as pending:
        for action in reversed(actions):
            pending.callback(action)


def line(process, timeout=15):
    ready, _, _ = select.select([process.stdout], [], [], timeout)
    if not ready:
        raise TimeoutError("native or fixture response timed out")
    output = process.stdout.readline()
    if not output:
        raise RuntimeError("native or fixture exited unexpectedly")
    return output


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def stop_group(process):
    """Stop a process created with start_new_session and await its whole group."""
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        process.wait()
        return
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        process.poll()
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            process.wait()
            return
        time.sleep(0.025)
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait()
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.025)
    raise RuntimeError("owned native fixture process group did not exit")


class NativeHelper:
    """One serial helper whose request transcript remains available on failure."""
    def __init__(self, transcript, helper_path=None):
        binary = Path(helper_path).resolve() if helper_path is not None else default_binary()
        self.process = subprocess.Popen([str(binary)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        text=True, start_new_session=True)
        self.sequence = 0
        self.transcript = transcript

    def call(self, method, params, error_code=None):
        self.sequence += 1
        request = {"id": str(self.sequence), "method": method, "params": params}
        self.process.stdin.write(json.dumps(request) + "\n")
        self.process.stdin.flush()
        result = json.loads(line(self.process))
        self.transcript.append({"request": request, "response": result})
        assert result["id"] == str(self.sequence)
        if error_code:
            assert result.get("error", {}).get("code") == error_code, result
            return result["error"]
        assert "error" not in result, result
        return result["result"]

    def eof(self):
        self.process.stdin.close()
        self.process.wait(timeout=5)
        assert self.process.returncode == 0

    def stop(self):
        try:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                stop_group(self.process)
        finally:
            self.process.stdin.close()
            self.process.stdout.close()
