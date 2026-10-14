---
description: "The connector group map: application plugins that connect a third-party service to agents through existing capabilities such as MCP servers."
kind: "package-group"
---

# connector/ — application plugins

English | [中文](README.zh.md)

## Summary

Each package in this group is one application plugin that a user installs into a profile to use a third-party service in conversations. A package composes existing capabilities, such as MCP servers registered with the shared manager, and keeps application-specific configuration and model guidance in its own package.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`tencent-docs/`](tencent-docs/README.md) | Registers Tencent Docs' hosted MCP server with OAuth through the shared MCP manager, adds the Tencent Docs plugin naming guidance, and shows its account on the plugin page | registers on `ctx.mcpServers`, `ctx.systemPrompt`, and `ctx.mcpAccounts` |

-----

<a id="related-documentation"></a>
## Related documentation

- [MCP subsystem reference](../../docs/subsystems/mcp.md) — the MCP packages that connector servers use.
- [MCP manager](../mcp/mcp-manager/README.md) — plugin-registered servers, status, and OAuth authorization.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
