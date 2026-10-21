---
name: dsh-code-review
description: Use when reviewing a pull request in the deepseek-harness repo — orients the reviewer to this codebase's standards (AGENTS.md conventions, defensive patterns, ADRs, quality gates) and the review-specific checks that code alone can't show
---

# Reviewing a DeepSeek-Harness PR

**This skill is guidance, not a complete checklist.** Verify and fetch the PR's live base and exact head, then run `pnpm --silent run change-scope --base <verified-base-ref> --head <verified-head-ref>` before reading the diff and enough surrounding code to understand the design. The report identifies paths and dirty layers but does not replace semantic review. Re-establish the base and rerun it after a retarget or merge. Prioritize correctness, lifecycle, security, and broken required behavior over style; a short review with one substantiated blocker is better than a list of nits.

**Read the requirements before judging the diff.** Map the changed paths to the artifacts below, open each owning page from [Sources of truth](#sources-of-truth), and only then read the diff against those requirements. Judging a diff against memory of the rules is how a violation passes review.

## Sources of truth

- [AGENTS.md](../../../AGENTS.md) and [packages/AGENTS.md](../../../packages/AGENTS.md): standing repository and package authoring rules.
- [docs/defensive-patterns/](../../../docs/defensive-patterns/README.md): the architecture requirements a change must satisfy and the habits behind them. Each page owns one artifact; read every page the diff touches:
  - [general.md](../../../docs/defensive-patterns/general.md) — timing, async state, value representation, shared ownership, decentralization, refactors, migrations, performance evidence, disposal, callbacks, subprocesses.
  - [package-surface.md](../../../docs/defensive-patterns/package-surface.md) — exports, package shape, build faces, dependency declarations, resolve hooks.
  - [remote-and-api.md](../../../docs/defensive-patterns/remote-and-api.md) — remote services, `@Remote` methods, API dispatch, business ownership in `packages/api`.
  - [client-components.md](../../../docs/defensive-patterns/client-components.md) — client components, slots, stores, hooks, effects, shared base packages.
  - [conversation-and-session.md](../../../docs/defensive-patterns/conversation-and-session.md) — projection reads, Session retention, conversation nodes, renderers.
- [docs/AGENTS.md](../../../docs/AGENTS.md): documentation placement and prose discipline.
- [dsh-prose-standard](../dsh-prose-standard/SKILL.md): required coverage and editorial judgment for comments, docs, prompts, and visible strings.
- [dsh-ci-test-reliability](../dsh-ci-test-reliability/SKILL.md): isolation and regression-proof rules for resource-owning, asynchronous, or flaky tests and fixtures.
- [dsh-client-ui-ux](../dsh-client-ui-ux/SKILL.md): feedback-surface choice, overlay safety, platform window adaptation, and visual token discipline for product-user-visible GUI changes.
- [dsh-error-handling](../dsh-error-handling/SKILL.md): failure classification, handling ownership, containment, state guarantees, and actionable reports.
- [dsh-session-projection](../dsh-session-projection/SKILL.md): projection ownership, state size, historical reads, and migrations.
- [docs/testing.md](../../../docs/testing.md) and the [quality-gates reference](../../../docs/testing.md): required test tiers and gates.
- [Agent Notes](../../notes/README.md): design rationale. Treat disagreement with an Agent Note as a design discussion, not an automatic veto.
- For bilingual changes, read [translation-rules.md](../../../docs/i18n/translation-rules.md) and [terminology.md](../../../docs/i18n/terminology.md); the extended translation skill is outside automatic review and runs only on explicit user invocation.

## Blocking requirements

1. **New prose receives semantic review.** Use [dsh-prose-standard](../dsh-prose-standard/SKILL.md) to critically review every added or changed Markdown passage, JSDoc, comment, prompt, description, diagnostic, and visible string. Verify required coverage, accuracy, placement, and editorial quality against the owning code or behavior; automated checks do not establish those properties.
2. **Docs match the code.** Config, defaults, errors, wire fields, events, and public behavior update the package README and JSDoc in the same diff. Comments state non-obvious contracts; flag implementation narration, test walkthroughs, review history, and duplicated rationale for deletion or a link to their one home.
3. **Core type docs match.** Changes to spine or seam vocabulary update the appropriate [subsystems](../../../docs/subsystems/README.md) page and any `type-equiv` entry. Internal types need no catalog entry.
4. **Cordis ownership and cleanup.** When reviewing Cordis plugin code or helpers reachable from its entrypoints, load and apply [cordis-styling-nitpicking](../cordis-styling-nitpicking/SKILL.md) to the changed behavior and affected consumers. Check its three P0 rules: singleton state, unreversed effects, and cleanup dependencies released before consumers finish. Verify each new registry contribution passes the disposal tests required by [packages/AGENTS.md](../../../packages/AGENTS.md).
5. **Required evidence exists.** Verify the author ran the [relevant local checks](../../../AGENTS.md#run-relevant-checks-locally) for the diff and that CI covers the exhaustive matrix; review the semantic gaps neither can detect.
6. **Client UI copy is locale-owned.** Reject product text embedded in JSX, templates, helper returns, accessibility attributes, or primitive defaults. Require typed dictionary keys, the standard `t` seat or explicit localized props, `verify-client-ui-i18n`, and behavior evidence in each affected locale; preserve user/model/wire data and code tokens verbatim.

## Manual checks

- **Intent and interface contracts:** trace both sides of every changed interface. Confirm the implementation matches the PR and any Agent Note, including errors, cancellation, ownership, and disposal.
- **Error handling:** apply [dsh-error-handling](../dsh-error-handling/SKILL.md) to changed failure paths, including their state guarantees and final user-visible reports. Reject catch-and-continue unless the state owner establishes that subsequent work's preconditions hold, including after recovery.
- **Lifecycle and concurrency:** for async setup, callbacks, processes, or teardown, apply [defensive-patterns/general.md](../../../docs/defensive-patterns/general.md). Check races before publication, cancellation during awaits, independent error reporting, callback containment, ownership before reentry, complete detach cleanup, and quiescent disposal.
- **Scope, ownership, and necessity:** first identify the required behavior behind each new distinction, field, adapter, state machine, option, defensive copy, and compatibility path. A requirement, check, or Agent Note introduced by the PR is a design choice to assess, not independent evidence of necessity. Compare existing source fields, discriminants, and their consumers before accepting another representation; distinguish deleting a concept from relocating its declaration. Moving an unnecessary concept closer to its owner is not a simplification. Challenge unrelated features and speculative generality against [the root rules](../../../AGENTS.md#conventions).
- **Capability and consumer fit:** trace every current consumer, then flag consumer-specific behavior leaking into the interface under [the package rules](../../../packages/AGENTS.md). For required behavior, prefer an existing extension point near its producer or consumer when the local implementation adds little complexity, following [the ownership rule](../../../docs/defensive-patterns/general.md#a-business-capability-owns-itself); compare producer-owned declaration merging with changes to distant core or shared type declarations. Flag the inverse too: a new public method on a generic service (registry, session, agent) whose only caller is one internal consumer is an unnecessary API expansion — require a private capability closure handed to that consumer at construction instead.
- **Configuration and public choices:** trace authoritative reads and precedence before accepting another CLI or configuration pass-through; a forwarded value may be shadowed before use. Ask what current-consumer evidence or prior art supports each default, public operation set, format, or imported external concept. Require an explicit choice or deferral when that evidence is absent.
- **Model perspective:** inspect the exact prompts, tool schemas, results, and diagnostics the model receives across affected modes. Flag concepts outside the model's task, then verify stable text verbatim and dynamic behavior through snapshots or end-to-end coverage.
- **Enforcement:** follow every denial path to the operation that executes it; exercise direct and alternate callers that can bypass schemas, prompts, facades, wrappers, or listener ordering.
- **Borrowed and derived state:** determine whether each retained value is borrowed or owned under the package contract, then trace notifications and every cache, prompt, UI echo, replay, and query view to the documented success point and authoritative source.
- **Bounds cover the final operation:** locate the owner of the complete emitted or retained result, including wrappers and metadata. Probe tiny and exact limits, oversized single chunks, and multibyte text for byte limits.
- **Real entry path:** tests exercise the shipped Loader, bin, worker, ACP bridge, or subprocess where relevant. A hand-mounted plugin does not catch invalid Loader exports; a function plugin must named-export its namespace and have no default export.
- **Test strength:** assertions fail on the intended regression and verify external state, logs, events, or disposal rather than restating the implementation or trusting an agent's report. Coverage is necessary but not evidence that the scenario is correct.
- **Test reliability:** for a resource-owning, asynchronous, platform-sensitive, or flaky test, apply [dsh-ci-test-reliability](../dsh-ci-test-reliability/SKILL.md) to the real worker/job topology, resource allocation, global-state restoration, synchronization, timeout budget, and quiescent teardown.
- **Negative controls:** verify a deliberately invalid case fails through the real runner for each changed acceptance rule.
- **Implemented Agent Notes match shipped reality:** when a PR implements a proposed Agent Note, move and rewrite it as present-tense shipped state in the same diff, then verify paths, names, and mechanisms against the implementation.
- **Transcript changes:** editor-visible or model-visible changes update snapshots or explain why no snapshot applies. Review expected-output diffs as behavior changes, not formatting noise.
- **Bilingual changes:** compare meaning and terminology on both sides; a green pairing hash does not prove translation quality.

## Reporting findings

State the defect, location, impact, and evidence. Place a localized defect inline on the tightest relevant diff range; use a PR-level comment for cross-cutting architecture, scope, or review-wide synthesis. Separate blockers from suggestions and omit issues already enforced by a green gate. Use the existing GitHub review thread for replies. When receiving review, verify each claim and fix or rebut it on technical grounds without performative agreement.
