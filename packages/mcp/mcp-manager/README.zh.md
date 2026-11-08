---
description: "MCP 服务器管理器：面向需要在运行时添加、修改、注册、启停、删除、探测并观察 MCP 服务器的部署、插件与管理界面。"
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-manager

[English](README.md) | 中文

## 概述

`dsh-mcp-manager` 管理一组实时 MCP 服务器，来源有两个：其 profile 条目 `config.servers` 中的条目（也可通过 Settings 编辑），以及已安装插件在自身生命周期内注册的条目。管理器为每个启用的条目挂载一个 `dsh-mcp-client` 实例，并随任一来源变化实时增加、重建、停用与移除实例。`ctx.mcpManager` 汇总每台服务器的连接状态，`restart` 恢复重连预算耗尽的服务器，`probe` 在不触碰活动实例的情况下测试一个条目，`watch` 向 Remote 客户端推送服务器列表。`${credential:REF}` 模板让密钥不进入条目；mcp-client 在各实例内部处理凭据轮换。

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

每个宿主挂载一次管理器。它自己创建 MCP 客户端宿主，只通过它校验、挂载、探测和授权服务器。Web 与 Desktop profile 将它作为 [`dsh-web-app`](../../bundle/web-app/README.zh.md) 的 `mcp-manager` 行挂载。其 volatile `config.servers` 存放配置条目；Settings 以所属条目 id 作为命名空间（下例为 `mcp`）。凭据模板与 OAuth 授权经凭据提供方解析，因此只要条目可能用到它们，就为该行加上 `inject: [credentials]`。

### 何时选择它

当服务器集合需要在运行时变化——设置编辑或管理界面添加、改配、停用、删除配置的服务器，或已安装插件带来自己的服务器——就选管理器。当部署把服务器钉死在组合里，或某台服务器只属于一个 agent preset 而非整个宿主时，继续用普通的 `dsh-mcp-client` 行；管理器只治理全局面。

### 最小配置

一条 `cordis.yml` 行挂载管理器；其配置里的 `servers` 可选，将成为组合基层：

```yaml
- id: mcp
  name: '@deepseek-ai/dsh-mcp-manager'
  inject: [credentials]
  config:
    servers:
      github:
        transport: stdio
        command: npx
        args: ['-y', '@modelcontextprotocol/server-github']
        env:
          GITHUB_TOKEN: '${credential:GITHUB_TOKEN}'
```

profile 的 `cordis.patch.yml` 会替换条目的完整 `servers` 映射。需要局部编辑并保留继承服务器时使用 Settings；完整替换则按以下方式指定管理器条目：

```yaml
- id: mcp
  config:
    servers:
      internal:
        transport: streamable-http
        url: https://mcp.example.com/mcp
        headers:
          Authorization: 'Bearer ${credential:MCP_TOKEN}'
        enabled: true
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `servers.<name>` | `{}` | 每个键一台受管服务器；键即实例的 `serverName`（`[A-Za-z0-9_-]{1,32}`） |
| `transport` | 必填 | `stdio` 或 `streamable-http` |
| `command` / `args` / `env` / `cwd` | — | stdio：可执行文件、参数、附加子进程环境、工作目录 |
| `url` / `headers` | — | streamable-http：端点 URL 与附加请求头 |
| `enabled` | `true` | 持久意图：`false` 卸载实例但保留条目 |
| `startupTimeoutMs` | `30,000` | 模板解析、协商、连接与初次工具发现的预算 |
| `toolCallTimeoutMs` / `closeTimeoutMs` / `reconnect` / `toolLoading` | mcp-client 默认值 | 逐服务器覆盖；`toolLoading: on-demand` 让 agent [在需要时加载服务器的工具](../mcp-client/README.zh.md#on-demand-tool-loading) |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-mcp-manager)是每个可接受字段的详尽出处。

### 管理配置的服务器

Settings 写入经 ConfigEditor 持久化并检查 revision；Loader 更新 volatile 配置，无需重新挂载管理器。每次提交的配置变更都会对账编队：新的启用条目挂载，被移除的条目卸载，`enabled: false` 卸载实例但保留条目在列表中，其余任何字段变化只重建那一个实例、未变的同级继续运行。通过 Settings 可以覆盖或停用继承的服务器；删除继承的服务器会恢复其基层配置。只有用户层新增的服务器才可移除。坏条目——缺 `command`、带跨传输字段、模板写错，或使用了插件已注册的名字——在写入处被拒绝，因此文档绝不会存下管理器无法执行的服务器。

`env` 值、`headers` 值、`command`、`args`、`cwd` 与 `url` 接受 `${credential:REF}` 模板。管理器将原始字符串传给 mcp-client 并启用模板展开；配置对管理界面保持可读，因此密钥值应保存在凭据提供方中。缺失值使实例进入 `waiting-credentials`；被引用凭据更新时重试解析，解析值变化时替换连接。诊断与工具失败会把每个已解析的值替换为 `[redacted]`。提供方要求与替换顺序见[运行时模板与凭据](../mcp-client/README.zh.md#runtime-templates-and-credentials)。

### 从插件注册服务器

接入某个 MCP 服务的插件注册自己的服务器，而不是写入配置：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-mcp-manager'

export const name = 'example-app'
export const inject = ['mcpManager']

export function apply(ctx: Context): void {
  ctx.mcpManager.register('example', {
    transport: 'streamable-http',
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: 'Bearer ${credential:EXAMPLE_TOKEN}' },
  })
}
```

