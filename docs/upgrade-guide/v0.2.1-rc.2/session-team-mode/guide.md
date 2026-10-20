---
kind: upgrade-guide
description: "Agent Teams defaults off for new Sessions and uses a saved per-Session selection."
---

# Select Agent Teams per Session

English | [中文](guide.zh.md)

## Change

Agent Teams ships with base-backed profiles; new Sessions default to off. The Plugins page has no separate Agent Teams switch. The root Session’s selection controls task tools and Team guidance throughout its subagent tree. The model and reasoning menu offers **Use Agent Teams**, and the Subagent header control opens members above shared tasks in one panel while enabled.

Disabling Team retains tasks and subagents. The selection survives restart. A historical task board without a saved selection remains enabled. The required `team/mode` event records selections; older readers reject this unfamiliar event. See the [persistence acknowledgement](../../../persistence-changes/2026-10-19-session-team-mode.md).

## Migration

1. Start each existing profile once. Profile loading removes the retired `@deepseek-ai/dsh-experimental-agent-team-profile` bundle selection; the base and Web bundles supply its plugins. Keep `agent-team`, `tool-agent-team`, and `ui-agent-team` row overrides. Custom compositions replace package names `@deepseek-ai/dsh-experimental-agent-team`, `@deepseek-ai/dsh-experimental-tool-agent-team`, and `@deepseek-ai/dsh-experimental-client-ui-agent-team` with `@deepseek-ai/dsh-agent-team`, `@deepseek-ai/dsh-tool-agent-team`, and `@deepseek-ai/dsh-client-ui-agent-team`.
2. Enable **Use Agent Teams** in the root conversation’s model and reasoning menu, or execute `/team on`. Use `/team off` to disable it.
3. Deployments requiring automatic enablement may set the `agent-team` plugin’s `config.enabledByDefault` to `true`. Saved selections and historical task boards take precedence.
4. Verify that enabling shows shared tasks below the Subagent tree in the same panel and exposes four task tools. Reload the Session to confirm the saved selection. Re-enabling after disabling restores the existing tasks.

Client plugin consumers replace `TeamActionProps` with `TeamBoardProps`; task content registers in the Subagent catalog footer slots instead of the header actions slot.
