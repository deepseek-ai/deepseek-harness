"""Verify independent helper responsibility across nested GUI launchers and helper reuse; no TCC grants are required."""
import argparse
import base64
from contextlib import ExitStack
import hashlib
import json
from pathlib import Path
import plistlib
import shutil
import struct
import subprocess
import tempfile
import uuid

from native_test_support import copy_helper, default_binary, ROOT, unregister_helper
from shared_helper_e2e import Connection, wait_released


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--helper", type=Path, default=None)
    args = parser.parse_args()
    args.helper = args.helper or default_binary()
    with tempfile.TemporaryDirectory(prefix="cua-", dir="/tmp") as temporary, ExitStack() as cleanup:
        root = Path(temporary)
        helper = copy_helper(args.helper, root)
        cleanup.callback(unregister_helper, helper)
        key = hashlib.sha256(helper.read_bytes()).hexdigest()
        runtime = root / "r"
        bare = root / "unbundled-helper"
        shutil.copy2(helper, bare)
        rejected = subprocess.run([str(bare), "--ensure-shared", "--runtime-key", key,
                                   "--runtime-directory", str(runtime), "--startup-timeout-ms", "10000"],
                                  capture_output=True, text=True, timeout=15)
        assert rejected.returncode == 1 and "requires its signed application bundle" in rejected.stderr, rejected
        bundle = root / "Visual Studio Code.app"
        binaries = bundle / "Contents" / "MacOS"
        binaries.mkdir(parents=True)
        launcher = binaries / "launcher"
        subprocess.run(["xcrun", "swiftc", "-parse-as-library", str(ROOT / "tests/LauncherFixture.swift"), "-o", str(launcher)],
                       check=True, timeout=60)
        nested = root / "Harness Dev.app"
        nested_launcher = nested / "Contents" / "MacOS" / "launcher"
        nested_launcher.parent.mkdir(parents=True)
        shutil.copy2(launcher, nested_launcher)
        identity = uuid.uuid4().hex
        register = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
        for role, application, name in [("owner", bundle, "Code"), ("nested", nested, "Harness Dev")]:
            with (application / "Contents" / "Info.plist").open("wb") as output:
                plistlib.dump({"CFBundleExecutable": "launcher",
                              "CFBundleIdentifier": f"dev.dsh.cua.launcher-fixture.{role}-{identity}",
                              "CFBundleName": name, "CFBundleDisplayName": name, "CFBundlePackageType": "APPL",
                              "LSUIElement": True}, output)
            cleanup.callback(subprocess.run, [register, "-u", str(application)], check=True,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        ready_file, stderr_file = root / "ready.json", root / "stderr.log"
        # Launch Services establishes the outer app's responsibility; its GUI child inherits it.
        subprocess.run(["/usr/bin/open", "-n", "-g", "-W", "--stdout", str(ready_file), "--stderr", str(stderr_file),
                        str(bundle), "--args", str(nested_launcher), str(helper), "--ensure-shared", "--runtime-key", key,
                        "--runtime-directory", str(runtime), "--startup-timeout-ms", "10000"],
                       check=True, capture_output=True, text=True, timeout=25)
        assert ready_file.read_text().strip(), stderr_file.read_text()
        ready = json.loads(ready_file.read_text())
        owner = ready["pid"]
        cleanup.callback(wait_released, runtime / (key + ".lock"), owner)
        first = Connection(runtime / (key + ".sock"), key)
        cleanup.callback(first.close)
        state = first.call("permissionStatus", {})
        assert state["parent"]["pid"] == 1, state["parent"]
        source = state["launchApplication"]
        assert source["name"] == helper.parents[2].name, source["name"]
        assert Path(source["path"]).resolve() == helper.parents[2].resolve(), source["path"]
        assert source["icon"].startswith("data:image/png;base64,")
        image = base64.b64decode(source["icon"].split(",", 1)[1], validate=True)
        assert image[:8] == b"\x89PNG\r\n\x1a\n"
        assert struct.unpack(">II", image[16:24]) == (64, 64)
        second = Connection(runtime / (key + ".sock"), key)
        cleanup.callback(second.close)
        assert second.call("permissionStatus", {})["launchApplication"] == source
        print("PASS: the helper owns its permission identity independently of nested GUI launchers and retained connections")


if __name__ == "__main__":
    main()
