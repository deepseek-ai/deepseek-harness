#!/usr/bin/env python3
"""Stage and build one Python wheel at the repository version."""

from __future__ import annotations

import argparse
import email
import json
import os
import re
import runpy
import shutil
import stat
import subprocess
import tempfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SDK_DISTRIBUTION = "deepseek-harness-sdk"
RUNTIME_DISTRIBUTION = "deepseek-harness-runtime-bin"
PLATFORM_MANIFEST = ROOT / "python" / "sdk-runtime" / "platforms.json"


def load_platforms(path: Path = PLATFORM_MANIFEST) -> dict[str, tuple[str, str]]:
    """Load the release platform tag and executable pairs from the build manifest."""
    try:
        payload = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"could not read runtime platform manifest from {path}") from error
    if not isinstance(payload, dict) or not payload:
        raise ValueError(f"{path} must contain a non-empty platform object")
    platforms: dict[str, tuple[str, str]] = {}
    for name, raw in payload.items():
        if (
            not isinstance(name, str)
            or not isinstance(raw, dict)
            or set(raw) != {"tag", "executable"}
            or not isinstance(raw["tag"], str)
            or not isinstance(raw["executable"], str)
        ):
            raise ValueError(f"{path} platform entries must contain string tag and executable fields")
        platforms[name] = (raw["tag"], raw["executable"])
    return platforms


PLATFORMS = load_platforms()


def runtime_filenames(executable_name: str) -> tuple[str, ...]:
    """Return the exact platform payload names for one runtime executable."""
    if executable_name.endswith(".exe"):
        return (executable_name, f"{executable_name.removesuffix('.exe')}-rg.exe")
    names = (executable_name, f"{executable_name}-rg")
    return (*names, f"{executable_name}-spawn-helper") if "-macos-" in executable_name else names


def office_sidecar_name(executable_name: str) -> str:
    """Return the complete Office dependency directory for one executable."""
    return f"{executable_name.removesuffix('.exe')}-office"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", choices=("sdk", "runtime"), required=True)
    parser.add_argument(
        "--tag",
        help="optional python-v<repository-version> release tag; it must match package.json",
    )
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--platform", choices=tuple(PLATFORMS))
    parser.add_argument("--runtime-exe", type=Path)
    args = parser.parse_args()
    version = repository_version()
    validate_release_tag(args.tag, version)
    # Wheels carry the PEP 440 spelling; the tag keeps the repository spelling.
    wheel_version = pep440_version(version)
    if args.package == "runtime" and (args.platform is None or args.runtime_exe is None):
        parser.error("runtime builds require --platform and --runtime-exe")
    if args.package == "sdk" and (args.platform is not None or args.runtime_exe is not None):
        parser.error("SDK builds do not accept --platform or --runtime-exe")

    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="dsh-python-release-") as temporary:
        staging = Path(temporary) / args.package
        if args.package == "sdk":
            stage_sdk(staging, wheel_version)
            environment = None
            expected = output_dir / f"deepseek_harness_sdk-{wheel_version}-py3-none-any.whl"
        else:
            platform_tag, executable_name = PLATFORMS[args.platform]
            stage_runtime(staging, wheel_version, args.runtime_exe.resolve(), executable_name)
            environment = {"DSH_RUNTIME_PLATFORM_TAG": platform_tag}
            expected = output_dir / f"deepseek_harness_runtime_bin-{wheel_version}-py3-none-{platform_tag}.whl"
        command = ["uv", "build", "--wheel", "--out-dir", str(output_dir), str(staging)]
        subprocess.run(command, cwd=ROOT, env=None if environment is None else {**os.environ, **environment}, check=True)
    if not expected.is_file():
        raise RuntimeError(f"build did not produce expected wheel: {expected}")
    verify_wheel(expected, args.package, wheel_version, None if args.platform is None else PLATFORMS[args.platform])
    print(expected)


def repository_version(root: Path = ROOT) -> str:
    package_json = root / "package.json"
    try:
        payload = json.loads(package_json.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"could not read repository version from {package_json}") from error
    version = payload.get("version") if isinstance(payload, dict) else None
    if not isinstance(version, str) or re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?", version) is None:
        raise ValueError(
            f"{package_json} version must be X.Y.Z with an optional prerelease segment, got {version!r}"
        )
    return version


def pep440_version(version: str) -> str:
    """The Python spelling of a repository version.

    A release candidate is `0.0.1-rc.1` in the repository and `0.0.1rc1` under
    PEP 440. Build backends normalize to the latter, so the wheel filename and
    metadata carry it: comparing them against the repository spelling would
    reject every prerelease build.
    """
    stable, separator, prerelease = version.partition("-")
    if not separator:
        return stable
    match = re.fullmatch(r"(a|b|c|rc|alpha|beta|pre|preview)\.?(\d+)", prerelease)
    if match is None:
        raise ValueError(
            f"prerelease segment {prerelease!r} has no PEP 440 spelling; use rc.N, alpha.N, or beta.N"
        )
    identifier = {"alpha": "a", "beta": "b", "c": "rc", "pre": "rc", "preview": "rc"}.get(
        match.group(1), match.group(1)
    )
    return f"{stable}{identifier}{match.group(2)}"


