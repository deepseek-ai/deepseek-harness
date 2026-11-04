# Agent Note: User controls address the target subagent

Status: implemented

English | [中文](2026-10-22-subagent-target-user-controls.zh.md)

## Problem

A browser knows the subagent it is displaying, but requiring its direct creator and a continuable marker makes every control caller repeat history metadata. A caller-supplied parent id checks address consistency without establishing the caller's identity or permission. Calls that resolve only the global access resource also cannot express a grant on one target Session.

## Decision

Browser prompts and `interruptByUser` address only the target child Session. Each Remote method explicitly declares that Session as its access resource; the Gateway checks the invocation's principal before attachment admission, restoration, or cancellation. A global or parent Session grant does not imply a child Session grant. Policies decide whether to grant both actions, either action, or inherited access. Same-process user interruption trusts its caller and does not accept a wire-supplied principal.

Prompt delivery derives the live root from the resident Activation or verified persisted creation edges. Only the cold target resumes; its creator can remain offline. Shared delivery retains exact live root checks, shutdown admission, cancellation, capacity, and final inbox acceptance. A root Session is not a target of the browser subagent prompt endpoint. User interruption addresses a resident Activation without persistence reads or restoration; an absent target remains a no-op, and interruption preserves parked input.

Model messages retain the exact live sender and same-tree rule from [tree-wide communication](2026-10-16-tree-wide-agent-communication.md). Model interruption retains its stricter ancestor rule. Creation parents still determine catalog edges, history-address consistency, ancestry, and completion recipients; they are not browser control credentials.

This supersedes the direct-parent addressing requirement for human continuation in [continuable subagents](../feature/2026-07-28-continuable-subagent-conversations.md). That record retains its inbox and durable continuation rationale; tree-wide communication owns its superseded model adjacency and runtime ownership restrictions. No Session format changes.

## Alternatives considered

**Keep the parent check as authorization.** The client supplies the parent id and can obtain it from history. Matching that id does not authorize the principal, and requiring it couples controls to discovery metadata.

**Require a root id from the browser.** The server already derives the runtime owner from the target. Another supplied id adds a consistency check without granting permission; Agent senders still need an independently resolved root to enforce same-tree messaging.

**Unify user and Agent interruption permissions.** A user with a target grant can stop that target, while an Agent may stop only its descendants. Same-tree collaboration does not grant members control over each other's execution.

## Consequences

Remote callers update their prompt fields, interrupt endpoint, and non-owner policy actions and resources; the [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-rc.2/subagent-user-controls/guide.md) owns the migration. History URLs retain parent ids for consistency checks. Cold host prompts may read creation ancestry twice, once to find the live root and again during restoration; no verified-ancestry cache is retained across asynchronous work.

Gateway tests cover target grants, global-only and parent-only refusal, separate send and interrupt actions, owner access, and refusal before side effects. Continuation tests cover nested and cold targets with online or offline creators, unavailable roots, and rejection of a root as a subagent target. The Web interrupt scenario exercises the renamed endpoint and parked-input behavior through the shipped composition.
