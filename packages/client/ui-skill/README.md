---
description: "Web skill references and the dedicated skill tool row for the dsh web client: the /-triggered skill source and the skill call card."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-skill

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-skill` lets users invoke skills by typing `/name` in the composer: the suggestion menu offers user-invocable skills from the `skills/list` Remote, and a pick lands the literal `/name ` text that the host then loads as the skill's instructions. Loading is deterministic: the host's pre-step boundary (`dsh-tool-skill`) recognizes the whitespace-bounded `/name` token in the sent message and injects the rendered `<skill_content>` for every entry point, so a menu pick, a hand-typed token, and a TUI/ACP prompt all load the skill the same way. Settled skill calls render in the conversation as an expandable `Instructions` card, derived only from the frozen call/result slice.

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

Type `/` in the composer and pick a skill from the suggestions, or type `/name` directly; the sent message carries the literal text, and the host loads the skill the same way for a menu pick or a hand-typed token. A name shared with a host command still resolves to the command — adjudication claims the line client-side before it ever becomes a prompt.

### What the source offers

Ordinary-session candidates come from the `skills/list` Remote; the host serves every user-invocable skill, and a `modelInvocable: false` entry (a `disable-model-invocation` skill, whose only entry point is this path) wears the user-only marker as a description prefix in the active language. Results rank through the `/` menu's shared name ranker, `rankByName` from ui-primitives: the query matches a case-insensitive ordered subsequence of the skill name, prefix hits rank first, and ties keep the host order ([ranking decision](../../../.agents/notes/archived/feature/2026-08-04-web-slash-command-fuzzy-discovery.md)). A failed `skills/list` call is logged and folded into a silent menu-group drop — the menu shows only pending/ready states.

### The skill tool row

A collapsed row renders the skill glyph, `Skill` title, and requested skill name; running calls carry the transcript shimmer, failures replace the name with the first error line, and interrupted calls use the warning state. A settled row expands into a bounded `Instructions` card containing the exact durable tool output, with the standard trajectory `Inspect` affordance when available. The row derives its name, lifecycle, and body only from the frozen call/result slice supplied by ui-tool, never from the current catalog, so replay stays stable when installed skills or their descriptions change.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The source implements no adjudication hooks and no reference codec: the pick lands literal text and the prompt ships the same literal, so determinism lives host-side ([slash pipeline note](../../../.agents/notes/archived/architecture/2026-07-25-web-input-machine-and-slash-pipeline.md)).

### Candidate flow

Catalogs cache per ordinary session with a single-flight fetch; the scope-birth `warm` hook prewarms the session's entry, the forwarded `agent-preset/selected` owner event drops that one session's entry (the catalog belongs to the preset, and a blank session may switch after the warm), and `connection/reset` clears everything. Catalog-addressed continuable children resolve no skill candidates locally because the existing skill RPC requires an attached session; viewing their persisted history must not activate them. The list RPC rides the plugin's root-context connection captured at registration; draft chip visuals derive from the `lexicon` scan.

### Registration

The `/client` exports are the plugin body (`apply`/`inject`) only; the source object is internal to the registration effect. The tool row registers the `skill` wire name in ui-tool's keyed `tool.call.toolview` slot.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the input machinery, the tool row host, and the host-side skill tool.

- [ui-input-trigger](../ui-input-trigger/README.md) — the inline suggestion machinery the source registers into.
- [ui-tool](../ui-tool/README.md) — the tool-call presentation layer hosting the `tool.call.toolview` slot.
- [tool-skill](../../skill/tool-skill/README.md) — the host-side `skill` tool owning the pre-step gesture boundary.
- [Web input machine and slash pipeline](../../../.agents/notes/archived/architecture/2026-07-25-web-input-machine-and-slash-pipeline.md) — how references and commands share the input machine.

-----

<a id="model-experience"></a>
## Model Experience

### User-explicit skill invocation

#### What the model sees

The user's message reaches the model verbatim, `/name` literal included. The host's pre-step boundary (`dsh-tool-skill`) then appends the canonical `<skill_content>` block — the same `renderSkillContent` output the `skill` tool returns — as injected instructions context at the end of that step's injections, closest to the model's answer. Loading is deterministic: the model receives the full body without being asked to call the `skill` tool, and the catalog tells it not to re-load an inline-injected skill.

#### Token effect

One invocation adds the rendered skill body to that turn as injected context — the same cost as the model loading the skill through the tool, paid unconditionally instead of at the model's discretion. Menu browsing and the candidate fetch add zero model tokens.

#### KV Cache effect

Append-only: the injected message lands after the reusable history prefix. This package never edits earlier request tokens.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where the reference and the row fall back to generic behavior; they are current package constraints.

- **Result-only history pages use the generic row** — keyed dispatch needs the paired call in the runtime window; pagination that leaves the call outside has no tool identity. This client presentation feature does not extend the history wire contract to recover it.
- **Text is the truth** — the reference is plain draft text; a hand-typed identical token is the same reference, and the host gesture boundary judges the sent text, not the menu interaction. Chip visuals derive from the lexicon scan; no occurrence identity, position tracking, or structured reference payload exists on the prompt wire.
- **A menu opened before the prewarm settles** shows no skill candidates for that keystroke; the next keystroke re-polls the settled cache.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The slash source, locale dictionaries, and keyed toolview are registry-owned registrations whose disposal is proven by the HMR-safety spec. They emit no cordis events and own no cross-plugin mutable state.
