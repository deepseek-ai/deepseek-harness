---
description: "The hooks group map: run existing Claude Code and Codex shell-hook configs during agent runs, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/hooks

English | [中文](README.zh.md)

## Summary

The hooks group lets agent runs use the shell hooks you already wrote for Claude Code or Codex: mount the matching bridge, point it at your existing `hooks.json`, and those hooks fire at the corresponding moments in agent runs — when a session starts, when a prompt is submitted, before and after a tool runs, or when a run is about to stop. Hooks can block a prompt or tool call with a message the model sees, attach extra context to the conversation, or force the run to continue. Choose this group when existing hook configs should keep working without being rewritten as native plugins; each bridge covers the command-hook subset its reference tool documents. `hook-protocol` is the shared hook engine both bridges use, so the two dialects behave the same way where their protocols agree.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | Shape |
|---|---|---|
| [`hook-protocol`](hook-protocol/README.md) | Shared hook engine both bridges use; never configured directly | library |
| [`hooks-claude-code`](hooks-claude-code/README.md) | Run your existing Claude Code `hooks.json` hooks during agent runs | plugin |
| [`hooks-codex`](hooks-codex/README.md) | Run your existing Codex `hooks.json` hooks during agent runs | plugin |

-----

<a id="related-documentation"></a>
## Related documentation

- [Interception extension-points Agent Note](../../.agents/notes/implemented/feature/2026-06-30-interception-extension-points.md) — the typed-Decision surface the bridges program against.
- [Hook bridges Agent Note](../../.agents/notes/archived/feature/2026-06-30-hook-bridges.md) — the bridge design and its decision mapping.
- [Hook protocol library Agent Note](../../.agents/notes/archived/feature/2026-06-30-hook-protocol-lib.md) — what the shared library owns and why.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
