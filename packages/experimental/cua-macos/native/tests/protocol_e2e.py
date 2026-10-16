"""JSONL admission and EOF regression without desktop observations or input.

Every request is malformed or fails before native platform observations.
This runs the chosen helper in a private owned process group.
"""
import argparse
import json
import math
import os
import select
from pathlib import Path
import subprocess
import tempfile
import time

from native_test_support import BINARY, stop_group


def request(identifier, method, params):
    return json.dumps({"id": identifier, "method": method, "params": params},
                      ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def cases():
    # (wire bytes, expected response ID, error code, exact method-level message or None)
    result = [
        (request("first", "protocol-absent", {}), "first", "UNSUPPORTED",
         "Unsupported native operation: protocol-absent"),
        (b"{", None, "INVALID_REQUEST", None),
        (b"", None, "INVALID_REQUEST", None),
        (b" \t ", None, "INVALID_REQUEST", None),
        (b"null", None, "INVALID_REQUEST", None),
        (b"[]", None, "INVALID_REQUEST", None),
        (b"true", None, "INVALID_REQUEST", None),
        (b"{}", None, "INVALID_REQUEST", None),
        (b'{"id":7,"method":"protocol-absent","params":{}}', None, "INVALID_REQUEST", None),
        (b'{"id":"bad-method","method":false,"params":{}}', None, "INVALID_REQUEST", None),
        (b'{"id":"missing-params","method":"protocol-absent"}', None, "INVALID_REQUEST", None),
        (b'{"id":"extra","method":"protocol-absent","params":{},"extra":true}',
         None, "INVALID_REQUEST", None),
        (b'{"id":"one","id":"two","method":"protocol-absent","params":{}}',
         None, "INVALID_REQUEST", None),
        (b'{"id":"duplicate-method","method":"one","method":"two","params":{}}',
         None, "INVALID_REQUEST", None),
        (request("array-params", "listApps", []), "array-params", "INVALID_ARGUMENT", "params must be an object"),
        (request("null-params", "listApps", None), "null-params", "INVALID_ARGUMENT", "params must be an object"),
        (request("scalar-params", "protocol-absent", False), "scalar-params", "INVALID_ARGUMENT",
         "params must be an object"),
        (request("unknown-param", "listApps", {"launch": True}), "unknown-param", "INVALID_ARGUMENT",
         "Unknown operation parameter"),
        (request("capture-debug", "screenshot", {"unexpected": "private capture content"}),
         "capture-debug", "INVALID_ARGUMENT", "Unknown operation parameter"),
        (request("", "protocol-absent", {}), "", "UNSUPPORTED", "Unsupported native operation: protocol-absent"),
        (request("call-中文-🧪", "protocol-absent\noperation", {}), "call-中文-🧪", "UNSUPPORTED",
         "Unsupported native operation: protocol-absent\noperation"),
    ]
    result.append((request("hover-button", "hover", {"mouseButton": "left"}), "hover-button", "INVALID_ARGUMENT",
                   "Unknown operation parameter"))
    for index in range(24):
        identifier = f"ordered-{index:02d}"
        method = f"protocol-absent-{index:02d}"
        result.append((request(identifier, method, {}), identifier, "UNSUPPORTED",
                       f"Unsupported native operation: {method}"))
    result.append((request("unterminated-tail", "protocol-final", {}), "unterminated-tail", "UNSUPPORTED",
                   "Unsupported native operation: protocol-final"))
    return result


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise AssertionError(f"Helper emitted duplicate JSON member {key!r}")
        value[key] = item
    return value


def validate(stdout, stderr, expected):
    assert stdout.endswith(b"\n"), f"Last response was not newline-terminated: {stdout!r}"
    frames = stdout.split(b"\n")[:-1]
    assert len(frames) == len(expected), (len(frames), len(expected), stdout)
    for index, (frame, (_, identifier, code, message)) in enumerate(zip(frames, expected)):
        assert frame, f"Empty stdout frame at index {index}"
        response = json.loads(frame.decode("utf-8"), object_pairs_hook=unique_object)
        assert isinstance(response, dict) and set(response) == {"id", "error"}, (index, response)
        assert response["id"] == identifier, (index, identifier, response)
        error = response["error"]
        assert isinstance(error, dict) and set(error) == {"code", "message"}, (index, response)
        assert error["code"] == code, (index, code, response)
        assert isinstance(error["message"], str) and error["message"], (index, response)
        if message is not None:
            assert error["message"] == message, (index, message, response)
    if any(identifier == "capture-debug" for _, identifier, _, _ in expected):
        prefix = b"[cua-screenshot] "
        records = [json.loads(line[len(prefix):]) for line in stderr.splitlines() if line.startswith(prefix)]
        records = [item for item in records if item["requestId"] == "capture-debug"]
        assert records[0]["stage"] == "helper.received", records
        assert any(item.get("errorCode") == "INVALID_ARGUMENT" for item in records), records
        assert all(set(item) <= {"requestId", "stage", "elapsedMs", "errorCode"} for item in records), records
        assert all(item["elapsedMs"] >= 0 for item in records), records
        assert b"private capture content" not in stderr


def exercise(helper, directory, payload, expected, timeout):
    environment = {key: value for key, value in os.environ.items() if key in {"PATH", "LANG", "LC_ALL"}}
    environment["TMPDIR"] = str(directory)
    process = subprocess.Popen([str(helper)], cwd=directory, env=environment, start_new_session=True,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    operation_error = None
    cleanup_error = None
    try:
        # communicate bounds pipe writes, partial output frames, EOF draining and process exit together.
        stdout, stderr = process.communicate(input=payload, timeout=timeout)
        assert process.returncode == 0, (process.returncode, stdout, stderr)
        validate(stdout, stderr, expected)
    except subprocess.TimeoutExpired as error:
        operation_error = AssertionError(
            f"Helper did not finish EOF drain within {timeout}s; timeout is not successful exit. "
            f"stdout={error.output!r}; stderr={error.stderr!r}"
        )
    except Exception as error:
        operation_error = error
    finally:
        try:
            stop_group(process)
        except Exception as error:
            cleanup_error = error
        finally:
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream is not None and not stream.closed:
                    stream.close()
    if operation_error is not None and cleanup_error is not None:
        raise RuntimeError(f"Protocol failure: {operation_error}; owned-process cleanup failure: {cleanup_error}") from operation_error
    if operation_error is not None:
        raise operation_error
    if cleanup_error is not None:
        raise cleanup_error


def exercise_live_pipe(helper, directory, timeout):
    environment = {key: value for key, value in os.environ.items() if key in {"PATH", "LANG", "LC_ALL"}}
    environment["TMPDIR"] = str(directory)
    process = subprocess.Popen([str(helper)], cwd=directory, env=environment, start_new_session=True,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
    deadline = time.monotonic() + timeout
    try:
        for identifier in ["live-first", "live-second"]:
            method = "protocol-live-absent"
            wire = request(identifier, method, {})
            process.stdin.write(wire + b"\n")
            process.stdin.flush()
            frame = b""
            while b"\n" not in frame:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not select.select([process.stdout], [], [], remaining)[0]:
                    raise AssertionError("Helper waited for EOF or more bytes instead of replying on its live stdin pipe")
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    raise AssertionError("Helper exited before replying on the live stdin pipe")
                frame += chunk
                assert len(frame) <= 1024 * 1024, "Admission response exceeded the fixture byte budget"
            validate(frame, b"", [(wire, identifier, "UNSUPPORTED", f"Unsupported native operation: {method}")])
        process.stdin.close()
        process.stdin = None
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise AssertionError("Live-pipe validation exhausted its deadline before EOF cleanup")
        stdout, stderr = process.communicate(timeout=remaining)
        assert process.returncode == 0 and stdout == b"", (process.returncode, stdout, stderr)
    finally:
        stop_group(process)
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None and not stream.closed:
                stream.close()


def main():
    if not __debug__:
        raise RuntimeError("Run this assertion-based regression without Python -O")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--helper", type=Path, default=BINARY, help="Built JSONL helper; defaults to native_test_support.BINARY")
    parser.add_argument("--timeout", type=float, default=30, help="Seconds allowed for each owned helper to drain and exit")
    args = parser.parse_args()
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error("--timeout must be positive and finite")
    helper = args.helper.resolve(strict=True)
    if not helper.is_file() or not os.access(helper, os.X_OK):
        parser.error("--helper must name an executable file")
    expected = cases()
    # A complete final frame remains valid when the writer closes without a newline.
    payload = b"\n".join(case[0] for case in expected)
    malformed = [(b'{"id":"broken-tail","method":', None, "INVALID_REQUEST", None)]
    with tempfile.TemporaryDirectory(prefix="dsh-cua-protocol-") as temporary:
        root = Path(temporary)
        for name, wire, replies in [
            ("ordered", payload, expected),
            ("malformed-tail", malformed[0][0], malformed),
        ]:
            directory = root / name
            directory.mkdir(mode=0o700)
            exercise(helper, directory, wire, replies, args.timeout)
        live = root / "live-pipe"
        live.mkdir(mode=0o700)
        exercise_live_pipe(helper, live, args.timeout)
    print(f"PASS: {len(expected) + len(malformed) + 2} admission errors, live stdin replies, ordered JSONL responses, "
          "separate stdout/stderr, unterminated EOF frames and normal helper exit")


if __name__ == "__main__":
    main()
