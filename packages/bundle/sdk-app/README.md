---
description: "SDK stdio application profile for users and maintainers launching a JSON-RPC harness runtime."
kind: "package-bundle"
---

# `@deepseek-ai/dsh-sdk-app`

English | [中文](README.zh.md)

## Summary

The SDK stdio application as a `dsh` profile bundle over [`dsh-base`](../base/README.md). It inherits the base's disabled module-HMR policy; its patch sets the coding-agent persona, mounts an app-owned zero-option command provider, and starts [`dsh-sdk-jsonrpc-server`](../../sdk/server/README.md) only after that provider accepts the invocation. `dsh --profile sdk --help` therefore writes help and exits without claiming stdin or stdout. The standalone [`sdk-minimal`](../sdk-minimal/README.md) bundle reuses the same startup provider with its own profile name.

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

-----

<a id="model-experience"></a>
## Model Experience

### SDK coding-agent persona

#### What the model sees

The profile supplies `You are a coding agent powered by the {{model}} model.` before first-party guidance and `Your working directory is {{cwd}}.` in a separate persona suffix. The exact SDK initialization route and session cwd resolve the placeholders. Default file tool schemas include `read`, `write`, and `edit`; they omit `str_replace_editor`.

#### Token effect

One short stable persona plus the data-dependent base prompt sections and selected tool schemas.

#### KV Cache effect

Stable for a fixed profile, provider, model, and tool roster. Profile changes take effect on the next process because the shipped SDK profile uses startup-only patches.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **A profile can omit the SDK server** — a custom profile selected by the TypeScript client must retain this bundle or another `dsh-sdk-jsonrpc-server` row; client initialization fails when no peer answers.
- **User plugins can violate stdout purity** — profile and per-launch patches are trusted application composition. The shipped bundle writes no non-protocol stdout, but it cannot contain an arbitrary inserted plugin.
- **Configuration changes require restart** — the shipped `sdk` profile uses `patchReload: startup` so one stdio connection never observes a replacement server or Agent dependency.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The bundle adds a process transport and startup latch; source/built stdio tests own frame purity, help exclusion, and shutdown.
