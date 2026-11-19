---
description: "通过共用的 MCP 管理器接入腾讯文档托管的 MCP 服务器，经 OAuth 授权后在对话中使用其工具。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-tencent-docs

[English](README.md) | 中文

## 概述

腾讯文档插件在加载期间把腾讯文档托管的 MCP 服务器 `https://docs.qq.com/openapi/mcp` 注册到 Host 共用的 [MCP 管理器](../../mcp/mcp-manager/README.zh.md)。用户在 Web 侧栏**插件**页面的插件详情页中连接腾讯文档账号，之后该 Host 上的所有对话都能使用这个服务器的工具，模型也会被告知把它称为腾讯文档插件。连接、OAuth 授权、已保存的 grant 和退出登录都由管理器负责，并由共用的 [MCP 账号服务](../../mcp/mcp-account/README.zh.md)显示在插件页面上。插件运行在 Web 与 Desktop 组合中。

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
dsh plugin --profile web add @deepseek-ai/dsh-tencent-docs
```

bundle patch 在 profile 其他层之后插入 `tencent-docs` 行。插件需要 `mcpManager` 与 `systemPrompt` 服务：[base bundle](../../bundle/base/README.zh.md) 提供 `systemPrompt`，Web 与 Desktop 组合通过 [`dsh-web-app`](../../bundle/web-app/README.zh.md) 补上 MCP 管理器。在没有 MCP 管理器的 profile（例如 `headless`）中，插件不会激活，启动时会打印一条警告，指出缺少 `mcpManager` 服务。

### 授权与退出登录

插件以固定的 OAuth 凭据 key `mcp-client/tencent-docs` 注册服务器 `tencent-docs`。没有已保存的 grant 时，服务器等待授权，不提供腾讯文档工具。有已保存的 grant 时，管理器在启动时连接，并按需刷新 token。腾讯文档的工具默认[按需加载](../../mcp/mcp-client/README.zh.md#on-demand-tool-loading)：系统提示词列出这些工具，每个 agent 用 `mcp__tencent-docs__load_tools` 加载需要的工具。

插件开启期间，它在**插件**页面的详情页显示 **腾讯文档账号**区块，标题旁的标签显示未连接、连接中、已连接、需要重新连接或暂时无法连接。在列表中开启插件而尚未连接账号时，页面提示**连接腾讯文档**，点击后打开插件详情页并发起授权。

| 区块状态 | 操作 |
|---|---|
| 未连接，或授权已过期、与当前设置不再匹配、被拒绝、缺少权限 | **连接腾讯文档** 或**重新连接**发起一次授权尝试 |
| 等待你在浏览器中确认 | 发起尝试的浏览器打开一次腾讯文档授权页面；**打开授权页面**再次打开，**取消**结束这次尝试 |
| 已连接 | **退出登录**确认后删除本地 grant |
| 暂时无法连接 | **重试**重启服务器并保留现有授权 |

授权必须在 Host 所在机器的浏览器中完成。用户在腾讯文档中同意授权后，回调页面说明 DSH 已收到授权，区块随后显示结果。离开页面不会取消授权尝试，尝试由 Host 持有。授权失败时显示**授权未完成，请重试**；页面操作失败时显示 toast。退出登录保留客户端注册，不会撤销腾讯文档签发的 token。

页面通过 [`connectorAccounts` Remote](../../client/ui-connector-account/README.zh.md) 以 key `mcp:tencent-docs` 跟随账号，其按钮在该 Remote 上发起 `connect`、`sign-out` 或 `retry`，或取消授权尝试。在 Host 上，[`dsh-mcp-account`](../../mcp/mcp-account/README.zh.md) 通过管理器的 [OAuth 操作](../../mcp/mcp-manager/README.zh.md#oauth-authorization)执行它们：`startAuthorization('tencent-docs')` 返回一次授权尝试，其 `authorizationUrl` 由流报告，`cancelAuthorization('tencent-docs', id)` 取消它，`signOut('tencent-docs')` 删除 grant，`restart('tencent-docs')` 重试。其他 Remote 客户端可以使用同样的操作。

### 停用与卸载

在 Plugin Manager 中关闭该行或卸载本包都会结束注册：腾讯文档工具从模型的工具集中撤下，已保存的 grant 留在凭据存储中，因此重新安装会复用它。要删除 grant，请在插件加载期间退出登录，或按[本地凭据提供方](../../credentials/credentials-local/README.zh.md)的说明，从 `$DSH_HOME/.credentials.yaml` 中删除 `mcp-client/tencent-docs` 记录。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `url` | `https://docs.qq.com/openapi/mcp` | 腾讯文档服务器的 Streamable HTTP MCP 端点 |
| `toolLoading` | `on-demand` | `on-demand` 让腾讯文档的工具在 agent 加载前对其隐藏；`eager` 在每次请求中发送全部工具定义 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tencent-docs)是受支持字段的完整来源。连接与授权的预算使用管理器和 mcp-client 的默认值。已保存的 grant 与 `url` 绑定，修改后需要重新连接账号。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制——点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 插入一行 id 为 `tencent-docs` 的条目，指向本包，因此本包既是 bundle，也是其唯一的一行；`config` 覆盖以该 id 为目标。Host 侧的 [`src/index.ts`](src/index.ts) 进行两项注册，二者都是插件 fiber 的 effect：`ctx.mcpManager.register('tencent-docs', …)` 以配置的 `url` 和 OAuth 凭据 key 添加一个 Streamable HTTP 条目，`ctx.systemPrompt.section()` 在 `MCP_SERVERS` 排序位置添加称呼指引。服务器名固定了 `mcp__tencent-docs__` 工具命名空间，凭据 key 固定了 grant 地址，因此重新加载或重新安装的插件会得到同样的工具和 grant。管理器在注册时校验条目；如果已配置或已注册的服务器占用了该名称或 key，插件会在添加指引之前加载失败。条目未设置 `scope`，因此授权请求腾讯文档 401 challenge 所指资源元数据中列出的 `docs:read docs:write docs:manage` scope，授权页面保留腾讯文档授权端点自带的 `authType=2` 查询参数。

