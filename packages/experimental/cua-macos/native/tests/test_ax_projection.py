"""Run the production AX projection on an isolated AppKit process's own windows."""
import argparse
import json
import subprocess
import tempfile
import time
from pathlib import Path

from native_test_support import NativeHelper, line, run_cleanup, stop


def check_input(executable, helper_path, root):
    log = root / "presses.json"
    target = subprocess.Popen([str(executable), str(log)], stdout=subprocess.PIPE, text=True)
    helper = None
    try:
        assert line(target).strip() == "READY"
        helper = NativeHelper([], helper_path)
        owner = {"appHandle": helper.call("getApp", {"selector": str(target.pid)})["appHandle"]}
        helper.call("activate", owner)
        windows = helper.call("listWindows", owner)
        partial = next(window for window in windows if window["title"] == "Partial target")
        scoped = {**owner, "windowId": partial["windowId"]}
        def observe():
            return helper.call("getState", {**scoped, "maxElements": 1000, "maxDepth": 12})
        def button(state, title):
            match = next(item for item in state["elements"] if item["title"] == title and item["role"] == "AXButton")
            return {**scoped, "snapshotId": state["snapshotId"], "elementId": match["elementId"]}
        def wait_presses(expected):
            deadline = time.monotonic() + 5
            while not log.exists() or json.loads(log.read_text()) != expected:
                assert time.monotonic() < deadline, (expected, log.read_text() if log.exists() else [])
                time.sleep(0.025)
        state = observe()
        assert state["hasUnreadableElements"]
        expected = []
        for title in ["Before gap", "After gap"]:
            assert helper.call("click", button(state, title)) == {"dispatched": True}
            expected.append(title)
            wait_presses(expected)
        panel = "Identify as open panel"
        assert helper.call("invoke", button(state, panel)) == {"dispatched": True}
        expected.append(panel)
        wait_presses(expected)
        state = observe()
        assert state["focusedWindowId"] == partial["windowId"]
        assert any(item["identifier"] == "open-panel" for item in state["elements"])
        for method, params in [("click", button(state, "Before gap")),
                               ("click", {**scoped, "x": 20, "y": 40}),
                               ("typeText", {**owner, "text": "a"}),
                               ("pressKey", {**owner, "key": "a"}),
                               ("sendKeyEvent", {**owner, "key": "a", "direction": "down", "runId": "fixture"})]:
            failure = helper.call(method, params, "PANEL_NOT_READY")
            assert failure["message"] == "File panel recipient discovery is incomplete. No input was dispatched. Read fresh state before retrying.", failure
        assert json.loads(log.read_text()) == expected
        print("Passed two observed sibling clicks and pre-dispatch rejection of pointer and keyboard input to an incomplete panel.")
    finally:
        run_cleanup(*([helper.stop] if helper else []), lambda: stop(target))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--helper", type=Path, help="Exercise click and keyboard dispatch through this signed helper")
    args = parser.parse_args()
    tests = Path(__file__).resolve().parent
    sources = sorted((tests.parent / "Sources" / "CuaNative").glob("*.swift"))
    with tempfile.TemporaryDirectory(prefix="ax-child-projection-") as temporary:
        executable = Path(temporary) / "probe"
        subprocess.run(["xcrun", "swiftc", "-swift-version", "6", "-parse-as-library",
                        *[str(source) for source in sources if source.name != "Main.swift"],
                        str(tests / "ChildProjectionFixture.swift"), "-o", str(executable)], check=True)
        subprocess.run([str(executable)], check=True, timeout=30)
        if args.helper:
            check_input(executable, args.helper, Path(temporary))


if __name__ == "__main__":
    main()
