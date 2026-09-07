# Agent Note: Localize bilingual document links

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-18-localized-bilingual-links.zh.md)

## Problem

GitHub resolves repository Markdown links directly, without the documentation website's locale projector. Requiring both sides of a bilingual pair to retain the same raw `.md` destination therefore sends readers from Chinese source files to English pages even when a reviewed `.zh.md` sibling exists. The website masks this error by routing ordinary links through the current locale, so the repository source and the published site previously produced different navigation results.

## Decision

A repository-relative document link follows the source file's locale when the target belongs to the active bilingual corpus: English sources use the target `.md`, and Chinese sources use its `.zh.md`. Both sides retain the same semantic target and exact query/fragment suffix. A missing counterpart in that corpus is a pair-completeness error rather than a fallback; external URLs, images, pure in-page fragments, and targets outside the corpus remain unchanged. The language switcher is the explicit cross-locale exception.

Page-navigation links whose intended target is a tutorial landing page name `index.md` or `index.zh.md` explicitly, so GitHub opens the page rather than a directory listing. The audited basic, framework, and practice entries use those concrete targets; ordinary package, source, example, and manifest directory references remain valid, and no generic directory-link prohibition exists.

The pairing core resolves relative paths against the repository tree, applies the active-scope and manifest-exclusion predicate, and normalizes paired locale paths to one English-sibling identity for structural comparison. `verify-translation-pairing` separately rejects a wrong-locale target with the source file, line, actual URL, and expected URL. The merge driver, mechanical translation briefing, and Cordis generator use the same scope predicate and semantic comparison, so they accept locale-correct path differences without weakening any other structural requirement.

The Cordis subsystem-region generator renders one catalog model, then projects paired document destinations for the Chinese output. Generated-region comparison normalizes only these paired locale paths; markers, prose, ordering, code, non-document URLs, and query/fragment suffixes remain byte-equal.

Existing active bilingual sources use the locale-correct target. A Chinese target that lacks an English fragment id exposes an explicit `<a id>` alias before the corresponding translated heading, so both source files keep one stable fragment suffix without a separate translation map. Pair consistency records name the migrated contents.

## Verification

Pairing tests cover English and Chinese locale selection, out-of-scope targets with siblings, in-scope targets missing a counterpart, switcher exclusion, exact query/fragment retention, non-inference of directory targets, definitions, rewrites, and diagnostics. Documentation-site tests also pin the audited basic, framework, and practice entry links to explicit index pages in both locales. Merge-driver, translation-brief, and Cordis generator tests cover their respective consumers. Corpus checks require zero wrong-locale links, resolvable fragments, fresh generated regions, current pair records, and a successful documentation-site build.

## Alternatives considered

**Keep `.md` destinations on both sides.** This preserves raw target equality but makes GitHub navigation leave the Chinese corpus. Website rewriting cannot repair repository rendering.

**Use translated heading fragments.** Locale-specific fragments require each link producer to know a translated heading and create a second mapping whose lifecycle can drift. One shared suffix plus an explicit target alias keeps the stable identifier with the target document.

**Maintain a locale-link manifest.** Pairing discovery, the exclusions-only manifest, and the sibling naming convention already determine whether a target belongs to the corpus and which paths form its pair. A second registry would duplicate identity and require updates for every move or new pair.

**Rewrite links only during publication.** The website already does this, but GitHub and other repository renderers consume the source files directly. Correct source paths are the user-visible behavior.

## Consequences

GitHub readers remain in the language they selected when a target belongs to the active bilingual corpus, and future regressions fail in the same corpus-wide pairing check that owns bilingual structure. Pair sides intentionally differ in paired document path spelling, while every other link property stays aligned. Stable English fragment aliases add small permanent identifiers to translated targets, and generators that own both outputs must project locale paths before recording the pair.
