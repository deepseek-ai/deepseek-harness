---
name: dsh-find-simplifications
description: 'Use when working in the deepseek-harness repo to find non-obvious simplification candidates, remove redundant comments or implementation-heavy documentation, write proposed Agent Notes or inline TODO/FIXME/XXX notes, audit or coalesce superseded Agent Notes, or fold worthwhile simplification ideas from another PR; especially for dead, duplicated, speculative, over-built, added-then-removed, or hand-rolled-where-a-dependency-exists surfaces.'
---

# Finding DeepSeek Harness Simplifications

This skill helps turn a broad "find things to simplify" request into evidence-backed Agent Notes that remove or collapse existing harness surface area. It is guidance, not a checklist: follow the code, keep judgment active, and prefer a few well-proven candidates over a pile of thin guesses.

## Start With Repo Context

- Read `AGENTS.md`, especially the pre-release stance and the conventions (including the tests-are-not-golden-truth and Agent Notes-are-not-golden-truth doctrines), plus [docs/defensive-patterns.md](../../../docs/defensive-patterns.md) and [docs/testing.md](../../../docs/testing.md).
- Skim [docs/architecture.md](../../../docs/architecture.md) before judging anything under `packages/`; simplifications that fight the service map or event taxonomy need extra evidence.
- Use the Agent Note tree and its [rules](../../notes/README.md) to understand intentional architecture. The most relevant implemented examples are [drop mutable session summary](../../notes/implemented/simplification/2026-06-19-drop-mutable-session-summary.md), [shared persistence write coordinator](../../notes/implemented/architecture/2026-06-18-shared-persistence-write-coordinator.md), [JSONL-only first-party Session persistence](../../notes/implemented/simplification/2026-08-30-jsonl-only-session-persistence.md), [capability seams](../../notes/implemented/architecture/2026-06-13-capability-seams.md), and the twin-adapter Agent Notes.
- Treat dual LLM adapters as intentional by default. Session persistence is different: JSONL is the sole first-party provider, while the backend-neutral service remains available to out-of-tree providers. Do not propose deleting an LLM twin or the persistence seam as "low effort" unless the user explicitly overrides that constraint. Removing an unused method or hook inside a protected seam can still be valid if it does not collapse the protected design.

## What Counts As A Strong Candidate

A strong simplification removes, folds, or demotes something real and has clear evidence that the current design costs more than it buys:

- A public method, event, config knob, registry notification, helper, package, durable event, or test artifact has no production consumer.
- Tests or docs are the only consumers, and the behavior they pin is not load-bearing.
- Two representations mirror the same fact, especially across durable session events and transient `agent/*` events.
- A seam has methods every implementation must support but no consumer uses.
- A separate package exists only for test/demo/support code and adds publish or dependency overhead.
- A feature implements speculative product generality: multi-session/session-load, background job rosters, live registry invalidation, mid-turn steering, tool-owned UI rendering, and similar designs with no product owner.
- An invariant, rollback path, set of expected outputs, or special-case test exists only to protect an unused API.
- Hand-rolled code reimplements what a well-maintained external package or a Node builtin at the engine floor already provides, and the swap would delete the implementation plus its dedicated tests ([dependency policy](../../notes/implemented/process/2026-07-26-dependencies-over-hand-rolling.md)).
- The simplified behavior may differ slightly, but the new behavior is still reasonable and easier to explain.

Thin candidates are not enough for an Agent Note: deleting one typo, running `knip` once, removing an intentionally documented backend/adapter, or flagging "this looks complex" without call-site proof.

### Audit invariant companions

Treat an invariant companion as useful only when it compares independently produced observations that can diverge. Remove empty installers and checks that merely inspect service presence, plugin metadata, fixed examples, or the result of calling the same mutation they claim to verify. For every omission, remove the export, build entry, invariant-only compiler reference or dependency, and companion-only test, then record the package-specific reason in both package READMEs. Keep a companion when it compares distinct event producers, durable history, or independently mutable data, even if the package also validates inputs synchronously.

## Survey Broadly

Use parallel subagents when the user asks for breadth or many candidates. Give each agent a domain and require evidence, not guesses. Useful domains:

- Agent loop and session log: turn/step boundaries, steering, abort/cancel, durable events, replay, load/resume.
- ACP automation and human UI APIs: prompt settlement and teardown on the protocol side; transcript rendering and interaction state on the UI side.
- LLM/tools/system prompt: stream/generate APIs, assemblers, registries, tool schema defaults, presentation hooks.
- Bash and tool execution: foreground/background split, job ownership, output spill files, executor methods.
- Packages/examples/scripts/tests: package splits, static inventories, redundant snapshot expected outputs, support packages.

