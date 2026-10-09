---
description: "Shared model-execution policy for session-title providers: route, bounds, cancellation, request logging, and stream assembly."
kind: "package-library"
---

# @deepseek-ai/dsh-session-title-llm

English | [中文](README.zh.md)

## Summary

`dsh-session-title-llm` executes one prepared auxiliary title request under consistent execution controls. Each provider supplies its own system instruction, user input, source-message attribution, reasoning selection, and output interpretation. This package resolves the route, caps the input, output, and end-to-end duration, keeps caller cancellation effective throughout streaming, records the exact model-visible request, and assembles the stream. Invalid or late operational results reject before a title can be replaced.

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

As a deployment, configure this policy through the [first-prompt](../session-title-first-prompt-llm/README.md) or [all-prompts](../../experimental/session-title-all-prompts-llm/README.md) provider plugin. As a provider author, build your own prepared input and execute it through the shared function.

### Executing a provider request

A provider plugin registers directly on `ctx.sessionTitle` and, inside its `generate(request)`, passes `{ system, input, messageSeqs, selectReasoningEffort }` to `executeSessionTitleLlm`. The provider owns the system instruction, input framing, its reasoning selection, and output interpretation; the function owns route preparation, bounds, cancellation, request logging, and stream assembly. A second registration on the service throws.

Every request carries `currentTitle`, the latest accepted title snapshot the service captured for the call, including an accepted fallback. A provider decides whether to use it: the all-prompts provider anchors only a provider-sourced title, including one inherited from a different provider, and treats fallback, user, and absent titles as initial generation. The first-prompt provider ignores `currentTitle`.

### Route and failure contract

`provider` and `model` overrides are optional but must be supplied together as non-empty strings. Without that pair, the function uses the exact provider/model route captured from the current session's logged `request/header`, so an explicit refresh before any route exists needs overrides. It measures the final prepared user input against `maxInputBytes` before logging or dispatch instead of truncating it, and rechecks timeout and caller cancellation while consuming the stream and after it completes, so a late successful result cannot be accepted even if an interceptor or adapter ignores abort. It records the exact request in `session/title-llm-request` and returns the assembled content blocks plus the terminal finish and the used model identity. Operational errors, aborts, and unsupported finish reasons reject; `stop`, `tool-calls`, and `max-tokens` return to the provider for its own acceptance decision. The title request uses `maxOutputTokens` independently of the conversation's cap. Its route must have a registered adapter so preparation can resolve the request before it is recorded.

### Configuration

<a id="configuration"></a>

Every execution field is required except the paired route override; there are no library defaults. Each provider adds its own title-length target settings, which that provider's README documents.

| Key | Default | Meaning |
|---|---|---|
| `maxInputBytes` | required | UTF-8 byte ceiling for the prepared user input |
| `maxOutputTokens` | required | Title output-token cap, independent of conversation requests |
| `timeoutMs` | required | End-to-end deadline within the runtime timer limit |
| `provider`, `model` | optional | Explicit route; both or neither |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the generation path; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

One small shared execution policy so operational behavior cannot drift: execution-control validation, route resolution, budget enforcement, cancellation, request logging, and stream assembly live here. Prompt wording, title-length targets, reasoning selection, and output interpretation stay with each provider.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config schema and validation, route resolution, request bounds, dispatch, logging, and stream assembly |

### Request flow

The caller builds the prepared input and frames it; the function checks the complete input against `maxInputBytes`. The provider's reasoning selector chooses at most one effort during `ctx.llm.prepareCall()`. The function records the exact input, output cap, and resolved effort in `session/title-llm-request`, then dispatches through the same captured adapter generation under the shared deadline. `purpose: 'session-title'` supplies attribution only. The request has no agent-loop identity and does not enter conversation history. Generation failures preserve the request record.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the generation policy is not enough. They move from the service it plugs into to the provider plugins that consume it.

- [Session title service](../session-title/README.md) — the title service, fallback behavior, and provider registration contract.
- [Session title subsystem](../../../docs/subsystems/session-title.md) — durable title state and the auxiliary request record.
- [First-message title provider](../session-title-first-prompt-llm/README.md) — titles from the first eligible human message.
- [All-messages title provider](../../experimental/session-title-all-prompts-llm/README.md) — titles from every eligible human message.
- [Session package map](../README.md) — adjacent persistence, projection, title, and telemetry packages.

-----

<a id="model-experience"></a>
## Model Experience

### Auxiliary title request

#### What the model sees

The title model receives the provider-owned system instruction and one user message containing the provider-owned input. The executor records and dispatches those exact values without reconstruction; the framing and the output instruction belong to each provider, which the [first-prompt](../session-title-first-prompt-llm/README.md) and [all-prompts](../../experimental/session-title-all-prompts-llm/README.md) READMEs document.

#### Token effect

The auxiliary request consumes tokens according to the provider-prepared input size and `maxOutputTokens`. It is separate from the main agent request and does not add title text or framing to agent history. The executor applies the provider's selected reasoning effort, or the route's normal default when the selector returns `undefined`; a model that still reasons spends part of `maxOutputTokens` on it. The main conversation retains its configured thinking mode.

#### KV Cache effect

No main-request invalidation. Auxiliary cache reuse is provider-specific: this executor dispatches the provider's exact system prompt and input, so reuse depends on how each provider frames successive revisions.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the accepted generation shapes. They are current package constraints.

- **Provider-interpreted output** — the executor returns assembled content blocks and the terminal finish and does not accept or reject them; each shipped provider's README owns its acceptance policy.
- **Whole-input byte ceiling** — it rejects prepared input over `maxInputBytes` rather than truncating it.
- **Reasoning is provider-selected** — the executor applies the effort the provider returns and never chooses one; when the selector returns `undefined`, the route's normal default applies.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
