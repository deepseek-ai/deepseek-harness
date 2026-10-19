"""Opt-in controlled AppKit checks for cold launch, paste, selection and physical input identities."""
import argparse
import base64
import json
import hashlib
import os
from pathlib import Path
import plistlib
import signal
import subprocess
import tempfile
import time
import uuid

from native_test_support import ROOT, NativeHelper, run_cleanup
from shared_helper_e2e import Connection


def wait_for_state(path, predicate):
    deadline = time.monotonic() + 10
    latest = None
    while time.monotonic() < deadline:
        try:
            latest = json.loads(path.read_text())
            if predicate(latest):
                return latest
        except (FileNotFoundError, json.JSONDecodeError):
            pass
        time.sleep(0.025)
    raise AssertionError(f"fixture state did not match: {latest}")


def stop_application(pid):
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.025)
    os.kill(pid, signal.SIGKILL)
    raise AssertionError("fixture did not exit after SIGTERM")


def check_click_holds(helper, owner, window, point, state_file):
    observed = helper.call("getState", {**owner, "maxElements": 2000, "maxDepth": 25})
    pad = next(item for item in observed["elements"] if item["role"] == "AXButton" and item["title"] == "Input receiver")
    target = {**owner, "snapshotId": observed["snapshotId"], "elementIndex": pad["index"]}
    state = json.loads(state_file.read_text())
    presses = state["axPresses"]
    helper.call("click", target)
    state = wait_for_state(state_file, lambda value: value["axPresses"] == presses + 1)
    count = len(state["events"])
    for invalid in [-1, 1.5, 5001, "800", None]:
        helper.call("click", {**target, "holdMs": invalid}, "INVALID_ARGUMENT")
    assert json.loads(state_file.read_text())["axPresses"] == presses + 1
    for params, types in [({**target, "holdMs": 0}, [1, 2]),
                          ({**target, "holdMs": 150}, [1, 2]),
                          ({**window, **point, "holdMs": 150, "mouseButton": "right"}, [3, 4]),
                          ({**window, **point, "holdMs": 150, "mouseButton": "middle"}, [25, 26]),
                          ({**window, **point, "holdMs": 150, "clickCount": 2}, [1, 2, 1, 2])]:
        helper.call("click", params)
        state = wait_for_state(state_file, lambda value: len(value["events"]) >= count + len(types))
        events = state["events"][count:]
        assert [event["type"] for event in events] == types, events
        for index in range(0, len(events), 2):
            assert events[index + 1]["timestamp"] - events[index]["timestamp"] >= params["holdMs"] / 1000, events
        assert state["axPresses"] == presses + 1, state
        count += len(types)
    # Production cancellation travels directly over the socket; the diagnostic stdio proxy exchanges whole requests.
    key = hashlib.sha256(Path(helper.process.args[0]).read_bytes()).hexdigest()
    socket_path = Path(f"/tmp/dsh-cua-{os.getuid()}/{key}.sock")
    for ending in ["cancel", "timeout", "disconnect"]:
        connection = Connection(socket_path, key, maxClickHoldMs=7000, timeoutMs=2000 if ending == "timeout" else 30000)
        try:
            app = connection.call("getApp", {"selector": str(observed["pid"])})
            connection.call("getState", {"appHandle": app["appHandle"], "windowId": window["windowId"],
                                         "maxElements": 2000, "maxDepth": 25})
            params = {**window, **point, "appHandle": app["appHandle"], "holdMs": 6000}
            count = len(json.loads(state_file.read_text())["events"])
            connection.call("click", {**params, "holdMs": 7001}, error="INVALID_ARGUMENT")
            request = {"id": "held-click", "method": "click", "params": params}
            connection.send(request)
            wait_for_state(state_file, lambda value: len(value["events"]) == count + 1)
            if ending == "disconnect":
                connection.close()
            else:
                if ending == "cancel":
                    connection.send({"type": "cancel", "id": request["id"]})
                response = connection.read()
                helper.transcript.append({"request": request, "response": response})
                assert response["id"] == request["id"], response
                assert response["error"]["code"] == ("NATIVE_CANCELLED" if ending == "cancel" else "NATIVE_TIMEOUT"), response
            state = wait_for_state(state_file, lambda value: len(value["events"]) >= count + 2)
            assert [event["type"] for event in state["events"][count:]] == [1, 2], state
            helper.call("click", {**window, **point})
            state = wait_for_state(state_file, lambda value: len(value["events"]) >= count + 4)
            assert [event["type"] for event in state["events"][count:]] == [1, 2, 1, 2], state
        finally:
            connection.close()
    connection = Connection(socket_path, key, maxClickHoldMs=0)
    try:
        app = connection.call("getApp", {"selector": str(observed["pid"])})
        connection.call("getState", {"appHandle": app["appHandle"], "windowId": window["windowId"],
                                     "maxElements": 2000, "maxDepth": 25})
        count = len(state["events"])
        params = {**window, **point, "appHandle": app["appHandle"]}
        connection.call("click", {**params, "holdMs": 1}, error="INVALID_ARGUMENT")
        connection.call("click", {**params, "holdMs": 0})
        state = wait_for_state(state_file, lambda value: len(value["events"]) >= count + 2)
        assert [event["type"] for event in state["events"][count:]] == [1, 2], state
    finally:
        connection.close()
    return state


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--helper", type=Path, required=True)
    parser.add_argument("--artifacts", type=Path)
    parser.add_argument("--click-only", action="store_true")
    args = parser.parse_args()
    transcript = []
    helper = None
    pid = None
    with tempfile.TemporaryDirectory(prefix="dsh-cua-capabilities-") as temporary:
        root = Path(temporary)
        application = root / "Capabilities Fixture.app"
        executable = application / "Contents/MacOS/CapabilitiesFixture"
        executable.parent.mkdir(parents=True)
        state_file = root / "state.json"
        info = {"CFBundleName": "Capabilities Fixture", "CFBundleDisplayName": "Capabilities Fixture",
                "CFBundleIdentifier": "test.dsh.cua." + uuid.uuid4().hex,
                "CFBundleExecutable": "CapabilitiesFixture", "CFBundlePackageType": "APPL",
                "DSHFixtureStatePath": str(state_file), "DSHFixtureBackground": args.click_only}
        (application / "Contents/Info.plist").write_bytes(plistlib.dumps(info))
        subprocess.run(["swiftc", str(ROOT / "tests/CapabilitiesFixture.swift"), "-o", str(executable)], check=True)
        try:
            helper = NativeHelper(transcript, args.helper)
            call = helper.call
            capabilities = call("getCapabilities", {})
            assert capabilities["permissions"] == {"accessibility": True, "screenRecording": True}, capabilities
            assert "launchApp" not in capabilities["methods"], capabilities
            matches = call("findApps", {"query": str(application), "maxAppMatches": 20})
            assert len(matches) == 1 and matches[0]["isRunning"] is False, matches
            pending = call("getApp", {"selector": str(application)})
            assert pending["pid"] is None and not state_file.exists(), pending
            owner = {"appHandle": pending["appHandle"]}
            # The Host consent barrier is separately exercised by provider-lifecycle.spec.ts.
            app = call("launchApp", owner)
            pid = app["pid"]
            wait_for_state(state_file, lambda value: value["pid"] == pid and value["windowId"] > 0)
            if not args.click_only:
                call("activate", owner)
                state = wait_for_state(state_file, lambda value: value["pid"] == pid and value["active"] and value["keyWindow"])
                assert call("findApps", {"query": str(application), "maxAppMatches": 20})[0]["pid"] == pid
                observed = call("getState", {**owner, "maxElements": 2000, "maxDepth": 25})
                field = next(item for item in observed["elements"] if item["role"] == "AXTextArea")
                assert "valueWritable=true" in observed["tree"] and "selectionWritable=true" in observed["tree"], observed["tree"]
                target = {**owner, "snapshotId": observed["snapshotId"], "elementIndex": field["index"]}
                call("selectText", {**target, "text": "target"}, "AMBIGUOUS_TEXT")
                call("selectText", {**target, "text": "target", "prefix": "第二😀 "})
                selected = wait_for_state(state_file, lambda value: value["selection"] == [17, 6])
                assert selected["text"] == "第一😀 target，第二😀 target.", selected
                call("paste", {**owner, "text": "替换\n第二行\t保留", "format": "text", "maxClipboardBytes": 33554432, "pasteReadTimeoutMs": 1000, "maxElements": 2000, "maxDepth": 25})
                state = wait_for_state(state_file, lambda value: value["text"] == "第一😀 target，第二😀 替换\n第二行\t保留.")
                assert state["pasteAttempts"] == [True], state
                observed = call("getState", {**owner, "maxElements": 2000, "maxDepth": 25})
                field = next(item for item in observed["elements"] if item["role"] == "AXTextArea")
                target = {**owner, "snapshotId": observed["snapshotId"], "elementIndex": field["index"]}
                call("selectText", {**target, "text": state["text"]})
                html = '<h1>Heading</h1><p><b>Bold</b> and <a href="https://example.com/">link</a></p>'
                call("paste", {**owner, "text": html, "format": "html", "maxClipboardBytes": 33554432, "pasteReadTimeoutMs": 1000, "maxElements": 2000, "maxDepth": 25})
                state = wait_for_state(state_file, lambda value: any(run.get("link") == "https://example.com/" for run in value["runs"]))
                assert any(run["bold"] and "Bold" in run["text"] for run in state["runs"]), state
            state = json.loads(state_file.read_text())
            pad = state["pad"]
            point = {"x": pad[0] + 80, "y": pad[1] + 70}
            window = {**owner, "windowId": state["windowId"]}
            if not args.click_only:
                call("click", {**window, **point, "mouseButton": "middle", "modifiers": ["shift"]})
                state = wait_for_state(state_file, lambda value: any(event["type"] == 26 and event.get("button") == 2 and event["shift"] for event in value["events"]))
                call("drag", {**window, "fromX": point["x"], "fromY": point["y"], "toX": point["x"] + 80,
                              "toY": point["y"] + 20, "durationMs": 200, "steps": 10, "mouseButton": "middle", "modifiers": ["shift"]})
                state = wait_for_state(state_file, lambda value: any(event["type"] == 27 and event.get("button") == 2 and event["shift"] for event in value["events"]))
                call("pressKey", {**owner, "key": "KP_0"})
                call("pressKey", {**owner, "key": "KP_Enter"})
                state = wait_for_state(state_file, lambda value: {82, 76}.issubset({event.get("keyCode") for event in value["events"]}))
            state = check_click_holds(helper, owner, window, point, state_file)
            if args.artifacts:
                args.artifacts.mkdir(parents=True, exist_ok=True)
                shot = call("screenshot", window)
                (args.artifacts / "capabilities.png").write_bytes(base64.b64decode(shot["data"]))
                (args.artifacts / "state.json").write_text(json.dumps(state, ensure_ascii=False, indent=2))
            print("PASS: click holds and cancellation/timeout/disconnect release" if args.click_only else
                  "PASS: stopped-app launch, Unicode selection, plain/HTML paste, middle/modifier drag, keypad identity and click holds")
        finally:
            if pid is None and state_file.exists():
                pid = json.loads(state_file.read_text())["pid"]
            if args.artifacts:
                args.artifacts.mkdir(parents=True, exist_ok=True)
                if state_file.exists():
                    (args.artifacts / "state-final.json").write_bytes(state_file.read_bytes())
                (args.artifacts / "transcript.json").write_text(json.dumps(transcript, ensure_ascii=False, indent=2))
            run_cleanup(*([helper.stop] if helper else []), *([lambda: stop_application(pid)] if pid else []))


if __name__ == "__main__":
    main()
