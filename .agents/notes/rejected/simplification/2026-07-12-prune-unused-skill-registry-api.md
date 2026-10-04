# Agent Note: Prune unused skill registry API

Status: rejected — Direct runtime skill registration is an intentional extension path for third-party plugins.

English | [中文](2026-07-12-prune-unused-skill-registry-api.zh.md)

## Problem

The skill service's embedded-runtime subsystem has zero production caller of `ctx.skills.register()`. It adds a reserved `runtime` provider name, a runtime map/rank/source, duplicate policy, a second revision in cache keys, normalization, disposers, and tests alongside the provider contract every shipped skill already uses. `SkillSummary.whenToUse` and candidate/definition `path` are parsed and copied but never read by a production consumer: the model catalog renders name/description, resource loading uses `resourceBase`, and providers own their locator. The deliberately open `metadata` extension point stays.

## Proposal

Remove `SkillRegistry.register()`, `SkillRegistration`, the runtime pseudo-provider and reserved-name rules, runtime revisions/cache branches, and runtime-only source/rank normalization. Tests that need an embedded skill register a small real provider. Retain `providerRevision` as the in-flight discovery epoch, but key completed catalogs by cwd alone: every provider mutation synchronously clears the cache, and the post-await revision comparison already prevents inserting stale work. Remove `whenToUse`, `SkillCandidate.path`, and `SkillDefinition.path` from the skill contract and local-provider copies while retaining provider locator/root paths; retain `metadata`, `disableModelInvocation`, `source`, `provider`, `locator`, and `resourceBase` as either deliberate extension vocabulary or production-consumed fields.

Amend the skill-system Agent Note, README, JSDoc, catalogs, and tests. Agent-scoped system-prompt sections, tool providers, and variables are explicitly outside this proposal: the [agent-scope contributor contract](../../../../packages/core/scope/README.md) intentionally allows all three to be registered during `setup(agentCtx)` through the agent-owned context, so absence of a fixed in-repo scoped registration is not evidence of non-consumption.

## Alternatives considered

**Keep runtime skill registration for embedders.** It is a deliberate synchronous direct-definition convenience in the implemented skill Agent Note. A small provider wrapper can expose the same embedded data under effect-owned lifetime, but it must implement async `list()`/`get()`, carry provider identity, and accept provider duplicate semantics. The proposal chooses that one regular path over preserving a second ranking, validation, cache-invalidation, and lookup path.

## Acceptance criteria

- Skill collection has one provider-backed path, a cwd-only completed-cache key, and a revision epoch only for in-flight invalidation; retained skill fields have a production reader or a recorded deliberate extension contract.
- Agent-scoped prompt sections, variables, tool providers, tool guards, and structured-output commit behavior in native and PTC mode remain unchanged.
- Typecheck, coverage, snapshots, doc-sync, module-graph verification, build, and hygiene pass.

## Risks

This is a compile-visible contraction of the pre-release skill registry. External programmatic `list()`/`get()` consumers lose `whenToUse` routing hints and candidate/definition `path`; the shipped model catalog never renders them, and resource resolution keeps its explicit `resourceBase` plus provider-owned opaque locator, but those fields are not observationally identical. Skill-local frontmatter parsing must continue to preserve and validate the supported metadata schema, and external providers remain able to supply embedded, filesystem, remote, or other skill sources.