If subagents are unavailable, simulate the same breadth yourself. Do not let the first good candidate stop the survey.

Start with the largest production-code deltas. A broad simplification audit that stops after obvious unused symbols can miss the files where duplicated lifecycle or defensive machinery carries most of the cost.

## Simplify Prose With The Code

Treat comments and documentation as maintained surface area. Apply [dsh-prose-standard](../dsh-prose-standard/SKILL.md) when a survey includes prose.

- Delete comments that restate code or explain behavior owned elsewhere; keep required local contracts.
- Keep docs at their owning level; omit implementation details and rare cases unless they change a maintained contract.

## Audit Trust And Lifecycle Boundaries

For every defensive copy, freeze, validator, and callback capture, name where the value came from and who owns it next. Same-process typed service/plugin calls ordinarily borrow readonly values; parsers, config loaders, queues, model/tool JSON, durable files, workers, processes, and wire decoders own or validate their data. Tests built around hostile getters, fake typed objects, callback replacement, or mutation after a same-process handoff are evidence of a potentially speculative contract, not automatic justification for keeping it.

For complex asynchronous code, draw the ownership graph and map each sentinel, readiness promise, cancellation path, disposer, and state flag to a distinct owner or transition. When several mechanisms mirror the same liveness or settlement fact, propose one transaction or lifecycle controller instead. Preserve separate machinery where it protects synchronous publication and rollback, callback containment, first-terminal-outcome arbitration, worker/process ownership, or dispose-to-quiescence.

## Hand-Rolled Code Versus A Dependency

Introducing a dependency is a valid simplification move, not a policy exception: the [dependency policy](../../notes/implemented/process/2026-07-26-dependencies-over-hand-rolling.md) owns the bar. When surveying, ask of protocol parsers, framers, retry/backoff loops, glob matchers, diff engines, and similar infrastructure: does a well-maintained npm package or a Node builtin at the repo's engine floor already do this?

Prove a dependency-swap candidate like any other, plus:

- Read the hand-rolled implementation and name the exact surface the package covers; residual semantics the package does not cover count against the swap and stay in the Agent Note.
- Check the package's health honestly (maintenance, adoption, transitive footprint) and prefer builtins when the engine floor has them.
- Check the Agent Note tree first: schemastery, vendored Cordis, the twin adapters, and other recorded seams are settled — a swap that collapses one needs to beat the recorded rationale, not just cite the policy.
- Weigh net deletion: implementation plus dedicated tests plus docs, minus the glue that remains. A wrapper that relocates the same complexity is not a win.

## Prove Or Reject Each Candidate

For every symbol or behavior, classify consumers before writing:

- Production corpus: `packages/*/src`, `examples/*/src`, `examples/**/*.yml`, runtime scripts, and loader/config paths.
- Non-production corpus: tests, README/docs, Agent Notes, snapshots, generated expected outputs, and comments.
- Ambiguous corpus: examples and scripts that may be product smoke paths. Inspect usage before classifying.

Use `rg` first. Good searches include the exact symbol, event name, package name, config key, method name with both `.name(` and `name(`, and any wire strings. Then read the call sites, public interfaces, dynamic event names, tests, docs, and Cordis loader paths.

Reject or downgrade a candidate when:

- A production caller exists and the simplification would be a feature decision rather than a cleanup.
- The API is explicitly justified by an implemented Agent Note or a hard-won defensive pattern, and the new evidence does not beat that reason.
- The removal would force unrelated churn without actually reducing the public API or required behavior.
- The idea is correct but tiny. Add a targeted TODO/FIXME/XXX instead, using the urgency semantics in [docs/development.md](../../../docs/development.md).

## Coalesce Superseded Agent Notes

Audit the Agent Note tree when the user asks to reduce or coalesce it, or when the simplification being implemented makes an owning note obsolete. Do not expand every code-simplification survey into a repository-wide note audit.

Use [`dsh-archive-agent-notes`](../dsh-archive-agent-notes/SKILL.md) for retention judgment and archive mechanics. Low-future-value implemented notes move as frozen triplets to `archived/{kind}`; proposed notes are never archived; rejected notes that no longer prevent a tempting mistake are deleted. Do not edit an archived note while simplifying current prose or code.

