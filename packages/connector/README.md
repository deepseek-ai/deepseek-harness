---
description: "The connector group map: application plugins that connect a third-party service to agents through existing Skill, MCP, Shell, and subprocess capabilities, and the CLI account and upstream skills Services that CLI app plugins register with."
kind: "package-group"
---

# connector/ — application plugins

English | [中文](README.zh.md)

## Summary

Each application plugin in this group is installed into a profile to use one third-party service in conversations. A plugin composes existing capabilities, such as skills, MCP servers registered with the shared manager, runtime context, and subprocesses, and keeps application-specific configuration and model guidance in its own package. Plugins whose vendor CLI keeps the user's account register that CLI and account with the CLI account Service, which runs their commands and account operations, and plugins whose upstream skills exist only in the vendor's GitHub repository register their entry skill with the upstream skills Service, which downloads them.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`cli-account/`](cli-account/README.md) | Holds the vendor CLIs and accounts CLI app plugins register: gives the model each CLI's absolute path in runtime context, runs each plugin's account operations one at a time, and shows the account on the Plugins page | `ctx.cliAccounts` |
| [`feishu/`](feishu/README.md) | The Feishu plugin: installs the official `lark-cli`, gives the model its absolute path, registers its embedded skills, and runs the account operations the Plugins page drives | registers on `ctx.cliAccounts` and `ctx.skills` |
| [`tencent-meeting/`](tencent-meeting/README.md) | The Tencent Meeting plugin: installs the official `tmeet`, gives the model its absolute path, registers its skill, and runs the account operations the Plugins page drives | registers on `ctx.cliAccounts` and `ctx.upstreamSkills` |
| [`dingtalk/`](dingtalk/README.md) | The DingTalk plugin: downloads the pinned official `dws` and its skills, gives the model the absolute path of `dws`, registers its skill, and runs the account operations the Plugins page drives | registers on `ctx.cliAccounts` and `ctx.skills` |
| [`upstream-skills/`](upstream-skills/README.md) | Holds the entry skills CLI app plugins register: downloads the upstream files each entry indexes from a pinned commit of the vendor's GitHub repository, verifies and caches them, and lists the entry skill over them | `ctx.upstreamSkills` |
| [`linear/`](linear/README.md) | Registers Linear's hosted MCP server with OAuth through the shared MCP manager, adds the Linear plugin naming guidance, and shows its account on the plugin page | registers on `ctx.mcpManager`, `ctx.systemPrompt`, and `ctx.mcpAccounts` |
| [`notion/`](notion/README.md) | Registers Notion's hosted MCP server with OAuth through the shared MCP manager, adds the Notion plugin naming guidance, and shows its account on the plugin page | registers on `ctx.mcpManager`, `ctx.systemPrompt`, and `ctx.mcpAccounts` |
| [`tencent-docs/`](tencent-docs/README.md) | Registers Tencent Docs' hosted MCP server with OAuth through the shared MCP manager, adds the Tencent Docs plugin naming guidance, and shows its account on the plugin page | registers on `ctx.mcpManager`, `ctx.systemPrompt`, and `ctx.mcpAccounts` |
| [`wecom/`](wecom/README.md) | The WeCom plugin: installs the official `wecom-cli`, gives the model its absolute path, registers its skills, and runs the authorization operations the Plugins page drives | registers on `ctx.cliAccounts` and `ctx.upstreamSkills` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Skill subsystem reference](../../docs/subsystems/skills.md) — the registry and provider contract that connector skills use.
- [System prompt](../core/system-prompt/README.md) — the registry that orders and renders runtime context.
- [Connector account surfaces](../client/ui-connector-account/README.md) — the Plugins page registry where CLI app plugins show their accounts.
- [MCP subsystem reference](../../docs/subsystems/mcp.md) — the MCP packages that connector servers use.
- [MCP manager](../mcp/mcp-manager/README.md) — plugin-registered servers, status, and OAuth authorization.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
