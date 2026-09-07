# Agent Note: Python SDK Windows x64 runtime

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-23-python-sdk-windows-x64-runtime.zh.md)

## Problem

The Python SDK runtime distribution needs a Windows carrier without creating another application entrypoint or weakening the installed-wheel evidence used by the existing native targets. Windows executable names, Python wheel tags, ConPTY addons, ripgrep sidecars, shell composition, virtual environments, and process launch rules differ from Linux and macOS. Claiming Windows from cross-platform unit tests or from a non-Windows executable would leave the artifact selected by `pip` unproved.

## Decision

### One x64 product

`python/sdk-runtime/platforms.json` declares one Windows target, `win-x64`. Its pkg target is `node24-win-x64`, its runtime wheel tag is `py3-none-win_amd64`, and its payload is `deepseek-harness-sdk-runtime-win-x64.exe` with `deepseek-harness-sdk-runtime-win-x64-rg.exe`. The packaged `node-pty` tree must contain both x64 ConPTY addons. Runtime lookup rejects Windows arm64 rather than selecting or relabeling the x64 wheel.

The Python process still launches the ordinary `dsh --profile sdk` application and requires an explicit Harness home under the [Python profile-runtime decision](2026-08-23-python-sdk-dsh-profile-runtime.md). Windows adds no Python-specific Node application, complete-config entrypoint, implicit `~/.dsh`, or system Node requirement.

### Native build and publication

The executable builder accepts `win` as a pkg platform only with x64, requires the Windows build to run under x64 Node on a Windows host, preserves `.exe` names, and copies `@vscode/ripgrep-win32-x64` as the conventional `-rg.exe` sidecar. Pnpm subprocesses use a caller-supplied JavaScript entry through `process.execPath`. When the caller exposes a `.cmd` shim, the builder resolves the installed `pnpm.mjs` or `pnpm.cjs` through `PNPM_HOME`; it fails if no JavaScript entry exists instead of spawning the shim or enabling a command shell.

The required GitHub matrix builds `node24-win-x64` on `windows-2025` beside Linux x64, Linux arm64, macOS arm64, and macOS x64. The public GitHub release and GitLab tag pipeline each publish the same five runtime wheels plus the pure SDK wheel. Windows arm64 is absent from target parsing, manifests, matrices, release contents, and documentation.

### Installed-wheel behavior

The Windows lane creates a clean Windows virtual environment, installs the exact SDK and `win_amd64` runtime wheels, changes to a directory outside the checkout, unsets `PYTHONPATH` and `DSH_RUNTIME_MODE`, and runs the same `--scenario all --installed-wheel` blackbox as every other target. Trusted pull requests also run the same two-turn `sdk-live` provider scenario. Fork and Dependabot heads receive no key.

The public Python client gives the initial profile handshake an independent 30-second default through `initialize_timeout_seconds`. The bound accommodates cold Windows x64 executable startup and profile materialization while still failing a stuck runtime; callers may configure it separately from ordinary request timeouts.

After a successful shutdown response, the Python client closes stdin and waits within the configured shutdown timeout for the `dsh` context to exit and flush durable session state before terminating it. A failed shutdown retains immediate bounded termination. `shutdown_timeout_seconds` bounds each of the shutdown request, EOF grace, and termination-confirmation phases, so a pathological close can approach three times that value before the final kill. This distinction preserves the final accepted turn on Windows, where `terminate()` force-kills the process rather than delivering a catchable signal.

The minimal blackbox uses persistent `pwsh` plus `str_replace_editor` on Windows and owns `minimal/win-x64/model-visible.json`; Linux and macOS retain persistent Bash and the shared `minimal/model-visible.json`. The advanced process/subagent snapshot and restart/durable-log snapshot remain shared across all targets. The shipped [`sdk-minimal` bundle](../../../../packages/bundle/sdk-minimal/README.md) selects the same platform shell pair for the runnable Python tutorial.

## Existing decisions and supersession

This decision partially supersedes the Windows non-goal in the [single-file runtime distribution](2026-07-10-single-file-executable-sdk-runtime-distribution.md) and extends the required target set in the [installed Python wheel blackbox decision](../testing/2026-08-23-installed-python-wheel-black-box-ci.md). Those notes remain authoritative for SEA packaging, the two Python distributions, provenance checks, key handling, and the common blackbox scenarios.

## Alternatives considered

**Add Windows before the dsh profile runtime.** Rejected because tests for the retired private direct-config carrier would not prove the Windows form users receive. Windows is defined only for the sole `dsh` launch architecture.

**Publish Windows arm64 too.** Rejected because the accepted product scope is x64 only; adding a second architecture would require its own native builder, wheel tag, ConPTY and ripgrep payload checks, installed-wheel matrix leg, and release artifact.

**Give Windows a smaller smoke suite.** Rejected because a platform wheel cannot borrow protocol, persistence, worker, MCP, plugin, native-tool, or real-provider evidence from another executable. Platform-specific expected output is limited to the persistent shell surface; the remaining snapshots stay shared.

**Run the Windows leg through Git Bash.** Rejected because the repository requires native `pwsh` on Windows runners and MSYS path conversion would not prove native command behavior. Portable one-line steps use each runner's default shell; path, virtual-environment, and blackbox steps have explicit POSIX and PowerShell forms.

## Consequences

Python installation selects a Node-free Windows x64 runtime with the same explicit-home and profile customization model as Linux and macOS. Every pull request builds the Windows executable and runtime wheel as one of five native targets, runs the full keyless blackbox, and—on trusted heads—runs the real-provider task. Release validation retains six wheels. Windows arm64 users receive an explicit unsupported-platform failure until a separate native product decision supplies and proves that carrier.
