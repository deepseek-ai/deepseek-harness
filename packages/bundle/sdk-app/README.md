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

The startup provider binds stdin EOF to the launcher's bounded successful shutdown. SDK protocol `shutdown`, SIGINT, and SIGTERM retain their owning server or launcher paths; disposal drains the root profile tree and persistence. Stdout is reserved for newline-delimited JSON-RPC frames. The bundle disables model-generated session titles because the SDK exposes no title surface; deterministic fallback titles remain durable without an auxiliary model request. The inherited projection cache checkpoints SDK-created sessions for later consumers; its durability barrier flushes each covered log prefix before publishing the cache row and may split otherwise coalesced JSONL runs. A deployment selects a different complete composition through profile bundles and patch files, not another app bin.

| Config | Default | Behavior |
|---|---|---|
| `profile` | `sdk` | Profile name rendered in command help; a bundle mounting this provider sets its own shipped profile name. |

`DSH_MAX_TOKENS_AS_SUCCESS` retains the SDK deployment mapping: unset or JSON `true` reports token-limited subagent completion as accepted, while JSON `false` reports it as an error. Provider/model and workspace cwd arrive through the SDK initialization request; the base profile owns adapters, tools, persistence, policy, settings, and credentials.

The SDK uses the base `read`, `write`, and `edit` defaults. To add `str_replace_editor`, use the explicit insertion patch in the [base configuration guide](../base/README.md#use-this-package). The standalone `sdk-minimal` profile owns its separate tool selection.

The packaged Python runtime enables the [Office runtime query and skills](../../skill/tool-workspace-dependencies/README.md#use-this-package) by default. `DSH_PRIMARY_RUNTIME` overrides its bundled payload; an empty value disables both rows. Source launches without a carrier default remain opt-in. The tool reads the payload in place. Profile patches can disable `skill-office` or replace its `assetRoot` independently of `workspace-dependencies`; filesystem skills with the same name take precedence over bundled skills. See the [runtime package](../../../python/sdk-runtime/README.md) for packaging and configuration.

-----

<a id="model-experience"></a>
## Model Experience

### SDK model context

#### What the model sees

The profile inherits the base system prompt, including the `You are an AI agent powered by DeepSeek Harness.` identity, without adding a task-specific persona. Each Session receives its current directory in required user-role context from [`dsh-working-directory`](../../session/working-directory/README.md). Default file tool schemas include `read`, `write`, and `edit`; they omit `str_replace_editor`.

#### Token effect

The base prompt sections and selected tool schemas determine token usage; this profile adds no persona text.

#### KV Cache effect

Stable for a fixed profile, provider, model, and tool roster. Profile changes take effect on the next process because the shipped SDK profile uses startup-only patches.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **A profile can omit the SDK server** — a custom profile selected by the TypeScript client must retain this bundle or another `dsh-sdk-jsonrpc-server` row; client initialization fails when no peer answers.
- **User plugins can violate stdout purity** — profile and per-launch patches are trusted application composition. The shipped bundle writes no non-protocol stdout, but it cannot contain an arbitrary inserted plugin.
- **Configuration changes require restart** — the `sdk-app` bundle disables HMR in YAML so one stdio connection never observes a replacement server or Agent dependency.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
