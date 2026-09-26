# Agent Note: Evidence-led simplification surveys

Status: implemented

English | [中文](2026-09-19-evidence-led-simplification-surveys.zh.md)

## Problem

Unused-symbol searches can miss working behavior whose implementation costs more than its required outcome, and can misclassify public extension APIs without fixed repository callers as dead. The previous simplification skill also combined discovery with lengthy archive procedures, omitted application and Python paths from its consumer examples, and suggested a proposal outline without the mandatory `Alternatives considered` section.

## Decision

The [simplification skill](../../../skills/dsh-find-simplifications/SKILL.md) traces a complete producer-to-outcome path, asks which distinctions change consumer actions, considers explicit reductions in supported behavior, and searches for maintained copies that an authoritative read can replace. It separates composition availability from deployment policy and counts removed configuration, lifecycle, tests, and documentation together with source code.

Production use changes the required trade-off evidence; it does not automatically veto a proposal or authorize implementation. Dynamic plugin discovery, installed consumers, generated runtime assets, profiles, applications, and Python participate in consumer tracing. Protected adapters and persistence designs, released data, trust boundaries, independent invariant observations, synchronous publication, cancellation, and quiescent disposal remain constraints.

The entry point separates decision criteria from an [optional historical reference](../../../skills/dsh-find-simplifications/references/historical-patterns.md) pairing mechanisms with counterexamples and residual obligations. Archive mechanics remain at their existing owner, and the proposal skeleton uses the canonical headings.

## Historical evidence

The author sampled 26 of the 100 English implemented or archived simplification notes: 11 implemented and 15 archived. All nine rejected simplification notes supplied counterexamples. The sample covers producerless variants, inert request knobs, explicit inputs, public projections, derived data, shared composition, lifecycle ownership, and dependency replacements; it is purposeful, not random or exhaustive.

The frozen comparison inputs contained 2,222 whitespace-delimited words in the baseline entry, 1,372 in the revised entry, and 897 in its reference; the hashes below identify those measured artifacts. The reference teaches questions rather than current deletion instructions. An adapter-rejected knob differs from a working extension API; a simpler public status can retain internal residency distinctions; reading at feedback time changes the observation promise; replacing a dependency can lose deterministic clocks or necessary teardown. Archived records were read without following or repairing outbound links. No old note was edited, archived, or deleted.

## Bounded survey evidence

The source snapshot is master after #4618. Each arm uses fresh agents with the same inherited model and reasoning effort, identical owner domains, a time cap, and at most four submissions per domain. Other outputs remain hidden from discovery agents. The runtime domain covers `core`, `session`, `session-query`, `api`, `sdk`, and Python; execution covers `shell`, `subprocess`, `terminal`, `jobs`, `fs`, `mcp`, and `boot`.

A third matched domain, covering `llm`, `compaction`, `context`, `skill`, and `extensions`, was added after the initial runtime results to broaden coverage. It is exploratory, uses a shorter equal cap, and remains separate from the initially declared two-domain comparison. The study stops after these three domains.

The skill author derived the revision from historical notes while isolated from current candidates. The coordinator received accidental early baseline hints, but accepted the independent author's revision unchanged before revised runs. Candidate packets hid arm labels from a separate reviewer; the coordinator's integration was not blind. The frozen inputs had SHA-256 values `9830af2272a1a1c3832078f31a432c8abe0335a013bc6c248c072b388520e798` for the baseline entry, `3b101d16ae098855c9214ad7fed631a2f079b6078c83b49829ae87305f631a87` for the revised entry, and `9a6b674d1eeadb691481ea09838b211b8e94c94e5a8cd928726246b1c097b2b5` for its reference.

After these runs, review replaced only the skill phrase “earns its place” with “is justified”; no discovery criterion changed and no new discovery run was performed. Each prompt requested exact source/search evidence, producer and consumer classification, note overlap, net reduction, the strongest counterargument, and acceptance requirements. Review applied those same criteria to every submission, distinguished local edits from durable decisions, and did not treat either public discoverability or a line-deletion count as a verdict by itself.

| Version | Domain | Cap | Submitted | Durable as submitted | Durable after refinement | Local | Deferred | Elapsed |
|---|---|---|---:|---:|---:|---:|---:|---|
| Baseline | Runtime | 12m | 3 | 1 | 2 | 0 | 0 | 6m 30s |
| Baseline | Execution | 12m | 3 | 3 | 0 | 0 | 0 | 8m 40s |
| Revised | Runtime | 12m | 2 | 1 | 0 | 1 | 0 | 5m 05s |
| Revised | Execution | 12m | 3 | 2 | 0 | 1 | 0 | 8m 19s |
| Baseline | Model/context, exploratory | 10m | 2 | 2 | 0 | 0 | 0 | 6m 02s |
| Revised | Model/context, exploratory | 10m | 2 | 0 | 0 | 1 | 1 | 7m 51s |

The baseline yields six durable proposals as submitted and two after refinement. The revised skill yields three durable proposals and three local cleanups, with one proposed behavior reduction deferred. Python RPC narrowing and filesystem-invariant omission overlap. The combined set contains nine distinct durable proposals; the revised version adds [configuration-only HMR](../../proposed/simplification/2026-09-19-config-only-hmr.md). This sample does not show higher durable-proposal yield from the revision.

Review narrowed the [query API proposal](../../proposed/simplification/2026-09-19-trim-session-query-convenience-api.md) to retain `filterEvents`, whose literal substring behavior differs from FTS. The [prompt-event proposal](../../proposed/simplification/2026-09-19-retire-prompt-registry-change-event.md) explicitly retires an active extension promise instead of claiming per-step assembly makes notifications redundant. Both refined baseline findings remain useful and are retained.

The three revised-only local findings were a mirrored provider reference, copied filesystem results, and duplicate assembler ordering state. They were counted separately and were not written as active design proposals.

Review deferred replacing automatic Session-reference sizing with a fixed byte default. The [current budget decision](../bug-fix/2026-09-05-session-reference-model-budget.md) fixes lost useful context on large models; best-effort spill retrieval does not replace inline context. No new workload evidence justified restoring the problematic default. The proposal's deletion inventory was accurate, but that alone did not overcome the current requirement.

## Alternatives considered

**Keep caller counts as the main filter.** This misses producer support, dynamic consumers, and useful explicit behavior reductions. More symbol matches do not establish which obligations can disappear.

**Encode historical successes as a deletion checklist.** Architecture and consumers change. The reference uses mechanisms and counterexamples without making frozen records current authority.

**Select the revision by proposal count.** The observed count does not support superiority. Its demonstrated benefit is complementary discovery and explicit classification; the stronger union includes findings from both versions.

## Consequences

The skill changes survey guidance, not runtime behavior. The nine proposals still require scoped implementation and relevant tests; their future implementation checks were not run. Three local opportunities remain evaluation findings, and the unsupported budget reversal is excluded from the proposal set.

There is one discovery run per version/domain, no randomized order or repetition, unequal actual elapsed time within equal caps, and subjective review. Source reductions are estimates, not implemented diffs. These results establish neither statistical superiority, reproducible speedup, nor exhaustive coverage.

The [dependency](2026-07-26-dependencies-over-hand-rolling.md), [prose](2026-08-09-concrete-prose-names-actors-and-recorded-facts.md), [archive](2026-07-26-frozen-agent-note-archive.md), and [performance-workflow](2026-09-06-evidence-driven-performance-skill.md) decisions retain their independent responsibilities. This note adds simplification-specific discovery and evaluation criteria without superseding those owners.
