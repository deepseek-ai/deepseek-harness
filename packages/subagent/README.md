---
description: "The subagent package group: the delegation seam, its in-process and out-of-process backends, and the model-facing delegation tools."
kind: "package-group"
---

# subagent/ — subagent capability family

English | [中文](README.zh.md)

## Summary

The subagent package family lets an agent delegate a task to a child, continue the child's work, and discover every child it created. Choose a fresh in-process child for isolated work, a history-seeded in-process child when prior conversation matters, or an out-of-process child backed by ACP, Codex, Claude Code, or another Harness runtime. Model-facing tools also let agents message adjacent agents, interrupt work, and list child status. Each child remains visible to its parent whether it is running or stored; the package READMEs document provider-specific setup and limits.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`subagent/`](subagent/README.md) | Defines the delegation service: provider registry, one-shot runs, continuable children, and discovery | `ctx.subagents` |
| [`subagent-in-process-driver/`](subagent-in-process-driver/README.md) | Provides the shared in-process run driver | — |
| [`subagent-spawn-in-process/`](subagent-spawn-in-process/README.md) | Runs a fresh in-process child | registers on `ctx.subagents` |
| [`subagent-fork-in-process/`](subagent-fork-in-process/README.md) | Runs an in-process child seeded from the parent's completed history | registers on `ctx.subagents` |
| [`subagent-acp/`](subagent-acp/README.md) | Runs an out-of-process child over the Agent Client Protocol | registers on `ctx.subagents` |
| [`subagent-codex/`](subagent-codex/README.md) | Runs a real Codex child through the official app-server protocol | registers on `ctx.subagents` |
| [`subagent-claude-code/`](subagent-claude-code/README.md) | Runs a real Claude Code child through the official Agent SDK | registers on `ctx.subagents` |
| [`subagent-dsh-sdk/`](subagent-dsh-sdk/README.md) | Runs an out-of-process Harness child through the TypeScript SDK | registers on `ctx.subagents` |
| [`tool-subagent/`](tool-subagent/README.md) | Exposes delegation to the model | registers on `ctx.tools` |
| [`tool-subagent-control/`](tool-subagent-control/README.md) | Exposes adjacent-agent messaging, interrupt, and listing to the model | registers on `ctx.tools` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Subagent subsystem](../../docs/subsystems/subagent.md) — the service contract, provider contract, and terminal result semantics.
- [Subagent capability seam](../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md) — the design record for the delegation capability family.
- [Continuable subagents](../../.agents/notes/implemented/feature/2026-07-28-continuable-subagent-conversations.md) — durable children that accept follow-up turns.
- [tool-subagent-control README](tool-subagent-control/README.md) — the follow-up, interrupt, and listing surface.

<a id="dev-note"></a>
## Dev Note

None.
