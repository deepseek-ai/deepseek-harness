# Agent Note: What stays host-plane once presets own the agent plane

Status: implemented

English | [中文](2026-08-10-host-plane-ownership-after-presets.zh.md)

## Problem

[Per-session agent presets](2026-09-18-declarative-agent-presets.md) moved every model-facing row onto the agent plane, and each later fix has been one reader that assumed the world before the move. `tasks` came back to the host because a preset row outside its realm resolved it; `goals` never left for the same reason; a child agent's `toolFilter` was repaired once every model-facing tool became an ancestor contribution rather than a global one ([child agents join their parent's preset](../bug-fix/2026-08-10-child-agents-join-their-parent-preset.md)).

Two more readers were still on the wrong side of that line.

`dsh-token-meter` was disabled on the host and mounted inside each preset's `compaction` realm. It takes no configuration, keys every fold by `Session`, and registers no tool or prompt section — but it owns the `tokenUsage`, `contextPressure`, and `contextBreakdown` projection units, and `sessionProjections` is a process-wide table with no scope layering. A unit registered from inside one preset therefore answers for every session: whether a `minimal` session showed a context meter depended on whether some *other* session had mounted `standard` since boot, and a process that only ever ran `minimal` showed none at all.

Nothing named an agent that joined no preset. The join is a scope-parent link; without it the `tools`, `system-prompt`, and `skill` views resolve the empty global layer and the model receives nothing — no error, no empty catalog, just an agent that cannot act. That is how delegated subagents ran for as long as presets existed, and the same hole is open at every entry point that predates them.

## Decision

**The meter is host-plane.** `dsh-token-meter` returns to the host composition and leaves the presets' `isolate` map, so `compaction-basic` and `tool-result-pruner` resolve the one host instance from inside their realm. The presets keep the realm and the backend — what a preset chooses is whether its agent compacts, not whether its tokens are counted. This is the criterion `tasks` and `goals` are already read by, applied to a Service whose *projection* reach is what made preset ownership wrong: a unit whose empty value is indistinguishable from a real one cannot be per-composition while the table it registers into is per-process.

**An unjoined agent fails at model use.** The invariant companion checks `system-prompt/assemble`, because a bare Agent can legally be bound later through `recompose`. Host-only and cold-scope prompt reads have no Agent and remain outside this check.

Projection key presence is not a per-session capability signal ([session projection](../../../../packages/session/session-projection/README.md)). Temporary plugins mounted through `cordis_mount` belong to the composition rather than the invoking session ([tool Cordis](../../../../packages/extensions/tool-cordis/README.md)). [Declarative presets](2026-09-18-declarative-agent-presets.md) own revision retention and reclaim retired trees after their final reference releases.

## Testing

`apps/cli/tests/web-agent-presets.e2e.ts` reads `ctx.get('tokenMeter')` on the booted Web composition before any Agent is created — a preset-side meter sits behind an `isolate` realm and is invisible to `ctx.get`, so the read is an ownership assertion rather than a mount-order coincidence — then asserts a `minimal` session's snapshot carries all three units.

`packages/preset/agent-preset-registry/tests/invariant.spec.ts` rejects an unjoined Agent's assembly and accepts a joined Agent, a Host read and a cold-scope read.

## Alternatives considered

**Keep the meter in the preset and scope-layer the projection registry.** The precise fix, and much larger: `snapshot`, `checkpoint`, and the eager drive would each need a session→scope resolution that a cold read does not have without the api-proxy's `presenterScopeFor`. Rejected as disproportionate to one Service with no per-preset state at all; the general rule is documented on the registry instead.

**Veto publication for an unjoined agent.** Loud beats silent, and the registry supports it — a synchronous `agent/created` listener that throws rolls the creation back. Rejected because composing an agent outside the roster is legal: `recompose` documents the bare agent it then binds, and the ACP bridge, the SDK server, and the headless bundle all create one. A veto would convert a capability gap into an outage.

**Check the join at `agent/created` in the companion too.** Rejected: publication cannot distinguish a missed join from an agent that will be bound later, so the check would reject a documented path. Prompt assembly can distinguish them.

**Move `plan-mode` and `tool-todo` off the agent plane for the same projection reason.** Rejected: both are genuinely per-preset capabilities, and their units compute an empty value for a session that never uses them, which clients already read by value (`plan.active`, an empty list). Only a unit whose empty value is indistinguishable from a real one — the meter — forces host ownership.

## Consequences

The context meter becomes a per-session fact instead of a function of mount history. A preset can no longer opt out of token accounting; no shipped preset did, and `minimal` now says it drops auto-compaction rather than the accounting.

The invariant reaches compositions loading `dsh-invariants`. Production entry points must compose Agents explicitly; installing the registry alone does not bind them.
