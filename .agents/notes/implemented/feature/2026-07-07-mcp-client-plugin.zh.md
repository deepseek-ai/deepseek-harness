# Agent Note: MCP 客户端插件——连接外部 MCP 服务器并桥接其工具

Status: implemented

[English](2026-07-07-mcp-client-plugin.md) | 中文

## 问题

harness 此前无法消费 MCP（Model Context Protocol）生态中的工具。MCP 是工具服务器的新兴标准——GitHub、文件系统、数据库、代码搜索以及数百个社区服务器都通过 MCP 暴露工具。用户希望将 harness 指向一个或多个 MCP 服务器，让其工具以原生的模型可见工具形式出现，而无需为每个服务器编写胶水代码。

`ToolRuntime` 已经接受原始 JSON Schema 工具定义（`dsh-tools` README 中有记录：「Raw JSON-Schema tool definitions (from MCP servers) are still accepted by `ToolRuntime.register()` directly」），扩展实操手册（cookbook）也勾勒了预期模式（「MCP | one plugin per server: discover tools → `ctx.tools.register()`」）。基础设施已就绪，缺的是桥接插件。

## 决策

### 包

单个包 `@deepseek-ai/dsh-mcp-client`，位于 `packages/mcp/mcp-client/`。不做能力 seam 的三包拆分——可预见范围内不会有第二种 MCP 客户端实现，且约定是「不要预防性拆分」（[能力 seam Agent Note](../architecture/2026-06-13-capability-seams.zh.md)）。

### SDK

使用官方 [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)（`Client`、`StdioClientTransport`、`StreamableHTTPClientTransport`）。harness 不自行实现 JSON-RPC，与 ACP 委托给 `@agentclientprotocol/sdk` 的做法一致。

### 范围

仅 MCP Client（不含 server 端——ACP 已承担「将 harness 暴露为 agent」的角色）。仅桥接 **Tools**——Resources 和 Prompts 延后处理（它们需要 harness 侧尚不存在的消费机制，且设计空间较大）。

### 插件形态

命名空间插件（具名导出 `name`/`inject`/`Config`/`apply`，无 `export default`）。`inject: ['tools']`。每个 MCP 服务器对应 `cordis.yml` 中的一个插件实例——同一个包以不同配置加载 N 次，与 `dsh-tool-subagent` 相同。

### 配置

以 `transport` 字段为判别的扁平联合类型：

```typescript
interface StdioConfig {
  transport: 'stdio'
  serverName: string          // required namespace, ^[A-Za-z0-9_-]{1,32}$
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  toolCallTimeoutMs?: number  // default 60_000
}

interface StreamableHttpConfig {
  transport: 'streamable-http'
  serverName: string          // required namespace, ^[A-Za-z0-9_-]{1,32}$
  url: string
  headers?: Record<string, string>
  toolCallTimeoutMs?: number  // default 60_000
}

type Config = StdioConfig | StreamableHttpConfig
```

`serverName` 是稳定的本地标识，用于在模型可见名称（见下文）中为该服务器的工具提供命名空间。它有意设计为用户配置，而非远端的 `serverInfo.name`：远端名称是不可信输入、跨部署不唯一（同一服务器的生产和预发布实例报告相同名称）、且可能在服务器升级时变化——这些都不得静默重命名模型可见工具。多个活跃实例使用重复的 `serverName` 属于配置错误：后加载的实例在启动时以可操作的错误消息失败，绝不静默覆盖或跳过。短 `serverName`（如 `gh`）也是缩短公开名称的配置手段。

`cordis.yml` 用法示例：

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
      Authorization: !!js `Bearer ${process.env.MCP_TOKEN}`
