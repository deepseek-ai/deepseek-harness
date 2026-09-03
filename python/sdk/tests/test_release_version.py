"""Tests for repository-owned Python release versions."""

from __future__ import annotations

import json
import runpy
from pathlib import Path
from types import SimpleNamespace

import pytest


ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "scripts" / "build-python-release.py"
build_python_release = SimpleNamespace(**runpy.run_path(str(SCRIPT)))


def test_repository_version_matches_root_package_json() -> None:
    expected = json.loads((ROOT / "package.json").read_text())["version"]

    assert build_python_release.repository_version() == expected


def test_release_tag_is_optional_for_non_release_builds() -> None:
    build_python_release.validate_release_tag(None, "1.2.3")


def test_release_tag_must_match_repository_version() -> None:
    build_python_release.validate_release_tag("python-v1.2.3", "1.2.3")

    with pytest.raises(ValueError, match="expected 'python-v1.2.3'"):
        build_python_release.validate_release_tag("python-v1.2.4", "1.2.3")


def test_repository_version_accepts_a_prerelease(tmp_path: Path) -> None:
    (tmp_path / "package.json").write_text('{"version":"1.2.3-rc.1"}\n')

    assert build_python_release.repository_version(tmp_path) == "1.2.3-rc.1"


def test_repository_version_rejects_malformed_versions(tmp_path: Path) -> None:
    (tmp_path / "package.json").write_text('{"version":"v1.2"}\n')

    with pytest.raises(ValueError, match="must be X.Y.Z"):
        build_python_release.repository_version(tmp_path)


def test_pep440_version_spells_a_prerelease_the_python_way() -> None:
    # Build backends normalize to this spelling, so the wheel filename and
    # metadata checks compare against it rather than the repository version.
    assert build_python_release.pep440_version("1.2.3") == "1.2.3"
    assert build_python_release.pep440_version("1.2.3-rc.1") == "1.2.3rc1"
    assert build_python_release.pep440_version("1.2.3-alpha.2") == "1.2.3a2"
    assert build_python_release.pep440_version("1.2.3-beta.10") == "1.2.3b10"

    with pytest.raises(ValueError, match="no PEP 440 spelling"):
        build_python_release.pep440_version("1.2.3-nightly")


def test_macos_wheel_tag_does_not_claim_unsupported_node_platforms() -> None:
    assert build_python_release.PLATFORMS["macos-arm64"][0] == "macosx_14_0_arm64"
    assert build_python_release.PLATFORMS["macos-arm64"][1] == "deepseek-harness-sdk-runtime-macos-arm64"
    assert build_python_release.PLATFORMS["macos-x64"][0] == "macosx_14_0_x86_64"
    assert build_python_release.PLATFORMS["macos-x64"][1] == "deepseek-harness-sdk-runtime-macos-x64"


def test_windows_wheel_tag_and_payload_are_x64_only() -> None:
    assert build_python_release.PLATFORMS["win-x64"] == (
        "win_amd64",
        "deepseek-harness-sdk-runtime-win-x64.exe",
    )
    assert not any(name.startswith("win-") and name != "win-x64" for name in build_python_release.PLATFORMS)


def test_platform_manifest_rejects_incomplete_entries(tmp_path: Path) -> None:
    manifest = tmp_path / "platforms.json"
    manifest.write_text('{"macos-arm64":{"tag":"macosx_14_0_arm64"}}\n')

    with pytest.raises(ValueError, match="tag and executable fields"):
        build_python_release.load_platforms(manifest)


def test_stage_sdk_keeps_distribution_module_and_runtime_pin_distinct(tmp_path: Path) -> None:
    destination = tmp_path / "staging"

    build_python_release.stage_sdk(destination, "1.2.3")

    pyproject = (destination / "pyproject.toml").read_text()
    assert 'name = "deepseek-harness-sdk"' in pyproject
    assert 'version = "1.2.3"' in pyproject
    assert 'license = "MIT"' in pyproject
    assert '"deepseek-harness-runtime-bin==1.2.3"' in pyproject
    assert 'license-files = ["LICENSE"]' in pyproject
    assert (destination / "LICENSE").read_bytes() == (ROOT / "LICENSE").read_bytes()
    assert (destination / "src" / "deepseek_harness" / "__init__.py").is_file()


@pytest.mark.parametrize(
    ("target", "with_helper"),
    [("linux-x64", False), ("macos-arm64", True), ("macos-x64", True), ("win-x64.exe", False)],
)
def test_stage_runtime_copies_platform_payload(
    tmp_path: Path, target: str, with_helper: bool
) -> None:
    executable = tmp_path / f"deepseek-harness-sdk-runtime-{target}"
    executable.write_bytes(b"runtime")
    executable.chmod(0o755)
    expected = {executable.name: b"runtime"}
    ripgrep = (
        executable.with_name(f"{executable.stem}-rg.exe")
        if executable.suffix == ".exe"
        else Path(f"{executable}-rg")
    )
    ripgrep.write_bytes(b"ripgrep")
    ripgrep.chmod(0o755)
    expected[ripgrep.name] = b"ripgrep"
    if with_helper:
        spawn_helper = Path(f"{executable}-spawn-helper")
        spawn_helper.write_bytes(b"helper")
        spawn_helper.chmod(0o755)
        expected[spawn_helper.name] = b"helper"
    destination = tmp_path / "staging"

    build_python_release.stage_runtime(destination, "1.2.3", executable, executable.name)

    runtime_dir = destination / "src" / "deepseek_harness_runtime" / "runtime"
    assert {
        path.name: path.read_bytes()
        for path in runtime_dir.glob("deepseek-harness-sdk-runtime-*")
    } == expected
    pyproject = (destination / "pyproject.toml").read_text()
    assert 'license = "MIT"' in pyproject
    assert 'license-files = ["LICENSE", "THIRD_PARTY_NOTICES.md"]' in pyproject
    assert 'dsh = "deepseek_harness_runtime:main"' in pyproject
    assert (destination / "platforms.json").read_bytes() == (
        ROOT / "python" / "sdk-runtime" / "platforms.json"
    ).read_bytes()
    assert (destination / "LICENSE").read_bytes() == (ROOT / "LICENSE").read_bytes()
    assert (destination / "THIRD_PARTY_NOTICES.md").read_bytes() == (
        ROOT / "THIRD_PARTY_NOTICES.md"
    ).read_bytes()


def test_stage_runtime_rejects_a_noncanonical_executable_name(tmp_path: Path) -> None:
    executable = tmp_path / "renamed.exe"
    executable.write_bytes(b"runtime")

    with pytest.raises(ValueError, match="must be named deepseek-harness-sdk-runtime-win-x64.exe"):
        build_python_release.stage_runtime(
            tmp_path / "staging",
            "1.2.3",
            executable,
            "deepseek-harness-sdk-runtime-win-x64.exe",
        )
