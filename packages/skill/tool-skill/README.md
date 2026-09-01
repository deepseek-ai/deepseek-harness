---
description: "The model-facing skill catalog and loader tool for users and maintainers understanding what agents see, or configuring the session skill catalog."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-skill

English | [中文](README.zh.md)

## Summary

Agents can discover and load skills during a session: before the first request they receive a durable catalog of every available skill's name and capped description, and they can load any listed skill's full instructions by name through the `skill` loader tool. A user can also invoke a skill directly with a `/name` token, which injects that skill's instructions into the step. The catalog stays current: membership, description, or visibility changes append a complete replacement catalog, and a deleted skill is explicitly retired. Mount it alongside the skill registry (and at least one provider) when agents should load skills; its only configuration caps catalog description length.

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

Mount the plugin alongside the skill registry to give agents a session skill catalog and the `skill` loader tool. It requires `ctx.agents`, `ctx.tools`, and `ctx.skills`.

### When to choose it

Use it when agents should discover and load skills during a session. Skip it when skill loading is handled by another consumer or not needed at all — without it, providers and the registry still work, but nothing renders a catalog or a tool for the model.

### Mount and configure

Load the plugin together with the skill registry and at least one provider. The only configuration caps the normalized description length rendered in the catalog.

```yaml
- name: '@deepseek-ai/dsh-skill'
- name: '@deepseek-ai/dsh-skill-filesystem'
- name: '@deepseek-ai/dsh-tool-skill'
```

| Field | Default | Meaning |
|---|---|---|
| `catalogDescriptionMaxLength` | `500` | Maximum normalized description length rendered in the session catalog; minimum 3 |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-skill) is the exhaustive source for every accepted field.

### What the model gets

- **A session catalog.** When model-invocable skills exist and the `skill` tool is visible, the agent receives a durable user-role message before its first request, listing each skill's name and a capped description; the message tells the model to load a skill with the tool before acting on it, and never to infer instructions from the summary alone.
- **A loader tool.** The model calls `skill` with the exact skill name and receives the full instruction body plus resource guidance in a canonical `<skill_content>` block; the result is retained as ordinary tool history.
- **Explicit user invocation.** A `/name` token in direct user input that names a user-invocable skill injects that skill's instructions into the step, without the model having to load it.
- **Live catalog updates.** Later membership, description, or visibility changes append a complete replacement catalog; removing every skill appends an empty catalog that retires older names.

### Observable success and failures

Loading a listed skill returns its full instructions; the model sees one canonical shape whether the load came from the tool or from a user's explicit invocation. An invalid name reports `Error: invalid skill name "<name>"`, an unknown name reports the skill is unknown or no longer available, and a skill disabled for model invocation reports it is not available for model invocation. The catalog is omitted entirely only when no model-invocable skills exist and none was ever published; a later visibility loss — the `skill` tool hidden or shadowed by a same-name scoped tool — instead appends an empty retirement catalog, as when every skill is removed.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the catalog and the invocation boundary are built; the observable behavior is fully covered in [Use this package](#use-this-package) and the Model Experience section below.

### Design concept

The package is built on two ideas. First, the catalog is a durable projection, diffed by a digest over the published entries rather than the rendered prose, so the `<system-reminder>` framing can never force a republish and consumers never re-parse the `<available_skills>` block. Second, one canonical rendering serves both load paths — the tool result and the user-explicit injection — through `renderSkillContent` shared from `dsh-skill`, so the model sees the same `<skill_content>` shape regardless of who initiated the load.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: tool registration, catalog and gesture pre-step listeners, rendering and digest |
| — | No runtime invariant companion is published; this model-facing adapter has no independent lifecycle stream; execution relations are owned by the capability seam it calls. |

### Catalog lifecycle

At each eligible `agent/pre-step`, the plugin snapshots the calling session's skill catalog, applies exact `skill` tool visibility, filters to model-invocable skills, and compares a digest of the entries against the newest visible `skill-catalog` message in the session log. When the digest changed, it hands the `enter` decision a durable user-role message containing the complete replacement catalog; an empty replacement explicitly retires earlier names. An incomplete provider snapshot emits nothing and preserves the last-good view for the next pre-step. The visibility check compares against the exact tool definition this plugin registered, so a scoped same-name shadow removes both the schema and its guidance; the plugin works mounted globally or inside one agent's composition.

### Invocation boundary

The `/name` gesture listener scans only claimed user messages: a whitespace-bounded token naming a user-invocable skill in the workspace catalog injects the same `<skill_content>` rendering as a `user`-role instructions context appended after every other injection. Unknown names and user-disabled skills stay ordinary prose. This is the only entry point for `disable-model-invocation` skills, which the catalog and the `skill` tool never expose.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the registry vocabulary behind the catalog to the exact tool schema and the design rationale.

- [Skill subsystem reference](../../../docs/subsystems/skills.md) — the registry and provider vocabulary behind the catalog.
- [skill package](../skill/README.md) — the registry and the shared `renderSkillContent` rendering.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-skill) — the exact `skill` schema the model receives.
- [Skill catalog hot-refresh Agent Note](../../../.agents/notes/implemented/feature/2026-07-27-skill-catalog-hot-refresh.md) — the durable initial catalog and replacement lifecycle.
- [User-explicit skill invocation Agent Note](../../../.agents/notes/implemented/feature/2026-08-08-user-explicit-skill-invocation.md) — the `/name` gesture design.

