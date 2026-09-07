# Agent Note: Semantic phases for composer-chain election

Status: proposed

English | [中文](2026-08-08-semantic-composer-chain-phases.zh.md)

## Problem

The browser's `conversation.composer` chain orders every candidate by one global numeric `priority`, then elects the first selector returning a match. Question uses the default priority `0`, approval uses `1`, and the one-shot or unavailable-parent read-only subagent composer uses `-10`. A selected one-shot history can therefore show the read-only explanation while an answerable question or approval is pending underneath it.

The defect is not one incorrect number. The chain currently uses the same scalar for two different decisions: whether a candidate resolves an existing interaction or restricts starting new work, and the local preference between candidates of the same semantic kind. Any numeric repair preserves that hidden coupling and lets a later registrant recreate the bug.

## Proposal

A chain declaration may define an ordered tuple of domain-owned phases. `conversation.composer` declares `['interaction', 'restriction']`; every registration on that phased chain must name one phase, and its numeric `priority` orders entries only within that phase. `SlotCore` sorts by declared phase index, then local priority, then stable registration order. Registration fails immediately when a phased chain entry omits its phase or names one outside the declaration. Unphased chains retain their current numeric behavior.

Question and approval register in `interaction`, retaining their current within-phase order of question before approval. `SubagentReadOnlyComposer` registers in `restriction` with an ordinary local priority. The domain rule is precise: an interaction resolves a live Host wait that already exists; a restriction prevents the user from initiating work through the ordinary composer. Resolving an existing wait is not a new follow-up to the one-shot child, so the interaction phase goes first. Once the wait resolves, the chain re-elects and the read-only restriction becomes visible again.

The phase vocabulary belongs to the declaring slot, not to the slot framework globally. `SlotMap` carries the exact phase tuple for compile-time registration, and the runtime `SlotSpec` repeats that tuple as the sorting authority. Other chains acquire no composer terminology and need no migration unless they deliberately declare phases.

This proposal extends the [Web subagent conversation](../../implemented/feature/2026-07-27-web-subagent-conversations.md), [Web permission and approval](../../archived/feature/2026-07-23-web-permission-and-approval.md), and [plan-review presentation](../../archived/feature/2026-07-30-plan-review-presentation-intent.md) contracts; it supersedes none of them. The [runtime-owned child guard record](../../archived/bug-fix/2026-08-01-ask-user-delegated-caller-guard.md) introduced the guard that prevents new child-owned human waits. No active Agent Note should be archived when this proposal lands.

## Alternatives considered

**Move the read-only priority after question and approval.** This is the smallest tactical fix, but it leaves semantic dominance encoded as undocumented number spacing and makes the next composer kind guess at the same global scale.

**Make the read-only selector decline whenever `interactions` is non-empty.** This fixes the current pair but makes a restriction plugin understand every actionable domain and duplicates election policy across selectors. A new interaction kind would require edits in unrelated restrictions.

**Rely only on the runtime child guard.** The guard fixes new model calls but cannot define browser ordering for already-pending waits, rolling-version overlap, or other interaction kinds such as approval. Runtime authority and presentation election are separate invariants.

**Render all matching takeovers as a stack.** The composer has one action seat. Stacking question, approval, and read-only surfaces makes keyboard focus and answer ownership ambiguous instead of selecting one current action.

## Acceptance criteria

- `SlotCore` tests prove phase order dominates arbitrary local priorities, local priority and stable registration order still work within a phase, unknown or omitted phases fail loud, and unphased chains are unchanged.
- Composer tests cover question plus read-only, approval plus read-only, question plus approval plus read-only, resolution back to read-only, and the all-declined InputBar fallback. Question remains ahead of approval within `interaction`.
- Disposal, HMR re-registration, and reconnect replay cannot leave a stale elected phase; election remains a pure function of the current owner props and current registrations.
- A keyless assembled Web snapshot pins a one-shot addressed conversation with a pending interaction, the interaction surface winning, its resolution, and the read-only surface returning afterward.
- Slot, conversation, question, permission, and subagent README/JSDoc contracts describe phase ownership and the interaction-before-restriction rule together.
- The change modifies no model-visible tool definition, system-prompt section, request routing, or session event. Browser election therefore has no token cost and no KV-cache invalidation; tests compare the model request header before and after the client-only transition.

## Risks

Phase names can become a vague substitute for design. Each phased slot therefore owns a short ordering rule and rejects entries that cannot state which side they belong to. A future hard safety surface that must preempt answering should not be mislabeled `restriction`; it needs an explicit earlier phase or a boundary outside this composer chain.

The generic slot types and stored-entry shape gain one conditional field, so an incomplete migration could compile in one face yet fail at runtime. The exact tuple is repeated in the runtime declaration specifically to make that drift mechanically rejectable. Concurrent questions and approvals remain a single-surface policy; this proposal preserves their current order rather than solving multi-interaction queueing.
