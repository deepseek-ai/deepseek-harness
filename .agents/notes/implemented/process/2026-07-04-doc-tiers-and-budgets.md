# Agent Note: Documentation structure, tiers, and budgets

Status: implemented

English | [中文](2026-07-04-doc-tiers-and-budgets.zh.md)

## Problem

Standing docs accumulated repeated rules, retold incidents, duplicated package maps, and stale Agent Note summaries despite existing writing guidance. That guidance also did not define how a document's place in the hierarchy limits its scope or how ordered teaching differs from lookup-oriented material. Because review alone did not prevent that growth, the repository needed a mechanical budget alongside its documentation taxonomy.

## Decision

- **Structure follows the documentation tree.** [docs/AGENTS.md](../../../../docs/AGENTS.md) is the documentation standard: a document owns detail about its subject, summarizes only the purpose, responsibility, and high-level behavior of direct children, and links to deeper owners. [Agent Notes](../../README.md) remain outside this structural contract. Every human-facing document is a tutorial with an ordered outcome or a reference with an explicit lookup scope; a [postmortem](../../../../docs/postmortem/README.md) is an incident-scoped reference whose chronology records evidence. Tutorials introduce concepts in prerequisite order for the reader's starting knowledge.
- **A tier taxonomy with one home per fact.** The standard assigns every Markdown tier one job, forbids restating a fact outside its home tier, and carries the slop checklist used when writing or reviewing any doc.
- **One product onboarding path.** The root README owns the recommended package-run path, the source-run alternative, and compact `dsh plugin --profile` usage. The published user guide starts with tasks inside the running Web UI, then links to distinct tutorials or reference owners for other interfaces, plugin development, and advanced configuration instead of repeating Web startup.
- **Narrow, hard budget gates.** [scripts/verify-doc-budgets.ts](../../../../scripts/verify-doc-budgets.ts) joins `doc-sync`: every doc listed in [scripts/doc-budgets.manifest.json](../../../../scripts/doc-budgets.manifest.json) must stay under its word ceiling (`wc -w` semantics, whole file), and a budgeted file that is missing fails the gate so a rename cannot silently orphan its budget. Its scope is deliberately only the accretion-prone standing docs — the root and subtree `AGENTS.md` files, `architecture.md`, `packages/README.md`, and the standing policy docs they evict content into (`docs/testing.md`, `docs/defensive-patterns.md`). Reference docs, Agent Notes, and complete package READMEs remain unbudgeted because exhaustive facts can be long. The separate [package Summary gate](../../../../scripts/verify-package-readme-summaries.ts) caps only each English package entry paragraph at 100 words and directs failures to `dsh-doc` and the selected kind template.
- **Ceilings are an enforcement frontier that ratchets.** A doc at or below its target keeps at least 5% headroom as its ceiling ratchets down; a doc above target keeps a frozen ceiling that prevents growth until it reaches the target (root `AGENTS.md` ≤ 1,600 words; `architecture.md` ≤ 1,800; subtree `AGENTS.md` ≤ 600 except `packages/AGENTS.md` ≤ 650 and `docs/AGENTS.md` ≤ 1,250; `packages/README.md` ≤ 600). When the gate goes red, relocate or condense; raise a ceiling only with explicit PR justification.
- **A thin workflow skill, contracts in docs.** [.agents/skills/dsh-doc](../../../skills/dsh-doc/SKILL.md) carries the placement, audit, budget, and website workflow and defers to the standard as its source of truth, the same split as [dsh-translate-docs](../../../skills/dsh-translate-docs/SKILL.md) over the i18n contract.

## Alternatives considered

- **Skill and review discipline without a gate** — rejected: the accretion above happened while the current-state rule and reviewer attention already existed; a prose rule with no mechanical backstop demonstrably does not hold here, and this repo's own [quality-gates stance](2026-06-11-quality-gates.md) says invariants worth keeping are worth encoding.
- **A broad gate over every complete doc** — rejected: a blanket ceiling punishes exactly the right kind of long doc (a feature matrix or type catalog where every row is a fact) and generates per-file override churn that trains contributors to rubber-stamp raises. The package Summary limit instead bounds one common entry paragraph without constraining its owning reference sections.
- **Independent onboarding tutorials for each documentation entry point** — rejected: duplicated setup steps drift in command order, first outcome, and product identity. A short README path followed by task-focused guides keeps the transition explicit without maintaining competing tutorials.
- **Housing the standard inside the skill** — rejected: contracts live in docs and workflows in skills; a standard packed into SKILL.md is invisible to an agent that edits docs without invoking the skill, and `docs/AGENTS.md` already loads as subtree instructions for anyone working under `docs/`.

## Consequences

- Adding to a budgeted doc requires displacement: relocate the addition to its taxonomy home with a pointer, or condense existing prose to pay for it. Growth without pruning fails CI.
- Structural review starts with ownership and document form before sentence-level editing, so lower-level detail moves to its owner instead of being polished in the wrong place.
- Readers reach a running Web UI before encountering headless execution, SDK embedding, custom profiles, or direct settings files; those interfaces remain available from their reference owners.
- Budgeted docs that remain above target cannot grow; reaching the target restores the 5% working headroom.
- Package references retain exhaustive owned facts below their entry paragraph, while every package Summary stays within the same 100-word retrieval budget.
- Word count is a crude proxy accepted deliberately: it cannot judge quality, but it forces the relocation decision at exactly the moment content is being added, which is when the author has the context to place it correctly.
