# Agent Note: Bound overwrite contextual-diff bases at the provider

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-30-bounded-overwrite-diff-basis.zh.md)

## Problem

`dsh-fs-local` returned the complete prior file in `FsWriteOutcome.before` so consumers could build a contextual overwrite diff. That presentation-only pre-read was unbounded: a large overwrite could allocate the entire prior file, and checking an earlier path stat alone could not enforce a limit because an external process could replace or grow the file between the stat and the read. A large replacement also made the contextual hunk approach the replacement size even when the prior file was small. This closes the deferred bound recorded by [result-time applied-hunk diffs](../../archived/architecture/2026-07-02-result-time-applied-hunk-diffs.md).

## Decision

`LocalFileSystem.Config.diffBasisMaxBytes` is a positive safe-integer deployment setting no greater than the runtime's Buffer-allocation and string-decoding limits, with a 10 MiB default. An overwrite supplies `before` only when the UTF-8 replacement is strictly below that limit and the prior file opened for the basis also ends below it. The prior read opens a descriptor, checks that descriptor, and reads at most the configured byte count in cancellation-aware chunks; reaching the boundary returns `null`. A size change after descriptor stat also returns `null`, even if the final size remains below the limit, because a partial prefix would be an incorrect diff basis. Binary or invalid UTF-8 prior content likewise returns `null`, as does any descriptor-phase errno — a prior file deleted or made unreadable between the caller's preflight and the basis open cannot fail a write the caller already committed to; only cancellation and non-errno faults propagate. These outcomes do not block the atomic write.

The local provider owns this decision because `before` is its optional, best-effort basis: it can avoid acquiring prior content that the configured pair limit has already made ineligible. `tool-fs` continues to own diff computation, retention, and presentation. The setting is independent of `tool-fs.readStreamMinSize`; read routing and overwrite presentation are different policies and need not share a value.

`before: null` asks consumers to use their existing whole-file fallback. The limit bounds only the extra prior-content acquisition and eligibility for a contextual pair. It does not bound the caller-owned replacement, the returned `after` value, or a consumer's fallback rendering.

## Alternatives considered

**Keep a hardcoded threshold equal to the read tool's streaming threshold.** Rejected because the read threshold is deployment-configurable and consumer-owned. Two same-valued constants would create an unenforced cross-package coupling, while the overwrite basis is itself a deployment memory/presentation choice.

**Gate only the prior side in the provider and cap new-content diffing in `tool-fs`.** Rejected because it would acquire prior text even when the provider's configured pair limit already excludes the replacement, and it would split one `before` eligibility rule across two plugins. Consumers remain free to impose additional output limits.

**Trust the initial `probe()` size before using an ordinary whole-file read.** Rejected because that size can become stale before the read. The descriptor reader must enforce the bound on the object it actually reads.

**Stream a contextual diff for arbitrarily large pairs.** Rejected for this bug fix because the current filesystem seam returns complete `before`/`after` strings and the current diff implementation consumes them. A streaming diff would require a separate cross-package protocol and presentation design.

## Consequences

Deployments can tune the extra overwrite-basis cost without changing read routing. At or above the exclusive limit, overwrites still succeed and remain visible through the whole-file fallback, but lose contextual hunks. Below the limit, the provider can still hold almost `diffBasisMaxBytes` of prior text in addition to the caller's replacement. The bounded descriptor read adds an open/stat/read sequence for eligible overwrites, while preventing a stale path probe from turning that sequence into an unbounded allocation.
