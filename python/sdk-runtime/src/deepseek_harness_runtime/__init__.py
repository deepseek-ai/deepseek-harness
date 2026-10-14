"""Locate and execute the bundled dsh CLI shipped with the Python SDK runtime.

Two runtime carriers coexist under ``runtime/``, both injected by the repo's
``scripts/build-exe-for-python-sdk.ts`` build (neither is checked into git):

- **exe (production)**: single-file Node executables named
  ``deepseek-harness-sdk-runtime-<platform>-<arch>`` for Linux/macOS and an
  ``.exe`` counterpart for Windows. Each has a sibling ripgrep executable;
  macOS also uses a sibling ``-spawn-helper``. The target machine needs no
  Node installation.
- **node (dev-only)**: the full deploy closure under ``runtime/node/``
  (``package.json`` + ``node_modules/``), executed as ``node
  runtime/node/runtime-bootstrap.mjs`` on a
  system Node >= 22.19. It is the current checkout's source build, never
  selected automatically, and excluded from wheel/sdist distributions.

Both carriers execute the same dsh command grammar. The Python SDK selects the
``sdk`` profile and requires an explicit Harness home; the installed ``dsh``
console command requires ``DSH_HOME`` for the same reason.
"""

from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path
from ._resources import validate_downloads, validate_resources, office_launch_args

PACKAGE_METADATA_FILENAME = "deepseek-harness-runtime.json"

RUNTIME_MODE_ENV_VAR = "DSH_RUNTIME_MODE"

_PLATFORM_TAGS = {"linux": "linux", "darwin": "macos", "win32": "win"}
_ARCH_TAGS = {"x86_64": "x64", "amd64": "x64", "arm64": "arm64", "aarch64": "arm64"}

_EXE_ACQUISITION_HINT = (
    "Two ways to get the executable: run `scripts/build-exe-for-python-sdk.ts` (via tsx) in a "
    "deepseek-harness checkout, or install the matching `deepseek-harness-runtime-bin` platform "
    "wheel retained by the `build-exe-for-python-sdk` CI workflow. For local development "
    "against a repo source build, explicitly select the dev-only node carrier with "
    f"{RUNTIME_MODE_ENV_VAR}=node (or resolve_bundled_launch_args('node'))."
)


def bundled_package_dir() -> Path:
    """Root directory of the installed runtime package data (the directory of this module)."""
    root = Path(__file__).resolve().parent
    metadata = root / PACKAGE_METADATA_FILENAME
    if not metadata.is_file():
        raise FileNotFoundError(f"deepseek-harness-runtime-bin is missing {metadata}")
    return root


def bundled_runtime_path() -> Path:
    """Absolute path of the bundled single-file runtime executable for the current platform.

    Raises FileNotFoundError when the platform is unsupported, the executable
    has not been placed into this package, the ripgrep sidecar or download
    manifest is missing, or the required macOS spawn helper is missing.
    Invalid download metadata raises ValueError. Missing executable messages name
    the acquisition routes (acquisition strategy is deliberately separate from
    this lookup interface, so an on-demand download can replace it without
    touching callers).
    """
    tag = _current_platform_tag()
    extension = ".exe" if tag.startswith("win-") else ""
    path = bundled_package_dir() / "runtime" / f"deepseek-harness-sdk-runtime-{tag}{extension}"
    if not path.is_file():
        raise FileNotFoundError(
            f"deepseek-harness-runtime-bin is missing the runtime executable at {path}. "
            + _EXE_ACQUISITION_HINT
        )
    ripgrep = (
        path.with_name(f"{path.stem}-rg.exe")
        if tag.startswith("win-")
        else Path(f"{path}-rg")
    )
    if not ripgrep.is_file():
        raise FileNotFoundError(
            f"deepseek-harness-runtime-bin is missing the ripgrep sidecar at {ripgrep}. "
            + _EXE_ACQUISITION_HINT
        )
    if tag.startswith("macos-"):
        helper = Path(f"{path}-spawn-helper")
        if not helper.is_file():
            raise FileNotFoundError(
                f"deepseek-harness-runtime-bin is missing the node-pty spawn helper at {helper}. "
                + _EXE_ACQUISITION_HINT
            )
    validate_downloads(path.with_name(tag), tag)
    return path


