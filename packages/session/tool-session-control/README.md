---
description: "Enable session_send_message in a Web profile so an Agent can message another ordinary Session and receive an acceptance receipt without waiting for a reply."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-session-control

English | [中文](README.zh.md)

## Summary

Let an Agent in a Web profile send a message to another ordinary Session, including one in a different Workspace or directory, and continue working once the recipient accepts it. A running recipient reads the message at its next input boundary; an idle recipient starts a turn, and an inactive recipient resumes first. The recipient sees the calling Session as the sender. The tool is off by default, exists only in Web compositions, and never waits for a reply; subagent targets are unavailable to this tool.

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

Enable the disabled `tool-session-control` row of the `@deepseek-ai/dsh-web-app` bundle with a profile patch; the [user guide](../../../docs/user/session-control.md) shows the patch and how to inspect the composed row.

### When to choose it

Enable it when Agents in a Web profile must hand instructions or findings to independent Sessions. The tool applies no Workspace or directory restriction: any Agent that sees it, including a subagent, can address any ordinary Session that the Session controller resolves. Leave the row disabled when Agents must not start work in other Sessions. Members of one subagent tree message each other with `send_message` from [subagent control](../../subagent/tool-subagent-control/README.md) instead.

### Minimal configuration

```yaml
- id: tool-session-control
  disabled: false
```

The package declares no `Config` fields. It injects `ctx.tools`, `ctx.sessionController` from [`@deepseek-ai/dsh-api-session-controller`](../../api/session-controller/README.md), and `ctx.workspaceRegistry` from [`@deepseek-ai/dsh-workspace`](../../workspace/workspace/README.md); the dsh-web-app bundle mounts both Host services, and a composition without them registers no tool.

### Delivery and failures

Call `session_send_message({ session_id: "target-id", message: "Please review the result." })` to obtain `{ "message_id": "accepted-message-id" }`. The receipt confirms that the target inbox accepted the message as steering input; it does not mean that the recipient ran or replied. The tool resolves the target with `ctx.sessionController.resolveAgent()`: a live Agent is reused, concurrent callers share one cold restoration, and the Session controller keeps a restored Agent resident like a Session opened in the GUI.

| Condition | Result |
|---|---|
| No calling Agent | `ToolContextUnavailableError` (`TOOL_CONTEXT_UNAVAILABLE`) |
| Whitespace-only message | `ToolArgsError` (`INVALID_ARGS`), before activation |
| Target is the caller's own Session | `SESSION_MESSAGE_SELF` |
| Target is archived before or after activation | `SESSION_MESSAGE_ARCHIVED`; the target stays archived |
| Subagent routing owns the target | `SESSION_MESSAGE_SUBAGENT_OWNED`; the target is unavailable to this tool |
| Other Session controller failure, including an unknown Session or one without a working directory | The controller's `RemoteError` code, such as `session/not-found` or `session/writer-held` |

`SESSION_MESSAGE_*` failures are `SessionMessageError` instances raised before the target inbox accepted the message. Cancellation before acceptance fails the call and stops waiting immediately; a restoration already in progress continues under the Session controller, and the tool delivers nothing after cancellation. Cancellation after acceptance can return `ABORTED` even though the message was delivered. Cancellation does not retract accepted input or prove that nothing was delivered. The tool never retries automatically.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The tool takes the sender from the runtime's calling Agent, so the model cannot choose a sender identity. It checks the Workspace registry's archive list, waits for the Session controller's activation while racing the caller's signal, then rechecks cancellation and the archive list. It builds the message with the `agent-message` source that `@deepseek-ai/dsh-subagent` declares, records the caller's `senderSessionId`, prefixes the text with `Session <caller session id> sent a message: `, and calls `steer()` on the target. The prefix differs from the `Agent <name> sent a message: ` prefix of `send_message`, whose names resolve only inside one subagent tree. Inbox failures propagate unchanged. The [tool pipeline](../../core/tools/README.md) applies its ordinary cancellation behavior. The Host presenter shows the target id and message text; the [Web tool card](../../client/ui-tool/README.md) derives the accepted state and message ID from the recorded result.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the tool definition, failure codes, archive checks, and activation wait |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Send a message to another Session](../../../docs/user/session-control.md) — enable the tool in a Web profile.
- [API Session Controller](../../api/session-controller/README.md) — Session activation, restoration, and ownership.
- [Subagent control](../../subagent/tool-subagent-control/README.md) — `send_message` within a subagent tree.
- [Tools](../../core/tools/README.md) — invocation, cancellation, and result recording.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema and result

#### What the model sees

The [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-session-control) defines the exact schema. The description instructs the model: "Use this tool only when the user explicitly asks you to send a message to another session." The schema exposes neither sender identity nor permission overrides. A successful call returns one JSON text block, `{"message_id":"..."}`, that confirms inbox insertion, not completion or a reply. Target cancellation or disposal can leave the message unprocessed. A rejected call returns `Error: <message>`; a subagent target reads `session "<id>" is not available to session_send_message`.

#### Token effect

The schema contributes prompt tokens whenever the tool is visible. Each call adds its arguments and a compact receipt to the caller's history.

#### KV Cache effect

Enabling or disabling the row changes the tool schema list and may invalidate reuse from the first changed schema token. Calls and receipts append to ordinary history without rewriting earlier messages.

### Delivered message

#### What the model sees

The recipient receives one steering user message: a text block `Session <caller session id> sent a message: ` followed by the message text unchanged.

#### Token effect

The recipient's history gains the prefix and the message text.

#### KV Cache effect

Append-only in the recipient; the message joins at its next input boundary without rewriting earlier messages.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Web compositions only** — only the dsh-web-app bundle declares the row; the `headless`, `sdk`, `sdk-minimal`, and `acp` profiles mount no Session controller and offer no `session_send_message`.
- **Subagent targets are unavailable** — a subagent can send to an ordinary Session, but that Session cannot reply to it with this tool. The separate `send_message` tool can address only members of the caller's own subagent tree.
- **Automatic reply loops** — automatic replies can repeatedly wake two Sessions and consume tokens. The explicit-user-request instruction relies on the model; the runtime applies no message-rate or hop limit.
- **Text only, no reply wait** — messages carry text only; the tool attaches no files and does not wait for the recipient's turn or answer.
- **Restored Agents stay resident** — a cold target restored for a message stays loaded under the Session controller, like a Session opened in the GUI.
- **No safe retry after an unknown outcome** — acceptance is not idempotent; callers must retain known successful receipts and must not repeat a send automatically.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
