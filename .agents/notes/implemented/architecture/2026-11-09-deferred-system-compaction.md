# Agent Note: Deferred system rebuilding after compaction

Status: implemented

English | [中文](2026-11-09-deferred-system-compaction.zh.md)

## Problem

Compaction must choose whether resumed conversation uses instructions from the selected historical endpoint or current registered sources. Historical reconstruction requires separate interpretations of canonical records for endpoint presentation and latest committed state, and cannot include uncommitted source changes.

Manual compaction can finish while a Session is idle, but released readers require ordinary `system/message` events inside an open model step. Immediate system rewriting therefore requires special relationship validation or another durable event and reader implementation. An update computed before compaction is also wrong once compaction removes the instructions it was compared against.

## Decision

Compaction summarizes the existing conversation and leaves current-source evaluation to the next model attempt. The assembly of that attempt’s step uses ordinary scope resolution, interpolation and trimming to capture live sources, including uncommitted changes; the rebuild omits retired sources and transition notices. [Section-based updates](2026-10-21-section-based-system-updates.md) own registration, lifecycle and incremental admission. This decision replaces historical endpoint snapshots and the intermediate immediate-rebuild design.

The existing committed `compaction/summary` event marks system rebuilding pending in the admission projection. A system message without `source.sections` marks it too: an earlier release’s whole prompts and an importer’s empty head are replaced by the same rebuild, without a separate appended replacement and its notice. Assembly fixes section text and lifecycle but computes no update. Before each model attempt, the loop asks the assembly for its updates; that call compares the captured sections with the projection at that moment and returns a full rebuild while one is pending. Compaction between assembly and commitment, or during overflow recovery between attempts of one step, therefore needs no second assembly. A retry receives only a pending rebuild, so system changes that another writer logs between attempts wait for the next assembly, as do source changes after capture.

Within the open step, ordinary `system/message` replacements first clear retained system additions and then reset the initial system node to the full current prompt. Additions outside the compacted range are cleared too. The final attributed reset establishes committed source state and completes the pending rebuild. Empty instructions preserve an empty-capable system head without adding a model-request message. Rejected or cancelled preparation commits no candidate; an interrupted replacement sequence leaves rebuilding pending until a head reset commits. Pending state recovers from the log across restarts without retaining runtime definitions.

The summarizer keeps the original logged instructions, selected conversation and cacheable ordering. Its framed-summary size check remains independent of deferred system text and uses the existing summary-only comparison. Reusing that logic avoids coupling compaction back to current-source assembly. Ordinary system replacements also retain existing scalar context-pressure accounting; this decision does not promise exact pressure after replacements that carry no shadow-price metadata.

## Alternatives considered

**Reconstruct historical instructions from logged sections.** The earlier design folded canonical records through the selected endpoint, omitted retired sources and notices, and let prior full snapshots reset that historical fold. Summary preparation could collect the records alongside selected messages without a second full-log read. A separate snapshot purpose kept the latest admission projection from regressing when an older snapshot was logged after retained suffix updates. This preserved exact endpoint text and order through repeated compaction, but required two interpretations of the log and excluded uncommitted changes. Current instructions govern resumed conversation, so that historical presentation and its tests are deliberately removed; runtime callbacks cannot recreate it.

**Restrict historical snapshots to prefixes or insert them before arbitrary ranges.** Prefix-only compaction allowed the always-present head, even empty, to be replaced with endpoint state using existing operations; it gave up middle ranges to avoid moving historical instructions before retained earlier conversation. Supporting arbitrary historical ranges instead needed insertion and supersession semantics. Current-source rebuilding gives up endpoint fidelity, so the compactor retains its existing range selection and head protection without snapshot-specific restrictions or an insertion operation.

**Immediately replace systems with ordinary messages.** This reuses the message vocabulary, but idle compaction would need an exception to the released open-step rule. Deferral supplies an ordinary open step without another Session-format rule.

**A required atomic rebuild event.** The intermediate `system/rebuild` design used a pure projection to replace the head, clear later system messages and reset committed source state together while preserving conversation positions. Rebuilding before destructive summary replacement protected instructions if preparation failed, but required coordinated event ordering and separate superseded-system token accounting; compaction as a whole still used several events. Readers needed the projection, and older readers safely rejected the required unknown event. Immediate idle inspection and restart visibility motivated that design, but do not justify another event, reader dependency and accounting path. No compatibility reader remains. Reintroduction requires a concrete need for immediate idle visibility or atomic system replacement.

**Compute the update at assembly and recapture after compaction.** Storing the computed delta on the assembly requires recording the latest compaction beside it and assembling again when a later compaction invalidates it. The loop then needs a freshness check, a pending-rebuild query and a commit operation on the system service, called in a fixed order, and source callbacks run twice in one step. Comparing at commitment needs one call and reuses the sections already captured for the step. It gives up source changes made between assembly and a compaction in the same step; they arrive as ordinary updates at the next step.

**Check summary and rebuilt-system size together.** This could reject a summary whose savings are outweighed by fresh system text, but requires evaluating that text during compaction and maintaining combined pricing. The retained summary-only check does not guarantee that the next complete request is smaller after unrelated source growth.

## Consequences

Completed idle compaction can display the old retained instructions until a model attempt begins. This lag is accepted. System replacements are sequential rather than atomically visible, but the model is not called until admission finishes; a failed tail cleanup or head reset remains recoverable from the pending flag. Original events remain in the durable log.

Current instructions move ahead of retained conversation, and later system updates disappear from model history once consolidated. Missing registrations after restart are absent from the full prompt even when ordinary incremental assembly would retain their committed text. A source change between a step’s assembly and a compaction in that step is absent too, until the next step admits it. A Session written by an earlier release is rebuilt once at its first model attempt, which forgoes reuse of its cached request prefix for that request. This gives up exact historical instruction placement and immediate idle visibility while retaining the existing Session vocabulary, surface operations and released reader rules.

Verification covers empty prompts, current and uncommitted sources, retained conversation, interrupted cleanup, restart recovery, repeated compaction and compaction between assembly and commitment. Compaction tests retain summary-only shrink and recovery behavior. Retry tests ensure that source changes after capture are not admitted within the step, with or without compaction.
