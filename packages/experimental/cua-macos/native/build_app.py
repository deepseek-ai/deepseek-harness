"""Build, sign and publish immutable Computer Use application generations."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import shutil
import subprocess
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


def retained(output, key, name):
    """Return a published generation after checking that its bytes still match its name."""
    application = output / key / name
    if not application.exists():
        return None
    if bundle_digest(application) != key:
        raise ValueError(f"Retained helper application does not match its content digest: {application}")
    return application


def select(output, temporary, key, name):
    receipt = Path(temporary) / "current.json"
    receipt.write_text(json.dumps({"bundle": key}) + "\n")
    os.replace(receipt, output / "current.json")
    return output / key / name / "Contents/MacOS/dsh-cua-native"


def publish(binary, output, identity, plist, variant="release", keychain=None):
    """Publish a complete signed bundle before atomically selecting its generation.

    Certificate signatures embed a signing time, so development builds record which generation
    each unsigned bundle and identity produced and select it again instead of re-signing.
    """
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".prepare-", dir=output) as temporary:
        name = f"{DEV_DISPLAY_NAME}.app" if variant == "dev" else "DSH Computer Use.app"
        staged = Path(temporary) / name
        executable = staged / "Contents/MacOS/dsh-cua-native"
        executable.parent.mkdir(parents=True)
        shutil.copy2(binary, executable)
        (staged / "Contents/Info.plist").write_bytes(application_info(plist, variant))
        shutil.copystat(plist, staged / "Contents/Info.plist")
        resources = staged / "Contents/Resources"
        resources.mkdir()
        for filename in ["DSHComputerUse.icns", "LICENSE.computer-use-icon", "LICENSE.cua-driver"]:
            shutil.copy2(plist.with_name(filename), resources / filename)
        index = None
        # Names can resolve to a renewed certificate; only fingerprints identify a stable signing key.
        if variant == "dev" and (identity == "-" or re.fullmatch(r"[0-9a-fA-F]{40}", identity)):
            source = hashlib.sha256(f"{bundle_digest(staged)}\0{identity}".encode()).hexdigest()
            index = output / "sources" / source
            if index.is_file():
                key = index.read_text().strip()
                if retained(output, key, name) is not None:
                    return select(output, temporary, key, name)
        command = ["/usr/bin/codesign", "--force", "--sign", identity, "--options", "runtime",
                   "--timestamp=none" if identity == "-" or variant == "dev" else "--timestamp"]
        if keychain is not None:
            command += ["--keychain", str(keychain)]
        subprocess.run([*command, str(staged)], check=True)
        subprocess.run(["/usr/bin/codesign", "--verify", "--strict", str(staged)], check=True)
        key = bundle_digest(staged)
        generation = output / key
        application = generation / staged.name
        if retained(output, key, name) is None:
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
        return select(output, temporary, key, name)


def main():
    root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--arch", choices=["arm64", "x86_64"], default=platform.machine())
    parser.add_argument("--scratch-path", type=Path)
    parser.add_argument("--output-directory", type=Path)
    parser.add_argument("--variant", choices=["release", "dev"], default="release",
                        help="dev uses a separate bundle identifier")
    parser.add_argument("--identity", default="-", help="existing codesign certificate name or SHA-1 fingerprint; defaults to ad-hoc (-)")
    parser.add_argument("--keychain", type=Path, help="absolute keychain path for --identity; the user owns unlocking it")
    args = parser.parse_args()
    if not args.identity.strip():
        parser.error("--identity must name an existing certificate")
    if args.keychain is not None and (args.identity == "-" or not args.keychain.is_absolute()):
        parser.error("--keychain requires --identity and an absolute path")
    architecture = "x64" if args.arch == "x86_64" else "arm64"
    scratch = args.scratch_path or root / ".build" / f"runtime-{architecture}"
    output = args.output_directory or root / "bin" / f"darwin-{architecture}"
    subprocess.run(["/usr/bin/xcrun", "swift", "build", "--package-path", str(root),
                    "--scratch-path", str(scratch), "--configuration", "release",
                    "--product", "dsh-cua-native", "--arch", args.arch], check=True)
    executable = publish(scratch / "release/dsh-cua-native", output, args.identity, root / "Info.plist", args.variant, args.keychain)
    print(executable)


if __name__ == "__main__":
    main()
