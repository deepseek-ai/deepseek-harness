# Bilingual documentation

English | [中文](README.zh.md)

This repo's documentation is read by people and agents both inside and outside the company, so every document in scope is maintained in English and Simplified Chinese. This page defines the pairing contract, checks, scope, and exclusions; [translation-rules.md](translation-rules.md) defines how to translate; [terminology.md](terminology.md) is the terminology source of truth. Routine agent work follows the lightweight path in [docs/AGENTS.md](../AGENTS.md); the extended [.agents/skills/dsh-translate-docs](../../.agents/skills/dsh-translate-docs/SKILL.md) workflow is available only through explicit user invocation.

## The pairing contract

- **Both languages carry equal authority.** A document may be authored and reviewed in either language first — a Chinese-first Agent Note is as legitimate as an English-first one — and the counterpart is translated from it. Neither file outranks the other; what binds them is that they must say the same thing.
- **A pair is three sibling files.** The English `foo.md`, the Chinese `foo.zh.md`, and a consistency record `foo.i18n.yaml`, all in the same directory. No locale directories, no separate translation repo, no interleaved bilingual files. Pairs merge whole: a PR never lands one language without the other two files.
- **The consistency record.** `foo.i18n.yaml` holds one entry per heading section that still contains language-specific content. The key is the section's English heading-slug path (`/` for text before the first heading; a repeated path gets `~2`, `~3`, …), and the entry holds a hash of the English and of the Chinese blocks in that section that differ between the two sides:

  ```yaml
  /foo:
    en: 41d772192075e133
    zh: dda91c6c670cfd9d
  /foo/usage:
    en: 86940bea4a3c7ed6
    zh: de78429597783c7f
  ```

  Section `i` of one side corresponds to section `i` of the other. Each side's hash covers every top-level block of the section except fenced code blocks and generated regions, the two kinds of content the gate already requires to be identical on both sides; content that merely happens to be identical is still hashed. A section with no remaining blocks has no entry. Regenerating a region or editing a code block on both sides leaves the record unchanged, and edits to different sections change separate record lines, so Git's default text merge, including GitHub's, composes them. A record conflicts only when both branches changed hashed content in the same section; resolve the Markdown and re-record the pair. An out-of-sync pair is updated by patching the counterpart minimally against the edited side's diff, never by re-translating whole files; the gate names each changed section. Routine work makes that patch directly; when the user explicitly invokes the extended workflow, `pnpm run gen-translation-brief <pair>` recovers the last-confirmed text from the newest commit whose contents produce the recorded entries, assembles the update at the narrowest safely aligned granularity, and `--apply` can splice a code-fence-only change after structural validation. After bringing the pair back in line, `pnpm run verify-translation-pairing --write <pair>` re-records the entries; that yaml diff is the reviewable act of confirming consistency, which is why `--write` requires naming the pairs you confirmed (`--write --all` is the explicit corpus-wide form).

  The Chinese file must retain its English backlink; an authored English source must retain its Chinese link, while a listed generated English source is exempt. The [section-keyed pairing records Agent Note](../../.agents/notes/implemented/process/2026-09-23-section-keyed-translation-pairing-records.md) owns the record format and its alternatives.
- **Language switcher.** The Chinese file always links back immediately after its H1 heading with `[English](foo.md) | 中文`. An authored English file reciprocates there with `English | [中文](foo.zh.md)`; a listed generated English source omits that line so it remains byte-identical to generator output. A README published outside GitHub, such as PyPI project metadata, may use the canonical `https://github.com/deepseek-ai/deepseek-harness/blob/master/<repository-path>` URL to the same counterpart so the switcher still resolves there.
- **Structure mirrors the counterpart.** Heading depths and order, list kinds, ordered-list starts, list item counts, table row and column counts, semantic link targets with exact query/fragment suffixes, and verbatim code blocks match one to one across the pair. When a relative document link targets the active bilingual corpus, the English side uses its `.md` path and the Chinese side uses its `.zh.md` path. A missing counterpart in that corpus is a pair-completeness error rather than a fallback; targets outside the active corpus keep the authored path. See [translation-rules.md](translation-rules.md) for the full preservation rules. Existing Markdown gates apply to `.zh.md` files unchanged (`verify-md-wrap`, `verify-md-links`).

## The gate: verify-translation-pairing

`pnpm run verify-translation-pairing` (part of `doc-sync`, which contributors run locally for documentation changes and CI runs exhaustively) enforces the contract mechanically:

1. Every document in scope has a complete pair. README discovery is case-insensitive on the basename, so `missions/readme.md` is in scope alongside the other documentation roots.
2. Every pair artifact that exists at all is complete and consistent: all three files present, the record is canonical and its entries equal the entries computed from the current contents (changing language-specific content on either side without re-confirming the pair goes red), the Chinese side and every authored English source carry their language switchers (listed generated English sources are exempt), every ordinary relative document link uses its source side's target locale, and the structural signatures match in order — heading depths, verbatim code blocks (info string and content), table row and column counts, list kinds, ordered-list starts, item counts, and semantic link targets with exact query/fragment suffixes apart from the switcher.
3. Files listed as `excluded` have no `.zh.md` and no `.i18n.yaml` at all. Frozen Agent Notes under `.agents/notes/archived/` are outside this evolving gate; their dedicated verifier requires and seals the complete existing triplet instead.

