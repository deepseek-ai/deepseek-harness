"""Real development signing keeps one designated requirement across changed builds.

Creates a temporary development identity, adds its keychain to the user search list for the duration
of the check, and removes both afterwards. No system permission or password dialog is requested.
"""
import importlib.util
import json
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile

NATIVE = Path(__file__).resolve().parents[4] / "packages/experimental/cua-macos/native"


def module(name):
    spec = importlib.util.spec_from_file_location(name, NATIVE / "build_app.py" if name == "build_app" else Path(__file__).with_name("signing_identity.py"))
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
        directory = root / "keys/dev"
        try:
            command = [sys.executable, str(Path(__file__).with_name("signing_identity.py")), "setup", "--directory", str(directory)]
            configuration = json.loads(subprocess.run(command, check=True, capture_output=True, text=True).stdout)
            identity = signing.setup(directory)
            assert configuration == {"identity": identity.sha1, "keychain": str(identity.keychain.resolve())}
            assert signing.setup(directory) == identity
            sha1, keychain = identity.sha1, identity.keychain
            assert (directory / "identity.json").stat().st_mode & 0o777 == 0o600
            signing.security("lock-keychain", str(keychain))
            assert signing.setup(directory) == identity, "setup must unlock an existing developer keychain"
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
            for index, (certificate, selected_keychain) in enumerate(((sha1, keychain), (signing.COMMON_NAME, keychain))):
                custom = builder.publish(root / "helper", root / f"custom-{index}", certificate, NATIVE / "Info.plist", "dev", selected_keychain)
                assert requirement(custom.parents[2]) == first_requirement
            print(f"PASS: developer setup reuses and unlocks its identity; configured signatures across changed builds share {first_requirement}")
        finally:
            try:
                signing.remove(directory)
            finally:
                # This fixture owns the temporary directory even if ownership validation fails.
                signing.clear_identity(directory)
    assert signing.user_keychains() == before, "the user keychain search list was not restored"


if __name__ == "__main__":
    main()
