---
description: "MCP 包组：挂载外部 Model Context Protocol 服务器，让它们的工具可以作为原生工具调用。"
kind: "package-group"
---

# MCP — 模型上下文协议

[English](README.md) | 中文

## 概述

`mcp/` 组把 harness 连接到 Model Context Protocol（MCP）工具服务器生态。本组的包挂载外部服务器——文件系统、GitHub、数据库或记忆服务器——让模型把它们的工具当作原生工具、以稳定的服务器限定名称使用：既可以每台服务器一条组合配置项，也可以是由管理界面在运行时编辑的、设置驱动的编队。默认不启用任何服务器，因此按需逐台开启。只桥接 Tools 能力：MCP resources 与 prompts 不受支持。本页映射该组；逐包约定由包 README 负责。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

本组包含两个包；包 README 与下方链接拥有细节。

| 包 | 提供的能力 |
|---|---|
| [`mcp-client/`](mcp-client/README.zh.md) | 挂载一台外部 MCP 服务器，让模型可以把它的工具当作原生工具调用 |
| [`mcp-manager/`](mcp-manager/README.zh.md) | 管理设置驱动的 mcp-client 实例编队：运行时增改启停删、状态、重启、探测 |

-----

<a id="related-documentation"></a>
## 相关文档

先用可运行的示例配置体验插件，再阅读 Agent Note 了解其背后的行为决策。

- [MCP 客户端插件 Agent Note](../../.agents/notes/implemented/feature/2026-07-07-mcp-client-plugin.zh.md)——桥接的设计：服务器限定命名、发现、执行与环境清洗。
- [MCP 管理器 Agent Note](../../.agents/notes/implemented/feature/2026-08-31-mcp-manager-plugin.zh.md)——设置驱动的编队：对账语义、模板、状态面与被否决的替代方案。
- [第三方记忆 MCP 指南](../../docs/user/guide/mcp-memory.zh.md)——可运行的 overlay 配置行与设置说明。
- [工具子系统参考](../../docs/subsystems/tools.zh.md)——接收已注册工具的 `ToolRuntime`。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
