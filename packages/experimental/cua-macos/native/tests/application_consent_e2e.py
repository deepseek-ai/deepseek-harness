"""Verify bundle and executable-path consent, optionally with fixture-only GUI operations."""
import argparse
import base64
import ctypes
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import uuid

from capabilities_e2e import stop_application, wait_for_state
from native_test_support import BINARY, ROOT, NativeHelper, stop


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--helper", type=Path, default=BINARY)
    parser.add_argument("--desktop", action="store_true", help="Read, click and capture owned fixture windows; requires existing system grants")
    args = parser.parse_args()
    transcript = []
    with tempfile.TemporaryDirectory(prefix="dsh-cua-consent-") as temporary, ExitStack() as cleanup:
        root = Path(temporary)
        binary = root / "fixture"
        subprocess.run(["xcrun", "swiftc", str(ROOT / "tests/CapabilitiesFixture.swift"), "-o", str(binary)],
                       check=True, timeout=60)
        identifier = "test.dsh.consent." + uuid.uuid4().hex
        expected = hashlib.sha256(("macos:bundle-id:" + identifier).encode()).hexdigest()
        helper = NativeHelper(transcript, args.helper)
        cleanup.callback(helper.stop)
        if args.desktop:
            assert helper.call("getCapabilities", {})["permissions"] == {"accessibility": True, "screenRecording": True}

        checked_windows = 0
        def check_window(app, state_path):
            nonlocal checked_windows
            if not args.desktop:
                return
            state = wait_for_state(state_path, lambda value: value["pid"] == app["pid"] and value["windowId"] > 0)
            owner = {"appHandle": app["appHandle"], "windowId": state["windowId"]}
            observed = helper.call("getState", {**owner, "maxElements": 2000, "maxDepth": 25})
            pad = next(item for item in observed["elements"] if item["role"] == "AXButton" and item["title"] == "Input receiver")
            helper.call("click", {"appHandle": app["appHandle"], "snapshotId": observed["snapshotId"], "elementIndex": pad["index"]})
            wait_for_state(state_path, lambda value: value["axPresses"] == state["axPresses"] + 1)
            captured = helper.call("screenshot", owner)
            assert base64.b64decode(captured["data"], validate=True).startswith(b"\x89PNG\r\n\x1a\n")
            checked_windows += 1

        register = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
        def fixture(name, bundle_id):
            app = root / (name + ".app")
            executable = app / "Contents/MacOS/fixture"
            executable.parent.mkdir(parents=True)
            shutil.copy2(binary, executable)
            state = root / (name + ".json")
            info = {"CFBundleName": name, "CFBundleDisplayName": name,
                    "CFBundleExecutable": "fixture", "CFBundlePackageType": "APPL",
                    "DSHFixtureStatePath": str(state), "DSHFixtureBackground": True}
            if bundle_id is not None:
                info["CFBundleIdentifier"] = bundle_id
            (app / "Contents/Info.plist").write_bytes(plistlib.dumps(info))
            cleanup.callback(subprocess.run, [register, "-u", str(app)], check=True,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
            def stop_started_fixture():
                pids = {item["pid"] for item in helper.call("findApps", {"query": str(app), "maxAppMatches": 20})
                        if item["isRunning"]}
                if state.exists():
                    pids.add(json.loads(state.read_text())["pid"])
                for pid in pids:
                    stop_application(pid)
            cleanup.callback(stop_started_fixture)
            return app, executable, state, info

        for change in ["identifier", "missing-identifier", "executable", "missing-plist"]:
            app, executable, state, info = fixture("Changed " + change, identifier + "." + change)
            pending = helper.call("getApp", {"selector": str(app)})
            plist = app / "Contents/Info.plist"
            if change == "identifier":
                info["CFBundleIdentifier"] += ".replacement"
            elif change == "missing-identifier":
                del info["CFBundleIdentifier"]
            elif change == "executable":
                info["CFBundleExecutable"] = "replacement"
                shutil.copy2(binary, executable.with_name("replacement"))
            if change == "missing-plist":
                plist.unlink()
            else:
                plist.write_bytes(plistlib.dumps(info))
            helper.call("launchApp", {"appHandle": pending["appHandle"]}, error_code="STALE_APP")
            assert not state.exists(), "The replaced application was started before refusal"
            assert not any(item["isRunning"] for item in helper.call("findApps", {"query": str(app), "maxAppMatches": 20})), \
                "The replaced application is running after refusal"

        identities = []
        mixed_case_identifier = "Test.DSH.MixedCase." + uuid.uuid4().hex
        for name, bundle_id in [("Version One", identifier), ("Version Two", identifier), ("Other", identifier + ".other"), ("No identifier", None), ("Mixed case", mixed_case_identifier)]:
            app, executable, state, info = fixture(name, bundle_id)
            pending = helper.call("getApp", {"selector": str(app)})
            assert pending["pid"] is None and not state.exists(), pending
            assert pending["authorization"]["persistable"] is True, pending
            launched = helper.call("launchApp", {"appHandle": pending["appHandle"]})
            pid = launched["pid"]
            wait_for_state(state, lambda value: value["pid"] == pid)
            running = helper.call("getApp", {"selector": str(pid)})
            assert running["authorization"]["id"] == pending["authorization"]["id"], (pending, running)
            assert running["authorization"]["persistable"] is True, running
            assert Path(running["authorization"]["executablePath"]).samefile(executable), running
            assert Path(pending["authorization"]["executablePath"]).samefile(executable), pending
            identities.append(running["authorization"]["id"])
            if bundle_id is None:
                # Foundation normalizes /private/var to /var; pathlib.resolve preserves /private/var.
                authorization = running["authorization"]
                expected_path = hashlib.sha256(("macos:executable-path:" + authorization["executablePath"]).encode()).hexdigest()
                assert authorization["id"] == expected_path, authorization
            check_window(running, state)
        assert identities[0] == identities[1] == expected, identities
        assert identities[2] != expected, identities
        assert identities[4] == hashlib.sha256(("macos:bundle-id:" + mixed_case_identifier).encode()).hexdigest(), identities

        app, executable, state, _ = fixture("Direct bundle", identifier)
        pending = helper.call("getApp", {"selector": str(app)})
        process = subprocess.Popen([str(executable)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
        cleanup.callback(stop, process)
        wait_for_state(state, lambda value: value["pid"] == process.pid and value["windowId"] > 0)
        running = helper.call("getApp", {"selector": str(process.pid)})
        assert running["authorization"]["id"] == pending["authorization"]["id"] == expected, running["authorization"]
        check_window(running, state)

        standalone_ids = []
        for index in range(2):
            state = root / f"standalone-{index}.json"
            process = subprocess.Popen([str(binary), str(state), "--background"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
            cleanup.callback(stop, process)
            try:
                wait_for_state(state, lambda value: value["pid"] == process.pid and value["windowId"] > 0)
                running = helper.call("getApp", {"selector": str(process.pid)})
                authorization = running["authorization"]
                assert running.get("bundleId") is None and authorization["persistable"] is True, authorization
                assert Path(authorization["executablePath"]).samefile(binary), authorization
                standalone_ids.append(authorization["id"])
                check_window(running, state)
            finally:
                stop(process)
        assert standalone_ids[0] == standalone_ids[1], standalone_ids

        libsystem = ctypes.CDLL(None, use_errno=True)
        libsystem.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        libsystem.proc_pidpath.restype = ctypes.c_int
        for name, bundle_id in [("Deleted bundle executable", identifier), ("Deleted path executable", None)]:
            app, executable, state, _ = fixture(name, bundle_id)
            pending = helper.call("getApp", {"selector": str(app)})
            launched = helper.call("launchApp", {"appHandle": pending["appHandle"]})
            pid = launched["pid"]
            wait_for_state(state, lambda value: value["pid"] == pid and value["windowId"] > 0)
            executable.unlink()
            buffer = ctypes.create_string_buffer(4096)
            ctypes.set_errno(0)
            copied = libsystem.proc_pidpath(pid, buffer, len(buffer))
            path_error = ctypes.get_errno()
            if bundle_id is None and copied == 0:
                failure = helper.call("getApp", {"selector": str(pid)}, error_code="APP_PATH_UNAVAILABLE")
                assert "exited" not in failure["message"], failure
            else:
                running = helper.call("getApp", {"selector": str(pid)})
                authorization = running["authorization"]
                assert authorization["id"] == pending["authorization"]["id"] and authorization["persistable"] is True, authorization
                if copied == 0:
                    assert "executablePath" not in authorization, authorization
                if args.desktop:
                    try:
                        helper.call("getState", {"appHandle": running["appHandle"], "maxElements": 2000, "maxDepth": 25})
                    except AssertionError:
                        observation = helper.transcript[-1]
                        assert observation["response"]["id"] == observation["request"]["id"], observation
                        failure = observation["response"]["error"]
                        assert failure["code"] in ["PERMISSION_DENIED", "NATIVE_ERROR", "WINDOW_UNAVAILABLE"], failure
                        print("Deleted executable observation:", json.dumps(failure))
                    else:
                        print("Deleted executable observation: succeeded")
            os.kill(pid, 0)
            print(f"Deleted executable: bundle_id={bundle_id is not None}, proc_pidpath_bytes={copied}, errno={path_error}")
        print("PASS: changed bundles cannot launch; cold/running and direct-bundle identities agree; copies share consent; other IDs stay separate; missing IDs and standalone GUIs use persistent paths across restarts"
              + (f"; {checked_windows} GUI instances expose controls, receive an AX click and produce a PNG" if args.desktop else ""))


if __name__ == "__main__":
    main()
