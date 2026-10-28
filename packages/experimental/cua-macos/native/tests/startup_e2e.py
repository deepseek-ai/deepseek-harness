"""Check real LaunchServices startup failures with owned apps and no permission prompts."""
import argparse
from contextlib import ExitStack
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import signal
import socket
import subprocess
import tempfile
import time
import uuid

from native_test_support import copy_helper, default_binary, ROOT, unregister_helper
from shared_helper_e2e import Connection, wait_released


def wait_exited(pid):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.01)
    raise AssertionError(f"Startup left owned helper {pid} alive")


def cleanup_fixture(root):
    record = root / "served.pid"
    if record.exists():
        pid = int(record.read_text())
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        wait_exited(pid)


def launch(helper, runtime, timeout_ms, expected_status=1):
    key = hashlib.sha256(helper.read_bytes()).hexdigest()
    start = time.monotonic()
    result = subprocess.run([str(helper), "--ensure-shared", "--runtime-key", key,
                             "--runtime-directory", str(runtime), "--startup-timeout-ms", str(timeout_ms)],
                            capture_output=True, text=True, timeout=timeout_ms / 1000 + 10)
    elapsed = time.monotonic() - start
    try:
        response = json.loads(result.stdout)
    except ValueError as error:
        raise AssertionError((elapsed, result.returncode, result.stdout, result.stderr)) from error
    if result.returncode != expected_status and response.get("type") == "ready":
        os.kill(response["pid"], signal.SIGKILL)
        wait_exited(response["pid"])
    assert result.returncode == expected_status, (result.returncode, response, result.stderr)
    return response, elapsed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--helper", type=Path)
    parser.add_argument("--runtime-source", type=Path, default=ROOT / "Sources/CuaNative/SharedHelperRuntime.swift")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="cua-", dir="/tmp") as temporary, ExitStack() as cleanup:
        root = Path(temporary)
        actual_root = root / "actual"
        actual_root.mkdir()
        helper = copy_helper(args.helper or default_binary(), actual_root)
        cleanup.callback(unregister_helper, helper)
        runtime = root / "r"
        runtime.mkdir(mode=0o700)
        ready, elapsed = launch(helper, runtime, 5000, expected_status=0)
        try:
            client = Connection(runtime / (ready["runtimeKey"] + ".sock"), ready["runtimeKey"])
            client.close()
            wait_released(runtime / (ready["runtimeKey"] + ".lock"), ready["pid"])
        except BaseException:
            try:
                os.kill(ready["pid"], signal.SIGKILL)
            except ProcessLookupError:
                pass
            wait_exited(ready["pid"])
            raise
        print(f"PASS: cold application launch within the default 5s budget, {elapsed:.3f}s", flush=True)
        # Foundation canonicalizes /private/tmp to /tmp; use the lock created by the real server.
        path_locks = list(runtime.glob("path-*.lock"))
        assert len(path_locks) == 1, path_locks
        with path_locks[0].open("r+") as held:
            os.chmod(held.name, 0o600)
            fcntl.flock(held, fcntl.LOCK_EX)
            failure, elapsed = launch(helper, runtime, 10000)
            assert failure["code"] == "NATIVE_RUNTIME_CONFLICT", failure
            assert "close its clients" in failure["message"], failure
            assert elapsed < 5, elapsed
            assert not list(runtime.glob("*.failed")), "Attempt failure record was not removed"
            print(f"PASS: real helper startup cause preserved in {elapsed:.3f}s")

        fixture_root = root / "fixture"
        binary = fixture_root / "Startup.app/Contents/MacOS/startup"
        binary.parent.mkdir(parents=True)
        application = binary.parent.parent.parent
        cleanup.callback(unregister_helper, binary)
        cleanup.callback(cleanup_fixture, fixture_root)
        with (application / "Contents/Info.plist").open("wb") as output:
            plistlib.dump({"CFBundleExecutable": "startup", "CFBundleIdentifier": f"dev.dsh.cua.startup.{uuid.uuid4().hex}",
                          "CFBundlePackageType": "APPL", "LSUIElement": True}, output)
        subprocess.run(["xcrun", "swiftc", "-parse-as-library", "-swift-version", "6",
                        str(ROOT / "tests/StartupFixture.swift"), str(args.runtime_source),
                        str(ROOT / "Sources/CuaNative/Protocol.swift"), "-o", str(binary)], check=True, timeout=90)
        subprocess.run(["codesign", "--force", "--sign", "-", str(application)], check=True, capture_output=True)
        for mode, timeout_ms, expected in [("exit", 10000, "NATIVE_STARTUP"),
                                           ("stall", 1500, "NATIVE_STARTUP_TIMEOUT"),
                                           ("stale", 1500, "NATIVE_STARTUP_TIMEOUT")]:
            (fixture_root / "mode").write_text(mode)
            with ExitStack() as case:
                stale_ready = None
                if mode == "stale":
                    key = hashlib.sha256(binary.read_bytes()).hexdigest()
                    stale_socket = case.enter_context(socket.socket(socket.AF_UNIX, socket.SOCK_STREAM))
                    socket_path = runtime / (key + ".sock")
                    stale_socket.bind(str(socket_path))
                    os.chmod(socket_path, 0o600)
                    case.callback(socket_path.unlink)
                    stale_ready = runtime / (key + ".ready")
                    stale_ready.write_text(json.dumps({"type": "ready", "protocol": 1, "runtimeKey": key,
                                                       "pid": os.getpid(), "instanceId": "stale"}))
                    case.callback(stale_ready.unlink)
                failure, elapsed = launch(binary, runtime, timeout_ms)
                assert failure["code"] == expected, (mode, failure, elapsed)
                if mode == "exit":
                    assert elapsed < 5, elapsed
                pid = int((fixture_root / "served.pid").read_text())
                wait_exited(pid)
                (fixture_root / "served.pid").unlink()
                print(f"PASS: {mode}, {failure['code']}, process exited, {elapsed:.3f}s")


if __name__ == "__main__":
    main()
