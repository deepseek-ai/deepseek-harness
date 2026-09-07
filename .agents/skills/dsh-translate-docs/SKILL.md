---
name: dsh-translate-docs
description: Manually run the extended DeepSeek Harness bilingual-document workflow, including generated briefings, delegated prose translation, whole-document translation, and scoped pairing verification.
disable-model-invocation: true
user-invocable: true
---

# Translating DeepSeek-Harness docs

## Invocation boundary

Run this extended workflow only when the user explicitly invokes `dsh-translate-docs` by name. Never select or load it for ordinary documentation work, from another skill, or from an inferred translation need; routine translation follows the one-shot, one-pass rule in [docs/AGENTS.md](../../../docs/AGENTS.md).

## What this skill is

**This skill is guidance, not a translation memory.** It is the workflow map for keeping `foo.md ↔ foo.zh.md` pairs consistent and natural in both languages. Both languages carry equal authority — a change is authored in either one, and that side is the source for that update. You are the translator: the rules below say what must hold, not how to phrase any particular sentence — phrasing judgment is yours, terminology is not.

## Triage by change type — this decides everything else

- **Update** (pair exists, one side edited): follow [the update path](#the-update-path-briefing-driven). It is briefing-driven and deliberately cheap: no guidance-corpus reading, no git archaeology, smallest counterpart edit. Never re-translate a whole document to apply an update — a minimal update preserves the reviewed phrasing of everything that didn't change; a re-translation throws that review away.
- **New pair** (no counterpart yet): follow [the whole-document path](#the-whole-document-path-new-pairs).
- **Deleted or renamed doc**: delete or rename the counterpart and the `.i18n.yaml` alongside it — the gate reports an incomplete pair otherwise.

Frozen Agent Notes under `.agents/notes/archived/` are not translation work. Their complete triplets are sealed by the archive verifier; never update, re-record, or repair either side after archival.

## The update path (briefing-driven)

The briefing-driven path matches guidance-corpus quality at a fraction of the cost; the archived [briefed-updates Agent Note](../../notes/archived/process/2026-07-26-briefed-minimal-translation-updates.md) records the benchmark evidence.

1. **Generate the briefing**: `pnpm run gen-translation-brief <any file of the pair>` (no arguments briefs every out-of-sync pair). The briefing maps the change at the narrowest safely aligned granularity — changed Markdown units (paragraph, table row, list item, heading), then whole heading sections, then whole document — and contains the authored side's diff since the last confirmed-consistent state, each changed unit's last-confirmed source, current source, and current counterpart text (with line numbers), the terminology rows the change touches, first-occurrence movement notes, and a digest of the binding update rules.
2. **Mechanical-only diff? `--apply` it.** When every change lies inside code fences that the pair shares byte-identically, the briefing says so; `pnpm run gen-translation-brief --apply <pair>` splices the edited fences into the counterpart and structure-validates the result before writing — no subagent, no hand-editing.
3. **Prose diff? Delegate to a subagent, passing the briefing** (or the command to generate it). The briefing is the translator's whole working set — the subagent does not re-read the guidance corpus (the rules digest, terminology rows, and each changed unit's three-way context are inline) and does not re-derive the diff. It escalates to the whole-document path's sources of truth only when the briefing leaves a specific decision genuinely unanswerable — an unlisted term with no precedent in the surrounding text, or a whole-document briefing (`BOTH sides changed`, or neither units nor sections align), which always means reconciling by hand under [translation-rules.md](../../../docs/i18n/translation-rules.md).
4. **Smallest edit that covers the diff.** Preserve the reviewed phrasing of everything the diff does not touch, then verify the changed hunks clause by clause against the source: nothing added, nothing dropped, terminology per the inline rows, code spans verbatim.
5. **Record and verify, scoped**: `pnpm run verify-translation-pairing --write <pair>` then `pnpm run verify-translation-pairing <pair>`. `--write` names exactly the pairs you confirmed — it refuses to run bare so a bulk re-record is always an explicit `--all`. The corpus-wide check still runs in `doc-sync`/CI; do not run it per-update.

## The whole-document path (new pairs)

When translations need to be written from scratch, the orchestrating agent does not translate: spawn a subagent to do the translation work. The translator reads the sources of truth below first, then translates the whole file into the other language — section by section for long documents, keeping each section's structure locked to the source as you go rather than fixing structure at the end.

### Sources of truth (read, don't re-summarize)

- **[docs/i18n/README.md](../../../docs/i18n/README.md)** — the pairing contract: the three-file pair (`foo.md`, `foo.zh.md`, `foo.i18n.yaml`), the consistency record's both-side blob hashes, the language-switcher lines, scope, and exclusions.
- **[docs/i18n/translation-rules.md](../../../docs/i18n/translation-rules.md)** — how to translate: faithfulness, structure preservation, terminology discipline, typography (MUST/SHOULD levels).
- **[docs/i18n/terminology.md](../../../docs/i18n/terminology.md)** — the terminology table, binding in both directions. Load it BEFORE translating, not when a term feels uncertain; the terms you don't notice are the ones that drift.
- **[docs/i18n/translation-prompt.md](../../../docs/i18n/translation-prompt.md)** — the automated pipeline's calibrated machine-consumed template. Agents using this skill do not render it; the terminology table is the only repository file the automated renderer injects, while this skill and `translation-rules.md` remain binding for agent-authored translations.
- **[dsh-prose-standard](../dsh-prose-standard/SKILL.md)** — required prose coverage and editorial judgment. Apply it to both sides without adding or dropping source propositions.

### Translate

- **Pass 1 — write, don't transpose.** Read a semantic unit, then restate it as a native technical author in the nearest [style sample's](../../../docs/i18n/style-samples.md) register. Preserve the required frame without forcing sentence-by-sentence correspondence.
- **Pass 2 — verify against the source, clause by clause.** Fidelity is checked here, not written in: confirm nothing was added or dropped, every term follows the table, and each code span survived verbatim. Fix by rewriting the sentence natively, not by patching words into it.
- **Read the completed counterpart alone.** After the source comparison, read the translated file without the source beside it and rewrite phrasing whose awkwardness only becomes visible in isolation.
- Write only the final text to the file, never drafts or notes.
- Every term in [terminology.md](../../../docs/i18n/terminology.md) renders exactly as specified. For a Chinese target, use the Chinese and first-occurrence columns; an unlisted term needs a citable Chinese OSS/vendor precedent or stays English under 「待定术语」. For an English target, use the English column and an established English technical term; preserve an ambiguous source term with a short gloss and list it as pending. Never invent a rendering inline.
- Code blocks are byte-identical across the pair, comments included. Repository-relative document links keep the same semantic target and exact query/fragment suffix: targets in the active bilingual corpus use `.md` on the English side and `.zh.md` on the Chinese side, a missing in-scope counterpart is an error, targets outside the corpus keep their authored path, and the switcher remains the cross-locale exception.
- The pairing gate checks heading depths, fenced blocks, table row and column counts, list kinds, ordered-list starts, list item counts, link locale, and semantic targets. In Pass 2, manually verify list and table order, noncanonical list numbering, inline code, emphasis, meaning, terminology, and tone.

