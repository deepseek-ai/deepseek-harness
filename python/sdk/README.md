# DeepSeek Harness Python SDK

English | [中文](README.zh.md)

Python subprocess SDK for driving DeepSeek Harness over newline-delimited JSON-RPC on stdio. Install `deepseek-harness-sdk`; it installs the exact same-version `deepseek-harness-runtime-bin` wheel for the current platform.

```sh
python -m pip install deepseek-harness-sdk
```

## Start a runtime

The Python SDK has no separate application entrypoint. It launches the bundled `dsh` CLI with `--profile sdk`; the selected profile owns the JSON-RPC server, agent composition, credentials, persistence, tools, and shutdown behavior.

Every launch requires an explicit Harness home. Pass `dsh_home` or provide a non-empty `DSH_HOME` in the child environment. The SDK deliberately never discovers `~/.dsh`.

```py
from deepseek_harness import DeepSeekHarness

with DeepSeekHarness(
    dsh_home="/absolute/path/to/isolated-dsh-home",
    cwd="/absolute/path/to/workspace",
    provider="deepseek-official",
    model="deepseek-v4-flash",
    reasoning_effort="max",
    max_tokens=49_152,
) as harness:
    result = harness.run("Say hi.", session_id="example-001")

print(result.final_response)
```

`DeepSeekHarness` starts lazily and reuses its runtime until `close()` or context-manager exit. The initial profile handshake has an independent 30-second default bound through `initialize_timeout_seconds`; ordinary turns remain unbounded unless `request_timeout_seconds` is set. A timeout names the selected profile and includes retained runtime diagnostics. `cwd` is the agent workspace; `runtime_cwd` independently selects the subprocess working directory. Both become absolute before launch. `provider`, `model`, optional `reasoning_effort`, and optional positive `max_tokens` are sent during JSON-RPC initialization. `base_url` and `api_key` explicitly override `DEEPSEEK_BASE_URL` and `DEEPSEEK_API_KEY` in the child environment.

## Customize plugins

Persistent customization belongs to a `dsh` profile. Initialize the shipped SDK profile and install an external bundle with the runtime wheel's `dsh` command:

```sh
export DSH_HOME=/absolute/path/to/isolated-dsh-home
dsh --profile sdk --dump-default-config >/dev/null
dsh plugin --profile sdk add file:/absolute/path/to/my-plugin-bundle
```

The `file:` form installs the local bundle into the profile package tree, where its peer imports reach the bundled installation fallback. The profile manifest records installed dependencies and ordered bundle layers; its `$DSH_HOME/profiles/sdk/cordis.patch.yml` is the persistent user patch. `dsh plugin` needs `pnpm` only when managing external packages. Running the SDK does not require system Node.js.

For an invocation-specific change, pass one or more patch files. They become absolute and are forwarded in order after the profile and home patch layers:

```py
with DeepSeekHarness(
    dsh_home="/absolute/path/to/isolated-dsh-home",
    profile="sdk",
    patches=("/absolute/path/to/first.patch.yml", "/absolute/path/to/last.patch.yml"),
) as harness:
    result = harness.run("Make the requested code change.")
```

`profile` may select another existing profile, but that composition must retain `@deepseek-ai/dsh-sdk-app` or another `@deepseek-ai/dsh-sdk-jsonrpc-server` row. Misconfiguration fails during CLI boot or SDK initialization; there is no complete-config fallback. `dsh_bin` may select another `dsh` executable while preserving the same profile grammar. Arbitrary argv replacement remains an internal fake-runtime test adapter, not public API.

`provider` selects a provider route registered by the chosen Cordis composition; `model` is the model id resolved by that adapter. `reasoning_effort` is an optional non-empty adapter-owned identifier for that exact route; omission preserves the model's own default. `max_tokens` is an optional positive per-request output-token cap for the root agent and its in-process descendants; omission leaves the provider default in control. Initialization rejects a missing adapter, unavailable model, or unsupported effort before a prompt runs. Compaction summaries keep the separate limit configured by their compaction plugin. The bundled default composition registers `deepseek-official`. A custom composition can mount `llm-pi-ai`, configure provider-specific credentials/endpoints there, and select any provider/model present in pi-ai's installed catalog.

The shipped `sdk-minimal` profile is a standalone explicit tree rather than an overlay on `dsh-base`. Select it with `profile="sdk-minimal"`; the ordinary `model` argument is the sole runtime model selection, including for model ids outside the adapter's advisory catalog. It provides only a platform-selected persistent shell, local execution, and JSONL sessions; filesystem tools, settings, managed credentials, telemetry, Web tools, and the full default tool roster remain available through the separate full `sdk` and `web` profiles.

## Results and notifications

`Session.run()` owns an activity interval from its prompt's durable inbox receipt through the next whole-agent idle and returns `RunResult(session_id, final_response, finish_reason, events, notifications)`. `final_response` is the last committed root-session assistant text in the interval. `finish_reason` is the `kind` of the last root-session `turn/end`, such as `completed`, `max-tokens`, or `error`, and is `None` when no turn ended. A `turn/end` without a string `data.reason.kind` violates the protocol and raises `SdkProtocolError`.

`HarnessClient` retains discovered subagent ancestry for the runtime process lifetime. During `Session.run()`, `RunResult.notifications` and `on_notification` receive the root session and known descendants in wire order. `RunResult.events` contains root-session events only, so descendant output cannot replace the root response. The low-level `session_prompt()` returns the queued message id immediately; callers that bypass `Session.run()` own the later activity boundary.

The selected home stores profiles, plugins, and every profile-owned durable resource. The full `sdk` profile uses its credentials, settings, and session stores; `sdk-minimal` uses only its JSONL session store. Use a fresh home when those resources must be isolated, and a fresh session id for independent work. Reusing both a harness and session id continues the durable conversation and session-owned resources.

See the [Python tutorial](../../docs/user/guide/python-sdk.md), [runnable example](examples/README.md), and [runtime wheel reference](../sdk-runtime/README.md).
