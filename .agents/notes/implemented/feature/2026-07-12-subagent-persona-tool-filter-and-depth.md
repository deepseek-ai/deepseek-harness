# Agent Note: Configure subagent persona, tool visibility, and depth

Status: implemented

English | [中文](2026-07-12-subagent-persona-tool-filter-and-depth.zh.md)

## Problem

A reusable subagent provider answers how to run a child, but different delegation tools need different child behavior. One deployment may want a reviewer persona, a research-only tool set, or a hard recursion bound without creating a new provider for every combination.

These controls affect the child's first model request and therefore cannot be installed after the child is visible. They also need honest provider support: an ACP backend cannot silently accept an in-process-only tool filter, and a filter must not be described as a security boundary when every plugin runs in the same trusted process.

## Decision

Subagent starts have three independent composition controls: `persona`, `toolFilter`, and `maxDepth`. A provider advertises support for each control, the service rejects unsupported requests before starting a run, and an in-process provider installs the requested composition while the child is still unpublished.

The controls answer different questions:

| Control | Question | Result |
|---|---|---|
| `persona` | What role instructions replace the deployment persona for this child? | A child-local prompt section shadows `deployment:persona-prefix` |
| `toolFilter` | Which deployment-global tools enter this child's visible tool view? | A scoped restriction filters globals before child-local tools are added |
| `maxDepth` | How deep may this delegation tree grow? | A start whose child depth exceeds the absolute cap is rejected |

`dsh-tool-subagent` exposes the controls as plugin configuration and copies them into each request it creates. Direct `SubagentRuntime` callers may choose them per request. The provider capability descriptor remains the source of truth for whether a backend can honor each field.

### Persona is a scoped shadow

The persona control changes one child without changing deployment-wide prompt assembly. During unpublished setup, an in-process provider registers a child-scoped section named `deployment:persona-prefix`; ordinary most-specific-wins resolution replaces the global section only in that child's assemblies.

The value has the same strict template semantics as the deployment persona. Omitting it inherits the deployment section through the global layer; an explicit empty string shadows the global persona with an empty section. Parent and sibling personas never enter the child's flat scope.

This uses the normal system-prompt registration mechanism rather than a second persona channel. The first prompt therefore sees the same named contribution that later prompts and prompt-inspection tools see.

### Tool filtering is one live global-view rule

The tool filter controls capability visibility and executable lookup together. An in-process provider installs `ToolRuntime.restrict()` in the child's scope before publication, and the registry's single resolver applies the same result to wire tool schemas, lookup, execution, and PTC mode SDK generation. Independently registered system-prompt sections are outside `ToolRuntime`, so filtering a tool does not remove that plugin's standalone guidance.

Resolution follows these rules:

1. Each restriction applies `allow` before `deny` to the live deployment-global tool registry.
2. Multiple restrictions intersect, so every installed restriction must admit a global tool.
3. Child-scoped tools are added after global filtering and may shadow an admitted global tool.
4. Reserved `run_code` presentation and other scope-local protocol contributions are outside the global filter.

Configuration fails loudly when a filter supplies neither `allow` nor `deny`, or names something outside the current global restrictable set, including a scope-local-only or reserved name. `allow: []` is valid and deliberately hides every global tool. These checks catch misspellings and prevent configuration from appearing effective when it cannot affect the named entry.

The global registry remains live. A deny-only filter admits a later global name unless it explicitly denies that name; an allow-list excludes a later global name unless it explicitly allows that name. Removing a global tool removes it from every resolved view. These semantics preserve hot registration while making the difference between allow and deny explicit.

### Depth is an absolute tree cap

The depth limit bounds recursive delegation independently of tool visibility. A top-level agent has depth zero; an in-process child has its parent's validated depth plus one. `maxDepth` is an absolute non-negative safe integer, and a start rejects before child ownership begins when the derived child depth is greater than the cap.

The effective parent depth is the greater of durable `SessionHeader.delegationDepth` and runtime `AgentOptions.subagentDepth`. An in-process child records its derived depth in the session header, and resume restores that header, so a restart cannot lower the recursion count.

