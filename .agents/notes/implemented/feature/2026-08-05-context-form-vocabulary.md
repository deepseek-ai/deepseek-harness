# Agent Note: Producer-declared context forms

Status: implemented

English | [中文](2026-08-05-context-form-vocabulary.zh.md)

## Problem

Every logged non-user `user/message` rendered through one body: the whole message serialized as inline JSON. A reader opening a row met `{ "content": [ { "type": "text", "text": "…\n\n…" } ], "source": { … } }`, where the escaping had collapsed the only thing worth reading — the model-facing prose — into a single line, and the producer fields sat inside the same blob.

Naming the producer in the header (the [source and steer marks decision](2026-08-04-web-context-source-and-steer-marks.md)) fixed *who added this*. It could not fix *what kind of thing was added*, because nothing in the log said so. Injected context is not one shape: a reconciled `AGENTS.md`, a catalog of available skills, a runtime policy snapshot, and a subagent's report are as different from each other as a terminal card is from a diff card, yet all four presented as the same wall of escaped JSON.

The tool surface already solved this shape. `ToolCallView` has three cards, not one per tool, and a tool declares which card its call is. Context had no equivalent: no vocabulary of shapes, and no way for a producer to say which one it emits.

## Decision

`MessageSource` gains an optional producer-declared `form: ContextForm` — a small tagged vocabulary of information *shapes*, independent of `kind`:

- `kind` answers **who produced this** and carries no presentation choice.
- `form` answers **what shape of information it is**. Several producers may share one form, and one producer may emit more than one over a session.

The vocabulary is semantic, never visual. A value states that the content is a file's instructions or a catalog of available items; colors, icons, ordering, and collapse defaults are the consumer's business and must not enter the union. It grows one value at a time, as producers gain the structured fields their form needs. The declared forms:

**`instructions`** — instructions read out of workspace files. `agent-instructions` declares it on both the startup baseline and later deltas; its existing `changes[]` already carried the paths, actions, and digests the presentation needs, so no field was added. The body lists the reconciled files above the text, and keeps the `<system-reminder>` framing verbatim: the framing is part of what the model read, so hiding it would misreport the request.

**`catalog`** — a catalog of items available this session, republished as it changes. `dsh-tool-skill` moves off the shared `plugin` kind to its own `skill-catalog` source carrying `entries` (the exact `name`/`description` pairs published) and `update` on a replacement, which the body renders as a replacement notice. The body lists those entries instead of re-parsing the `<available_skills>` block out of the prose.

Entries record the published fact **unescaped**. The pseudo-XML escaping belongs to the `<available_skills>` frame, which exists for the model, so it is applied when rendering that frame and never stored; otherwise a consumer would have to know the frame's encoding to display a description containing `<`, and the same frame knowledge this decision removes would leak back in another shape. `escapeText` is deterministic and injective, so digesting the unescaped entries preserves republish semantics exactly, and the model-facing text stays byte-identical.

That move also relocates catalog **identity**: the republish digest now covers the durable entries rather than the rendered text, so the model-facing framing can no longer decide whether a republish is needed, and the text-slicing that recovered entries from a logged message is gone. The v0-to-v1 edge preserves an accepted older catalog payload, so a resumed session whose newest catalog predates this change republishes once. One case does not self-heal: if that old-form catalog is the only one and the current view has no skills, the plugin sees no published catalog and emits no tombstone, so the model keeps a stale catalog nothing replaces. This is the context feature's explicit degradation, not a Session-format refusal.

**`snapshot`** — current state that a later snapshot from the same producer supersedes. The runtime-context snapshot, `time-context`, and `tmux-context` declare it. `renderContextSections()` exposes the assembly's named contributions, which `renderContextSnapshot()` already joined for the model, so the body attributes each part to the subsystem that produced it without re-splitting joined prose. The two single-contribution producers record one section each. The cleared runtime-context marker has no contributions left and declares no form.

