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


def check_system_drag(helper, owner, window, point, state_file):
    call = helper.call
    call("getState", {**window, "maxElements": 300, "maxDepth": 20})
    count = len(json.loads(state_file.read_text())["events"])
    params = {**window, "fromX": point["x"], "fromY": point["y"], "toX": point["x"] + 80,
              "toY": point["y"] + 20, "durationMs": 400, "steps": 1, "modifiers": ["shift"], "useSystemPointer": True}
    call("drag", params, "FOREGROUND_REQUIRED")
    assert len(json.loads(state_file.read_text())["events"]) == count
    call("activate", owner)
    wait_for_state(state_file, lambda v: v["active"] and v["keyWindow"])
    call("getState", {**window, "maxElements": 300, "maxDepth": 20})
    call("drag", params)
    state = wait_for_state(state_file, lambda v: any(e["type"] == 2 for e in v["events"][count:]))
    events = state["events"][count:]
    assert [e["type"] for e in events] == [1, 6, 2], events
    down, move, up = events
    assert all(e["shift"] and e["eventNumber"] == down["eventNumber"] for e in events), events
    assert move["pressedButtons"] & 1 and (move["deltaX"], move["deltaY"]) == (80, 20), events
    # AppKit window coordinates count upward; Quartz movement deltas count downward.
    assert (move["point"][0] - down["point"][0], down["point"][1] - move["point"][1]) == (80, 20), events
    assert up["point"] == move["point"] and not up["pressedButtons"] & 1, events
    key = hashlib.sha256(Path(helper.process.args[0]).read_bytes()).hexdigest()
    connection = Connection(Path(f"/tmp/dsh-cua-{os.getuid()}/{key}.sock"), key)
    try:
        app = connection.call("getApp", {"selector": str(state["pid"])})
        target = {**params, "appHandle": app["appHandle"], "durationMs": 5000, "steps": 2}
        connection.call("getState", {"appHandle": app["appHandle"], "windowId": window["windowId"], "maxElements": 300, "maxDepth": 20})
        count = len(state["events"])
        connection.send({"id": "cancel-drag", "method": "drag", "params": target})
        wait_for_state(state_file, lambda v: any(e["type"] == 6 for e in v["events"][count:]))
        connection.send({"type": "cancel", "id": "cancel-drag"})
        assert connection.read()["error"]["code"] == "NATIVE_CANCELLED"
        state = wait_for_state(state_file, lambda v: any(e["type"] == 2 for e in v["events"][count:]))
        events = state["events"][count:]
        assert [e["type"] for e in events] == [1, 6, 2], events
        assert events[-1]["point"] == events[-2]["point"] and not events[-1]["pressedButtons"] & 1, events
    finally:
        connection.close()


def check_clicks(helper, window, point, state_file):
    observed = helper.call("getState", {**window, "maxElements": 2000, "maxDepth": 25})
    pad = next(item for item in observed["elements"] if item["role"] == "AXButton" and item["title"] == "Input receiver")
    target = {**window, "snapshotId": observed["snapshotId"], "elementId": pad["elementId"]}
    state = json.loads(state_file.read_text())
    count = len(state["events"])
    presses, menus = state["axPresses"], state["axMenus"]
    assert {"AXPress", "AXShowMenu"}.issubset(helper.call("listActions", target))
    helper.call("invoke", target)
    state = wait_for_state(state_file, lambda value: value["axPresses"] == presses + 1)
    helper.call("performAction", {**target, "action": "AXShowMenu"})
    state = wait_for_state(state_file, lambda value: value["axMenus"] == menus + 1)
    assert len(state["events"]) == count, state
    for invalid in [-1, 1.5, 5001, "800", None]:
        helper.call("click", {**target, "holdMs": invalid}, "INVALID_ARGUMENT")
    for params, types in [(target, [1, 2]), ({**target, "mouseButton": "right"}, [3, 4]),
                          ({**window, **point}, [1, 2]),
                          ({**target, "holdMs": 0}, [1, 2]),
                          ({**target, "holdMs": 150}, [1, 2]),
                          ({**window, **point, "holdMs": 150, "mouseButton": "right"}, [3, 4]),
                          ({**window, **point, "holdMs": 150, "mouseButton": "middle"}, [25, 26]),
                          ({**window, **point, "holdMs": 150, "clickCount": 2}, [1, 2, 1, 2])]:
        helper.call("click", params)
        state = wait_for_state(state_file, lambda value: len(value["events"]) >= count + len(types))
        events = state["events"][count:]
        assert [event["type"] for event in events] == types, events
        for index in range(0, len(events), 2):
            assert events[index + 1]["timestamp"] - events[index]["timestamp"] >= params.get("holdMs", 0) / 1000, events
        assert (state["axPresses"], state["axMenus"]) == (presses + 1, menus + 1), state
        count += len(types)
    # Production cancellation travels directly over the socket; the diagnostic stdio proxy exchanges whole requests.
    key = hashlib.sha256(Path(helper.process.args[0]).read_bytes()).hexdigest()
    socket_path = Path(f"/tmp/dsh-cua-{os.getuid()}/{key}.sock")
    for ending in ["cancel", "timeout", "disconnect"]:
        connection = Connection(socket_path, key, maxClickHoldMs=7000, timeoutMs=2000 if ending == "timeout" else 30000)
        try:
            app = connection.call("getApp", {"selector": str(state["pid"])})
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
        app = connection.call("getApp", {"selector": str(state["pid"])})
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


