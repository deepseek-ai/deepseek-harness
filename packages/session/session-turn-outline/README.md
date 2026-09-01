---
description: "Whole-log turn outline for clients and maintainers composing or debugging the turnOutline projection unit behind full-session turn navigation."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-turn-outline

English | [中文](README.zh.md)

## Summary

`dsh-session-turn-outline` serves the whole-log turn outline — every started turn with its `turn/start` seq and bounded prompt and final-response previews — as the `turnOutline` projection unit. A client that pages history in windows reads the outline to offer every turn of the session (loaded or not) and to target its backwards paging at the exact seq that brings a turn's events in. Choose it in compositions that already mount the projection registry, such as the web app bundle whose chat turn rail is the reference consumer; assemblies without the registry are unaffected and their consumers fall back to loaded-window navigation. Setup and entry semantics come first; the fold internals live in a collapsible developer section below.

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

Mount the plugin beside the session store and the projection registry when clients should navigate every turn of a session without holding its complete event log. The unit registers only when the registry is present.

### Composition

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-projection'
- name: '@deepseek-ai/dsh-session-turn-outline'
```

### What an entry means

| Field | Meaning |
|---|---|
| `turn` | Host-assigned turn number from the `turn/start` payload |
| `seq` | The turn's `turn/start` event seq — paging a window back through this seq loads the whole turn |
| `prompt` | Preview of the turn's first human prompt (space-joined text blocks, collapsed whitespace, 50-character cap with a trailing ellipsis when clipped — one rail-card line); `''` until an eligible prompt lands |
| `response` | Preview of the turn's final text-bearing assistant message (same normalization, 120-character cap — up to three rail-card lines); `''` until the turn ends with assistant text |

The wire value is the complete entry array, strictly increasing by `turn` (whole-value rule): consumers replace, never merge. Prompts fill only from `user/message` events with the human `user` source, so injected context and tool results never leak into navigation; a turn whose prompt is images-only keeps `''` and consumers label it by number. The response buffers as a draft while its turn streams and commits at `turn/end`; the change feed's raw-view identity gate keeps draft-only changes quiet, so the outline pushes at most three times per turn — boundary, prompt, settled response. Preview budgets match the chat rail's loaded-turn previews, so a turn shows the same words before and after its events load.

### Failures and recovery

The unit is inert without the projection registry: `inject` keeps the fiber pending and nothing registers, so other assemblies lack the `turnOutline` key. Unmounting the plugin removes the key, because registrations are effects on the mounting fiber. Persisted-cache rows are schema-validated on restore — including the strictly-increasing turn order — so a corrupt row is discarded instead of seeding a broken fold.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the fold behind the outline; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The unit is a pure fold over committed session events. `turn/start` — not the prompt `user/message` — anchors each entry because its seq is the load-through target for a jump: the agent loop logs `turn/start` before the turn's prompt and steps, so a window paged back through that seq contains the whole turn. The prompt fills from the first human `user/message`, and only while the newest entry is still empty — later human messages in the same turn (steering) keep the first preview. The response cannot fill the same way (`turn/end` carries no text), so each text-bearing `assistant/message` overwrites a state draft and `turn/end` commits the survivor — the newest text, which is the loaded rail's `findLast` semantic.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `inject`, unit registration on the mounting fiber |
| [`src/projection.ts`](src/projection.ts) | The fold: entry append, preview fill, wire view |
| [`src/types.ts`](src/types.ts) | One home of the `turnOutline` projection-key declaration and entry types |
| — | No runtime invariant companion is published: the package owns one pure projection fold, `session-projection` schema-validates its served values, and re-folding the same log would duplicate the implementation instead of comparing independently maintained observations; session and agent-loop own turn-boundary ordering. |

### Fold rules

- Uninteresting events return the same state reference, and draft-only changes keep the `turns` array's identity; the registry's two `Object.is` gates then hold the feed to at most three pushes per turn.
- A `turn/start` that does not advance the turn number is skipped, keeping the outline sorted; a retried boundary's previews then land on the standing entry.
- The wire view projects `state.turns`; the persisted-cache state schema wraps the wire schema with the draft field.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the unit's contract is not enough. They move from the registry that drives units to adjacent session packages.

- [Session projection subsystem](../../../docs/subsystems/session-projection.md) — the registry that drives units and serves snapshot and change-feed values.
- [Session projection registry package](../session-projection/README.md) — the registry contract units register against.
- [Session package map](../README.md) — adjacent persistence, projection, title, and telemetry packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as the turnOutline unit folds already-logged turn boundaries into a client-facing read model and registers nothing model-facing.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the outline describes and when the unit is absent. They are current package constraints.

- **The wire value grows with the session** — every push carries the complete outline (whole-value rule), up to ~600 bytes per turn at full CJK budgets and typically far less; splitting previews into an on-demand read is deferred until sessions with many thousands of turns need it.
- **The response previews only settled turns** — it commits at `turn/end`, so an open turn (or one whose end never logged) shows a prompt-only preview until the boundary lands.
- **A turn without eligible text keeps `''`** — images-only and command-only turns are navigable but labeled by number, and a turn whose steps emit no text gets no response preview.
- **Mounted only where the projection registry is composed** — other assemblies serve no `turnOutline` key, and their consumers fall back to loaded-window navigation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
