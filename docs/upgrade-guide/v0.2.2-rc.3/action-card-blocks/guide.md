---
kind: upgrade-guide
description: "Personalized recommendations cards come from action-card blocks in answers; the propose_action tool, the action-cards queuedMessageLimit field and the callId card field are gone."
---

# Action cards come from blocks in answers

English | [中文](guide.zh.md)

## Change

The experimental Personalized recommendations bundle offered its cards through the `propose_action` tool. The model now ends its final answer with a fenced `action-card` block holding the same `action`, `title`, `brief` and `details`, and `@deepseek-ai/dsh-action-cards` reads the card from the logged answer. The tool is no longer declared, and the service has no `queuedMessageLimit` configuration field: a value left under `id: action-cards` in a profile's `cordis.patch.yml` is ignored.

For plugins that register a card kind or call the service:

- `ActionCardKind` no longer takes `skill` or `invitation`; the kind's skill tells the model how to write the block and how to invite the user.
- `ActionCardProposal`, `ActionCardDecision`, `ctx.actionCards.act()` and the `actionCards` Remote name cards by `cardId` (type `ActionCardId`) instead of `callId`, and new decisions carry `cardId`.
- The package no longer exports `ActionCardError`, and its `Config` holds only `enabled` ([Personalized recommendations bundle removed](../../v0.2.2-rc.5/personalized-recommendations-bundle-retired/guide.md)).

Sessions recorded with `propose_action` no longer show those cards: the calls appear as ordinary tool rows, and their decisions are not read. This affects users with such Sessions, users who changed `queuedMessageLimit` and plugins that register card kinds; the shipped bundle needs no change.

## Migration

1. Remove `queuedMessageLimit` from the `id: action-cards` entry of the profile's `cordis.patch.yml`, and remove the entry when nothing else remains in it.
2. In a plugin that registers a card kind, drop `skill` and `invitation` from `ctx.actionCards.register()`, and change its skill to ask for one `action-card` block at the end of the final answer, with the invitation sentence before it, as [`official-plugins.md`](../../../../packages/extensions/plugin-recommendations/skills/official-plugins.md) does.
3. Rename `callId` to `cardId` where the plugin reads proposals or decisions, records decisions or calls `act()`.
4. Ask a question that a kind's skill answers with a card; the migration works when the card appears below the answer and the process area shows no `propose_action` call.
