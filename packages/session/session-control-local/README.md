---
description: "Deliver Agent messages to independent Sessions in the current runtime, restoring cold Sessions with their recorded preset and preserving deployment model defaults."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-control-local

English | [中文](README.zh.md)

## Summary

Send messages to live or persisted independent Sessions in the current runtime. Cold Sessions resume with their recorded preset, while unselected models follow the deployment's current defaults. Archived targets reject messages without being unarchived. Subagent Sessions continue through their existing tree controls.

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

The [base bundle](../../bundle/base/README.md) mounts this provider for the [Session control service](../session-control/README.md). Custom compositions require `sessionControl`, `agents`, `sessions`, `sessionQuery`, and `agentDefaultModel`; persisted targets also require an Agent factory and persistence. The optional preset registry restores the recorded preset, and the optional Workspace registry supplies archive state. This provider has no configuration fields.

Send through `ctx.sessionControl.sendMessage` or its [model tool](../tool-session-control/README.md). An exact live Agent may address any independent Session visible to this runtime, including a different Workspace or cwd. This authorization does not borrow an API Remote principal. A running recipient accepts steering input for its next input opportunity; an idle recipient begins a turn. Cold restoration preserves history, and the receipt acknowledges inbox acceptance without waiting for an answer.

Missing Sessions, archived targets, subagent-owned identities, another writer, and failed restoration return structured failures. Cancellation applies before acceptance. Unloading this provider first cancels and drains its calls, then releases the Agent handles it restored; already-live Agents remain owned by their original creator.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [provider](src/index.ts) rechecks caller identity, target archive state, and target ownership before accepting input. It uses the Session query service to retain a cold observation and reads its projected preset. Its `compose`, `defaultOptions`, `presetForObservation`, and `resumeObserved` methods supply ordinary Session activation to the [API Session Controller](../../api/session-controller/README.md), which retains its own Remote errors and blank-Session reuse rules. `resumeObserved` binds the returned handle to its calling Context; message delivery owns its restored handles within this provider. Subagent ownership is checked again after asynchronous preset resolution.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session control](../session-control/README.md) — attribution, ordering, and acceptance receipts.
- [Session query](../../session-query/session-query/README.md) — retained observations.
- [Agent presets](../../preset/agent-preset-registry/README.md) — recorded and default composition.
- [Subagent service](../../subagent/subagent/README.md) — managed-child continuation.

-----

<a id="model-experience"></a>
## Model Experience

### Restored conversations

#### What the model sees

The recipient continues its existing Session history with the attributed Agent message described by [Session control](../session-control/README.md#model-experience). A cold restore reapplies the recorded `agentPreset`; its ordinary prompt and tools remain owned by that preset.

#### Token effect

Restoration retains the conversation's existing history and adds the accepted message. This provider contributes no separate model-facing instructions or schema.

#### KV Cache effect

Live delivery appends input without rewriting earlier context. A restored Agent rebuilds its request from recorded history and the selected preset; cache reuse depends on the resulting request and model provider.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- This provider addresses the current runtime's Session store and persistence; it does not deliver to another running Harness instance.
- Subagent Sessions require their existing tree owner and continuation rules. Ordinary Session restoration cannot bypass those requirements.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
