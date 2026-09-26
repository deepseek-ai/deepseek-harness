---
description: "Web ask_user_question feature for the dsh web client: the composer-takeover question UI and the plan-review approval card."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-user-questions

English | [中文](README.zh.md)

## Summary

When an agent asks a question in the Web client, this package replaces the chat composer with an interactive question surface. Users can move through questions, choose one or multiple options, enter custom answers, skip items, and submit one structured answer batch. Single-choice selections advance immediately, while drafts survive Session navigation for the lifetime of the page. A single question with a supported presentation intent can use a dedicated surface, including the plan-review card with `Request changes` and `Approve` actions.

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

When the agent asks a question, the composer becomes the question surface: answer each question, navigate with the pager, or skip it. Single-select choices advance immediately; Enter continues the flow and submits once every question is answered or skipped, while Shift+Enter breaks a line instead (during IME composition Enter only confirms the input candidate without advancing).

### Answering

A multi-select draft keeps its selected labels while the user opens or edits the custom answer, so its submitted item may carry both `selected` and `custom`; a single-select custom answer remains exclusive. Question detail reuses the assistant-output `MarkdownText` primitive, including its GFM rendering and untrusted-content policy. The capped card keeps its title, navigation, and submission actions fixed while long detail and choices share an internal scroll region. "Skip" retains other drafts and emits the existing blank `{ selected: [] }` result for that item, while close rejects the whole wait as `ASK_CANCELLED`.

### The plan-review card

A `plan-review` intent — set by `dsh-plan-mode` on the `exit_plan_mode` review — renders a compact approval card: a `Plan review` strip with a `View full plan` link, the plan title and a two-line plain-text summary, and `Request changes` / `Approve` actions. The strip uses the shared warning dot and changes it to the ongoing loader while either action settles. The complete plan opens in the sidebar through the link or its permanent Chat card. Approve answers with the asker's approval label; `Request changes` rejects the wait as `ASK_CANCELLED`, returning the composer for the user's feedback without submitting an approval. The card has no separate refusal button.

### Failure and recovery

The generic question flow keeps its current page, selected labels, custom text, and explicit skips in a non-persisted Slot store scoped to the owning Session generation and keyed by the pending request's local render identity. Switching from Session A to B retires A when no other reference owns it, so returning to A starts an empty question draft; another reference that keeps A's generation alive also keeps that draft. A different request identity reads an empty draft and replaces the previous value on its first edit; a successful answer or cancellation clears the matching value. The host remains authoritative for whether the request is pending.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package is one ownership rule: rendering a question is a host UI capability, having the tool is an agent capability, so the `tool-ask-user` row belongs to the presets that want it (and to the TUI composition, which has no presets).

### Intent surface election

The card accepts one question declaring the intent, carrying the plan as `detail`, and offering the named approve label, with at most one alternative and no multi-select. Its secondary action returns to the composer for change requests. Larger choices and multi-select questions remain in the generic flow.

### Copy and locale

Composer chrome copy (pager, buttons, placeholders, validation feedback) is bilingual: the plugin registers zh/en dictionaries under the `question` namespace of `dsh-client-locale` and hands the entry its bound translator plus the locale snapshot source through the inject face, so a locale switch re-renders a mounted composer. Question and option text arrives from the model and renders verbatim; carrier failure messages also display untranslated.

A plan review exposes `conversation.plan-review.actions` with its request key, full text, and optional invocation identity. The plan plugin opens logged plans from history and unlogged reviews as temporary sidebar previews. Opening a document does not answer or dismiss the review.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the composer host, the tool seam, and the plan-mode consumer.

- [ui-conversation](../ui-conversation/README.md) — the chat surface owning the `conversation.composer` chain.
- [tool-ask-user](../../interaction/tool-ask-user/README.md) — the model-facing tool whose schema and answers this UI renders.
- [ui-plan](../ui-plan/README.md) — the plan-mode surface that sets the `plan-review` intent.
- [user-questions](../../interaction/user-questions/README.md) — the Host-side question seam and its answerer waterfall.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-ask-user`, whose model-visible schema and answer rendering this package presents in the Web client.

#### KV Cache effect

No direct invalidation; `dsh-tool-ask-user` owns the model-visible tool call and result.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define draft durability and composer ownership; they are current package constraints.

- **Unsubmitted drafts have page-and-Session lifetime** — Session navigation preserves them while that Session scope remains in the page, but a full page reload, Session pruning, or a newly delivered pending-request identity starts with an empty draft. The store never writes them to the Host, `localStorage`, or disk.
- **One request owns the composer at a time** — later pending requests remain in the session snapshot and become visible after the earlier request resolves.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Tool and slot registrations are effects owned and observed by their respective registries; the host pending table is exercised through the public wire protocol.
