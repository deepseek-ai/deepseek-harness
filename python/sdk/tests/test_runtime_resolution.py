"""Keyless runtime-resolution tests; launch coverage lives in test_bundled_runtime.py."""

from __future__ import annotations

from pathlib import Path

import deepseek_harness_runtime as runtime
import pytest

from deepseek_harness_runtime import (
    RUNTIME_MODE_ENV_VAR,
    bundled_package_dir,
    main,
    resolve_bundled_launch_args,
)


def test_unknown_explicit_mode_fails_loud() -> None:
    with pytest.raises(ValueError, match="expected 'exe' or 'node'"):
        resolve_bundled_launch_args("bogus")


def test_unknown_env_mode_fails_loud(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(RUNTIME_MODE_ENV_VAR, "bogus")
    with pytest.raises(ValueError, match="expected 'exe' or 'node'"):
        resolve_bundled_launch_args()


def test_explicit_mode_wins_over_env_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(RUNTIME_MODE_ENV_VAR, "bogus")
    try:
        args = resolve_bundled_launch_args("exe")
    except FileNotFoundError:
        return  # explicit 'exe' was honored; only the artifact is missing
    assert args[0].endswith(("-x64", "-arm64"))


def test_runtime_requires_spawn_helper_only_on_macos(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runtime_dir = tmp_path / "runtime"
    runtime_dir.mkdir()
    linux = runtime_dir / "deepseek-harness-sdk-runtime-linux-x64"
    linux.touch()
    Path(f"{linux}-rg").touch()
    macos = runtime_dir / "deepseek-harness-sdk-runtime-macos-arm64"
    macos.touch()
    Path(f"{macos}-rg").touch()
    monkeypatch.setattr(runtime, "bundled_package_dir", lambda: tmp_path)

    monkeypatch.setattr(runtime, "_current_platform_tag", lambda: "macos-arm64")
    with pytest.raises(FileNotFoundError, match="node-pty spawn helper"):
        runtime.bundled_runtime_path()
    monkeypatch.setattr(runtime, "_current_platform_tag", lambda: "linux-x64")
    assert runtime.bundled_runtime_path() == linux


def test_windows_runtime_uses_exe_payload_and_exe_sidecar(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runtime_dir = tmp_path / "runtime"
    runtime_dir.mkdir()
    executable = runtime_dir / "deepseek-harness-sdk-runtime-win-x64.exe"
    executable.touch()
    (runtime_dir / "deepseek-harness-sdk-runtime-win-x64-rg.exe").touch()
    monkeypatch.setattr(runtime, "bundled_package_dir", lambda: tmp_path)
    monkeypatch.setattr(runtime, "_current_platform_tag", lambda: "win-x64")

    assert runtime.bundled_runtime_path() == executable


def test_current_platform_supports_windows_x64_only(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runtime.sys, "platform", "win32")
    monkeypatch.setattr(runtime.platform, "machine", lambda: "AMD64")
    assert runtime._current_platform_tag() == "win-x64"

    monkeypatch.setattr(runtime.platform, "machine", lambda: "ARM64")
    with pytest.raises(FileNotFoundError, match="Windows x64"):
        runtime._current_platform_tag()


def test_current_platform_supports_macos_x64(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runtime.sys, "platform", "darwin")
    monkeypatch.setattr(runtime.platform, "machine", lambda: "x86_64")

    assert runtime._current_platform_tag() == "macos-x64"


def test_runtime_requires_ripgrep_sidecar(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runtime_dir = tmp_path / "runtime"
    runtime_dir.mkdir()
    (runtime_dir / "deepseek-harness-sdk-runtime-linux-x64").touch()
    monkeypatch.setattr(runtime, "bundled_package_dir", lambda: tmp_path)
    monkeypatch.setattr(runtime, "_current_platform_tag", lambda: "linux-x64")

    with pytest.raises(FileNotFoundError, match="ripgrep sidecar"):
        runtime.bundled_runtime_path()


def test_node_mode_runs_the_deployed_dsh_cli(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bin_js = tmp_path / "runtime" / "node" / "node_modules" / "@deepseek-ai" / "dsh" / "lib" / "bin.js"
    bin_js.parent.mkdir(parents=True)
    bin_js.touch()
    monkeypatch.setattr(runtime, "bundled_package_dir", lambda: tmp_path)
    monkeypatch.setattr(runtime.shutil, "which", lambda _name: "/node")

    assert resolve_bundled_launch_args("node") == ("/node", str(bin_js))


def test_python_dsh_command_requires_explicit_home(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("DSH_HOME", raising=False)

    with pytest.raises(SystemExit) as excinfo:
        main()

    assert excinfo.value.code == 2
    assert "explicit DSH_HOME" in capsys.readouterr().err


def test_python_dsh_command_executes_the_bundled_cli(
    monkeypatch: pytest.MonkeyPatch
) -> None:
    called: dict[str, object] = {}
    monkeypatch.setenv("DSH_HOME", "/explicit/home")
    monkeypatch.setattr(runtime, "resolve_bundled_launch_args", lambda: ("/runtime",))
    monkeypatch.setattr(runtime.sys, "argv", ["dsh", "plugin", "--profile", "sdk", "list"])

    def execvpe(file: str, args: tuple[str, ...], env: dict[str, str]) -> None:
        called.update(file=file, args=args, home=env.get("DSH_HOME"))

    monkeypatch.setattr(runtime.os, "execvpe", execvpe)

    main()

    assert called == {
        "file": "/runtime",
        "args": ("/runtime", "plugin", "--profile", "sdk", "list"),
        "home": "/explicit/home",
    }