-----

<a id="model-experience"></a>
## Model Experience

### Session catalog

#### What the model sees

If model-invocable skills exist and this exact `skill` tool is visible, the agent receives the catalog template below as a durable user-role message before the first request, with one data-dependent entry per sorted skill. Later membership, description, or visibility changes append a complete replacement using the same `<available_skills>` envelope; deleting every skill appends an empty envelope with an explicit instruction not to use older names. The template's closing sentence is the rule against double-loading: the user-explicit gesture boundary (the pre-step listener below) injects the same `renderSkillContent` output (shared from `@deepseek-ai/dsh-skill`) inline, and the catalog tells the model to follow that block instead of re-loading the skill through the tool; the replacement-catalog template carries the same anti-double-loading rule in both arms, including the emptied catalog.

##### Skill catalog template

```markdown
<system-reminder>
A skill is a reusable set of task-specific instructions. The following skills are available in this session:

<available_skills>
- `<name>`: <normalized-and-capped-description>
</available_skills>

If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.
A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.
</system-reminder>
```

#### Token effect

Repeated input cost scales with skill count and `catalogDescriptionMaxLength`; no initial catalog tokens are sent when the list is empty or the tool is hidden or shadowed. Each actual catalog change adds one retained complete replacement message.

#### KV Cache effect

The initial durable catalog is appended after the existing reusable prefix. Dynamic changes are append-only history after that catalog, so earlier reusable tokens stay intact while each newly appended catalog and later turns form a new suffix. A new or resumed instance with a changed digest may affect cache reuse from the newly appended catalog position.

### Tool schema

#### What the model sees

The model sees the generated [`skill` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-skill).

#### Token effect

Fixed schema cost per request where the tool is visible.

#### KV Cache effect

Prefix-stable while the tool definition and visibility are unchanged. Shadowing, restrictions, or plugin lifecycle changes may invalidate reuse from this schema.

### Tool result

#### What the model sees

A successful call uses the result template and the provider-managed, directory, URL, or opaque resource guidance below.

##### Skill result template

```markdown
<skill_content name="<escaped-name>">
<skill_resources>
<resource-guidance>
</skill_resources>

<skill_instructions>
<provider-owned-instruction-body>
</skill_instructions>
</skill_content>
```

##### Provider-managed resource guidance

```markdown
Resources for this skill are managed by provider "<provider>".
Load referenced resources only as needed.
```

##### Directory resource guidance

```markdown
Base directory for this skill: <path>
Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.
```

##### URL resource guidance

```markdown
Base URL for this skill: <url>
Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.
```

##### Opaque resource guidance

```markdown
Resources for this skill: <description>
Load referenced resources only as needed.
```

#### Token effect

Loaded instructions are data-dependent tool-result tokens, resent on later steps until compaction; no duplicate `agent.inject()` copy is made.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Tool errors

#### What the model sees

Invalid or stale selections return exactly `Error: invalid skill name "<name>"`, `Error: skill "<name>" is unknown or no longer available`, or `Error: skill "<name>" is not available for model invocation`. Provider-thrown lookup text is data-dependent and receives the same `Error: <message>` wrapper.

#### Token effect

Only a failing call adds these retained tokens.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### User-explicit invocation injection

#### What the model sees

A whitespace-bounded `/name` token anywhere in a claimed user message, naming a user-invocable skill in the workspace catalog, injects that skill's full `<skill_content>` rendering (the exact result-template shape above) as a `user`-role instructions context appended after every other injection of that step — background first, the material to act on last. Only direct user input is scanned, the check runs on the loaded definition, and unknown or user-disabled names stay ordinary prose. This is the sole entry point for `disable-model-invocation` skills, which the catalog and the `skill` tool never expose; the catalog's closing sentence tells the model to follow the injected block instead of re-loading it.

#### Token effect

Each gesture adds one rendered skill body to that turn as injected context — the same size as the tool result for the same skill, paid deterministically at the user's request instead of at the model's discretion. Repeated gestures for one skill within one step inject once.

#### KV Cache effect

Append-only; the injection lands after the reusable request prefix inside the step's message batch and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the catalog or the loader is a poor fit. They are current package constraints, not a task backlog.

- **The catalog omits `whenToUse`, source, and provider metadata** — routing is based only on name and a capped description; `whenToUse` remains provider metadata and is not rendered by the loaded wrapper either.
- **Loaded instruction bodies have no size cap** — a provider can return a skill large enough to consume substantial next-step context; only catalog descriptions are truncated.
- **Resources are guidance, not attachments** — the tool reports a base directory/URL/opaque hint but neither enumerates nor fetches referenced files for the model.
- **Loading is one-shot text** — there is no partial, streaming, or cached-content handle when a remote provider is slow or a skill body is large.
- **Catalog replacement is whole-list** — one changed name or description appends every visible summary; this keeps stale-name retirement explicit but costs tokens proportional to the catalog.
- **Bodies are not versioned** — body-only edits do not change the catalog digest or notify the model; a later tool call reads the current provider content while earlier tool results remain historical facts.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
