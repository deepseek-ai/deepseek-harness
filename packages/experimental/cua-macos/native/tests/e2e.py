"""Opt-in macOS integration against a disposable two-window AppKit application.

Build dsh-cua-native first, then run this file with Python 3. macOS Accessibility
and Screen Recording permission must already be granted to the responsible host.
The fixture records its own received actions; native dispatch success is not the
assertion. --artifacts saves fixture-only screenshots and a private transcript.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

from native_test_support import ROOT, NativeHelper, line, run_cleanup, stop


def check_file_panel(call, owner, primary_params, primary, directory, wait_state, button_target):
    selected_file = Path(directory) / "sheet-target.txt"
    selected_file.write_text("Owned file picker fixture\n")
    call("click", button_target(call("getState", primary_params), "Open fixture file"))

    # A remote AX traversal can consume the helper's 15-second response budget.
    # Allow two completed observations rather than timing out after the first.
    def wait_observation(predicate, description, params={**owner, "maxElements": 2000, "maxDepth": 25}):
        deadline = time.monotonic() + 30
        while True:
            try:
                observed = call("getState", params)
            except AssertionError as error:
                # A closing modal can invalidate an enumerated AX node. The
                # failed read publishes no snapshot; only this read is repeated.
                reply = error.args[0] if error.args else None
                if not isinstance(reply, dict) or reply.get("error", {}).get("code") != "STALE_SNAPSHOT" or time.monotonic() >= deadline:
                    raise
                time.sleep(0.025)
                continue
            if predicate(observed):
                return observed
            if time.monotonic() >= deadline:
                raise AssertionError(description + ": " + observed["tree"])
            time.sleep(0.025)

    sheet = wait_observation(lambda observed: any(e["identifier"] == "open-panel" for e in observed["elements"]),
                             "File panel did not appear")
    sheet_id = sheet["focusedWindowId"]
    assert sheet_id != primary["windowId"], sheet
    scoped = call("getState", {**primary_params, "windowId": sheet_id})
    assert any(e["role"] == "AXSheet" for e in scoped["elements"]), scoped
    assert "Increment primary" not in scoped["tree"], scoped
    panel = next(e for e in scoped["elements"] if e["identifier"] == "open-panel")
    call("performSecondaryAction", {**owner, "snapshotId": scoped["snapshotId"], "elementIndex": panel["index"], "action": "raise"})
    deadline = time.monotonic() + 30
    while True:
        try:
            call("pressKey", {**owner, "key": "g", "modifiers": ["command", "shift"]})
            break
        except AssertionError as error:
            # PANEL_NOT_READY guarantees no key was dispatched while ViewBridge starts.
            reply = error.args[0] if error.args else None
            if not isinstance(reply, dict) or reply.get("error", {}).get("code") != "PANEL_NOT_READY" or time.monotonic() >= deadline:
                raise
            time.sleep(0.025)
    goto = wait_observation(lambda observed: any(e["identifier"] == "PathTextField" for e in observed["elements"]),
                            "Command+Shift+G did not reach the system panel")
    path_field = next(e for e in goto["elements"] if e["identifier"] == "PathTextField")
    call("click", {**owner, "snapshotId": goto["snapshotId"], "elementIndex": path_field["index"]})
    call("pressKey", {**owner, "key": "a", "modifiers": ["command"]})
    call("typeText", {**owner, "text": str(selected_file)})
    wait_observation(lambda observed: any(e["identifier"] == "PathTextField" and e["value"] == str(selected_file)
                                         for e in observed["elements"]), "Panel text input did not arrive")
    call("pressKey", {**owner, "key": "Return"})
    ready = wait_observation(lambda observed: not any(e["identifier"] == "PathTextField" for e in observed["elements"])
                             and any(e["identifier"] == "OKButton" and e["enabled"] for e in observed["elements"]),
                             "Go to folder did not select the requested file")
    open_button = next(e for e in ready["elements"] if e["identifier"] == "OKButton")
    call("click", {**owner, "snapshotId": ready["snapshotId"], "elementIndex": open_button["index"]})
    wait_state(lambda state: bool(state["selectedFile"]) and Path(state["selectedFile"]).samefile(selected_file),
               "File picker did not return the intended file")
    # AppKit can retain the dismissed panel's hidden WindowServer window after
    # its completion handler. Modal dismissal does not imply window destruction.
    wait_observation(lambda observed: observed["focusedWindowId"] == primary["windowId"]
                     and not any(e["identifier"] == "open-panel" for e in observed["elements"]),
                     "File panel did not dismiss and return focus to the primary window")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--helper", type=Path, help="Existing native helper executable for this run")
    parser.add_argument("--artifacts", type=Path, help="Save fixture screenshots and private JSON protocol transcript")
    parser.add_argument("--panels-only", action="store_true", help="Exercise system file panels without unrelated pointer gestures")
    parser.add_argument("--hover-only", action="store_true", help="Exercise native hover without keyboard or file-panel scenarios")
    parser.add_argument("--alternate-hover", action="store_true", help="Use AX alternate UI and verify the system pointer stays unchanged")
    parser.add_argument("--input-overlays", action="store_true", help="Verify pass-through and input-blocking overlay windows")
    args = parser.parse_args()
    artifacts = args.artifacts
    if artifacts is not None:
        artifacts.mkdir(parents=True, exist_ok=True)
    transcript = []
    if os.uname().sysname != "Darwin":
        raise RuntimeError("this opt-in check requires macOS")
    with tempfile.TemporaryDirectory(prefix="dsh-cua-fixture-") as directory:
        fixture_binary = Path(directory) / "dsh-cua-fixture"
        state_path = Path(directory) / "state.json"
        subprocess.run(["swiftc", str(ROOT / "tests" / "Fixture.swift"), "-o", str(fixture_binary)], check=True)
        fixture_args = [str(fixture_binary), str(state_path)]
        if args.alternate_hover:
            fixture_args += ["35", "--alternate-hover"]
        fixture = subprocess.Popen(fixture_args, stdout=subprocess.PIPE, text=True)
        helper = None
        try:
            assert line(fixture).strip() == "READY"
            helper = NativeHelper(transcript, args.helper)
            call = helper.call

            def wait_state(predicate, description):
                deadline = time.monotonic() + 5
                while True:
                    state = json.loads(state_path.read_text())
                    if predicate(state):
                        return state
                    if time.monotonic() >= deadline:
                        raise AssertionError(description + ": " + json.dumps(state))
                    time.sleep(0.025)

            capabilities = call("getCapabilities", {})
            assert capabilities["platform"] == "macos", capabilities
            assert capabilities["permissions"] == {"accessibility": True, "screenRecording": True}, capabilities
            apps = call("listApps", {})
            assert any(app["pid"] == fixture.pid for app in apps), apps
            app = call("getApp", {"selector": str(fixture.pid)})
            handle = app["appHandle"]
            assert app["pid"] == fixture.pid and isinstance(handle, str) and handle
            assert call("getApp", {"selector": str(fixture.pid)})["appHandle"] == handle
            owner = {"appHandle": handle}
            deadline = time.monotonic() + 5
            while True:
                windows = call("listWindows", owner)
                primary = next(window for window in windows if window["title"] == "DSH CUA primary fixture")
                secondary = next(window for window in windows if window["title"] == "DSH CUA secondary fixture")
                actual = json.loads(state_path.read_text())
                sizes = [[window["bounds"]["width"], window["bounds"]["height"]] for window in [primary, secondary]]
                if sizes == [actual["primaryWindowSize"], actual["secondaryWindowSize"]]:
                    break
                if time.monotonic() >= deadline:
                    raise AssertionError("WindowServer has not finished presenting the fixture windows")
                time.sleep(0.025)
            primary_params = {**owner, "windowId": primary["windowId"], "maxElements": 300, "maxDepth": 20}
            secondary_params = {**owner, "windowId": secondary["windowId"], "maxElements": 300, "maxDepth": 20}
            first = call("getState", primary_params)
            second = call("getState", secondary_params)
            assert "Increment secondary" not in first["tree"], first
            assert "Increment primary" not in second["tree"], second

            def button_target(state, title):
                matches = [element for element in state["elements"] if element["role"] == "AXButton" and element["title"] == title]
                assert len(matches) == 1, state
                return {**owner, "snapshotId": state["snapshotId"], "elementIndex": matches[0]["index"]}

            target = button_target(first, "Increment primary")
            call("click", target)
            wait_state(lambda state: state["count"] == 1, "primary click was not received exactly once")
            call("click", button_target(second, "Increment secondary"))
            wait_state(lambda state: state["secondaryCount"] == 1, "second window snapshot was invalidated by primary action")
            first = call("getState", primary_params)
            call("click", target, "STALE_SNAPSHOT")
            call("click", button_target(second, "Increment secondary"))
            wait_state(lambda state: state["secondaryCount"] == 2, "refresh invalidated another window snapshot")
            call("click", {**owner, "snapshotId": second["snapshotId"], "windowId": primary["windowId"], "x": 30, "y": 30}, "STALE_SNAPSHOT")

            def capture(window, name):
                result = call("screenshot", {**owner, "windowId": window["windowId"]})
                pixels = base64.b64decode(result["data"], validate=True)
                assert pixels.startswith(b"\x89PNG\r\n\x1a\n")
                assert result["pixelWidth"] == int.from_bytes(pixels[16:20], "big")
                assert result["pixelHeight"] == int.from_bytes(pixels[20:24], "big")
                actual = json.loads(state_path.read_text())
                size_key = "primaryWindowSize" if window["windowId"] == primary["windowId"] else "secondaryWindowSize"
                assert result["coordinateSpace"] == "window-points"
                assert [result["bounds"]["width"], result["bounds"]["height"]] == actual[size_key]
                if artifacts is not None:
                    (artifacts / name).write_bytes(pixels)
                return result

            def check_hover():
                if not args.alternate_hover:
                    call("activate", owner)
                    current = call("getState", primary_params)
                    window_element = next(element for element in current["elements"] if element["role"] == "AXWindow")
                    call("performSecondaryAction", {**owner, "snapshotId": current["snapshotId"],
                                                     "elementIndex": window_element["index"], "action": "raise"})
                call("getState", primary_params)
                def hover(target):
                    result = call("hover", target)
                    if args.alternate_hover:
                        assert result["hoverRoute"] == "accessibility" and result["systemPointerMoved"] is False, result
                    return result
                x, y, width, height = json.loads(state_path.read_text())["dragBounds"]
                hover({**owner, "windowId": primary["windowId"], "x": x + 20, "y": y + 20})
                wait_state(lambda actual: actual["hoverVisible"], "AppKit tracking area did not reveal hover controls")
                time.sleep(0.25)
                hover_state = call("getState", primary_params)
                capture(primary, "02-native-hover.png")
                assert json.loads(state_path.read_text())["hoverVisible"], "Observation dismissed native hover controls"
                hover_target = button_target(hover_state, "Use native hover details")
                hover(hover_target)
                call("click", hover_target)
                wait_state(lambda actual: actual["hoverClicks"] == 1, "Native hover control did not activate")
                hover({**owner, "windowId": primary["windowId"], "x": 10, "y": 40})
                wait_state(lambda actual: not actual["hoverVisible"], "AppKit tracking area did not exit")
                if args.alternate_hover:
                    actual = json.loads(state_path.read_text())
                    assert actual["cursorSamples"] > 1 and actual["cursorChanges"] == 0, actual
                if args.input_overlays:
                    def cycle_overlay(mode):
                        state = call("getState", primary_params)
                        call("click", button_target(state, "Cycle input overlay"))
                        return wait_state(lambda actual: actual["overlayMode"] == mode
                                          and actual["overlayOnScreen"] == (mode != 0)
                                          and actual["hoverHitWindow"] == (actual["overlayWindowId"] if mode == 2 else primary["windowId"]),
                                          "Overlay input routing did not settle")
                    cycle_overlay(1)
                    target = {**owner, "windowId": primary["windowId"], "x": x + 20, "y": y + 20}
                    hover(target)
                    wait_state(lambda actual: actual["hoverVisible"], "Input-transparent overlay blocked hover")
                    before = cycle_overlay(2)
                    call("hover", target, "FOREGROUND_REQUIRED")
                    after = wait_state(lambda actual: actual["cursorSamples"] >= before["cursorSamples"] + 2,
                                       "Pointer observation did not advance")
                    assert after["cursorChanges"] == before["cursorChanges"], "Rejected hover moved the system pointer"
                    cycle_overlay(0)
                    hover({**owner, "windowId": primary["windowId"], "x": 10, "y": 40})
                    wait_state(lambda actual: not actual["hoverVisible"], "Hover did not exit after removing the overlay")

            if args.hover_only:
                check_hover()
                helper.eof()
                print("PASS: native AppKit tracking-area entry, AX and screenshot preservation, hover-control interaction and exit")
                return

            if args.panels_only:
                check_file_panel(call, owner, primary_params, primary, directory, wait_state, button_target)
                helper.eof()
                print("PASS: sheet window scope, system-panel keyboard routing, pointer field focus, selected file URL")
                return

            before = capture(primary, "00-primary.png")
            other = capture(secondary, "01-secondary.png")
            assert before["pixelWidth"] != other["pixelWidth"]
            fields = [element for element in first["elements"] if element["role"] == "AXTextField" and element["bounds"] is not None]
            assert len(fields) == 1, first
            field = fields[0]["bounds"]
            call("click", {**owner, "snapshotId": first["snapshotId"], "windowId": primary["windowId"],
                           "x": field[0] + field[2] / 2 - primary["bounds"]["x"],
                           "y": field[1] + field[3] / 2 - primary["bounds"]["y"]})
            call("typeText", {**owner, "text": "中文 CUA 🧪"})
            wait_state(lambda state: state["text"] == "中文 CUA 🧪", "Unicode input was not received completely")
            call("pressKey", {**owner, "key": "a", "modifiers": ["command"]})
            call("typeText", {**owner, "text": "第二次 CUA"})
            call("pressKey", {**owner, "key": "tab"})
            state = wait_state(lambda state: state["text"] == "第二次 CUA", "Command+A replacement or key dispatch was not received")
            check_hover()
            state = json.loads(state_path.read_text())
            expected_pointer_counts = {key: state[key] + 1 for key in
                                       ["scrollEventCount", "rightDownCount", "rightUpCount", "dragDownCount", "dragCount"]}
            x, y, width, height = state["scrollBounds"]
            initial_scroll = state["scrollY"]
            call("scroll", {**owner, "windowId": primary["windowId"], "x": x + width / 2, "y": y + height / 2, "deltaLinesY": -3})
            state = wait_state(lambda state: state["scrollY"] > initial_scroll, "line scroll did not move the actual document")
            assert state["scrollEventCount"] == expected_pointer_counts["scrollEventCount"], state
            x, y, width, height = state["dragBounds"]
            call("click", {**owner, "windowId": primary["windowId"], "x": x + width / 2,
                           "y": y + height / 2, "mouseButton": "right"})
            state = wait_state(lambda state: state["rightUpCount"] >= expected_pointer_counts["rightUpCount"],
                               "right click release was not received")
            assert state["rightDownCount"] == expected_pointer_counts["rightDownCount"], state
            assert state["rightUpCount"] == expected_pointer_counts["rightUpCount"], state
            call("drag", {**owner, "windowId": primary["windowId"], "fromX": x + 20, "fromY": y + height / 2,
                          "toX": x + width - 20, "toY": y + height / 2, "durationMs": 250, "steps": 12})
            state = wait_state(lambda state: state["dragCount"] >= expected_pointer_counts["dragCount"]
                               and abs(state["dragPoint"][0] - (width - 20)) < 3,
                               "drag release did not reach the intended document point")
            assert state["dragDownCount"] == expected_pointer_counts["dragDownCount"], state
            assert state["dragCount"] == expected_pointer_counts["dragCount"], state
            capture(primary, "02-input-scroll-drag.png")
            call("scroll", {**owner, "windowId": primary["windowId"], "x": 10, "y": 10, "deltaLinesY": 0}, "INVALID_ARGUMENT")
            call("listWindows", {"appHandle": "invalid"}, "STALE_APP")
            call("click", button_target(second, "Close secondary"))
            deadline = time.monotonic() + 5
            while any(window["windowId"] == secondary["windowId"] for window in call("listWindows", owner)):
                if time.monotonic() >= deadline:
                    raise AssertionError("secondary window did not close")
                time.sleep(0.025)
            call("screenshot", {**owner, "windowId": secondary["windowId"]}, "WINDOW_UNAVAILABLE")
            call("click", button_target(second, "Increment secondary"), "STALE_SNAPSHOT")

            check_file_panel(call, owner, primary_params, primary, directory, wait_state, button_target)
            state = json.loads(state_path.read_text())
            assert {key: state[key] for key in expected_pointer_counts} == expected_pointer_counts, state
            stop(fixture)
            call("listWindows", owner, "APP_UNAVAILABLE")
            call("listWindows", owner, "STALE_APP")
            helper.eof()
            print("PASS: capability preflight, two-window snapshots, scoped invalidation, AX readback, Unicode input, single scroll/right-click/drag dispatch, image dimensions, native hover, stale app cleanup, EOF, system file panel")
        finally:
            def save_artifacts():
                if artifacts is not None:
                    (artifacts / "transcript.json").write_text(json.dumps(transcript, ensure_ascii=False, indent=2) + "\n")
                    if state_path.exists():
                        (artifacts / "fixture-state.json").write_bytes(state_path.read_bytes())

            run_cleanup(save_artifacts, *([helper.stop] if helper is not None else []), lambda: stop(fixture))


if __name__ == "__main__":
    main()
