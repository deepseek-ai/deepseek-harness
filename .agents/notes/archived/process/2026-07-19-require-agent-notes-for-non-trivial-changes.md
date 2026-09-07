# Agent Note: Require an Agent Note for every non-trivial change

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-19-require-agent-notes-for-non-trivial-changes.zh.md)

## Problem

A selective threshold based on whether a decision seems durable, contested, and surprising lets substantial changes land without preserving their rationale. Code and tests show what changed, but they cannot consistently preserve why an approach won, which alternatives lost, or what costs maintainers accepted.

## Decision

Every non-trivial change adds or updates at least one Agent Note in the same PR. Non-trivial changes include behavior, architecture, cross-file or cross-package contracts, process or tooling, testing strategy, on-disk, wire, or configuration formats, and other decisions a maintainer may reasonably revisit.

Updating the note that already owns a decision satisfies the rule; a new note is required only when no note owns it. Purely mechanical or local edits with no behavioral, contractual, structural, process, or rationale change are exempt. The [Agent Notes README](../../README.md#when-to-write-one) owns this boundary, while root `AGENTS.md` carries the standing order.

A fully superseded implemented note may be consolidated into the current owning note and deleted only after that owner preserves every unique rationale, alternative, consequence, verification contract, and named coverage gap. The same change repairs inbound links and removes the Chinese counterpart and consistency record. Partial supersession keeps both notes cross-linked and current; consolidation neither rewrites an old decision into its opposite nor leaves git history as the only copy of rationale.

When a later decision removes an earlier feature completely, the removal note becomes the current owner only after the feature is absent from production code, configuration, schemas, durable or wire formats, migration, and compatibility behavior; no current documentation presents it as available; and no test exercises it as supported behavior. Removal rationale and tests that verify absence may remain. The removal owner preserves the feature's original motivation, why that motivation no longer justified the surface, alternatives to full removal, the capability given up, conditions for reintroduction, and verification of complete absence. Implementation inventories and tests that only described the deleted behavior are obsolete rather than current verification contracts. A removal limited to one transport, default, implementation, or presentation remains partial supersession.

Review enforces the semantic boundary. No automated gate attempts to classify a diff as trivial or non-trivial, so this policy adds no gate stage or runtime.

## Alternatives considered

**Require notes only for decisions judged durable, contested, and surprising.** The threshold is subjective enough that a substantial change can be treated as obvious or local, losing the rationale Agent Notes exist to preserve.

**Require a new note for every change.** This duplicates an existing note when it already owns the decision and adds empty ceremony to purely mechanical edits.

**Keep every fully superseded note indefinitely.** A cross-linked record is necessary while part of its decision remains current, but a wholly obsolete implemented note contradicts the current-state contract and duplicates rationale that can have one owner.

**Add a `superseded/` lifecycle.** Another lifecycle would retain the obsolete record and expand the tree, format gate, and maintenance rules without reducing duplication.

**Rewrite the old note into the replacement decision.** This erases the decision boundary and its rejected alternatives. Consolidation instead preserves those facts in the current owner before deleting the obsolete file.

**Preserve every implementation and test detail from a removed feature.** This recreates the obsolete note inside its replacement. The removal owner keeps the rationale and verification needed to understand or revisit the current absence, while deleted mechanics remain available in git history.

**Add a CI diff-classification gate.** A mechanical check cannot reliably determine whether a semantic change is trivial, while another gate adds runtime and invites false positives or superficial compliance.

## Consequences

- Every substantial change preserves its rationale and rejected alternatives beside the implementation.
- Contributors maintain an existing owning note instead of creating duplicate records.
- Fully superseded records can collapse into one current owner without losing their unique rationale or verification contract.
- Features that were later removed can have one current owner without carrying obsolete implementation and test inventories forward.
- Partial supersession remains explicit and cross-linked, while deletion requires link and bilingual-pair cleanup in the same change.
- Mechanical edits remain lightweight, and the gate topology and runtime remain unchanged.
