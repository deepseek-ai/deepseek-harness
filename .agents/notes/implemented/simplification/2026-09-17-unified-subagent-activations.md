# Agent Note: Unified subagent activations

Status: implemented

English | [中文](2026-09-17-unified-subagent-activations.zh.md)

## Problem

Local one-shot execution and continuable residency separately owned child creation, cancellation, structured capture, results, and cleanup. Foreground and Job-backed tool paths added more ownership paths. Workflow code still needed to await a result, while external backends needed one process execution without acquiring a multi-turn protocol.

## Decision

`startActivation()` is the consumer entry point for every provider. A published handle exposes child identity, a result promise, and disposal of that exact activation. The caller signal cancels unpublished creation only. Local results wait for pending input and owned descendants before closing admission, so descendant replies can contribute to the final answer. Both local and external result promises settle after cleanup and notifications. Parent waits use that same completion promise; a captured execution result survives cleanup failure, which disposal reports separately. Workflow consumers already wait for cleanup before continuing, so activation ownership needs no independent result-readiness and release signals.

Local spawn and fork providers contribute only `prepareContinuable()` data; the subagent service owns Agent creation and residency. The standalone in-process driver package is removed. Structured tools, validation, instructions, and terminal guards attach to one activation and close with it. After capture, that activation rejects further input; cold resume reconstructs an ordinary conversation without the previous schema.

ACP, DSH SDK, Codex, and Claude Code retain their existing single-execution provider adapters. They join the same activation capacity and ownership graph without accepting follow-up messages or fabricating a local child Session. The parent-owned catalog registers every local child and parent-delivery external leaves. Local membership remains independent of result delivery so completed workflow Sessions and their descendants stay discoverable. Caller delivery leaves external membership tracking to its consumer. External entries carry `mode: 'external'` because they have no local Session to open. Creation records membership once; execution and cleanup do not update the catalog. Execution status has no required consumer and remains outside the membership record. Caller delivery returns the complete result; parent delivery queues the complete completion notice.

The model-facing tool always returns a background child id and promises the manager's completion notice. It has no foreground switch or Job integration. Workflows select caller delivery, await the activation result, and dispose the handle before finishing; they add neither a completion notice nor initial return guidance to the parent/child exchange. Headless completion waits for its own child tree and subsequent parent turns.

Parent completion notices include final text regardless of `send_message` availability or use. Tool availability cannot establish that the child sent its answer: it may send only progress or finish without calling the tool. An answer already sent through the tool can appear twice; accepting that duplication avoids making result delivery depend on model compliance or another delivery ledger.

### Retained decisions

The native Session reader rejects duplicate child membership for both local and external catalog entries.

The [continuable residency](../feature/2026-07-28-continuable-subagent-conversations.md), [fork request prefix](../architecture/2026-08-10-fork-children-stay-one-shot.md), and [parent-owned catalog](../architecture/2026-09-01-parent-owned-subagent-catalog.md) records retain their independent rationale. The [subagent package reference](../../../../packages/subagent/subagent/README.md) owns current provider, result-delivery, and activation-capacity contracts; the corresponding [capability seam](../../archived/feature/2026-06-21-subagent-capability-seam.md), [settlement delivery](../../archived/feature/2026-08-06-manager-owned-subagent-settlement-delivery.md), and [capacity](../../archived/feature/2026-09-15-continuable-activation-capacity.md) records remain historical snapshots. This decision owns the shared entry point, external participation, and caller-versus-parent result delivery.

Released Session generations remain immutable. Historical one-shot descriptors stay readable; removing current execution paths does not justify rewriting or discarding durable history.

## Alternatives considered

**Keep a separate external execution projection.** It duplicates membership, restoration, and client update handling already supplied by the parent catalog. Repeated directory snapshots would also retransmit every retained result. The catalog retains only membership; results remain with their recipient.

**Keep one-shot local execution for synchronous workflows.** Awaiting a result is a consumer requirement. A second Agent lifecycle duplicates cancellation and cleanup solely to supply a promise, which the activation can supply directly.

**Add multi-turn support to every external backend.** This expands backend protocols, recovery, and authenticated routing without being necessary for shared ownership. The adapters retain their existing execution capability.

**Use Jobs for all background children.** Jobs add a second work registry and cancellation authority beside activation residency and the Agent inbox. Child discovery and completion already belong to the subagent service.

**Send every result to the parent.** A workflow already consumes and presents its child result. Another wake adds duplicate context and can disturb a parent that is awaiting the workflow tool. Delivery is an explicit consumer choice; the model-facing tool's notice remains unconditional.

## Consequences

One manager controls admission, cancellation, ownership, and resource release across providers. Workflow result collection remains synchronous at its API, while model delegation leaves the parent's tool step promptly. External children share accounting and durable discovery but gain no continuation or independent result archive. Restoring foreground or Job-backed local execution would require a concrete capability that result collection through an activation cannot provide.

## Verification

Focused tests cover local spawn/fork inheritance, structured capture and schema-free cold resume, explicit cancellation, external catalog membership, result-versus-disposal ordering, workflow collection without parent notices, and headless child-tree completion. Existing replay generations are preserved; updated recorded-session cases cover the current model-visible tool and notice behavior.
