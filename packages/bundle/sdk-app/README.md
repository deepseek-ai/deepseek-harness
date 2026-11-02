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

The `sdk` profile includes native desktop tools and model context. Native tool execution is the default. For PTC, pass the [executor overlay](../../../apps/cli/config/examples/ptc.yml) through `--patch` or the `patches` option in the TypeScript or Python SDK. `DSH_TOOLS_MODE` is ignored.

The startup provider binds stdin EOF to the launcher's bounded successful shutdown. SDK protocol `shutdown`, SIGINT, and SIGTERM retain their owning server or launcher paths; disposal drains the root profile tree and persistence. Stdout is reserved for newline-delimited JSON-RPC frames. The bundle disables model-generated session titles because the SDK exposes no title surface; deterministic fallback titles remain durable without an auxiliary model request. The inherited projection cache checkpoints SDK-created sessions for later consumers; its durability barrier flushes each covered log prefix before publishing the cache row and may split otherwise coalesced JSONL runs. A deployment selects a different complete composition through profile bundles and patch files, not another app bin.

| Config | Default | Behavior |
|---|---|---|
| `profile` | `sdk` | Profile name rendered in command help; a bundle mounting this provider sets its own shipped profile name. |

`DSH_MAX_TOKENS_AS_SUCCESS` retains the SDK deployment mapping: unset or JSON `true` reports token-limited subagent completion as accepted, while JSON `false` reports it as an error. Provider/model and workspace cwd arrive through the SDK initialization request; the base profile owns adapters, tools, persistence, policy, settings, and credentials.

The SDK uses the base `read`, `write`, and `edit` defaults. To add `str_replace_editor`, use the explicit insertion patch in the [base configuration guide](../base/README.md#use-this-package). The standalone `sdk-minimal` profile owns its separate tool selection.

The model can use [`plugin_manager`](../../boot/plugin-manager/README.md) in native and PTC modes. Every action, including listing, requires full access or approval for that call. The default workspace-write/ask policy needs a client approval responder: enable `approvalRequests` and handle `approval/request` through `harness.client.onRequest()`, or supply an approver in the composition. Without one, the operation is refused as unavailable. For Python package installation/removal, explicitly prepare Node and pnpm with `download_primary_runtime()` before starting the runtime; the packaged launcher then supplies them to plugin management without requiring system pnpm. Without a selected payload, package operations need `pnpm` on `PATH` or an explicit `plugin-manager.pnpmCommand`. See the [interactive approval example](../../../python/sdk/examples/manage_plugins.py). Saved profile changes report `restart-required` with `no-hmr`; the current runtime and its sessions retain their tools until the caller closes and starts the runtime again. Set `tool-plugin-manager.disabled: true` through a profile patch to hide this tool. The standalone `sdk-minimal` profile does not include it.

The Python runtime exposes explicitly downloaded authoring resources and Office sidecars to this profile. `DSH_PRIMARY_RUNTIME` overrides the authoring payload; an empty value disables its query. Office skills can use either resource independently. Profile patches can disable `skill-office` or replace its `assetRoot` independently of `workspace-dependencies`; filesystem skills with the same name take precedence. See the [runtime package](../../../python/sdk-runtime/README.md) for downloads and configuration.

-----

<a id="model-experience"></a>
## Model Experience

### SDK model context

#### What the model sees

The profile inherits the base system prompt, including the `You are an AI agent powered by DeepSeek Harness.` identity, and adds the same model-interpolated coding persona as the Web and headless profiles. Each Session receives its current directory in required user-role context from [`dsh-working-directory`](../../session/working-directory/README.md). Default file tool schemas include `read`, `write`, and `edit`; they omit `str_replace_editor`. The model also receives `present`, `ask_user_question`, `plugin_manager`, schedule tools, shared file-reference guidance, and time context. Child agents cannot use schedule tools. The [`time-context`](../../context/time-context/README.md) row accepts a fallback time zone. Skills use the configured resources described above.

#### Token effect

The profile adds a coding-persona sentence, the mounted tool definitions and guidance, and logged runtime-context and time messages. The `plugin_manager` description and parameter schema add input tokens even when an operation cannot be approved; an embedding that does not use plugin management can disable its row.

#### KV Cache effect

Enabling `plugin_manager` changes the tool-schema prefix from earlier SDK versions. The static prefix is stable for a fixed profile, provider, model, and tool roster. Runtime values append to logged user context. Profile changes take effect on the next process because the shipped SDK profile uses startup-only patches.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No graphical client** — file cards, native file opening, and browser state require an embedding client; the SDK starts no Web server.
- **User time zone is unknown** — the SDK protocol does not carry a user time zone, so time context reports `Browser time zone for this request: unavailable.` The process or container time zone may differ from the user's. The `time-context.timeZone` setting only controls fallback timestamp formatting; it does not establish the user's time zone. Automatic detection and SDK time-zone input are deferred.
- **Questions require an answerer** — configure `onUserQuestion` in TypeScript or `on_user_question` in Python, or supply a native `user-questions/request` handler; otherwise `ask_user_question` returns `NO_PROVIDER`.
- **Schedules share the runtime lifetime** — delivery needs a running process and its persistent Session storage.
- **A profile can omit the SDK server** — a custom profile selected by the TypeScript client must retain this bundle or another `dsh-sdk-jsonrpc-server` row; client initialization fails when no peer answers.
- **User plugins can violate stdout purity** — profile and per-launch patches are trusted application composition. The shipped bundle writes no non-protocol stdout, but it cannot contain an arbitrary inserted plugin.
- **Plugin changes share a profile** — saved changes affect `<DSH_HOME>/profiles/sdk` and other embeddings using that home on their next launch; use separate `dshHome` directories for independent compositions. The Python launcher uses Node/pnpm from its selected downloaded runtime; without that payload or an external pnpm, package operations fail.
- **Configuration changes require restart** — the `sdk-app` bundle disables HMR in YAML so one stdio connection never observes a replacement server or Agent dependency.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The [SDK/Desktop tool comparison](../../../apps/cli/tests/profiles/sdk/desktop-tools.expected.e2e.ts) runs without API credentials in `test:expected`, included in the required PR consumer job. It covers standard/PTC root sessions with Team disabled; Team parity is deferred to #7172. After building, run `CI=true pnpm run test:expected apps/cli/tests/profiles/sdk/desktop-tools.expected.e2e.ts`. Maintain exact, reasoned differences in the adjacent `tool-parity.ts`; resolved differences invalidate their exceptions. Existing SDK session snapshots and installed-runtime smokes independently check model output and packaging.

</details>
