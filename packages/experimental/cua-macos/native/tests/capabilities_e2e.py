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

from native_test_support import ROOT, NativeHelper, run_cleanup, stop
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


def check_toggle_mouse(helper, owner, state_file, executable):
    call = helper.call
    source_pid = call("permissionStatus", {})["helper"]["pid"]

    def observed(value):
        return {**value, "events": [event for event in value["events"] if event.get("sourcePid") == source_pid]}

    def read_owned():
        return observed(json.loads(state_file.read_text()))

    def wait_owned(predicate):
        return observed(wait_for_state(state_file, lambda value: predicate(observed(value))))

    def cursor(*position):
        return json.loads(subprocess.check_output([executable, "--cursor", *map(str, position)], text=True))

    state = read_owned()
    window = {**owner, "windowId": state["windowId"]}
    def toggle(button, direction, error=None):
        result = call("toggleMouse", {**window, "mouseButton": button, "direction": direction}, error)
        if not error:
            assert result == {"dispatched": True}, result

    toggle("left", "down", "FOREGROUND_REQUIRED")
    assert read_owned()["events"] == state["events"]
    call("activate", owner)
    state = wait_owned(lambda s: s["active"] and s["keyWindow"])
    bounds = next(w["bounds"] for w in call("listWindows", owner) if w["windowId"] == window["windowId"])
    inside = [bounds["x"] + state["pad"][0] + 80, bounds["y"] + state["pad"][1] + 70]
    outside = [bounds["x"] - 8, inside[1]]
    other = None
    original = cursor()
    try:
        assert cursor(*outside) == outside
        toggle("left", "down", "FOREGROUND_REQUIRED")
        assert read_owned()["events"] == state["events"]
        for index, (button, down, up) in enumerate([("left", 1, 2), ("right", 3, 4), ("middle", 25, 26)]):
            assert cursor(*inside) == inside
            call("activate", owner)
            wait_owned(lambda s: s["active"] and s["keyWindow"])
            count = len(state["events"])
            toggle(button, "down")
            try:
                state = wait_owned(lambda s: len(s["events"]) > count)
                assert [(e["type"], e["button"]) for e in state["events"][count:]] == [(down, index)], state
                assert cursor() == inside
                assert not state["events"][-1]["pressedButtons"] & (1 << index), state
                assert cursor(*outside) == outside
                if button == "right":
                    os.kill(state["pid"], signal.SIGUSR1)
                    wait_owned(lambda s: s["windowX"] == bounds["x"] + 40)
                if button == "middle":
                    other_state = state_file.with_name("other.json")
                    other = subprocess.Popen([executable, other_state])
                    wait_for_state(other_state, lambda s: bool(s["windowId"]))
                    other_app = call("getApp", {"selector": str(other.pid)})
                    call("activate", {"appHandle": other_app["appHandle"]})
                    wait_owned(lambda s: not s["active"])
            finally:
                assert cursor(*outside) == outside
                toggle(button, "up")
            state = wait_owned(lambda s: len(s["events"]) >= count + 2)
            events = state["events"][count:]
            assert [(e["type"], e["button"]) for e in events] == [(down, index), (up, index)], events
            assert events[1]["point"][0] < 0, events
            if button == "right":
                assert events[1]["point"][0] == outside[0] - bounds["x"] - 40, events
                os.kill(state["pid"], signal.SIGUSR1)
                wait_owned(lambda s: s["windowX"] == bounds["x"])
            if button != "middle":
                assert cursor() == outside
        call("activate", owner)
        wait_owned(lambda s: s["active"] and s["keyWindow"])
        call("getState", {**window, "maxElements": 300, "maxDepth": 20})
        key = hashlib.sha256(Path(helper.process.args[0]).read_bytes()).hexdigest()
        socket = Path(f"/tmp/dsh-cua-{os.getuid()}/{key}.sock")
        for index, (button, down, moved, up) in enumerate([("left", 1, 6, 2), ("right", 3, 7, 4), ("middle", 25, 27, 26)]):
            assert cursor(*inside) == inside
            params = {**window, "mouseButton": button, "useSystemInput": True}
            count = len(read_owned()["events"])
            call("toggleMouse", {**params, "direction": "down"})
            try:
                state = wait_owned(lambda s: len(s["events"]) > count)
                assert state["events"][-1]["pressedButtons"] & (1 << index), state
                call("toggleMouse", {**params, "direction": "down"}, "INPUT_BUSY")
                call("mouseMove", {**window, "x": inside[0] - bounds["x"] + 15, "y": inside[1] - bounds["y"],
                                   "useSystemInput": True})
                state = wait_owned(lambda s: len(s["events"]) >= count + 2)
                assert state["events"][-1]["type"] == moved, state
                assert cursor() == [inside[0] + 15, inside[1]]
            finally:
                call("toggleMouse", {**params, "direction": "up"})
            events = wait_owned(lambda s: len(s["events"]) >= count + 3)["events"][count:]
            assert [e["type"] for e in events] == [down, moved, up], events
            assert len({e["eventNumber"] for e in events}) == 1 and not events[-1]["pressedButtons"] & (1 << index), events
        def wait_button(pressed):
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                buttons = json.loads(subprocess.check_output([executable, "--buttons"], text=True))
                if buttons[0] == pressed:
                    return
                time.sleep(0.025)
            raise AssertionError(f"System left button did not become {pressed}")

        for ending in ("releaseHeldInputs", "disconnect"):
            call("activate", owner)
            wait_owned(lambda s: s["active"] and s["keyWindow"])
            assert cursor(*inside) == inside
            connection = Connection(socket, key)
            try:
                app = connection.call("getApp", {"selector": str(state["pid"])})
                params = {**window, "mouseButton": "left", "useSystemInput": True}
                connection.call("toggleMouse", {**params, "appHandle": app["appHandle"], "direction": "down"})
                wait_button(True)
                call("toggleMouse", {**params, "direction": "up"}, "INVALID_ARGUMENT")
                wait_button(True)
                call("activate", {"appHandle": other_app["appHandle"]})
                wait_owned(lambda s: not s["active"])
                if ending != "disconnect":
                    connection.call(ending, {})
            finally:
                connection.close()
            wait_button(False)

    finally:
        run_cleanup(lambda: cursor(*original), *([lambda: stop(other)] if other else []))