`register(name, entry)` 接受除 `enabled` 外的全部配置条目字段，并执行相同校验。注册在调用方插件的生命周期内有效：通过插件管理器停用或卸载该插件会将其卸载，注册的释放会卸载服务器并撤回其工具，然后插件的释放才完成。服务器解析过的值仍保存在凭据提供方中。注册名必须与所有配置条目和其他注册都不同；注册与之后的设置写入都会拒绝冲突。Settings 不编辑注册的条目。

### 观察与恢复

`ctx.mcpManager.list()` 返回各服务器的 `name`、`configured` 标记与实时 `status`，配置条目排在注册条目之前。已移除、但仍在清理或清理失败的条目继续列出，`configured: false`；清理失败时该行保留到宿主重启。清理状态保留首个诊断；任一实例或探测未确认关闭时，`closeConfirmed` 保持 `false`。管理器存活期间，已发布状态的变化会发出 `mcp-manager/status`，包括条目移除后的清理失败。生命周期操作不等待监听器完成；监听器同步抛错或返回的 Promise 拒绝都会被记录，其他监听器仍会收到通知。

重连留在 mcp-client 内。`restart(name)` 替换实例并重置重连预算，预算耗尽后同样适用。传输关闭未确认或本地清理出错时，会阻止该服务器的替换与后续探测；需要重启宿主恢复。`probe(name, options)` 解析模板、连接、读取服务器身份与工具名，再关闭，不注册工具或预留 namespace。已停用条目也可探测。对 OAuth 条目，探测可能刷新过期授权并保存新令牌。探测有独立的截止时间与取消信号，并分别报告连接/列表查询成功与关闭、清理结果。

<a id="oauth-authorization"></a>
### OAuth 授权

