#!/usr/bin/env python3
"""Reject runtime executables that require newer macOS than their wheel tag."""

from __future__ import annotations

import argparse
import re
import runpy
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RELEASE = runpy.run_path(str(ROOT / "scripts" / "build-python-release.py"))
MACOS_PLATFORMS = {
    name: details[0]
    for name, details in RELEASE["PLATFORMS"].items()
    if name.startswith("macos-")
}


def parse_version(value: str) -> tuple[int, ...]:
    """Parse a dot-separated numeric deployment version."""
    if re.fullmatch(r"\d+(?:\.\d+)*", value) is None:
        raise ValueError(f"invalid macOS deployment version: {value!r}")
    return tuple(int(part) for part in value.split("."))


def claimed_version(platform_tag: str) -> tuple[int, ...]:
    """Return the minimum macOS version encoded by a wheel platform tag."""
    match = re.fullmatch(r"macosx_(\d+)_(\d+)_(?:arm64|x86_64)", platform_tag)
    if match is None:
        raise ValueError(f"unsupported macOS wheel platform tag: {platform_tag!r}")
    return int(match.group(1)), int(match.group(2))


def parse_otool_deployment_target(output: str) -> tuple[int, ...]:
    """Return the newest deployment target from one or more Mach-O slices."""
    versions: list[tuple[int, ...]] = []
    command: str | None = None
    for line in output.splitlines():
        stripped = line.strip()
        if re.fullmatch(r"Load command \d+", stripped):
            command = None
        elif stripped == "cmd LC_BUILD_VERSION":
            command = "build"
        elif stripped == "cmd LC_VERSION_MIN_MACOSX":
            command = "minimum"
        elif command == "build" and (match := re.fullmatch(r"minos\s+(\d+(?:\.\d+)*)", stripped)):
            versions.append(parse_version(match.group(1)))
        elif command == "minimum" and (match := re.fullmatch(r"version\s+(\d+(?:\.\d+)*)", stripped)):
            versions.append(parse_version(match.group(1)))
    if not versions:
        raise ValueError("otool output contains no macOS deployment target load command")
    return max(versions)


def deployment_target(executable: Path) -> tuple[int, ...]:
    """Read one Mach-O executable's deployment target with ``otool``."""
    if not executable.is_file():
        raise FileNotFoundError(f"runtime executable does not exist: {executable}")
    result = subprocess.run(
        ["otool", "-l", str(executable)],
        check=True,
        capture_output=True,
        text=True,
    )
    try:
        return parse_otool_deployment_target(result.stdout)
    except ValueError as error:
        raise ValueError(f"{executable}: {error}") from error


def ensure_compatible(
    executable: Path, actual: tuple[int, ...], platform_tag: str
) -> None:
    """Reject an executable whose deployment target exceeds its wheel claim."""
    claimed = claimed_version(platform_tag)
    width = max(len(actual), len(claimed))
    padded_actual = actual + (0,) * (width - len(actual))
    padded_claimed = claimed + (0,) * (width - len(claimed))
    if padded_actual > padded_claimed:
        rendered = ".".join(str(part) for part in actual)
        raise RuntimeError(
            f"{executable} requires macOS {rendered} but the wheel claims {platform_tag}"
        )


def validate_deployment_targets(
    executables: list[Path], platform_tag: str
) -> list[tuple[Path, tuple[int, ...]]]:
    """Validate every executable and return its measured deployment target."""
    measured = [(executable, deployment_target(executable)) for executable in executables]
    for executable, actual in measured:
        ensure_compatible(executable, actual, platform_tag)
    return measured


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", choices=tuple(MACOS_PLATFORMS), required=True)
    parser.add_argument("executables", type=Path, nargs="+")
    args = parser.parse_args()
    platform_tag = MACOS_PLATFORMS[args.platform]
    for executable, version in validate_deployment_targets(args.executables, platform_tag):
        rendered = ".".join(str(part) for part in version)
        print(f"{executable}: macOS {rendered} <= {platform_tag}")


if __name__ == "__main__":
    main()
