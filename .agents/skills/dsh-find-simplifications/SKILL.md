---
name: dsh-find-simplifications
description: Find evidence-backed simplifications in DeepSeek Harness code, APIs, configuration, tests, and prose; write or consolidate proposals, identify small inline cleanups, or assess simplifications from another branch. Use for removing dead, duplicated, speculative, or unnecessarily maintained behavior and infrastructure.
---

# Finding DeepSeek Harness Simplifications

Find changes that remove maintained obligations: APIs, representations, lifecycle states, configuration paths, dependencies, tests, or documentation. Prefer a few well-supported candidates over a count of deletions. This is guidance, not a checklist; keep the user's scope and distinguish a survey from permission to implement its proposals.

## Establish scope and constraints

Read `AGENTS.md`, [architecture](../../../docs/architecture.md) before judging packages, [defensive patterns](../../../docs/defensive-patterns.md), and [testing policy](../../../docs/testing.md). Consult the relevant active Agent Notes for intentional decisions; use the [note rules](../../notes/README.md) for new records. Archived notes are historical examples, not current authority: never inspect, verify, or repair their outbound links.

The two LLM adapters are intentional. JSONL is the sole first-party Session persistence provider, while the backend-neutral Service Definition supports out-of-tree providers. Do not propose deleting an LLM twin or the persistence seam unless the user explicitly overrides that constraint. Unused members within a protected design remain candidates when their removal preserves its purpose.

For broad requests, divide independent domains among subagents: loop and persistence; model/tool assembly; Host, Client, and SDKs; subprocess and execution providers; composition, scripts, tests, and documentation. Give each agent a bounded domain and require consumer evidence and rejected alternatives. Inspect substantial production machinery as well as obvious unused symbols; do not stop after the first promising deletion.

## Search for removable obligations

Use these questions to guide discovery. Read the relevant section of [historical patterns](references/historical-patterns.md) when a candidate needs calibration; the examples illustrate decisions, not a current deletion inventory.

- **Does a declared feature have a complete effect path?** Trace producer, transformations, provider or endpoint support, and observable result. A field copied everywhere may still have no setter, no reader, or only implementations that reject it. Search constructors and discriminant emitters as well as callers.
- **Which distinctions change a consumer's action?** Several internal states may require one model-facing status or one usable identifier. Keep internal distinctions that control authorization, residency, durability, or ownership; remove public distinctions that only invite an unusable choice.
- **Could a smaller explicit behavior remove the subsystem?** Fixed intervals, caller-supplied time zones, or reported activation failure can eliminate generalized calendars, persisted defaults, or automatic rollback. Name the capability given up and the machinery deleted. A production caller makes this a behavior decision, not an automatic rejection; implementation must remain within the user's authorization.
- **Can a consumer read the authoritative value when needed?** Look for copied histories, promotion ledgers, invalidation events followed by reads, and feature caches beside a shared projection stream. Derivation or reuse may delete subscriptions, retained data, stale-response handling, and recovery paths together. Establish the required time of observation first.
- **Is composition being mistaken for policy?** Optional service presence, a provider method, or a sibling tool can express availability without deciding deployment behavior. Explicit configuration or a caller-intent operation may remove registries and dependency checks. Preserve distinct operations when their ownership or completion timing differs.
- **What owns the complete maintenance cost?** Trace pass-through configuration, duplicate application trees, demo launchers used by products, resolver-only workspaces, and installation helpers with their own upgrade lifecycle. Compare the entire removed system with the replacement, including residual glue; moving complexity or adding a gate to keep duplicate definitions equal does not remove it.

## Prove reachability and the trade-off

Start with `rg`, then read the matches. Search exact symbols, property reads and writes, discriminants, event and wire strings, config keys, package names, and both `.method(` and `method(` forms. Tests and declarations can show a contract without proving a shipped producer or consumer.

Include `packages/*/*/src`, `apps/`, `python/`, runtime scripts, shipped profiles and overlays, package manifests and exports, loader resolution, generated runtime assets, and installed-package consumers. Classify examples and fixtures by their actual entry point rather than directory name. Follow generated catalogs to their consumers: a catalog used by model-written plugin mounts is a dynamic product API, while a documentation-only listing is not a fixed caller. Public third-party extension paths can be intentional despite zero repository call sites.

