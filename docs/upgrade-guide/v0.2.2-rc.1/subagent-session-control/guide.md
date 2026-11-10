---
kind: upgrade-guide
description: "Custom Session controllers and subagent messaging must mount the shared Session control services."
---

# Custom Session controls require shared services

English | [中文](guide.zh.md)

## Change

Custom compositions that use `send_message` or `ctx.subagents.sendMessage()` must mount `@deepseek-ai/dsh-session-control`. Subagent messaging previously delivered directly through the subagent manager; it now uses the shared service for message identity, attribution, and target ordering. Without that service, messaging fails instead of taking an alternative delivery path. The existing tool arguments, tree permissions, and restoration restrictions remain unchanged.

Custom compositions mounting `@deepseek-ai/dsh-api-session-controller` also require `@deepseek-ai/dsh-session-control-local`, which owns ordinary Session activation. The base bundle supplies both services.

After the target accepts a `send_message` call, a later caller cancellation preserves its successful receipt. Previously, tool execution could replace the receipt with an aborted result even though the target had already accepted the message. Cancellation before acceptance still fails the call; neither case retracts an accepted message.

## Migration

1. Add `@deepseek-ai/dsh-session-control` to the package dependencies of a custom profile or bundle that resolves plugin packages. Add `@deepseek-ai/dsh-session-control-local` when the composition mounts the API Session Controller.
2. Mount one `@deepseek-ai/dsh-session-control` row in the Host context shared by the Agents and subagent service. Mount `@deepseek-ai/dsh-session-control-local` in that context when the API Session Controller is present. Keep existing providers and tool rows; the new `session_send_message` tool is optional.
3. Restart the composition. Send a message between two Agents in the same subagent tree and confirm that the existing tool returns its receipt and the recipient records the sender's Session id. For a custom Controller composition, confirm that creating and resuming an ordinary Session still work.
4. Retain successful receipts even if the caller was cancelled. A cancellation racing accepted delivery is not a reason to repeat the send. See [Session control](../../../subsystems/session-control.md) for acceptance semantics.