def validate_release_tag(tag: str | None, version: str) -> None:
    if tag is None:
        return
    expected = f"python-v{version}"
    if tag != expected:
        raise ValueError(
            f"release tag must match repository version: expected {expected!r}, got {tag!r}"
        )


def copy_package(source: Path, destination: Path) -> None:
    generated_parent = source / "src" / "deepseek_harness_runtime"
    ignore_files = shutil.ignore_patterns(
        ".venv", ".pytest_cache", "__pycache__", "*.pyc", "dist", "node_modules",
    )

    def ignore(directory: str, names: list[str]) -> set[str]:
        ignored = ignore_files(directory, names)
        if Path(directory) == generated_parent:
            ignored.add("runtime")
        return ignored

    shutil.copytree(
        source,
        destination,
        ignore=ignore,
    )


def rewrite_version(pyproject: Path, version: str) -> None:
    text, count = re.subn(
        r'^version = "[^"]+"$',
        f'version = "{version}"',
        pyproject.read_text(),
        count=1,
        flags=re.MULTILINE,
    )
    if count != 1:
        raise RuntimeError(f"could not rewrite version in {pyproject}")
    pyproject.write_text(text)


def stage_license_files(destination: Path, *, include_notices: bool) -> None:
    """Copy legal files and declare them as wheel license payloads."""
    shutil.copy2(ROOT / "LICENSE", destination / "LICENSE")
    license_files = '["LICENSE"]'
    if include_notices:
        shutil.copy2(ROOT / "THIRD_PARTY_NOTICES.md", destination / "THIRD_PARTY_NOTICES.md")
        license_files = '["LICENSE", "THIRD_PARTY_NOTICES.md"]'
    pyproject = destination / "pyproject.toml"
    text, count = re.subn(
        r'^(license = "[^"]+")$',
        rf"\1\nlicense-files = {license_files}",
        pyproject.read_text(),
        count=1,
        flags=re.MULTILINE,
    )
    if count != 1:
        raise RuntimeError(f"could not declare license files in {pyproject}")
    pyproject.write_text(text)


def stage_sdk(destination: Path, version: str) -> None:
    copy_package(ROOT / "python" / "sdk", destination)
    stage_license_files(destination, include_notices=False)
    pyproject = destination / "pyproject.toml"
    rewrite_version(pyproject, version)
    text, count = re.subn(
        r'"deepseek-harness-runtime-bin==[^"]+"',
        f'"deepseek-harness-runtime-bin=={version}"',
        pyproject.read_text(),
        count=1,
    )
    if count != 1:
        raise RuntimeError("SDK must contain exactly one runtime dependency pin")
    pyproject.write_text(text)


def stage_runtime(destination: Path, version: str, executable: Path, executable_name: str) -> None:
    if executable.name != executable_name:
        raise ValueError(
            f"runtime executable must be named {executable_name}, got {executable.name}"
        )
    copy_package(ROOT / "python" / "sdk-runtime", destination)
    stage_license_files(destination, include_notices=True)
    rewrite_version(destination / "pyproject.toml", version)
    runtime_dir = destination / "src" / "deepseek_harness_runtime" / "runtime"
    runtime_dir.mkdir(parents=True, exist_ok=True)
    source_directory = executable.parent
    for filename in runtime_filenames(executable_name):
        shutil.copy2(source_directory / filename, runtime_dir / filename)
    office = office_sidecar_name(executable_name)
    shutil.copytree(source_directory / office, runtime_dir / office)
    resources = executable_name.removeprefix("deepseek-harness-sdk-runtime-").removesuffix(".exe")
    shutil.copytree(source_directory / resources, runtime_dir / resources)


