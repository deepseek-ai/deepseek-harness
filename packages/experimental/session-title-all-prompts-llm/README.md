---
description: "All-messages LLM session-title provider for users and maintainers choosing a title strategy or debugging automatic title generation."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-title-all-prompts-llm

English | [中文](README.zh.md)

## Summary

`dsh-session-title-all-prompts-llm` summarizes every eligible human message through `ctx.llm` as an optional `ctx.sessionTitle` provider. It registers the `all-prompts` cadence and starts a new revision after each new human prompt, using seeded history and child-session prompts. A newer revision aborts and supersedes older work, and even a provider that ignores cancellation cannot commit stale output. It owns both its initial-generation prompt and its revision prompt, and shares only the [execution module](../../session/session-title-llm/README.md) from `dsh-session-title-llm` with the first-prompt provider. Automatic behavior and configuration come first; the implementation is a small provider strategy over that executor.

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

Mount this plugin beside the title service when a session should be retitled as it grows, so the title keeps representing the whole conversation. It requires its own `targetWords` and `targetCjkCharacters` plus the shared [execution controls](../../session/session-title-llm/README.md#configuration), all with no defaults.

### When titles are generated

A new revision starts after each new eligible human prompt, including prompts in child sessions; the generation folds all eligible messages through the current revision, seeded history included. A newer revision aborts and supersedes older work, so a stale completion can never commit. An automatic failure — including input over `maxInputBytes`, which fails instead of truncating history — warns and keeps the prior title; `ctx.sessionTitle.refresh()` is the explicit retry.

Once a provider-generated title exists, each request includes it and asks the model to preserve it exactly while it still describes the main topic or task. Follow-up questions, same-topic details, acknowledgements such as “thanks”, and requests to continue do not by themselves justify rewording. The model is instructed to update the title only when a material change or expansion of the main topic or task makes it inaccurate. A fallback title still receives ordinary initial generation; every eligible prompt still schedules a revision.

### Configuration

The plugin requires `targetWords` and `targetCjkCharacters` plus the shared [execution controls](../../session/session-title-llm/README.md#configuration): `maxInputBytes`, `maxOutputTokens`, `timeoutMs`, and the optional paired `provider`/`model` route. Omit both to inherit the exact route from each current logged main request, or set both to route title generation independently. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-session-title-all-prompts-llm) is the exhaustive source for every accepted field.

### Failures and recovery

If the final framed aggregate prompt exceeds `maxInputBytes`, the request fails instead of truncating history; automatic use warns and keeps the prior title, and only an explicit `refresh()` retries. Automatic work adds no tokens and no latency to the main agent request.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the plugin's shape; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

A small provider strategy: it owns both the initial-generation prompt and the revision prompt that anchors `currentTitle`, parses the assembled response into a title, and delegates only route, bounds, cancellation, logging, and assembly to the [shared execution module](../../session/session-title-llm/README.md).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, initial and revision prompts, output parsing, and direct provider registration |

### Scheduling

The title service schedules automatic work: for the `all-prompts` cadence, every new eligible user message starts a revision, and a newer revision supersedes older work; the provider call begins after the exact main-request route is logged.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the provider contract is not enough. They move from the shared execution module to the alternative cadence and the service it plugs into.

- [Shared LLM execution module](../../session/session-title-llm/README.md) — the execution module this provider uses.
- [First-message title provider](../../session/session-title-first-prompt-llm/README.md) — the cadence that titles a session once from its first prompt.
- [Session title service](../../session/session-title/README.md) — fallback behavior, rename, refresh, and provider registration.
- [Session package map](../../session/README.md) — adjacent persistence, projection, title, and telemetry packages.

-----

<a id="model-experience"></a>
## Model Experience

### All-messages title request

#### What the model sees

The title model receives all eligible human messages through the current revision, in log order with exact seqs, including seeded history. When an accepted provider-generated title exists, this provider adds it as `currentTitle` with its own preservation instructions; fallback, user, and absent titles take its initial-generation path. Both the messages and the current title count toward `maxInputBytes`.

#### Token effect

One auxiliary request may follow every new eligible prompt, bounded per request by `maxInputBytes` and `maxOutputTokens`; explicit refreshes may add calls. It selects the route's least supported reasoning effort, or leaves effort unspecified when the route exposes none. The main agent request gains zero tokens.

#### KV Cache effect

No main-request invalidation. Auxiliary input grows or changes after each prompt, so provider-specific cache reuse ends at the first changed JSON token.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define how the provider treats long and heterogeneous sessions. They are current package constraints.

- **No summarization-of-summaries** — input overflow retains the prior title; this provider has no summarization-of-summaries or retention policy for very long sessions.
- **Messages are treated equally** — it includes every eligible human message without configurable weighting or filtering.
- **Model-dependent stability** — title preservation is a model instruction, not a deterministic semantic check; the model may still change an adequate title.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
