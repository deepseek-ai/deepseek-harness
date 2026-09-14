# Get started with the Python SDK

English | [中文](python-sdk.zh.md)

This tutorial installs the published Python SDK, runs the shipped standalone minimal profile, and shows how to customize the same `dsh` profile from your own program.

## Prerequisites

- Python 3.10 or newer
- Git
- Linux x64, Linux arm64, macOS 14 or newer on arm64, or Windows x64
- A DeepSeek-compatible API endpoint and credential
- An isolated workspace and an isolated Harness home

## Install the SDK

### Linux and macOS

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
python -m venv .venv
. .venv/bin/activate
python -m pip install deepseek-harness-sdk
```

### Windows PowerShell

```powershell
git clone https://github.com/deepseek-ai/deepseek-harness.git
Set-Location deepseek-harness
py -3.10 -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install deepseek-harness-sdk
```

The installation includes a matching native runtime wheel and the `dsh` command. Normal SDK execution needs no system Node.js. Repository contributors who build the artifacts should use the [Python contributor workflow](../../../python/development.md).

## Run the checked-in example

Export the credential and, when needed, a compatible proxy endpoint:

### Linux and macOS

```sh
export DEEPSEEK_API_KEY=sk-your-key-here
# export DEEPSEEK_BASE_URL=http://127.0.0.1:8000/v1
```

### Windows PowerShell

```powershell
$env:DEEPSEEK_API_KEY = "sk-your-key-here"
# $env:DEEPSEEK_BASE_URL = "http://127.0.0.1:8000/v1"
```

Run one task with explicit workspace and home paths:

### Linux and macOS

```sh
python python/sdk/examples/minimal.py \
  --workspace /absolute/path/to/disposable-workspace \
  --dsh-home /absolute/path/to/example-dsh-home \
  --session-id example-001 \
  "Inspect the repository and fix the failing tests."
```

### Windows PowerShell

```powershell
python python/sdk/examples/minimal.py `
  --workspace C:\work\disposable-workspace `
  --dsh-home C:\work\example-dsh-home `
  --session-id example-001 `
  "Inspect the repository and fix the failing tests."
```

The script prints the final assistant response. The selected home receives the generated `sdk-minimal` profile, installed plugins, and uncompressed JSONL session logs under `sessions/`. The example and SDK never silently read `~/.dsh`.

## Use the SDK in your program

```python
from pathlib import Path

from deepseek_harness import DeepSeekHarness

workspace = Path("/absolute/path/to/disposable-workspace").resolve()
dsh_home = Path("/absolute/path/to/example-dsh-home").resolve()
with DeepSeekHarness(
    provider="deepseek-official",
    model="deepseek-v4-flash",
    max_tokens=49_152,
    cwd=str(workspace),
    dsh_home=str(dsh_home),
    profile="sdk-minimal",
) as harness:
    result = harness.run(
        "Inspect the repository and fix the failing tests.",
        session_id="example-001",
    )

print(result.final_response)
```

The SDK starts the bundled `dsh --profile sdk-minimal` process lazily and reuses it until context-manager exit. The profile, its persistent patch, the home patch, and any ordered `patches` tuple form the application configuration. There is no separate Python runtime bin or complete-config option.

## Install or define plugins

Use `dsh plugin` for dependencies and bundle layers that should persist in this home:

### Linux and macOS

```sh
export DSH_HOME=/absolute/path/to/example-dsh-home
dsh --profile sdk-minimal --dump-default-config >/dev/null
dsh plugin --profile sdk-minimal add file:/absolute/path/to/my-plugin-bundle
```

### Windows PowerShell

```powershell
$env:DSH_HOME = "C:\work\example-dsh-home"
dsh --profile sdk-minimal --dump-default-config | Out-Null
dsh plugin --profile sdk-minimal add file:C:/work/my-plugin-bundle
```

The first command initializes the shipped standalone profile. The second forwards package management to `pnpm`, then records any installed package that exports a `dsh.bundle` layer. Install `pnpm` only for this management command; launching the installed SDK does not need it. Edit `$DSH_HOME/profiles/sdk-minimal/cordis.patch.yml` for persistent row changes, or pass patch files from Python for per-launch changes.

Another `profile` is valid when it includes `@deepseek-ai/dsh-sdk-app` or another JSON-RPC server row. Missing server rows, unresolved plugins, and invalid patches fail during startup instead of falling back to another composition.

<a id="opt-in-to-str_replace_editor"></a>
### Opt in to `str_replace_editor`

The bundled runtime includes `str_replace_editor`, but `sdk-minimal` omits it from the default Cordis tree. To use it, save this configuration as `editor.patch.yml`; `insert` adds both the editor and the filesystem provider that the minimal profile lacks:

```yaml
- insert:
    - id: fs-local
      name: '@deepseek-ai/dsh-fs-local'
      config:
        cwd: !!js process.cwd()
    - id: tool-str-replace-editor
      name: '@deepseek-ai/dsh-tool-str-replace-editor'
```

Pass `patches=("/absolute/path/to/editor.patch.yml",)` when constructing `DeepSeekHarness(profile="sdk-minimal", ...)`, or put the patch in `$DSH_HOME/profiles/sdk-minimal/cordis.patch.yml` for persistent configuration. On the next runtime launch, model requests include `str_replace_editor` beside the persistent shell. The local filesystem provider uses the runtime working directory for relative paths; like the minimal shell, it does not confine access to that directory. For the standard `sdk` profile, insert only the editor row so it uses the existing filesystem provider and policies.

## Understand the minimal profile

| Property | Value |
|---|---|
| System prompt | `DSH_SYSTEM_PROMPT`, falling back to `You are a helpful software engineer assistant.` |
| Model in `minimal.py` | `--model`, then `DSH_MODEL`, then `deepseek-v4-flash` |
| Model-facing tool | Persistent `bash` on Linux/macOS or `pwsh` on Windows |
| Shell timeout | 300 seconds |
| Runtime context and compaction | Absent |
| Session persistence | Uncompressed JSONL under `<dsh_home>/sessions` |

The profile's sole bundle inserts the complete tree over an empty root and does not include `dsh-base`; later base-profile tools therefore cannot appear implicitly. It contains the SDK protocol, one environment-configured DeepSeek adapter, local execution, and persistence, while filesystem tools, settings, managed credentials, telemetry, Web tools, subagents, local instruction discovery, and compaction are absent. It pins `danger-full-access`, so the platform-selected persistent shell can modify any path visible to the runtime; use a disposable checkout or container.

The installed wheel still packages the full `web` profile and frontend assets. Run `dsh web` against an explicit `DSH_HOME` when a Python SDK deployment also needs the browser application; `web` is a separate CLI application and cannot serve a Python SDK client.

Use a fresh home when profiles, plugins, credentials, settings, and sessions must be isolated. Use a fresh session id for independent work; reuse a harness, home, and id only to continue the same durable conversation and session-owned resources.

The [bundle reference](../../../packages/bundle/sdk-minimal/README.md) owns the exact tree, and the [example reference](../../../python/sdk/examples/README.md) owns the runnable program. The [Python SDK reference](../../../python/sdk/README.md) covers lifecycle, results, notifications, and low-level behavior; the [dsh CLI reference](../../../apps/cli/reference/README.md) covers profile layering.