def verify_office_payload(archive: zipfile.ZipFile, office_modules: str, platform_tag: str) -> None:
    """Check packaged engine assets and native helper executable permissions."""
    names = set(archive.namelist())
    adapter = f"{office_modules}/@deepseek-ai/libreoffice-kit/package.json"
    if adapter not in names:
        raise RuntimeError("Office dependency is missing: libreoffice-kit")
    engines = f"{office_modules}/@deepseek-ai"
    target = next(name for name, value in PLATFORMS.items() if value[0] == platform_tag)
    native_target = target.replace("win-", "win32-").replace("macos-", "darwin-")
    declared = json.loads(archive.read(adapter)).get("optionalDependencies", {})
    selected = native_target if f"@deepseek-ai/libreoffice-kit-{native_target}" in declared else "wasm"
    for required in (f"libreoffice-kit-{selected}/prebuilds.json",):
        if f"{engines}/{required}" not in names:
            raise RuntimeError(f"Office dependency is missing: {required}")
    manifests = (
        name for name in names
        if name.startswith(f"{engines}/libreoffice-kit-")
        and name.endswith("/prebuilds.json")
        and name.count("/") == engines.count("/") + 2
    )
    for manifest_path in manifests:
        if manifest_path != f"{engines}/libreoffice-kit-{selected}/prebuilds.json":
            raise RuntimeError(f"Unexpected Office engine for {platform_tag}: {manifest_path}")
        manifest = json.loads(archive.read(manifest_path))
        engine = manifest["engine"]
        native = engine["kind"] == "native"
        fields = ("executable",) if native else ("loader", "wasm", "data", "metadata")
        for field in fields:
            asset = f"{manifest_path.rsplit('/', 1)[0]}/{engine[field]}"
            if asset not in names:
                raise RuntimeError(f"Office engine asset is missing: {asset}")
            mode = archive.getinfo(asset).external_attr >> 16
            if native and platform_tag != "win_amd64" and mode & stat.S_IXUSR == 0:
                raise RuntimeError(f"Office helper lost its executable bit: {asset}")


def verify_wheel(
    wheel: Path,
    package: str,
    version: str,
    platform: tuple[str, str] | None,
) -> None:
    expected_tag = "py3-none-any" if platform is None else f"py3-none-{platform[0]}"
    expected_distribution = SDK_DISTRIBUTION if package == "sdk" else RUNTIME_DISTRIBUTION
    dist_info = f"{expected_distribution.replace('-', '_')}-{version}.dist-info"
    with zipfile.ZipFile(wheel) as archive:
        wheel_metadata_path = f"{dist_info}/WHEEL"
        metadata_path = f"{dist_info}/METADATA"
        wheel_metadata = email.message_from_bytes(archive.read(wheel_metadata_path))
        metadata = email.message_from_bytes(archive.read(metadata_path))
        if wheel_metadata.get_all("Tag") != [expected_tag]:
            raise RuntimeError(f"{wheel} has wrong WHEEL tags: {wheel_metadata.get_all('Tag')}")
        if metadata.get("Version") != version:
            raise RuntimeError(f"{wheel} has version {metadata.get('Version')}, expected {version}")
        if metadata.get("Name") != expected_distribution:
            raise RuntimeError(
                f"{wheel} has distribution name {metadata.get('Name')}, expected {expected_distribution}"
            )
        if metadata.get("License-Expression") != "MIT":
            raise RuntimeError(
                f"{wheel} has license expression {metadata.get('License-Expression')}, expected MIT"
            )
        expected_license_files = ["LICENSE"] if package == "sdk" else ["LICENSE", "THIRD_PARTY_NOTICES.md"]
        license_files = [Path(name).name for name in metadata.get_all("License-File") or []]
        if license_files != expected_license_files:
            raise RuntimeError(
                f"{wheel} has license files {license_files}, expected {expected_license_files}"
            )
        runtime_payload = [
            name for name in archive.namelist() if name.startswith("deepseek_harness_runtime/runtime/")
        ]
        if package == "runtime":
            assert platform is not None
            office = office_sidecar_name(platform[1])
            resources = platform[1].removeprefix("deepseek-harness-sdk-runtime-").removesuffix(".exe")
            expected_files = sorted((*runtime_filenames(platform[1]), office, resources))
            found_files = sorted({name.split("/runtime/", 1)[1].split("/", 1)[0] for name in runtime_payload})
            if found_files != expected_files:
                raise RuntimeError(f"{wheel} runtime payload must be {expected_files}, found {found_files}")
            office_modules = f"deepseek_harness_runtime/runtime/{office}/node_modules"
            verify_office_payload(archive, office_modules, platform[0])
            validate = runpy.run_path(str(ROOT / "python/sdk-runtime/src/deepseek_harness_runtime/_resources.py"))["validate_resources"]
            target = next(name for name, value in PLATFORMS.items() if value == platform)
            validate(zipfile.Path(archive, f"deepseek_harness_runtime/runtime/{resources}/"), target)
            for runtime_file in runtime_payload:
                if "/" in runtime_file.split("/runtime/", 1)[1]:
                    continue
                mode = archive.getinfo(runtime_file).external_attr >> 16
                if platform[0] != "win_amd64" and mode & stat.S_IXUSR == 0:
                    raise RuntimeError(f"{wheel} runtime executable lost its executable bit: {runtime_file}")
        elif runtime_payload:
            raise RuntimeError(f"SDK wheel unexpectedly contains runtime files: {runtime_payload}")
        if package == "sdk":
            requirements = metadata.get_all("Requires-Dist") or []
            expected_requirement = f"{RUNTIME_DISTRIBUTION}=={version}"
            if expected_requirement not in requirements:
                raise RuntimeError(f"{wheel} does not pin {expected_requirement}; found {requirements}")


if __name__ == "__main__":
    main()
