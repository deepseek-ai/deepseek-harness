---
description: "The hooks group map: run existing Claude Code and Codex shell-hook configs during agent runs, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/hooks

English | [中文](README.zh.md)

## Summary

The hooks group lets agent runs reuse shell hooks written for Claude Code or Codex. Point the matching integration at an existing `hooks.json` to run supported command hooks when sessions start, prompts arrive, tools run, or runs stop. These hooks can block prompts or tool calls with model-visible messages, add conversation context, or require the run to continue. Choose this group to preserve existing hook configurations; each integration supports only the command-hook subset documented by its source tool.

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