def check_keyboard(call, owner, state_file, state):
    count = len(state["events"])
    call("pressKey", {**owner, "key": ["w", "d"]}, "INVALID_ARGUMENT")
    call("pressKey", {**owner, "key": "d", "modifiers": ["w"]}, "INVALID_ARGUMENT")
    call("pressKey", {**owner, "key": "d", "modifiers": ["shift"]})
    state = wait_for_state(state_file, lambda value: len(value["events"]) >= count + 2)
    shortcut = [(event["type"], event.get("keyCode"), event["shift"]) for event in state["events"][count:]]
    assert shortcut == [(10, 2, True), (11, 2, True)], shortcut
    count = len(state["events"])

    def key(name, direction):
        call("sendKeyEvent", {**owner, "runId": "held-input", "key": name, "direction": direction})

    key("w", "down")
    key("d", "down")
    state = wait_for_state(state_file, lambda value: len(value["events"]) >= count + 2)
    call("getState", {**owner, "maxElements": 2000, "maxDepth": 25})
    time.sleep(2)
    key("d", "up")
    state = wait_for_state(state_file, lambda value: len(value["events"]) >= count + 3)
    held = state["events"][count:]
    assert [(event["type"], event["keyCode"]) for event in held] == [(10, 13), (10, 2), (11, 2)], held
    assert held[2]["timestamp"] - held[1]["timestamp"] >= 2, held
    call("releaseHeldKeys", {"runId": "held-input"})
    state = wait_for_state(state_file, lambda value: len(value["events"]) >= count + 4)
    assert [(e["type"], e["keyCode"]) for e in state["events"][count:]] == [(10, 13), (10, 2), (11, 2), (11, 13)]

    for explicit_up in (True, False):
        count = len(state["events"])
        key("w", "down")
        key("w", "down")
        if explicit_up:
            key("w", "up")
        call("releaseHeldKeys", {"runId": "held-input"})
        state = wait_for_state(state_file, lambda value: any(
            e["type"] == 11 and e.get("keyCode") == 13 for e in value["events"][count:]))
        view_events = [(e["type"], e["keyCode"], e["repeat"]) for e in state["events"][count:]]
        # AppKit can filter a synthetic repeat before NSView.keyDown receives it.
        down, repeat, up = (10, 13, False), (10, 13, True), (11, 13, False)
        assert view_events in ([down, up], [down, repeat, up]), view_events


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--helper", type=Path, required=True)
    parser.add_argument("--artifacts", type=Path)
    only = parser.add_mutually_exclusive_group()
    only.add_argument("--click-only", action="store_true")
    only.add_argument("--keyboard-only", action="store_true")
    only.add_argument("--drag-only", action="store_true")
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
                "DSHFixtureStatePath": str(state_file), "DSHFixtureBackground": args.click_only or args.keyboard_only or args.drag_only,
                "DSHFixtureKeyboard": args.keyboard_only}
        (application / "Contents/Info.plist").write_bytes(plistlib.dumps(info))
        subprocess.run(["swiftc", str(ROOT / "tests/CapabilitiesFixture.swift"), "-o", str(executable)], check=True)
        try:
            helper = NativeHelper(transcript, args.helper)
            call = helper.call
            capabilities = call("getCapabilities", {})
            assert capabilities["permissions"] == {"accessibility": True, "screenRecording": True}, capabilities
            matches = call("findApps", {"query": str(application), "maxAppMatches": 20})
            assert len(matches) == 1 and matches[0]["isRunning"] is False, matches
            pending = call("getApp", {"selector": str(application)})
            assert pending["running"] is False and not state_file.exists(), pending
            owner = {"appHandle": pending["appHandle"]}
            # The Host consent barrier is separately exercised by provider-lifecycle.spec.ts.
            app = call("launchApp", owner)
            assert app["running"] is True, app
            pid = wait_for_state(state_file, lambda value: bool(value["windowId"]))["pid"]
            if args.drag_only:
                state = json.loads(state_file.read_text())
                pad = state["pad"]
                check_system_drag(helper, owner, {**owner, "windowId": state["windowId"]},
                                  {"x": pad[0] + 80, "y": pad[1] + 70}, state_file)
                print("PASS: system drag delivers held-button movement and releases at the last point on cancellation")
                return
            if args.keyboard_only:
                check_keyboard(call, owner, state_file, json.loads(state_file.read_text()))
                print("PASS: Shift+D shortcut, two-second W+D hold, independent D up, explicit W repeat and one final up")
                return
            if not args.click_only:
                call("activate", owner)
                state = wait_for_state(state_file, lambda value: value["pid"] == pid and value["active"] and value["keyWindow"])
                assert call("findApps", {"query": str(application), "maxAppMatches": 20})[0]["pid"] == pid
                observed = call("getState", {**owner, "maxElements": 2000, "maxDepth": 25})
                field = next(item for item in observed["elements"] if item["role"] == "AXTextArea")
                assert "valueWritable=true" in observed["tree"] and "selectionWritable=true" in observed["tree"], observed["tree"]
                target = {**owner, "snapshotId": observed["snapshotId"], "elementId": field["elementId"]}
                call("selectText", {**target, "text": "target"}, "AMBIGUOUS_TEXT")
                call("selectText", {**target, "text": "target", "prefix": "第二😀 "})
                selected = wait_for_state(state_file, lambda value: value["selection"] == [17, 6])
                assert selected["text"] == "第一😀 target，第二😀 target.", selected
                call("paste", {**owner, "text": "替换\n第二行\t保留", "format": "text", "maxClipboardBytes": 33554432, "pasteReadTimeoutMs": 1000, "maxElements": 2000, "maxDepth": 25})
                state = wait_for_state(state_file, lambda value: value["text"] == "第一😀 target，第二😀 替换\n第二行\t保留.")
                assert state["pasteAttempts"] == [True], state
                observed = call("getState", {**owner, "maxElements": 2000, "maxDepth": 25})
                field = next(item for item in observed["elements"] if item["role"] == "AXTextArea")
                target = {**owner, "snapshotId": observed["snapshotId"], "elementId": field["elementId"]}
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
                check_keyboard(call, owner, state_file, state)
                call("drag", {**window, "fromX": point["x"], "fromY": point["y"], "toX": point["x"] + 80,
                              "toY": point["y"] + 20, "durationMs": 200, "steps": 10, "mouseButton": "middle", "modifiers": ["shift"]})
                state = wait_for_state(state_file, lambda value: any(event["type"] == 27 and event.get("button") == 2 and event["shift"] for event in value["events"]))
                call("pressKey", {**owner, "key": "KP_0"})
                call("pressKey", {**owner, "key": "KP_Enter"})
                state = wait_for_state(state_file, lambda value: {82, 76}.issubset({event.get("keyCode") for event in value["events"]}))
            state = check_clicks(helper, window, point, state_file)
            if args.artifacts:
                args.artifacts.mkdir(parents=True, exist_ok=True)
                shot = call("screenshot", window)
                (args.artifacts / "capabilities.png").write_bytes(base64.b64decode(shot["data"]))
                (args.artifacts / "state.json").write_text(json.dumps(state, ensure_ascii=False, indent=2))
            print("PASS: click holds and cancellation/timeout/disconnect release" if args.click_only else
                  "PASS: stopped-app launch, Unicode selection, plain/HTML paste, middle/modifier drag, overlapping W+D events, keypad identity and click holds")
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
