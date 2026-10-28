---
description: "Bind readable subagent names to Session ids and recover the mappings from the root Session."
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-names

English | [中文](README.zh.md)

## Summary

Address delegated agents by readable names such as `lead/research` and `lead/research/checker`. Bound names survive root Session reloads and keep the same spelling after agents finish. Choose this package when delegation tools need names while preserving Session ids for execution and authorization. Agents without a bound name remain addressable by id.

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

Add this row to a composition providing `subagents` and `sessionProjections`:

```yaml
- name: '@deepseek-ai/dsh-subagent-names'
```

This plugin has no configuration fields. It exposes `ctx.subagentNames`; the subagent service owns execution, messages, discovery, and authorization.

### Choosing and finding names

A requested name segment starts with a lower-case letter and contains only lower-case letters, digits, underscores, and hyphens. Omission selects the first available `agent-N` under the parent's name, starting at `agent-1`. Reservations prevent concurrent starts from choosing the same full name. A bound name remains occupied after execution settles.

The root is `lead`. `nameOf` returns a bound full name, or the original Session id when no binding exists. `resolveName` accepts `lead` and bound full names; it rejects an unknown `lead/...` name and passes other ids through. The subsequent subagent operation still authorizes the caller.

### Binding after startup

Call `reserve(parent, requested?)`, start the child through `ctx.subagents.startActivation`, then call `bind(parent, childId, reservation.name)` with the successful receipt. Release the reservation with `dispose()` in `finally`, whether startup and binding succeed or fail.

Binding records the full name in the root Session. If binding fails after startup succeeds, the caller must report the already-started child id; the child remains managed by the subagent service. A crash before binding can likewise leave an unnamed child that remains addressable by id.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Each root Session stores its own name-to-id bindings. A projection recovers those bindings and excludes inherited fork records. Lookups read this root mapping without observing ancestor Sessions or joining child catalogs. Callers own transient reservations and release them after their operation.

The mapping retains one binding per named child: storage is O(n), a lookup or binding is O(n), and replaying n distinct bindings is O(n²) in the worst case because each event searches the binding array.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Name reservations, binding, and lookup |
| [`src/projection.ts`](src/projection.ts) | Durable bindings and replay validation |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages own execution and the model-facing tools that use names.

- [Subagent service](../subagent/README.md) — activation ownership, catalogs, and authorization.
- [Delegation tool](../tool-subagent/README.md) — named creation and start acknowledgements.
- [Control tools](../tool-subagent-control/README.md) — discovery, messaging, and interruption.
- [Session projections](../../session/session-projection/README.md) — incremental recovery.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the [delegation tool](../tool-subagent/README.md) and [control tools](../tool-subagent-control/README.md), which render names alongside Session ids and accept names as addresses.

#### KV Cache effect

This plugin resolves message sender names through `subagent/message-name` and adds no prompt text or tool schema. Its consumers own any model-visible name text and its cache effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Name bindings have these limits:

- **Names are available after binding** — the child's first request may precede its binding; this plugin adds no initial identity message.
- **Names are immutable** — bound names and ids cannot be reassigned or reused after an activation ends.
- **Paths capture the parent's name at reservation time** — an unnamed parent uses `lead/legacy:<parentId>` as its prefix; a later parent binding does not rewrite the child's stored path.
- **Naming is explicit** — callers that do not bind a name continue to use Session ids.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
