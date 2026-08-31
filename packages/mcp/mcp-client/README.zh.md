---
description: "面向部署方与维护者的 MCP 客户端桥接说明，用于选择、配置或排查连接到外部 MCP 服务器、并将其工具注册到 ctx.tools 的插件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-client

[English](README.md) | 中文

## 概述

`dsh-mcp-client` 把外部 MCP（Model Context Protocol）服务器挂载到 harness 上，让它们的工具像原生工具一样可用。每台服务器一条配置项，模型就能调用该服务器的工具——文件系统、GitHub、数据库或记忆服务器——名称稳定，例如 `mcp__github__create_issue`。当模型需要使用外部工具服务器时添加它；默认不启用任何服务器，因此由你开启。主要成本是这些工具定义给每次请求增加的 token，而且缓慢或崩溃的服务器可能延迟启动，或在恢复前让它的工具一直调用失败。只桥接工具能力：MCP resources 与 prompts 不受支持。

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

当模型需要把外部 MCP 服务器的工具当作原生工具调用时，添加 `dsh-mcp-client`。每台服务器一条配置项就是全部设置：给服务器一个简短的唯一名称和一种传输方式，它的工具就会以 `mcp__<serverName>__<tool>` 形式出现。服务器作为本地程序运行时选择 stdio，作为服务运行时选择 Streamable HTTP。如果你已经用其他客户端连接过 MCP 工具服务器，同样的配置行在这里也能用。

### 最小配置

每台服务器添加一条配置项即可，无需其他内容。harness 启动后，服务器的工具会出现在模型的工具列表中。

