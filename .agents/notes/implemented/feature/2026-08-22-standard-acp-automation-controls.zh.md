# Agent Note：标准 ACP v1 自动化控制

状态：已实现

[English](2026-08-22-standard-acp-automation-controls.md) | 中文

> 本说明仅取代 [ACP 作为纯自动化协议](../simplification/2026-07-23-acp-automation-only-protocol.zh.md) 中仅支持提示词的协议清单。该决策关于禁止 ACP 成为第二套产品 UI 的规定仍具权威性。

## 问题

纯自动化 ACP 桥接层可以创建新会话、一次提交一个提示词、取消提示词、接收已提交 assistant 消息，并回答一次性权限请求。通用外部自动化控制器仍需依赖私有进程知识，才能发现模型、挂载 MCP 服务器、在重启后找到持久会话、恢复会话、独立关闭一个会话，以及观察 reasoning、工具或上下文压力进度。如果在集成专用 runtime 中复制这些控制，ACP 只会名义上可互操作，而 DSH 自动化仍依赖私有旁路协议。

稳定 ACP v1 协议已经定义所需的控制词汇。增加私有 `_meta`、自定义方法、用例专用环境处理或展示投影会割裂该词汇，并重新引入纯自动化决策已经移除的 UI 耦合。

## 决策

`@deepseek-ai/dsh-acp` 实现通用控制器需要的完整标准 ACP v1 自动化子集：`session/new`、`session/list`、`session/resume`、`session/close`、`session/prompt`、`session/cancel`、`session/set_config_option`、JSON-RPC `$/cancel_request`、`session/update` 和 `session/request_permission`。仓库内每条连接的两端都使用 `@agentclientprotocol/sdk` 1.4 的 app／context 接口。

能力会省略未支持的方法和功能。DSH 不增加自定义方法、能力标记或 `_meta`，也不为客户端元数据赋予私有含义。`session/load`、`session/delete`、`session/fork`、附加目录、SSE 和 ACP 传输 MCP、模式、命令、计划、终端、客户端文件系统操作和 elicitation 仍不受支持。会话控制和语义更新是自动化协议数据；它们不会使 ACP 成为人工 UI。

## Per-session 所有权

每个已公布 Agent 由一个 `AcpSession` 模块拥有，该模块同时拥有所选模型状态、请求 MCP 挂载、单提示词槽位、有序更新链和记忆化关闭操作。全局事件监听器只识别确切 Agent 或 Session，再委托给该模块。模块会在内存中把准入快照与已识别消息关联到 inbox claim 时刻，再将其固定到已准入轮次。因此，图片能力检查、提示词变量、请求 header 和每个模型步骤都使用同一个提供方／模型／reasoning tuple，而普通持久用户 source 保持不变。并发配置变更从下一个 ACP 轮次开始生效。

显式 `session/close`、连接丢失和插件释放调用同一个关闭操作。它会先取消准入和 Agent 工作，再等待；随后 drain 已提交更新和可继续后代、flush 持久化，并释放 Agent scope 及其 MCP 客户端。关闭流程会保留事件路由直到 drain 完成。只有所有自有会话 teardown 都完成后才报告失败，其他前端的 Agent 和后代不受影响。

## 持久会话控制

完整 ACP 生命周期支持要求挂载会话持久化。`session/list` 读取已实体化的顶层 header，排除活动会话和后代会话，按规范物理 `cwd` 过滤，按创建时间和 id 排序，并通过不透明 keyset cursor 返回有界页面。摘要有意省略标题和展示元数据。

`session/new` 会显式要求持久化在不虚构会话事件的情况下实体化 live session header，因此即使空会话也可以关闭、列出和恢复。其他前端仍保留持久化 seam 的惰性默认行为，不会实体化被放弃的空会话。`session/resume` 拒绝活动 id，以及非顶层或未知的持久 id；在组合 Agent 前校验请求的规范 `cwd`；恢复持久日志但不向客户端重放；挂载该请求提供的 MCP 声明。`session/close` 让持久日志可供后续进程使用。

持久化有意把 `create(meta)` 视为 live registration：交付的 JSONL provider 在首次追加事件前不创建 artifact。该默认行为会移除被放弃的空会话，但 ACP 不能继承它，因为 `session/new` 会在任何提示词出现前公布会话身份，而进程可能在返回成功响应后、收到 `session/close` 前停止。桥接层只在 Agent 和 MCP 组合成功后、返回 `session/new` 前执行实体化；组合失败仍不留下残留物，每个已返回 id 则都能在重启后继续存在。

bridge 经由普通的持久性屏障实体化：`ctx.sessions.flush(session)` 抵达该会话的写句柄，其 `flush` 在尚无任何追加时写入仅 header 实体化。JSONL 写入一个 header frame；仓库外 provider 必须原子实体化等价 header 状态，否则拒绝该操作。重复调用幂等。让 `create` 全面 eager 会改变所有前端放弃会话的行为；追加 synthetic event 会仅为触发存储而虚构 sequence 与 replay 事实；等到关闭时再写入则会让持久性与进程丢失竞争。

