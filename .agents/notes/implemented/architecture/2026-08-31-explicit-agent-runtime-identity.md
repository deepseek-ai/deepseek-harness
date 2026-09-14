# Agent Note: Explicit Agent identity at runtime boundaries

Status: implemented

English | [中文](2026-08-31-explicit-agent-runtime-identity.zh.md)

## Problem

An Agent's Cordis Context owns registrations and their cleanup. Agent identity instead selects the Session, runtime owner, event subject, authority decision, or wire identity for one operation. A reverse Agent property on Context made those two facts appear interchangeable: a caller could choose a Context for effect ownership and accidentally let that choice determine domain identity.

The reverse association also required compensating mechanisms after type erasure. Host Remote forwarding inspected a routed subject for its Context, creation inferred runtime parentage from the caller Context, and adapters maintained reverse identity scans. These mechanisms duplicated identity already present in typed requests and obscured which caller owned an Agent at runtime.

Without an explicit owner, `SubagentContinuationManager` creates and resumes children through its private plugin Context, so Context-based inference classifies every continuable child as a runtime root even though the manager holds its exact parent. Root-only consumers could then attach scheduling tools, grant direct-human goal authority, or route user questions as if the child were top-level.

## Decision

Runtime interfaces carry Agent identity at the point that owns it. `AgentSetup` receives `(agentCtx, agent)`; Agent creation and resume options carry `parentAgent` for a runtime child; scoped events carry their Agent in the payload; Remote forwarding verifies that `request.agent` is the carrier key; and Host Typert Context resolution maps wire identity to a live Agent Context without a reverse scan. `agent.ctx` remains the registration and lifecycle owner and exposes no reverse Agent property.

Scope-aware registries continue to use the opaque scope key only for registration membership. Tool-subagent does not classify that key or resolve an Agent from Context. A direct `AgentSetup` passes the unpublished Session explicitly and installs through the supplied Context before publication. For a settings-backed standing preset, the event payload supplies the Agent, its Session supplies the policy target, and its Context owns the registrations.

`SubagentContinuationManager` puts the exact parent in both fresh-creation and cold-resume options. A live continuable child is therefore excluded from `AgentRegistry.roots()` and satisfies `isOwnedBy(child.id, parent)`. Durable `parentSession` metadata does not substitute for this relation: a fork or resumed Session may be a runtime root when no live Agent owns it.

The [Agent registration-scope decision](2026-07-08-agent-scope-contexts.md), its [runtime design](2026-07-12-agent-scope-runtime-design.md), and the [initiator-scope decision](2026-07-15-agent-initiator-scope.md) retain their independent registration, lifecycle, and private-chain rationale. This decision supersedes only the reverse Context association and implicit runtime-owner derivation described there.

## Verification

Agent creation tests pin explicit root and child ownership. Continuation integration tests keep a real child live long enough to assert both `roots()` exclusion and `isOwnedBy()` membership. Existing Schedule tests verify that root-only registrations stay absent from an explicitly owned child.

Remote-event tests reject a missing or mismatched Agent before forwarding a scoped waterfall. Tool-subagent tests verify that direct setup installs before Session publication; standing-preset tests verify per-Session policy sampling and inheritance.

## Alternatives considered

**Keep `Context.agent`.** A reverse accessor makes registration ownership look like operation identity and requires every Context derivation, adapter, and test double to preserve an association unrelated to Cordis service selection or effect cleanup.

**Infer runtime ownership from the caller Context.** A private manager Context, an Agent Context, and a standing preset Context can all call the same factory. Context ancestry therefore does not state which live Agent owns the result; the creator must put the parent it already knows in the request options.

**Classify Agent scope keys.** An opaque scope key states routing membership, not domain identity. Classifying it would make Agent the center of composition and would still couple a plugin's effect owner to the Session whose policy it needs.

**Use the initiating Agent as creation ownership.** Initiator scope records causal asynchronous execution, not lifetime ownership. A parent may initiate work that intentionally creates a root, and setup remains outside the child's driver boundary.

**Use durable Session lineage.** `parentSession` records conversation ancestry across process lifetimes. Runtime ownership controls live roots and teardown, so equating the two would prevent a legitimately resumed fork from becoming a top-level Agent.

## Consequences

Lifecycle options, events, service requests, and transport requests carry explicit Agent identities, so each operation states the identity it uses and TypeScript checks both sides. Context remains reusable for dependency access and effect ownership without becoming an alternate domain-object locator.

Continuable children have the same runtime parent relation as one-shot in-process children. Root-only consumers exclude them, parent teardown can reason from one live ownership graph, and durable lineage remains free to describe history rather than process-local lifetime.
