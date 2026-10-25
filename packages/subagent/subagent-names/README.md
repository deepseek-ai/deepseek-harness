---
description: "Create subagents with durable sibling names and resolve their tree paths for delegation tools without changing Session identities."
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-names

English | [中文](README.zh.md)

## Summary

Give delegated agents readable names such as `lead/research` and `lead/research/checker`. Names survive Session reloads, and lookup can read parents that are no longer live. Choose this package for named delegation tools while retaining Session ids for execution and authorization. Names identify existing catalog children; a failed creation does not permanently occupy its requested name.

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

Mount this plugin with the naming-aware [delegation tool](../tool-subagent/README.md) and [control tools](../tool-subagent-control/README.md).

### Minimal configuration

Add this row to a composition providing `agents`, `subagents`, and `sessionProjections`:

```yaml
- name: '@deepseek-ai/dsh-subagent-names'
```

This plugin has no configuration fields. It exposes `ctx.subagentNames`; the existing subagent service continues to own providers, activations, messages, and authorization. Mount `sessionQuery` for parent reads used by name lookup and discovery; starting a root's child and reading the root's name do not require it.

### Choosing and finding names

A requested sibling name starts with a lower-case letter and contains only lower-case letters, digits, underscores, and hyphens. Omission selects the first available `agent-N` name, starting at `agent-1`. Names are immutable and unique under their direct parent, including concurrent starts. A committed child keeps its name after execution settles.

The live tree root is `lead`; child paths append one segment per parent. An unnamed catalog child uses `legacy:<sessionId>` as its segment. Lookup accepts a full `lead/...` path, `lead`, or a tree member's exact Session id, including ids in existing runtime notices. It resolves identity only; the subsequent subagent operation still authorizes the caller.

### Creation and failure

Call `ctx.subagentNames.startActivation` with `delivery: 'parent'` so the existing catalog retains the child identity. For caller-owned delivery, use `ctx.subagents.startActivation`; that operation retains its id-based behavior.

Local creation records a candidate name before starting the child. The name becomes discoverable only when the existing parent catalog records that child. A candidate left by failed creation or a crash neither resolves nor occupies the name while its child is absent from the catalog. Once the catalog contains the child, a later startup failure does not free its name.

External providers allocate their own ids, so their names are recorded after startup returns. If that recording fails, the operation attempts and awaits disposal, then reports the started child id. Completed external work cannot be undone; if disposal also fails, execution may still be active. Check that child before retrying.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin owns parent-local name records and joins them with the existing subagent catalog. Its projection excludes inherited fork records. Pending sibling reservations belong to the plugin instance; unloading cancels and awaits in-flight named starts before releasing their state.

Name reads traverse creation ancestry through Session observations without restoring parent agents. Discovery adds relative paths to the subagent service's existing descendant rows. Missing projections and inconsistent catalog/name records fail explicitly instead of supplying an unverified alias.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Named startup, reservation lifetime, path lookup, and discovery |
| [`src/projection.ts`](src/projection.ts) | Durable candidate records and replay validation |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages own the execution behavior and model-facing consumers that use names.

- [Subagent service](../subagent/README.md) — activation ownership, catalogs, and authorization.
- [Delegation tool](../tool-subagent/README.md) — named creation and start acknowledgements.
- [Control tools](../tool-subagent-control/README.md) — discovery, messaging, and interruption.
- [Session projections](../../session/session-projection/README.md) — incremental recovery and observation.

-----

<a id="model-experience"></a>
## Model Experience

### Initial child identity

#### What the model sees

Named startup appends the child's full name and its parent's full name to the task prompt. Local children receive this text in their durable initial user message; external providers receive it in the delegated prompt. For a child named `research` under the root:

##### Identity message

```markdown
Your name is "lead/research". Your parent agent name is "lead".
```

#### Token effect

One short identity sentence is added to each named child's initial prompt; longer ancestry adds path text. This plugin registers no tool schema or system-prompt section.

#### KV Cache effect

The identity joins the new task prompt after any inherited history. Existing history remains unchanged; each child receives its own identity text.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Names supplement the existing execution identities with these limits:

- **Direct subagent callers remain unnamed** — starts that bypass `ctx.subagentNames` use the `legacy:<sessionId>` path representation.
- **External name binding follows execution startup** — a recording failure can occur after external work begins or completes.
- **Runtime notices retain Session ids** — names do not rewrite messages or settlement notices owned by the subagent service.
- **Names cannot be renamed or reused for cataloged children** — settling or disposing an activation does not remove its durable catalog membership.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
