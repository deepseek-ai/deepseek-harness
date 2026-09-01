---
description: "The subagent package group: the delegation seam, its in-process and out-of-process backends, and the model-facing delegation tools."
kind: "package-group"
---

# subagent/ — subagent capability family

English | [中文](README.zh.md)

## Summary

The subagent group is the delegation family: it lets an agent hand a task to a child agent, wait for or continue the child's work, and keep every child discoverable. One contract (`ctx.subagents`) serves any number of named providers, so a single composition can mix in-process children (fresh, or forked from the parent's completed history) with out-of-process children — an ACP agent, a real Codex or Claude Code installation, or a complete Harness runtime over the SDK. The model-facing tools expose delegation, adjacent-Agent messaging, and listing to agents, and a parent can always see which children exist and whether they are live or stored. This page maps the group; each package README owns its package contract.

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
| [`tool-subagent-control/`](tool-subagent-control/README.md) | Exposes adjacent-Agent messaging, interrupt, and listing to the model | registers on `ctx.tools` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Subagent subsystem](../../docs/subsystems/subagent.md) — the service contract, provider contract, and terminal result semantics.
- [Subagent capability seam](../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md) — the design record for the delegation capability family.
- [Continuable background subagents](../../.agents/notes/implemented/feature/2026-07-21-continuable-background-subagents.md) — durable children that accept follow-up turns.
- [Merged subagent control service](../../.agents/notes/implemented/simplification/2026-07-26-merge-subagent-control-service.md) — the follow-up, interrupt, and listing surface.

<a id="dev-note"></a>
## Dev Note

None.
