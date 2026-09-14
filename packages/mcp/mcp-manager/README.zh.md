---
description: "MCP 服务器管理器：面向需要在运行时通过 mcp 设置命名空间添加、修改、启停、删除、探测并观察 MCP 服务器的部署与管理界面。"
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-manager

[English](README.md) | 中文

## 概述

`dsh-mcp-manager` 把 `mcp` 设置命名空间变成一支活的 MCP 服务器编队：在 `settings.yaml` 的 `mcp.servers` 下声明服务器（或由管理界面写入），管理器为每个启用的条目挂载一个 `dsh-mcp-client` 实例，并随文档变化增加、重建、停用与移除实例，无需重启。`ctx.mcpServers` 汇总每台服务器的连接状态，`restart` 恢复重连预算耗尽的服务器，`probe` 在不触碰活动实例的情况下测试一份配置。`${env:NAME}` 与 `${credential:REF}` 模板让密钥不进入文档，轮换的凭据只重建引用它的服务器。

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

挂载一次管理器；此后用户设置文档的 `mcp.servers` 分节就是管理服务器的唯一入口。

### 何时选择它

当服务器集合需要在运行时变化——设置编辑或 Web 管理界面添加、改配、停用、删除服务器且改动即时生效——就选管理器。当部署把服务器钉死在组合里，或某台服务器只属于一个 agent preset 而非整个宿主时，继续用普通的 `dsh-mcp-client` 行；管理器只治理全局面。

### 最小配置

一条 `cordis.yml` 行挂载管理器；其配置里的 `servers` 可选，将成为组合基层：

```yaml
- id: mcp
  name: '@deepseek-ai/dsh-mcp-manager'
  config:
    servers:
      github:
        transport: stdio
        command: npx
        args: ['-y', '@modelcontextprotocol/server-github']
        env:
          GITHUB_TOKEN: '${credential:GITHUB_TOKEN}'
```

用户在 `settings.yaml` 里以同样的形状添加或覆盖服务器：

