# Agent Note: Validate published document fragments

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-13-published-document-fragments.zh.md)

## Problem

`verify-md-links` validates fragments with GitHub's Markdown heading ids, while the documentation website renders headings with VitePress. Punctuation-heavy headings and translated headings can therefore pass source validation but produce links to ids absent from the published HTML. A successful VitePress build validates target pages, not fragment ids.

## Decision

`docs:build` and its MPA variant run `verify-doc-site-fragments` after VitePress emits `website/.dist`. The verifier parses every emitted HTML page, resolves each internal fragment link against VitePress clean URLs, and fails when the output is absent, routes are ambiguous, an href is malformed, or either the target page or requested id is missing. Unit tests cover those failures plus clean URLs, `.html` aliases, same-page links, encoded and literal ids, and external-link exclusion.

Any fragment target heading whose GitHub id differs from its VitePress id carries an explicit GitHub-compatible alias. Authored English and translated pages place the alias before the heading; translated pages use the English id shared by the bilingual pair. Generated config, tool, and persistence catalogs emit the alias from their owning generator. Source Markdown validation remains independent and continues to reject links that do not resolve under repository rendering.

The file path follows the source document's locale when a paired target exists, as defined by the [localized bilingual links decision](2026-08-18-localized-bilingual-links.md); the query and fragment suffix remain identical across the pair.

## Alternatives considered

**Use locale-specific fragments.** Bilingual pairs intentionally preserve an identical fragment suffix even though a paired file path follows the source locale. Locale-specific fragments would require every link producer to know the target locale's translated heading.

**Rely on VitePress heading ids.** Those ids depend on rendered punctuation and localized heading text. They do not preserve the GitHub ids already used by repository links and generated references.

**Check source Markdown only.** This leaves the published artifact unverified and cannot detect differences between the GitHub and VitePress slug algorithms.

## Consequences

Every production documentation build reads its emitted HTML once, adding a bounded post-build check to the existing site build. Cross-page fragment links now require an id that survives publication. Explicit aliases become part of the published reference and let headings change language or punctuation without invalidating established fragments.