## Find the work

- `pnpm run verify-translation-pairing --list` prints every in-scope document as missing / out-of-sync / ok. Missing and out-of-sync rows are contract violations; the normal check rejects them.
- `pnpm run gen-translation-brief` with no arguments prints the briefing for every out-of-sync pair.
- In a PR that edits paired docs, the work list is the diff itself: every changed side of a pair needs its counterpart updated and the pair re-recorded in the same PR, and the gate goes red if you forget.

## Finish the pair

1. Switcher: `[English](foo.md) | 中文` immediately after the Chinese file's H1, `English | [中文](foo.zh.md)` after the English file's H1 — add both if this is a new pair, except that a generator-owned English source stays byte-identical to generator output and omits its switcher while the Chinese counterpart still links back.
2. Record consistency: `pnpm run verify-translation-pairing --write <pair>` recomputes and records both sides' full blob hashes in `foo.i18n.yaml`. The yaml diff in your PR is the reviewable statement "I confirmed these two say the same thing" — only run it after you actually have.
3. No manifest entry is needed for an ordinary document: every in-scope source requires a pair. Change [scripts/translation-pairing.manifest.json](../../../scripts/translation-pairing.manifest.json) only when the owning policy documents a genuine generated, instructional, or bilingual-by-construction exclusion.
4. Before the PR: the touched pairs are green under the scoped check; `pnpm run doc-sync` (which includes the corpus-wide pairing check plus `verify-md-wrap`/`verify-md-links`) runs once at PR level per [dsh-pre-push-checks](../dsh-pre-push-checks/SKILL.md), not inside each translation task.
5. Keep the PR reviewable: state which pairs are new versus minimally updated and list 「待定术语」 prominently.

## How to respond to translation review

Follow the [code-review reporting guidance](../dsh-code-review/SKILL.md#reporting-findings): evaluate each comment on its merits, and for terminology comments, remember the terminology table is the contract — apply a reviewer's rendering decision to [terminology.md](../../../docs/i18n/terminology.md), not only to one file.
