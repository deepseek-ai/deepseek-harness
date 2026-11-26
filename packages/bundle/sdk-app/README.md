---
description: "SDK stdio application profile for users and maintainers launching a JSON-RPC harness runtime."
kind: "package-bundle"
---

# `@deepseek-ai/dsh-sdk-app`

English | [中文](README.zh.md)

## Summary

The SDK stdio application as a `dsh` profile bundle over [`dsh-base`](../base/README.md). It inherits the base's disabled module-HMR policy; its patch mounts an app-owned zero-option command provider, and starts [`dsh-sdk-jsonrpc-server`](../../sdk/server/README.md) only after that provider accepts the invocation. `dsh --profile sdk --help` therefore writes help and exits without claiming stdin or stdout. The standalone [`sdk-minimal`](../sdk-minimal/README.md) bundle reuses the same startup provider with its own profile name.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The `sdk` profile includes native desktop tools and model context. Native tool execution is the default. For PTC, pass the [PTC root overlay](../../../apps/cli/config/examples/ptc.yml) through `--patch` or the `patches` option in the TypeScript or Python SDK. `DSH_TOOLS_MODE` is ignored.

The startup provider binds stdin EOF to the launcher's bounded successful shutdown. SDK protocol `shutdown`, SIGINT, and SIGTERM retain their owning server or launcher paths; disposal drains the root profile tree and persistence. Stdout is reserved for newline-delimited JSON-RPC frames. The bundle disables model-generated session titles because the SDK exposes no title surface; deterministic fallback titles remain durable without an auxiliary model request. The inherited projection cache checkpoints SDK-created sessions for later consumers; its durability barrier flushes each covered log prefix before publishing the cache row and may split otherwise coalesced JSONL runs. A deployment selects a different complete composition through profile bundles and patch files, not another app bin.

| Config | Default | Behavior |
|---|---|---|
| `profile` | `sdk` | Profile name rendered in command help; a bundle mounting this provider sets its own shipped profile name. |

`DSH_MAX_TOKENS_AS_SUCCESS` retains the SDK deployment mapping: unset or JSON `true` reports token-limited subagent completion as accepted, while JSON `false` reports it as an error. Provider/model and workspace cwd arrive through the SDK initialization request; the base profile owns adapters, tools, persistence, policy, settings, and credentials.

