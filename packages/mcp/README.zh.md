---
description: "MCP 包组：连接外部 Model Context Protocol 服务器，调用其工具并读取其资源。"
kind: "package-group"
---

# MCP — 模型上下文协议

[English](README.md) | 中文

## 概述

`mcp/` 组让模型调用外部 Model Context Protocol（MCP）工具并读取服务器资源。可以直接配置 `mcp-client` 条目；已安装插件向 `mcp-manager` 注册自己的服务器。随附 profile 已统一挂载 `mcp-resources` 一次。只有作用域中存在已配置服务器的调用方才会看到 MCP 工具与提示词文本。连接还会提供服务器指令。配置与限制由各包的 README 说明。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

客户端拥有每个已配置连接，管理器运行插件注册的客户端，共享资源包为这些连接提供资源工具。

| 包 | 提供的能力 |
|---|---|
| [`mcp-client/`](mcp-client/README.zh.md) | 连接一台 MCP 服务器，暴露其工具与指令，并提供其资源操作 |
| [`mcp-manager/`](mcp-manager/README.zh.md) | 运行插件注册的 mcp-client 实例，提供状态、重启与服务器列表流 |
| [`mcp-resources/`](mcp-resources/README.zh.md) | 通过显式选择服务器的共享工具发现和读取资源 |

-----

<a id="related-documentation"></a>
## 相关文档

先用可运行的示例配置体验插件，再阅读 Agent Note 了解其背后的行为决策。

- [历史MCP 客户端插件 Agent Note](../../.agents/notes/archived/feature/2026-07-07-mcp-client-plugin.md)——桥接的设计：服务器限定命名、发现、执行与环境清洗。
- [MCP 管理器 Agent Note](../../.agents/notes/implemented/feature/2026-08-31-mcp-manager-plugin.zh.md)——插件注册的服务器：对账语义、状态面与被否决的替代方案。
- [资源与指令 参考](mcp-resources/README.zh.md)——按需资源访问与作用域服务器指引。
- [第三方记忆 MCP 指南](../../docs/user/guide/mcp-memory.zh.md)——可运行的 overlay 配置行与设置说明。
- [工具子系统参考](../../docs/subsystems/tools.zh.md)——接收已注册工具的 `ToolRuntime`。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
