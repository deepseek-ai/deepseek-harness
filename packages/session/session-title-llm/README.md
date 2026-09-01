---
description: "Shared model-backed title generation policy for users and maintainers configuring title providers or debugging auxiliary LLM requests."
kind: "package-library"
---

# @deepseek-ai/dsh-session-title-llm

English | [中文](README.zh.md)

## Summary

`dsh-session-title-llm` runs model-backed title generation through one shared policy: it resolves the auxiliary route, frames the exact selected human messages as JSON, enforces input and output budgets, composes timeout and caller cancellation, and validates the model's output before a title is accepted. It is a library, not a Cordis plugin — the shipped provider plugins call `registerSessionTitleLlmProvider()` with their cadence and message selector, and the helper validates shared config and delegates every revision to one generation path, so registration, route, prompt, cancellation, and validation behavior cannot drift between them. Deployments configure it through the provider plugins, which require every limit. The route, failure, and configuration contracts come first; the request internals live in a collapsible developer section below.

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

As a deployment, configure this policy through the [first-prompt](../session-title-first-prompt-llm/README.md) or [all-prompts](../session-title-all-prompts-llm/README.md) provider plugin. As a provider author, register through the shared helper instead of hand-rolling generation.

### Registering a provider

A provider plugin calls `registerSessionTitleLlmProvider(ctx, config, id, automatic, selectMessages)`; the helper validates the shared config, registers the provider on `ctx.sessionTitle`, and runs every generation through the shared policy. The two shipped plugins register the `first-prompt` and `all-prompts` cadences with their message selectors, and a second registration on the service throws.

### Route and failure contract

`provider` and `model` overrides are optional but must be supplied together as non-empty strings. Without that pair, the helper uses the exact provider/model route captured from the current session's logged `request/header`, so an explicit refresh before any route exists needs overrides. The helper measures the final JSON-framed user prompt against `maxInputBytes` before logging or dispatch instead of truncating it, and rechecks timeout and caller cancellation while consuming the stream and after it completes, so a late successful result cannot be accepted even if an interceptor or adapter ignores abort. Malformed or empty output, tool calls, and non-stop finish reasons reject; the session-title service decides whether that rejection is an automatic warning or an explicit caller failure.

### Configuration

<a id="configuration"></a>

Every field is required except the paired route override; there are no library defaults.

| Key | Default | Meaning |
|---|---|---|
| `targetWords` | required | Target word count for non-CJK titles |
| `targetCjkCharacters` | required | Target character count for Chinese, Japanese, or Korean titles |
| `maxInputBytes` | required | UTF-8 byte ceiling for the final JSON-framed user prompt |
| `maxOutputTokens` | required | Auxiliary generation token cap |
| `timeoutMs` | required | End-to-end deadline within the runtime timer limit |
| `provider`, `model` | optional | Explicit route; both or neither |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the generation path; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

One shared policy so provider plugins cannot drift: config validation, route resolution, prompt framing, budget enforcement, cancellation, and output validation all live here, parameterized only by the provider's cadence and message selector.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config schema and validation, provider registration helper, request framing, dispatch, and output validation |

### Request flow

A generation validates the config once at registration; each revision frames the selected messages as JSON, measures the framed prompt's UTF-8 bytes against `maxInputBytes`, resolves the route (the explicit pair or the logged `request/header`), appends a log-only `session/title-llm-request` event carrying the exact dispatchable request, then streams through `ctx.llm` under a composed timeout and cancellation deadline. The dispatched envelope carries `purpose: 'session-title'` and deliberately lacks the agent loop's process-local request identity; the DeepSeek adapter maps that purpose to thinking-disabled so the small output budget is reserved for visible title text, and other adapters own their purpose-specific behavior. Output assembles into text blocks only; tool calls, malformed or empty output, and non-stop finish reasons reject, and a later model failure leaves the request record intact.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the generation policy is not enough. They move from the service it plugs into to the provider plugins that consume it.

- [Session title service](../session-title/README.md) — the title service, fallback behavior, and provider registration contract.
- [Session title subsystem](../../../docs/subsystems/session-title.md) — durable title state and the auxiliary request record.
- [First-message title provider](../session-title-first-prompt-llm/README.md) — titles from the first eligible human message.
- [All-messages title provider](../session-title-all-prompts-llm/README.md) — titles from every eligible human message.
- [Session package map](../README.md) — adjacent persistence, projection, title, and telemetry packages.

-----

<a id="model-experience"></a>
## Model Experience

### Auxiliary title request

#### What the model sees

The title model receives a fixed system instruction to return one concise unadorned title in the input language, including the configured word and CJK-character targets. Its one user message contains a JSON array of the exact selected human messages and their seqs.

#### Token effect

The auxiliary request consumes tokens according to selected input size and `maxOutputTokens`. It is separate from the main agent request and does not add title text or framing to agent history. DeepSeek title calls disable thinking; the main conversation retains its configured thinking mode.

#### KV Cache effect

No main-request invalidation. Auxiliary cache reuse is provider-specific; the fixed instruction is reusable while the JSON message array changes with each revision.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the accepted generation shapes. They are current package constraints.

- **Text output only** — the helper accepts text output and rejects tool calls; structured-output adapters and provider-specific prompt variants are not exposed.
- **Whole-prompt byte ceiling** — it enforces a byte ceiling for the whole framed user prompt rather than clipping individual messages or applying a retention policy.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. This stateless helper validates and freezes each auxiliary request before dispatch; deadline, stream, cited message seqs, and provider/model fields are checked synchronously and by tests.