def resolve_bundled_launch_args(mode: str | None = None) -> tuple[str, ...]:
    """The argv tuple that launches the bundled runtime.

    Mode selection: the explicit ``mode`` argument wins, then the
    ``DSH_RUNTIME_MODE`` environment variable (``exe`` | ``node``), then
    automatic resolution. Automatic resolution finds the production exe ONLY —
    the dev-only node carrier must be selected explicitly so a production
    deployment can never silently ride on a source build. Returns
    ``(exe_path,)`` in exe mode and ``(node_path, bin_js_path)`` in node mode;
    raises FileNotFoundError when the selected carrier is unavailable and
    ValueError for an unknown mode value.
    """
    selected = mode if mode is not None else os.environ.get(RUNTIME_MODE_ENV_VAR)
    if selected is None or selected == "exe":
        return (str(bundled_runtime_path()),)
    if selected == "node":
        return _node_launch_args()
    raise ValueError(
        f"unsupported DeepSeek Harness runtime mode {selected!r}: expected 'exe' or 'node' "
        f"(explicit argument or ${RUNTIME_MODE_ENV_VAR})"
    )


def _current_platform_tag() -> str:
    plat = _PLATFORM_TAGS.get(sys.platform)
    arch = _ARCH_TAGS.get(platform.machine().lower())
    if (
        plat is None
        or arch is None
        or (plat == "win" and arch != "x64")
    ):
        raise FileNotFoundError(
            "no bundled DeepSeek Harness SDK runtime exists for this platform "
            f"(sys.platform={sys.platform!r}, machine={platform.machine()!r}); supported: "
            "Linux x64/arm64, macOS x64/arm64, and Windows x64. " + _EXE_ACQUISITION_HINT
        )
    return f"{plat}-{arch}"


def _node_launch_args() -> tuple[str, str]:
    node_root = bundled_package_dir() / "runtime" / "node"
    bin_js = node_root / "runtime-bootstrap.mjs"
    if not bin_js.is_file():
        raise FileNotFoundError(
            f"the dev-only node runtime closure is missing at {node_root} "
            f"(no {bin_js}); run `scripts/build-exe-for-python-sdk.ts` in a deepseek-harness "
            "checkout, which builds and copies the deploy closure here. The node carrier "
            "is for repo-local development only — production uses the single-file exe."
        )
    node = shutil.which("node")
    if node is None:
        raise FileNotFoundError(
            "the node runtime mode needs a system `node` (>=22.19) on PATH; "
            "install Node.js or use the exe mode"
        )
    return (node, str(bin_js))


def _download(resource: str) -> Path:
    result = subprocess.run(resolve_bundled_launch_args(), capture_output=True, encoding="utf-8",
                            env={**os.environ, "DSH_RUNTIME_DOWNLOAD": resource})
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or f"resource download failed with exit code {result.returncode}")
    path = json.loads(result.stdout)
    if not isinstance(path, str) or not Path(path).is_absolute():
        raise ValueError("runtime returned an invalid resource path")
    return Path(path)


def download_office() -> Path:
    """Download the locked npm Office sidecar and standalone Node into the resource cache.

    Return its absolute directory. Reuse completed downloads; failures leave no
    published partial installation. DSH_RESOURCE_CACHE selects the cache root.
    This explicit operation requires network access on a cache miss, not a
    Harness home, agent, or model. Other SDK operations never trigger downloads.
    """
    return _download("office")


def download_primary_runtime() -> Path:
    """Download locked CPython, libraries, Node, pnpm and skills into the resource cache.

    Return the absolute primary-runtime directory. This is independent of the
    Office engine download and does not copy resources into a Harness home.
    Completed downloads are reused; DSH_RESOURCE_CACHE selects the cache root.
    """
    path = _download("primary")
    validate_resources(path.parent, _current_platform_tag())
    return path


def resolve_office_launch_args() -> tuple[str, str]:
    """Locate the explicitly downloaded Office CLI and its standalone Node; never download."""
    tag = _current_platform_tag()
    return office_launch_args(bundled_runtime_path().with_name(tag), tag)


def main() -> None:
    """Launch the CLI with explicit DSH_HOME; wait on Windows, replace the process on POSIX."""
    if not os.environ.get("DSH_HOME", "").strip():
        print(
            "dsh: the Python runtime command requires an explicit DSH_HOME; "
            "it never uses ~/.dsh implicitly",
            file=sys.stderr,
        )
        raise SystemExit(2)
    argv = (*resolve_bundled_launch_args(), *sys.argv[1:])
    if sys.platform == "win32":
        # Windows CRT exec does not replace the process; wait and preserve the runtime status.
        raise SystemExit(subprocess.run(argv, env=os.environ).returncode)
    os.execvpe(argv[0], argv, os.environ)


__all__ = [
    "PACKAGE_METADATA_FILENAME",
    "RUNTIME_MODE_ENV_VAR",
    "bundled_package_dir",
    "bundled_runtime_path",
    "download_office",
    "download_primary_runtime",
    "resolve_office_launch_args",
    "main",
    "resolve_bundled_launch_args",
]
