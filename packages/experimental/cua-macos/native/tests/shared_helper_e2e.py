"""Shared helper process lifetime, scoped handles and request-local screenshot deadlines.

Uses an owned copy of the selected helper and an owned AppKit fixture. Existing
Accessibility/Screen Recording grants are required unless --without-desktop is set.
"""
import argparse
import concurrent.futures
from contextlib import ExitStack
import fcntl
import hashlib
import json
import os
from pathlib import Path
import select
import shutil
import signal
import socket
import subprocess
import tempfile
import time

from native_test_support import BINARY, ROOT, line, stop


CONFIG = {"maxRequestBytes": 1024 * 1024, "maxResponseBytes": 32 * 1024 * 1024,
          "axTimeoutMs": 3000, "textEventIntervalMs": 0.25, "maxClickHoldMs": 5000, "screenshotTimeoutMs": 5000,
          "timeoutMs": 30000, "graceMs": 3000}


class Connection:
    def __init__(self, path, key, **overrides):
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket.settimeout(35)
        self.socket.connect(str(path))
        self.reader = self.socket.makefile("rb")
        self.sequence = 0
        self.diagnostics = []
        self.cleanup_timeout = overrides.get("graceMs", CONFIG["graceMs"]) / 1000
        self.send({"type": "hello", "protocol": 1, "runtimeKey": key, "config": {**CONFIG, **overrides}})
        self.ready = self.read()
        assert self.ready["type"] == "ready", self.ready

    def send(self, value):
        self.socket.sendall(json.dumps(value, separators=(",", ":")).encode() + b"\n")

    def read(self):
        while True:
            data = self.reader.readline()
            if not data:
                raise EOFError("shared helper disconnected")
            value = json.loads(data)
            if value.get("type") == "diagnostic":
                self.diagnostics.append(value)
            else:
                return value

    def call(self, method, params, error=None):
        self.sequence += 1
        identifier = str(self.sequence)
        self.send({"id": identifier, "method": method, "params": params})
        reply = self.read()
        assert reply["id"] == identifier, reply
        if error:
            assert reply.get("error", {}).get("code") == error, reply
            return reply["error"]
        assert "result" in reply, reply
        return reply["result"]

    def close(self):
        if self.socket.fileno() < 0:
            return
        try:
            self.socket.settimeout(self.cleanup_timeout)
            self.socket.shutdown(socket.SHUT_WR)
            while self.reader.readline():
                pass
        finally:
            self.reader.close()
            self.socket.close()