Every public entry validates the domain rather than relying on one model-facing configuration path. Negative values, fractions, negative zero, non-finite values, unsafe integers, malformed stored parent depth, and derived overflow all reject. A direct `SubagentStartRequest` may omit the cap to leave depth unbounded; loader-resolved `dsh-tool-subagent` configuration instead defaults to `3`, accepts a numeric override, and uses explicit `'provider-managed'` to omit the cap for an out-of-process provider whose deployment owns its recursion budget. Three is a small finite default that still permits a root plus three descendant generations, and the [base profile](../../../../packages/bundle/base/cordis.patch.yml) uses that general policy. A numeric tool cap fails at provider mount when the provider lacks `depthLimit`.

A deployment can combine depth and filtering, but the numeric cap does not synthesize a filter. The delegation tool stays visible at the cap because authorization may depend on runtime state; every attempted start checks the calling agent's current durable and runtime depth, and a rejected start returns an errored tool result without publishing a child. A deployment may separately deny delegation tools in children when its visibility policy is static. Neither choice changes the provider's conversation-history behavior.

### Capability gating keeps providers honest

Capabilities separate a requested feature from a provider implementation. `SubagentCapabilities` advertises `persona`, `toolFilter`, and `depthLimit`; `SubagentRuntime.start()` checks every present request field against those flags before calling the provider.

This lets spawn and fork providers share the in-process implementation while external providers advertise only what they can enforce. A request never degrades silently: selecting an unsupported control produces `UNSUPPORTED_CAPABILITY`, and no run or lifecycle event exists.

### Unpublished setup makes the first request correct

All child-local composition is complete before the child becomes observable. The in-process provider supplies one setup callback to agent creation; that callback installs persona, tool restriction, and structured-output contributions in the child's scope. Only after setup succeeds does creation publish the session and agent and allow the driver to start.

A setup failure rolls back the private child. No observer can acquire a child whose first prompt used the deployment persona or unfiltered tool set and whose later prompts use the requested configuration.

## Visibility is not authority

These controls compose trusted same-process behavior; they do not authorize it. `toolFilter` changes the child view resolved by the tool registry, but it does not create a parent-to-child grant lattice, require a child to be a subset of its parent, sandbox plugins, or prevent code with another Cordis context from calling services directly.

In particular, a child-local tool is added after the global filter and may be absent from the parent's view. A deny-only child also sees later global tools not named by the deny-list. Those are deliberate live-composition semantics, not non-escalation guarantees.

A security design would need a separate authority representation, propagation rule, and execution-time enforcement point. Creation-time grant snapshots, parent-subset grants, explicit future-grant APIs, and generic capability/output/termination tags are outside this feature.

## Alternatives considered

**Create one provider per persona or tool set.** This multiplies providers that share the same transport and lifecycle implementation, makes dynamic deployment configuration awkward, and still needs a recursion mechanism. Providers remain about execution transport; requests carry per-child composition.

**Copy the parent's complete tool view.** Registration scope is flat by design, and lifetime ownership does not imply visibility inheritance. Copying a resolved view would also freeze dynamic global registrations and conflate composition with authority without defining either contract fully.

**Snapshot allowed global tools at child creation.** A frozen allow-set makes future registration uniformly unavailable, but it changes hot-registration semantics and starts an authorization design. The implemented filter stays a live registry predicate and documents allow-versus-deny behavior directly.

**Hide only tool schemas.** Presentation-only filtering lets the model execute a tool that the prompt says does not exist through PTC mode or a forged call. One resolver governs both presentation and execution instead.

**Encode the depth cap as an automatic tool filter.** A creation-time filter snapshots a decision that may depend on runtime state, affects only one configured tool name, and does not protect direct service callers or alternate delegation tools. The provider instead enforces the absolute cap at every start.

## Consequences

Contributors can configure child role, visible global tools, and recursion without defining new providers. Capability checks fail before ownership starts, unpublished setup makes the first request consistent, and one tool resolver prevents presentation/execution drift.

The cost is that deployments must understand live allow/deny behavior and the distinction between visibility and authority. A model may call a visible delegation tool after the current depth policy forbids another child and receive an error. Provider authors must advertise each supported control accurately, and in-process providers must install every requested contribution before publication. The controls deliberately do not solve security confinement or parent-to-child non-escalation.
