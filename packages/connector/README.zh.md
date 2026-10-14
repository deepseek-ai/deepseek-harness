---
description: "connector 分组地图：通过 MCP 服务器等现有能力把第三方服务接入 agent 的应用插件。"
kind: "package-group"
---

# connector/ — 应用插件

[English](README.md) | 中文

## 概述

本分组中的每个包都是一个应用插件，用户把它安装到 profile 后，即可在对话中使用对应的第三方服务。包组合现有能力，例如注册到共用管理器的 MCP 服务器，并把应用特有的配置和模型指引保留在包内。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`notion/`](notion/README.zh.md) | 通过共用的 MCP 管理器以 OAuth 注册 Notion 托管的 MCP 服务器，添加 Notion 插件称呼指引，并在插件页面显示账号 | 注册到 `ctx.mcpServers`、`ctx.systemPrompt` 与 `ctx.mcpAccounts` |

-----

<a id="related-documentation"></a>
## 相关文档

- [MCP 子系统参考](../../docs/subsystems/mcp.zh.md)——connector 服务器所使用的 MCP 包。
- [MCP 管理器](../mcp/mcp-manager/README.zh.md)——插件注册的服务器、状态与 OAuth 授权。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