For each candidate, record the current owner, effective producer/consumer path, what disappears, what remains, and the strongest reason to retain it. Distinguish:

- removal of unreachable or unread behavior;
- a narrower public or product behavior with an explicit loss;
- a protected obligation or insufficient evidence.

Reject a candidate when it breaks a retained obligation, merely relocates the same complexity, or has no meaningful reduction. Read rejection reasons at the level of the proposed change: a stale inventory or a mixed proposal's rejected behavior does not settle every independent item. Refresh the evidence before re-proposing one. Small local improvements belong in actionable `TODO`/`FIXME`/`XXX` comments under the [urgency rules](../../../docs/development.md), not standalone design records.

## Preserve ownership and failure semantics

For copies, freezes, validators, and callback captures, name the value's origin, next owner, and trust boundary. Typed same-process calls ordinarily borrow readonly values; parsers, config loaders, queues, model/tool JSON, durable files, workers, processes, and wire decoders own or validate their inputs. Hostile-getter or callback-replacement tests do not establish a requirement by themselves. A frozen root does not prove its descendants immutable, and equal ids do not prove object identity.

For asynchronous machinery, map each promise, flag, cancellation path, disposer, and reservation to its owner and transition. Collapse mechanisms only when they express the same fact. Preserve synchronous publication and rollback, callback containment, first-terminal-outcome arbitration, worker/process ownership, and dispose-to-quiescence where required. Durable start/end markers can record real facts even when transcript renderers ignore them; dropping interrupted work is a capability loss, not redundant-log cleanup.

An invariant companion is justified by comparing independently produced observations that can diverge. Checks of service presence, plugin metadata, fixed examples, or the same mutation's return value do not qualify. Removing a companion includes its export, build entry, invariant-only compiler references, dependencies, and tests; record the package-specific omission reason in both READMEs. Keep checks comparing independent event producers, durable history, or mutable data.

## Replace infrastructure only for a net reduction

Follow the [dependency policy](../../notes/implemented/process/2026-07-26-dependencies-over-hand-rolling.md). Search existing dependencies and Node builtins at the engine floor before adding a package. Identify the exact implementation and dedicated tests the replacement deletes, its maintenance and transitive cost, and every residual behavior the glue must preserve.

Exercise the mismatches most likely to defeat the replacement: protocol truncation, cancellation and teardown, configured bounds, deterministic test clocks, platform packaging, and source versus built entry points. A library that covers framing but requires rebuilding the same framing to enforce a size limit is not a simplification. An accepted edge-behavior change belongs in the proposal and relevant tests. Do not re-prove a dependency's generic specification while omitting tests for the harness-specific shim.

## Record, consolidate, and validate

Use [dsh-prose-standard](../dsh-prose-standard/SKILL.md) when prose is in scope. Remove code-restating or remotely owned explanations while preserving local behavior, timing, ownership, and failure obligations. Update affected READMEs, JSDoc, model-visible catalogs, configuration, snapshots, and generated files with their owning change.

A substantial proposal uses the mandatory note skeleton: `Problem`, `Proposal`, `Alternatives considered`, `Acceptance criteria`, and `Risks`. Include concrete consumer evidence, the removed maintenance cost, the capability given up, and observable acceptance conditions. An implemented decision uses the [implemented format](../../notes/README.md#the-body-skeleton) instead. Update an existing owner when the decision is the same; do not create duplicate notes to preserve candidate counts.

Every new note requires a scoped supersession check through [dsh-archive-agent-notes](../dsh-archive-agent-notes/SKILL.md). That workflow owns retention, consolidation, triplet deletion, and frozen archive mechanics. A code survey does not imply a repository-wide note audit. Preserve partial supersessions and current durable, wire, compatibility, or rejected-alternative obligations.

When folding another branch, compare its independent diff against the target base, port only supported non-overlapping proposals, and consolidate overlapping rationale. Closing another PR requires authorization or clear ownership of that housekeeping.

For docs-only Agent Note work, run `pnpm run doc-sync`, `pnpm run lint`, and `git diff --check`; for skill or comment edits, include the applicable validator. Select other checks through [dsh-pre-push-checks](../dsh-pre-push-checks/SKILL.md). Report the surveyed areas, supported candidates, meaningful rejections or deferrals, notes added/consolidated/retained/removed, and commands actually run. Use a draft PR while the survey is expanding; do not describe an unverified search as exhaustive.