def check_system_drag(helper, owner, window, point, state_file):
    call = helper.call
    call("getState", {**window, "maxElements": 300, "maxDepth": 20})
    count = len(json.loads(state_file.read_text())["events"])
    params = {**window, "fromX": point["x"], "fromY": point["y"], "toX": point["x"] + 80,
              "toY": point["y"] + 20, "durationMs": 400, "steps": 1, "modifiers": ["shift"], "useSystemInput": True}
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
    plain = helper.call("getActionSchema", {"action": "AXShowMenu"})
    assert plain["type"] == "object" and plain["required"] == [] and plain["additionalProperties"] is False, plain
    assert "description" not in plain and "description" in plain["properties"]["argument"], plain
    setter = helper.call("getActionSchema", {"action": f"{pad['role']}.AXValue.Set"})
    argument = setter["properties"]["argument"]
    assert setter["required"] == ["argument"] and len(argument["oneOf"]) == 6, setter
    assert "description" in argument and "description" not in setter, setter
    helper.call("getActionSchema", {"action": ""}, "INVALID_ARGUMENT")
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


def check_mixed_input(call, owner, state_file, executable):
    def cursor(*position):
        return json.loads(subprocess.check_output([executable, "--cursor", *map(str, position)], text=True))
    source_pid = call("permissionStatus", {})["helper"]["pid"]
    call("activate", owner)
    state = wait_for_state(state_file, lambda s: s["active"] and s["keyWindow"])
    window = {**owner, "windowId": state["windowId"]}
    bounds = next(w["bounds"] for w in call("listWindows", owner) if w["windowId"] == window["windowId"])
    original = cursor()
    try:
        cursor(bounds["x"] + state["pad"][0] + 80, bounds["y"] + state["pad"][1] + 70)
        for system, system_key in ((False, False), (True, False), (False, True), (True, True)):
            count = len(json.loads(state_file.read_text())["events"])
            call("sendKeyEvent", {**owner, "key": "a", "direction": "down"})
            call("toggleMouse", {**window, "mouseButton": "left", "direction": "down", "useSystemInput": system})
            call("sendKeyEvent", {**owner, "key": "w", "direction": "down", "useSystemInput": system_key})
            assert call("getHeldInputs", {}) == [
                {"kind": "key", "key": "a", "appHandle": owner["appHandle"], "mode": "application"},
                {"kind": "mouse", "button": "left", "appHandle": owner["appHandle"],
                 "windowId": window["windowId"], "mode": "system" if system else "window"},
                {"kind": "key", "key": "w", "appHandle": owner["appHandle"], "mode": "system" if system_key else "application"},
            ]
            call("releaseHeldInputs", {})
            assert call("getHeldInputs", {}) == []
            state = wait_for_state(state_file, lambda s: sum(e.get("sourcePid") == source_pid for e in s["events"][count:]) >= 6)
            events = [(e["type"], e.get("keyCode")) for e in state["events"][count:] if e.get("sourcePid") == source_pid]
            assert events == [(10, 0), (1, None), (10, 13), (11, 13), (2, None), (11, 0)], events
    finally:
        run_cleanup(lambda: call("releaseHeldInputs", {}), lambda: cursor(*original))


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
        call("sendKeyEvent", {**owner, "key": name, "direction": direction})

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
    call("releaseHeldInputs", {})
    state = wait_for_state(state_file, lambda value: len(value["events"]) >= count + 4)
    assert [(e["type"], e["keyCode"]) for e in state["events"][count:]] == [(10, 13), (10, 2), (11, 2), (11, 13)]

    for explicit_up in (True, False):
        count = len(state["events"])
        key("w", "down")
        key("w", "down")
        if explicit_up:
            key("w", "up")
        call("releaseHeldInputs", {})
        state = wait_for_state(state_file, lambda value: any(
            e["type"] == 11 and e.get("keyCode") == 13 for e in value["events"][count:]))
        view_events = [(e["type"], e["keyCode"], e["repeat"]) for e in state["events"][count:]]
        # AppKit can filter a synthetic repeat before NSView.keyDown receives it.
        down, repeat, up = (10, 13, False), (10, 13, True), (11, 13, False)
        assert view_events in ([down, up], [down, repeat, up]), view_events


