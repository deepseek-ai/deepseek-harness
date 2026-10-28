"""Build, sign and publish immutable Computer Use application generations."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile


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


def publish(binary, output, identity, plist):
    """Publish a complete signed bundle before atomically selecting its generation."""
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".prepare-", dir=output) as temporary:
        staged = Path(temporary) / "DSH Computer Use.app"
        executable = staged / "Contents/MacOS/dsh-cua-native"
        executable.parent.mkdir(parents=True)
        shutil.copy2(binary, executable)
        shutil.copy2(plist, staged / "Contents/Info.plist")
        resources = staged / "Contents/Resources"
        resources.mkdir()
        for filename in ["DSHComputerUse.icns", "LICENSE.computer-use-icon", "LICENSE.cua-driver"]:
            shutil.copy2(plist.with_name(filename), resources / filename)
        subprocess.run(["/usr/bin/codesign", "--force", "--sign", identity, "--options", "runtime",
                        "--timestamp=none" if identity == "-" else "--timestamp", str(staged)], check=True)
        subprocess.run(["/usr/bin/codesign", "--verify", "--strict", str(staged)], check=True)
        key = bundle_digest(staged)
        generation = output / key
        application = generation / staged.name
        if application.exists():
            if bundle_digest(application) != key:
                raise ValueError(f"Retained helper application does not match its content digest: {application}")
        else:
            generation.mkdir(exist_ok=True)
            try:
                staged.rename(application)
            except OSError:
                # Independent packagers can publish the same immutable generation.
                if not application.is_dir() or bundle_digest(application) != key:
                    raise
        receipt = Path(temporary) / "current.json"
        receipt.write_text(json.dumps({"bundle": key}) + "\n")
        os.replace(receipt, output / "current.json")
        return application / "Contents/MacOS/dsh-cua-native"


def main():
    root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--arch", choices=["arm64", "x86_64"], default=platform.machine())
    parser.add_argument("--scratch-path", type=Path)
    parser.add_argument("--output-directory", type=Path)
    parser.add_argument("--identity", default="-", help="codesign identity; '-' produces a local ad-hoc build")
    args = parser.parse_args()
    architecture = "x64" if args.arch == "x86_64" else "arm64"
    scratch = args.scratch_path or root / ".build" / f"runtime-{architecture}"
    output = args.output_directory or root / "bin" / f"darwin-{architecture}"
    subprocess.run(["/usr/bin/xcrun", "swift", "build", "--package-path", str(root),
                    "--scratch-path", str(scratch), "--configuration", "release",
                    "--product", "dsh-cua-native", "--arch", args.arch], check=True)
    executable = publish(scratch / "release/dsh-cua-native", output, args.identity, root / "Info.plist")
    print(executable)


if __name__ == "__main__":
    main()
