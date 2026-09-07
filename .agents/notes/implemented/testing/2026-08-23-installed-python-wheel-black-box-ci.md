# Agent Note: Installed-wheel Python runtime pull-request validation

Status: implemented

English | [中文](2026-08-23-installed-python-wheel-black-box-ci.zh.md)

## Problem

The Python SDK unit suite drives fake peers, while the packaged-runtime workflow can run the source SDK against a newly built executable before either Python distribution exists. Its clean virtual environment exercises only the default and MCP cases, and required pull-request CI builds only Linux x64. A source checkout, editable install, mismatched SDK/runtime pair, broken native wheel, platform-specific closure, or real-provider integration can therefore escape the evidence that blocks a merge.

## Decision

### Installed artifact boundary

The required Python runtime workflow builds the pure SDK wheel and each platform runtime wheel before behavior tests. Every native target installs those two local files into a new Python 3.10 virtual environment, changes to a temporary directory outside the repository, unsets `PYTHONPATH` and `DSH_RUNTIME_MODE`, and invokes only the public Python modules plus the packaged executable.

The black-box harness rejects a non-venv process, repository-relative working directory, source or editable import, unequal distribution versions, an SDK dependency that does not exactly pin the runtime version, an executable outside the installed runtime package, or an executable absent from the runtime distribution record. This provenance check runs before the first agent request, so a behavior pass cannot conceal that the wrong code ran.

### Keyless behavior

Every target runs the complete packaged-runtime scenario set after installation. A local SSE model keeps outputs deterministic while the public SDK exercises the default SDK profile, ordered patch overlays, external bundle installation through `dsh plugin`, persistent PTY and editor behavior, worker-thread code and workflow execution, ripgrep-backed search, external stdio MCP discovery and execution, model-visible and durable snapshots, Zstandard persistence, direct JSON-RPC, and shutdown. A restart snapshot launches two complete SDK runtime processes against one persistence root and pins their isolated model histories, high-level results, and separate durable logs. The installed run replaces the source-SDK pre-wheel run; the executable and wheel are tested together once rather than maintaining two behavior inventories.

Linux additionally retains its manylinux 2.28 clean-install smoke and GLIBC checks. macOS retains deployment-target and native helper checks. These platform constraints supplement the common black-box behavior rather than substituting for it.

### Real DeepSeek API

Trusted pull requests and master pushes run a second installed-wheel check on each selected native target with `DEEPSEEK_API_KEY_EXTERNAL`, mapped only into a preflight and the live test step. The preflight fails when the secret is empty, so the provider suite cannot self-skip to green. The test starts the public SDK against `https://api.deepseek.com`, asks the model to write an exact sentinel file through the platform shell, asks a second turn in the same session to read it, and verifies the external line content, final responses, completed turn reasons, model-requested tool calls, and the existence and Zstandard framing of its session log. Decoded record content and completed-turn durability are deterministic keyless obligations owned by the restart snapshot rather than inferred from compressed live-provider bytes.

Fork and Dependabot pull requests never receive the repository secret. Their native jobs run the complete keyless path and skip both secret-bearing steps; `pull_request_target` is forbidden because it would execute untrusted code with the key.

### Required targets

The pull-request `python-runtime` job calls the reusable builder for Linux x64 and Windows x64; master pushes select Linux arm64 and both macOS architectures under the [master-only platform policy](../process/2026-09-06-master-only-platform-ci.md). Its aggregate result remains a dependency of `all checks passed`, so a failed, cancelled, or missing native carrier blocks the required verdict. The [sdk-runtime README](../../../../python/sdk-runtime/README.md) owns the Windows target and its PowerShell-specific minimal snapshot.

## Existing decisions and supersession

This decision supersedes the single-target topology in the archived [required Python runtime pull-request validation](../../archived/testing/2026-08-12-required-python-runtime-pull-request-ci.md) while retaining its requirement that the real executable, snapshots, wheels, and clean installation meet in each selected target check. [docs/architecture.md](../../../../docs/architecture.md) owns the launched application and customization surface; the [single-file Python SDK runtime distribution](../architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md) remains authoritative for SEA packaging, native sidecars, wheel tags, and release artifacts.

## Alternatives considered

**Keep Linux x64 as the only required carrier.** Rejected because native addons, executable construction, wheel tags, and helper files differ across the five published targets. Release-time discovery is too late for an artifact that every Python SDK installation selects by platform.

**Run full behavior before wheel construction and keep two small installed smokes.** Rejected because that proves the executable against source imports, then proves too little through the distribution users install. The clean installed environment is the stronger common location for the same scenarios.

**Use keyless model emulation only.** Rejected because a local SSE endpoint cannot prove authentication, request compatibility, streaming, tool-call interpretation, or a complete turn against the real provider.

**Expose the key to forked pull requests through `pull_request_target`.** Rejected because arbitrary fork code could exfiltrate the repository secret. Missing credentialed evidence on an untrusted ref is explicit and security-preserving; trusted heads and post-merge provider CI retain the live signal.

## Consequences

Every pull request pays for two native executable and wheel builds plus deterministic installed-artifact scenarios. Trusted same-repository pull requests also pay for one two-turn DeepSeek task per target. In exchange, the required result describes the files Python users install, proves the selected carriers before merge, and cannot pass by importing the checkout or silently skipping the real provider.
