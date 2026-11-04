---
description: "The MCP package group: connect external Model Context Protocol servers, call their tools, and read their resources."
kind: "package-group"
---

# MCP — Model Context Protocol

English | [中文](README.zh.md)

## Summary

The `mcp/` group lets the model call external Model Context Protocol (MCP) tools and read server resources. Configure `mcp-client` entries directly, or let `mcp-manager` run a settings-driven fleet of them that a management surface edits at runtime; shipped profiles already mount `mcp-resources` once. MCP tools and prompt text appear only for callers with a configured server in scope. Connections also supply server instructions. Package READMEs own configuration and limitations.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The client owns each configured connection, the manager runs a settings-driven fleet of clients, and the shared resource package supplies resource tools across those connections.

| Package | What it provides |
|---|---|
| [`mcp-client/`](mcp-client/README.md) | Connect one MCP server, expose its tools and instructions, and provide its resource operations |
| [`mcp-manager/`](mcp-manager/README.md) | Manage a settings-driven fleet of mcp-client instances: live add/edit/enable/disable/delete, status, restart, probe |
| [`mcp-resources/`](mcp-resources/README.md) | Discover and read resources through shared tools with explicit server selection |

-----

<a id="related-documentation"></a>
## Related documentation

Try the worked example configurations to see the plugin in action, then read the Agent Note for the behavior decisions behind it.

- [historical MCP client plugin Agent Note](../../.agents/notes/archived/feature/2026-07-07-mcp-client-plugin.md) — the bridge's design: server-qualified naming, discovery, execution, and environment scrubbing.
- [MCP manager Agent Note](../../.agents/notes/implemented/feature/2026-08-31-mcp-manager-plugin.md) — the settings-driven fleet: reconcile semantics, templates, status surface, and rejected alternatives.
- [Resources and instructions reference](mcp-resources/README.md) — on-demand resource access and scoped server guidance.
- [Third-party memory MCP guide](../../docs/user/guide/mcp-memory.md) — runnable overlay rows and setup instructions.
- [Tools subsystem reference](../../docs/subsystems/tools.md) — the `ToolRuntime` that receives the registered tools.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