Follow the deletion rule in the [Agent Note rules](../../notes/README.md#when-to-write-one); do not duplicate or weaken it here. For each candidate chain:

1. Identify the current owner from shipped code, configuration, generated catalogs, package docs, newer Agent Notes, and inbound links; dates and titles are discovery hints, not proof.
2. Classify the old note as fully or partially superseded. Any surviving behavior, current contract, durable format, compatibility obligation, or independently current rejected alternative makes it partial. Rationale that can be transferred to the current owner does not by itself make supersession partial.
3. For full supersession, move every unique rationale, alternative, consequence, shipped verification evidence, and named coverage gap into the current owner. An inventory that only describes deleted implementation mechanics is not one of those decision facts.
4. Repair every inbound link, then delete the English note, Chinese counterpart, and consistency record together.
5. Search exact filenames, symbols, config keys, event names, and wire strings after the edit. Keep partial supersessions cross-linked and current.

An added-then-removed feature is a common full-supersession case. Let the removal note own the history only when the feature is absent from production code, configuration, schemas, durable or wire formats, migration, and compatibility behavior; no current documentation presents it as available; and no test exercises it as supported behavior. Removal rationale and tests that enforce absence may remain. Preserve why the feature originally existed, why that motivation no longer justified it, alternatives to full removal, the capability given up, conditions for reintroduction, and evidence that removal is complete. Old tests and implementation mechanics that verified only the deleted behavior are not current verification evidence.

Reject consolidation when the removal is only one transport, default, implementation, or presentation of a feature; when persisted data or compatibility handling survives; or when the removal note does not yet carry enough rationale to prevent accidental reintroduction. A current negative design decision may legitimately need its own note even though the removed implementation is gone.

## Write The Agent Note

Create one file per durable proposal under `.agents/notes/<lifecycle>/<class>/yyyy-mm-dd-topic.md`, following the lifecycle and classification rules in `.agents/notes/README.md`. Keep prose paragraphs on one physical line and use relative Markdown links.

Prefer this structure, adjusting when the idea needs it:

- `# Agent Note: <action-oriented title>`
- `Status: proposed`
- `## Problem`: name the current API, cite the relevant files, and state the consumer evidence. Separate production callers from tests/docs.
- `## Proposal`: say exactly what to remove, fold, demote, or rehome. Include tests, docs, READMEs, JSDoc, event-taxonomy, snapshot, and generated-file cleanup when relevant.
- `## Why not keep it?` or `## What we give up`: make the strongest counterargument legible.
- `## Acceptance criteria`: observable end state and gates.
- `## Risks`: public API changes, behavior changes, future product wants, and why the tradeoff is still reasonable.

Be concrete enough that an implementing PR can follow the trail. Avoid vague "simplify this package" Agent Notes. When a proposal overlaps an existing Agent Note, consolidate the useful details into the existing one rather than creating a duplicate.

## Inline TODO Notes

Use inline TODO/FIXME/XXX only for small, local cleanups that are clearly useful but not durable design decisions. Keep them short and actionable:

- Name the smell with a stable tag, e.g. `TODO(double-default)` or `XXX(unused-default)`.
- Explain why it is safe to revisit and what action would simplify it.
- Do not add TODOs for speculative complaints or for behavior that needs an Agent Note-level decision.

## When Folding Another PR Or Branch

Diff the sibling branch against `origin/master`, not against the current PR branch, so you see its independent contribution. For each item:

- Port non-overlapping Agent Notes or TODOs that meet the quality bar.
- Consolidate overlapping material into the existing Agent Note that owns the topic.
- Do not port duplicate or lower-confidence proposals just to preserve the count.
- Update the PR body so reviewers see the true candidate count and scope.
- Close the duplicate PR only when the user asked you to, or when you clearly own that housekeeping.

## Validation And PR Hygiene

For docs-only Agent Note work, run at least `pnpm run doc-sync`, `pnpm run lint`, and `git diff --check`. For code comments or skill changes, also run the relevant validator when one exists. Select any other evidence from the outgoing diff; the pre-push hook contributes typecheck only.

When opening or updating a PR, summarize:

- How many Agent Notes and inline notes were added, consolidated, retained as partial supersessions, or deleted.
- The main areas surveyed.
- What was intentionally excluded.
- Which checks passed.

For each consolidation group, name the old and current owners, state the evidence for full supersession, and explain why deletion is safe. If an added-then-removed scan finds no qualifying note, report that result and the representative partial cases retained.

Use a draft PR while the survey is still expanding; mark ready only when the candidate set, review responses, and validation are settled.
