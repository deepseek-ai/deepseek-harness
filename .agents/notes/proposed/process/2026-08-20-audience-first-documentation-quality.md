# Agent Note: Audience-first documentation quality criteria

Status: proposed

English | [中文](2026-08-20-audience-first-documentation-quality.zh.md)

## Problem

The documentation system has strong placement, freshness, linking, bilingual, and source-equivalence checks, but it does not define “brief, intuitive, and friendly” as reviewable outcomes for users, newcomers, developers, and agents. All `doc-sync` checks and translation pairs pass, while the following design problems remain. The first three findings are the design priorities; the capacity finding explains why adding more standing rules will not solve them.

### Semantic correctness can pass without a current owner

The gates prove structure and generated freshness, not that maintained prose still names the live mechanism. The former `dsh-doc-site-sync` skill told authors to reuse a nonexistent `en-docs` sidebar and to add sections to a removed `sectionOrder`; [website/docs.ts](../../../../website/docs.ts) owns `en-guide`, `en-develop`, `en-reference`, and `sections`. The implemented [product-first README decision](../../archived/process/2026-07-22-product-first-root-readme.md) describes an internal-testing notice and ACP, Python, and JSON-RPC surface sections absent from the [root README](../../../../README.md), although implemented Agent Notes must track shipped facts.

