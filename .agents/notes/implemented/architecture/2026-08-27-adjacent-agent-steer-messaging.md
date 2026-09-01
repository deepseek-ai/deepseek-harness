# Agent Note: Adjacent Agents share one Steer send_message operation

Status: implemented

English | [中文](2026-08-27-adjacent-agent-steer-messaging.zh.md)

## Problem

Continuable Agents originally used direction-specific model controls. A parent called `send_message({ subagent_id, message })`, which delegated to a FIFO `followup` service operation. A child instead received a child-scoped `report({ output })` tool, a `tool:report` system-prompt section, and deployment-selected quiet or waking delivery. The tools described one adjacent-Agent operation through different schemas, service paths, provenance, and scheduling.

A continuable child owns its own Session, so its parent does not automatically receive the child's transcript, tool output, or reasoning. The return path must therefore remain explicit and repeatable: a child may send progress before it finishes, remain available after sending, or fail before it can cooperate. Turning every final assistant message into an implicit result would conflate turn completion with model-selected communication and would not cover abnormal endings.

The child-only tool and system-prompt section also preceded every inherited fork turn. They made a continuable fork child's request head differ from its parent's before the history that fork exists to reuse, forcing the provider to prefill the entire copied transcript again.

## Decision

`SubagentRuntime.sendMessage(sender, targetId, content, { signal })` is the only public model-authored message operation. The continuation manager accepts only the exact live sender and a target on one adjacent edge:

- parent to direct continuable child, authorized by the child's durable `SessionHeader.parentSession`;
- resident continuable child to its exact live direct parent, authorized by the child's Activation.

Siblings, self-targets, ancestors beyond one edge, stale Agent objects, unknown targets, and one-shot children are not alternate routes. The operation has no caller-supplied source, delivery mode, offline parent mailbox, or provider dispatch.

Every accepted message uses `Agent.steer()`. A running target receives it at the nearest step boundary; an idle target starts a turn. An absent direct child is cold-resumed through the existing continuation lifecycle before the same Steer delivery. The manager retains waking-send accounting so a continuation-managed target cannot settle between synchronous inbox insertion and driver admission.

Every direction uses one durable source. The service derives `senderSessionId` from the authorized Agent and frames the model-visible content as `Agent <sender-id> sent a message:`, so attribution cannot diverge from authority.

```ts
import type { SessionId } from '@deepseek-ai/dsh-session'

interface AgentMessageSource {
  readonly kind: 'agent-message'
  readonly form: 'relay'
  readonly senderSessionId: SessionId
}
```

### One model tool and one return instruction

The globally registered model tool is direction-neutral and has one fixed schema:

```ts
interface SendMessageInput {
  readonly agent_id: string
  readonly message: string
}
```

Parents and children inherit the same definition in the same registry order. The standard definition carries a process-stable internal identity that a scoped same-name tool does not satisfy. A child `toolFilter` may explicitly remove the inherited tool, and a scoped replacement may provide different semantics; neither case receives the standard call instruction. When the standard tool remains visible, the continuation manager appends the JSON-encoded direct parent id and the instruction to send one self-contained result before finishing, plus earlier actionable findings, to the child's initial user task. For a fork child this task follows the inherited completed-turn prefix; no child-only system-prompt section or tool schema precedes that prefix.

The instruction is guidance, not settlement enforcement. Sending does not end the child's turn, zero or several calls remain mechanically valid, and the runtime never rejects a child for staying silent. The manager-owned `subagent-settled` notice remains unconditional and separately attributed because it records how an Activation ended and preserves terminal output when the child cannot cooperate.

Human browser prompts are not model-authored Agent messages. The remote prompt path keeps a private Queue delivery so each human prompt remains a distinct turn. Interrupt behavior and settlement delivery remain independent.

### Complete removal and reintroduction condition

The standalone `@deepseek-ai/dsh-tool-subagent-report` package, `report` schema, `tool:report` prompt section, `reportDelivery` configuration, report-specific message source, catalog entries, composition rows, and supported-behavior snapshots are absent. The unified tool gives up the recipient-free child shortcut and the old ability for a structural return tool to survive an explicit child allow-list. Those capabilities return only if a concrete use case requires semantics that an adjacent `agent_id` and fixed Steer cannot express; reintroducing them requires a distinct model operation and prefix-cost evidence, not an alias over `sendMessage()`.

## Alternatives considered

**Keep `followup` and add child-to-parent routing.** The name promises a later turn and inherits `Agent.followup()` semantics. It would obscure the chosen nearest-step behavior and preserve a parent-centric name for a direction-neutral capability.

**Keep a recipient-free `report` wrapper over `sendMessage()`.** This preserves a convenient child shortcut and lets a scope-local registration survive global tool filtering. It loses because the separate schema and prompt duplicate one operation, make parent and child request heads differ, and let equivalent directions drift again.

**Make `report` global.** Roots, one-shot children, remote children, and agentless callers cannot derive a report recipient. Advertising it globally would make schema visibility disagree with authority, while `send_message` already makes the recipient explicit.

**Turn every child final message into an implicit send.** A long-lived child may have nothing useful to send in one turn and several findings in another. Automatic delivery would merge model-authored communication with the runtime's settlement account and could not replace the unconditional notice on errors, cancellation, or token exhaustion.

**Rely only on the tool description.** A tool description helps after the model considers that tool; the failure mode is a child that believes it is finished without considering any return call. Initial-task guidance reaches that decision without changing the inherited system or tool prefix.

**Keep quiet delivery as deployment policy.** A quiet model-authored message can be accepted while an idle target never reads it. Fixed Steer gives both directions one delivery meaning and preserves accepted order with later settlement notices.

## Consequences

- Model consumers expose one `send_message({ agent_id, message })` definition to parents and children, with no model-selected Queue versus Steer parameter.
- The continuation manager remains the sole owner of adjacency authorization, residency, cold resume, waking admission, and teardown races.
- Accepted messages may extend a running target's current turn; messages waiting together share next-step FIFO ordering.
- Caller cancellation owns work only until inbox acceptance and does not retract an accepted message or dispose the target.
- The initial task carries JSON-encoded dynamic parent addressing after a fork prefix, while the request-head system prompt and tool ordering remain reusable.
- Human prompts, settlement notices, QueueDock, and the base bundle's one-shot fork policy remain separate decisions.

This decision consolidates and removes the fully superseded report-tool and child-report-obligation records. It supersedes the `followup` naming choice in [Intent-named subagent continuation operations](../simplification/2026-07-27-intent-named-subagent-continuation-operations.md) and retains the accepted-order guarantee in [Child Agent messages precede their settlement notices](../bug-fix/2026-08-17-subagent-message-settlement-ordering.md).
