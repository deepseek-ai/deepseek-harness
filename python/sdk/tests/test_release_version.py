"""Tests for repository-owned Python release versions."""

from __future__ import annotations

import json
import runpy
import zipfile
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


def test_wheel_verification_uses_distribution_metadata_not_nested_libraries(tmp_path: Path) -> None:
    wheel = tmp_path / "sdk.whl"
    with zipfile.ZipFile(wheel, "w") as archive:
        archive.writestr("nested/library.dist-info/WHEEL", "Tag: cp312-cp312-linux_x86_64\n")
        archive.writestr("nested/library.dist-info/METADATA", "Name: library\nVersion: 0.0.1\n")
        archive.writestr("deepseek_harness_sdk-1.2.3.dist-info/WHEEL", "Tag: py3-none-any\n")
        archive.writestr("deepseek_harness_sdk-1.2.3.dist-info/METADATA",
                         "Name: deepseek-harness-sdk\nVersion: 1.2.3\nLicense-Expression: MIT\n"
                         "License-File: LICENSE\nRequires-Dist: deepseek-harness-runtime-bin==1.2.3\n")
    build_python_release.verify_wheel(wheel, "sdk", "1.2.3", None)


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


def test_copy_package_omits_generated_carriers_before_staging_one_target(tmp_path: Path) -> None:
    source = tmp_path / "source"
    module = source / "src/deepseek_harness_runtime"
    for path in ("runtime/macos-arm64/primary-runtime/runtime.json", "runtime/node/package.json",
                 "runtime/deepseek-harness-sdk-runtime-win-x64.exe", "__init__.py", "_resources.py"):
        file = module / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.touch()
    destination = tmp_path / "staged"
    build_python_release.copy_package(source, destination)
    assert sorted(path.name for path in (destination / "src/deepseek_harness_runtime").iterdir()) == ["__init__.py", "_resources.py"]


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
    office = executable.parent / build_python_release.office_sidecar_name(executable.name)
    office_asset = office / "node_modules" / "@deepseek-ai" / "libreoffice-kit-wasm" / "assets" / "soffice.data"
    office_asset.parent.mkdir(parents=True)
    office_asset.write_bytes(b"office data")
    resources = executable.with_name(executable.name.removeprefix("deepseek-harness-sdk-runtime-").removesuffix(".exe"))
    resource = resources / "office-skills/scripts/check_office.py"
    resource.parent.mkdir(parents=True)
    resource.write_text("checker")
    destination = tmp_path / "staging"

    build_python_release.stage_runtime(destination, "1.2.3", executable, executable.name)

    runtime_dir = destination / "src" / "deepseek_harness_runtime" / "runtime"
    assert {
        path.name: path.read_bytes()
        for path in runtime_dir.glob("deepseek-harness-sdk-runtime-*")
        if path.is_file()
    } == expected
    assert (runtime_dir / office.name / office_asset.relative_to(office)).read_bytes() == b"office data"
    assert (runtime_dir / resources.name / resource.relative_to(resources)).read_text() == "checker"
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


@pytest.mark.parametrize("platform_tag,selected", [
    ("manylinux_2_28_x86_64", "wasm"), ("macosx_14_0_arm64", "darwin-arm64"),
    ("macosx_14_0_x86_64", "darwin-x64"), ("win_amd64", "win32-x64"),
    ("manylinux_2_28_x86_64", "linux-x64"), ("macosx_14_0_arm64", "wasm"),
])
@pytest.mark.parametrize("invalid", [None, "asset", "missing-engine", "foreign-engine", "helper-mode"])
def test_office_wheel_requires_only_target_engine(
    tmp_path: Path, platform_tag: str, selected: str, invalid: str | None,
) -> None:
    root = "runtime-office/node_modules"
    wheel = tmp_path / "office.zip"
    native = selected != "wasm"
    if invalid == "helper-mode" and (not native or platform_tag == "win_amd64"):
        pytest.skip("executable mode applies to POSIX native helpers")
    engine = ({"kind": "native", "executable": "bin/helper"} if native else
              {"kind": "wasm", "loader": "loader.cjs", "wasm": "engine.wasm", "data": "engine.data", "metadata": "fonts.json"})
    with zipfile.ZipFile(wheel, "w") as archive:
        archive.writestr(f"{root}/@deepseek-ai/libreoffice-kit/package.json", json.dumps({
            "optionalDependencies": {f"@deepseek-ai/libreoffice-kit-{selected}": "0.0.1"},
        }))
        base = f"{root}/@deepseek-ai/libreoffice-kit-{selected}"
        if invalid != "missing-engine":
            archive.writestr(f"{base}/prebuilds.json", json.dumps({"engine": engine}))
        for field in (("executable",) if native else ("loader", "wasm", "data", "metadata")):
            if invalid == "asset" and field == ("executable" if native else "data"):
                continue
            asset = zipfile.ZipInfo(f"{base}/{engine[field]}")
            asset.external_attr = (0o644 if invalid == "helper-mode" else 0o755) << 16
            archive.writestr(asset, b"payload")
        if invalid == "foreign-engine":
            foreign = "wasm" if native else "darwin-arm64"
            archive.writestr(f"{root}/@deepseek-ai/libreoffice-kit-{foreign}/prebuilds.json", "{}")
    with zipfile.ZipFile(wheel) as archive:
        if invalid is None:
            build_python_release.verify_office_payload(archive, root, platform_tag)
        else:
            message = {"asset": "asset is missing", "missing-engine": "dependency is missing",
                       "foreign-engine": "Unexpected Office engine", "helper-mode": "executable bit"}[invalid]
            with pytest.raises(RuntimeError, match=message):
                build_python_release.verify_office_payload(archive, root, platform_tag)