```yaml
- id: mcp-github
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: github
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
    env:
      GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN

- id: mcp-web
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: web
    transport: streamable-http
    url: http://localhost:3000/mcp
    headers:
      Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `transport` | 必填 | `stdio` 或 `streamable-http` |
| `serverName` | 必填 | 服务器工具名称的 namespace；`[A-Za-z0-9_-]{1,32}`，在一个注册作用域内唯一 |
| `command` / `args` / `env` / `cwd` | — | stdio：可执行文件、参数、合并到清洗过的环境之上的额外环境变量、工作目录 |
| `url` / `headers` | — | streamable-http：端点 URL 与额外请求标头 |
| `toolCallTimeoutMs` | `60,000` | 每次 `tools/call` 调用的超时 |
| `startupTimeoutMs` | `30,000` | 单次连接尝试加初次工具同步的预算 |
| `healthCheckIntervalMs` | `30,000` | 已建立连接上两次存活 ping 的间隔（同时是每次 ping 的应答预算） |
| `failOnStartupError` | `false` | 初始连接或工具同步失败时拒绝插件激活 |
| `reconnect.enabled` | `true` | 连接丢失后自动重新连接 |
| `reconnect.initialDelayMs` | `500` | 首次重连延迟；每次连续失败尝试翻倍 |
| `reconnect.maxDelayMs` | `30,000` | 退避上限；同时是重置尝试预算所需的正常运行时长 |
| `reconnect.maxAttempts` | `10` | 每次中断内连续失败尝试次数上限，超出后放弃 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-mcp-client)是每个受支持字段及其 JSDoc 的穷尽式真源。

启动后，服务器的工具会以 `mcp__<serverName>__<tool>` 形式出现——试着用一条提示词调用其中一个。如果初始连接失败，harness 仍会启动，但该服务器的工具不会出现，并会记录一条错误；设置 `failOnStartupError: true` 可让启动失败改为中止 harness。

### 工具命名与共存

模型看到每个工具都带有稳定的服务器限定名称：`mcp__<serverName>__<rawName>`，例如 `mcp__github__create_issue`——与 Claude Code 和 Codex 使用的命名形态相同。只要服务器保持相同的工具名称，名称就保持不变，因此会话历史与权限规则在重启和重载后仍然有效。两个服务器可以同时提供名为 `search` 的工具，分别以 `mcp__github__search` 和 `mcp__web__search` 共存。

- 发布相同工具名称（例如 `search`）的两个服务器会在各自的 namespace 下共存。
- 两条配置项使用相同的服务器名称时，后加载的一条会在加载时以明确错误失败。
- 服务器在工具列表中两次列出同一工具时，其工具列表会被作为无效列表拒绝，上一组工具保持可用。
- 工具更新与已有工具名称冲突时，该更新会被整体拒绝——绝不会得到该服务器的部分工具集。

### 调用工具与读取结果

模型调用 MCP 工具时，调用会以每次调用超时（默认 60 秒）发往远程服务器，并像其他工具调用一样可以取消。结果按块顺序以普通文本返回；资源链接以文本形式显示名称与 URI。如果服务器报告错误，调用会明确失败——模型不会看到虚假的成功。

当前模型接受图片输入且 harness 启用了附件功能时支持图片；图片会像其他图片一样出现在对话中。不支持图片时——以及服务器返回音频或嵌入资源时——模型会看到清晰的诊断消息，而不是什么都没有。

### 启动、工具更新与重连

服务器的工具会在 harness 开始首个轮次之前出现。每次连接尝试——首次连接与每次重连——都受 `startupTimeoutMs`（默认 30 秒）约束，覆盖连接加初次工具发现，因此无响应的服务器无法拖住启动。已建立的连接每 `healthCheckIntervalMs`（默认 30 秒）发送一次存活 ping：stdio 服务器死亡会自行关闭传输，而 Streamable HTTP 在两次请求之间没有连接，失败或超时的 ping 正是把悄然死亡的服务器送入重连路径的信号。服务器更改工具列表时，模型的工具集会自动更新；更新失败时，上一组工具继续可用。

服务器连接断开时——例如本地服务器进程崩溃——插件会以从 500 ms 起逐次翻倍、上限 30 s 的延迟自动重连，并刷新工具集；重连进度在日志中可见。中断期间最后已知的工具仍会列出，但对它们的调用会失败，直到服务器恢复。连续失败十次后，该服务器的工具会被移除，重连停止，直到你重载配置或重启 harness；服务器持续连接一段时间后，该计数会重置。设置 `reconnect.enabled: false` 可禁用自动重连——此时工具在断开后仍会列出，但调用失败，直到你重载。编辑配置项会在原地重载服务器连接，未变的名称保持不变。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释桥接背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

- **服务器限定身份。** 每个 MCP 工具都有稳定的身份 `(serverName, rawName)`。namespace 是本地配置，绝不采用远程 `serverInfo.name`——远程名称不可信、在部署间不唯一、且升级时可能变化，这些都不允许静默重命名面向模型的工具。
- **命名是固定约定。** 公开名称是 `(serverName, rawName)` 的纯函数，并满足 DeepSeek 函数名称约定；有损规范化会追加 12 位十六进制 SHA-256 hash，使不同身份绝不会折叠。会话历史与权限规则因此能在 HMR 替换、重新同步和其他服务器变化后保持有效。
- **原始名称是唯一的协议名称。** `tools/call` 始终收到原始名称；公开名称绝不会发给服务器，也绝不会被解析来还原原始名称。
- **要么完整世代，要么没有。** 同步会原子地交换世代：获取失败保留上一世代，注册冲突则回滚整个尝试中的世代。
- **一个规范值，一个投影。** 执行器返回协议完整的规范 `McpResult`；另一个有序投影准备 Native 内容，`finalizeContent` 只在注册表的执行后结果未变时安装它，因此策略块与值替换保持权威。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、`serverName` 预留、激活等待 |
| [`src/connection.ts`](src/connection.ts) | 连接监督器：客户端世代、重连策略、尝试预算、dispose |
| [`src/tools.ts`](src/tools.ts) | 工具桥接：发现、命名、注册交换、执行、图片投影 |
| [`src/transport.ts`](src/transport.ts) | 传输工厂：带清洗环境的 stdio spawn、Streamable HTTP |
| [`src/status.ts`](src/status.ts) | 状态面：每实例状态单元与按作用域的查询 |
| [`src/probe.ts`](src/probe.ts) | 一次性探测：连接、取身份、列工具、关闭——不注册任何东西 |
| [`src/deadline.ts`](src/deadline.ts) | 启动与探测预算共用的结算截止器 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件（无运行时不变式；世代只能通过工具注册表观察） |

### 生命周期与同步

`apply` 解析重连策略、在当前注册作用域内预留 `serverName`、启动监督器，并等待初始连接加发现完成。独立 Agent 作用域可以复用相同 namespace，因为其工具与传输彼此隔离；同一作用域内重复会在加载时失败。监督器把所有同步——初始、通知与重连——串行到同一条队列，因此两次同步绝不会交错执行各自的先 dispose 后注册交换。dispose 会取消待执行的重连、关闭活动客户端、等待进行中的尝试与排队同步完全停稳，然后注销当前世代。[自动重连 Agent Note](../../../.agents/notes/implemented/feature/2026-08-06-mcp-client-auto-reconnect.zh.md) 拥有重连决策。

组合实例的管理器（如 `dsh-mcp-manager`）通过 `connectionStatusOf(ctx, serverName)` 观察单个实例：这是对监督器状态单元（`connecting`、`connected`、`reconnecting`、`failed`）的读取加订阅句柄，随 `serverName` 预留一起注册与释放。`probeServer(config)` 回答配置界面的「测试该服务器」，既不预留名字也不触碰 `ctx.tools`。

监督器监听 `notifications/tools/list_changed` 并排队一次重新同步；获取阶段失败时保留上一世代注册，注册冲突则回滚本次尝试的世代。每次中断共享一个尝试预算：连续失败达到 `maxAttempts` 次后工具被注销、重连停止；连接存活超过 `maxDelayMs` 会重置预算。

### 工具执行内部细节

工具调用会发送一次未缓存的 `tools/call` 请求，携带原始 MCP 名称、JSON 参数、中止信号与配置的超时；公开名称绝不会发给服务器，也绝不会被解析还原。规范成功值是 `{ content: JsonValue[], structuredContent? }`，为程序化调用方与 PTC mode 调用方保留完整的 MCP JSON 块。受支持且已声明的 `outputSchema` 会验证 `structuredContent`；不受支持的 schema 词汇回退为不受约束的 `JsonValue`。MCP 的 `isError` 结果会在任何图片持久化之前抛出，使注册表产生失败的工具结果。图片批次会先整体解码并校验，再保存任一成员；任何拒绝都会把每张图片投影为诊断文本。

### 环境清洗（stdio）

子进程环境以子进程 seam 的 `scrubbedParentEnv()` 为基座——删除匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的环境名称与所有 `DSH_*` 名称——再在其上合并配置的 `env`，因此显式覆盖得以保留。实际 spawn 由 MCP SDK 负责；本包共享清洗定义，而非 spawn 路径。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享工具注册表逐步进入桥接的设计证据与可运行的示例配置。

- [工具子系统参考](../../../docs/subsystems/tools.zh.md)——接收已桥接工具的 `ToolRuntime` 与 `ctx.tools.register()` 约定。
- [MCP 客户端插件 Agent Note](../../../.agents/notes/implemented/feature/2026-07-07-mcp-client-plugin.zh.md)——命名不变式、发现与执行设计、备选方案与后果。
- [MCP 客户端自动重连 Agent Note](../../../.agents/notes/implemented/feature/2026-08-06-mcp-client-auto-reconnect.zh.md)——重连策略、尝试预算与退出开关的依据。
- [规范工具输出约定 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-20-canonical-tool-output-contract.zh.md)——MCP 结果如何映射进规范工具输出约定。
- [第三方记忆 MCP 指南](../../../docs/user/guide/mcp-memory.zh.md)——使用本包的三份记忆服务器 overlay。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-mcp-client)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 已发现的 MCP 工具

#### 模型看到什么

初始发现成功后，每个已声明的 MCP 工具都会显示为名为 `mcp__<serverName>__<rawName>`（或其确定性规范化形式）的原生工具，并携带服务器提供的描述与输入 schema。成功的重新同步——包括自动重连后的同步——会替换整个世代；对插件执行 dispose（资源释放）或重连预算耗尽会移除该世代。

#### Token 影响

工具注册期间，工具描述与输入 schema 会进入每次请求；重新同步会替换而非累积 schema，服务器限定名称也会为每个工具定义和调用增加 token。

#### KV Cache 影响

已发现工具集合及其 schema 不变时，工具定义前缀保持稳定。增加、移除、重命名或更改工具的重新同步会替换定义，并可能使从第一个变化的 schema token 起的复用失效；恢复未变列表的重连会生成完全相同的定义，前缀保持稳定。

### 工具调用历史与结果

#### 模型看到什么

公开工具名称和 JSON 参数保留在 assistant 历史中。规范值始终为程序化调用方与 PTC mode 调用方保留完整的 MCP JSON 块与可选结构化内容；受支持的图片块在确切路由能力得到证明后，按原始顺序与文本一起投影。被拒绝的图片、音频、嵌入资源、资源链接与未知块继续以有界文本诊断可见；MCP `isError` 会在图片持久化之前拒绝调用。

#### Token 影响

参数、映射后的文本与持久图片引用保留到压缩（compaction）发生时。内联 MCP base64 只存在于执行局部的规范值中，绝不会复制进会话事件；提供方会从附件存储读取经过校验的字节。音频与嵌入资源载荷不会进入模型上下文。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明你无法用本插件做什么、以及何时需要运维注意。它们是当前包约束，不是与其他 MCP 客户端的对比，也不是任务积压。

- **只桥接 MCP 的工具能力**——Resources 与 Prompts 没有 harness 消费机制，暂缓实现。
- **只有启动尝试受预算约束** —— `startupTimeoutMs` 覆盖每次连接尝试加其初次工具同步；通知驱动的重同步发出的 `tools/list` 请求仍使用 MCP SDK 的 60 秒请求默认值。
- **重连在传输关闭时触发**——崩溃的 stdio 子进程会触发重连；Streamable HTTP 失败按请求经 SDK 传输自身的恢复机制暴露，因此不可达的 HTTP 服务器会按调用重试，而非由 supervisor 重新 spawn。
- **图片是唯一的持久丰富结果桥接**——PNG、JPEG、WebP 与 GIF 在确切能力得到证明后进入 Native 上下文。音频与嵌入资源载荷仍只存在于执行局部并带明确诊断，资源链接只以文本保留名称与 URI。
- **不强制执行不受支持的 MCP 输出 schema**——已声明 schema 使用 harness 子集之外的词汇时，`structuredContent` 回退为 `JsonValue`。
- **要求基于任务的 MCP 工具在调用时被拒绝**——要求使用基于任务的执行（task-based execution）扩展的工具会抛出异常而非被桥接；该扩展未实现。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放设计问题与尚未决定的探索方向。它明确不具权威性——已交付行为、限制与既定理由以上文、包代码与所链接的 Agent Note 为准。

- 公开名称算法是由测试固定的 v1 约定；发布后更改会破坏会话历史与权限规则。
- Streamable HTTP 的重连归属仍未决定：按请求重试是 SDK 行为，supervisor 也可以拥有 HTTP 世代。
- 桥接 MCP Resources 需要 harness 侧的注入决策（系统提示词、按需或模型触发）；桥接 Prompts 需要 harness 缺少的提示词模板概念。
- 固定的 MCP SDK 仍在演化；上游破坏性变更需要更新桥接。

</details>