The SDK uses the base `read`, `write`, and `edit` defaults. To add `str_replace_editor`, use the explicit insertion patch in the [base configuration guide](../base/README.md#use-this-package). The standalone `sdk-minimal` profile owns its separate tool selection.

The model can use [`plugin_manager`](../../boot/plugin-manager/README.md) in native and PTC modes. Every action, including listing, requires full access or approval for that call. The default workspace-write/ask policy needs a client approval responder: enable `approvalRequests` and handle `approval/request` through `harness.client.onRequest()`, or supply an approver in the composition. Without one, the operation is refused as unavailable. For Python package installation/removal, explicitly prepare Node and pnpm with `download_primary_runtime()` before starting the runtime; the packaged launcher then supplies them to plugin management without requiring system pnpm. Without a selected payload, package operations need `pnpm` on `PATH` or an explicit `plugin-manager.pnpmCommand`. See the [interactive approval example](../../../python/sdk/examples/manage_plugins.py). Saved profile changes report `restart-required` with `no-hmr`; the current runtime and its sessions retain their tools until the caller closes and starts the runtime again. Set `tool-plugin-manager.disabled: true` through a profile patch to hide this tool. The standalone `sdk-minimal` profile does not include it.

The Python runtime exposes explicitly downloaded authoring resources and Office sidecars to this profile. `DSH_PRIMARY_RUNTIME` overrides the authoring payload; an empty value disables its query. Office skills, the Office kit, and the [Office tools](../../document/tool-document/README.md) always load. The skills use their packaged assets; with an authoring payload they direct the model to its bundled Python environment, and without one to the user's existing Python. The tool reports an unavailable LibreOffice Kit until an Office sidecar is downloaded or selected. Profile patches can disable `skill-office` or replace its `assetRoot` independently of `workspace-dependencies`; filesystem skills with the same name take precedence. See the [runtime package](../../../python/sdk-runtime/README.md) for downloads and configuration.

The standard SDK profile lists `official-plugins` and `personalized-pages` by default. A proposal reaches the caller as a fenced `action-card` block in the final response. For training, pass a YAML patch containing `- {id: action-cards, config: {enabled: false}}` to omit both skills from the catalog and prevent loading them by name.

The profile mounts [`dsh-mcp-manager`](../../mcp/mcp-manager/README.md) as the `mcp-manager` row with the same configuration as Desktop. Configure its `servers` in the SDK profile patch, the home patch `$DSH_HOME/cordis.patch.yml`, or a `patches` file; Desktop Settings writes the Desktop profile patch, which the SDK does not read. Installed plugins, such as the Linear connector, register their servers with the same manager. OAuth servers connect with grants saved in the same DSH home, for example after authorizing them in Desktop. The profile omits the Plugins page account row `mcp-account`, because the SDK serves no browser.

-----

<a id="model-experience"></a>
## Model Experience

### SDK model context

#### What the model sees

The profile inherits the base system prompt, including the `You are an AI agent powered by DeepSeek Harness.` identity, and adds the same model-interpolated coding persona as the Web and headless profiles. Each Session receives its current directory in required user-role context from [`dsh-working-directory`](../../session/working-directory/README.md). Default file tool schemas include `read`, `write`, and `edit`; they omit `str_replace_editor`. The model also receives `present`, `ask_user_question`, `plugin_manager`, `cordis_inspect`, schedule tools, shared file-reference guidance, and time context. `cordis_inspect` reads Host runtime APIs as the Desktop standard and Creator presets do; its directory lists no Client providers because the SDK serves no browser. Child agents cannot use schedule tools. The [`time-context`](../../context/time-context/README.md) row accepts a fallback time zone. Each ordinary prompt reports its zone like a Web prompt: the client's `timeZone` (`time_zone` in Python) when given, otherwise the runtime process zone sampled for that prompt, so the model sees `Browser time zone for this request: <zone>. Interpret otherwise-unqualified dates and times in this zone.` A process zone that is not UTC or an IANA Area/Location name, such as the `+00:00` that `TZ=GMT` produces, reports `unavailable`. The skill catalog always lists the Office skills; their Python environment section names `load_workspace_dependencies` with an authoring payload and the user's existing Python without one. The catalog also lists `dsh-doc`, the DSH documentation skill that the Desktop standard, PTC, and Creator presets list; see the [Web app](../web-app/README.md#model-experience) for what it guides. Servers that the `mcp-manager` row configures or installed plugins register add their `mcp__<server>__<tool>` tools, their instructions, and their names in the MCP resource server list; the default profile configures none.

#### Token effect

The profile adds a coding-persona sentence, the mounted tool definitions and guidance, and logged runtime-context and time messages. The `plugin_manager` description and parameter schema add input tokens even when an operation cannot be approved; an embedding that does not use plugin management can disable its row. The `cordis_inspect` schema adds one tool definition; query results enter the transcript only when the model calls it. The `dsh-doc` catalog entry adds about 125 heuristic tokens to the first request; its instructions and references enter context only when the model loads the skill. Each managed MCP server adds its tool definitions and instructions.

#### KV Cache effect

Enabling `plugin_manager` changes the tool-schema prefix from earlier SDK versions, and the `dsh-doc` entry changes the skill catalog logged at the first step. The static prefix is stable for a fixed profile, provider, model, and tool roster. Runtime values append to logged user context. Profile changes take effect on the next process because the shipped SDK profile uses startup-only patches. A managed MCP server changes the tool-schema prefix when its tools join or leave the tool list.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No graphical client** — file cards, native file opening, and browser state require an embedding client; the SDK starts no Web server.
- **The process zone stands in for the user** — a prompt without `timeZone` reports the runtime process zone, which may differ from the user's; containers usually run in UTC. Pass the user's zone per prompt or set `TZ` for the runtime. The `time-context.timeZone` setting only controls fallback timestamp formatting; it does not establish the user's time zone. Native commands record no zone, matching Web commands, so a turn opened by `/plan <message>` reports `unavailable`.
- **Questions require an answerer** — configure `onUserQuestion` in TypeScript or `on_user_question` in Python, or supply a native `user-questions/request` handler; otherwise `ask_user_question` returns `NO_PROVIDER`.
- **Schedules share the runtime lifetime** — delivery needs a running process and its persistent Session storage.
- **A profile can omit the SDK server** — a custom profile selected by the TypeScript client must retain this bundle or another `dsh-sdk-jsonrpc-server` row; client initialization fails when no peer answers.
- **User plugins can violate stdout purity** — profile and per-launch patches are trusted application composition. The shipped bundle writes no non-protocol stdout, but it cannot contain an arbitrary inserted plugin.
- **Plugin changes share a profile** — saved changes affect `<DSH_HOME>/profiles/sdk` and other embeddings using that home on their next launch; use separate `dshHome` directories for independent compositions. The Python launcher uses Node/pnpm from its selected downloaded runtime; without that payload or an external pnpm, package operations fail.
- **Configuration changes require restart** — the `sdk-app` bundle disables HMR in YAML so one stdio connection never observes a replacement server or Agent dependency.
- **MCP servers can miss the first prompt** — the profile sets `sdk-jsonrpc-server.startupWaitMs` to 5000, so `initialize` waits at most 5 seconds for managed servers in their first connection attempt; a profile patch can change it, and `0` skips the wait. A server still connecting after that, or added later, joins the tool list when it connects, so earlier requests reach the model without its tools.
- **No OAuth authorization in the SDK** — starting an authorization requires a Web server; authorize the server in Desktop with the same DSH home, or configure a header template instead.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The [SDK/Desktop model context comparison](../../../apps/cli/tests/profiles/sdk/desktop-tools.expected.e2e.ts) and the [agent row comparison](../../../apps/cli/tests/profiles/sdk/agent-config-parity.expected.e2e.ts) run without API credentials in `test:expected`, included in the required PR consumer job. Both compare this profile with native tool execution against the Desktop `standard` agent preset; PTC execution is not compared. The first compares the first model request of the top-level Agent, with Team off and on: tool names and schemas, system prompt sections, runtime context values, the session skill catalog and the other injected messages, and the order of the prompt sections, runtime context entries, injected messages and tools, after replacing test paths and clock readings and running both sides in UTC. The second compares each `--dump-config` row of this profile with the preset row of the same id, or else with the Desktop host row of that id, and reports an enabled row neither has; it covers rows whose effect a default turn does not show, such as the plan mode section. After building, run `CI=true pnpm run test:expected apps/cli/tests/profiles/sdk/`. Record each accepted difference in the adjacent `parity-exceptions.ts` with a reason; an inconsistency left unfixed also names its tracking issue in `debt`. A fix makes its exception stale, so the fixing change removes it. Existing SDK session snapshots and installed-runtime smokes independently check model output and packaging.

</details>
