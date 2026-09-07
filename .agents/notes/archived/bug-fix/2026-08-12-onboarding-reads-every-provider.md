# Agent Note: First-run readiness reads every provider, and the setup card closes

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-12-onboarding-reads-every-provider.zh.md)

## Problem

The first-run step and the Models page both asked one question — is `deepseek-official`'s credential stored? — of a join that describes every provider. Two defects followed from that single reading.

A user who configured some other provider (a pi-ai gateway, a self-hosted route) and never wanted the official DeepSeek endpoint was taken over by the full-screen credential prompt on every blank session, with a working model already selected in the composer behind it. Nothing they could do short of storing a DeepSeek key would end it, because the step's readiness projection never looked at the row they had configured.

On the Models page the same reading opened the DeepSeek setup card over them on every visit, and that card could not be closed: it was rendered from row data with no local state a Cancel could flip, so its Cancel button did nothing visible. Worse, it shared the row-editor/add/declare close handler, which unconditionally clears all three of those states — so cancelling the card that owned none of them discarded the add card's draft while staying open itself.

## Decision

One predicate answers what both surfaces actually need. `providerUsable(row)` is true when the route is registered with the adapter registry (`entry.active`) and whatever credential its resolved profile names is stored; a profile naming no reference authenticates through the provider's own path, as does a live route with no settings address, so neither owes this page a key.

`onboardingReadiness` (renamed from `deepSeekReadiness`, which no longer describes what it reads) returns `provider-ready` as soon as any joined row is usable. Only a user with none of those reaches the official DeepSeek lookup, which is unchanged: it is the one route the prompt can offer a key field for. The gate subsumes two diagnostics the old projection carried — `settings-unavailable` and `credential-ref-unavailable` — because both described an active route the new gate now calls usable; the outcome for the user was already identical (the step completed without rendering).

`needsSetup(row, anyUsable)` takes the same fact, so the setup card is the first-run posture alone. With another provider reachable, DeepSeek is an ordinary row carrying the missing-key dot, one Edit click from the same card.

Each card kind now owns its own close handler. `closeSetup` records the provider in a component-local `dismissedSetup` set and touches nothing else; `closeEditor` keeps clearing the three states its cards own. Both route the post-save reload through one `announceSaved` helper. Dismissal is viewing state, like the open editor and the add card: a reload restores the first-run posture for a user still in it.

## Alternatives considered

- **Deriving readiness from the model catalog (`session/modelCatalog`) instead of the join.** It answers "can the user talk to something" most directly, but it costs a per-provider listing round trip on a surface that already holds the join, and a provider whose listing fails transiently would re-open onboarding.
- **Requiring `row.configured` in `providerUsable`.** It reads as the stricter check, and would exclude exactly the routes a deployment mounts through `cordis.yml` without a configurable-provider declaration — live routes serving models that this page cannot configure. Registration, not configurability, is what makes a provider usable.
- **Only adding the dismissal, leaving the card auto-opening.** It fixes the Cancel button and nothing else: a user with a working provider would still be handed the DeepSeek form on every visit to Models, which is the same misreading in a quieter form.
- **Persisting the dismissal to settings.** A durable "do not ask about DeepSeek" flag is a second fact about first-run state that can disagree with the join. The credential itself already ends the posture permanently, and every other card on this page is session-local.

## Consequences

Onboarding now ends for reasons the DeepSeek route knows nothing about, so the step's name is the last thing tying it to that adapter; a future step that offers more than one route to configure would replace the prompt, not the readiness projection. The narrowed diagnostic union means an unresolvable `llm-deepseek` settings address is reported as `provider-ready` rather than as its own reason — the user-visible behavior is unchanged, and the Models page remains the diagnostic surface.

## Testing

Package tests pin `providerUsable` over the four join states and `onboardingReadiness` over both the new gate and every surviving diagnostic; the section tests cover the first-run posture, the plain-row posture, and the cancel that collapses the setup card while the add card keeps its draft. The `onboarding-usable-provider` web e2e lane replays the whole scenario through the real wire: cancel with both cards open, configure `minimax-cn` instead, reload, and find no takeover — with one aria golden of the dismissed state.
