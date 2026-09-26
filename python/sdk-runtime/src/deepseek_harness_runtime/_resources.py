"""Validate the authoring resources in staged, installed, or archived runtime wheels."""

from __future__ import annotations

import json
import re
import stat
import zipfile
from pathlib import Path


def validate_resources(root: Path | zipfile.Path, target: str) -> None:
    """Reject a missing or wrong-target Python/Node environment or bundled Office skill tree."""
    manifest_path = root / "primary-runtime/runtime.json"
    if not manifest_path.is_file():
        raise FileNotFoundError(f"runtime authoring resources are missing: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    platform, arch = target.rsplit("-", 1)
    platform = {"macos": "darwin", "win": "win32"}.get(platform, platform)
    if not isinstance(manifest, dict) or (manifest.get("platform"), manifest.get("arch")) != (platform, arch):
        raise ValueError(f"runtime authoring resources do not match target {target}")
    version = manifest.get("python")
    if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("runtime authoring resources have invalid Python version metadata")
    if not isinstance(manifest.get("pythonPackages"), dict) or not manifest["pythonPackages"]:
        raise ValueError("runtime authoring resources have no Python distributions")
    python_root = root / "primary-runtime/dependencies/python"
    executable = python_root / ("python.exe" if platform == "win32" else "bin/python3")
    packages = python_root / ("Lib/site-packages" if platform == "win32" else f"lib/python{version.rsplit('.', 1)[0]}/site-packages")
    node = root / "primary-runtime/dependencies/node/bin" / ("node.exe" if platform == "win32" else "node")
    required = [executable, node, root / "office-skills/scripts/check_office.py"]
    required.extend(root / f"office-skills/office-{kind}/SKILL.md" for kind in ("docx", "pptx", "xlsx"))
    for path in required:
        if not path.is_file():
            raise FileNotFoundError(f"runtime authoring resource is missing: {path}")
    if not packages.is_dir():
        raise FileNotFoundError(f"runtime Python site-packages is missing: {packages}")
    if platform != "win32":
        for binary in (executable, node):
            mode = (binary.root.getinfo(binary.at).external_attr >> 16
                    if isinstance(binary, zipfile.Path) else binary.stat().st_mode)
            if mode & stat.S_IXUSR == 0:
                raise ValueError(f"runtime interpreter lost its executable bit: {binary}")