账号注册表运行时，插件还调用 `ctx.mcpAccounts.register({ server: 'tencent-docs', packageName: '@deepseek-ai/dsh-tencent-docs', copy })`，其中 [`src/locales.ts`](src/locales.ts) 以每种已发布语言保存指明腾讯文档的文案；随后由 [`dsh-mcp-account`](../../mcp/mcp-account/README.zh.md) 把账号登记到连接器账号注册表，由注册表渲染上文所述的区块、引导、标签与 toast。没有注册表的组合（如 headless profile）加载插件时不带账号区块。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Connector 包](../README.zh.md)——这个应用插件所属的分组。
- [MCP 管理器](../../mcp/mcp-manager/README.zh.md)——注册生命周期、状态、OAuth 授权与退出登录。
- [MCP 客户端](../../mcp/mcp-client/README.zh.md)——连接、工具命名、OAuth grant 刷新与脱敏。
- [MCP 子系统](../../../docs/subsystems/mcp.zh.md)——各 MCP 包如何协同。
- [Plugin Manager](../../boot/plugin-manager/README.zh.md)——安装与启用。
- [MCP 账号服务](../../mcp/mcp-account/README.zh.md)——管理器的状态与授权如何映射到账号区块。
- [连接器账号界面](../../client/ui-connector-account/README.zh.md)——账号注册后显示的区块、标签、引导与提示。
- [插件页面](../../client/ui-plugin-manager/README.zh.md#use-this-package)——这些界面所在的 bundle 详情页。

-----

<a id="model-experience"></a>
## 模型体验

### 称呼与连接指引

#### 模型看到什么

插件加载期间，无论腾讯文档是否已授权，系统提示词都会在 MCP 服务器各节之后包含下面这段文字。

##### 指引文本

```markdown
Tools named `mcp__tencent-docs__*` come from the Tencent Docs plugin. In user-facing replies, call it the Tencent Docs plugin (腾讯文档插件 in Chinese), not MCP. If no `mcp__tencent-docs__*` tool appears in your tool list, Tencent Docs is not connected yet; ask the user to connect it on the Tencent Docs plugin page in Plugins.
```

#### Token 影响

插件加载期间，这三句固定文字为每次请求增加约 80 个 token。

#### KV Cache 影响

这段指引保持前缀稳定：只在插件加载或卸载时变化，授权或连接状态变化不会改变它。

### 腾讯文档服务器工具与说明

#### 模型看到什么

授权之后，模型会在 `### MCP server: tencent-docs` 之下看到腾讯文档的服务器说明；在默认的 `toolLoading: on-demand` 下，还会看到加载器 `mcp__tencent-docs__load_tools`，以及系统提示词中的[腾讯文档工具目录](../../mcp/mcp-client/README.zh.md#model-experience)，加载的每个工具随后以 `mcp__tencent-docs__<tool>` 命名，带有腾讯文档提供的描述和输入 schema。腾讯文档的许多工具名包含点号，例如 `doc.create_with_markdown`；目录按原样列出这些名称，加载后的名称把点号替换掉并加上哈希后缀，例如 `mcp__tencent-docs__doc_create_with_markdown_ff0986999909`，详见 [MCP 客户端](../../mcp/mcp-client/README.zh.md#model-experience)。设为 `eager` 时，所有工具从一开始就出现，详见 [MCP 客户端](../../mcp/mcp-client/README.zh.md#model-experience)。设为 `on-demand` 时，加载器和目录只在腾讯文档连接后出现。插件加载期间（包括授权之前），[共用的资源工具](../../mcp/mcp-resources/README.zh.md#model-experience)及其服务器名提示词都会列出 `tencent-docs`。

#### Token 影响

工具集与服务器说明由腾讯文档服务器定义，其大小可能在 DSH 不更新的情况下变化。设为 `on-demand` 时，已连接的腾讯文档的开销是约 3,000 字符的服务器说明、加载工具、225 个工具约 37,900 字符的目录，以及 agent 已加载的定义；设为 `eager` 时，全部 225 个定义在每次请求中重复出现。

#### KV Cache 影响

腾讯文档的服务器说明（设为 `eager` 时则是其工具）在连接成功时出现，在授权被撤回或插件卸载时消失；每次变化都可能使从第一个变化 token 起的复用失效。设为 `on-demand` 时，目录只在腾讯文档的工具列表变化时变化，每次加载都会改变该 agent 下一次请求的工具列表，详见 [MCP 客户端](../../mcp/mcp-client/README.zh.md#model-experience)。共用的资源工具在连接变化前后保持不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 腾讯文档账号区块只在插件开启时存在。关闭插件后如需退出登录，请先重新开启插件，或删除 grant 记录。
- 只有 Web 与 Desktop 组合挂载 MCP 管理器；在其他 profile 中插件保持未激活。
- 授权回调地址是 Host 上的 `http://127.0.0.1:<port>`，因此完成授权的浏览器必须运行在 Host 所在机器上。从另一台机器访问的 Web Host 无法完成授权。
- Desktop 每次启动都监听操作系统分配的端口。重启后再次授权会注册一个新的 OAuth 客户端，并保留之前的注册记录；已保存的 grant 在重启前后正常刷新。
- 账号连接之前，共享资源的提示词仍把 `tencent-docs` 列为服务器名，对它的资源调用会失败，直到用户完成连接。
- 一次腾讯文档授权供整个 Host 使用；没有账号或工作区选择器。
- 停用或卸载插件会保留本地 grant。退出登录会删除本地 grant，但 DSH 不会撤销腾讯文档已签发的 token；腾讯文档的授权服务器没有公布撤销端点。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

Host 侧单测让插件运行在 MCP 管理器和 mcp-client 的回环 OAuth 服务器夹具之上；另一项单测检查账号注册表提供带文案的腾讯文档账号，并随插件一起撤下。`tencent-docs-plugin` 会话快照在没有已保存 grant 的情况下回放腾讯文档行，因此它固定称呼指引，并验证没有请求到达服务器。Web e2e 的夹具按托管服务的元数据布局：challenge 指向 MCP 路径下的资源元数据，该元数据列出 `docs:*` scope，授权端点自带查询参数。

</details>
