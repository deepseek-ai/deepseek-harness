# Agent Note: Explicit Agent identity at runtime boundaries

Status: implemented

English | [中文](2026-08-31-explicit-agent-runtime-identity.zh.md)

## Problem

An Agent's Cordis Context owns registrations and their cleanup. Agent identity instead selects the Session, runtime owner, event subject, authority decision, or wire identity for one operation. A reverse Agent property on Context made those two facts appear interchangeable: a caller could choose a Context for effect ownership and accidentally let that choice determine domain identity.

The reverse association also required compensating mechanisms after type erasure. Host Remote forwarding inspected a routed subject for its Context, creation inferred runtime parentage from the caller Context, and adapters maintained reverse identity scans. These mechanisms duplicated identity already present in typed requests and obscured which caller owned an Agent at runtime.

Without an explicit owner, `SubagentManager` creates and resumes children through its private plugin Context, so Context-based inference classifies every continuable child as a runtime root even though the manager holds its exact parent. Root-only consumers could then attach scheduling tools, grant direct-human goal authority, or route user questions as if the child were top-level.

## Decision

Runtime interfaces carry Agent identity at the point that owns it. `AgentSetup` receives `(agentCtx, agent)`; each subagent Activation retains its exact runtime root; scoped events carry their Agent in the payload; Remote forwarding verifies that `request.agent` is the carrier key; and Host Typert Context resolution maps wire identity to a live Agent Context without a reverse scan. `agent.ctx` remains the registration and lifecycle owner and exposes no reverse Agent property.

Scope-aware registries continue to use the opaque scope key only for registration membership. Tool-subagent does not classify that key or resolve an Agent from Context. A direct `AgentSetup` receives the Agent explicitly and installs through the supplied Context before Agent publication. For a settings-backed standing preset, the event payload supplies the Agent, its Session supplies the policy target, and its Context owns the registrations.

`SubagentManager.rootOf(agent)` reads runtime membership from existing Activations; both the child and root must match their live registry objects. Ordinary Sessions resolve to themselves, and unmanaged subagent headers grant no membership. Durable `parentSession` describes creation edges; an Activation retains the exact root while intermediate creators are offline, and same-id replacements cannot inherit it. Root-only consumers classify the explicit subagent origin.

The [scope reference](../../../../packages/core/scope/README.md) and [Agent loop reference](../../../../packages/core/agent-loop/README.md) document registration and lifecycle behavior. The [initiator-scope decision](2026-07-15-agent-initiator-scope.md) owns private-chain rationale; explicit runtime ownership does not change causal initiation or registration lifetime.

## Verification

Managed-child tests verify intermediate-creator disposal and exact-instance checks after child or root replacement. SDK approval tests verify routing during a turn after the direct creator exits. Schedule and user-question tests reject delegated Sessions while ordinary historical forks remain independent.

Remote-event tests reject a missing or mismatched Agent before forwarding a scoped waterfall. Tool-subagent tests verify that direct setup installs before Agent publication; standing-preset tests verify per-Session policy sampling and inheritance.

## Alternatives considered

**Keep `Context.agent`.** A reverse accessor makes registration ownership look like operation identity and requires every Context derivation, adapter, and test double to preserve an association unrelated to Cordis service selection or effect cleanup.

**Infer runtime ownership from the caller Context.** A private manager Context, an Agent Context, and a standing preset Context can all call the same factory. Context ancestry therefore does not state which live Agent owns the result; the subagent Activation retains the exact root supplied at admission.

**Classify Agent scope keys.** An opaque scope key states routing membership, not domain identity. Classifying it would make Agent the center of composition and would still couple a plugin's effect owner to the Session whose policy it needs.

**Use the initiating Agent as creation ownership.** Initiator scope records causal asynchronous execution, not lifetime ownership. A parent may initiate work that intentionally creates a root, and setup remains outside the child's driver boundary.

**Use durable Session lineage.** `parentSession` records creation ancestry across process lifetimes. An intermediate creator can be offline while its descendant remains managed by a live root; durable ids also cannot distinguish replaced Agent instances. Historical ordinary forks may retain parent metadata without being delegated.

## Consequences

Lifecycle options, events, service requests, and transport requests carry explicit Agent identities, so each operation states the identity it uses and TypeScript checks both sides. Context remains reusable for dependency access and effect ownership without becoming an alternate domain-object locator.

Continuable children have one runtime root independent of creator residency. The subagent manager owns tree teardown and local membership; the core factory and registry retain only instance creation, publication, and disposal. Third-party callers create managed children through the subagent service rather than assigning ownership to arbitrary factory-created Agents.
