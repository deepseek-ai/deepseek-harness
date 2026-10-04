---
description: "The model-facing ask_user_question tool over the user-questions seam, for users and maintainers composing or debugging interactive agent surfaces."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-ask-user

English | [中文](README.zh.md)

## Summary

`ask_user_question` asks the user for confirmation, a choice, or missing information. It waits for an answer by default. With `mode: timed`, a deadline can release the model to continue independent work while the question stays answerable; `timeout: -1` waits indefinitely. A live child agent cannot call the tool. Callers provide the answer UI.

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

Compose this plugin with `ctx.userQuestions` when the model needs a user decision. Without an answerer, blocking calls fail; finite timed calls return pending at their deadline.

Shipped presets use blocking mode. To enable timed mode, set `mode: timed` on the `tool-ask-user` row in the active preset's `config.plugins` list:

```yaml
- id: tool-ask-user
  name: '@deepseek-ai/dsh-tool-ask-user'
  config:
    mode: timed
    timeout: 120
```

This is a plugin row, not a top-level `--patch` entry. In the Web profile, change the `preset-standard` plugin list or use the Agent Preset editor. `mode: legacy` or omitted config keeps the blocking schema. The row's `timeout` applies to each timed call by default; `-1` waits indefinitely unless the model supplies a positive timeout. A model-supplied `-1` applies only to that call, including all its questions.

### When to call the tool

Send one or more questions with ids unique within the call; the answer echoes those ids. Put a recommended option first and append `(Recommended)` to its label. The optional per-call `timeout` is in seconds; use `-1` when work cannot safely continue without an answer. A timeout is never approval. In the Web card, editing or choosing Take time also holds that Client's wait until submission or cancellation.

```json
{
  "questions": [
    {
      "id": "cleanup",
      "question": "Proceed with the destructive cleanup?",
      "header": "Confirm",
      "options": [
        { "label": "Yes, delete them (Recommended)", "description": "Removes the three stale files." },
        { "label": "No, keep them", "description": "Aborts the cleanup." }
      ]
    }
  ]
}
```

### What the model gets back

An answer returns one item per question. `selected` holds option labels; `custom` supplements a multi-select answer or replaces a single-select choice. A skipped item has empty `selected` and no `custom`.

For a finite timed call, `{ "pending": true, "callId": "…" }` means the foreground wait ended without an answer. The question remains answerable, and the model may continue independent work. A later answer arrives as a user message identified by `kind`, `tool`, and `callId`. Web chat pairs its questions and answers; other consumers receive compact JSON text.

```json
{ "answers": [{ "id": "cleanup", "selected": ["Yes, delete them (Recommended)"] }] }
```

### When the call fails

Legacy and `timeout: -1` calls wait for an answer or cancellation; without an accepting answerer, they return an error. A finite timed call without an answerer returns pending at its deadline. Cancellation and a caller that is not the exact live runtime root also return errors. A live child agent is rejected with `DELEGATED_CALLER` and must include the unresolved decision in its final result.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The observable behavior is covered in [Use this package](#use-this-package); this section explains the tool definition and its relationship to the seam.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Default blocking tool definition and mode selection |
| [`src/timed.ts`](src/timed.ts) | Opt-in timed tool definition and result rendering |

### Consumer role

The plugin registers one tool definition. Legacy mode calls `ask()`; timed mode calls `askTimed()` for positive timeouts and `ask()` for `-1`. Both forward the calling agent and turn signal to `ctx.userQuestions`. Timed requests include the tool call id in `wait`, so a Client can reopen their card. The projection identifies timed native calls from the `timeout` field in the recorded tool schema, even when a call omits that argument.

### Result rendering

The `render` output projects the structured value to a single text block via `JSON.stringify`, which is why the model-facing result is compact JSON rather than a richer content-block vocabulary.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the tool surface to the seam contract and its answerer waterfall.

- [User interaction subsystem reference](../../../docs/subsystems/user-questions.md) — the service contract, question vocabulary, and answerer waterfall behind this tool.
- [Tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-ask-user) — the generated `ask_user_question` schema.
- [user-questions package](../user-questions/README.md) — the seam this tool consumes.
- [Interaction group map](../README.md) — adjacent approval and command surfaces.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The shipped presets expose the original blocking [`ask_user_question` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-ask-user). A custom Cordis row with `mode: timed` switches to the alternate schema, including question ids, prompts, headings, options, multi-select flags, `timeout`, and the pending result; the model sees only the selected definition.

#### Token effect

Fixed schema cost on every request where the tool is visible.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema.

### Tool-call history and result

#### What the model sees

The assistant tool call retains the questions. An answer during the wait appears in the next step as compact `{"answers":[{"id":"<id>","selected":["<label>"],"custom":"<text>"}]}` JSON; unused `custom` is omitted. A timed-out call returns `{"pending":true,"callId":"<pending-call-id>","message":"<instruction>"}`. A later answer arrives as a user message with `kind: "answer_to_pending_question"`, `tool: "ask_user_question"`, the call id, the original questions, and the answers. UI activity before submission is not model context.

#### Token effect

Arguments and answer JSON are data-dependent retained tokens; there is no token cost while waiting for the human.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the tool is a poor fit. They are current package constraints, not a UI backlog.

- **The legacy tool never reports pending** — it returns an answer or an error. Native legacy calls do not enter the `userQuestions` projection, and interrupted calls cannot take late answers.
- **An interrupted PTC wait may lose its question** — if the `run_code` process ends before an `ask_user_question` sub-call records its `tool/ptc-dispatch` result, the projection cannot reconstruct that sub-call for a late answer.
- **Runtime-owned subagents cannot ask the user** — `ask_user_question` rejects a live child owned by another agent with `DELEGATED_CALLER`; the child must include the unresolved question or decision in its final result. Durable lineage does not decide this boundary, so a lineage-bearing session resumed as a runtime root may ask normally.
- **Native answers render as JSON text** — the canonical value remains structured, but the model-facing result uses compact JSON rather than a richer content-block vocabulary.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The [`userQuestions` projection](../user-questions/src/projection.ts) reads each recorded tool schema rather than the call arguments: timed calls may omit `timeout`, and timed `-1` calls still use the timed schema. Changes to the projection fold require a `stateVersion` bump so stored caches refold from the log.

</details>
