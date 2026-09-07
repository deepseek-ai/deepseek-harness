# Agent Note: Web transcript marks context source, recall, and steering

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-04-web-context-source-and-steer-marks.zh.md)

## Problem

Everything a producer adds to the model-facing conversation reached the Web transcript as one of two anonymous shapes. Every logged non-user `user/message` — the skill catalog, the runtime snapshot, reconciled `AGENTS.md` instructions, a guard notice, a subagent report, a cross-session snapshot — collapsed into one identical `上下文注入` row, so a reader could not tell what had been added without expanding each row and reading raw JSON. Mid-turn steering was worse: it rendered in exactly the bubble a turn-opening prompt uses, leaving the transcript unable to say which message interrupted a running turn.

The distinctions are already durable. Every producer must supply a merge-extensible `user/message.source` that identifies itself, while `agent/inbox/spliced` records whether an identified message entered and left `next-turn` or `next-step`; only the presentation discarded them. The terminal transcript this Web UI replaced did name each card's producer, so the Web surface was a regression for the same log.

## Decision

The transcript names all three roles a non-prompt message can play — injected context, recalled session, and steering.

The Chat Message Definition attaches a `provenance` view containing the producer role and label to every `ContextMessageNode`; `contextProvenance()` computes it from the durable source alone. It returns a `role` (`inject`, or `recall` for a cross-session snapshot) and a `label` naming the producer. `ContextInjectionRow` titles itself from the role and shows the label beside that title in `ToolRow`'s summary geometry, so the collapsed row already answers what was added and by whom; the 141px scrollport and truncation bound are unchanged from the [archived disclosure decision](../../archived/feature/2026-07-30-web-context-injection-disclosure.md). What renders inside that scrollport is chosen by the independent form axis added in the [context form decision](2026-08-05-context-form-vocabulary.md).

**The label is read out of the log, never from a client-side table of producer names.** `agent-instructions` is named by the distinct instruction paths it reconciled, `session-reference` by the titles of the sessions it read, a plugin source by its logged plugin id, and any other source by its own `kind` — the documented default arm for a merge-extensible union. A source carrying no readable kind degrades to an unnamed injection. A new or renamed producer is therefore identifiable without a client release, no label can go stale against the code, and a resumed, forked, or foreign log projects exactly like a live session.

`recall` covers `session-reference` because that is the one shipped source that lifts another session's material into this one. No Web leaf mounts `dsh-session-reference` — it had only a terminal host — so the arm exists for log portability rather than for a bundled producer, and it is exercised by unit coverage rather than an assembled Web scenario.

`MessageItem` captions durable and pending steering bubbles with `插话`. The Chat Inbox and Message Definitions replay durable `agent/inbox/spliced` events and project a user-origin `user/message` as `SteeringMessageNode` when that same message identity was claimed from `next-step`; a queued-turn claim stays a `UserMessageNode`, and a non-user next-step message stays context. This reverses one clause of the [archived no-steer decision](../../archived/simplification/2026-07-31-web-ui-no-steer-entry-or-interjection-chrome.md), which removed the badge because the composer could not steer and the label named a gesture users could not perform. The composer gained a Steer gesture afterwards without amending that note; this decision supplies the product decision its reintroduction clause required, and corrects the stale facts left in it. The caption is the only steering chrome here: composer modes, the Queue dock's strict-steer action, and pending-steering lifecycle stay with their own owners.

## Alternatives considered

**Localize producer names in the client.** A dictionary keyed by plugin id would read better than `@deepseek-ai/dsh-system-prompt`, but it drifts silently on every rename, needs a client change per new producer, and cannot name a producer from a foreign log at all. The producer name already recorded in the log is more reliable than a label the client invents.

**Register presentations per source kind.** The disclosure decision deferred a keyed context-view slot until source-owned presentations emerged. Naming a row is not a distinct presentation, and a registry keyed on mounted producers would fail exactly where it matters — a resumed log whose producer is no longer mounted still has to render.

**Compute the role and label on the host.** The host would have to attach a view to each event copy, duplicating what the durable source already states and adding a wire field per context message. The projection derives it once per node instead, where the transcript's other derived facts live.

**Give steering its own row instead of a captioned bubble.** Steering is a user message that arrived mid-turn; a separate row shape would break the right-aligned reading rhythm and duplicate the bubble's copy and branch actions for no new information.

**Extend the trajectory table with the same names.** Out of scope: the table's context cell has its own text derivation, and the issue asks for the conversation surface.

## Testing

- `packages/client/runtime` unit coverage pins each source kind, the label fallbacks when a name field is missing, empty, or wrongly typed, the unnamed degradation for a source with no readable kind, and steering reconstruction on reset and live append paths.
- `packages/client/ui-conversation` jsdom coverage pins the role title, the producer label beside it, the label's survival while expanded, and the roleless header.
- The keyless assembled-Web goldens carry the named header, so the assembled transcript — not only component tests — proves the marks.

## Consequences

- **Superseded in part.** The steering-caption clause of the Decision no longer describes master: the [caption removal](../simplification/2026-08-10-web-remove-steering-interjection-caption.md) deleted the `插话` / `Interjection` caption, leaving a mid-turn steer recognizable only by its position in the flow. The context-source and recall naming in the Decision stays current, and the `SteeringMessageNode` projection is unchanged.
- A reader can attribute every non-prompt message in the transcript at a glance, and the header stays honest for logs this client version has never seen a producer for.
- Producer names in the UI are package-shaped (`dsh-tool-skill`, `@deepseek-ai/dsh-system-prompt`) wherever the source carries only a plugin id. That is the cost of refusing a client-side name table; a producer that wants a better label must record one in its source fields.
- `ContextMessageNode` gains a required field, so every constructed node — including test fixtures — must supply it.
- `SteeringMessageNode` remains a distinct presentation node even though the agent loop now records admitted steering as `user/message`; its identity comes from the durable inbox history rather than a separate message event.
- The `recall` arm has no producer in a shipped Web leaf until a host mounts `dsh-session-reference`; it is reachable only through logs written elsewhere.
