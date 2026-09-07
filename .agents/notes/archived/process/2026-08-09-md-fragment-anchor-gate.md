# Agent Note: verify-md-links validates fragment anchors, closing the last dead-link class

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-09-md-fragment-anchor-gate.zh.md)

## Problem

`verify-md-links` proved a relative link's target file exists but never looked at the `#fragment`, and the documentation standard compensated with a manual rule: grep anchors yourself before renaming a heading. A corpus sweep found 15 links whose fragments named no anchor in their target — three distinct decay modes: a heading reworded after the link was written (`#security-and-authority-are-explicit-non-goals` vs the note's current `Security and authority are non-goals`), a contract relocated to a different owning document (`tool-fs` linking the seam README for the no-timeout rule that now lives in the group README), and zh pair sides linking English slugs their Chinese headings never produce (`#deferred-work` against `## 推迟工作`). None of these fail any gate, and each silently strands the reader at the top of the target page.

## Decision

`verify-md-links` now resolves fragments too (superseding the deferred scope cut in the [cross-link decision](2026-06-18-markdown-cross-link-lint.md)). For every relative link whose target is a Markdown file — same-file `#anchor` links included, which the old checker skipped entirely — the fragment must name a real anchor in the target: a heading's GitHub slug or an explicit `<a id>` in real HTML flow (code samples and commented-out anchors register nothing). Slugs are computed from the RENDERED heading text via the repository's own `markdownHeadingLines`, so links, inline code, and emphasis inside a heading slug as GitHub renders them; underscores survive (`#showcase-web_fetch`); repeated slugs get GitHub's occupied-set `-1`, `-2`, … suffixes; matching is exact-case, since element ids are case-sensitive. Fragments onto non-Markdown targets (`file.ts#L10`) carry renderer-owned semantics and stay out of scope, as do external and root-absolute URLs. Anchor sets are collected lazily for any existing target (`anchorCache`), so links INTO archived notes and vendor documents are validated without making those files sources.

The slug function differs from `gen-cordis-catalog`'s region-anchor slugger (which drops underscores): the generator's headings are always reachable through its explicit `<a id>` anchors, so the two need not share one rule. Chinese pair sides follow the existing repository convention (`docs/glossary.zh.md`, `docs/cordis-primer.zh.md`): keep the English fragment in the link and place an explicit `<a id>` before the Chinese heading, so both language sides expose identical anchors.

The 15 broken fragments are fixed in the same change: stale slugs retargeted to the current headings, the relocated no-timeout contract now linked at its owning group README, and four zh documents given explicit anchors. `docs/AGENTS.md` and the `dsh-doc` skill no longer prescribe the manual anchor grep for Markdown links; it survives only for anchors cited from TypeScript strings whose output never reaches gate-scanned Markdown (the three scanned references all render into scanned pages, so the gate covers them through the committed output).

## Verification

`scripts/verify-md-links.spec.ts` proves the acceptance paths: rendered-text slugging (backticks, punctuation, a linked heading, kept underscores), occupied-set repeat suffixes, `<a id>` ignored inside fences/inline code/comments, a resolving mixed-link document, dead same-file and cross-file fragments, a case-variant fragment, and a missing target still reported as `target` rather than `anchor`. The gate runs over the full corpus in doc-sync (`verify-md-links`) and passes only after the 15 fixes — the corpus itself is the red-to-green evidence for each decay mode.

## Alternatives considered

- **Keep the manual-grep rule.** It demonstrably did not hold: the 15 fragments decayed under a gate-driven maintenance culture, because heading rewrites happen in PRs that never look at inbound links. A mechanical invariant belongs in an executed gate.
- **Point zh links at Chinese-slug anchors.** GitHub slugs CJK headings fine, but the corpus convention is already explicit `<a id>` + English fragments (glossary, primer), which also survives renderers that strip non-ASCII; adopting a second convention would split the corpus.
- **Share `githubSlug` with the typert generator.** A one-function import would couple a doc gate to a package build, and the two rules genuinely differ (the generator strips underscores; its anchors are explicit `<a id>`s the gate reads directly), so divergence is by design, not drift.
- **Validate VitePress slugs as well.** The published site's dead-link check already runs in `website:build`; generated regions carry explicit anchors precisely so the two renderers agree, and hand headings that diverge would fail there.

## Consequences

Renaming a heading now breaks the build wherever a Markdown link cites its anchor, instead of stranding readers; authors fix the inbound links in the same change, exactly as they already must for file renames. Same-file anchors are no longer a blind spot, so zh pages must anchor any English fragment they use. The manual pre-rename grep survives only for anchors cited from TypeScript strings whose output never reaches gate-scanned Markdown.
