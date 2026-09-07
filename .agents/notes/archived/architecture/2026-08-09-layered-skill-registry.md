# Agent Note: The skill registry is host-held and layered per scope

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-09-layered-skill-registry.zh.md)

## Problem

The agent-preset stack moved the whole skill capability — registry, local provider, and the `skill` tool — into each preset's `isolate` realm, because "which skills an agent has" is an agent-plane choice. That framing conflated two different questions: which skills a *deployment* supplies, and whether an *agent* consumes them. A repository plugin's prepared wrapper declares `inject: ['skills']` and mounts its skill root as a host-plane provider; with no host registry composed in the web and headless profiles, that wrapper waited forever and the repository-plugin e2e hung, which was bypassed at the time by dropping the fixture's skill root. A per-preset realm registry also made the gateway's skill listing depend on a live agent — a cold session's `/` popup had no registry to read at all.

The tools registry never had this problem: it is one host singleton layered per scope over `dsh-scope`, so deployment-level tools (MCP servers, plugin entries) register globally while a preset's rows register into that preset's layer.

## Decision

`SkillRegistry` adopts the same shape. It holds `ScopedLayers<SkillLayer>`; `registerProvider()` and `register()` file into the layer of the calling context's scope, so host rows and repository plugins land in the global layer while a preset's `skill-filesystem` — mounted by the standing composition, whose context carries the preset's scope key — lands in that preset's layer. Provider names are unique per layer rather than process-wide, which is what lets every preset mount its own `local` provider.

Reads take the viewing scope through `SkillViewOptions` (the calling agent, which is its own scope key). The registry merges the global layer with the scope's chain: **the nearest layer wins a duplicate name outright, and rank decides duplicates only within one layer** — the tools registry's shadowing rule. Rank-pooling across layers was considered and rejected: ranks were designed to order sources that know about each other, and under a global pool a later-installed repository plugin could silently displace a preset's own same-named skill by registration-order tiebreak, changing a preset's behavior remotely. Nearest-wins keeps a composition's behavior decided by its author.

Discovery caches are keyed by the resolved scope chain plus one revision counter, so a blank-session recompose — which re-parents the agent's scope key without touching the registry — is visible to the next read.

The composition moves with it: the web-app bundle re-enables the base `skill` registry row (only `skill-filesystem` and `tool-skill` stay preset-owned), and preset compositions drop their `isolate: skills` realm for bare rows over the host registry. The gateway's skills domain reads the host registry in the presenter scope — the live agent, else the recorded preset's standing key — so a cold session lists the catalog its composition actually serves instead of failing; the `serviceFor` branch stays for compositions that still realm-mount their own registry.

## Consequences

**A deployment-level skill reaches every preset-composed session that mounts `tool-skill`.** The repository-plugin e2e's skill root and assertions are restored; the shipped-Web e2e proves the badge row (the same host-registration shape) merges into a standard-preset agent's catalog while the host view stays global-only.

**Layer visibility and consumption stay separate choices.** A `minimal` agent can read the global layer in principle, but composes no `skill` tool — whether an agent has skills at all remains the preset's decision, made by mounting or omitting `tool-skill`.

**Provider options are still the borrowed caller object.** `SkillViewOptions` extends `SkillLookupOptions`; the registry consumes `scope` and providers read only their own contract from the same readonly object, preserving the existing borrow-identity guarantee.

**The TUI profile is unaffected.** With every row at host, there is exactly one (global) layer and the merged view equals the old single-registry view, ranks and all.

**Shadowing across layers is silent.** Within a layer the loser is logged as before; a nearer layer replacing a farther name follows the tools registry's convention and logs nothing. The registry still exposes no API to inspect shadowed definitions.

## Alternatives considered

**Rank pool across all visible layers.** Faithful to the single-registry precedence, but cross-layer ties break on registration order (boot-time providers always beat standing mounts), and a preset's own skill could be displaced by a deployment change it never sees. Rejected for composition stability; see Decision.

**Keep per-preset realm registries and deliver repository skills as directories a preset's provider scans.** Leaves the wrapper's `inject: ['skills']` contract broken (or forks the wrapper per profile), duplicates discovery configuration into every preset, and still gives cold sessions nothing to read. Rejected.
