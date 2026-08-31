---
description: "The MCP package group: attach external Model Context Protocol servers so their tools are callable as native tools."
kind: "package-group"
---

# MCP — Model Context Protocol

English | [中文](README.zh.md)

## Summary

The `mcp/` group connects the harness to the Model Context Protocol (MCP) ecosystem of tool servers. Its packages attach external servers — a filesystem, GitHub, database, or memory server — so their tools are available to the model as native tools under stable server-qualified names, either as one composition entry per server or as a settings-driven fleet a management surface edits at runtime. Nothing ships enabled, so you opt in per server. Only the Tools capability is bridged: MCP resources and prompts are not supported. This page maps the group; the package READMEs own the per-package contracts.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The group holds two packages; the package READMEs and the links below own the details.

| Package | What it provides |
|---|---|
| [`mcp-client/`](mcp-client/README.md) | Attach one external MCP server so the model can call its tools as native tools |
| [`mcp-manager/`](mcp-manager/README.md) | Manage a settings-driven fleet of mcp-client instances: live add/edit/enable/disable/delete, status, restart, probe |

-----

<a id="related-documentation"></a>
## Related documentation

Try the worked example configurations to see the plugin in action, then read the Agent Notes for the behavior decisions behind it.

- [MCP client plugin Agent Note](../../.agents/notes/implemented/feature/2026-07-07-mcp-client-plugin.md) — the bridge's design: server-qualified naming, discovery, execution, and environment scrubbing.
- [MCP manager Agent Note](../../.agents/notes/implemented/feature/2026-08-31-mcp-manager-plugin.md) — the settings-driven fleet: reconcile semantics, templates, status surface, and rejected alternatives.
- [MCP client auto-reconnect Agent Note](../../.agents/notes/implemented/feature/2026-08-06-mcp-client-auto-reconnect.md) — the reconnect policy, the per-outage attempt budget, and the opt-out.
- [Third-party memory MCP examples Agent Note](../../.agents/notes/implemented/feature/2026-07-31-third-party-memory-mcp-examples.md) — three default-off memory-server overlays delivered as reference configurations.
- [Third-party memory MCP guide](../../docs/user/guide/mcp-memory.md) — runnable overlay rows and setup instructions.
- [Tools subsystem reference](../../docs/subsystems/tools.md) — the `ToolRuntime` that receives the registered tools.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
