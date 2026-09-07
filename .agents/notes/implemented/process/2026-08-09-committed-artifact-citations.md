# Agent Note: Cite committed artifacts, never design-session ordinals

Status: implemented

English | [中文](2026-08-09-committed-artifact-citations.zh.md)

## Problem

Large design and review sessions leave working shorthand — decision ordinals, audit item codes, plan section numbers, task and stack ordinals, reviewer rulings — that reads naturally while the session transcript is open and resolves to nothing after it closes. A repo-wide audit found the pattern concentrated in `packages/client`: bare `(decision 12/16/19/20/21)` citations of which only decision 21 had a committed owner, `(audit C2/S1/S3/S7)` codes with no audit document anywhere, `design §4.7` / `web2 §0` / `plan §1.4` references to uncommitted drafts, plan-phase labels (`T2/T5/T9`, `P-I`, `W5`), stack positions ("a later PR in this stack") in durable JSDoc, and "ruling" / "design ledger" vocabulary. The same families appeared in tests, CSS comments, generator templates, CI comments, and Agent Notes ("this PR/branch/review round" vantage, review-choreography attributions, stale "deferred to a later PR" claims whose targets had since shipped). The [documentation standard](../../../../docs/AGENTS.md) already banned the change-history half (previously/now, PR and commit references) but stated no counterpart rule for citations, so unresolvable ordinals kept landing.

## Decision

Durable prose — comments, JSDoc, docs, notes, test comments and titles — cites only committed artifacts, resolvable in-repo without grep archaeology:

- Name the owning Agent Note (its path at least once per file, a searchable name inline), the doc page path, or a GitHub issue number. PR, commit, branch, and stack positions stay banned in docs and code per the documentation standard; issues are durable and citable, and Agent Notes and postmortems may cite merged PRs and issues as evidence, per the [documentation standard](../../../../docs/AGENTS.md)'s change-story routing.
- A design-session ordinal whose decision has a committed owner is replaced by the decision's name — the ordinal once logged as "decision 21" is now "the plain-text-reference decision", owned by the [web input-machine note](../../archived/architecture/2026-07-25-web-input-machine-and-slash-pipeline.md); the ordinal itself resolves nowhere in-repo and was dropped everywhere. An ordinal without an owner is deleted and its factual clause restated to stand alone.
- Fixed regressions are pinned as present-tense counterfactuals ("without X, Y happens"; "a naive X would…"), never as repo history ("used to Y").
- Implemented notes state shipped reality: a "deferred to a later PR" claim whose target shipped names the shipped note instead.
- Recorded fixtures, snapshots, and archived notes are exempt: recorded model output and sealed history keep their original voice. Inside a note's change-story sections, a historical stage name ("the first cut shipped X") is current-state-safe; indexical stamps ("this cut") stay banned everywhere.
- Recall probes use lexical boundaries and are calibrated against a known positive and a near-miss negative. Authoring-language probes target the opposite-language surface instead of treating the complete Chinese corpus as untranslated residue.
- Owner-first edits trace every generated consumer. Verbatim code fences are copied byte-for-byte across bilingual pairs; model- or user-visible wording changes only with its owning behavior evidence, otherwise the audit leaves it unchanged and reports the deferral.

One repo-wide purge applied these rules across the prose surfaces, including the generator-owned templates (`scripts/gen-doc-graphs.ts`, `scripts/gen-tool-catalog.ts`, the typert generator's page notice) with regeneration, the type-equiv source JSDoc with page re-pastes, and the bilingual counterparts with pair re-records. The [dsh-trim-cot-leakage skill](../../../skills/dsh-trim-cot-leakage/SKILL.md) operationalizes these rules: the audit taxonomy, the committed recall batteries, and few-shot examples for deciding what to keep or delete.

## Alternatives considered

- **Commit the design ledgers and audit documents so the ordinals resolve.** Rejected: session transcripts are working artifacts, not maintained references; committing them would create a parallel, ungated decision corpus beside Agent Notes, and their internal numbering would still drift.
- **A mechanical gate for the banned vocabulary.** Deferred: the vocabulary is unbounded natural language, and the audit's recall batteries need judgment to separate leakage from legitimate prose ("wait" the noun, contrastive "actually", runtime old/new states). A narrow high-precision gate (for example `\(decision \d`, `\(audit [A-Z]\d`, `\bcut \d`, `this cut`, a bare `\bT\d\b`, `P-I`, `used to `, a bare `\bv1\b`, and `§\d` — the last excluding citations whose section numbering has a committed owner, such as web-styling.md's own §N) is the candidate if the pattern recurs; review of the purge itself caught residuals in exactly the cases those searches missed, so they lead the candidate list.
- **Delete the rationale that cited dead artifacts.** Rejected: the factual clauses were preserved or restated; only citations, review choreography, and derivation transcripts were removed, per the prose standard's complete-proposition rule.

## Verification

The audit's grep batteries (English and Chinese, comments and prose, `--hidden` for `.agents/`) return no design-ordinal citations outside recorded fixtures, archived notes, the trim skill's own files, and this note's quoted evidence; `verify-type-equiv`, the `gen-*` freshness checks, and `verify-translation-pairing` pin the regenerated and re-recorded surfaces. Coverage gap: no gate rejects a new ordinal citation — review owns the rule.

## Consequences

- A comment's citations resolve by path or name; readers never reconstruct a closed session to follow one.
- Design sessions must land their decisions in Agent Notes before durable prose can cite them; ordinal shorthand stays inside the session.
- Citations get longer (a note path instead of "(decision 21)") in exchange for grep-free resolution.
