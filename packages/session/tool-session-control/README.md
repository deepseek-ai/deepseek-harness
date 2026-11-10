---
description: "Send messages to other Sessions with the calling Agent's identity and receive acceptance receipts without waiting for replies."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-session-control

English | [中文](README.zh.md)

## Summary

Send a message to an independent Session and continue working after it accepts the message. A running recipient reads the message at its next input boundary; an idle recipient starts a turn, and an inactive recipient resumes first. The recipient sees the calling Agent as the sender. Access and archive restrictions remain enforced by the Session control provider.

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

Mount alongside `tools`, `sessionControl`, and a Session control provider. The tool has no configuration fields. Call `session_send_message({ session_id: "target-id", message: "Please review the result." })` to obtain `{ "message_id": "accepted-message-id" }`.

```yaml
- name: '@deepseek-ai/dsh-tool-session-control'
```

The tool rejects calls without a calling Agent with `ToolContextUnavailableError` (`TOOL_CONTEXT_UNAVAILABLE`) and whitespace-only messages with `ToolArgsError` (`INVALID_ARGS`). Provider failures retain their structured error codes. Cancellation stops work before acceptance; it does not retract an accepted message. An archived target remains archived and rejects delivery.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The tool passes the runtime's exact calling Agent and cancellation signal to [Session control](../session-control/README.md). It delegates authorization, restoration, message attribution, and delivery to that service. The Host presenter shows the target and message; the Web tool card derives its accepted state and message ID from the recorded result.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session control](../session-control/README.md) — shared delivery and provider registration.
- [Local Session control](../session-control-local/README.md) — access, restoration, and lifecycle rules.
- [Tools](../../core/tools/README.md) — invocation, cancellation, and result recording.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema and result

#### What the model sees

The [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-session-control) defines the exact schema. The receipt confirms acceptance, not completion or a reply. The schema does not expose sender identity or permission overrides.

#### Token effect

The tool schema contributes prompt tokens when available. Each invocation adds its arguments and a compact JSON acceptance receipt; the recipient receives the message through the shared service.

#### KV Cache effect

Tool availability changes the schema context. Calls and receipts append ordinary history without rewriting earlier messages.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Messages contain text only; the tool does not attach files or wait for recipient completion.
- Acceptance is not a safe-retry guarantee after an unknown outcome. Callers must retain known successful receipts.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
