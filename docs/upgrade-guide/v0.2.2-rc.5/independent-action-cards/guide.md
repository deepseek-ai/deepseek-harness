---
kind: upgrade-guide
description: "Earlier action cards stay available when a later turn offers another card."
---

# Action cards stay available across turns

English | [中文](guide.zh.md)

## Change

A later proposal used to mark earlier unstarted cards as `replaced`. When you reopen a Session, those cards offer their actions again. Each card keeps its own recorded decisions, including dismissals and work already started. Each turn still admits only its first valid `action-card` block.

## Migration

1. Reopen a conversation containing two proposals from different turns. The Host rebuilds the `actionCards` projection from the Session log when it encounters a version 3 checkpoint. Session files need no edits.
2. Check that each untouched proposal offers its controls. Choose **Not now** on any proposal you no longer want.
3. If your plugin reads `ActionCardView.decisions`, use the decision for the proposal’s `cardId`. An absent decision means the card is unstarted. Remove handling for the former shared `replaced` phase.
