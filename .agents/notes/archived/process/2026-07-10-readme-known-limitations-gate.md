# Agent Note: A gated Known-Limitations section in every package README

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-10-readme-known-limitations-gate.zh.md)

## Problem

The [documentation standard](../../../../docs/AGENTS.md) assigns limitations to package READMEs. Without a shared shape, an omitted section cannot distinguish an audited absence from forgotten documentation, and variant headings prevent a repository-wide search.

## Decision

Every package manifest under `packages/<group>/<pkg>/package.json` has a sibling README with the canonical `## Known Limitations and Deferred Work` section. Its bullets record durable consumer gaps and non-obvious maintainer constraints owned by that package; ordinary cleanup remains in its source TODO or owning Agent Note. The [`verify-package-readme-limitations` gate](../../../../scripts/verify-package-readme-limitations.ts) derives the package set from manifests, rejects missing READMEs, and requires exactly one canonical h2 with at least one top-level bullet. Near-miss headings such as “Limitations,” “Deferred,” “What is NOT here,” or “Non-goals” fail.

A package with nothing to declare is listed in `NO_LIMITATIONS` and omits the section. Adding a limitation requires removing the entry; renames and removals fail because every entry must name a scanned package.

The gate checks presence, shape, and the allowlist. Review under the documentation and [prose](../../../skills/dsh-prose-standard/SKILL.md) standards owns coverage and accuracy. The standing rule lives in [packages/AGENTS.md](../../../../packages/AGENTS.md).

## Alternatives considered

- **Free-form headings** — cannot be searched uniformly and still need near-miss detection.
- **Require an empty section or “None.”** — boilerplate can remain after a package gains a limitation; an allowlist makes absence explicit and reviewable.
- **Impose a word ceiling** — legitimate limitation counts vary, so review governs this unbudgeted README tier.

## Consequences

- New packages declare qualifying limitations or explicitly join the allowlist; missing, drifted, and empty sections fail `doc-sync` locally and in CI.
- The gate adds one dependency-free TypeScript script to `doc-sync`.
- Renaming the enforced heading requires changing the script and every package README together.
