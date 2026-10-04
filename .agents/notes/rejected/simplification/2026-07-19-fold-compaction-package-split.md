# Agent Note: Fold the single compaction backend into its service package

Status: rejected — More compaction backends are planned, so the Service Definition and basic provider packages remain separate.

English | [中文](2026-07-19-fold-compaction-package-split.zh.md)

## Problem

Compaction is split between `@deepseek-ai/dsh-compaction`, which owns an abstract two-method service and shared types, and `@deepseek-ai/dsh-compaction-basic`, which owns the only complete provider. Shipped configurations load only the basic package, and no production package independently consumes the Service Definition package except that provider.

The split adds a package manifest, README, project boundary, dependency edge, abstract forwarding class, generated catalog entries, and composition wiring without demonstrating backend substitution. The [capability-seam decision](../../implemented/architecture/2026-06-13-capability-seams.md) requires a real interface, implementation, and consumer rather than a preemptive split; the [historical compaction decision](../../archived/feature/2026-06-18-compaction-capability-seam.md) records that its independent consumer was deferred.

## Proposal

Move the basic implementation into `@deepseek-ai/dsh-compaction` and remove `@deepseek-ai/dsh-compaction-basic`. Keep `ctx.compaction`, `CompactionResult`, the shared transcript and tool-pairing helpers, the existing configuration, and the concrete compaction algorithm in one package.

Preserve `summarize()` as a protected customization hook. A deployment-specific summarizer can subclass or intercept the existing LLM call without requiring a second capability package. Reintroduce a separate Service Definition package only when a second complete backend and an independent Consumer need substitution.

Amend the implemented compaction decision and the [recallable-compaction proposal](../../proposed/feature/2026-07-06-recallable-compaction.md) if this proposal is accepted so package ownership has one durable description.

## Alternatives considered

**Keep the split because a remote or recall backend may arrive.** A possible future implementation does not justify the current package boundary. Recall adds a consumer of compaction results, not necessarily another implementation, and a remote summarizer can use the protected hook.

**Move the provider package name onto the Service Definition package.** Keeping `compaction-basic` as the surviving name would make the product service appear to be one optional backend. `compact` is the stable service identity already used by `ctx.compaction` and is the clearer single-package owner.

## Acceptance criteria

- `@deepseek-ai/dsh-compaction-basic` and its workspace/package metadata are removed.
- `@deepseek-ai/dsh-compaction` owns the current configuration, plugin class, algorithm, types, events, and shared helpers.
- Existing deployments can load the surviving package with equivalent configuration and model-visible behavior.
- Automatic and manual compaction preserve cancellation, locking, token accounting, tool pairing, durable events, cited source-event seqs, retry convergence, and transcript rendering.
- Loader composition, unit, runaway-turn, cancellation, snapshot, and real-model compaction tests pass; generated catalogs and module graphs are current.

## Risks

This is an intentional pre-release package-name contraction. Embedders loading `@deepseek-ai/dsh-compaction-basic` must switch packages, and future backend substitution would require extracting a boundary again. The cost is acceptable only while one complete implementation exists; acceptance should be revisited if a second backend lands first.