The budget policy has the same split. [docs/AGENTS.md](../../../../docs/AGENTS.md#wordcount-budgets) states a 1,800-word target and 5% headroom for `architecture.md`, but the [budget manifest](../../../../scripts/doc-budgets.manifest.json) allows 2,400 words while the file contains 1,313. The budget gate passes because it checks the manifest ceiling, not the target or ratchet rule. High-impact prose therefore needs a named source or a focused check that consumes the source; a second hand-written copy is not a freshness mechanism.

### Reader success is implicit rather than testable

The standard classifies pages as tutorials or references and asks authors to classify a tutorial reader privately. It does not require a reviewable statement of the reader’s starting state, desired outcome, shortest successful path, likely failure, or next useful page. A document can therefore satisfy tier placement, links, word limits, and Markdown structure without proving that its intended reader can complete the task.

The public site makes the pressure visible. Each locale publishes 84 pages: 3 guide pages, 17 developer pages, and 63 reference pages. The 13 English files under `docs/user/` contain 7,540 words, while 47 subsystem pages contain 100,759 words. The short Web quick start is a good product entry, but no corpus-level criterion verifies that a first-time user, a plugin newcomer, and a maintainer each has one obvious path from entry to outcome and recovery.

### Generated accuracy and retrieval quality are conflated

The repository contains 19 fully generated English Markdown files with 49,611 words. Forty-four of 47 subsystem pages also contain generated Cordis regions; those regions contribute 34,622 of the subsystem tier’s 100,759 words. `config-catalog.md` has 14,807 words, `tool-catalog.md` has 10,599, and the largest mixed subsystem pages contain 5,600–7,781 words.

These are legitimate exhaustive references, so a blanket word limit would delete value. Their generators prove completeness and freshness, but the standard has no separate retrieval criterion for an agent with a limited context window or a human looking for one answer. A generated reference needs a compact entry layer, stable grouping, direct anchors, and a split rule based on lookup cost; exhaustive detail can remain exhaustive behind that entry layer.

### The standard has no room for its next rule

The standing documentation file is 1,320 words against a 1,320-word ceiling and a stated 1,250-word target. Root `AGENTS.md` is 1,936 words against a 1,600-word target, `packages/AGENTS.md` is 672 against 650, and `packages/README.md` is 969 against 600. The frozen ceilings prevent further growth but do not create a place for audience and outcome criteria. Adding more standing prose would deepen the problem the standard is meant to prevent.

### Baseline

The audit excludes `vendor/`, frozen `.agents/notes/archived/`, recorded snapshots, and fixtures. It counts 1,042 English Markdown files and 986 Chinese counterparts in the maintained corpus, with 1,106,138 English words. Active Agent Notes account for 580 files and 637,850 words; Markdown under `packages/` accounts for 276 files and 225,630 words; `docs/` accounts for 112 files and 193,456 words. These quantities describe maintenance and retrieval pressure, not defects by themselves.

The system’s strongest properties should remain: one fact owner by tier, canonical Markdown projected into the website without copies, complete bilingual pairing, generated catalogs that fail when source changes, type-equivalent declarations, compilable TypeScript examples, checked links and anchors, and package-local model-experience and limitation contracts. The proposal changes quality criteria and entry structure, not those guarantees.

## Proposal

Adopt one audience-first quality contract with five definitions:

- **Brief** means the common path contains only the facts needed for its outcome. Exhaustive contracts remain available through a direct link or generated detail; brevity never means deleting required behavior, failures, ownership, or limitations.
- **Intuitive** means the page establishes its reader’s starting state, introduces prerequisites before dependent concepts, offers one obvious next action, and uses the product or domain terms a reader will search for.
- **Friendly** means a reader can recognize success, understand material risk before acting, recover from the likely failure, and reach the next relevant depth without first learning unrelated architecture.
- **Accurate** means every durable claim has one owner and a verification path appropriate to its risk. Generated facts derive from source; hand-written workflow values link to or consume their owner instead of copying enums and paths.
- **Agent-readable** means headings, anchors, terminology, ownership, and current-versus-proposed status are explicit enough to retrieve the needed section without loading an entire corpus or reconstructing review history.

### Prototype rules

The [dsh-doc skill](../../../skills/dsh-doc/SKILL.md) owns the first executable version of these rules. The `session-persistence-jsonl` README pair uses the shipped append, recovery, and encoding behavior as evidence rather than treating its prior prose as authority.

- Every authored package README starts with searchable YAML. A Skill-style `description` and mechanically derived `kind` are required. Four kinds map one-to-one to four skill templates: `package-group` (group map), `package-reference` (plugin or service package), `package-library` (plain module entry), and `package-bundle` (`dsh.bundle.patch`). The counterpart path, hashes, and physical line alignment belong to the merge-safe sidecar and its gate, so README frontmatter contains no `i18n` block. The title or package manifest already owns the name, the document job expresses its audience, and tags remain absent until a governed taxonomy and search consumer proves value beyond full-text search.
- Authored pages start with a three-to-five-sentence `Summary`, then a linked `Table of Contents`. Format-owned Agent Notes, postmortems, generated fragments, and machine files keep their required skeletons.
- Each substantive section starts with a short orientation before subsections, tables, or code, and the page progresses from basic user use to advanced developer and maintainer detail.
- English technical prose uses an ASD-STE100-inspired, non-certified clarity review: explicit actors and actions, stable terms, direct verbs, separated instructions and conditions, and preserved modality, exceptions, timing, and numbers. The 20-word instruction and 25-word description limits are review prompts. Precision overrides them.
- Package contracts remain beside code. Cross-package material moves deliberately toward `docs/learn/overview/`, `docs/learn/cordis/`, `docs/learn/practices/`, `docs/user/`, `docs/developer/`, `docs/developer/discussion/`, `docs/scratch/`, and the parallel `docs/subsystems/` tier.
- English and Chinese pages keep equal authority, matching structure, links, code, frontmatter layout, and exact physical line count.
- Inline pair metadata is the target replacement for sidecars. The prototype may carry both until the verifier, merge driver, recovery flow, generated-region recorder, and archive checks consume a non-self-referential pair digest.
- Repository-root internal links are the target authoring model. The prototype keeps renderer-valid relative links because leading `/` currently leaves the repository on GitHub, bypasses `verify-md-links`, and remains unprojected by the website.
- `Further Exploration` is an optional newcomer route to three to seven adjacent pages.
- Every authored page ends with `Dev Note`, the sole place for active rough context. It remains non-authoritative, links rather than duplicates task state, and is promoted or cleaned when work closes.
- Independently searchable rules, practices, examples, and decisions use small files under descriptive folders when they have distinct owners or change cadence; tightly coupled obligations stay together.

### Criteria by document job

| Job | Primary outcome | Required entry information | Verification |
|---|---|---|---|
| Product quick start | Complete one representative task | Prerequisites, one launch path, first success, safety boundary, next step | Built or packaged smoke for the documented path plus link/site checks |
| User task guide | Complete or recover one user task | Starting UI/API state, ordered actions, observable result, likely failure and recovery | Behavior test, screenshot review when visual state matters, or named manual owner |
| Contributor tutorial | Reach a checked development state | Supported runtime, setup commands, expected result, narrow follow-up commands | Clean-checkout command smoke on a supported environment |
| Architecture overview | Reconstruct the system from one page | Product composition, owners, dependency direction, extension points, links to detail | Source-backed package or graph checks plus focused human review |
| Package or subsystem reference | Look up one contract without reading implementation | Scope, owned types or behavior, failures, lifecycle, limitations, related owners | Existing JSDoc, type-equivalence, generated-region, README, and link checks |
| Generated reference | Locate one exact item and trust its completeness | Scope, generation owner, grouping/index, stable anchors, related conceptual guide | Deterministic `--check`, completeness fixture, site build, and retrieval-size report |
| Agent instruction or skill | Apply one workflow without stale copied values | Scope, authority links, required decisions, exact commands only when owned here | Metadata/link checks and focused tests for copied machine values |
| Proposed or implemented Agent Note | Understand a decision, trade-off, and state | Problem, proposal or decision, alternatives, acceptance or consequences | Existing lifecycle, format, pairing, and supersession checks; review owns semantic currency |

The table belongs in one canonical quality reference. `docs/AGENTS.md` should retain only the short standing orders needed whenever documentation is edited and link to that reference. This creates budget headroom instead of placing another complete standard inside agent context.

### Generated-reference entry and detail layers

Every generated reference should expose a compact entry layer before exhaustive output: scope, intended lookup, grouping or index, direct links to conceptual guidance, and the generator/check command. Generators should report page words, entry count, heading count, and largest section. A page crosses a review threshold when one lookup requires scanning unrelated groups or when one page dominates agent context; the owner then splits it by a stable domain already present in source metadata rather than by an arbitrary word slice.

The first prototype should use one large catalog and one mixed subsystem page. It should compare lookup steps, generated diff size, build time, route stability, and agent context needed for representative questions before any corpus-wide split. Existing anchors need aliases when routes move.

### Enforcement slices

1. Create and validate `dsh-doc`, then rewrite one package README pair as a line-aligned, metadata-bearing prototype without changing runtime claims.
2. Review the rendered prototype with newcomer, user, developer, and agent tasks; revise the skill before enforcing the format elsewhere.
3. Add narrow metadata, section-order, line-alignment, link-resolution, and pairing fixtures. Keep sidecars until every merge and recovery consumer has replacement support.
4. Extract accepted standing rules into one canonical quality reference, condense `docs/AGENTS.md` below its target, and organize one coherent `docs/` topic at a time with atomic link/navigation repair.
5. Prototype generated-reference entry/detail separation on `config-catalog.md` and `docs/subsystems/core.md`; apply confirmed patterns elsewhere only after measured lookup cost falls without lost facts or route churn.

This sequence keeps each change independently reviewable. The first three slices improve criteria and correctness without rewriting the corpus; the generated-doc prototype supplies evidence before a broader information-architecture change.

Slices 1–3 have shipped in this form: `dsh-doc` is the consolidated standard (`dsh-doc-standards` and `dsh-doc-site-sync` are folded into it, and the site workflow carries the corrected sidebar values), the `session-persistence-jsonl` README pair is the reference example, and `pnpm run test:docs` enforces the metadata, pairing, and quick documentation checks. Slices 4–5 remain open.

### Non-goals

This proposal does not shorten exhaustive facts, merge audience tiers, publish internal decision records, restore an Agent Note index, split tightly coupled rules for file-count symmetry, or treat the audit as user research. It does not delete current pairing or link infrastructure before its replacement passes equivalent recovery and rendering checks.

## Alternatives considered

**Apply one word ceiling to every document.** Rejected because exhaustive reference rows, public contracts, and decision rationale can be long and correct. Entry-path length and lookup cost are the relevant constraints for those jobs.

**Require one universal page template or audience frontmatter.** Rejected because it would add ceremony to generated pages, package references, and short instructions without proving reader success. The standard defines outcomes by document job, uses `kind` only where it selects a concrete package-document standard, and adds only fields that a focused check or reviewer consumes.

**Use readability scores as the quality gate.** Rejected because formulas penalize exact technical terms and cannot detect wrong ownership, missing failure behavior, stale commands, or a broken reader journey.

**Rewrite or split the full corpus immediately.** Rejected because the current system is mechanically healthy and many long references are appropriately exhaustive. A prototype should prove a retrieval improvement before route and translation churn spreads.

**Keep the existing gates and rely on review for friendliness.** Rejected because the stale workflow values and budget-policy mismatch show that review alone does not preserve copied semantic claims, and the current gates do not ask whether a reader can complete a task.

## Acceptance criteria

- One canonical quality reference defines brief, intuitive, friendly, accurate, and agent-readable documentation by document job.
- `.agents/skills/dsh-doc` validates and directly links its metadata, structure/hierarchy, and review/prototype references without duplicating their detailed rules in `SKILL.md`.
- The `session-persistence-jsonl` README pair demonstrates searchable YAML, Summary, Table of Contents, user-to-developer progression, Further Exploration, final Dev Note, structural parity, and exact line-count equality while preserving verified package contracts.
- `docs/AGENTS.md` links that reference, remains sufficient as standing instruction, and is below its target with at least 5% headroom.
- The root user path, Web quick start, first-plugin tutorial, contributor setup, and architecture overview each name an observable outcome and a verification owner without duplicating implementation detail.
- The budget manifest records both target and temporary ceiling, and its check reports or rejects a violated headroom/ratchet state.
- The docs-site workflow contains no copied invalid sidebar name or section-owner claim, and a focused test prevents recurrence.
- The sidecar remains the single consistency record because it preserves equal authority, last-confirmed-text recovery, automatic merge safety, generated-region recording, and archive sealing without creating owner-file conflicts.
- An accepted repository-root link form renders correctly on GitHub and the documentation site and remains locally target/anchor checked before relative links are migrated.
- One large standalone catalog and one mixed subsystem page demonstrate a compact entry layer and lower measured lookup cost while preserving exhaustive generated truth, stable links, bilingual pairing, and deterministic freshness.
- `pnpm run doc-sync`, `pnpm run lint`, the focused new checks, and `git diff --check` pass.

## Risks

- Metadata can become boilerplate; the package README check therefore permits only fields with current retrieval, template-selection, or bilingual-consistency consumers.
- Hard sentence limits can fragment explanations or separate a condition from its consequence. The controlled-English word counts remain review prompts, and exact contracts override them.
- Exact line alignment can pressure translators into unnatural prose; review must protect meaning and may revise both sides together rather than weaken one.
- Splitting generated references can increase routes and link maintenance; prototypes must preserve aliases and measure the trade-off.
- A semantic check can become a repository-topology scanner that blocks legitimate changes; checks should cover high-risk copied values and representative journeys, while review owns prose meaning.
- Package README quick-reference tables manually repeat selected configuration defaults; until a source-driven check owns them, reviewers must verify changed values against source and the generated config catalog and keep the tables selected rather than exhaustive.
- Optimizing for short agent context can make human references fragmented; each split needs one stable conceptual owner and one obvious navigation path.
- A permanent Dev Note can become a second queue or stale history dump; completion must promote durable truth and remove resolved chatter.
- The audit uses repository structure, gates, and representative pages rather than user research. Before broad rollout, maintainers should validate the proposed reader outcomes with actual newcomer, user, developer, and agent tasks.
