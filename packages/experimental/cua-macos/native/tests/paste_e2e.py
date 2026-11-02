"""Verify bounded unread-paste failure and foreground success against owned AppKit apps."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile
import time

from native_test_support import default_binary, ROOT, NativeHelper, line, run_cleanup, stop


def wait_state(path, predicate):
    deadline = time.monotonic() + 10
    latest = None
    while time.monotonic() < deadline:
        if path.exists():
            latest = json.loads(path.read_text())
            if predicate(latest):
                return latest
        time.sleep(0.025)
    raise AssertionError(f"Fixture state did not settle: {latest}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--helper", type=Path, default=None)
    parser.add_argument("--artifacts", type=Path)
    args = parser.parse_args()
    args.helper = args.helper or default_binary()
    transcript = []
    processes = []
    helper = None
    with tempfile.TemporaryDirectory(prefix="dsh-cua-paste-") as directory:
        root = Path(directory)
        binary = root / "paste-fixture"
        subprocess.run(["swiftc", str(ROOT / "tests/PasteFixture.swift"), "-o", str(binary)], check=True)
        try:
            for label in ["target", "foreground"]:
                process = subprocess.Popen([str(binary), str(root / f"{label}.json"), f"DSH paste {label}"],
                                           stdout=subprocess.PIPE, text=True)
                processes.append(process)
                assert line(process).strip() == "READY"
            helper = NativeHelper(transcript, args.helper)
            app = helper.call("getApp", {"selector": str(processes[0].pid)})
            blocker = helper.call("getApp", {"selector": str(processes[1].pid)})
            owner = {"appHandle": app["appHandle"]}
            params = {**owner, "text": "test", "format": "text", "pasteReadTimeoutMs": 1000,
                      "maxClipboardBytes": 33554432, "maxElements": 2000, "maxDepth": 25}
            helper.call("activate", {"appHandle": blocker["appHandle"]})
            wait_state(root / "target.json", lambda state: not state["active"] and state["textFocused"])
            started = time.monotonic()
            error = helper.call("paste", params, "PASTE_NOT_CONSUMED")
            elapsed = time.monotonic() - started
            assert "foreground" in error["message"] and "focus" in error["message"], error
            background = wait_state(root / "target.json", lambda state: state["pasteCalls"] == [False])
            assert background["text"] == "" and not background["active"], background
            helper.call("activate", owner)
            wait_state(root / "target.json", lambda state: state["active"] and state["textFocused"])
            result = helper.call("paste", params)
            assert result == {"dispatched": True, "verified": False}, result
            foreground = wait_state(root / "target.json", lambda state: state["text"] == "test")
            assert foreground["pasteCalls"] == [False, True] and foreground["active"], foreground
            if args.artifacts:
                args.artifacts.mkdir(parents=True, exist_ok=True)
                (args.artifacts / "results.json").write_text(json.dumps({"background": background,
                    "foreground": foreground, "backgroundElapsedSeconds": elapsed, "error": error}, indent=2) + "\n")
            print(f"PASS: background PASTE_NOT_CONSUMED in {elapsed:.3f}s; foreground paste inserted test")
        finally:
            if args.artifacts:
                args.artifacts.mkdir(parents=True, exist_ok=True)
                (args.artifacts / "transcript.json").write_text(json.dumps(transcript, indent=2) + "\n")
            run_cleanup(*([helper.stop] if helper else []), *[lambda process=process: stop(process) for process in reversed(processes)])


if __name__ == "__main__":
    main()
