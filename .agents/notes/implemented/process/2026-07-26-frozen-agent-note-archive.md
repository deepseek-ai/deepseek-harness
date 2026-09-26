# Agent Note: Freeze low-future-value Agent Notes outside the active corpus

Status: implemented

English | [中文](2026-07-26-frozen-agent-note-archive.zh.md)

## Problem

Implemented Agent Notes are maintained as current decision records, so every path, symbol, default, translation, code fence, package reference, and outbound link in the active corpus remains an obligation. That cost is justified when the rationale can guide future work, but not for closed UI details, minor fixes, superseded implementation mechanics, or process history whose current authority lives elsewhere. Deleting every low-value implemented record would erase useful historical evidence, while retaining every rejected proposal preserves ideas that are neither plausible nor instructive. The corpus needs a retention boundary that distinguishes active guidance from frozen history without turning archival into another maintenance tier.

## Decision

Implemented notes that only describe small UI adjustments or purely mechanical changes are deleted as complete triplets, with inbound links repaired or removed. A small implementation can still carry lasting naming, compatibility, ownership, or behavior decisions; those records remain eligible for retention. Only other implemented Agent Notes can be archived: the shipped decision is complete, its rationale is unlikely to guide future work, and it still has historical decision value. Foundational boundaries, durable and wire semantics, security rules, recurring design temptations, and unresolved reintroduction conditions remain active regardless of age or word count. Proposed notes never enter the archive; an obsolete proposal becomes rejected. A rejected note remains only while it prevents a tempting, meaningful mistake and is otherwise deleted as a complete triplet.

The archive uses `.agents/notes/archived/{kind}/yyyy-mm-dd-topic.md`; the redundant `implemented` segment is absent. The archival change moves the complete English, Chinese, and consistency-sidecar triplet, leaves `Status: implemented` intact, and inserts `Archived: YYYY-MM-DD` immediately below it in both language files. Relocation, that metadata line, the corresponding sidecar re-record, and mechanical inbound-link repair are the only permitted archival edits. Archival admission checks lifecycle metadata and completeness, not title punctuation, blank-line layout, or language-switcher wording; requiring those repairs would rewrite the historical record.

The root `.rgignore` excludes the archive from searches that traverse a parent directory. Historical queries name the archive directory explicitly, so intentional access remains available without mixing frozen facts into active decision discovery.

After archival, the triplet is permanently frozen and is historical context rather than current authority. It is not updated for renamed packages, changed behavior, translation standards, formatting rules, broken outbound links, or later documentation contracts. Active prose may intentionally link into an archived note, redirect that link to current authority, or delete it. Repository gates therefore validate links into archived files but never treat archived files as link sources.

[`verify-archived-agent-notes`](../../../../scripts/verify-archived-agent-notes.ts) owns the frozen boundary. It accepts only the closed set of Agent Note kinds, requires a complete triplet with implemented status and matching valid archive dates, verifies the sidecar against both current Git blob hashes, and seals every artifact by path and SHA-256 content hash in an append-only manifest, with only the exact seal-transition exceptions recorded in [archive instructions](../../archived/AGENTS.md). Its `--write` mode first proves every existing seal unchanged and then appends only newly archived artifacts. Pull-request CI supplies the trusted base SHA and checks out complete history before running the verifier, so a reused runner's shallow checkout cannot omit the baseline manifest. The ordinary Agent Note format, translation-pairing, wrapping, Markdown-link, package-path, Mermaid, documentation-TypeScript, and type-equivalence gates exclude archive sources; their evolving standards cannot create pressure to edit history.

The [`dsh-archive-agent-notes`](../../../skills/dsh-archive-agent-notes/SKILL.md) workflow owns classification. It requires a semantic note-by-note audit, uses code and current documentation to identify present authority, treats word count only as triage, carries calibrated keep/archive/delete examples, and reports genuinely borderline outcomes for review.

Supersession is checked while a new Agent Note is being written, not deferred to a later corpus cleanup. The author compares the new note with active notes covering the same decision, mechanism, or rejected alternative and classifies every full or partial supersession. Qualifying implemented triplets are archived in the same pull request; partial supersessions and independently useful rationale remain active and cross-linked, while proposed and rejected matches follow their own lifecycle rules.

## Alternatives considered

**Delete every note that leaves the active corpus.** Rejected because an implemented record can have low forward guidance while still providing useful historical evidence about a closed decision. A content-sealed archive preserves that evidence without pretending it remains current.

**Keep every implemented and rejected note active.** Rejected because maintenance effort and search noise grow with records that no longer help a future decision. Rejected notes in particular earn retention only by preventing a plausible fallacy.

**Leave archived notes in default repository search results.** Rejected because archived facts may be stale by design and can outrank current results by lexical match. Historical work can search the archive directory explicitly.

**Defer supersession cleanup to periodic corpus audits.** Rejected because the author of a replacement note has the freshest evidence about ownership and overlap. Postponement leaves redundant active authorities and makes later classification more expensive.

**Archive rejected or proposed notes too.** Rejected because archive status means “implemented historical decision.” An obsolete proposal needs an explicit rejection, while a rejection with no guardrail value needs deletion rather than a second low-value holding area.

**Continue applying all documentation gates to archived notes.** Rejected because a later formatting, translation, code, package, or link rule would require rewriting the historical snapshot. The dedicated verifier owns completeness and immutability instead.

**Permit factual refreshes while freezing only rationale.** Rejected because that recreates the judgment and translation burden of the active corpus and makes it unclear which clauses are historical. Current facts belong in active documentation or a new active Agent Note.

## Consequences

The active corpus becomes a set of decisions expected to influence future work, while substantive historical decisions with little future guidance remain explicitly searchable and linkable without consuming maintenance attention or appearing in parent-directory searches. Writing a new note includes a scoped supersession check, so replacement decisions cannot silently leave redundant active records behind. Rejected clutter can disappear when it no longer protects a meaningful choice, and proposed work cannot quietly evade a verdict through archival. The archive adds a manifest, a dedicated verifier, and an explicit one-time metadata step. Archived facts and outbound links can become stale by design, so readers and agents must treat active code and documentation as authority and cite an archived note only as history.
