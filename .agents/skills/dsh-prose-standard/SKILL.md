---
name: dsh-prose-standard
description: Use when writing, reviewing, restoring, trimming, or auditing prose in the deepseek-harness repo, including deciding where documentation or comments are required across Markdown, JSDoc, code and test comments, prompts, descriptions, diagnostics, and CLI or UI strings.
---

# DeepSeek Harness Prose Standard

Write enough to preserve the contract, then remove reasoning transcripts, repetition, and decoration. A contract is an obligation, invariant, precondition, postcondition, or compatibility promise that a caller, callee, implementer, producer, or consumer relies on. This skill owns editorial judgment and required prose coverage; use [dsh-doc](../dsh-doc/SKILL.md) for placement, budgets, bilingual pairs, and documentation gates, and [dsh-trim-cot-leakage](../dsh-trim-cot-leakage/SKILL.md) for hunting and fixing reasoning-transcript leakage. It is guidance, not a script.

Treat `contract`, `boundary`, `shape`, `surface`, `seam`, `gate`, and `vocabulary` as terms to check before use, not banned words. First ask whether the exact rule, API, field set, type, validation, timing point, component split, or failure states the fact better. Keep a term when it names the exact technical subject, including caller/callee contracts and security/process boundaries.

Comments describe non-obvious contracts or rationale that code cannot express; they do not restate what code already implies.

## Inputs and exclusions

Require an explicit `scope`. If it is missing, report the required input and stop; do not infer a repository-wide scope or begin an interview.

Accept `mode: automatic | interactive`; default to `automatic`. Enter interactive mode only when the user explicitly requests questions or calibration.

`mode` controls questions, not write authority. Review and audit tasks report findings without editing; explicitly requested write, fix, or trim tasks apply clear changes.

Always exclude `vendor/` from discovery, review, and edits, even when the requested scope is the whole repository. Do not follow a symlink into it. Put exclusions after inclusion globs so a later include cannot re-admit it: for example, end ripgrep commands with `--glob '!vendor/**'`, and give Git commands an explicit `:(exclude)vendor/**` pathspec. If the requested scope contains only `vendor/`, report that no eligible files remain.

Also exclude `.agents/notes/archived/` from prose review and edits. Archived Agent Notes are frozen snapshots; inspect an exact target only to understand a historical inbound citation, never to modernize its prose or outbound links.