## 标准配置选项

建议性 LLM catalog 现在服务于另一个自动化 consumer，但不会成为请求校验。ACP 公开按提供方分组的 `model` select，其不透明值保留提供方／模型对；还会公开来自已解析确切模型的依赖 `reasoning_effort` select。具有 efforts 但没有 adapter 配置默认值的模型会包含 `Provider default`，以保留省略状态并让提供方自行选择。新建、恢复和设置响应都返回完整状态。Adapter 拓扑事件发出 `config_option_update`；每个会话按接收顺序串行处理变更。配置的 ACP 提供方／模型仍是初始选择；未列出的配置路由会合成到返回选项中，而不会被拒绝。

## 标准 MCP 映射

`session/new` 和 `session/resume` 接受标准 stdio 和 Streamable HTTP MCP 声明。Stdio 使用会话 `cwd`；HTTP 使用已声明 URL 和 header；两者都保留 `dsh-mcp-client` 的超时和重连默认值。名称、命令、URL、环境项、header 和重复的规范化 namespace 都会在 Agent 公布前校验。初始连接或发现失败会回滚尚未公布的 Agent。

MCP namespace reservation 跟随最近的 DSH registration scope，而不是进程 root。独立 Agent scope 可以使用同一服务器名，同一 Agent 内的重复名称仍会失败。Scoped disposal 会释放工具、传输和 reservation。

ACP 客户端是受信任的控制器：stdio 声明授权执行进程，HTTP 声明授权携带其 header 发起请求。DSH 不增加每服务器私有 cwd 或超时字段。工具挂载后，普通 DSH 工具策略仍然约束调用。

## 语义更新投影

只有已提交的持久事实会进入 `session/update`。Assistant 文本／图片变成 `agent_message_chunk`；reasoning 变成 `agent_thought_chunk`；工具调用／结果变成通用 `tool_call` 和 `tool_call_update`；已知的测量上下文压力与容量变成 `usage_update`；adapter 拓扑变化变成 `config_option_update`。持久消息 id 和工具调用 id 保留关联。规范 DSH 工具名作为标准工具调用 title。

Per-session 链会串行处理所有更新，并在提示词完成前 drain。引用工具调用的权限请求只会在该工具调用通知 drain 后发送。原始模型 delta、重试尝试、卡片、终端状态、diff、位置、计划、标题、todo 和不受支持内容不会进入 wire。

`session/cancel` 和 `$/cancel_request` 进入同一个提示词自有取消路径。关联结尾只映射到标准 stop reason 和 JSON-RPC error；模型输出达到上限时报告 `max_tokens`。ACP 不返回额外 DSH 结果结构。

## 考虑过的替代方案

**增加私有控制器扩展。** 已拒绝，因为标准 ACP v1 已经承载所需生命周期、配置、MCP、取消、权限和语义更新概念。私有扩展会使通用 SDK 客户端不完整。

**恢复之前的编辑器投影。** 已拒绝，因为计划、终端、diff、卡片、导航和人工 elicitation 属于展示职责。语义工具和 reasoning 事实可以作为有用的自动化遥测，而无需导入展示模块。

**实现所有 ACP 会话方法。** 已拒绝。列出、恢复和关闭已经完成持久自动化生命周期。加载／重放、删除和 fork 会引入本用例不需要的独立 transcript、破坏性存储和 lineage 语义。

**使用不稳定 provider 方法发现模型。** 已拒绝，因为标准会话配置选项可以表达该选择，并保持会话 scope。

**把每个 DSH runtime 字段复制到 ACP 元数据。** 已拒绝，因为精确 token 明细、私有结果状态、程序化展示名称和每 MCP tunable 没有稳定 ACP v1 对应项。

## 验证

聚焦测试覆盖：无私有元数据的确切能力公布；模型／reasoning 选择、无效和并发变更、拓扑更新以及图片路由固定；stdio／HTTP MCP 设置、声明回滚、scope 隔离、恢复和释放；列表分页、规范 workspace 校验、活动冲突、关闭／恢复和重启恢复；消息／思考／工具／用量顺序与 id；工具先于权限；标准 stop reason；请求和会话取消；连接丢失 teardown。

通用 keyless conformance 测试会启动真实 ACP demo 两次，并且只使用公开 ACP SDK：选择模型和 reasoning effort、挂载 MCP 服务器、执行工具轮次、观察标准更新、关闭、重启、列出、恢复和取消。它不包含集成专用名称、依赖、元数据或环境行为。

## 后果

外部自动化项目可以通过稳定 ACP v1 使用 DSH，而无需维护 DSH 专用 runtime 协议。桥接层的控制接口变大，但仍小于 UI：它拥有生命周期和语义互操作，而人工展示和交互仍属于产品客户端。

持久生命周期和请求 MCP 挂载让会话创建更严格。配置错误和初始 MCP 失败会在公布前拒绝，关闭会等待真实完全停稳和持久化。这是避免部分 Agent、泄漏工具或孤儿进程所需的所有权证明。
