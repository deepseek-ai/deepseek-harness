# Agent Note: Reject human interaction from runtime-owned subagents

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-01-ask-user-delegated-caller-guard.zh.md)

## Problem

A one-shot subagent that calls `ask_user_question` can block indefinitely. The call waits for a human answer, but the child has no independently owned human channel, so the child's completion and the parent waiting on that completion both stall.

Durable session lineage cannot decide whether an answerer exists. A child session may later be resumed as a new top-level runtime root, while a live runtime-owned child may carry a zero or absent durable delegation depth. Error guidance at the shared seam must also fit every consumer: `exit_plan_mode` uses `ctx.userQuestions.ask()` without calling `ask_user_question`.

## Decision

When `AskUserQuestionRequest.agent` is present, `UserQuestionService.ask()` authenticates the exact live agent through `ctx.agents` and admits it only when `ctx.agents.roots()` contains that instance. A missing registry or stale same-id object fails with `CALLER_NOT_LIVE`; a live agent owned by another live agent fails with `DELEGATED_CALLER`. The check runs after the existing aborted and empty-batch guards and before intent validation or provider dispatch, so an owned child never creates a UI wait.

Runtime ownership is the authority. A lineage-bearing session resumed without an owner is a runtime root and may ask; a live child remains ineligible even when its durable `delegationDepth` is zero. Agentless programmatic calls retain the existing provider path.

The shared failure text is consumer-neutral and actionable: the child includes the unresolved question or decision in its final result. The parent already receives that result through the delegation contract and can decide whether to ask the human. Neither the service nor a child claims an upward messaging or answer-forwarding capability that does not exist.

This safety boundary is independent of the browser's composer election. The proposed [semantic composer phases](../../proposed/architecture/2026-08-08-semantic-composer-chain-phases.md) address how an already-pending interaction and a read-only subagent surface should be ordered; they do not weaken this runtime guard.

## Alternatives considered

**Use `session.header.delegationDepth > 0`.** Rejected because durable lineage survives resume and does not attest the current process-local owner. It rejects valid resumed roots and can admit a live child whose durable header is incomplete.

**Reject only inside `dsh-tool-ask-user`.** Rejected because `exit_plan_mode` and direct callers share `ctx.userQuestions.ask()`. The service is the narrow operation boundary common to every human-interaction consumer.

**Tell the child to delegate upward or wait for forwarding.** Rejected because one-shot delegation exposes no child-to-parent request channel and no answer-forwarding protocol. The only guaranteed return path is the child's final result.

**Rely on the browser composer fix.** Rejected because presentation cannot make an ownerless human channel exist, and non-browser deployments still need the call to terminate.

## Consequences

Runtime-owned child calls fail fast with a stable structured error instead of hanging. Exact live roots and agentless programmatic calls remain eligible, including resumed sessions with historical child lineage. `ask_user_question` and `exit_plan_mode` receive the same neutral corrective guidance, while their model-visible schemas and system-prompt prefixes remain unchanged; only the appended error result differs, so existing KV-cache prefixes remain reusable.

## Testing

Service tests cover a zero-depth live child, a depth-one resumed runtime root, a missing registry, a stale same-id object, and provider non-invocation on every rejection. Tool and plan-mode tests prove both consumers surface the neutral `DELEGATED_CALLER` result and never reach the provider. The keyless assembled snapshot delegates to a child that attempts `ask_user_question`, pins the child's error tool result and final handoff, and proves the parent completes instead of waiting for an answer.