Treat generated catalogs, snapshots, and fixtures as derivative. Trace every consumer before editing: source JSDoc may also feed a generated model-visible catalog. Edit the owning source or scenario first, then regenerate every derivative. When a generator extracts a summary from owner prose, make the extracted sentence complete for that surface. Bilingual pairs have no permanent owner: either language may be the authored side for an update. Follow the [lightweight routine path](../../../docs/AGENTS.md#writing-rules), update the counterpart minimally, and re-record the pair.

## Preserve the complete proposition

Before editing, identify every proposition in the passage. Preserve each relevant:

- actor and action;
- condition, timing, and ordering;
- modality such as must, may, or never;
- negative guarantee and exception;
- ownership, side effect, failure mode, and consequence.

Remove adjectives, repetition, and narration only when every factual clause survives and the result is clearer. A smaller word count alone is not an improvement.

Keep a complete local contract at the point of use: behavior, failure, ownership, and consequence that a caller or maintainer needs there. Aggressively link to the owning document for architecture, rationale, algorithms, history, or extended examples. One explanation has one home; essential contract facts may repeat locally.

Keep non-obvious rationale when omitting it could plausibly cause misuse or an incorrect simplification. Otherwise state the consequence and link the rationale home.

## Required coverage by prose location

This is not a one-way shortening pass. Add or restore prose when code, types, and structure do not communicate a required contract below. Do not add a comment when those facts are already obvious locally.

- **Public JSDoc:** document caller-visible return distinctions, throws or rejections, side effects, ownership, timing, cancellation, and durability.
- **Internal comments:** orient non-local structure and obviously complicated local structure, including invariants, race ordering, ownership, security boundaries, and surprising failure behavior. Delete control-flow narration and code restatement.
- **Module comments:** state the module's role, dependencies, responsibilities, and non-obvious architecture choices; link architecture choices to their owning explanation.
- **Tests:** explain only non-obvious test design—why a fixture, assertion, platform accommodation, real entry path, or indirect observation is necessary. Delete walkthroughs and inventories.
- **Cookbooks:** include prerequisites, required actions, the real entry path, observable verification, and concise warnings.
- **READMEs:** include the consumer contract: configuration, semantics, failures, limitations, extension points, and model-visible effects. Quote stable model-visible text owned by the package; link generated catalogs and cross-package owners. Keep durable gaps and maintainer traps, not ordinary cleanup inventories. Follow the [package README requirements](../../../docs/cookbook/adding-a-package.md#4-write-the-package-readme).
- **Agent Notes:** retain unique rationale, mechanisms, alternatives, consequences, shipped verification evidence, and named coverage gaps. Implemented Agent Notes state shipped reality in the present tense; remove planning checklists, not evidence of what pins the decision.
- **Postmortems:** retain the incident sequence, evidence, causal chain, impact, and prevention. Remove repeated persuasion or implementation detail that does not establish causality.
- **Skills and agent instructions:** state behavioral guardrails and explicit scope limitations such as “guidance, not a script/checklist.” Keep the workflow concise and link its source of truth.
- **Examples and configuration comments:** explain access limits, non-obvious wiring or load order, security stance, replay behavior, exceptions, and likely misuse. Do not narrate entries that the configuration already shows.
- **Prompts and visible strings:** treat wording as behavior. Client UI copy belongs in typed locale dictionaries and reaches Cordis-free primitives as explicit localized props; inspect text, accessibility names, tooltips, placeholders, and format templates together, then run `verify-client-ui-i18n`. English UI copy, including plugin `meta.title` and `meta.description`, uses sentence case: capitalize only the first word, proper nouns, and product names such as `Chrome DevTools`, `Git`, or `MCP` (`Git worktrees`, not `Git Worktrees`). Chinese copy keeps its own conventions. Update the owning runnable snapshot for model-visible text and repository-required GUI evidence. If the authorized scope has no owning scenario, leave the wording unchanged and report the deferral; do not silently fold it into a prose-only edit.
- **Diagnostics:** name the failing subject or path, violated rule, and correction when it is non-obvious. Remove internal execution narration.

Preserve searchable mechanism names and meaningful modal, temporal, or negative emphasis. Normalize decorative emphasis only.

## Workflow

1. Confirm the scope, mode, current branch or PR base, and applicable `AGENTS.md` files. Do not inspect unrelated branches.
2. Read [the documentation standard](../../../docs/AGENTS.md) and the owning code or document before judging a passage. For calibration or unfamiliar cases, read [the distilled examples](references/examples.md).
3. Inspect the requested scope, not only the largest files. Use searches and word counts to find candidates, then judge passages semantically.
4. Classify each candidate as keep, add, trim, restore, restructure, or defer. Apply clear changes only when the task authorizes edits; do not manufacture edits to satisfy a deletion target.
5. Update the owner before derivative artifacts. Re-check analogous passages after learning a new rule.
6. Run the narrow relevant checks, documentation gates, `git diff --check`, and behavior tests for visible strings. Verify the final diff contains no `vendor/` path and report any accidental vendor match rather than claiming a clean exclusion history.
7. Report the inspected scope, clear changes, deliberate keeps, deferred cases, and checks actually run.

## Borderline decisions

A case is borderline only when at least two versions satisfy the complete-proposition rule but trade accepted principles, and this skill does not already resolve the tradeoff. A rewrite with one proposition-preserving answer is not borderline.

In automatic mode, apply clear edits when authorized and report genuine borderline cases without asking questions. Do not weaken a proposition to make progress.

In interactive mode, group analogous passages under the governing principle. Present two or three viable versions, recommend one, and state the factual or structural difference. Do not offer inferior distractors. Use the user's requested channel; when calibrating a PR through inline comments, place the recommended provisional version in the diff and attach the alternatives to that exact line.

After the user decides, distill the principle and versions into [the examples](references/examples.md), without PR history or reviewer narration, and apply the learned rule to every analogous passage in scope.