使用[客户端 OAuth 选项](../mcp-client/README.zh.md#oauth)配置或注册条目。每个条目（包括禁用条目）都需要独立且稳定的 `oauth.credentialKey`：重命名或覆盖继承条目时保留，复制条目时分配新值。管理器拒绝已被其他配置条目或注册条目占用的 key。注册 OAuth 服务器的插件使用一个固定的 key，因此重新安装的插件会复用已保存的授权。

加载 credentials、Authorization 和 WebServer 服务后，`startAuthorization(name)` 启动授权尝试或返回当前尝试。`list()` 暴露进度与浏览器 URL；`mcp-manager/status` 也通知授权状态更新，以及清理成功后的授权视图移除。`cancelAuthorization(name, id)` 只取消指定尝试。失败或取消保留旧授权；已经获准的提交会完成。条目替换时立即退役授权所有者，因此等待中的重试无法使用旧配置启动。

`signOut(name)` 排空授权、探测与连接，再删除本地授权，同时保留兼容的客户端注册。整个操作期间拒绝新的授权和探测。删除前配置发生变化（例如保留 key 的重命名）时保留授权并拒绝本次退出。清理未完成时保留授权并要求重启宿主。退出不执行远程令牌撤销。显式授权中被拒绝的动态客户端注册会被删除，使下一次显式尝试可以重新注册。

### Remote 操作

浏览器客户端经 [`dsh-api-remotes`](../../api/remotes/README.zh.md) 以 `ctx.remote.mcpManager` 访问管理器。`watch(signal)` 在订阅时推送完整服务器列表，之后每次状态或条目变化再推送一次，订阅方尚未读取的变化会合并；中止信号结束该流，管理器销毁结束所有流。`restart(name)` 与 `probe(name, signal)` 执行上述操作。授权、取消与退出只在宿主上执行：插件页经由 [`dsh-mcp-account`](../mcp-account/README.zh.md) 调用它们，因此浏览器从不指定要授权的服务器。配置写入仍走 Settings Remote；管理器不提供写入方法，因此浏览器无法定义服务器命令。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

本节解释设计决策并指向代码；可观察行为已在[使用本包](#use-this-package)中完整覆盖。

### 设计理念

- **两个来源决定服务器集合。** 当前 volatile Config 值（schema 默认值 → 继承的 profile 配置 → 用户 patch）决定配置条目；注册添加插件拥有的条目。运行时记录保留实例归属、活动探测与清理失败。外部文件编辑与管理界面写入走同一条路。
- **注册是副作用。** 注册是调用方插件的副作用，因此由其所有者的生命周期决定服务器何时存在；没有插件需要写入别的插件的配置，移除时也不会残留条目。
- **单条串行操作队列。** 对账与 restart 排在一条链上，两个生命周期操作不能交错同一实例的卸载/挂载。探测独立运行；条目变化与销毁会先取消探测，再等待操作队列与所属资源的清理。
- **整条目即身份。** 除 `enabled` 外任何字段变化都会重建实例——实例配置在 mcp-client 加载时被捕获，原地更新不存在。`enabled` 只切换是否挂载。
- **扁平条目 schema，跨字段校验。** 写入期校验在写入处强制执行 union 本可表达的逐传输规则，拒绝时点名出错字段——union 的形状错误做不到这一点。MCP 客户端宿主用各传输自己的 schema 校验 mcp-client 拥有的字段——作为 `serverName` 的条目键、模板 token、`reconnect` 与 `oauth`——因此这些拒绝同样点名字段；管理器的 schema 对 `reconnect` 与 `oauth` 原样透传、不做解析。
- **连接处理留在 mcp-client。** 子实例是宿主挂在其自身 Fiber 下的普通 mcp-client 实例：`serverName` 预留与静态组合实例正确互斥，收卷即注销工具，管理器经宿主返回的句柄读取各实例状态而不重复监督。
- **宿主是管理器接触 mcp-client 的唯一途径。** 除 mcp-client 的类型外，管理器只导入 `McpClientHost` 类，并在构造时创建宿主，因此宿主及其挂载的所有实例都运行在管理器的 Fiber 下，随管理器结束。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务本体：schema、校验、注册、对账、restart、probe、watch、状态注册表 |
| [`src/types.ts`](src/types.ts) | 状态联合、列表视图与 `mcp-manager/status` 事件声明（`./types`） |

### 生命周期要点

管理器只在宿主可用时运行；撤下宿主会停止管理器，宿主再次可用时管理器带着配置与注册的条目重新启动。首次对账等待管理器自身 fiber 激活，因为服务从那一刻起才对依赖方可见。子实例启动不占住操作队列。条目变化或移除时，在排队清理前停止转发子实例状态并取消其探测；替换等待探测与子实例都完成清理。相等的状态不重复发布。条目移除后仍可观察清理失败；销毁停止所有后续事件并结束每个 `watch` 流。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

包级契约不够用时读这些页面。

- [mcp-client README](../mcp-client/README.zh.md) —— 单实例桥：命名、重连策略、工具执行、状态面。
- [Settings 包 README](../../settings/settings/README.zh.md) —— 管理器使用的 Config 表单、继承、revision 检查与 profile 写入。
- [Credentials 组 README](../../credentials/README.zh.md) —— `${credential:…}` 模板解析的凭据引用。
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

- **OAuth 登录界面只随插件账号提供**——[`dsh-mcp-account`](../mcp-account/README.zh.md) 为向它注册的插件服务器在**插件**页面显示账号；其他服务器没有浏览器界面可以授权，因为授权只经由宿主上的调用方执行。
- **只治理全局面**——agent preset 或静态 `cordis.yml` 行挂载的实例既不被列出也不受治理；静态实例只在受管条目试图复用其名字时以 `serverName` 冲突现身。
- **重建存在工具空窗**——变更的条目先销毁再重挂，其工具会从模型工具集消失直到新实例完成初次同步；没有旧代继续服务到换代完成的交接。
- **注册条目由其插件固定**——Settings 无法覆盖注册条目的预算；注册插件需要的可调参数放在它自己的配置中。
- **探测输出有上限**——探测默认最多跟进 16 页列表、返回 512 个工具名，超出即报告截断；调用方可设置 `maxPages` 与 `maxToolNames`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放设计问题与尚未决定的方向。它明确不具权威性——已交付行为、限制与既定理由以上文、包代码与所链接的 Agent Note 为准。

- 滚动换代（先起新实例再销毁旧实例、保持公开工具名稳定）可以消除重建空窗；同类产品用代理世代实现这一点。
- 逐服务器的工具允许/禁用清单是条目的自然扩展，待出现真实消费方再加。

</details>
