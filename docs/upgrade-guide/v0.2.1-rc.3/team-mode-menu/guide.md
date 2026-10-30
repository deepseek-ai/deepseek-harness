---
kind: upgrade-guide
description: "The Team mode slash command is removed; use the root conversation menu."
---

# Select Team mode from the conversation menu

English | [中文](guide.zh.md)

## Change

`/team on` and `/team off` are no longer registered. The root conversation’s **Use Agent Teams** switch calls `remote.agentTeams.setEnabled` directly. Saved selections, task retention, and root-only authorization are unchanged.

## Migration

1. Enable or disable **Use Agent Teams** in the root conversation’s model and reasoning menu.
2. Plugins that execute the command should call `ctx.agentTeams.setEnabled(rootAgent, enabled)` instead; browser clients call `remote.agentTeams.setEnabled(rootSessionId, enabled)`.
3. Confirm the switch reflects the saved selection after reloading the Session.