```yaml
mcp:
  servers:
    internal:
      transport: streamable-http
      url: https://mcp.example.com/mcp
      headers:
        Authorization: 'Bearer ${env:MCP_TOKEN}'
      enabled: true
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `servers.<name>` | `{}` | 每个键一台受管服务器；键即实例的 `serverName`（`[A-Za-z0-9_-]{1,32}`） |
| `transport` | 必填 | `stdio` 或 `streamable-http` |
| `command` / `args` / `env` / `cwd` | — | stdio：可执行文件、参数、附加子进程环境、工作目录 |
| `url` / `headers` | — | streamable-http：端点 URL 与附加请求头 |
| `enabled` | `true` | 持久意图：`false` 卸载实例但保留条目 |
| `toolCallTimeoutMs` / `startupTimeoutMs` / `healthCheckIntervalMs` / `reconnect` | mcp-client 默认值 | 逐服务器覆盖，原样传给实例 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-mcp-manager)是每个可接受字段的详尽出处。

### 运行时管理服务器

每次提交的设置变更都会对账编队：新的启用条目挂载，被移除的条目卸载，`enabled: false` 卸载实例但保留条目在列表中，其余任何字段变化只重建那一个实例、未变的同级继续运行。来自组合的基层条目可以在用户文档中覆盖或停用，但不能删除；只有用户层单独承载的条目才可移除。坏条目——缺 `command`、带跨传输字段、模板写错——在写入处被拒绝，因此文档绝不会存下管理器无法执行的服务器。

`env` 值、`headers` 值、`command`、`args`、`cwd` 与 `url` 接受 `${env:NAME}` 与 `${credential:REF}` 模板，在实例挂载时解析，设置文档因此从不携带密钥；存储值——包括模板串——对管理表面保持可读，必须隐藏的值应写成模板而不是存进文档。引用缺失会让那一台服务器失败，并给出指明修复方式的消息。存入或轮换被引用的凭据会重建使用它的服务器——包括那台因凭据当时还不存在而挂载失败的。

### 观察与恢复

`ctx.mcpServers.list()` 给管理界面每台已配置服务器一行：传输、持久意图、可删性与实时状态（`connecting`、带工具数的 `connected`、带尝试预算的 `reconnecting`、带原因与最近错误的 `failed`，或 `disabled`）。每次状态迁移同时发出 `mcp-manager/status` 事件。重连本身留在 mcp-client 内（500 毫秒到 30 秒退避、每次断线十次尝试）；`restart(name)` 是其外的手动恢复——全新实例带全新预算，也是不改配置时走出 `failed` 终态的唯一途径。`probe(name)` 连接、列工具、断开而不注册任何东西——即「测试该服务器」，对已停用条目同样可用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

本节解释设计决策并指向代码；可观察行为已在[使用本包](#use-this-package)中完整覆盖。

### 设计理念

- **配置是唯一事实。** 管理器不自存服务器状态：每个决策都新读解析后的设置值（schema 默认值 → 组合基层 → 用户层），因此外部文件编辑与管理界面写入走同一条路。
- **单条串行操作尾巴。** 对账、restart 与凭据重建排在一条链上，两个生命周期操作永远无法交错同一实例的卸载/挂载，销毁时先排干尾巴再收卷。
- **整条目即身份。** 除 `enabled` 外任何字段变化都会重建实例——实例配置在 mcp-client 加载时被捕获，原地更新不存在。`enabled` 只切换是否挂载。
- **扁平条目 schema，跨字段校验。** 写入期校验在写入处强制执行 union 本可表达的逐传输规则，拒绝时点名出错字段——union 的形状错误做不到这一点。
- **连接处理留在 mcp-client。** 子实例是挂在管理器 fiber 下的普通插件实例：`serverName` 预留与静态组合实例正确互斥，收卷即注销工具，管理器经 `connectionStatusOf` 读取各实例状态而不重复监督。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务本体：schema、校验、对账、restart、probe、状态注册表 |
| [`src/templates.ts`](src/templates.ts) | `${env:…}` / `${credential:…}` 语法检查、解析与静态引用扫描 |
| [`src/types.ts`](src/types.ts) | 状态联合、列表视图与 `mcp-manager/status` 事件声明 |
| [`src/invariant.ts`](src/invariant.ts) | 不变量伴生：状态事件必须点名活管理器所列出的服务器 |

### 生命周期要点

首次对账等待管理器自身 fiber 激活，因为服务从那一刻起才对依赖方可见，而状态事件断言管理器可达。挂载在模板解析后会把条目与当前配置复核一致，解析中途被删除的条目不会留下任何东西。状态发布对相等值吸收、对配置已不含的名字丢弃、销毁后彻底停止——被拆除实例的迟到连接回调不可能替一个已消失的管理器发事件。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

包级契约不够用时读这些页面。

- [mcp-client README](../mcp-client/README.zh.md) —— 单实例桥：命名、重连策略、工具执行、状态面。
- [Settings 包 README](../../settings/settings/README.zh.md) —— 管理器所依托的命名空间注册、分层与写入语义。
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

- **没有 OAuth 流程**——服务器返回授权挑战时表现为普通连接失败与重连翻腾；没有 needs-auth 状态、token 存储或交互式登录。
- **只治理全局面**——agent preset 或静态 `cordis.yml` 行挂载的实例既不被列出也不受治理；静态实例只在受管条目试图复用其名字时以 `serverName` 冲突现身。
- **重建存在工具空窗**——变更的条目先销毁再重挂，其工具会从模型工具集消失直到新实例完成初次同步；没有旧代继续服务到换代完成的交接。
- **模板只认两种来源**——仅 `${env:NAME}` 与 `${credential:REF}`；没有默认值语法，也没有其他来源。
- **探测输出有上限**——一次探测最多跟进 16 页列表、最多返回 512 个工具名，超出即报告截断。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放设计问题与尚未决定的方向。它明确不具权威性——已交付行为、限制与既定理由以上文、包代码与所链接的 Agent Note 为准。

- 覆盖 `list`/`restart`/`probe` 与设置命名空间的 Remote 控制器和 Web 设置分区是预期中的管理界面；这里的服务 API 正是为它们塑形的。
- OAuth 应落在凭据记录与 authorization seam 加上 MCP SDK 的 `OAuthClientProvider` 之上；`needs-auth` 状态位为其保留。
- 滚动换代（先起新实例再销毁旧实例、保持公开工具名稳定）可以消除重建空窗；同类产品用代理世代实现这一点。
- 逐服务器的工具允许/禁用清单是条目的自然扩展，待出现真实消费方再加。

</details>
