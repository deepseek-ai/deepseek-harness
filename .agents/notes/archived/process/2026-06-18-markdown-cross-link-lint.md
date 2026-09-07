# Agent Note: Markdown cross-link validity linting

Status: implemented
Archived: 2026-09-04

English | [中文](2026-06-18-markdown-cross-link-lint.zh.md)

## Problem

Docs in this repo link to each other by relative path — `[topic](../implemented/2026-…-….md)`, `[the cookbook](adding-a-tool.md)`, `[architecture.md](../../architecture.md)`. Nothing verified those targets exist. A rename or a move silently breaks every inbound link, and the break is invisible until a reader clicks it. [Doc-sync enforcement](../../archived/process/2026-06-11-doc-sync-enforcement.md) already mechanized two classes of doc drift (uncompilable code blocks, a stale event-taxonomy table) and [verify-md-wrap](../../archived/process/2026-06-11-doc-sync-enforcement.md) a third (hard-wrapped prose) — but a dead cross-link is a fourth, equally mechanical class that was still verified by eyeball.

The motivating case is the Agent Note tree reorganization that introduced this gate: unifying `docs/adr/` + `.agents/notes/` into one `.agents/notes/` with `proposed/`/`implemented/`/`rejected/` subfolders renamed roughly forty inter-doc links by hand. A single fat-fingered path would have shipped a broken link with nothing to catch it.

## Decision

A fourth `doc-sync` gate, `verify-md-links` (`scripts/verify-md-links.ts`), mirroring the `verify-md-wrap` style (tsx ESM, AST-based, verify-don't-generate):

- Parse each in-scope Markdown file with `mdast-util-from-markdown` + GFM and walk every `link`, `image`, and `definition` node.
- Check a target only when it is a **relative path**. Skip scheme-qualified URLs (`https:`, `mailto:`, …), protocol-relative (`//host`), root-absolute (`/path` — no stable base in a checkout), and pure in-page anchors (`#section`). Strip any `#fragment`/`?query`, resolve the path against the linking file's directory, and assert it exists on disk.
- Report and never rewrite; exit non-zero on the first broken link found.

Scope matches the other gates plus the AGENTS.md pair and the repo-authored agent-skill Markdown under `.agents/skills/` (those skill files cross-link into the docs tree, so this reorg rewrote links in them too): `README.md`, `docs/**/*.md`, `packages/*/README.md`, `AGENTS.md`, `packages/AGENTS.md`, `.agents/skills/**/*.md`, deduped by real path (the `CLAUDE.md` symlinks resolve onto the AGENTS.md files). It is wired into `doc-sync`, so relevant documentation changes and CI exercise the same broken-link check.

The gate now also checks `#fragment` anchors on Markdown targets — same-file anchors included — against heading slugs and explicit `<a id>`; the [fragment-anchor decision](2026-08-09-md-fragment-anchor-gate.md) owns that mechanism and the slug rules.

## Alternatives considered

**Anchor-level validity checking** — deferred here as heavier and lower-value (file-level dead links were the failure that had actually bit), leaving authors to verify `#fragment` anchors themselves. That manual rule did not hold; the [fragment-anchor decision](2026-08-09-md-fragment-anchor-gate.md) later added the check.

## Consequences

- Renames and moves that orphan a cross-link fail `doc-sync` and CI instead of waiting for a reader to click a dead link. This made the Agent Note reorganization that introduced the gate self-verifying: the check proves none of its own rewritten links dangle.
- One more fast tsx script in the `doc-sync` chain; no new dependency (the mdast/GFM stack is already in devDependencies for `verify-md-wrap`).
- The convention this enforces — cross-reference docs by machine-checkable relative link, never by bare prose or a number — is documented in [docs/AGENTS.md](../../../../docs/AGENTS.md) so authors know the gate exists and why.
