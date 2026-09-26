from __future__ import annotations

import json
import os
import platform
import runpy
import stat
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


def _load_platforms() -> dict[str, tuple[str, str]]:
    """Load and validate the platform manifest inside an isolated wheel build."""
    path = Path(__file__).with_name("platforms.json")
    try:
        payload = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"could not read runtime platform manifest from {path}") from error
    if not isinstance(payload, dict) or not payload:
        raise RuntimeError(f"{path} must contain a non-empty platform object")
    platforms: dict[str, tuple[str, str]] = {}
    for name, raw in payload.items():
        if (
            not isinstance(name, str)
            or not isinstance(raw, dict)
            or set(raw) != {"tag", "executable"}
            or not isinstance(raw["tag"], str)
            or not isinstance(raw["executable"], str)
        ):
            raise RuntimeError(f"{path} platform entries must contain string tag and executable fields")
        platforms[name] = (raw["tag"], raw["executable"])
    return platforms


_PLATFORMS = _load_platforms()


def _host_platform_tag() -> str:
    machine = platform.machine().lower()
    arch = "arm64" if machine in {"arm64", "aarch64"} else "x64" if machine in {"x86_64", "amd64"} else machine
    system = platform.system().lower()
    key = (
        f"macos-{arch}"
        if system == "darwin"
        else f"linux-{arch}"
        if system == "linux"
        else f"win-{arch}"
        if system == "windows"
        else system
    )
    try:
        return _PLATFORMS[key][0]
    except KeyError as exc:
        raise RuntimeError(f"unsupported deepseek-harness-runtime-bin build platform: {key}") from exc


class RuntimeBuildHook(BuildHookInterface):
    """Assign the native wheel tag and reject incomplete or mixed-platform payloads."""

    def initialize(self, version: str, build_data: dict[str, object]) -> None:
        if version == "editable":
            return
        if self.target_name == "sdist":
            raise RuntimeError(
                "deepseek-harness-runtime-bin is wheel-only; build and publish platform wheels only."
            )

        platform_tag = os.environ.get("DSH_RUNTIME_PLATFORM_TAG") or _host_platform_tag()
        matches = [value for value in _PLATFORMS.values() if value[0] == platform_tag]
        if len(matches) != 1:
            supported = ", ".join(value[0] for value in _PLATFORMS.values())
            raise RuntimeError(
                f"unsupported DSH_RUNTIME_PLATFORM_TAG {platform_tag!r}; expected one of {supported}"
            )
        expected_executable = matches[0][1]
        target = next(name for name, value in _PLATFORMS.items() if value[0] == platform_tag)
        runtime_dir = Path(self.root) / "src" / "deepseek_harness_runtime" / "runtime"
        runtime_files = sorted(
            (path for path in runtime_dir.iterdir() if path.name != "node") if runtime_dir.is_dir() else []
        )
        expected_files = (
            [expected_executable, f"{expected_executable.removesuffix('.exe')}-rg.exe"]
            if expected_executable.endswith(".exe")
            else [expected_executable, f"{expected_executable}-rg"]
        )
        if "-macos-" in expected_executable:
            expected_files.append(f"{expected_executable}-spawn-helper")
        office = runtime_dir / f"{expected_executable.removesuffix('.exe')}-office"
        expected_files.append(office.name)
        resources = runtime_dir / target
        expected_files.append(resources.name)
        expected_files.sort()
        found_files = [path.name for path in runtime_files]
        if found_files != expected_files:
            raise RuntimeError(
                f"runtime wheel {platform_tag} payload must be {expected_files}; found {found_files}"
            )
        for executable in runtime_files:
            if executable == resources:
                validate = runpy.run_path(str(runtime_dir.parent / "_resources.py"))["validate_resources"]
                validate(resources, target)
                continue
            if executable == office:
                adapter = office / "node_modules/@deepseek-ai/libreoffice-kit/package.json"
                if not adapter.is_file():
                    raise RuntimeError(f"runtime Office dependency is missing: {adapter}")
                native = target.replace("win-", "win32-").replace("macos-", "darwin-")
                declared = json.loads(adapter.read_text(encoding="utf-8")).get("optionalDependencies", {})
                engine = native if f"@deepseek-ai/libreoffice-kit-{native}" in declared else "wasm"
                required = office / "node_modules" / f"@deepseek-ai/libreoffice-kit-{engine}/prebuilds.json"
                if not required.is_file():
                    raise RuntimeError(f"runtime Office dependency is missing: {required}")
                continue
            if not executable.is_file():
                raise RuntimeError(f"runtime executable is not a file: {executable}")
            if platform_tag != "win_amd64" and executable.stat().st_mode & stat.S_IXUSR == 0:
                raise RuntimeError(f"runtime executable is not executable: {executable}")
        build_data["pure_python"] = False
        build_data["infer_tag"] = False
        build_data["tag"] = f"py3-none-{platform_tag}"
