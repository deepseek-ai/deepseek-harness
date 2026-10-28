"""Opt-in macOS Blender GUI keyboard regression.

Requires --blender pointing to an existing official Blender executable. No runtime
is downloaded. This owns a new factory-startup process and private user directories.
Run only after other desktop automation has stopped: activation changes GUI focus.
"""
import argparse
from contextlib import contextmanager
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import uuid

import native_test_support as support


SEED = "AlphaOne\nBetaTwo"
REPLACEMENT = "ReplaceXYZ"


def write_json(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def private_log(path):
    return os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w", encoding="utf-8")


@contextmanager
def whole_run_deadline(seconds):
    # This standalone runner owns its alarm. It also bounds a partial native JSONL
    # line, for which the shared helper's select()+readline() timeout is insufficient.
    if signal.getitimer(signal.ITIMER_REAL) != (0.0, 0.0):
        raise RuntimeError("Runner cannot replace another active real-time alarm")
    previous = signal.getsignal(signal.SIGALRM)

    def expired(_number, _frame):
        raise TimeoutError(f"Blender keyboard regression exceeded {seconds}s")

    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def read_state(path, token, pid):
    if not path.exists():
        return None
    state = json.loads(path.read_text(encoding="utf-8"))
    if state.get("token") != token or state.get("pid") != pid:
        raise AssertionError("Observer state belongs to another fixture")
    if "error" in state:
        raise RuntimeError("Blender fixture failed: " + json.dumps(state, ensure_ascii=False))
    return state


def wait_state(path, fixture, token, seconds, predicate, description):
    deadline = time.monotonic() + seconds
    observed = None
    while True:
        if fixture.poll() is not None:
            raise RuntimeError(f"Owned Blender exited with {fixture.returncode} while waiting for {description}")
        observed = read_state(path, token, fixture.pid)
        if observed is not None and predicate(observed):
            return observed
        if time.monotonic() >= deadline:
            raise AssertionError(description + ": " + json.dumps(observed, ensure_ascii=False))
        time.sleep(0.025)


def events_after(state, sequence, kind=None):
    return [event for event in state["events"] if event["sequence"] > sequence and
            (kind is None or event["type"] == kind) and event["value"] == "PRESS"]


def exercise(args, artifacts, transcript, summary):
    with tempfile.TemporaryDirectory(prefix="dsh-cua-blender-") as temporary:
        root = Path(temporary)
        state_path = root / "state.json"
        token = uuid.uuid4().hex
        paths = {key: root / key for key in ["home", "tmp", "user", "config", "scripts", "datafiles", "extensions"]}
        for path in paths.values():
            path.mkdir(mode=0o700)
        environment = {key: value for key, value in os.environ.items() if key in {"PATH", "LANG", "LC_ALL"}}
        environment.update({"HOME": str(paths["home"]), "TMPDIR": str(paths["tmp"]),
                            "BLENDER_USER_RESOURCES": str(paths["user"]), "BLENDER_USER_CONFIG": str(paths["config"]),
                            "BLENDER_USER_SCRIPTS": str(paths["scripts"]), "BLENDER_USER_DATAFILES": str(paths["datafiles"]),
                            "BLENDER_USER_EXTENSIONS": str(paths["extensions"])})
        command = [str(args.blender), "--factory-startup", "--disable-autoexec", "--python-exit-code", "11",
                   "--window-geometry", "80", "100", "960", "640", "--python",
                   str(Path(__file__).with_name("blender_keyboard_fixture.py")), "--",
                   "--state", str(state_path), "--token", token, "--seed", SEED]
        summary.update({"blender": str(args.blender), "helper": str(args.helper), "command": command,
                        "helper_sha256": hashlib.sha256(args.helper.read_bytes()).hexdigest()})
        fixture = None
        helper = None
        cleanup_errors = []
        with private_log(artifacts / "blender.stdout.log") as stdout, private_log(artifacts / "blender.stderr.log") as stderr, \
                private_log(artifacts / "helper.stderr.log") as helper_stderr:
            class SelectedNativeHelper(support.NativeHelper):
                """Use the shared real JSONL call/eof/stop implementation with a selected binary."""
                def __init__(self):
                    self.process = subprocess.Popen([str(args.helper)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                                    stderr=helper_stderr, text=True, env=environment, start_new_session=True)
                    self.sequence = 0
                    self.transcript = transcript

                def call(self, method, params, error_code=None):
                    # A missing response leaves an explicit uncertain dispatch attempt.
                    summary["request_attempts"].append({"id": str(self.sequence + 1), "method": method, "params": params})
                    return super().call(method, params, error_code)

            try:
                with whole_run_deadline(args.total_timeout):
                    helper = SelectedNativeHelper()
                    call = helper.call
                    capabilities = call("getCapabilities", {})
                    summary["capabilities"] = capabilities
                    if not capabilities.get("permissions", {}).get("accessibility"):
                        raise RuntimeError("PERMISSION_DENIED: grant Accessibility to the responsible host/helper before this GUI test")
                    if capabilities.get("sessionLocked") is not False:
                        raise RuntimeError("The macOS desktop session is locked or unavailable")
                    fixture = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                                               cwd=root, env=environment, start_new_session=True)
                    summary["owned_blender_pid"] = fixture.pid

                    def wait(predicate, description, seconds=None):
                        return wait_state(state_path, fixture, token, seconds or args.event_timeout, predicate, description)

                    def checkpoint(name, state):
                        write_json(artifacts / (name + ".json"), state)
                        summary["completed_phases"].append(name)
                        return state

                    initial = checkpoint("00-ready", wait(lambda state: state["ready"], "Blender Text Editor readiness", args.startup_timeout))
                    summary["blender_version"] = initial["blender_version"]
                    assert initial["text"] == SEED and initial["is_in_memory"] and initial["text_is_displayed"], initial
                    app = call("getApp", {"selector": str(fixture.pid)})
                    assert app["pid"] == fixture.pid, app
                    owner = {"appHandle": app["appHandle"]}
                    call("activate", owner)
                    call("pressKey", {**owner, "key": "Escape"})
                    deadline = time.monotonic() + args.event_timeout
                    while True:
                        windows = call("listWindows", owner)
                        visible = [window for window in windows if window["isOnScreen"] and
                                   window["bounds"]["width"] > 200 and window["bounds"]["height"] > 200]
                        if len(visible) == 1:
                            window = visible[0]
                            break
                        if time.monotonic() >= deadline:
                            raise AssertionError("Expected one owned Blender document window: " + json.dumps(windows))
                        time.sleep(0.025)

                    observed = call("getState", {**owner, "windowId": window["windowId"],
                                                  "maxElements": 2000, "maxDepth": 25})
                    window_elements = [element for element in observed["elements"] if element["role"] == "AXWindow"]
                    assert len(window_elements) == 1, observed
                    call("performSecondaryAction", {**owner, "snapshotId": observed["snapshotId"],
                        "elementIndex": window_elements[0]["index"], "action": "raise"})
                    observed = call("getState", {**owner, "windowId": window["windowId"],
                                                  "maxElements": 2000, "maxDepth": 25})
                    window = next(value for value in observed["windows"] if value["windowId"] == window["windowId"])

                    # Blender region coordinates can be Retina backing pixels while native
                    # bounds use macOS points. Choose inside the fixture's large left editor;
                    # the received Blender event independently verifies the actual region.
                    x = window["bounds"]["width"] / 3
                    y = window["bounds"]["height"] / 2
                    before_click = initial["event_sequence"]
                    call("click", {**owner, "windowId": window["windowId"], "x": x, "y": y})

                    def editor_received_click(state):
                        bounds = state["region"]
                        return any(bounds["x"] <= event["mouse_x"] < bounds["x"] + bounds["width"] and
                                   bounds["y"] <= event["mouse_y"] < bounds["y"] + bounds["height"]
                                   for event in events_after(state, before_click, "LEFTMOUSE"))

                    focused = checkpoint("01-focus", wait(editor_received_click, "Native click inside Blender Text Editor"))
                    before_command = focused["event_sequence"]
                    call("pressKey", {**owner, "key": "a", "modifiers": ["command"]})
                    selected = wait(lambda state: bool(events_after(state, before_command, "A")), "Blender receipt of Command+A")
                    # Read on a later observer revision so the ordinary editor handler has
                    # completed after the pass-through event observer saw the key.
                    selected = checkpoint("02-command-a", wait(lambda state: state["revision"] > selected["revision"], "Selection after Command+A"))
                    command_events = events_after(selected, before_command, "A")
                    assert any(event["oskey"] and not event["shift"] and not event["ctrl"] and not event["alt"]
                               for event in command_events), {"reason": "Command was not observed by Blender", "state": selected}
                    assert selected["text"] == SEED and selected["selection"]["selected"] == SEED, selected

                    before_replace = selected["event_sequence"]
                    call("typeText", {**owner, "text": REPLACEMENT})
                    replaced = checkpoint("03-replaced", wait(lambda state: state["text"] == REPLACEMENT and
                        state["selection"]["collapsed"], "Command+A followed by whole-text replacement"))
                    assert any(event["unicode"] and not event["oskey"] and not event["shift"]
                               for event in events_after(replaced, before_replace)), replaced

                    before_shift = replaced["event_sequence"]
                    call("pressKey", {**owner, "key": "Left", "modifiers": ["shift"]})
                    shifted = checkpoint("04-shift-selection", wait(lambda state: state["text"] == REPLACEMENT and
                        state["selection"]["offsets"] == [len(REPLACEMENT) - 1, len(REPLACEMENT)], "Shift+Left selection of final character"))
                    assert shifted["selection"]["selected"] == "Z", shifted
                    assert any(event["shift"] and not event["oskey"] and not event["ctrl"] and not event["alt"]
                               for event in events_after(shifted, before_shift, "LEFT_ARROW")), shifted

                    call("typeText", {**owner, "text": "好"})
                    expected = REPLACEMENT[:-1] + "好"
                    after_selection = checkpoint("05-unicode-replacement", wait(lambda state: state["text"] == expected and
                        state["selection"]["collapsed"], "Unicode replacement of the shifted selection"))
                    before_plain = after_selection["event_sequence"]
                    call("pressKey", {**owner, "key": "b"})
                    plain = checkpoint("06-modifiers-released", wait(lambda state: state["text"] == expected + "b",
                                                                     "Lowercase key after modifier release"))
                    assert any(not event["oskey"] and not event["shift"] and not event["ctrl"] and not event["alt"]
                               for event in events_after(plain, before_plain, "B")), plain
                    before_unicode = plain["event_sequence"]
                    call("typeText", {**owner, "text": "中文"})
                    final = checkpoint("07-unicode-after-chords", wait(lambda state: state["text"] == expected + "b中文" and
                        state["selection"]["collapsed"], "Plain Unicode input after Command and Shift release"))
                    assert any(event["unicode"] and not event["oskey"] and not event["shift"] and
                               not event["ctrl"] and not event["alt"] for event in events_after(final, before_unicode)), final
                    summary["final_text"] = final["text"]
                    helper.eof()
                    summary["helper_exit_before_cleanup"] = helper.process.returncode
                    if fixture.poll() is not None:
                        raise RuntimeError("Blender exited before the owned test cleanup")
                    summary["status"] = "passed"
            except BaseException as error:
                summary["operation_error"] = repr(error)
                raise
            finally:
                # Each handle was created with start_new_session. Never signal by app
                # name or bundle ID: another user-owned Blender may be running.
                for label, process in [("helper", helper), ("blender", fixture)]:
                    if process is None:
                        continue
                    try:
                        if label == "helper":
                            process.stop()
                        else:
                            support.stop_group(process)
                    except Exception as error:
                        cleanup_errors.append({"process": label, "error": str(error)})
                summary["cleanup_errors"] = cleanup_errors
                if state_path.exists():
                    write_json(artifacts / "last-fixture-state.json", json.loads(state_path.read_text(encoding="utf-8")))
                if cleanup_errors:
                    summary["status"] = "failed"
                    if "operation_error" not in summary:
                        raise RuntimeError("Owned process cleanup failed: " + json.dumps(cleanup_errors))


def main():
    if not __debug__:
        raise RuntimeError("Run this assertion-based regression without Python -O")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--blender", type=Path, required=True, help="Existing official .app/Contents/MacOS/Blender executable")
    parser.add_argument("--helper", type=Path, help="Built dsh-cua-native; an older binary can be selected for a negative control")
    parser.add_argument("--artifacts", type=Path, help="Parent for a new private artifact directory")
    parser.add_argument("--startup-timeout", type=float, default=60)
    parser.add_argument("--event-timeout", type=float, default=8)
    parser.add_argument("--total-timeout", type=float, default=180)
    args = parser.parse_args()
    if os.uname().sysname != "Darwin":
        raise RuntimeError("This opt-in check requires macOS")
    args.helper = (args.helper or support.default_binary()).resolve()
    args.blender = args.blender.resolve()
    for label, path in [("Blender", args.blender), ("native helper", args.helper)]:
        if not path.is_file() or not os.access(path, os.X_OK):
            raise RuntimeError(label + " executable is unavailable: " + str(path))
    if not all(math.isfinite(value) and value > 0 for value in [args.startup_timeout, args.event_timeout, args.total_timeout]):
        raise ValueError("All timeouts must be positive and finite")
    parent = args.artifacts or repo / "tmp/cua-background-audit/blender-keyboard-runs"
    parent.mkdir(parents=True, exist_ok=True)
    artifacts = Path(tempfile.mkdtemp(prefix="run-", dir=parent))
    transcript = []
    summary = {"status": "failed", "completed_phases": [], "request_attempts": [], "artifacts": str(artifacts)}
    try:
        exercise(args, artifacts, transcript, summary)
    except Exception as error:
        summary["error"] = str(error)
        raise
    finally:
        write_json(artifacts / "native-transcript.json", transcript)
        write_json(artifacts / "summary.json", summary)
        print(json.dumps({"status": summary["status"], "artifacts": str(artifacts)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
