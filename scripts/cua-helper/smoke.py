"""Query a distributed helper without requesting system permissions or inspecting applications."""
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time


def wait_for_exit(pid, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        time.sleep(0.025)
    return False


def main():
    executable = Path(sys.argv[1]).resolve(strict=True)
    key = hashlib.sha256(executable.read_bytes()).hexdigest()
    pid = None
    with tempfile.TemporaryDirectory(prefix="cua-smoke-", dir="/tmp") as directory:
        os.chmod(directory, 0o700)
        try:
            started = subprocess.run([str(executable), "--ensure-shared", "--runtime-key", key,
                                      "--runtime-directory", directory, "--startup-timeout-ms", "15000"],
                                     check=True, capture_output=True, text=True, timeout=25)
            ready = json.loads(started.stdout)
            assert ready["runtimeKey"] == key and ready["type"] == "ready", ready
            pid = ready["pid"]
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(20)
                connection.connect(f"{directory}/{key}.sock")
                stream = connection.makefile("rwb", buffering=0)
                hello = {"type": "hello", "protocol": 1, "runtimeKey": key, "config": {
                    "maxRequestBytes": 1048576, "maxResponseBytes": 33554432, "axTimeoutMs": 3000,
                    "textEventIntervalMs": 0.25, "maxClickHoldMs": 5000, "screenshotTimeoutMs": 5000,
                    "timeoutMs": 30000, "graceMs": 5000,
                }}
                stream.write((json.dumps(hello) + "\n").encode())
                admitted = json.loads(stream.readline())
                assert admitted["type"] == "ready" and admitted["pid"] == pid, admitted
                for method in ["getCapabilities", "permissionStatus"]:
                    stream.write((json.dumps({"id": method, "method": method, "params": {}}) + "\n").encode())
                    response = json.loads(stream.readline())
                    assert response["id"] == method and "result" in response, response
                    result = response["result"]
                    if method == "getCapabilities":
                        assert result["platform"] == "macos", result
                    else:
                        assert result["launchApplication"]["name"] == "DSH Computer Use.app", result.get("launchApplication", {}).get("name")
                        assert isinstance(result["accessibility"], bool) and isinstance(result["screenRecording"], bool)
                connection.shutdown(socket.SHUT_WR)
                assert stream.read() == b"", "helper did not acknowledge connection cleanup"
                stream.close()
            assert wait_for_exit(pid, 10), "helper remained alive after its final connection closed"
            pid = None
            print("CUA distribution smoke: capabilities, helper identity and cleanup passed")
        finally:
            if pid is not None:
                for action in [signal.SIGTERM, signal.SIGKILL]:
                    try:
                        os.kill(pid, action)
                    except ProcessLookupError:
                        break
                    if wait_for_exit(pid, 5):
                        break
                else:
                    raise RuntimeError("failed helper did not exit during cleanup")
            subprocess.run(["/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
                            "-u", str(executable.parents[2])], check=True, capture_output=True, timeout=10)


if __name__ == "__main__":
    main()
