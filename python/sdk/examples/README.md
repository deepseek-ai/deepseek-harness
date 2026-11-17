# Python SDK example

English | [中文](README.zh.md)

Runnable Python SDK examples over the sole application launcher, `dsh`. The Python client owns JSON-RPC stdio; the selected profile owns the agent composition, persistence, execution policy, and plugins.

## Run the minimal agent

Install `deepseek-harness-sdk`, export a model credential, then supply an isolated Harness home and workspace:

```sh
export DEEPSEEK_API_KEY=sk-your-key-here
python python/sdk/examples/minimal.py \
  --dsh-home /absolute/path/to/example-dsh-home \
  --workspace /absolute/path/to/disposable-workspace \
  --session-id example-001 \
  "Inspect the repository and fix the failing tests."
```

Set `DEEPSEEK_BASE_URL` for a compatible proxy, `DSH_MODEL` for the script's default model, or `DSH_SYSTEM_PROMPT` for the deployment persona. `--model` is the single runtime model selection; no matching environment variable is required. `--profile` can select another SDK-serving profile. The selected home stores the generated `sdk-minimal` profile and uncompressed JSONL session logs under `sessions/`; the script never reads `~/.dsh` implicitly.

The shipped [`@deepseek-ai/dsh-sdk-minimal` bundle](../../../packages/bundle/sdk-minimal/README.md) is the complete explicit Cordis tree for this mode. It exposes exactly:

- owner-scoped persistent `bash` on Linux/macOS or `pwsh` on Windows
- `read_image` for PNG/JPEG/WebP/GIF files, with an image-capable model
- `working_directory` to inspect or change the Session directory

The bundle does not include `dsh-base`, so every additional row is an explicit profile change. Runtime context, text file tools, local instruction discovery, settings, managed credentials, telemetry, Web tools, subagents, and the full default tool roster are absent. The tree retains SDK startup and JSON-RPC serving, one environment-configured DeepSeek adapter, local execution, and JSONL persistence. [Automatic context compaction](../../../packages/bundle/sdk-minimal/README.md#model-experience) summarizes older history through an additional model request while preserving the complete log. This minimal composition leaves unsupported slash input on the ordinary prompt path.

The persistent PTY can modify any path available to the runtime process, so use a disposable checkout or container.

<a id="compact-a-full-sdk-session"></a>
## Compact a full SDK Session

The [compaction example](compact.py) uses the full `sdk` profile. It reads `README.md` from the selected workspace into a `Session.run()` prompt, executes `/compact` through the same method, then asks a follow-up using the retained context. It uses the same model credentials and `DSH_MODEL` default as the minimal example, and requires an explicit home:

```sh
python python/sdk/examples/compact.py \
  --dsh-home /absolute/path/to/compact-dsh-home \
  --workspace /absolute/path/to/disposable-workspace
```

The script prints `RunResult.final_response` for prompts and commands. An unsuccessful `finish_reason` stops the example. See [Run text and commands](../README.md#run-text-and-commands) for completion and error behavior; `minimal.py` uses the same `run()` entry, with capabilities supplied by its selected profile.

<a id="change-session-permissions"></a>
## Change Session permissions

The [permission example](permission.py) starts the full `sdk` profile with a `workspace-write` default, sends `/permission <preset>`, then runs ordinary text on the same Session. Supply the preset explicitly:

```sh
python python/sdk/examples/permission.py \
  --dsh-home /absolute/path/to/permission-dsh-home \
  --workspace /absolute/path/to/disposable-workspace \
  --preset read-only
```

The command changes the Session's policy while the printed launch setting remains `workspace-write`. The later input uses the Session's current policy. Bare `/permission` is ordinary text, and unknown presets produce a command error. See [Run text and commands](../README.md#run-text-and-commands) for result and state semantics.

<a id="review-a-plan"></a>
## Review a plan

The [plan example](plan.py) sends `/plan <task>` through `run()` and keeps the Session notification subscription and question handler alive within that call until plan activity finishes. Enter `a` to approve, `k` to give feedback, or `d` to dismiss; cancellation or EOF before an answer dismisses the review. Approval allows implementation from a later model step, so choose an isolated workspace.

```sh
python python/sdk/examples/plan.py \
  --dsh-home /absolute/path/to/plan-dsh-home \
  --workspace /absolute/path/to/disposable-workspace \
  "Plan the requested change and present it for review."
```

The native plan is carried in `exit_plan_mode`, not written to a workspace document. Permissions remain workspace-write. Dismissal leaves plan mode active and ends the current turn. The example waits through `run()` and rejects truncated or failed root turns; its question callback is independent of the protocol reader. Ctrl+C stops the example even while it is waiting for input.

Piped answers use the parent process's stdin encoding and leave later lines for subsequent questions. UTF-16 and UTF-32 input requires an explicit little-endian or big-endian encoding. Truncated characters at EOF are reported as input errors.

<a id="run-a-goal"></a>
## Run a goal

The [goal example](goal.py) submits `/goal <objective>`, prints goal changes and assistant replies, and waits for the final reply after a terminal goal event. It uses the full SDK profile and workspace-write permissions.

```sh
python python/sdk/examples/goal.py \
  --dsh-home /absolute/path/to/goal-dsh-home \
  --workspace /absolute/path/to/disposable-workspace \
  "Calculate 17 * 19, verify the result, and complete the goal without changing files."
```

`--timeout-seconds` requires a finite positive value and bounds the initial command wait and subsequent observation (300 seconds by default). A timeout reports failure and closes the runtime; it does not mark the goal complete. The persisted goal can be inspected after restoration and explicitly resumed. `run()` includes the automatic rounds and final reply.

## Manage full-profile plugins with approvals

[`manage_plugins.py`](manage_plugins.py) explicitly downloads the optional authoring runtime, then starts the full `sdk` profile with `workspace-write` permissions and stdio approvals. It displays each requested operation and requires `y` to grant it once; any other answer rejects it. The prepared Node/pnpm runs package operations even without system pnpm. Downloading this payload also prepares its Python libraries and Office skills.

```sh
python python/sdk/examples/manage_plugins.py \
  --dsh-home /absolute/path/to/example-dsh-home \
  --workspace /absolute/path/to/disposable-workspace \
  "Install and enable the bundle at /absolute/path/to/my-plugin-bundle."
```

The current process keeps its original plugins. After a `restart-required` result, rerun the example with the same home to use the saved configuration. Removing a bundle still used by the running startup composition requires stopping that runtime and using `dsh plugin`.

## Add plugins

Use the runtime wheel's `dsh` command against the same explicit home for persistent profile changes:

```sh
export DSH_HOME=/absolute/path/to/example-dsh-home
dsh plugin --profile sdk-minimal add file:/absolute/path/to/my-plugin-bundle
```

Use `sdk-minimal` in that command to extend this example, or `sdk` to extend the full base-backed SDK profile. The Python call can also pass additional absolute patch paths in `patches=(...)`; later files win. A selected profile must retain `@deepseek-ai/dsh-sdk-app` or another JSON-RPC server row. The example accepts no complete Cordis file or arbitrary process argv.

The same runtime wheel packages the `web` profile and its frontend assets for direct CLI use: `dsh web` starts that separate application. A Python SDK client cannot select `web` because it has no JSON-RPC server row.

See the [Python SDK tutorial](../../../docs/user/guide/python-sdk.md) and [SDK reference](../README.md).
