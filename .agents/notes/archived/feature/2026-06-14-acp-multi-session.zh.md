# Agent Note: 在单个连接上多路复用并发 ACP 会话

Status: implemented
Archived: 2026-09-04

[English](2026-06-14-acp-multi-session.md) | 中文

> 本 Agent Note 写于 ACP 还是编辑器桥接层的时期，动机来自 Zed 的多会话客户端模型。[ACP 作为仅面向自动化的协议](../simplification/2026-07-23-acp-automation-only-protocol.zh.md)移除了编辑器接口；多路复用决策本身不变，本 Agent Note 现依照自动化约定陈述它。

## 问题

一个 ACP（Agent Client Protocol）自动化客户端可以在同一个 agent（智能体）子进程上保持多个对话。如果桥接层只支持单活跃会话，就不得不启动额外进程，也会阻止一个父控制器通过一条连接驱动多个独立子任务。多路复用引入了隔离风险：已提交的回答、提示词完成、取消、权限请求以及可预测的后台 job id 绝不能跨越会话边界。

## 决策

ACP 桥接层将活跃会话存储在 `Map<SessionId, AcpSession>` 中。agent 作用域的回调使用 `ownedRecord`：在正向 map 中查找 `agent.session.id`，且仅当该模块拥有精确的 agent 对象时才接纳它，使外部的同 id 对象无法冒领会话。模块拥有 Agent handle、MCP 挂载、模型选择、有序更新、记忆化关闭，以及可选的进行中提示词和最终结算它的持久轮次号。会话 header 拥有其 cwd；桥接层不保留平行的工作区或客户端能力状态。

每个 `session/event` 回调在发送或结算任何内容之前，先解析出所属记录。每个会话独立允许一个进行中的提示词。提示词捕获自己源自用户消息的 `turn/start`，并仅在匹配的 `turn/end` 到达时结算；注入轮次、插件或 goal 的自主轮次，以及来自已取消的前一轮次的迟到 end 都不能 resolve 它。`session/cancel` 定位到一条记录，只调用该 agent 的队列感知取消路径。

权限归属使用对正向 map 的同一精确 agent 检查。ACP `approval/request` 应答器只为拥有发起请求的 agent 的会话发送一次性机器策略请求，并将外部请求或不带 call id 的请求委托出去。桥接层没有表单引导、配置选择或其他人机交互状态。

后台 bash 任务携带一个不透明的 owner token，其值等于所属会话 id。`job_output` 和 `job_kill` 在读取或终止之前，将调用方的 token 与执行器的任务归属进行比较；仅凭可预测的 job id 不能获得访问权。归属信息与执行器任务一起存储，因此工具插件重载不会擦除它。

逐会话关闭、连接拆除和插件释放共享每个 `AcpSession` 的记忆化关闭。桥接层在事件和更新 drain 期间保留活跃 map，把每个待处理提示词结算为已取消，drain 可继续后代，在会话仍挂载时 flush，并行释放 Agent scope。确切记录只在关闭操作结算后离开 map。

## 协议与工作区作用域

[ACP v1 明确允许一个连接上存在多个并发会话](https://github.com/agentclientprotocol/agent-client-protocol/blob/01beb5fb5eec60e9f516a80d85eb03594bac61e3/docs/get-started/architecture.mdx#L16-L24)，每个新会话都携带自己的主 `cwd`。本桥实现该会话级多路复用，其中包括[按会话 cwd 决策](../architecture/2026-07-02-fs-per-session-cwd.zh.md)所记录的不同主工作区；它不会为每个会话创建一个 agent 子进程。

一个会话内部的多根项目是另一项可选能力：ACP 把[有效根目录定义为主 `cwd` 加 `additionalDirectories`](https://github.com/agentclientprotocol/agent-client-protocol/blob/01beb5fb5eec60e9f516a80d85eb03594bac61e3/docs/protocol/v1/session-setup.mdx#L313-L367)。自动化桥接层不公布任何多根能力，并拒绝非空的 `additionalDirectories`；如[包约定](../../../../packages/acp/acp/README.zh.md#standard-acp-v1-surface)所记录，每个会话恰好有一个工作区。

[标准传输是每个 stdio 连接一个 agent 子进程](https://github.com/agentclientprotocol/agent-client-protocol/blob/01beb5fb5eec60e9f516a80d85eb03594bac61e3/docs/protocol/v1/transports.mdx#L17-L42)；多个连接因此需要多个子进程或自定义传输，而本决策保证的是一个连接内部存在多个会话。在该连接内，`ctx.sandboxPolicy` 把每个会话的 `cwd` 解析为其自己的 `workspace-write` 根目录，因此共享的 bash 和文件系统服务可以服务并发项目而不授予跨项目写入。这不会添加 ACP `additionalDirectories`；它只是从已经支持的「每会话一个主根目录」路径中移除了进程级根目录限制。

## 曾考虑的替代方案

**每连接单活跃会话**：否决。增加进程开销，并阻止程序化的父控制器多路复用可独立取消的工作。

**每会话 `ctx.extend()`**：否决。子上下文本身不会创建子插件 fiber，因此监听器仍属于桥接层 fiber。实际实现的桥接层使用全局监听器加显式 O(1) 解复用，以及每会话拥有的记录；agent 生命周期由 `AgentHandle` 管理。

**以 agent 对象标识作为 bash 任务归属**：否决。恢复或替换后的 agent 对象可能合法地代表同一个持久会话。不透明的会话 token 才是跨边界的标识，应当在插件重载后仍然存活。

## 后果

N 个会话可以并发地返回已提交的回答、提交提示词、请求权限和运行后台任务，而不会交错或跨会话结算。一个会话中的取消不影响相邻会话。桥接层为此付出了显式 map 和隔离测试的代价，但它不会为每个会话添加一组监听器，从而避免了长连接期间的监听器扇出。

标准 `session/close` 会独立停稳一个活跃会话，并保留其可恢复持久状态。`session/list` 省略活动记录，`session/resume` 拒绝仍存活的 id，因此自动化客户端不能为同一持久会话创建两个 Agent 对象。

## 验证

多会话测试套件通过按路由投递的已提交回答、独立的进行中提示词、定向取消以及共享拆除来驱动并发会话；审批与输出边界套件覆盖权限路由和对非同一 agent 对象的拒绝。工具 bash 测试证明一个会话无法读取或终止另一个会话的后台任务。