def check_system_input(helper, owner, state_file, executable):
    call = helper.call
    state = json.loads(state_file.read_text())
    window = {**owner, "windowId": state["windowId"]}
    point = {"x": state["pad"][0] + 80, "y": state["pad"][1] + 70}
    def keys():
        return json.loads(subprocess.check_output([executable, "--key-state"], text=True))
    assert not any(keys().values()), "Release keyboard keys before the system-input check"
    call("pressKey", {**owner, "key": "w", "useSystemInput": True}, "FOREGROUND_REQUIRED")
    call("activate", owner)
    wait_for_state(state_file, lambda value: value["active"] and value["keyWindow"])
    call("getState", {**window, "maxElements": 300, "maxDepth": 20})
    call("mouseMove", {**window, **point, "useSystemInput": True})
    call("click", {**window, **point, "useSystemInput": True})
    state = wait_for_state(state_file, lambda value: any(event["type"] == 2 for event in value["events"]))
    count = len(state["events"])
    call("pressKey", {**owner, "key": "d", "modifiers": ["shift"], "useSystemInput": True})
    events = wait_for_state(state_file, lambda value: any(event["type"] == 11 for event in value["events"][count:]))["events"][count:]
    assert [(event["type"], event.get("keyCode")) for event in events] == [(10, 2), (11, 2)], events
    assert all(event["shift"] for event in events) and not any(keys().values()), events
    held = {**owner, "key": "w", "useSystemInput": True}
    for cleanup in (False, True):
        count = len(json.loads(state_file.read_text())["events"])
        call("sendKeyEvent", {**held, "direction": "down"})
        try:
            state = wait_for_state(state_file, lambda value: any(
                event["type"] == 10 and event.get("keyCode") == 13 for event in value["events"][count:]))
            down = next(event for event in state["events"][count:] if event["type"] == 10 and event.get("keyCode") == 13)
            assert down["systemW"], down
        finally:
            if cleanup:
                call("releaseHeldInputs", {})
            else:
                call("sendKeyEvent", {**held, "direction": "up"})
        state = wait_for_state(state_file, lambda value: any(
            event["type"] == 11 and event.get("keyCode") == 13 for event in value["events"][count:]))
        up = next(event for event in state["events"][count:] if event["type"] == 11 and event.get("keyCode") == 13)
        assert not up["systemW"], up
    shift = {**held, "key": "shift"}
    mouse = {**window, "mouseButton": "left", "useSystemInput": True}
    count = len(state["events"])
    call("sendKeyEvent", {**shift, "direction": "down"})
    try:
        call("toggleMouse", {**mouse, "direction": "down"})
        state = wait_for_state(state_file, lambda value: any(event["type"] == 1 for event in value["events"][count:]))
        assert next(event for event in state["events"][count:] if event["type"] == 1)["shift"]
    finally:
        call("sendKeyEvent", {**shift, "direction": "up"})
        call("toggleMouse", {**mouse, "direction": "up"})
    state = wait_for_state(state_file, lambda value: any(event["type"] == 2 for event in value["events"][count:]))
    assert not next(event for event in state["events"][count:] if event["type"] == 2)["shift"], state
    key = hashlib.sha256(Path(helper.process.args[0]).read_bytes()).hexdigest()
    connection = Connection(Path(f"/tmp/dsh-cua-{os.getuid()}/{key}.sock"), key)
    try:
        selected = connection.call("getApp", {"selector": str(state["pid"])})
        target = {**window, "appHandle": selected["appHandle"]}
        connection.call("getState", {**target, "maxElements": 300, "maxDepth": 20})
        for method, arguments in [
            ("click", {**point, "holdMs": 5000}),
            ("drag", {"fromX": point["x"], "fromY": point["y"], "toX": point["x"] + 60,
                      "toY": point["y"] + 20, "durationMs": 5000, "steps": 2}),
        ]:
            count = len(json.loads(state_file.read_text())["events"])
            request_id = "system-" + method
            connection.send({"id": request_id, "method": method, "params": {
                **target, **arguments, "modifiers": ["shift"], "useSystemInput": True}})
            state = wait_for_state(state_file, lambda value: any(event["type"] == 1 for event in value["events"][count:]))
            down = next(event for event in state["events"][count:] if event["type"] == 1)
            assert down["systemShift"] and down["shift"] and down["pressedButtons"] & 1, down
            connection.send({"type": "cancel", "id": request_id})
            assert connection.read()["error"]["code"] == "NATIVE_CANCELLED"
            state = wait_for_state(state_file, lambda value: any(event["type"] == 2 for event in value["events"][count:]))
            assert not state["events"][-1]["pressedButtons"] & 1 and not any(keys().values()), state
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--helper", type=Path, required=True)
    parser.add_argument("--artifacts", type=Path)
    only = parser.add_mutually_exclusive_group()
    only.add_argument("--click-only", action="store_true")
    only.add_argument("--keyboard-only", action="store_true")
    only.add_argument("--drag-only", action="store_true")
    only.add_argument("--toggle-only", action="store_true")
    only.add_argument("--mixed-only", action="store_true")
    only.add_argument("--system-input-only", action="store_true")
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
                "DSHFixtureStatePath": str(state_file), "DSHFixtureBackground": args.click_only or args.keyboard_only or args.drag_only or args.toggle_only or args.mixed_only or args.system_input_only,
                "DSHFixtureKeyboard": args.keyboard_only or args.mixed_only}
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
            if args.mixed_only:
                check_mixed_input(call, owner, state_file, executable)
                print("PASS: receiver observes mixed keyboard/window and keyboard/system input in reverse release order")
                return
            if args.system_input_only:
                check_system_input(helper, owner, state_file, executable)
                print("PASS: system clicks, keyboard chords, held-key state and cancellation release of mouse and modifiers")
                return
            if args.toggle_only:
                check_toggle_mouse(helper, owner, state_file, executable)
                print("PASS: window-directed and HID events for three buttons, held moves, explicit release, cleanup and disconnect")
                return
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
