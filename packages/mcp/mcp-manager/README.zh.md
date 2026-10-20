---
description: "MCP 服务器管理器：面向在自身生命周期内注册 MCP 服务器的插件，以及观察和重启这些服务器的管理界面。"
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-manager

[English](README.md) | 中文

## 概述

`dsh-mcp-manager` 管理一组实时 MCP 服务器，它们由已安装插件在自身生命周期内注册。管理器为每个注册挂载一个 Streamable HTTP `dsh-mcp-client` 实例，注册结束时卸载它。`ctx.mcpServers` 汇总每台服务器的连接状态，`restart` 恢复重连预算耗尽的服务器，`watch` 向 Remote 客户端推送服务器列表。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

每个宿主挂载一次管理器。Web 与 Desktop profile 将它作为 [`dsh-web-app`](../../bundle/web-app/README.zh.md) 的 `mcp-manager` 行挂载。

### 何时选择它

当已安装插件带来自己的 MCP 服务器，且服务器应恰好在该插件加载期间存在时，就选管理器。当部署把服务器钉死在组合里，或某台服务器只属于一个 agent preset 而非整个宿主时，继续用普通的 `dsh-mcp-client` 行；管理器只治理全局面。

### 最小配置

一条 `cordis.yml` 行挂载管理器：

```yaml
- id: mcp-manager
  name: '@deepseek-ai/dsh-mcp-manager'
  config:
    startupTimeoutMs: 30000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `startupTimeoutMs` | `30,000` | 每台注册服务器一次连接尝试及其初次工具发现的预算 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-mcp-manager)是每个可接受字段的详尽出处。

### 从插件注册服务器

接入某个 MCP 服务的插件注册自己的服务器：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-mcp-manager'

export const name = 'example-app'
export const inject = ['mcpServers']

export function apply(ctx: Context): void {
  ctx.mcpServers.register('example', { url: 'https://mcp.example.com/mcp' })
}
```

`register(name, entry)` 为 `entry.url` 挂载一个 Streamable HTTP 实例，其 `serverName` 为 `name`（`[A-Za-z0-9_-]{1,32}`）。该实例的工具调用超时、清理预算与重连策略使用 mcp-client 默认值，启动预算使用管理器的 `startupTimeoutMs`。注册在调用方插件的生命周期内有效：通过插件管理器停用或卸载该插件会将其卸载，注册的释放会卸载服务器并撤回其工具，然后插件的释放才完成。名字不合法或已被其他注册占用时，注册直接抛错。

### 观察与恢复

`ctx.mcpServers.list()` 按注册顺序返回各服务器的 `name` 与实时 `status`。清理失败的已移除注册继续列出，该行保留到宿主重启。清理状态保留首个诊断；实例未确认关闭时，`closeConfirmed` 为 `false`。

重连留在 mcp-client 内。`restart(name)` 替换实例并重置重连预算，预算耗尽后同样适用。传输关闭未确认或本地清理出错时，会阻止该服务器的替换；需要重启宿主恢复。

### Remote 操作

浏览器客户端经 [`dsh-api-remotes`](../../api/remotes/README.zh.md) 以 `ctx.remote.mcpServers` 访问管理器。`watch(signal)` 在订阅时推送完整服务器列表，之后每次状态或注册变化再推送一次，订阅方尚未读取的变化会合并；中止信号结束该流，管理器销毁结束所有流。`restart(name)` 执行上述操作。管理器不提供写入方法，因此浏览器无法定义服务器。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

本节解释设计决策并指向代码；可观察行为已在[使用本包](#use-this-package)中完整覆盖。

### 设计理念

- **注册是副作用。** 注册是调用方插件的副作用，因此由其所有者的生命周期决定服务器何时存在；没有插件需要写入别的插件的配置，移除时也不会残留条目。运行时记录保留实例归属与清理失败。
- **单条串行操作队列。** 对账与 restart 排在一条链上，两个生命周期操作不能交错同一实例的卸载/挂载。
- **连接处理留在 mcp-client。** 子实例是挂在管理器 fiber 下的普通插件实例：`serverName` 预留与静态组合实例正确互斥，收卷即注销工具，管理器经 `connectionStatusOf` 读取各实例状态而不重复监督。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务本体：注册、对账、restart、watch、状态注册表 |
| [`src/types.ts`](src/types.ts) | 状态联合与列表视图（`./types`） |

### 生命周期要点

子实例启动不占住操作队列。注册移除时，在排队清理前停止转发子实例状态；替换等待子实例完成清理。相等的状态不重复发布。注册移除后仍可观察清理失败；销毁结束每个 `watch` 流。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

包级契约不够用时读这些页面。

- [mcp-client README](../mcp-client/README.zh.md) —— 单实例桥：命名、重连策略、工具执行、状态面。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-mcp-manager) —— 每个可接受的配置字段。
- [MCP 管理器 Agent Note](../../../.agents/notes/implemented/feature/2026-08-31-mcp-manager-plugin.zh.md) —— 设计决策、同类产品调研与被否决的替代方案。

-----

<a id="model-experience"></a>
## 模型体验

通过其挂载的 `dsh-mcp-client` 实例间接影响；进入请求的是那些实例的服务器限定工具与 schema，管理器自身不注册任何提示词或工具内容。

#### KV Cache 影响

不会直接导致 KV Cache 失效；挂载、重建与卸载实例对工具定义的影响与 mcp-client README 所述完全一致，管理器自身不添加任何请求内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制描述今天用本管理器做不到的事。它们是当前包约束，不是任务清单。

- **没有 OAuth 流程**——服务器返回授权挑战时表现为普通连接失败与重连翻腾；没有 needs-auth 状态、token 存储或交互式登录。
- **只治理全局面**——agent preset 或静态 `cordis.yml` 行挂载的实例既不被列出也不受治理；静态实例只在受管条目试图复用其名字时以 `serverName` 冲突现身。
- **重启存在工具空窗**——重启的服务器先销毁再重挂，其工具会从模型工具集消失直到新实例完成初次同步；没有旧代继续服务到换代完成的交接。
- **注册只是使用客户端默认值的 Streamable HTTP 端点**——注册只设置 URL，因此管理器不挂载 stdio 服务器，并对工具调用超时、清理预算与重连策略使用 mcp-client 默认值；需要其他设置的插件自行挂载 `dsh-mcp-client` 实例。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放设计问题与尚未决定的方向。它明确不具权威性——已交付行为、限制与既定理由以上文、包代码与所链接的 Agent Note 为准。

- OAuth 应落在凭据记录与 authorization seam 加上 MCP SDK 的 `OAuthClientProvider` 之上；`needs-auth` 状态位为其保留。
- 滚动换代（先起新实例再销毁旧实例、保持公开工具名稳定）可以消除重启空窗；同类产品用代理世代实现这一点。
- 逐服务器的工具允许/禁用清单是注册的自然扩展，待出现真实消费方再加。

</details>
