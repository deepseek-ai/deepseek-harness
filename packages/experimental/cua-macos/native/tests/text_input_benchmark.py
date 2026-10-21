"""Opt-in macOS text-input comparison on fresh owned Blender Text Editors.

Run after other desktop automation stops: each sample activates its own window.
Both helpers receive identical synthetic 200/2000-scalar text containing ASCII,
Chinese, emoji and newlines. Three reference/candidate pairs run serially per
length by default, each with fresh processes and private Blender user directories.

Measure complete JSONL request/reply time and time through Blender's observed
full-text equality. Startup, focus, hashing and cleanup are excluded; observer
publication/polling is included in verification latency. This bypasses DSH/model
overhead and the TypeScript request timeout. Raw samples have no speed threshold
or RSS claim. Protocol frames and fixture state are bounded and retained privately.

Example candidate options: --candidate-arg=--text-event-interval-ms
--candidate-arg=0.5. The same helper binary may be used with different arguments.
No binary is compiled and no application is downloaded by this runner.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import statistics
import tempfile
import time
import uuid

from blender_keyboard_e2e import events_after, read_state
from observation_benchmark import FramedPipe, OwnedProcess, file_sha256, json_bytes, private_write, remaining


FIXTURE = Path(__file__).with_name("blender_keyboard_fixture.py")
MAX_REQUEST_BYTES = 1024 * 1024
PATTERN = "alpha 0123456789 中文测试 🧪🙂\nbeta XYZ 9876543210 输入检查\n"


def payload(length):
    return (PATTERN * (length // len(PATTERN) + 1))[:length - 1] + "Z"


def text_facts(text):
    encoded = text.encode("utf-8")
    return {"unicodeScalars": len(text), "utf16CodeUnits": len(text.encode("utf-16-le")) // 2,
            "utf8Bytes": len(encoded), "sha256": hashlib.sha256(encoded).hexdigest()}


class InputHelper:
    """Record complete request/reply frames, including failed or partial replies."""

    def __init__(self, process, artifacts, sample, request_timeout, deadline):
        self.pipe = FramedPipe(process)
        self.artifacts = artifacts
        self.sample = sample
        self.request_timeout = request_timeout
        self.deadline = deadline
        self.sequence = 0

    def call(self, method, params):
        self.sequence += 1
        identifier = str(self.sequence)
        wire = json_bytes({"id": identifier, "method": method, "params": params}) + b"\n"
        if len(wire) > MAX_REQUEST_BYTES:
            raise RuntimeError("Native request exceeds the 1 MiB request budget")
        stem = f"{self.sequence:03d}-{method}"
        private_write(self.artifacts / (stem + ".request.jsonl"), wire)
        record = {"id": identifier, "method": method, "requestBytes": len(wire), "status": "pending"}
        self.sample["requests"].append(record)
        started = time.perf_counter_ns()
        deadline = min(self.deadline, time.monotonic() + self.request_timeout)
        raw = None
        try:
            self.pipe.write(wire, deadline)
            raw = self.pipe.frame(deadline)
            received = time.perf_counter_ns()
            reply = json.loads(raw.decode("utf-8"))
            if not isinstance(reply, dict) or reply.get("id") != identifier:
                raise RuntimeError("Native reply does not match its pending request")
            if "error" in reply:
                raise RuntimeError(f"{method} failed: {reply['error']}")
            if set(reply) != {"id", "result"}:
                raise RuntimeError("Native reply must contain only id and result")
            remaining(deadline)
            record.update({"status": "completed", "wireElapsedNs": received - started,
                           "elapsedNs": time.perf_counter_ns() - started})
            return reply["result"], started, record
        except BaseException as error:
            record.update({"status": "failed", "elapsedNs": time.perf_counter_ns() - started,
                           "error": repr(error)})
            raise
        finally:
            if raw is not None:
                private_write(self.artifacts / (stem + ".response.jsonl"), raw)
                record.update({"responseBytes": len(raw), "responseSHA256": hashlib.sha256(raw).hexdigest()})
            elif self.pipe.pending:
                private_write(self.artifacts / (stem + ".partial-response.bin"), bytes(self.pipe.pending))
                record["partialResponseBytes"] = len(self.pipe.pending)


def wait_for_state(state_path, token, fixture, deadline, predicate, description):
    while True:
        remaining(deadline)
        if fixture.poll() is not None:
            raise RuntimeError(f"Owned Blender exited before {description}: {fixture.returncode}")
        state = read_state(state_path, token, fixture.pid)
        if state is not None and predicate(state):
            return state
        time.sleep(min(0.025, remaining(deadline)))


def run_sample(args, label, repeat, length, artifacts, summary, deadline):
    text = payload(length)
    directory = artifacts / f"scalars-{length}-{repeat:02d}-{label}"
    directory.mkdir(mode=0o700)
    private_write(directory / "expected.txt", text.encode("utf-8"))
    sample = {"helper": label, "repeat": repeat, "expected": text_facts(text), "status": "pending",
              "artifacts": str(directory), "requests": []}
    summary["samples"].append(sample)
    owned = []
    state_path = None
    with tempfile.TemporaryDirectory(prefix="dsh-cua-text-input-") as temporary:
        work = Path(temporary)
        token = uuid.uuid4().hex
        state_path = work / "state.json"
        paths = {key: work / key for key in ["home", "tmp", "user", "config", "scripts", "datafiles", "extensions"]}
        for path in paths.values():
            path.mkdir(mode=0o700)
        environment = {key: value for key, value in os.environ.items() if key in {"PATH", "LANG", "LC_ALL"}}
        environment.update({"HOME": str(paths["home"]), "TMPDIR": str(paths["tmp"]),
                            **{"BLENDER_USER_" + key.upper(): str(paths[value]) for key, value in
                               [("RESOURCES", "user"), ("CONFIG", "config"), ("SCRIPTS", "scripts"),
                                ("DATAFILES", "datafiles"), ("EXTENSIONS", "extensions")]}})
        try:
            remaining(deadline)
            helper_process = OwnedProcess(summary["helpers"][label]["argv"], work, directory,
                                          "helper", environment, summary, input_pipe=True, output_pipe=True)
            owned.append(helper_process)
            helper = InputHelper(helper_process.process, directory, sample, args.request_timeout, deadline)
            capabilities, _, _ = helper.call("getCapabilities", {})
            if not capabilities.get("permissions", {}).get("accessibility"):
                raise RuntimeError("Accessibility permission is required for the responsible helper/host")
            if capabilities.get("sessionLocked") is not False:
                raise RuntimeError("The macOS desktop is locked or unavailable")
            command = [str(args.blender), "--factory-startup", "--disable-autoexec", "--python-exit-code", "11",
                       "--window-geometry", "80", "100", "960", "640", "--python", str(FIXTURE.resolve()), "--",
                       "--state", str(state_path), "--token", token, "--seed", ""]
            fixture = OwnedProcess(command, work, directory, "blender", environment, summary)
            owned.append(fixture)

            def wait(predicate, description, timeout=None):
                return wait_for_state(state_path, token, fixture.process,
                                      min(deadline, time.monotonic() + (timeout or args.event_timeout)),
                                      predicate, description)

            initial = wait(lambda state: state["ready"], "Text Editor readiness", args.startup_timeout)
            if initial["text"] != "" or not initial["is_in_memory"] or not initial["text_is_displayed"]:
                raise RuntimeError("Fresh Blender Text Editor is not empty and in memory")
            sample["blenderVersion"] = initial["blender_version"]
            app, _, _ = helper.call("getApp", {"selector": str(fixture.process.pid)})
            if app["pid"] != fixture.process.pid:
                raise RuntimeError("Native helper selected another Blender process")
            owner = {"appHandle": app["appHandle"]}
            helper.call("activate", owner)
            helper.call("pressKey", {**owner, "key": "Escape"})
            windows_deadline = min(deadline, time.monotonic() + args.event_timeout)
            while True:
                windows, _, _ = helper.call("listWindows", owner)
                visible = [window for window in windows if window["pid"] == fixture.process.pid and
                           window["isOnScreen"] and window["bounds"]["width"] > 200 and window["bounds"]["height"] > 200]
                if len(visible) == 1:
                    window = visible[0]
                    break
                time.sleep(min(0.025, remaining(windows_deadline)))
            before_click = initial["event_sequence"]
            helper.call("click", {**owner, "windowId": window["windowId"],
                                  "x": window["bounds"]["width"] / 3, "y": window["bounds"]["height"] / 2})

            def editor_received_click(state):
                region = state["region"]
                return any(region["x"] <= event["mouse_x"] < region["x"] + region["width"] and
                           region["y"] <= event["mouse_y"] < region["y"] + region["height"]
                           for event in events_after(state, before_click, "LEFTMOUSE"))

            focused = wait(editor_received_click, "native click inside the Text Editor")
            if focused["text"] != "":
                raise RuntimeError("Focus setup changed the empty fixture text")
            result, started, request = helper.call("typeText", {**owner, "text": text})
            sample["requestElapsedNs"] = request["elapsedNs"]
            if result.get("dispatched") is not True:
                raise RuntimeError("Native helper did not acknowledge text dispatch")
            final = wait(lambda state: state["revision"] > focused["revision"] and state["text"] == text and
                         state["text_is_displayed"] and state["is_in_memory"] and state["selection"]["collapsed"],
                         "full Blender text equality")
            sample.update({"textVerifiedElapsedNs": time.perf_counter_ns() - started,
                           "actual": text_facts(final["text"]), "fullTextEqual": final["text"] == text})
            private_write(directory / "verified-state.json", json_bytes(final) + b"\n")
            helper.pipe.eof(min(deadline, time.monotonic() + args.event_timeout))
            if fixture.process.poll() is not None:
                raise RuntimeError("Blender exited before owned cleanup")
            sample["status"] = "passed"
        except BaseException as error:
            sample.update({"status": "failed", "error": repr(error)})
            raise
        finally:
            # Stop pending input before terminating its target window.
            for process in owned:
                process.cleanup()
            if state_path.exists():
                state_bytes = state_path.read_bytes()
                private_write(directory / "last-fixture-state.json", state_bytes)
                last = json.loads(state_bytes)
                if isinstance(last.get("text"), str):
                    sample["lastObserved"] = text_facts(last["text"])
                    sample["fullTextEqual"] = last["text"] == text
            if any(process.record.get("cleanup") != "completed" for process in owned):
                sample["status"] = "failed"
                raise RuntimeError("Owned text-input sample processes did not finish cleanup")


def aggregate(samples):
    result = {}
    for length in [200, 2000]:
        comparison = {}
        for label in ["reference", "candidate"]:
            selected = [s for s in samples if s["helper"] == label and s["expected"]["unicodeScalars"] == length
                        and s["status"] == "passed"]
            request_ms = [s["requestElapsedNs"] / 1_000_000 for s in selected]
            verified_ms = [s["textVerifiedElapsedNs"] / 1_000_000 for s in selected]
            comparison[label] = {"passedSamples": len(selected), "requestRawMs": request_ms,
                                 "textVerifiedRawMs": verified_ms,
                                 "requestMedianMs": statistics.median(request_ms) if request_ms else None,
                                 "textVerifiedMedianMs": statistics.median(verified_ms) if verified_ms else None}
        reference, candidate = comparison["reference"], comparison["candidate"]
        if reference["passedSamples"] == candidate["passedSamples"] and reference["passedSamples"]:
            comparison["candidateOverReferenceVerifiedMedianRatio"] = candidate["textVerifiedMedianMs"] / reference["textVerifiedMedianMs"]
        result[str(length)] = comparison
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for label in ["reference", "candidate"]:
        parser.add_argument(f"--{label}-helper", type=Path, required=True)
        parser.add_argument(f"--{label}-arg", action="append", default=[], help="Repeatable helper startup argument; use --option=value")
    parser.add_argument("--blender", type=Path, required=True, help="Existing Blender.app/Contents/MacOS/Blender executable")
    parser.add_argument("--artifacts", type=Path, required=True, help="Parent for a new private evidence directory")
    parser.add_argument("--samples", type=int, default=3)
    parser.add_argument("--startup-timeout", type=float, default=60)
    parser.add_argument("--event-timeout", type=float, default=10)
    parser.add_argument("--request-timeout", type=float, default=60)
    parser.add_argument("--timeout", type=float, default=900, help="Whole run deadline, excluding bounded owned-process cleanup")
    args = parser.parse_args()
    if os.uname().sysname != "Darwin":
        parser.error("This opt-in benchmark requires macOS")
    if not 1 <= args.samples <= 5:
        parser.error("--samples must be between 1 and 5")
    for key in ["startup_timeout", "event_timeout", "request_timeout", "timeout"]:
        if not math.isfinite(getattr(args, key)) or getattr(args, key) <= 0:
            parser.error("Timeouts must be positive finite seconds")
    for key in ["reference_helper", "candidate_helper", "blender"]:
        path = getattr(args, key).resolve(strict=True)
        if not path.is_file() or not os.access(path, os.X_OK):
            parser.error(f"--{key.replace('_', '-')} must name an existing executable")
        setattr(args, key, path)
    args.artifacts.mkdir(parents=True, exist_ok=True)
    artifacts = Path(tempfile.mkdtemp(prefix="text-input-", dir=args.artifacts.resolve()))
    summary = {"status": "pending", "artifacts": str(artifacts), "startedUnixNs": time.time_ns(),
               "system": list(os.uname()), "blender": {"path": str(args.blender), "sha256": file_sha256(args.blender)},
               "helpers": {label: {"path": str(getattr(args, label + "_helper")),
                                    "sha256": file_sha256(getattr(args, label + "_helper")),
                                    "argv": [str(getattr(args, label + "_helper")), *getattr(args, label + "_arg")]}
                           for label in ["reference", "candidate"]},
               "fixtureSourceSHA256": file_sha256(FIXTURE), "samplesPerHelperAndLength": args.samples,
               "timeoutsSeconds": {key: getattr(args, key) for key in ["startup_timeout", "event_timeout", "request_timeout", "timeout"]},
               "measurement": {"request": "perf_counter_ns before complete JSONL write through validated complete response",
                               "textVerified": "same request start through Blender observer full-text equality",
                               "excluded": "startup, focus, hashing, cleanup, DSH/model/network overhead",
                               "observer": "50 ms publication with fsync; 25 ms polling, included in verification latency",
                               "order": "200 then 2000 scalars; reference then candidate per repetition; fresh processes each sample",
                               "memory": "1 MiB request and 32 MiB response caps; bounded fixture event history; no RSS measurement",
                               "verdict": "all text must match; report all samples and median ratios without speed thresholds"},
               "processes": [], "samples": []}
    deadline = time.monotonic() + args.timeout
    failure = None
    try:
        for length in [200, 2000]:
            for repeat in range(1, args.samples + 1):
                for label in ["reference", "candidate"]:
                    run_sample(args, label, repeat, length, artifacts, summary, deadline)
        for label in ["reference", "candidate"]:
            if file_sha256(getattr(args, label + "_helper")) != summary["helpers"][label]["sha256"]:
                raise RuntimeError("A helper binary changed during the benchmark")
        if file_sha256(args.blender) != summary["blender"]["sha256"] or file_sha256(FIXTURE) != summary["fixtureSourceSHA256"]:
            raise RuntimeError("Blender executable or observer source changed during the benchmark")
        summary["status"] = "passed"
    except BaseException as error:
        failure = error
        summary.update({"status": "failed", "error": repr(error)})
    finally:
        summary["statistics"] = aggregate(summary["samples"])
        summary["finishedUnixNs"] = time.time_ns()
        private_write(artifacts / "summary.json", json_bytes(summary) + b"\n")
        print(json.dumps({"status": summary["status"], "artifacts": str(artifacts)}))
    if failure is not None:
        raise failure


if __name__ == "__main__":
    main()
