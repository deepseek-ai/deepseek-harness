---
description: "通过共用的 MCP 管理器接入 Notion 托管的 MCP 服务器，经 OAuth 授权后在对话中使用其工具。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-notion

[English](README.md) | 中文

## 概述

Notion 插件在加载期间把 Notion 托管的 MCP 服务器 `https://mcp.notion.com/mcp` 注册到 Host 共用的 [MCP 管理器](../../mcp/mcp-manager/README.zh.md)。用户授权一个 Notion 账号后，该 Host 上的所有对话都能使用这个服务器的工具，模型也会被告知把这项集成称为 Notion 插件。连接、OAuth 授权、已保存的 grant 和退出登录都由管理器负责，本包不另设账号接口。插件运行在 Web 与 Desktop 组合中。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 安装到 profile

将本包作为 bundle 安装，例如在 Web 侧栏的**插件**页面安装，或使用 CLI：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-notion
```

bundle patch 在 profile 其他层之后插入 `notion` 行。插件需要 `mcpServers` 与 `systemPrompt` 服务，Web 与 Desktop 组合通过 [`dsh-web-app`](../../bundle/web-app/README.zh.md) 提供它们。在没有 MCP 管理器的 profile（例如 `headless`）中，插件不会激活，启动时会打印一条警告，指出缺少 `mcpServers` 服务。

### 授权与退出登录

插件以固定的 OAuth 凭据 key `mcp-client/notion` 注册服务器 `notion`。没有已保存的 grant 时，服务器等待授权，不提供 Notion 工具。有已保存的 grant 时，管理器在启动时连接，并按需刷新 token。Notion 的工具默认[按需加载](../../mcp/mcp-client/README.zh.md#on-demand-tool-loading)：系统提示词列出这些工具，每个 agent 用 `mcp__notion__load_tools` 加载需要的工具。

授权通过 Remote 使用管理器的 [OAuth 操作](../../mcp/mcp-manager/README.zh.md#oauth-authorization)；目前还没有登录页面。Remote 客户端调用 `ctx.remote.mcpServers.startAuthorization('notion')`，在 Host 所在机器的浏览器中打开返回的 `authorizationUrl`，用户在 Notion 中同意授权。`list()` 与 `watch` 报告进度，`cancelAuthorization('notion', id)` 取消一次授权尝试。`signOut('notion')` 删除本地 grant 并保留客户端注册；它不会在 Notion 一侧撤销连接。

### 停用与卸载

在 Plugin Manager 中关闭该行或卸载本包都会结束注册：Notion 工具从模型的工具集中撤下，已保存的 grant 留在凭据存储中，因此重新安装会复用它。要删除 grant，请在插件加载期间退出登录，或按[本地凭据提供方](../../credentials/credentials-local/README.zh.md)的说明，从 `$DSH_HOME/.credentials.yaml` 中删除 `mcp-client/notion` 记录。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `url` | `https://mcp.notion.com/mcp` | Notion 服务器的 Streamable HTTP MCP 端点 |
| `toolLoading` | `on-demand` | `on-demand` 让 Notion 的工具在 agent 加载前对其隐藏；`eager` 在每次请求中发送全部工具定义 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-notion)是受支持字段的完整来源。连接与授权的预算使用管理器和 mcp-client 的默认值。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制——点击展开</summary>

[`src/index.ts`](src/index.ts) 进行两项注册，二者都是插件 fiber 的 effect：`ctx.mcpServers.register('notion', …)` 以配置的 `url` 和 OAuth 凭据 key 添加一个 Streamable HTTP 条目，`ctx.systemPrompt.section()` 在 `MCP_SERVERS` 排序位置添加称呼指引。服务器名固定了 `mcp__notion__` 工具命名空间，凭据 key 固定了 grant 地址，因此重新加载或重新安装的插件会得到同样的工具和 grant。管理器在注册时校验条目；如果已配置或已注册的服务器占用了该名称或 key，插件会在添加指引之前加载失败。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Connector 包](../README.zh.md)——这个应用插件所属的分组。
- [MCP 管理器](../../mcp/mcp-manager/README.zh.md)——注册生命周期、状态、OAuth 授权与退出登录。
- [MCP 客户端](../../mcp/mcp-client/README.zh.md)——连接、工具命名、OAuth grant 刷新与脱敏。
- [MCP 子系统](../../../docs/subsystems/mcp.zh.md)——各 MCP 包如何协同。
- [Plugin Manager](../../boot/plugin-manager/README.zh.md)——安装与启用。