Source-oriented code gates consume an exact `.zh.md` fence sequence as a derivative of its unsuffixed sibling instead of compiling or manifesting the same code twice. The sequence must match in length, order, fence kind, and byte-exact body; otherwise both copies remain independently checked and the pairing gate reports the structural mismatch.

`pnpm run verify-translation-pairing --list` prints the current pairing state of every document in scope — missing, out-of-sync, or ok. It never fails; `missing` and `out-of-sync` rows identify violations that the normal check rejects.

`pnpm run verify-translation-pairing <pair...>` checks just the named pairs — any of a pair's three files (or its bare stem) names it — so an update loop verifies its own pair in seconds instead of re-scanning the corpus. The no-argument corpus-wide form is what `doc-sync` and CI run; a scoped green never substitutes for it at PR level.

The practical rule this gate creates: **when a PR edits either side of a paired document, the same PR updates the counterpart directly in one terminology-guided pass and re-records the pair with `--write <pair>`**, exactly like the repo's existing doc-sync rule for code and READMEs. A PR that leaves a pair out of sync goes red in CI.

The gate's limit, stated plainly: **a green gate means the pair was confirmed consistent at these exact contents, not that the confirmation was sound.** It checks hashes and Markdown structure; it cannot judge whether the two sides say the same thing, or whether the wording is accurate, well-termed, and natural — that is the reviewer's half of the contract, per [translation-rules.md](translation-rules.md). A re-recorded pair with a sloppy counterpart passes the gate; it must not pass review.

## Scope and exclusions

**Scope**: the root `CONTRIBUTING.md`, `BRAND_GUIDELINES.md`, and `SAFETY.md` documents, every non-vendor README, and every active document under `.agents/notes/**`, `docs/**`, and `python/**`. README matching is case-insensitive on the basename and covers future directories without another manifest edit. Dependency and ignored build-output trees and the frozen `.agents/notes/archived/` tree are discovery exclusions, not evolving translation source.

Generated English references and graphs participate in pairing when a reviewed Chinese counterpart is available. A generator puts its generated data in generated regions and writes each region into both pages, so regeneration never requires a manual Chinese update or a new record; only the prose outside the regions is translated and recorded. Freshness and pairing gates enforce their respective invariants independently.

Shared generated regions, such as the Cordis subsystem regions and the per-package regions of the [config catalog](../config-catalog.md), keep every generated byte identical across languages except localized paired-document paths; labels inside a region are code identifiers rather than translated words. A full-page generator can also render source-owned paired prose, such as [persistence-catalog-text.ts](../../scripts/persistence-catalog-text.ts), from the same structural data with matching Markdown structure and identical code blocks. It regenerates both pages and their consistency record together; review still verifies the paired prose's meaning and terminology.

Generated English sources omit the language switcher that ordinary authored sources carry, because adding it would make the generator stale; their Chinese counterparts still link back to the English source. A manually maintained Chinese counterpart may rewrite only self-referential generation and maintenance statements that would otherwise be false for the reviewed translation; all technical content remains subject to the ordinary faithfulness rules.

**Excluded** (never paired, and the gate rejects a `.zh.md` or `.i18n.yaml` for them):

- [cordis-api/inherited.md](../cordis-api/inherited.md) — generated without a reviewed Chinese counterpart, so both website locales project the English source.
- `docs/AGENTS.md`, `.agents/notes/**/AGENTS.md`, and their `CLAUDE.md` instruction symlinks — agent instructions, maintained in English only like the root `AGENTS.md`.
- `docs/i18n/terminology.md` and [style-samples.md](style-samples.md) — both are bilingual by construction.
- [translation-prompt.md](translation-prompt.md) — the automated pipeline's prompt template; its body is machine-consumed verbatim, so a paired translation would change pipeline behavior.
- [review-ownership/README.md](../../.github/review-ownership/README.md) — repository-internal approval policy maintained in English only.
- `.agents/notes/archived/` — frozen historical triplets. [`verify-archived-agent-notes`](../../scripts/verify-archived-agent-notes.ts) validates their completeness and content seals; translation maintenance must never rewrite them.

**Universal requirement**: every current or future document in scope must merge as a complete bilingual pair. [scripts/translation-pairing.manifest.json](../../scripts/translation-pairing.manifest.json) contains only explicit exclusions; there is no per-file rollout list, date cutoff, or README-specific policy class.

## Division of labor

Routine counterparts are updated directly by the working agent in one pass after it loads [terminology.md](terminology.md); it does not invoke a translation skill, generate a briefing, run a separate translation-review pass, or delegate to a subagent. The extended [dsh-translate-docs](../../.agents/skills/dsh-translate-docs/SKILL.md) workflow retains those heavier mechanisms for explicit user invocation. The gate checks pair completeness, recorded hashes, the Chinese backlink and authored-source switcher (with the documented generated-source exception), and its documented structural signature. Review still owns translation quality, terminology, and structural requirements that the signature does not encode. The prompt contract is executable: [scripts/translation-prompt.ts](../../scripts/translation-prompt.ts) renders the committed template (terminology injected; the template carries its own calibrated rules) into either direction and parses the three-section response, while `verify-translation-prompt` exercises both render directions and the checked-in example in `doc-sync`.
