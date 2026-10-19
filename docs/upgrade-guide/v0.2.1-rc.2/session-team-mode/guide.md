---
kind: upgrade-guide
description: "Agent Teams defaults off for new Sessions and uses a saved per-Session selection."
---

# Select Agent Teams per Session

English | [中文](guide.zh.md)

## Change

Installing the Agent Teams bundle makes the feature available; new Sessions default to off. The root Session’s selection controls task tools and Team guidance throughout its subagent tree. The model and reasoning menu offers **Use Agent Teams**, and the header shows shared tasks while enabled. Members use the existing Subagent tree.

Disabling Team retains tasks and subagents. The selection survives restart. A historical task board without a saved selection remains enabled. The required `team/mode` event records selections; older readers reject this unfamiliar event. See the [persistence acknowledgement](../../../persistence-changes/2026-10-19-session-team-mode.md).

## Migration

1. Enable **Use Agent Teams** in the root conversation’s model and reasoning menu, or execute `/team on`. Use `/team off` to disable it.
2. Deployments requiring automatic enablement may set the `agent-team` plugin’s `config.enabledByDefault` to `true`. Saved selections and historical task boards take precedence.
3. Verify that enabling shows the shared task board and exposes four task tools. Reload the Session to confirm the saved selection. Re-enabling after disabling restores the existing tasks.
