---
description: "Session feedback: the `/feedback` command, the `sessionFeedback` Host Remote behind the Web feedback dialog, and the fixed category taxonomy; for users and maintainers choosing, composing, or debugging feedback capture."
kind: "package-reference"
---

# @deepseek-ai/dsh-command-feedback

English | [中文](README.zh.md)

## Summary

`dsh-command-feedback` lets a user tell the harness what they think of a session. Typing `/feedback` plus a remark records it and acknowledges the session and anonymous user ids; the Web feedback dialog records a category and an optional description through the `sessionFeedback` Host Remote. Recording is immediate and never starts model work: the model neither sees the remark nor is interrupted by it. The package also owns the fixed category taxonomy every feedback surface files under. It ships with the standard `dsh` base and needs no configuration; headless, ACP, and JSON-RPC entry points provide no slash commands.

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

Users can record feedback from the Web client out of the box: the `/feedback` command ships with the standard `dsh` base, needs no configuration, and works in any conversation. A custom app gets the same command by mounting the Session store, command registry, and this plugin together.

### The `/feedback` command

Type `/feedback` followed by your remark and send it. A successful entry is acknowledged with the receiving session id and the anonymous user id:

| Input | Result |
|---|---|
| `/feedback the diff view is unreadable` | Record the remark and acknowledge with two lines: `Feedback recorded for session {sessionId}` and `Anonymous user: {userId}.` |
| `/feedback` | A usage error: `Feedback text is required. Usage: /feedback <text>`. Whitespace-only input counts as empty. |

Surrounding whitespace is trimmed, but the remark is otherwise kept exactly as typed: no truncation, case folding, or command parsing — `/feedback /plan felt slow` records that literal text. Each command records its own entry; nothing is merged or replaced.

<a id="the-web-feedback-dialog"></a>
### The Web feedback dialog

In the Web client a bare `/feedback` — picked from the composer menu or typed and sent without text — opens the feedback dialog instead of the usage error. The dialog offers the seven categories below and a free-text box; every field is optional and an empty submission is accepted, and the conversation log travels with the recorded event as with every feedback event. It records through `sessionFeedback.record`, which appends the same `feedback/record` event without command bookkeeping and without an acknowledgement row; the dialog shows a toast instead.

| Category id | Meaning |
|---|---|
| `task-result` | The outcome of the task |
| `instruction-following` | Understanding and following instructions |
| `product-interaction` | Product features and interaction |
| `service-stability` | Stability and speed |
| `resource-cost` | Resource usage and cost |
| `security-privacy-permission` | Security, privacy, and permissions |
| `other` | Anything else |

The ids are durable log vocabulary shared with per-message feedback; each surface owns its localized labels.

### Recording feedback from your own UI

Feedback does not have to come from the slash command or the dialog: any UI, hook, or host integration can record a remark directly through `recordFeedback` or the `sessionFeedback` Remote, with the same guarantees and without a model turn. A custom app that wants the slash command mounts the Session store, the command registry, and this plugin; the Session store is what the `sessionFeedback` Remote resolves live Sessions from:

```yaml
- id: session
  name: '@deepseek-ai/dsh-session'
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: command-feedback
  name: '@deepseek-ai/dsh-command-feedback'
```

The Web client ships the command. Headless mode, ACP automation, and JSON-RPC provide no slash commands, so `/feedback` is unavailable there.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The remark is one append-only fact in the session log, owned by the event rather than by the trigger that produced it: feedback can arrive from the command, the dialog, or any integration, so the fact must not depend on the slash command. The command keeps its own bookkeeping payload-free, so the remark text exists in exactly one place in the log, and the event never surfaces to the model.

### How a remark is recorded

The producer trims the text, records blank text as absent, and writes one event into the session log even when the entry carries neither text nor category; the `/feedback` handler rejects empty input itself and is otherwise a thin wrapper over that same producer, and the `sessionFeedback.record` Remote resolves the live Session by id and calls it too, answering `session-not-found` when no live owner carries the id. Neither path starts model work. The write is eager but not flushed: the acknowledgement means the entry reached the log, not the disk. The first accepted command remark for a harness home also mints the anonymous user id the acknowledgement reports. The exact producer contract lives in [`src/index.ts`](src/index.ts); the event payload, the taxonomy, and the Remote vocabulary live in [`src/types.ts`](src/types.ts).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `recordFeedback` producer, the `sessionFeedback` Remote service, `/feedback` command registration |
| [`src/types.ts`](src/types.ts) | `feedback/record` event declaration, the category taxonomy, and the Remote request and result types |
| — | No runtime invariant companion is published; each `feedback/record` is an independent append-only fact with no cross-event or mutable-data relationship. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They cover the command registry, persistence, and identity facts this capture path relies on.

- [dsh-commands](../../interaction/commands/README.md) — the registry that discovers the global command and its `recordInput` semantics.
- [Session persistence subsystem](../../../docs/subsystems/persistence.md) — how appended events become durable and what a flush barrier means.
- [Anonymous user identity](../../identity/anonymous-user-id/README.md) — the id the acknowledgement reports.
- [ui-message-feedback](../../client/ui-message-feedback/README.md) — the Web feedback dialog that records through the `sessionFeedback` Remote.
- [Feedback package map](../README.md) — where log-only capture sits next to per-message feedback.

-----

<a id="model-experience"></a>
## Model Experience

### Human `/feedback` capture

#### What the model sees

Nothing. The slash input, the dialog, `feedback/record`, and the acknowledgement are absent from model requests. The feedback event and registry lifecycle records are log-only and carry no `surfaceOp`, so they never reach the ordered surface, `deriveMessages()`, or a system prompt. Recording feedback during a turn does not change that turn's remaining requests.

#### Token effect

Zero direct token effect. Neither an accepted entry nor a usage error adds model tokens, in the recording turn or any later one.

#### KV Cache effect

Independent of the model request path. Recording appends to the session log only, leaving an already-reusable request prefix untouched. Nothing this package contributes can invalidate cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where session feedback is a poor fit or behaves differently than a user might expect. They are current package constraints, not a task backlog.

- **No feedback retrieval or management surface** — there is no retrieval, aggregation, or model-facing tool for `feedback/record`.
- **Category and text only** — an entry carries at most one category and one free-text string, with no severity or referenced-event link.
- **Live Sessions only through the Remote** — `sessionFeedback.record` answers `session-not-found` for a Session no live owner carries; the Web dialog reports that failure when its Session retires while it is open.
- **No amend or withdraw** — the session log is append-only and this package adds no tombstone, so a mistaken entry stays recorded and can only be superseded by a later one.
- **No explicit durability barrier** — the acknowledgement follows the append, not a flush, so an entry recorded immediately before a crash can be lost with any other unflushed tail. A consumer that needs a barrier awaits `ctx.sessions.flush(session)`.
- **No visible acknowledgement on a fresh session** — the web transcript renders command rows only once a session is active, so a typed `/feedback <text>` on a still-blank session records the event but shows no acknowledgement row; the dialog's toast does not depend on the transcript.
- **Web only among the shipped entry points** — headless mode, ACP automation, and JSON-RPC provide no command adapter, so `/feedback` is unavailable there.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers; it is explicitly non-authoritative. Shipped behavior, limits, and rationale live in the sections above and the package code.

- The acknowledgement sentences and the category order are pinned by [`tests/command-feedback.spec.ts`](tests/command-feedback.spec.ts); changing them changes user-visible copy.
- A retrieval surface remains the open direction behind the first limitation; nothing in the current contract reserves a format for it.

</details>
