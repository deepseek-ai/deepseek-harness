# Agent Note: Prefer maintained dependencies over hand-rolling

Status: implemented

English | [中文](2026-07-26-dependencies-over-hand-rolling.zh.md)

## Problem

The harness hand-rolls a lot of infrastructure that mature external packages already provide. Some of that is deliberate — vendored Cordis ([vendoring decision](../../archived/process/2026-06-11-vendor-cordis-as-source.md)), the [twin LLM adapters](../architecture/2026-06-13-twin-llm-adapters.md), schemastery as the config-schema standard — but much of it accreted from an unstated "avoid new dependencies" reflex: the repo-wide external dependency list stayed tiny while packages grew their own SSE parsers, protocol framers, retry loops, and glob matchers. Nothing in `AGENTS.md` actually stated a dependency policy, so agents inferred one from the existing pattern, and the inferred rule ("don't add deps") is stricter than anyone decided. That is the "Not Invented Here" fallacy operating by default: every hand-rolled clone of a well-maintained library is code we test, document, review, and debug ourselves, with none of the ecosystem's accumulated edge-case fixes.

## Decision

Introducing an external dependency is a legitimate simplification, not a policy exception. When a well-maintained package (or a Node builtin at our engine floor) covers a hand-rolled surface, replacing the hand-rolled code is the preferred direction, subject to the same evidence standard as any other simplification: the swap must genuinely shrink what we own — code, tests, and contract surface — rather than merely relocate complexity behind a wrapper.

The bar for a new dependency:

- **Net deletion.** The dependency replaces real owned code (implementation + dedicated tests + docs), not hypothetical future code. A dep that only adds capability is a feature decision, not a simplification.
- **Health.** Actively maintained, widely used, sensible transitive footprint. A tiny unmaintained package trades our code for someone's abandoned code.
- **Fit at the boundary.** The package's semantics cover our actual contract; residual semantics we still hand-roll around it count against the swap.
- **Not a settled seam.** schemastery (config schemas), vendored Cordis, the `@earendil-works` twins, and other decisions recorded in implemented Agent Notes are not reopened by this policy; a swap that collapses a recorded design needs to beat the recorded rationale, not just cite this note.

`packages/util/`'s "zero-dependency" charter describes that group's *export* discipline — util packages stay free of harness dependencies so any group can depend on them — and does not ban external packages where they simplify; a util package whose entire job a maintained external package does better should be replaced by the dependency, not preserved for the charter.

Dependency-swap proposals are recorded as `proposed/simplification` Agent Notes like any other removal, with the candidate package, the deletable surface, residual semantics, and supply-chain considerations stated. The [supply-chain proposal](../../proposed/process/2026-06-11-supply-chain-and-vendor-drift.md) owns advisory scanning and update cadence for the dependency list this policy grows.

## Alternatives considered

- **Keep the implicit no-new-deps culture.** Rejected: it was never a recorded decision, and its cost is concrete — hand-rolled protocol and parsing code duplicates battle-tested libraries, inflates the per-file coverage burden, and slows every reviewer who must re-derive edge cases the ecosystem already fixed.
- **A hard allowlist of approved packages.** Rejected: the repo is pre-release and the dependency set is small; a per-PR evidence bar (net deletion, health, fit) plus review keeps judgment where the context is, without a standing committee artifact that would itself need maintenance.
- **Vendor every new dependency like Cordis.** Rejected: vendoring is for packages we must patch or pin against upstream churn ([vendoring decision](../../archived/process/2026-06-11-vendor-cordis-as-source.md)); applying it broadly recreates the maintenance burden the dependency was meant to shed. Ordinary npm dependencies with lockfile pinning are the default.

## Consequences

- Agents and contributors surveying for simplifications now treat "replace hand-rolled X with package Y" as in-scope output; [dsh-find-simplifications](../../../skills/dsh-find-simplifications/SKILL.md) carries the corresponding guidance.
- The dependency list will grow, and with it the supply-chain surface; the mitigations live in the [supply-chain proposal](../../proposed/process/2026-06-11-supply-chain-and-vendor-drift.md), which this policy makes more urgent.
- Root `AGENTS.md` carries the one-line rule; this note owns the rationale and the bar.
