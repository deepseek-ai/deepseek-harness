"""Validate wheel download manifests, downloaded resources, and Office process launches."""

from __future__ import annotations

import json
import os
import signal
import subprocess
from collections.abc import Sequence
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
    required = [executable, node]
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


def validate_downloads(root: Path | zipfile.Path, target: str) -> dict:
    """Validate the lightweight download manifest carried by one platform wheel."""
    path = root / "downloads.json"
    value = json.loads(path.read_text(encoding="utf-8"))
    if (not isinstance(value, dict) or value.get("target") != target.replace("macos-", "mac-")
            or not isinstance(value.get("identity"), str)
            or not re.fullmatch(r"[a-f0-9]{64}", value["identity"])
            or not isinstance(value.get("office"), list) or not value["office"]
            or not isinstance(value.get("pnpm"), dict)):
        raise ValueError(f"invalid runtime download manifest: {path}")
    for file in (f"office-{kind}/SKILL.md" for kind in ("docx", "pptx", "xlsx")):
        if not (root / "office-skills" / file).is_file():
            raise FileNotFoundError(f"runtime Office skill is missing: {root / 'office-skills' / file}")
    return value


def office_launch_args(root: Path, target: str) -> tuple[str, str]:
    """Require an explicitly installed sidecar, including its independent Node interpreter."""
    metadata = validate_downloads(root, target)
    cache = Path(os.environ.get("DSH_RESOURCE_CACHE", str(Path.home() / ".cache/deepseek-harness/resources")))
    if not cache.is_absolute():
        raise ValueError("DSH_RESOURCE_CACHE must be an absolute directory")
    office = Path(os.environ.get("DSH_OFFICE_SIDECAR", str(cache / metadata["identity"] / "office")))
    if not office.is_absolute():
        raise ValueError("DSH_OFFICE_SIDECAR must be an absolute directory")
    if "DSH_OFFICE_SIDECAR" not in os.environ:
        complete = office / "complete"
        if not complete.is_file():
            raise FileNotFoundError(f"Office download is incomplete: {office}. Call deepseek_harness_runtime.download_office() first.")
        if complete.read_text(encoding="utf-8") != metadata["identity"]:
            raise ValueError(f"Office cache identity mismatch: {office}")
    node = office / "node/bin" / ("node.exe" if target == "win-x64" else "node")
    cli = office / "node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js"
    for path in (node, cli):
        if not path.is_file():
            raise FileNotFoundError(f"Office resource is missing: {path}. Call deepseek_harness_runtime.download_office() first.")
    return str(node), str(cli)


def run_office_process(arguments: Sequence[str]) -> subprocess.CompletedProcess[bytes]:
    """Run Office with captured streams; a second interrupt kills its process tree."""
    taskkill = os.path.join(os.environ.get("SystemRoot", ""), "System32", "taskkill.exe")
    if os.name == "nt" and not os.path.isabs(taskkill):
        raise ValueError("Office operations on Windows require an absolute SystemRoot environment value.")
    with subprocess.Popen(
        arguments,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=os.name != "nt",
    ) as process:
        try:
            stdout, stderr = process.communicate()
        except KeyboardInterrupt:
            # Windows console Ctrl+C already reaches children in the same console.
            if os.name != "nt":
                process.send_signal(signal.SIGINT)
            try:
                process.communicate()
            except KeyboardInterrupt:
                if os.name == "nt":
                    subprocess.run([taskkill, "/PID", str(process.pid), "/T", "/F"],
                                   stdin=subprocess.DEVNULL, capture_output=True, check=False)
                else:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError as error:
                        # The CLI and its children can finish before the second interrupt.
                        pass
                process.communicate()
            raise
    return subprocess.CompletedProcess(arguments, process.returncode, stdout, stderr)
