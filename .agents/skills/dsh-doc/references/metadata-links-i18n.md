# Metadata, links, and bilingual pairs

## Summary

README metadata is a retrieval and template-selection interface, not a miniature report or advertisement. The `kind` field selects exactly one README template that exists in this skill and maps to the document standard; the frontmatter carries no field that a filename convention or an executed gate already owns. Bilingual pages keep equal authority, one-to-one structure, and exact physical line alignment. The `*.i18n.yaml` sidecar records the last-confirmed pair and supports automatic merges. Link syntax must render correctly on GitHub and the documentation site, so repository links stay renderer-valid relative URLs.

## Table of Contents

- [README metadata](#readme-metadata)
- [The kind system](#the-kind-system)
- [Description quality](#description-quality)
- [Repository links and path mentions](#repository-links-and-path-mentions)
- [Bilingual line alignment](#bilingual-line-alignment)
- [Bilingual consistency records](#bilingual-consistency-records)
- [Dev Note](#dev-note)

## README metadata

Start every authored README with YAML frontmatter. Permit custom fields, but keep common fields stable enough for search and indexing.

```yaml
---
description: "Example capability for users and maintainers choosing, configuring, or debugging the package."
kind: "package-reference"
---
```

`description` and `kind` are required for package README pairs. The page title and package manifest already own the name, while the document job and its reader path express the audience; duplicating either in frontmatter adds no retrieval value. The counterpart path comes from the sibling filename (`README.zh.md`), and the sidecar owns pair state, so README-local `i18n` metadata is redundant. Do not add `tags` until a repository-owned taxonomy and search consumer justify them beyond description and full-text search. Keep keys lowercase and hyphenated unless an existing owner defines another spelling, and do not copy volatile code inventories into frontmatter.

## The kind system

`kind` selects the document template directly; every kind maps to exactly one template that exists in this skill, and no template exists without a kind. Files named `docs/persistence-changes/YYYY-MM-DD-slug.md` use `persistence-change`; files named `docs/persistence-changes/releases/dsh-v*.md` use `persistence-release`. Files named `docs/persistence-changes/historical-formats/vN.md` use `persistence-format`. Their Chinese siblings use the same kind. Folder READMEs are indexes, not records. Derive package README kinds mechanically, in this order:

1. The README is `packages/README.md` or `packages/<group>/README.md` → `package-group`.
2. The package manifest declares `dsh.bundle.patch` → `package-bundle`.
3. The package is in the audited library registry of `scripts/doc-standard.spec.ts` → `package-library`.
4. Everything else — a service default export or an `apply` plugin — is `package-reference`.

| `kind` | Repository position | Template | Standard |
|---|---|---|---|
| `package-group` | `packages/README.md`, `packages/<group>/README.md` | [package-group.md](../templates/package-group.md) | Group map: orient the capability family, map its direct packages, explain composition relationships, and link package-owned details. |
| `package-reference` | `packages/<group>/<package>/README.md` with a plugin entry | [package-reference.md](../templates/package-reference.md) | Package contract: follow the [package README review standard](review.md#package-readme-review) and the canonical [package documentation requirements](../../../../docs/cookbook/adding-a-package.md#4-write-the-package-readme). |
| `package-library` | `packages/<group>/<package>/README.md` with a plain module entry | [package-library.md](../templates/package-library.md) | Library contract: consumer entry points and boundaries; no profile-install path and no mount configuration. |
| `package-bundle` | `packages/<group>/<package>/README.md` declaring `dsh.bundle.patch` | [package-bundle.md](../templates/package-bundle.md) | Installable layer: the verified `dsh plugin` install path, layer semantics, and patch document. |
| `persistence-change` | `docs/persistence-changes/YYYY-MM-DD-slug.md` and its Chinese sibling | [persistence-change.md](../templates/persistence-change.md) | Historical acknowledgement: mechanically detected type changes, per-root predecessor references, compatibility decision, and generated after schemas. |
| `persistence-release` | `docs/persistence-changes/releases/dsh-v*.md` and its Chinese sibling | [persistence-release.md](../templates/persistence-release.md) | Retrospective observation: pinned tag, adjacent before/after digests, actual version constants, and changed after schemas; no compatibility acknowledgement. |
| `persistence-format` | `docs/persistence-changes/historical-formats/vN.md` and its Chinese sibling | [persistence-format.md](../templates/persistence-format.md) | Selected historical format: source evidence, complete root schemas and reachable types; the current writer uses the generated catalog. |

Before assigning `package-library` or `package-bundle`, inspect the facts: read `package.json` for `dsh.bundle.patch` and `src/index.ts` for the entry shape (`apply` export or a default service export is a plugin; a plain module API is a library). `dsh plugin --profile <name> add <package>` installs any npm dependency, but the profile reconcile activates a layer only for a package that declares `dsh.bundle`; never present that command as an install path for a library or a plain plugin. The documentation check derives the expected kind from these same facts, rejects another value, and rejects `name`, `audience`, `tags`, and README-local `i18n` metadata. Add a new kind only with a distinct template, an unambiguous repository position or declared owner, and a focused check that maps documents to it.

## Description quality

Agents search frontmatter `description` values to shortlist pages before loading full documents. Write each value like a Skill description: state what the page covers and when a reader should open it. Use one or two concrete sentences, include searchable domain terms, and distinguish the page from nearby owners. Do not summarize every section, claim superiority, repeat the title, advertise vaguely, preserve change history, or write a technical status report.

Good: `The shipped JSONL session-persistence backend for deployments and maintainers choosing, configuring, or debugging per-session durable logs with optional Zstandard compression.`

Weak: `The best and most advanced session storage implementation with lots of optimizations.`

## Repository links and path mentions

Keep link destinations machine-checkable and mentions context-relative. Use fragment-only links for the current page's menu. Use full URLs for external resources.

The desired internal-link model names a target from the repository root, but a leading `/docs/...` Markdown URL resolves outside the repository on GitHub, remains untouched by the website projector, and is skipped by `verify-md-links`. Until a repository-owned resolver supports root paths in every renderer, use the current renderer-valid relative URL in Markdown links and write logical path mentions such as `docs/` or `packages/session/` relative to the discussion. Never adopt an unchecked leading-slash link merely to resemble an absolute path.

## Bilingual line alignment

Keep English and Simplified Chinese equally authoritative. Match frontmatter key order, headings, blank lines, paragraphs, list items, tables, code fences, link targets, and total physical line count one to one. The English side points every relative link at the `.md` target; the Chinese side points it at the `.zh.md` sibling when that counterpart exists and falls back to the `.md` target otherwise — the pairing gate compares `.md` and `.zh.md` targets as the same document. Translate prose naturally within its corresponding line; do not hard-wrap either language. Keep code blocks byte-identical and reposition first-use terminology annotations without changing line structure.

Line equality is a structural check, not proof of faithful meaning. Review still owns completeness, terminology, natural language, and whether each line expresses the same proposition.

## Bilingual consistency records

Keep the `*.i18n.yaml` sidecar for every bilingual pair. It records a hash pair per heading section, excluding fenced code blocks and generated regions, so edits to different sections merge with Git's default text merge; generated data belongs in generated regions that the generator writes into both pages; `verify-translation-pairing` compares those entries with the current contents and verifies structure. Re-record it with `pnpm run verify-translation-pairing --write <pair>` after either language changes. Do not copy content hashes into README frontmatter: independent edits would change the same header line and turn otherwise mergeable prose into an owner-file conflict.

## Dev Note

None.