-----

<a id="model-experience"></a>
## 模型体验

### 称呼指引

#### 模型看到什么

插件加载期间，无论 Notion 是否已授权，系统提示词都会在 MCP 服务器各节之后包含下面这段文字。

##### 指引文本

```markdown
Tools named `mcp__notion__*` come from the Notion plugin. In user-facing replies, call it the Notion plugin (Notion 插件 in Chinese), not MCP.
```

#### Token 影响

插件加载期间，这句固定文字为每次请求增加几十个 token。

#### KV Cache 影响

这句话保持前缀稳定：只在插件加载或卸载时变化，授权或连接状态变化不会改变它。

### Notion 服务器工具与说明

#### 模型看到什么

授权之后，模型会在 `### MCP server: notion` 之下看到 Notion 的服务器说明；在默认的 `toolLoading: on-demand` 下，还会看到加载器 `mcp__notion__load_tools`，以及系统提示词中的 [Notion 工具目录](../../mcp/mcp-client/README.zh.md#model-experience)，加载的每个工具随后以 `mcp__notion__<tool>` 命名，带有 Notion 提供的描述和输入 schema。设为 `eager` 时，所有工具从一开始就出现，详见 [MCP 客户端](../../mcp/mcp-client/README.zh.md#model-experience)。设为 `on-demand` 时，加载器和目录只在 Notion 连接后出现。插件加载期间（包括授权之前），[共用的资源工具](../../mcp/mcp-resources/README.zh.md#model-experience)及其服务器名提示词都会列出 `notion`。

#### Token 影响

工具集与服务器说明由 Notion 服务器定义，其大小可能在 DSH 不更新的情况下变化。设为 `on-demand` 时，已连接的 Notion 的开销是服务器说明、加载工具、46 个工具约 6,400 字符的目录，以及 agent 已加载的定义；设为 `eager` 时，全部定义（约 214,500 字符）在每次请求中重复出现。

#### KV Cache 影响

Notion 的服务器说明（设为 `eager` 时则是其工具）在连接成功时出现，在授权被撤回或插件卸载时消失；每次变化都可能使从第一个变化 token 起的复用失效。设为 `on-demand` 时，目录只在 Notion 的工具列表变化时变化，每次加载都会改变该 agent 下一次请求的工具列表，详见 [MCP 客户端](../../mcp/mcp-client/README.zh.md#model-experience)。共用的资源工具在连接变化前后保持不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 没有登录页面。在 Remote 客户端展示管理器的授权链接之前，用户无法在产品中授权 Notion。
- 只有 Web 与 Desktop 组合挂载 MCP 管理器；在其他 profile 中插件保持未激活。
- 授权回调地址是 Host 上的 `http://127.0.0.1:<port>`，因此完成授权的浏览器必须运行在 Host 所在机器上。从另一台机器访问的 Web Host 无法完成授权。
- Desktop 每次启动都监听操作系统分配的端口。重启后再次授权会注册一个新的 OAuth 客户端，并保留之前的注册记录；已保存的 grant 在重启前后正常刷新。
- 一次 Notion 授权供整个 Host 使用；没有账号或工作区选择器。
- 停用或卸载插件会保留本地 grant。退出登录会删除本地 grant，但在用户于 Notion 一侧移除之前，该连接在 Notion 中仍处于已授权状态。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

单测让插件运行在 MCP 管理器和 mcp-client 的回环 OAuth 服务器夹具之上。`notion-plugin` 会话快照在没有已保存 grant 的情况下回放 Notion 行，因此它固定称呼指引，并验证没有请求到达服务器。

</details>
