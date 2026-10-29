"""Build, sign and publish immutable Computer Use application generations."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import sys
import tempfile

DEV_BUNDLE_SUFFIX = ".dev"
DEV_DISPLAY_NAME = "DSH Computer Use Dev"


def bundle_digest(application):
    """Hash bundle membership and bytes; generated bundles contain only regular files."""
    if application.is_symlink() or not application.is_dir():
        raise ValueError(f"Helper application is not a real directory: {application}")
    digest = hashlib.sha256()
    for path in sorted(application.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"Helper application contains a symbolic link: {path}")
        if path.is_file():
            digest.update(path.relative_to(application).as_posix().encode() + b"\0")
            digest.update(hashlib.sha256(path.read_bytes()).digest())
            digest.update(bytes([bool(path.stat().st_mode & 0o111)]))
        elif not path.is_dir():
            raise ValueError(f"Helper application contains a non-regular entry: {path}")
    return digest.hexdigest()


def application_info(plist, variant):
    """Render Info.plist; development builds get their own bundle identifier and permission entry."""
    if variant == "release":
        return plist.read_bytes()
    info = plistlib.loads(plist.read_bytes())
    info["CFBundleIdentifier"] += DEV_BUNDLE_SUFFIX
    info["CFBundleName"] = info["CFBundleDisplayName"] = DEV_DISPLAY_NAME
    return plistlib.dumps(info)


def retained(output, key):
    """Return a published generation after checking that its bytes still match its name."""
    application = output / key / "DSH Computer Use.app"
    if application.exists() and bundle_digest(application) != key:
        raise ValueError(f"Retained helper application does not match its content digest: {application}")
    return application if application.exists() else None


def select(output, temporary, key):
    receipt = Path(temporary) / "current.json"
    receipt.write_text(json.dumps({"bundle": key}) + "\n")
    os.replace(receipt, output / "current.json")
    return output / key / "DSH Computer Use.app/Contents/MacOS/dsh-cua-native"


def publish(binary, output, identity, plist, variant="release", keychain=None):
    """Publish a complete signed bundle before atomically selecting its generation.

    Certificate signatures embed a signing time, so development builds record which generation
    each unsigned bundle and identity produced and select it again instead of re-signing.
    """
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".prepare-", dir=output) as temporary:
        staged = Path(temporary) / "DSH Computer Use.app"
        executable = staged / "Contents/MacOS/dsh-cua-native"
        executable.parent.mkdir(parents=True)
        shutil.copy2(binary, executable)
        (staged / "Contents/Info.plist").write_bytes(application_info(plist, variant))
        resources = staged / "Contents/Resources"
        resources.mkdir()
        for filename in ["DSHComputerUse.icns", "LICENSE.computer-use-icon", "LICENSE.cua-driver"]:
            shutil.copy2(plist.with_name(filename), resources / filename)
        index = None
        if variant == "dev":
            source = hashlib.sha256(f"{bundle_digest(staged)}\0{identity}".encode()).hexdigest()
            index = output / "sources" / source
            if index.is_file():
                key = index.read_text().strip()
                if retained(output, key) is not None:
                    return select(output, temporary, key)
        command = ["/usr/bin/codesign", "--force", "--sign", identity, "--options", "runtime",
                   "--timestamp=none" if identity == "-" or variant == "dev" else "--timestamp"]
        if keychain is not None:
            command += ["--keychain", str(keychain)]
        subprocess.run([*command, str(staged)], check=True)
        subprocess.run(["/usr/bin/codesign", "--verify", "--strict", str(staged)], check=True)
        key = bundle_digest(staged)
        generation = output / key
        application = generation / staged.name
        if retained(output, key) is None:
            generation.mkdir(exist_ok=True)
            try:
                staged.rename(application)
            except OSError:
                # Independent packagers can publish the same immutable generation.
                if not application.is_dir() or bundle_digest(application) != key:
                    raise
        if index is not None:
            index.parent.mkdir(exist_ok=True)
            entry = Path(temporary) / "source"
            entry.write_text(key + "\n")
            os.replace(entry, index)
        return select(output, temporary, key)


def load_dev_signing():
    """Load the sibling module whether this file runs as a script or is imported by path."""
    location = Path(__file__).resolve().with_name("dev_signing.py")
    spec = importlib.util.spec_from_file_location("dev_signing", location)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def signing_identity(variant, identity):
    """Resolve the codesign identity and keychain; development builds prefer the local identity."""
    if identity is not None or variant == "release":
        return identity or "-", None
    signing = load_dev_signing()
    local = signing.load()
    if local is None:
        print(f"Computer Use development build is ad-hoc signed; macOS asks for permissions again after each change. "
              f"Run {signing.SETUP_COMMAND} once to keep them across rebuilds and checkouts.", file=sys.stderr)
        return "-", None
    return local.sha1, local.keychain


def main():
    root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--arch", choices=["arm64", "x86_64"], default=platform.machine())
    parser.add_argument("--scratch-path", type=Path)
    parser.add_argument("--output-directory", type=Path)
    parser.add_argument("--variant", choices=["release", "dev"], default="release",
                        help="dev uses a separate bundle identifier and the local development signing identity")
    parser.add_argument("--identity", help="codesign identity; release defaults to '-', an ad-hoc build")
    args = parser.parse_args()
    architecture = "x64" if args.arch == "x86_64" else "arm64"
    scratch = args.scratch_path or root / ".build" / f"runtime-{architecture}"
    output = args.output_directory or root / "bin" / f"darwin-{architecture}"
    identity, keychain = signing_identity(args.variant, args.identity)
    subprocess.run(["/usr/bin/xcrun", "swift", "build", "--package-path", str(root),
                    "--scratch-path", str(scratch), "--configuration", "release",
                    "--product", "dsh-cua-native", "--arch", args.arch], check=True)
    executable = publish(scratch / "release/dsh-cua-native", output, identity, root / "Info.plist", args.variant, keychain)
    print(executable)


if __name__ == "__main__":
    main()
