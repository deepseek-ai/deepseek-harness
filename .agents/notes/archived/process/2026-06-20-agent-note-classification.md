# Agent Note: Classify Agent Notes by kind via path-encoded subdirectories

Status: implemented
Archived: 2026-09-04

English | [中文](2026-06-20-agent-note-classification.zh.md)

## Problem

A lifecycle-only Agent Note tree — `proposed/` / `implemented/` / `rejected/` — does not record what *kind* of decision each file contains. A reader browsing one lifecycle cannot distinguish a new capability from a removal or a tooling-policy change without opening each file.

The repo's standing bias is [mechanical quality gates over prose guidelines](2026-06-11-quality-gates.md): a convention that isn't machine-checked rots. So a classification scheme here had to be enforceable, not an honor-system header.

## Decision

Add a second axis — the Agent Note's **class** — and encode it in the path: `{lifecycle}/{class}/yyyy-mm-dd-topic.md`. The folder *is* the label. A file's location declares its class, the closed set is "these folders and no others," and the existing [verify-md-links](2026-06-18-markdown-cross-link-lint.md) gate already protects the path rewrites the move required.

### The closed set of six classes

| Class | Covers |
|---|---|
| `feature` | A new user- or model-facing capability. |
| `bug-fix` | Corrects a defect or closes a gap a postmortem surfaced. |
| `simplification` | Removes code, behavior, or surface area without adding a capability. |
| `architecture` | A structural decision about the **shipped source** — how packages relate, what the runtime vocabulary is. |
| `process` | Tooling, policy, or workflow **around** the code, not runtime behavior. |
| `testing` | Test infrastructure and strategy. |

The `architecture` / `process` line: **architecture** is about the source we ship; **process** is the surrounding tooling and workflow. This Agent Note is itself a `process` decision — it changes how the repo is organized and gated, not what the harness does at runtime — so it lives under `implemented/process/`.

### Two gates

Both are `doc-sync` members, in the `verify-md-wrap` style (tsx ESM, verify-don't-generate, exit non-zero on the first violation):

- **`scripts/verify-agent-note-classification.ts`** — the closed lifecycle and class sets. It asserts every file under a lifecycle folder lives in a class folder from the canonical set (a loose `.md` at a lifecycle root, or an unknown class folder, fails) and rejects a centralized `INDEX.md`. The canonical sets live in `scripts/agent-note-tree.ts`, and [the README](../../README.md) documents each class in prose.
- **`scripts/verify-doc-refs.ts`** — source comments that cite docs. Agent Note paths are referenced not only from Markdown but from TypeScript doc comments (root-relative prose like `.agents/notes/implemented/testing/2026-06-19-acp-snapshot-tests.md`). `verify-md-links` does not see those, so a reorganization could silently orphan them. This gate scans repo-authored `.ts` under `packages/**` (excluding built `lib/` and `vendor/`) for `docs/….md` and `.agents/notes/….md` tokens, resolves each root-relative path, and asserts it exists. It requires the `.md` extension so extensionless prose is left alone.

## Alternatives considered

- **A `Classification:` prose line** in each file (next to `Status:`), parsed by the gate. Workable, but it duplicates into the file a fact the path can already carry, and a line can disagree with its folder. Path-encoding makes the label and its storage the same thing — there is nothing to keep in sync.
- **A `refactor` class.** It overlaps `simplification` almost entirely; the only discriminator anyone reached for was "does observable behavior change?", which `simplification` already encodes (it does not). One class, not two.
- **A generated or hand-maintained corpus index.** Rejected because the lifecycle/class tree is authoritative, while a centralized inventory creates a merge hotspot without providing discovery that tree navigation or repository search cannot provide.

## Consequences

- Every Agent Note sits under a class folder. A reader can browse one folder to see all simplifications or all testing decisions within a lifecycle.
- Two more fast tsx scripts in the `doc-sync` chain; no new dependency (the mdast/GFM stack was already present for `verify-md-wrap`/`verify-md-links`).
- Adding a class is a deliberate act: amend the `const` in `scripts/agent-note-tree.ts` and the [Classification section](../../README.md#classification), not just `mkdir` a folder. The gate rejects an unknown folder, so an ad-hoc class can't slip in.
- Source-comment doc references are gated too — a moved or renamed doc that a `.ts` comment cites fails `verify-doc-refs` in `doc-sync` and CI, closing a drift class `verify-md-links` structurally could not see.
