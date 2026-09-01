---
description: "Free-text session feedback through a `/feedback` command, for users and maintainers choosing, composing, or debugging feedback capture."
kind: "package-reference"
---

# @deepseek-ai/dsh-command-feedback

English | [中文](README.zh.md)

## Summary

`dsh-command-feedback` lets a user tell the harness what they think of a session: type `/feedback` plus a remark, and the remark is recorded and acknowledged. Recording is immediate and never starts model work, so it is safe at any point in a conversation — the model neither sees the remark nor is interrupted by it. The acknowledgement names the session and the anonymous user, and reports how the session is shared under the deployment's telemetry policy. The command ships with the Web client and needs no configuration; headless, ACP, and JSON-RPC entry points do not provide slash commands and cannot run it.

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

Users can record feedback from the Web client out of the box: the `/feedback` command ships with the standard `dsh` base, needs no configuration, and works in any conversation. A custom app gets the same command by mounting the command registry and this plugin together.

### The `/feedback` command

Type `/feedback` followed by your remark and send it. A successful entry is acknowledged with the receiving session id, the anonymous user id, and the session-sharing policy:

| Input | Result |
|---|---|
| `/feedback the diff view is unreadable` | Record the remark and acknowledge: `Feedback recorded for session {sessionId}`, `Anonymous user: {userId}`, plus the sharing disclosure. |
| `/feedback` | A usage error: `Feedback text is required. Usage: /feedback <text>`. Whitespace-only input counts as empty. |

Surrounding whitespace is trimmed, but the remark is otherwise kept exactly as typed: no truncation, case folding, or command parsing — `/feedback /plan felt slow` records that literal text. Each command records its own entry; nothing is merged or replaced.

### The sharing disclosure

The acknowledgement also states how the session is shared under the deployment's telemetry policy:

| Disclosed status | Acknowledgement sentence |
|---|---|
| `full` | `Session sharing is enabled.` |
| `feedback-only` | `Session sharing is feedback-gated; recording feedback uploads the session records not yet shared.` |
| `disabled` | `Session sharing is disabled.` |
| no telemetry service | `Session sharing is not configured.` |

The sentence reports the current policy only; it never claims the feedback or the session was delivered anywhere. The disclosure records nothing itself and never reaches the model.

### Recording feedback from your own UI

Feedback does not have to come from the slash command: any UI, hook, or host integration can record a remark directly, with the same guarantees and without a model turn. A custom app that wants the slash command mounts the command registry plus this plugin:

```yaml
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

The remark is one append-only fact in the session log, owned by the event rather than by the command that produced it: feedback can arrive from any trigger, so the fact must not depend on the slash command. The command keeps its own bookkeeping payload-free, so the remark text exists in exactly one place in the log, and the event never surfaces to the model. The sharing disclosure reads the optional telemetry service through the plugin context, so the command still works when no backend is mounted, and its sentence set mirrors the telemetry status union so an unknown status fails closed.

### How a remark is recorded

The producer trims the text, rejects empty input, and writes one event into the session log; the `/feedback` handler is a thin wrapper over that same producer and starts no model work. The write is eager but not flushed: the acknowledgement means the entry reached the log, not the disk. The first accepted remark for a harness home also mints the anonymous user id the acknowledgement reports. The exact producer contract and event payload live in [`src/index.ts`](src/index.ts).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `feedback/record` event declaration, `recordFeedback` producer, `/feedback` command registration |
| — | No runtime invariant companion is published; each `feedback/record` is an independent append-only fact with no cross-event or mutable-data relationship. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the sharing policy and command registry behind this capture path to the persistence and identity facts the acknowledgement relies on.

- [Session telemetry subsystem](../../../docs/subsystems/session-telemetry.md) — the `SessionTelemetrySharingStatus` vocabulary and backend contract behind the disclosure.
- [dsh-session-telemetry](../../session/session-telemetry/README.md) — the seam whose `sharing` member drives the acknowledgement sentence.
- [dsh-commands](../../interaction/commands/README.md) — the registry that discovers the global command and its `recordInput` semantics.
- [Session persistence subsystem](../../../docs/subsystems/persistence.md) — how appended events become durable and what a flush barrier means.
- [Anonymous user identity](../../identity/anonymous-user-id/README.md) — the id the acknowledgement reports.
- [Feedback package map](../README.md) — where log-only capture sits next to per-message feedback.

-----

<a id="model-experience"></a>
## Model Experience

### Human `/feedback` capture

#### What the model sees

Nothing. The slash input, `feedback/record`, and the acknowledgement are absent from model requests. The feedback event and registry lifecycle records are log-only and carry no `surfaceOp`, so they never reach the ordered surface, `deriveMessages()`, or a system prompt. Recording feedback during a turn does not change that turn's remaining requests.

#### Token effect

Zero direct token effect. Neither an accepted entry nor a usage error adds model tokens, in the recording turn or any later one.

#### KV Cache effect

Independent of the model request path. Recording appends to the session log only, leaving an already-reusable request prefix untouched. Nothing this package contributes can invalidate cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where `/feedback` is a poor fit or behaves differently than a user might expect. They are current package constraints, not a task backlog.

- **No feedback retrieval or management surface** — the optional OTel plugin uses the event only as a sharing trigger. There is no retrieval, aggregation, categorization, or model-facing tool for `feedback/record`.
- **No structured fields** — an entry is one free-text string with no category, severity, or referenced-event link, so feedback cannot be filtered by subject without re-reading its text.
- **No amend or withdraw** — the session log is append-only and this package adds no tombstone, so a mistaken entry stays recorded and can only be superseded by a later one.
- **No explicit durability barrier** — the acknowledgement follows the append, not a flush, so an entry recorded immediately before a crash can be lost with any other unflushed tail. A consumer that needs a barrier awaits `ctx.sessions.flush(session)`.
- **No visible acknowledgement on a fresh session** — the web transcript renders command rows only once a session is active, so `/feedback` on a still-blank session records the event but shows no acknowledgement row. Recording feedback after the first message renders normally.
- **Web only among the shipped entry points** — headless mode, ACP automation, and JSON-RPC provide no command adapter, so `/feedback` is unavailable there.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers; it is explicitly non-authoritative. Shipped behavior, limits, and rationale live in the sections above and the package code.

- The acknowledgement sentences are pinned by [`tests/command-feedback.spec.ts`](tests/command-feedback.spec.ts); changing them changes user-visible copy and the disclosure tests.
- Structured fields and a retrieval surface remain the open direction behind the first two limitations; nothing in the current contract reserves a format for them.

</details>
