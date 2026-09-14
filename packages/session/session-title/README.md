---
description: "Log-backed session titles for users and maintainers choosing a title source, configuring the service, or debugging title state."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-title

English | [中文](README.zh.md)

## Summary

Use `dsh-session-title` to give each session a client-visible title from the first eligible human message, an optional asynchronous generator, or an explicit user rename. Accepted titles persist through replay, resume, and paging but never enter model input. Automatic generation never delays the main agent response, and newer title requests supersede older work. Choose the package when clients need durable titles with configurable length limits and a deliberate `refresh()` path for regenerating them.

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

Mount the service to give sessions titles that clients can display and that never reach the model. The common path is explicit: load the session store, mount the service with its required limits, and optionally mount one provider plugin.

### Choosing a title source

Titles come from three sources, newest wins. The built-in fallback derives from the first eligible human message's leading words within the configured caps; a registered provider generates a title over eligible messages; an explicit `rename()` accepts a user-supplied title. Only text blocks from human `user/message` events are eligible, and empty or non-text prompts wait for later eligible input. A user-sourced latest title pins the session — later user messages schedule no automatic revision, and an explicit `refresh()` remains the deliberate unpin.

### Minimal configuration

All limits are required; the library supplies no defaults. Mount the service with the three bounds:

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-title'
  config:
    fallbackMaxWords: 8
    fallbackMaxBytes: 96
    maxTitleBytes: 120
```

| Field | Default | Meaning |
|---|---|---|
| `fallbackMaxWords` | required | Maximum whitespace-delimited words in the deterministic fallback |
| `fallbackMaxBytes` | required | Maximum UTF-8 bytes in the fallback; must not exceed `maxTitleBytes` |
| `maxTitleBytes` | required | Maximum UTF-8 bytes accepted from any source |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-session-title) is the exhaustive source for every accepted field and its JSDoc.

### Adding a provider

One optional asynchronous provider may be registered through `ctx.sessionTitle.register(provider)`; a second registration throws. The shipped model-backed providers are [first-prompt](../session-title-first-prompt-llm/README.md) and [all-prompts](../session-title-all-prompts-llm/README.md), both using the shared [LLM generation policy](../session-title-llm/README.md). A provider starts only after a marked loop-built request's exact route matches the logged `request/header`, and a newer revision supersedes and aborts older work.

### Reading titles

`get(session)` reads the latest folded title from one live or replayed session, and `foldSessionTitle(events)` is the pure fold over a log. The service requires `ctx.sessionProjections` and registers two units: the client-visible `title` unit (the accepted title string for client list rows) and the host-only `titleInput` unit, which folds the first and latest eligible messages plus their count so scheduling and fallback reads are O(1) through `stateOf()`; the full eligible prefix for one provider generation is scanned from the session log at execution time. An explicit `refresh(session)` materializes the fallback when needed, then explicitly runs the registered provider over the current eligible messages.

### Failures and recovery

Automatic failures warn and retain the latest title; explicit `refresh()` rejects on provider error or caller cancellation, and cancellation does not roll back an already accepted fallback event. Automatic work never delays the main agent response, its late completion appends a standalone log-only event without opening a turn, and a stale completion cannot append. Forks inherit title events in their seed unchanged.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the title design; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

Titles are durable, log-only state: every accepted revision is a `session/title` event, and `foldSessionTitle()` selects the latest, so a title survives replay, resume, and paging exactly like any other session event. The service owns scheduling, supersession, and acceptance; providers own generation.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service: config, fold, fallback scheduling, provider registry, concurrency, `title` projection unit |
| [`src/normalize.ts`](src/normalize.ts) | Title-text cleaning, UTF-8-safe truncation, and the deterministic fallback |
| [`src/types.ts`](src/types.ts) | One home of the `title` projection-key declaration |

### Lifecycle and concurrency

Per-session work state tracks a revision counter, an in-flight fallback, and pending and active provider work. A newer user message, provider disposal, session disposal, or explicit refresh aborts older work through an `AbortController`; a completion whose provider, revision, session, or signal is stale cannot append. Explicit refreshes reserve their revision before provider work; overlapping automatic and explicit fallback requests share one session-local in-flight append. Service teardown cancels queued work and drains calls that ignore cancellation before unloading completes.

### Normalization

Accepted titles are cleaned of terminal control sequences, directional and invisible controls, and non-whitespace C0/C1 controls; whitespace is normalized, and truncation to the byte caps never splits a Unicode code point. The deterministic fallback takes the first eligible message's leading words within `fallbackMaxWords` and `fallbackMaxBytes`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the service contract is not enough. They move from the subsystem reference to the model-backed providers that plug in here.

- [Session title subsystem](../../../docs/subsystems/session-title.md) — durable title state and the provider vocabulary types.
- [Shared LLM title policy](../session-title-llm/README.md) — the model-backed generation helper both shipped providers use.
- [First-message title provider](../session-title-first-prompt-llm/README.md) — titles from the first eligible human message.
- [All-messages title provider](../session-title-all-prompts-llm/README.md) — titles from every eligible human message.
- [Session package map](../README.md) — adjacent persistence, projection, title, and telemetry packages.

-----

<a id="model-experience"></a>
## Model Experience

### Session title state

#### What the model sees

Nothing. `session/title` is log-only and never enters the session surface, `deriveMessages()`, system prompt, tool schemas, or request prefix.

#### Token effect

The fallback and accepted provider revisions add zero tokens to the main agent request. An optional provider's separate auxiliary request is documented by that provider package.

#### KV Cache effect

None for the main request; title events do not change its reconstructed content or cache key.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the title service does not provide. They are current package constraints.

- **No title deletion, search, or list indexing** — unpinning back to automatic titles without an explicit `refresh`, search, and list indexing are outside this service.
- **At most one provider** — the registry deliberately accepts a single implementation, so a deployment cannot compose competing title strategies without writing one provider that owns their precedence.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
