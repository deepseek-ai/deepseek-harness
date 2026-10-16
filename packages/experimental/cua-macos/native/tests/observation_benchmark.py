"""Opt-in, read-only getState comparison on owned AppKit windows with 35 and 400 static rows.

Only fixture startup can activate an application. Each helper gets one recorded
warm-up, followed by three alternating reference/candidate observations. All result
fields must match; only helper-generated appHandle and snapshotId are excluded.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import select
import statistics
import subprocess
import tempfile
import time

from native_test_support import ROOT, stop_group


MAX_FRAME_BYTES = 32 * 1024 * 1024
OBSERVATION_LIMITS = {"maxElements": 10000, "maxDepth": 100}
READ_ONLY_METHODS = {"getCapabilities", "getApp", "listWindows", "getState"}


def remaining(deadline):
    value = deadline - time.monotonic()
    if value <= 0:
        raise TimeoutError("Observation benchmark exhausted its deadline")
    return value


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def private_write(path, data):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as stream:
        stream.write(data)


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


class OwnedProcess:
    def __init__(self, argv, cwd, artifacts, name, environment, summary, input_pipe=False, output_pipe=False):
        self.logs = []
        self.cleaned = False
        self.record = {"name": name, "argv": argv, "stderr": str(artifacts / f"{name}.stderr.log")}
        try:
            stderr = self.log(artifacts / f"{name}.stderr.log")
            stdout = subprocess.PIPE if output_pipe else self.log(artifacts / f"{name}.stdout.log")
            self.process = subprocess.Popen(argv, cwd=cwd, env=environment, start_new_session=True, bufsize=0,
                                            stdin=subprocess.PIPE if input_pipe else subprocess.DEVNULL,
                                            stdout=stdout, stderr=stderr)
        except BaseException:
            for stream in self.logs:
                stream.close()
            raise
        self.record["pid"] = self.process.pid
        summary["processes"].append(self.record)

    def log(self, path):
        stream = os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb")
        self.logs.append(stream)
        return stream

    def cleanup(self):
        if self.cleaned:
            return
        self.cleaned = True
        self.record["exitBeforeCleanup"] = self.process.poll()
        try:
            stop_group(self.process)
            self.record["cleanup"] = "completed"
        except BaseException as error:
            self.record["cleanup"] = "failed"
            self.record["cleanupError"] = repr(error)
        finally:
            self.record["exitAfterCleanup"] = self.process.poll()
            for stream in [self.process.stdin, self.process.stdout, self.process.stderr, *self.logs]:
                if stream is not None and not stream.closed:
                    stream.close()


class FramedPipe:
    """Nonblocking pipe reads and writes share the full operation deadline, including partial lines."""
    def __init__(self, process):
        self.process = process
        self.pending = bytearray()
        os.set_blocking(process.stdout.fileno(), False)
        if process.stdin is not None:
            os.set_blocking(process.stdin.fileno(), False)

    def write(self, data, deadline):
        pending = memoryview(data)
        while pending:
            if not select.select([], [self.process.stdin], [], remaining(deadline))[1]:
                raise TimeoutError("Helper did not accept the complete request before its deadline")
            try:
                written = os.write(self.process.stdin.fileno(), pending)
            except BlockingIOError:
                continue
            if written == 0:
                raise RuntimeError("Helper stdin accepted zero bytes")
            pending = pending[written:]

    def read_chunk(self, deadline):
        while True:
            if not select.select([self.process.stdout], [], [], remaining(deadline))[0]:
                raise TimeoutError("Helper did not return the complete response before its deadline")
            try:
                return os.read(self.process.stdout.fileno(), 65536)
            except BlockingIOError:
                continue

    def frame(self, deadline):
        while True:
            newline = self.pending.find(b"\n")
            if newline >= 0:
                frame = bytes(self.pending[:newline + 1])
                del self.pending[:newline + 1]
                if self.pending:
                    raise AssertionError("Helper emitted data beyond its one pending response")
                return frame
            chunk = self.read_chunk(deadline)
            if not chunk:
                raise RuntimeError("Helper stdout ended before a complete response")
            self.pending.extend(chunk)
            if len(self.pending) > MAX_FRAME_BYTES:
                raise AssertionError("Observation exceeded the unchanged 32 MiB response budget")

    def eof(self, deadline):
        self.process.stdin.close()
        self.process.stdin = None
        if self.pending:
            raise AssertionError("Unconsumed helper response before EOF")
        while True:
            chunk = self.read_chunk(deadline)
            if not chunk:
                break
            raise AssertionError(f"Unexpected stdout after the final response: {chunk[:512]!r}")
        self.process.wait(timeout=remaining(deadline))
        if self.process.returncode != 0:
            raise AssertionError(f"Helper did not exit normally after EOF: {self.process.returncode}")


class ObservationHelper:
    def __init__(self, owned, label, binary_sha, artifacts, request_timeout, deadline, scenario):
        self.owned = owned
        self.pipe = FramedPipe(owned.process)
        self.label = label
        self.binary_sha = binary_sha
        self.artifacts = artifacts
        self.request_timeout = request_timeout
        self.deadline = deadline
        self.sequence = 0
        self.scenario = scenario

    def call(self, method, params, phase, group=None):
        if method not in READ_ONLY_METHODS:
            raise AssertionError(f"Benchmark cannot send input operation {method}")
        self.sequence += 1
        identifier = f"{self.label}-{self.sequence}"
        wire = json_bytes({"id": identifier, "method": method, "params": params}) + b"\n"
        stem = f"{identifier}-{phase}-{method}"
        private_write(self.artifacts / f"{stem}.request.jsonl", wire)
        record = {"helper": self.label, "helperSHA256": self.binary_sha, "phase": phase, "group": group,
                  "method": method, "requestId": identifier, "status": "pending"}
        self.scenario["requests"].append(record)
        started = time.perf_counter_ns()
        deadline = min(self.deadline, time.monotonic() + self.request_timeout)
        raw = None
        try:
            self.pipe.write(wire, deadline)
            raw = self.pipe.frame(deadline)
            received = time.perf_counter_ns()
            reply = json.loads(raw.decode("utf-8"))
            if not isinstance(reply, dict) or reply.get("id") != identifier:
                raise AssertionError("Helper response has no matching request ID")
            if "error" in reply:
                raise AssertionError(f"{self.label} {method}: {reply['error']}")
            if set(reply) != {"id", "result"}:
                raise AssertionError("Helper response must contain only id and result")
            result = reply["result"]
            remaining(deadline)
            record.update({"status": "completed", "elapsedNs": time.perf_counter_ns() - started,
                           "wireElapsedNs": received - started})
            return result, record
        except BaseException as error:
            record.update({"status": "failed", "elapsedNs": time.perf_counter_ns() - started, "error": repr(error)})
            raise
        finally:
            if raw is not None:
                path = self.artifacts / f"{stem}.response.jsonl"
                private_write(path, raw)
                record.update({"responseFile": str(path), "responseBytes": len(raw), "responseSHA256": sha256(raw)})
            elif self.pipe.pending:
                path = self.artifacts / f"{stem}.partial-response.bin"
                private_write(path, bytes(self.pipe.pending))
                record.update({"partialResponseFile": str(path), "partialResponseBytes": len(self.pipe.pending)})


def same_value(left, right):
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(same_value(left[key], right[key]) for key in left)
    if isinstance(left, list):
        return len(left) == len(right) and all(same_value(a, b) for a, b in zip(left, right))
    return left == right


def check_observation(value, row_count, fixture_pid, window_id):
    required = {"appHandle", "snapshotId", "pid", "windowId", "tree", "elements", "windows", "focusedWindowId", "truncated"}
    if not isinstance(value, dict) or not required.issubset(value):
        raise AssertionError("Observation is missing required result fields")
    if value["pid"] != fixture_pid or value["windowId"] != window_id:
        raise AssertionError("Observation belongs to a different fixture process or window")
    if value["truncated"] is not False:
        raise AssertionError("Complete benchmark observation was truncated")
    if not isinstance(value["tree"], str) or not isinstance(value["elements"], list) or not isinstance(value["windows"], list):
        raise AssertionError("Observation tree, elements or windows have unexpected types")
    labels = {int(number) for number in re.findall(r"\bScroll row ([0-9]+)\b", value["tree"])}
    if labels != set(range(1, row_count + 1)):
        raise AssertionError(f"Observation omitted static rows: expected {row_count}, found {len(labels)}")
    return {key: item for key, item in value.items() if key not in {"appHandle", "snapshotId"}}


def aggregate(scenario):
    samples = [record for record in scenario["requests"] if record["phase"] == "sample" and record["status"] == "completed"]
    statistics_by_helper = {}
    for label in ["reference", "candidate"]:
        selected = [record for record in samples if record["helper"] == label]
        if selected:
            milliseconds = [record["elapsedNs"] / 1_000_000 for record in selected]
            statistics_by_helper[label] = {"sampleCount": len(selected), "rawMs": milliseconds,
                                           "medianMs": statistics.median(milliseconds), "minMs": min(milliseconds),
                                           "maxMs": max(milliseconds), "responseBytes": [record["responseBytes"] for record in selected]}
    result = {"helpers": statistics_by_helper}
    if all(statistics_by_helper.get(label, {}).get("sampleCount") == 3 for label in ["reference", "candidate"]):
        reference = statistics_by_helper["reference"]["medianMs"]
        candidate = statistics_by_helper["candidate"]["medianMs"]
        result["candidateOverReferenceMedianRatio"] = candidate / reference if reference else None
    return result


def scenario_run(args, binary, work, artifacts, row_count, deadline, summary, owned):
    scenario = {"rowCount": row_count, "limits": OBSERVATION_LIMITS, "warmupCallsPerHelper": 1,
                "measuredGroups": 3, "order": ["reference", "candidate"], "requests": [], "status": "pending"}
    summary["scenarios"].append(scenario)
    directory = work / f"rows-{row_count}"
    directory.mkdir(mode=0o700)
    records = artifacts / f"rows-{row_count}"
    records.mkdir(mode=0o700)
    environment = {key: value for key, value in os.environ.items() if key in {"PATH", "LANG", "LC_ALL"}}
    environment["TMPDIR"] = str(directory)
    case_owned = []
    try:
        helpers = {}
        for label, helper_path in [("reference", args.reference_helper), ("candidate", args.candidate_helper)]:
            slot = OwnedProcess([str(helper_path)], directory, records, label, environment, summary, input_pipe=True, output_pipe=True)
            owned.append(slot)
            case_owned.append(slot)
            helper = ObservationHelper(slot, label, summary["helpers"][label]["sha256"], records,
                                       args.request_timeout, deadline, scenario)
            helpers[label] = helper
            capabilities, _ = helper.call("getCapabilities", {}, "setup")
            if capabilities.get("sessionLocked") is not False or capabilities.get("permissions", {}).get("accessibility") is not True:
                raise RuntimeError("Benchmark needs an unlocked session and an existing Accessibility grant")
        state_path = directory / "fixture-state.json"
        fixture = OwnedProcess([str(binary), str(state_path), str(row_count)], directory, records, "fixture",
                               environment, summary, output_pipe=True)
        owned.append(fixture)
        case_owned.append(fixture)
        ready = FramedPipe(fixture.process).frame(min(deadline, time.monotonic() + 60))
        if ready != b"READY\n":
            raise AssertionError(f"Fixture readiness marker differs: {ready!r}")
        initial = json.loads(state_path.read_text(encoding="utf-8"))
        if initial.get("rowCount") != row_count:
            raise AssertionError("Fixture row count differs from requested workload")
        window_id = initial["primaryWindowId"]
        scenario.update({"fixturePID": fixture.process.pid, "windowID": window_id})
        private_write(records / "fixture-initial.json", json_bytes(initial) + b"\n")
        owners = {}
        for label, helper in helpers.items():
            app, _ = helper.call("getApp", {"selector": str(fixture.process.pid)}, "setup")
            if app["pid"] != fixture.process.pid:
                raise AssertionError("Helper selected a different process")
            owners[label] = {"appHandle": app["appHandle"]}
            readiness_deadline = min(deadline, time.monotonic() + 60)
            while True:
                windows, _ = helper.call("listWindows", owners[label], "setup")
                window = next((item for item in windows if item["windowId"] == window_id), None)
                if window is not None and [window["bounds"]["width"], window["bounds"]["height"]] == initial["primaryWindowSize"]:
                    break
                remaining(readiness_deadline)
                time.sleep(min(0.025, remaining(readiness_deadline)))
        baseline = None
        for phase, group in [("warmup", None), ("sample", 1), ("sample", 2), ("sample", 3)]:
            for label in ["reference", "candidate"]:
                params = {**owners[label], "windowId": window_id, **OBSERVATION_LIMITS}
                result, record = helpers[label].call("getState", params, phase, group)
                observation = check_observation(result, row_count, fixture.process.pid, window_id)
                record.update({"observationSHA256": sha256(json_bytes(observation)),
                               "treeUTF8Bytes": len(result["tree"].encode("utf-8")), "elementCount": len(result["elements"]),
                               "windowCount": len(result["windows"]), "staticRows": row_count})
                if baseline is None:
                    baseline = observation
                fields = set(baseline) | set(observation)
                record["equalFields"] = {field: field in baseline and field in observation and same_value(baseline[field], observation[field])
                                         for field in sorted(fields)}
                mismatches = [field for field, equal in record["equalFields"].items() if not equal]
                if mismatches:
                    raise AssertionError(f"rows={row_count} {phase} group={group} {label}: result fields differ: {mismatches}")
        final = json.loads(state_path.read_text(encoding="utf-8"))
        private_write(records / "fixture-final.json", json_bytes(final) + b"\n")
        if not same_value(initial, final):
            raise AssertionError("Read-only observations changed the fixture state")
        for helper in helpers.values():
            helper.pipe.eof(min(deadline, time.monotonic() + 30))
        for label, path in [("reference", args.reference_helper), ("candidate", args.candidate_helper)]:
            if file_sha256(path) != summary["helpers"][label]["sha256"]:
                raise AssertionError(f"{label} helper binary changed during the benchmark")
        scenario["status"] = "passed"
    except BaseException as error:
        scenario.update({"status": "failed", "error": repr(error)})
        raise
    finally:
        for process in reversed(case_owned):
            process.cleanup()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference-helper", type=Path, required=True)
    parser.add_argument("--candidate-helper", type=Path, required=True)
    parser.add_argument("--artifacts", type=Path, required=True, help="Parent directory for a new private benchmark evidence directory")
    parser.add_argument("--request-timeout", type=float, default=120, help="Complete request/response deadline in seconds")
    parser.add_argument("--timeout", type=float, default=900, help="Whole run deadline in seconds, excluding bounded owned-process cleanup")
    args = parser.parse_args()
    if os.uname().sysname != "Darwin":
        parser.error("This owned AppKit benchmark requires macOS")
    for key in ["request_timeout", "timeout"]:
        value = getattr(args, key)
        if not math.isfinite(value) or value <= 0:
            parser.error(f"--{key.replace('_', '-')} must be positive and finite")
    for key in ["reference_helper", "candidate_helper"]:
        path = getattr(args, key).resolve(strict=True)
        if not path.is_file() or not os.access(path, os.X_OK):
            parser.error(f"--{key.replace('_', '-')} must name an existing executable")
        setattr(args, key, path)
    args.artifacts.mkdir(parents=True, exist_ok=True)
    artifacts = Path(tempfile.mkdtemp(prefix="observation-", dir=args.artifacts.resolve()))
    fixture_source = ROOT / "tests" / "Fixture.swift"
    summary = {"status": "pending", "artifacts": str(artifacts), "startedUnixNs": time.time_ns(),
               "system": dict(zip(os.uname()._fields, os.uname())) if hasattr(os.uname(), "_fields") else list(os.uname()),
               "helpers": {label: {"path": str(path), "sha256": file_sha256(path)} for label, path in
                           [("reference", args.reference_helper), ("candidate", args.candidate_helper)]},
               "fixtureSourceSHA256": file_sha256(fixture_source), "requestTimeoutSeconds": args.request_timeout,
               "runTimeoutSeconds": args.timeout, "excludedResultFields": ["appHandle", "snapshotId"],
               "measurement": "monotonic request write through complete validated JSON reply; warmups recorded but excluded from statistics",
               "memory": "One full baseline and current observation retained per case; no RSS claim; 32 MiB frame cap",
               "processes": [], "scenarios": []}
    deadline = time.monotonic() + args.timeout
    owned = []
    failure = None
    try:
        with tempfile.TemporaryDirectory(prefix="dsh-cua-observation-") as temporary:
            work = Path(temporary)
            binary = work / "observation-fixture"
            environment = {key: value for key, value in os.environ.items() if key in {"PATH", "LANG", "LC_ALL"}}
            environment["TMPDIR"] = str(work)
            compiler = OwnedProcess(["xcrun", "swiftc", str(fixture_source), "-o", str(binary)], work, artifacts,
                                    "fixture-build", environment, summary)
            owned.append(compiler)
            try:
                compiler.process.wait(timeout=remaining(deadline))
                if compiler.process.returncode != 0:
                    raise RuntimeError(f"Fixture compilation failed: {compiler.process.returncode}")
            finally:
                compiler.cleanup()
            summary["fixtureBinarySHA256"] = file_sha256(binary)
            for row_count in [35, 400]:
                scenario_run(args, binary, work, artifacts, row_count, deadline, summary, owned)
                if any(process.record.get("cleanup") != "completed" for process in owned):
                    raise RuntimeError("Owned benchmark processes did not finish cleanup")
            if file_sha256(fixture_source) != summary["fixtureSourceSHA256"]:
                raise AssertionError("Fixture source changed during the benchmark")
            summary["status"] = "passed"
    except BaseException as error:
        failure = error
        summary.update({"status": "failed", "error": repr(error)})
    finally:
        for process in reversed(owned):
            process.cleanup()
        cleanup_errors = [process.record for process in owned if process.record.get("cleanup") != "completed"]
        if cleanup_errors:
            summary["status"] = "failed"
            summary["cleanupErrors"] = cleanup_errors
        for scenario in summary["scenarios"]:
            scenario["statistics"] = aggregate(scenario)
        summary["finishedUnixNs"] = time.time_ns()
        private_write(artifacts / "summary.json", json.dumps(summary, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8") + b"\n")
        print(json.dumps({"status": summary["status"], "artifacts": str(artifacts)}, ensure_ascii=False))
    if failure is not None:
        raise failure
    if summary["status"] != "passed":
        raise RuntimeError("Owned benchmark processes did not finish cleanup")


if __name__ == "__main__":
    main()
