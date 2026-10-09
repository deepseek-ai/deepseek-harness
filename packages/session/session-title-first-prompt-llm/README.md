---
description: "First-message LLM session-title provider for users and maintainers choosing a title strategy or debugging automatic title generation."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-title-first-prompt-llm

English | [中文](README.zh.md)

## Summary

`dsh-session-title-first-prompt-llm` summarizes the first eligible human message through `ctx.llm` as an optional `ctx.sessionTitle` provider. It registers the `first-prompt` cadence, runs automatically only when a fresh non-fork session first creates its fallback, and attributes the result to that message's exact seq. An automatic failure retains the fallback and is retried only through `ctx.sessionTitle.refresh()`. The plugin owns its system instruction, JSON framing, and output parsing; it shares only the [execution module](../session-title-llm/README.md) from `dsh-session-title-llm` with the all-prompts provider. Automatic behavior and configuration come first; the implementation is a small provider strategy over that executor.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin beside the title service when a session should be titled from its first eligible human message. It requires its own `targetWords` and `targetCjkCharacters` plus the shared [execution controls](../session-title-llm/README.md#configuration), all with no defaults.

### When titles are generated

Automatic generation runs only for a fresh session with no parent and no prior title: after its first eligible human message, the fallback is created and one auxiliary request summarizes that message. Later prompts, explicit user renames, and inherited fork history do not trigger another automatic call. An automatic failure keeps the fallback; `ctx.sessionTitle.refresh()` is the explicit retry. Forks keep their inherited title and never run this provider automatically, even when their seeded first message came from the parent.

### Configuration

The plugin requires `targetWords` and `targetCjkCharacters` plus the shared [execution controls](../session-title-llm/README.md#configuration): `maxInputBytes`, `maxOutputTokens`, `timeoutMs`, and the optional paired `provider`/`model` route. Omit both to inherit the exact route from the current logged main request, or set both to route title generation independently. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-session-title-first-prompt-llm) is the exhaustive source for every accepted field.

### Failures and recovery

A generation that fails — a missing route before any main request, input over `maxInputBytes`, timeout, cancellation, or invalid model output — warns and keeps the current title; only an explicit `refresh()` retries. Automatic work adds no tokens and no latency to the main agent request.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the plugin's shape; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

A small provider strategy: it builds the first-message system instruction and JSON input, parses the assembled response into a title, and delegates only route, bounds, cancellation, logging, and assembly to the [shared execution module](../session-title-llm/README.md).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, first-message prompt and framing, output parsing, and direct provider registration |

### Scheduling

The title service schedules automatic work: for the `first-prompt` cadence it starts a revision only when the session has no parent, holds exactly one eligible message, and has no title yet; the provider call begins after the exact main-request route is logged, and a newer revision supersedes older work.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the provider contract is not enough. They move from the shared execution module to the alternative cadence and the service it plugs into.

- [Shared LLM execution module](../session-title-llm/README.md) — the execution module this provider uses.
- [All-messages title provider](../../experimental/session-title-all-prompts-llm/README.md) — the cadence that retitles after every new prompt.
- [Session title service](../session-title/README.md) — fallback behavior, rename, refresh, and provider registration.
- [Session package map](../README.md) — adjacent persistence, projection, title, and telemetry packages.

-----

<a id="model-experience"></a>
## Model Experience

### First-message title request

#### What the model sees

The title model receives this provider's title instruction and a JSON array containing only the first eligible human message; it never receives a `currentTitle`. Later prompts and inherited fork history do not trigger another automatic call.

#### Token effect

At most one automatic auxiliary request is made for a fresh session, bounded by `maxInputBytes` and `maxOutputTokens`; explicit refreshes may make additional calls. It selects the route's least supported reasoning effort, or leaves effort unspecified when the route exposes none. The main agent request gains zero tokens.

#### KV Cache effect

No main-request invalidation. The auxiliary request uses the configured or logged route and has provider-specific cache behavior.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this provider stops representing the session. They are current package constraints.

- **First message may go stale** — the first message alone may cease to represent a long-running session; use the all-messages provider when later prompts should retitle it.
- **Forks never retitle automatically** — a fork keeps its inherited title and never runs this provider automatically, even when its seeded first message came from the parent.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
