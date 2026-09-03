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
  runtime/node/node_modules/@deepseek-ai/dsh/lib/bin.js`` on a
  system Node >= 22.19. It is the current checkout's source build, never
  selected automatically, and excluded from wheel/sdist distributions.

Both carriers execute the same dsh command grammar. The Python SDK selects the
``sdk`` profile and requires an explicit Harness home; the installed ``dsh``
console command requires ``DSH_HOME`` for the same reason.
"""

from __future__ import annotations

import os
import platform
import shutil
import sys
from pathlib import Path

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
    has not been placed into this package, the required ripgrep sidecar is
    missing, or the required macOS spawn helper is missing; the message names
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
    bin_js = (
        node_root
        / "node_modules"
        / "@deepseek-ai"
        / "dsh"
        / "lib"
        / "bin.js"
    )
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


def main() -> None:
    """Execute the bundled dsh CLI with an explicitly selected Harness home."""
    if not os.environ.get("DSH_HOME", "").strip():
        print(
            "dsh: the Python runtime command requires an explicit DSH_HOME; "
            "it never uses ~/.dsh implicitly",
            file=sys.stderr,
        )
        raise SystemExit(2)
    argv = (*resolve_bundled_launch_args(), *sys.argv[1:])
    os.execvpe(argv[0], argv, os.environ)


__all__ = [
    "PACKAGE_METADATA_FILENAME",
    "RUNTIME_MODE_ENV_VAR",
    "bundled_package_dir",
    "bundled_runtime_path",
    "main",
    "resolve_bundled_launch_args",
]