def wait_released(path, pid, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with open(path, "r+b") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    return
        except BlockingIOError:
            pass
        time.sleep(0.02)
    raise AssertionError(f"Owned shared helper {pid} or its version lock did not exit")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--helper", type=Path, default=BINARY)
    parser.add_argument("--without-desktop", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="cua-", dir="/tmp") as temporary:
        root = Path(temporary)
        helper = root / "helper"
        shutil.copy2(args.helper.resolve(strict=True), helper)
        key = hashlib.sha256(helper.read_bytes()).hexdigest()
        runtime = root / "r"
        socket_path = runtime / (key + ".sock")
        lock_path = runtime / (key + ".lock")
        base = [str(helper), "--runtime-key", key, "--runtime-directory", str(runtime), "--startup-timeout-ms", "10000"]

        def launch():
            result = subprocess.run([base[0], "--ensure-shared", *base[1:]], check=True,
                                    capture_output=True, text=True, timeout=15, start_new_session=True)
            return json.loads(result.stdout)

        clients = []
        fixture = None
        owner_pid = None
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as workers:
                ready = list(workers.map(lambda _: launch(), range(2)))
            assert ready[0] == ready[1], ready
            owner_pid = ready[0]["pid"]
            a = Connection(socket_path, key)
            b = Connection(socket_path, key)
            clients.extend([a, b])
            assert a.ready == b.ready == ready[0]
            for client in clients:
                client.call("protocol-unsupported", {}, error="UNSUPPORTED")
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as invalid:
                invalid.settimeout(15)
                invalid.connect(str(socket_path))
                invalid.sendall(b'{"type":"hello","protocol":2}\n')
                with invalid.makefile("rb") as reader:
                    failure = json.loads(reader.readline())
                    assert failure["type"] == "error" and failure["code"] == "NATIVE_PROTOCOL", failure
                    assert reader.readline() == b"", "Rejected handshake retained its connection"
            b.call("protocol-after-invalid-hello", {}, error="UNSUPPORTED")
            # Coalesced frames retain socket order, including cancellation before execution starts.
            a.socket.sendall(b'{"id":"coalesced","method":"listApps","params":{}}\n'
                             b'{"type":"cancel","id":"coalesced"}\n')
            coalesced = a.read()
            assert coalesced["id"] == "coalesced", coalesced
            assert "result" in coalesced or coalesced.get("error", {}).get("code") == "NATIVE_CANCELLED", coalesced
            a.call("protocol-after-cancel", {}, error="UNSUPPORTED")
            queued = Connection(socket_path, key)
            clients.append(queued)
            queued.socket.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
            identifier = "shared-call"
            queued.send({"id": identifier, "method": "unsupported-" + "x" * (512 * 1024), "params": {}})
            assert select.select([queued.socket], [], [], 5)[0], "First reply did not begin"
            # The large unread reply holds the writer while a same-ID operation and cancellation arrive.
            queued.socket.sendall(json.dumps({"id": identifier, "method": "getCapabilities", "params": {}}).encode() + b"\n"
                                  + json.dumps({"type": "cancel", "id": identifier}).encode() + b"\n")
            first_reply = queued.read()
            assert first_reply.get("id") == identifier and first_reply.get("error", {}).get("code") == "UNSUPPORTED"
            second_reply = queued.read()
            assert second_reply.get("id") == identifier and second_reply.get("error", {}).get("code") == "NATIVE_CANCELLED", second_reply
            queued.send({"type": "cancel", "id": identifier})
            queued.call("protocol-after-late-cancel", {}, error="UNSUPPORTED")
            queued.close()
            clients.remove(queued)
            if not args.without_desktop:
                executable = root / "fixture"
                state = root / "state.json"
                subprocess.run(["xcrun", "swiftc", str(ROOT / "tests/Fixture.swift"), "-o", str(executable)], check=True)
                fixture = subprocess.Popen([str(executable), str(state)], stdout=subprocess.PIPE, text=True)
                assert line(fixture).strip() == "READY"
                capabilities = a.call("getCapabilities", {})
                assert capabilities["permissions"] == {"accessibility": True, "screenRecording": True}, capabilities
                app_a = a.call("getApp", {"selector": str(fixture.pid)})["appHandle"]
                app_b = b.call("getApp", {"selector": str(fixture.pid)})["appHandle"]
                assert app_a != app_b
                b.call("listWindows", {"appHandle": app_a}, error="STALE_APP")
                settle_until = time.monotonic() + 5
                while True:
                    windows = a.call("listWindows", {"appHandle": app_a})
                    primary = next(value for value in windows if value["title"] == "DSH CUA primary fixture")
                    size = [primary["bounds"]["width"], primary["bounds"]["height"]]
                    if size == json.loads(state.read_text())["primaryWindowSize"]:
                        break
                    assert time.monotonic() < settle_until, "Fixture window geometry did not settle"
                    time.sleep(0.025)
                window = primary["windowId"]
                observed = a.call("getState", {"appHandle": app_a, "windowId": window, "maxElements": 300, "maxDepth": 20})
                b.call("click", {"appHandle": app_b, "snapshotId": observed["snapshotId"], "elementIndex": 0}, error="STALE_SNAPSHOT")
                own_observation = b.call("getState", {"appHandle": app_b, "windowId": window, "maxElements": 300, "maxDepth": 20})
                button = next(element for element in own_observation["elements"]
                              if element["role"] == "AXButton" and element["title"] == "Increment primary")
                before = json.loads(state.read_text())["count"]
                b.call("click", {"appHandle": app_b, "snapshotId": own_observation["snapshotId"], "elementIndex": button["index"]})
                changed_until = time.monotonic() + 5
                while json.loads(state.read_text())["count"] != before + 1:
                    assert time.monotonic() < changed_until, "B input did not update the fixture exactly once"
                    time.sleep(0.025)
                after = a.call("getState", {"appHandle": app_a, "windowId": window, "maxElements": 300, "maxDepth": 20})
                assert f"Count: {before + 1}" in after["tree"], "A retained handle did not observe B's input"

                def capture(pair):
                    client, handle = pair
                    result = client.call("screenshot", {"appHandle": handle, "windowId": window})
                    assert result["mimeType"] == "image/png" and result["pixelWidth"] > 0, result
                    return result["pixelWidth"], result["pixelHeight"]

                for _ in range(3):
                    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as workers:
                        sizes = list(workers.map(capture, [(a, app_a), (b, app_b)]))
                    assert sizes[0] == sizes[1], sizes
                timed = Connection(socket_path, key, screenshotTimeoutMs=1)
                clients.append(timed)
                timed_handle = timed.call("getApp", {"selector": str(fixture.pid)})["appHandle"]
                timed.call("screenshot", {"appHandle": timed_handle, "windowId": window}, error="NATIVE_TIMEOUT")
                assert timed.call("listWindows", {"appHandle": timed_handle})
                assert b.call("listWindows", {"appHandle": app_b})
                timed.close()
                clients.remove(timed)
            a.close()
            clients.remove(a)
            b.call("protocol-still-open", {}, error="UNSUPPORTED")
            assert b.ready["pid"] == owner_pid
            if not args.without_desktop:
                assert b.call("listWindows", {"appHandle": app_b})
                capture((b, app_b))
            b.close()
            clients.remove(b)
            wait_released(lock_path, owner_pid)
            owner_pid = None

            for shutdown in ["signal", "incomplete-hello", "idle"]:
                serve_options = base[1:] if shutdown != "idle" else [*base[1:-1], "100"]
                daemon = subprocess.Popen([base[0], "--serve", *serve_options], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    with ExitStack() as connections:
                        assert select.select([daemon.stdout], [], [], 15)[0], "Daemon did not report ready"
                        signalled_ready = json.loads(daemon.stdout.readline())
                        assert signalled_ready["type"] == "ready", signalled_ready
                        if shutdown == "incomplete-hello":
                            pending = connections.enter_context(socket.socket(socket.AF_UNIX, socket.SOCK_STREAM))
                            pending.settimeout(15)
                            pending.connect(str(socket_path))
                            pending.sendall(b'{"type":"hello"')
                            # A later completed handshake observes the accept loop progressing past this socket.
                            active = Connection(socket_path, key)
                            connections.callback(active.socket.close)
                            connections.callback(active.reader.close)
                        if shutdown != "idle":
                            daemon.send_signal(signal.SIGTERM)
                        status = daemon.wait(timeout=15)
                        expected_status = 0 if shutdown == "idle" else 128 + signal.SIGTERM
                        assert status == expected_status, (status, daemon.stderr.read())
                        wait_released(lock_path, daemon.pid)
                        # The forced-exit deadline does not unlink these files; require normal cleanup.
                        assert not socket_path.exists(), "Shutdown left its listening socket"
                        assert not (runtime / (key + ".ready")).exists(), "Shutdown left its ready record"
                        if shutdown == "incomplete-hello":
                            assert pending.recv(1) == b"", "Signal shutdown retained an incomplete handshake"
                finally:
                    stop(daemon)
                    daemon.stdout.close()
                    daemon.stderr.close()
            print("PASS: concurrent launch, shared PID, client isolation, rejected/incomplete handshakes, cleanup/lock release, SIGTERM and idle exit")
        finally:
            errors = []
            for client in reversed(clients):
                try:
                    client.close()
                except Exception as error:
                    errors.append(error)
            if fixture is not None:
                stop(fixture)
                fixture.stdout.close()
            if owner_pid is not None:
                try:
                    wait_released(lock_path, owner_pid)
                except Exception as error:
                    errors.append(error)
            if errors:
                raise RuntimeError(f"Shared-helper cleanup failed: {errors}")


if __name__ == "__main__":
    main()
