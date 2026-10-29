"""Real development signing keeps one designated requirement across changed builds.

Creates a temporary development identity, adds its keychain to the user search list for the duration
of the check, and removes both afterwards. No system permission or password dialog is requested.
"""
import importlib.util
import json
from pathlib import Path
import plistlib
import subprocess
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

NATIVE = Path(__file__).resolve().parents[1]


def module(name):
    spec = importlib.util.spec_from_file_location(name, NATIVE / f"{name}.py")
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


def requirement(application):
    output = subprocess.run(["/usr/bin/codesign", "-d", "-r-", str(application)], check=True, capture_output=True, text=True)
    return next(line.split("=> ", 1)[1] for line in (output.stdout + output.stderr).splitlines() if "designated =>" in line)


def main():
    builder, signing = module("build_app"), module("dev_signing")
    before = signing.user_keychains()
    with tempfile.TemporaryDirectory(prefix="cua-dev-signing-e2e-") as temporary:
        root = Path(temporary)
        directory = root / "signing"
        try:
            local_signing = SimpleNamespace(setup=lambda: signing.setup(directory))
            with patch.object(builder, "load_dev_signing", return_value=local_signing):
                sha1, keychain = builder.signing_identity("dev", None, "local-identity")
                assert builder.signing_identity("dev", None, "local-identity") == (sha1, keychain)
            with patch.object(builder, "load_dev_signing", side_effect=AssertionError("ad-hoc accessed keychain")):
                assert builder.signing_identity("dev", None, "ad-hoc") == ("-", None)
            requirements = []
            for status in (0, 1):
                (root / "main.c").write_text(f"int main(void) {{ return {status}; }}\n")
                subprocess.run(["/usr/bin/xcrun", "clang", "-o", str(root / "helper"), str(root / "main.c")], check=True)
                executable = builder.publish(root / "helper", root / f"checkout-{status}", sha1, NATIVE / "Info.plist", "dev", keychain)
                application = executable.parents[2]
                assert application.name == "DSH Computer Use Dev.app", application
                subprocess.run(["/usr/bin/codesign", "--verify", "--strict", str(application)], check=True)
                info = plistlib.loads((application / "Contents/Info.plist").read_bytes())
                assert info["CFBundleIdentifier"] == "com.deepseek.harness.computer-use.dev", info
                requirements.append((application, requirement(application)))
            (first, first_requirement), (second, second_requirement) = requirements
            assert first != second, "changed builds must publish separate generations"
            assert first_requirement == second_requirement, requirements
            assert "certificate leaf" in first_requirement and "cdhash" not in first_requirement, first_requirement
            subprocess.run(["/usr/bin/codesign", "--verify", f"-R={first_requirement}", str(second)], check=True)
            selected = json.loads((root / "checkout-1/current.json").read_text())["bundle"]
            assert second.parent.name == selected
            print(f"PASS: changed development builds share {first_requirement}")
        finally:
            signing.remove(directory)
    assert signing.user_keychains() == before, "the user keychain search list was not restored"


if __name__ == "__main__":
    main()
