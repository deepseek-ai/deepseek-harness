---
description: "Send an attributed Agent message to a Session and receive its inbox acceptance identity. Shared delivery preserves cancellation, target ordering, and subagent lifecycle ownership."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-control

English | [中文](README.zh.md)

## Summary

Send a message to a Session and receive an acceptance receipt without waiting for its reply. Every message identifies the actual sending Agent. Running recipients receive steering input, idle recipients begin a turn, and the selected delivery provider restores cold recipients when supported. Existing subagent messaging retains its tree permissions and restoration rules.

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

Use `ctx.sessionControl.sendMessage({ id, message }, { caller, signal })` for nonblank text addressed to an independent Session. The trusted caller supplies the exact live Agent and cancellation signal; model arguments cannot replace the sender. The returned `messageId` identifies the accepted inbox message, not a reply or completed turn. The [model tool](../tool-session-control/README.md) supplies the JSON interface.

The [base bundle](../../bundle/base/README.md) mounts this service and its [local provider](../session-control-local/README.md). A custom composition requires the Agent registry and a delivery provider; this service has no configuration fields. Subagent consumers use the existing [subagent service](../../subagent/subagent/README.md), which resolves names and retains its own tree authority.

Cancellation stops work before acceptance and never withdraws an accepted message. Provider removal cancels and drains its pending calls before a replacement can register. Calls are not retried automatically, including failures with an unknown delivery outcome.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [service](src/index.ts) serializes delivery by target Session id across its independent-Session and subagent entry points. The [message constructor](src/message.ts) fixes the message identity and actual sender before delivery. Providers retain ownership of restoration, closing coordination, archive checks, and final inbox admission. The subagent manager registers its existing private delivery capability, so its closing and parent-report bookkeeping remain with that manager.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Local Session control](../session-control-local/README.md) — current-runtime restoration and delivery.
- [Session control tools](../tool-session-control/README.md) — model-facing arguments and receipts.
- [Subagent service](../../subagent/subagent/README.md) — tree membership and continuation.

-----

<a id="model-experience"></a>
## Model Experience

### Agent messages

#### What the model sees

The recipient receives `Agent <sender> sent a message: ` followed by the sender's content. Independent Session messages use the sender's Session id; subagent messages use its tree-local name when available. The same durable message records `source.kind: 'agent-message'` and the real `senderSessionId`.

#### Token effect

Each accepted message adds its attribution prefix and supplied content to the recipient's input. This service adds no tool schema or standing prompt of its own.

#### KV Cache effect

Delivery appends input to the recipient's existing conversation. It does not replace earlier messages or the system prompt.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Acceptance does not report execution success, completion, or a reply. A caller requiring a result must use a separate conversation or result-reading operation.
- Receipt identities do not deduplicate separate calls. A caller must not repeat an operation merely because its outcome is unknown.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
