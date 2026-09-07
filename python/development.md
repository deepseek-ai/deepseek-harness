# Python contributor workflows

English | [中文](development.zh.md)

Follow the workflow for the contributor outcome you need: build runtime artifacts, validate the SDK, run against source, or build distributions. Package behavior belongs in the [SDK reference](sdk/README.md) and [runtime carrier reference](sdk-runtime/README.md).

## Build runtime artifacts

Platform executables are build artifacts and are not checked into git. Run the build from the repository root:

```sh
pnpm install
pnpm exec tsx scripts/build-exe-for-python-sdk.ts
```

Use `--skip-build` when the required `lib/` artifacts already exist, or `--targets=node24-linux-x64,node24-linux-arm64,node24-macos-arm64,node24-macos-x64,node24-win-x64` to select platforms. Build each target on its native architecture. Products land in `dist-exe/` and the script syncs the selected carriers into `python/sdk-runtime/`. Windows emits `.exe` and `-rg.exe`; macOS also syncs the matching spawn helper required by `node-pty`.

## Validate the SDK

Keep the virtual environment outside `python/`, install the test group, and run the Python suite:

```sh
export UV_PROJECT_ENVIRONMENT="$PWD/tmp/py-sdk-venv"
uv sync --project python/sdk --group test
uv run --project python/sdk pytest
```

`python/sdk/tests/test_bundled_runtime.py` exercises available bundled carriers and skips a carrier when its artifact has not been built. For repository-wide test policy, see [Testing](../docs/testing.md).

That suite drives fake runtime peers. `scripts/smoke-python-runtime.py` drives the packaged runtime instead. The `python-runtime` CI jobs build Linux x64 and Windows x64 on pull requests, and Linux arm64 plus both macOS architectures on master pushes. Each selected target installs the matching SDK and runtime wheels into a new Python 3.10 virtual environment, runs outside the checkout with `PYTHONPATH` and `DSH_RUNTIME_MODE` unset, proves that both modules and the executable came from those distributions, and then runs every keyless scenario. A focused local source-SDK run can select one built executable and scenario:

```sh
uv run --project python/sdk python scripts/smoke-python-runtime.py \
  --scenario sdk-minimal --exe dist-exe/deepseek-harness-sdk-runtime-macos-arm64
```

Three scenarios compare committed expected output under `scripts/snapshots/python-sdk-single-exe/`. `minimal/model-visible.json` pins the Linux/macOS `sdk-minimal` profile's assembled system prompts, advertised tool schemas, and model-visible messages; `minimal/win-x64/model-visible.json` pins its PowerShell counterpart. A plugin that contributes an unintended system section or user message therefore fails the job, and every message the profile emits is compared. `advanced/` pins one complex process's SDK result and parent/child session logs across every target. `restart/` launches two complete SDK runtime processes against one persistence root and snapshots their isolated model histories, high-level results, and separate durable logs across every target. Rerun the owning scenario with `--update-snapshots` and review that diff before committing it.

Trusted pull requests and master pushes also run `--scenario sdk-live --installed-wheel` on each selected native target. That scenario performs two tool-using turns against `https://api.deepseek.com`, verifies the created file externally, and fails when the repository secret is absent instead of self-skipping. Fork and Dependabot pull requests run the complete keyless installed-wheel path but receive no key.

An interactive smoke test needs `DEEPSEEK_API_KEY` in the environment or repository-root `.env`:

```python
from deepseek_harness import DeepSeekHarness

with DeepSeekHarness(dsh_home="/absolute/path/to/test-dsh-home") as harness:
    print(harness.run("say hi").final_response)
```

Alternatively export a non-empty `DSH_HOME`. The SDK rejects a launch that would silently use `~/.dsh`.

## Run against Node source

Repository contributors can select either development route; both execute the normal `dsh --profile sdk` launcher:

- Set `DSH_RUNTIME_MODE=node` to use the built Node carrier on system Node `>=22.19`. The build script refreshes this carrier, but distributions never include or auto-select it.
- Set `dsh_bin` to the absolute built `apps/cli/lib/bin.js` path to exercise the checkout's CLI directly. Supply an explicit `dsh_home`, plus `profile` and ordered `patches` as needed.

`python/sdk/tests/manual_sdk_agent_smoke.py` uses the internal `_launch_args` test adapter to exercise the unbuilt TypeScript CLI under tsx. Arbitrary argv replacement is intentionally absent from the public SDK.

## Build distributions

The root `package.json` version is authoritative for both Python distributions. The staging script injects that version into both wheels and pins the SDK to the same `deepseek-harness-runtime-bin` version.

Build the pure SDK wheel once and one runtime wheel on each native platform:

```sh
version="$(python - <<'PY'
import runpy

release = runpy.run_path("scripts/build-python-release.py")
print(release["pep440_version"](release["repository_version"]()))
PY
)"
python scripts/build-python-release.py --package sdk --output-dir dist-python
python scripts/build-python-release.py --package runtime --platform macos-arm64 --runtime-exe dist-exe/deepseek-harness-sdk-runtime-macos-arm64 --output-dir dist-python
pip install \
  "dist-python/deepseek_harness_sdk-$version-py3-none-any.whl" \
  "dist-python/deepseek_harness_runtime_bin-$version-py3-none-macosx_14_0_arm64.whl"
```

The runtime distribution is wheel-only. The release pipeline publishes five platform wheels with the pure SDK wheel: Linux x64, Linux arm64, macOS 14 or newer on arm64 and x64, and Windows x64 (`win_amd64`). A `python-v<repository-version>` tag is accepted only when it matches the repository version; prerelease repository versions such as `0.0.1-rc.1` use their normalized PEP 440 spelling, such as `0.0.1rc1`, inside wheel filenames and metadata.

## Validate a release candidate

Manually run the GitHub `Release (Python)` workflow with `publish=false` to build all six wheels, install the Linux release set on Python 3.10 and 3.14, check exact filenames and metadata, enforce PyPI's default per-file size limit, and retain one aggregate artifact with SHA-256 hashes. The run has no registry credentials; a dry run cannot enter either publication job.

Public publication runs from the private automation repository. Package metadata points to the separate read-only public source mirror, which does not run release Actions. The private repository defines the repository variable `PYPI_PUBLISHER_REPOSITORY` as its own `owner/name` and keeps `PUBLIC_PYPI_RELEASE_ENABLED=false` except during an intentional release.

Separate runtime and SDK jobs let an SDK upload failure resume without resending immutable runtime files. They accept `publish=true` only when the workflow runs from the configured publisher repository at the matching `python-v*` tag and the protected `pypi-runtime` and `pypi` environments approve the runtime and SDK jobs, respectively. PyPI Trusted Publishing still supplies short-lived OIDC credentials, but public attestations are disabled because they would disclose the private publisher identity.