```

模型看到的是 `mcp__github__create_issue`、`mcp__github__search_code`、`mcp__web__search`。

### 生命周期

启动时从 `cordis.yml` 加载。HMR（热模块替换）（`@cordisjs/plugin-hmr`）提供热替换：编辑 yml 条目触发旧实例的 dispose（资源释放）（断开连接、注销工具），并创建新实例（连接、发现、注册）。不提供运行时动态 API。公开名称是 `(serverName, rawName)` 的纯函数，因此保持 `serverName` 不变的 HMR 替换会重建完全相同的模型可见名称——会话历史和权限规则保持有效——而添加或移除不相关的服务器永远不会重命名已有工具。

### 工具发现与注册

每个 MCP 工具有两个名称：

- `rawName`——MCP `Tool.name` 的原始值，仅用于协议通信（`tools/call`）。
- `publicName`——在 `ToolRuntime` 中注册的全局唯一模型可见名称：

      mcp__<serverName>__<rawName>

这种按服务器限定的形式是多服务器 agent 客户端事实上的标准——所有被调研的终端用户产品都按服务器限定 MCP 工具名（[Claude Code](https://code.claude.com/docs/en/agent-sdk/mcp#tool-naming-convention) `mcp__github__list_issues`、[Codex](https://openai.com/index/unrolling-the-codex-agent-loop/) `mcp__weather__get-forecast`、[Gemini CLI](https://geminicli.com/docs/tools/mcp-server/#3-tool-naming-and-namespaces)、[VS Code](https://github.com/microsoft/vscode/blob/ab9ec62c6a61e429a9abd612ff220c3f4834c9ea/src/vs/workbench/contrib/mcp/common/mcpServer.ts#L217-L260)、[Cline](https://github.com/cline/cline/blob/52fdbb1d72f7324a28142a7ba7678d4b53c902f4/sdk/packages/core/src/extensions/mcp/name-transform.ts#L20-L35)、[Roo Code](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/utils/mcp-name.ts#L117-L140)、[Goose](https://github.com/block/goose/blob/b3a012cbdde854b0fe14f95b1c48543bf6517c0a/crates/goose/src/agents/extension_manager.rs#L1391-L1441)、[OpenCode](https://github.com/anomalyco/opencode/blob/d199b1bff90282a4f9cd6251b5fc7b16875a52f6/packages/opencode/src/mcp/catalog.ts#L117-L120)）；`mcp__<server>__<tool>` 的拼写方式与 Claude Code 和 Codex 一致。`mcp__` 前缀将 MCP 注册与原生工具的命名空间隔离，并为权限/遥测规则提供稳定的匹配模式（`mcp__*`、`mcp__github__*`）。

1. 连接时：遍历 `client.listTools()` 的分页结果，推导每个工具的 `publicName`，然后通过 `ctx.tools.register()` 将其注册为原始 `ToolDefinition`。MCP 的 JSON Schema 和描述原样透传（不做 `defineTool` DSL 转换）；仅替换模型可见的 `name`。
2. 监听 `notifications/tools/list_changed` → 重新执行同步（dispose 上一代、注册新一代）。确定性命名意味着未变化的工具在重新同步后保持原名。
3. 执行器闭包持有 `rawName`；公开名称永远不发送给服务器，也永远不被解析以还原原始名称。
4. 无 `presentCall`/`presentResult`——UI 消费方使用提供方无关的通用卡片兜底。
5. 工具在系统提示词中是透明的——除名称本身外不附加「[via MCP]」标注。

### 公开名称规范化

MCP 允许工具名最长 128 字符且可包含 `.`；DeepSeek 的函数名约定允许 `[A-Za-z0-9_-]` 且最多 64 字符。公开名称按确定性规则规范化：非法字符替换为 `_`，当替换或截断改变了名称时，追加 `(serverName, rawName)` 标识的 12 位十六进制 SHA-256 hash，确保不同的 MCP 标识永远不会坍缩为同一个公开名称：

```typescript
function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_')
  if (normalized === joined && normalized.length <= 64) return normalized
  const hash = sha256(`${serverName}\0${rawName}`).slice(0, 12)
  return `${normalized.slice(0, 64 - 13)}_${hash}`
}
```

### 名称冲突处理

MCP 仅保证工具名在[单个服务器内](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#tool-names)唯一；跨服务器冲突是常态而非例外（一项[微软研究院调查](https://www.microsoft.com/en-us/research/blog/tool-space-interference-in-the-mcp-era-designing-for-agent-compatibility-at-scale/#namespacing-issues-and-naming-ambiguity)覆盖 1,470 个服务器，发现 775 个冲突的工具名；仅 `search` 就出现在 32 个服务器中，官方 GitHub 服务器发布的是裸名 `create_issue`）。始终启用的命名空间从结构上杜绝冲突，而非在冲突发生时再处理：

- 两个服务器都发布 `search` → 共存为 `mcp__github__search` 和 `mcp__web__search`。
- 名为 `search` 的原生 harness 工具不受影响。
- 重复的 `serverName` 配置使后加载的实例在启动时失败（见配置一节）。
- 服务器列出重复的工具名属于无效工具列表：同步抛出异常，上一代注册保持不变。
- 替换期间的注册表冲突只可能意味着外部工具占据了该服务器的 `mcp__<serverName>__` 命名空间：部分代注册被回滚（该服务器零工具），并以醒目日志记录错误。

工具永远不会被静默跳过；哪些工具可用永远不取决于插件加载顺序。

### 命名不变式

1. 每个 MCP 工具拥有稳定标识 `(serverName, rawName)`；每个活跃标识恰好对应一个公开名称。
2. 公开名称是确定性的、全局唯一的，且满足 DeepSeek 64 字符 `[A-Za-z0-9_-]` 约定。
3. MCP `tools/call` 始终接收原始的 raw name。
4. 连接、断开或重新同步不相关的服务器永远不会重命名已有工具。
5. 注册顺序永远不决定哪个工具可用。

### 工具执行

为来自同一个 MCP 服务器的所有工具提供统一的 `execute` 处理器：

1. 解析 `rawName`（执行器闭包持有它），以配置的超时时间调用 `client.callTool({ name: rawName, arguments }, { signal: exec.signal })`——公开名称永远不发送给服务器。
2. 把规范成功值保留为 `{ content: JsonValue[], structuredContent? }`；完整 MCP JSON 块仍是程序化调用／PTC mode 值。`isError: true` 会在持久化任何图片前抛出，使失败路径归注册表所有。
3. 另行准备有序 Native 投影。连续文本块以 `'\n'` 连接；资源链接以文本保留名称和 URI；音频、嵌入资源、格式错误的块和未知类型成为明确诊断。只要存在图片，桥接层就严格解码完整批次，解析调用 agent 的最新确切路由，要求附件存储以及模型明确支持图片输入，再把全成员校验和有序持久化委托给 `AttachmentStore.saveImages()`。任何解码、能力或存储拒绝都会把全部图片渲染为诊断文本，且不返回部分引用。
4. 保持 `output.render` 同步且纯净。执行器把更丰富的投影暂存在按同步世代创建、以确切执行为键的 `WeakMap` 中；只有注册表的 post-execute 结果仍保留原规范值和兜底内容时，`finalizeContent` 才安装该投影。策略阻止、值替换或内容替换仍具有权威性，重新同步也无法让旧世代消费新执行状态。
5. PTC mode 接收未改动的规范值。其通用分发桥接层会把包含图片的成功最终内容序列经外层 `run_code` 结果延后，因此 MCP 无需私有父 token 特例。
6. 取消：`exec.signal`（来自 agent loop 的取消）透传给 MCP SDK 的 `callTool`、确切模型查询和存储前门禁。

### 子进程环境（stdio 传输）

以子进程服务边界共享的 `scrubbedParentEnv()` 为基础构建子进程环境；该基础环境会移除环境中匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的名称以及 `DSH_*` 名称，然后在其上合并 `config.env`。显式配置的 env 覆盖在清洗后仍会保留。

### 断连 / 崩溃

每个实例的连接监督器在连接丢失后以有界指数退避和单次故障尝试预算自动重连，成功后重新执行发现流程；尝试耗尽则注销该服务器的工具并停止，直到重新加载。[自动重连 Agent Note](../../archived/feature/2026-08-06-mcp-client-auto-reconnect.md) 拥有该决策，包括 `reconnect` 配置块和恢复手动 HMR/重启恢复的 `reconnect.enabled: false` opt-out。

## 曾考虑的替代方案

### MCP Server 端（将 harness 工具暴露给外部 MCP 客户端）

延后。ACP 桥接已将 harness 暴露为 agent 服务器。再加一层 MCP server 会以不同协议重复这一功能，而用户的首要需求是消费外部工具，而非暴露自身工具。

### 能力 seam 三包拆分（接口 / 实现 / 消费方）

否决。可预见范围内不会有替代的 MCP 客户端实现——MCP 只有一个协议、一个 SDK。约定是「不要预防性拆分」，直到出现第二种实现。

### 指数退避自动重连

单次连接设计否决了该方案：它会引入部分可用状态（工具已注册但暂时不可用），且 stdio 崩溃往往表明配置问题，重试无法修复；HMR 曾是恢复路径。运营反馈扭转了该延期决定——[自动重连 Agent Note](../../archived/feature/2026-08-06-mcp-client-auto-reconnect.md)以有界的单次故障预算和 opt-out 实现了自动重连。

### 桥接 Resources 和 Prompts

延后。Resources 需要 harness 侧的机制来决定何时注入内容（系统提示词？按需？模型触发？）。Prompts 需要 harness 尚不具备的「提示词模板」概念。两者都需要独立设计；Tools 是高价值、低风险的起点。

### 原始模型可见工具名加可选 `toolPrefix`

否决。这是最初的提案，基于「大多数 MCP 服务器已在工具名中使用语义前缀（如 `github_create_issue`）」这一前提。该前提不成立：官方 GitHub 服务器发布的是 `create_issue`，参考文件系统服务器发布 `read_file`，Sentry 发布 `search_issues`——且上述微软调查表明冲突在生态规模下很常见。冲突时再加前缀（或 warn-and-skip）还会使可用工具集取决于插件加载顺序，且添加不相关服务器时工具可能被静默重命名——在对话中途使会话历史和权限规则失效。所有被调研的多服务器 agent 产品都不使用裸名。

### 仅服务器命名空间（`github__create_issue`，无 `mcp__` 前缀）

不予采纳。它能防止跨服务器冲突，但无法将 MCP 注册与原生 harness 工具分离，也丧失了 MCP 全局策略匹配模式（`mcp__*`）。前缀仅多花 5 个字符；`mcp__<server>__<tool>` 拼写与 Claude Code 和 Codex 一致，最大化模型的熟悉度。如果 ToolRuntime 未来引入源感知命名空间，届时可作为命名策略变更重新考虑去掉字面前缀。

### 从服务器公告的 `serverInfo.name` 派生命名空间

否决。远端名称不可信、跨部署不唯一、升级时可变；工具标识和权限规则不得静默跟随它。命名空间是本地配置。

### 在工具结果中保留多个 TextBlock

否决。DeepSeek 序列化器中的 `flattenText()` 在将 `ContentBlock[]` 扁平化为协议格式（wire format）时使用 `join('')`（无分隔符）。多个 text 块会静默丢失块间边界——这是正确性缺陷。所有现有工具返回单个 TextBlock；MCP 桥接遵循同一做法。

### 用核心 `ContentBlock[]` 替换规范 MCP 结果

不予采用。程序化调用方需要协议完整的 MCP 块和 `structuredContent`，Native 消费方则需要持久核心图片而不是 base64。一份规范协议值加一份独立投影可以同时保留两项契约。

### 添加通用 RichContent 服务，或在 `output.render` 中执行 I/O

不予采用。核心已经拥有角色无关的内容词汇，第二套服务会重复其日志与顺序契约。`output.render` 必须纯净、同步且可回放，因此附件 I/O 属于异步执行，再经确切的最终化交接安装结果。

### 让每个返回图片的工具分别特殊处理 PTC mode 父调用

不予采用。这会把叶子工具与组合工具内部机制耦合，并漏掉未来丰富工具。通用 PTC mode 桥接层观察最终 post-policy 内容，统一转发含图片结果。

## 测试

覆盖范围按层级列出；每项行为都放在能够表达它的最低成本层级。

- **单元测试**（`tests/mcp-client.spec.ts`、`tests/apply.spec.ts`，mock MCP SDK）：`publicToolName` 算法（干净名称、规范化、截断加 hash、确定性、不同标识的分离）、raw 与 public 的协议纪律、跨服务器与原生工具共存、重复 `serverName` 加载失败与预留释放、无效工具列表拒绝、注册代切换/回滚、重新同步失败时保留上一代注册、无损规范结果、丰富内容混合顺序、格式错误批次原子性、确切能力／存储拒绝、明确的非图片诊断、post-execute 策略优先级、取消，以及配置 schema 校验。100% 逐文件覆盖率门禁约束该包。
- **E2E**（`tests/mcp-client.e2e.ts`，无需密钥）：使用真实 MCP 协议对接仓库内的 fixture（测试前置数据）服务器、`@modelcontextprotocol/server-everything` 和 `@modelcontextprotocol/server-filesystem`（stdio 传输），以及进程内 `StreamableHTTPServerTransport` 服务器（Streamable HTTP 传输）——命名空间下的发现、带点号名称的端到端规范化、执行往返、持久图片保存／读取且 base64 只保留在规范值中、缺少图片路由时明确拒绝、重复 `serverName` 拒绝，以及 dispose。
- **快照**：组装后的 ACP 示例负责传输可见的内联图片 transcript 与 PTC mode 图片转发 transcript；包 E2E 负责真实 MCP 协议，因为可运行快照必须保持无密钥且确定，而不是 spawn 第三方服务器包。MCP 工具卡片仍使用通用卡片兜底，无需包专属 UI 快照。

## 后果

- 每个 MCP 服务器只需 `cordis.yml` 中的一条配置即完成集成：`serverName: filesystem` 加一条 stdio 命令（或一个 Streamable HTTP URL），就能将 `mcp__filesystem__read_file` 放入模型的工具列表，可调用，协议上使用原始的 `read_file`。
- 公开名称是会话历史和权限／配置 API 的一部分；测试固定了命名算法，发布后变更即为破坏性变更。
- `mcp__<serverName>__` 限定符在每个名称上消耗 token。已接受：描述和 JSON Schema 在工具定义 token 中占主导，而限定符换来了稳定标识、冲突隔离和 MCP 全局策略匹配模式（`mcp__*`、`mcp__github__*`）。
- **MCP SDK 稳定性**：`@modelcontextprotocol/sdk` 仍在演进中；破坏性变更需要更新桥接。版本已固定，且该 SDK 被广泛采用（Claude Desktop、Cursor、VS Code），因此破坏性变更不太可能悄然发生。
- **工具 schema 质量**：MCP 服务器可能暴露描述不佳的工具（模糊的描述、不完整的 JSON Schema）。harness 原样透传——垃圾进垃圾出；这是服务器作者的责任，不是桥接的。
- **Stdio 进程管理**：行为异常的 MCP 服务器如果忽略信号，可能卡住 dispose。Cordis fiber 的 dispose 具有有界的完全停稳过程；卡住的传输层最终会在框架层面超时。
- 崩溃恢复在[重连预算](../../archived/feature/2026-08-06-mcp-client-auto-reconnect.md)内自动进行；耗尽后或配置 `reconnect.enabled: false` 时回退为手动重新加载。
- 图片载荷只有通过共享持久附件存储和确切正向路由能力，才能进入模型上下文。音频与嵌入资源载荷仍只存在于执行局部，并附带明确诊断。
