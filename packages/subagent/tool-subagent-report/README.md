---
description: "Child-scoped report tool for users and maintainers composing or debugging the child-to-parent return channel of continuable subagents."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-subagent-report

English | [中文](README.zh.md)

## Summary

`dsh-tool-subagent-report` gives every continuable in-process child a return channel to the agent that started it: it installs a child-scoped `report` tool plus the prompt guidance that tells the child to use it. The tool and its guidance exist only inside those children — roots, one-shot subagents, remote providers, and sibling scopes never see them. Accepted reports reach the parent as ordinary parent messages, framed as `Background subagent <child-id> reported:`. Continuable mode depends on neither this package nor the control package; this one owns only the child-to-parent direction.

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

Mount this package in a composition with continuable in-process children whose findings the parent should see before they finish. The tool and its guidance appear automatically inside each continuable child; no per-child configuration is needed.

### Minimal configuration

Load the subagent service, a backend, the delegation tool in `continuable` mode, and this package:

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    backgroundMode: continuable
- name: '@deepseek-ai/dsh-tool-subagent-report'
```

| Field | Default | Meaning |
|---|---|---|
| `reportDelivery` | `next-step` | Parent scheduling for accepted reports: `next-step` wakes the parent at its nearest step boundary; `quiet` adds the same context without waking it |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-subagent-report) is the exhaustive source for every accepted field and its JSDoc.

### What the child gets

Each continuable child gets a `report` tool whose only parameter is `output` — a self-contained answer for the parent — and a prompt section telling it to call `report` once before finishing, and earlier whenever a partial finding changes what the parent should do next. The instruction is guidance, not enforcement: a child may call zero or many times in one turn, and finishing a turn never reports automatically. A successful call neither ends the turn nor settles the child's Activation.

### What the parent sees

An accepted report becomes one user-role parent message framed as `Background subagent <child-id> reported:` followed by the child's exact output, with a durable source naming the child. `next-step` delivery wakes an idle parent or joins a running parent's nearest step boundary; `quiet` delivery adds the same context without waking the parent. The tool takes no recipient: the service derives the sole recipient from the child's durable `parentSession`.

### Scope and direction

The report tool deliberately survives the child's global `toolFilter`: a delegation allow-list cannot remove the only return channel. A deployment that requires a child with no return channel omits this package. The parent-to-child direction remains the independently installed control package, and continuable mode depends on neither package.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the tool is installed and scheduled; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

The package registers a continuable-child setup contribution rather than a global tool, so the tool and its guidance are installed inside each child's unpublished scope and vanish with it. The same registrations are ordinary child-scoped contributions, so an expert `system-prompt/assemble` listener could replace them and would then own preserving the reporting protocol for that child.

### Delivery scheduling

`next-step` uses `parent.steer()`: a running parent receives the report at its nearest safe step boundary, an idle parent starts a turn, and reports accepted in sequence share the next-step FIFO. `quiet` uses `parent.inject()`, adding the same next-step context without waking a parked parent. Both are deployment policy: the model-facing schema cannot select or override delivery per call.

### Exported contribution

`installReportTool(childCtx, ctx, delivery)` installs the tool and guidance into a minted child scope and returns one disposer revoking both. The generated tool catalog uses this path because the global registry cannot expose a scope-local schema; production composition still enters through `apply()`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Continuable-child setup: `installReportTool`, `Config`, delivery resolution |
| — | No runtime invariant companion is published; this adapter has no independent lifecycle stream; sender authorization and delivery relations belong to the subagent service. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the report channel to the continuation service behind it and the parent-facing tools.

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — continuable children, activations, and the `reportFrom`/`reportDelivery` contract.
- [dsh-tool-subagent-control](../tool-subagent-control/README.md) — the parent-to-child control tools.
- [dsh-tool-subagent](../tool-subagent/README.md) — the delegation tool that starts continuable children.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent-report) — the `report` schema.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-subagent-report) — every accepted config field.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The generated [`report` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent-report): one required `output` string. Its description states that the child must report once before finishing, that reporting reaches only the Agent that started the child, and that it does not end the turn. It carries no recipient or delivery-mode parameter. The separate `tool:report` prompt section repeats the obligation outside the schema.

#### Token effect

Fixed schema and prompt-section cost per continuable-child request, and none in any other Agent's requests.

#### KV Cache effect

Prefix-stable within a child; neither the schema nor the section changes at runtime. Removing the package revokes both from resident children, which changes their next request prefix.

### Report result

#### What the model sees

`report accepted by the agent that started you as message <messageId>` on acceptance; the canonical output carries the stable `messageId`. A failure from an unauthorized sender, an unavailable parent, or a closing lifecycle is an errored result. The description says a failed call may still have arrived, because a later `tools/post-execute` failure can replace the result after `reportFrom()` accepted the message.

#### Token effect

One short acknowledgement per call in the reporting child. The reported content is additionally billed to the parent: next-step delivery joins the next request in an open parent turn or starts a turn for an idle parent, while quiet delivery waits for another input to wake the parent.

#### KV Cache effect

Append-only in the child. In the parent, the framed report follows existing history and preserves the reusable prefix.

### Parent-visible report

#### What the model sees

One user-role parent message framed as `Background subagent <child-id> reported:` followed by the child's exact `output`, with a durable source `{ kind: 'subagent-report', senderSessionId: <child-id> }` that names the child.

#### Token effect

The child's complete `output` plus the one-line frame, uncapped by this package.

#### KV Cache effect

Append-only; the report follows the parent's reusable request prefix. Next-step delivery wakes the parent and may extend its open turn, while quiet delivery does not wake it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what an accepted report does and does not guarantee; they are current package constraints.

- **A parent whose host-owned disposal already started can still accept** — `AgentHandle.dispose()` cancels, awaits quiescence, and only then unwinds the scope and leaves the registry; it exposes no signal for "disposal started." A report accepted in that window is appended to the parent's transcript, but that parent will not act on it in this process. A continuation-manager-owned parent rejects forest teardown through the manager's admission boundary.
- **Acceptance is weaker than durable delivery** — there is no durable mailbox, idempotency key, delivery receipt, retry protocol, or exactly-once claim. A process failure after one side recorded acceptance leaves the outcome ambiguous, and an external retry may duplicate the report.
- **A staged quiet report is not immediately reconstructable** — acceptance returns its stable `MessageId`, but the parent Session reconstructs the framed content only after pending context reaches its ordinary log boundary.
- **Granting waits for the next Activation; revocation is immediate** — installing this package after a child becomes resident grants `report` and its guidance only on that child's next Activation, while removing the package revokes both from resident children immediately.
- **Nested reporting reaches exactly one edge upward** — a grandchild reports to its direct child parent, never to the top-level coordinator, which must explicitly report a derived update later.
- **No rate limiting** — the default `next-step` mode can amplify model work when nested children report frequently, although reports waiting together share one step; a deployment that accepts unread reports over that amplification selects `quiet`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