**`notice`** — a one-off account of something that just happened. `tool-jobs`, `tool-goal` wrap-up, `plan-mode` switches, and `repeat-tool-reminder` reminders declare it with a `summary`, which rides the **collapsed** row: a notice is meant to be read without expanding at all. The summary is bounded where its inputs are caller text (a task's label and status detail have no length of their own). Goal state changes remain domain-owned `goal/change` events rather than model context, so they declare no form.

**`relay`** — a message another agent addressed to this one. Both subagent-addressed sources declare it; the sender is shown as the opaque session id the source already records, because this client cannot resolve it to a title.

**`recall`** — material lifted out of another session's log. `session-reference` declares it and needed no new field: its references already record the label, retained and omitted counts, and truncation flag, which the body shows first, because recalled context is bounded on the way in and a card that hid the omitted count would overstate what the model received.

Both readers are **all-or-nothing**: one unreadable entry disqualifies the record rather than being dropped, because a body that replaces the model-facing text must not present a confident but incomplete account of what the model read. The row's form marker reports what actually rendered, not what was declared.

The producer side validates the same durable data with the same posture. `catalogHistory` reads `source.entries` out of `agent.session.snapshotEvents()`, which on resume or fork is a persistence seed whose validation only guarantees a source object with a non-empty `kind` — no per-kind field is checked. An unreadable catalog is therefore skipped as "not this plugin's record", the posture the replaced content digest had; throwing there would fail every later step of that session at the latest, least diagnosable point.

Everything else — including a form this UI version does not present, a form absent from the source, and a `catalog` whose entries are unusable — renders the **opaque** body: the model-facing text with its real line breaks, then the remaining source data as fields. Opaque is the documented default; the contract assigns these unsupported cases to it. A resumed, forked, or foreign log must render whether or not its producer is mounted here, which is also why the classification lives in the durable source rather than in a client-side table keyed by producer.

## Why not a presenter registry

The tool presentation contract pairs its vocabulary with `presentCall(args)`, a host-side pure function each tool implements. Context deliberately has no equivalent, because the input differs in ownership: a tool's `args` are generated by the **model** against a model-facing schema, so a translation step is unavoidable; a context `source` is constructed by the **producing plugin** itself, under no external constraint, and can simply record the facts a presentation needs. Adding a registry would have bought a translation nobody needs, at the cost of a host computation point, a wire field per context message, and a browser bundle for every producing package (the client purity gate forbids host packages from contributing components).

## Alternatives considered

**Map source kinds to renderers in the client.** Cheapest to write and requires no format change, but it puts producer knowledge back in the client: every new kind then needs a client release to render as anything but opaque, and a foreign log cannot be classified at all. It also reintroduces exactly the coupling the [source and steer marks decision](2026-08-04-web-context-source-and-steer-marks.md) removed for labels.

**Reuse `kind` as the form.** One discriminant is simpler, and `agent-instructions` is already 1:1 with its form. This design loses information when several producers share one form: three shipped producers emit runtime snapshots, and combining them into one kind would make it impossible to tell which producer supplied each message. Separate `kind` and `form` fields record the producer while allowing several producers to share one presentation.

**Let the client parse the model-facing prose.** The entries and file sections are visibly structured in the text. Parsing them couples the presentation to prompt wording, so every reword silently breaks a card — the same reason catalog identity moved off the text.

**Render instructions as Markdown.** The body is a Markdown file and would read better rendered. The text also carries `<system-reminder>` framing, which the Markdown renderer drops as raw HTML, so a Markdown body would silently hide part of what the model read. Deferred until the producer records per-file content structurally.

## Testing

- `packages/client/runtime` pins the form projection, including the unknown, empty, wrongly-typed, and absent values that must degrade to opaque.
- `packages/client/ui-conversation` pins each body: the opaque body's preserved line breaks and source fields, the instructions body's file list and verbatim framing, the catalog body's entry list, and a catalog with unusable entries falling back to opaque.
- `packages/skill/tool-skill` pins the new source on first publication and replacement, republish behavior driven by the durable entries, and a malformed durable catalog leaving step observation intact.
- The keyless assembled-Web seeded-history scenario expands a real `instructions` context in Chromium and asserts its file list, verbatim framing, and the unchanged disclosure geometry. `catalog` has no assembled coverage: the hermetic scaffold publishes no skills, so no catalog reaches a browser scenario.

## Consequences

- A reader can tell what was added without expanding, and reading it no longer means reading escaped JSON.
- The durable `MessageSource` now records content shape beside the producer kind and its fields. The boundary is load-bearing: facts and shape only, never presentation. A producer that wants a better card records better facts.
- Catalog identity no longer depends on the model-facing prose, deleting the text-slicing path that could mistake a reworded catalog for a changed one.
- Every shipped producer except the two hook bridges now declares a form. The bridges stay opaque by design: their content is whatever an external program printed, so no shape can be promised for it. Unknown kinds and unreadable records land there too.
- `ContextFormed` is discriminated by `form`, so a producer cannot declare a shape without the facts that shape is presented from — a `notice` without its summary, or a `snapshot` without its sections, fails to compile.
