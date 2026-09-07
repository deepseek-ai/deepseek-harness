---
description: "Automation-only ACP stdio application profile for users and maintainers launching persistent harness agents."
kind: "package-bundle"
---

# `@deepseek-ai/dsh-acp-app`

English | [中文](README.zh.md)

## Summary

The automation-only ACP stdio application as a `dsh` profile bundle over [`dsh-base`](../base/README.md). It inherits the base's disabled module-HMR policy; its patch sets the coding-agent persona and default model route, mounts an app-owned zero-option command provider, and starts [`dsh-acp`](../../acp/acp/README.md) only after that provider accepts the invocation. `dsh --profile acp --help` therefore writes help and exits without claiming stdin or stdout.

## Table of Contents

- [Use this package](#use-this-package)
- [Standard automation workflow](#standard-automation-workflow)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The startup provider binds stdin EOF to the launcher's bounded successful shutdown. ACP connection close, SIGINT, and SIGTERM drain the bridge-owned agents and the root profile tree before exit. Stdout is reserved for newline-delimited ACP JSON-RPC frames. The bundle disables model-generated session titles because ACP exposes no title surface; deterministic fallback titles remain durable without an auxiliary model request. The inherited projection cache checkpoints ACP-created sessions for later consumers; its durability barrier flushes each covered log prefix before publishing the cache row and may split otherwise coalesced JSONL runs. A deployment selects a different complete composition through profile bundles and patch files, not another app bin.

The shipped row creates sessions with `deepseek-official` and `deepseek-v4-flash`; a later patch can replace that row's complete config. The base profile owns adapters, tools, persistence, policy, settings, credentials, and the per-session workspace supplied by the ACP client.

-----

<a id="standard-automation-workflow"></a>
## Standard automation workflow

An ACP v1 SDK client initializes `dsh --profile acp`, creates a session with an absolute `cwd` and optional standard stdio/HTTP MCP declarations, chooses an advertised `model` or `reasoning_effort`, prompts while observing standard semantic updates, then calls `session/close`. Another process can use `session/list` and `session/resume` against the same profile persistence root; resume reconnects the MCP declarations supplied by that request and does not replay history.

The complete supported method matrix, MCP trust model, update mapping, and stop reasons live in the [`dsh-acp` protocol contract](../../acp/acp/README.md#standard-acp-v1-surface). This profile adds no private method, capability, `_meta`, environment variable, or transport field. The keyless control-surface conformance test drives the real profile through the public ACP SDK.

<a id="model-experience"></a>
## Model Experience

### ACP coding-agent persona

#### What the model sees

The profile supplies `You are a coding agent powered by the {{model}} model.` before first-party guidance and `Your working directory is {{cwd}}.` in a separate persona suffix. The ACP row's route and each `session/new` cwd resolve the placeholders.

#### Token effect

One short stable persona plus the data-dependent base prompt sections and selected tool schemas.

#### KV Cache effect

Stable for a fixed profile, provider, model, and tool roster. Profile changes take effect on the next process because the shipped ACP profile uses startup-only patches.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **A profile can omit the ACP bridge** — a custom ACP launch profile must retain this bundle or another `dsh-acp` row; otherwise no peer answers the client.
- **User plugins can violate stdout purity** — profile and per-launch patches are trusted application composition. The shipped bundle writes no non-protocol stdout, but it cannot contain an arbitrary inserted plugin.
- **Configuration changes require restart** — the shipped `acp` profile uses `patchReload: startup` so one stdio connection never observes a replacement bridge or Agent dependency.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The bundle adds a process transport and startup latch; source/built stdio tests own frame purity, help exclusion, and shutdown.
