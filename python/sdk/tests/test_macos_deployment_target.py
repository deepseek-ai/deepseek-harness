"""Tests for macOS runtime wheel deployment-target validation."""

from __future__ import annotations

import runpy
from pathlib import Path
from types import SimpleNamespace

import pytest


ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "scripts" / "check-macos-deployment-target.py"
checker = SimpleNamespace(**runpy.run_path(str(SCRIPT)))


def test_otool_parser_uses_the_newest_macho_slice() -> None:
    output = """
Load command 8
      cmd LC_VERSION_MIN_MACOSX
  cmdsize 16
  version 10.7
      sdk 11.1
Load command 9
      cmd LC_BUILD_VERSION
    minos 11.0
Load command 10
      cmd LC_BUILD_VERSION
    minos 13.5
    """

    assert checker.parse_otool_deployment_target(output) == (13, 5)


def test_otool_parser_requires_a_deployment_target() -> None:
    with pytest.raises(ValueError, match="contains no macOS deployment target"):
        checker.parse_otool_deployment_target("Load command 0\n")


def test_otool_parser_ignores_unrelated_version_fields() -> None:
    output = """
Load command 1
          cmd LC_ID_DYLIB
      cmdsize 48
      current version 14.1.0
compatibility version 1.0.0
    """

    with pytest.raises(ValueError, match="contains no macOS deployment target"):
        checker.parse_otool_deployment_target(output)


def test_wheel_tag_rejects_a_newer_executable_target() -> None:
    checker.ensure_compatible(Path("runtime"), (13, 5), "macosx_14_0_arm64")
    checker.ensure_compatible(Path("runtime-x64"), (10, 7), "macosx_14_0_x86_64")

    with pytest.raises(RuntimeError, match="requires macOS 14.1"):
        checker.ensure_compatible(Path("spawn-helper"), (14, 1), "macosx_14_0_arm64")


def test_wheel_tag_accepts_only_supported_macos_architectures() -> None:
    assert checker.claimed_version("macosx_14_0_arm64") == (14, 0)
    assert checker.claimed_version("macosx_14_0_x86_64") == (14, 0)

    with pytest.raises(ValueError, match="unsupported macOS wheel platform tag"):
        checker.claimed_version("macosx_14_0_universal2")
