# Agent Note: headless 是直接使用核心服务的入口

Status: implemented
Archived: 2026-09-04

[English](2026-08-09-headless-direct-core-entry-point.md) | 中文

## 问题

`headless` 的产品约定是一个本地任务：最终 assistant 文本写入 stdout，退出状态反映成功与否，不打开监听端口，并由 [headless 推理进度](../feature/2026-08-21-headless-reasoning-progress.zh.md)负责 stderr 推理投影。包含 Workspace Host 服务、浏览器 RPC、HTTP、Web 运行时或浏览器插件的组合违背这一约定，也使本地完成状态依赖无关的传输树。

直接入口仍需要与 Web 所创建 Agent 相同的部署模型状态。独立的提供方／模型默认值会让同一部署产生两种答案，而在 Agent 与会话持久化完全停稳之前推导完成状态，会让 stdout 与退出状态观察到不完整状态。

## 决策

随附的 `headless` profile 包含 `dsh-base` 与 `dsh-headless`。base 提供默认禁用模块 HMR（热模块替换）的策略；headless 组合包提供自身的 persona 与工具模式、显式挂载 PTC mode worker，并在不覆盖该策略的情况下插入 `headless-runner`。其插件树不包含浏览器 Connection、HTTP server、Web 运行时或浏览器客户端。PTC mode 与会话持久化均为独立于 Web 呈现的一次性 Agent 能力。

`headless-runner` 是直接使用核心服务的入口。Loader 完全加载后，它读取 `ctx.agentDefaultModel.currentSelection()`，通过 `ctx.agents.create` 创建一个新的持久化 Agent，在 Agent 作用域中安装该 `ModelSelection`，等待启动工作完全停稳，锚定会话事件序号，提交一条普通用户消息，再次等待完全停稳。随后，它等待 `ctx.sessions.flush`，折叠自身持有的持久事件区间，以取得最后一条非空 assistant 文本和最终 `turn/end` 结束原因，将文本连同一个换行写入 stdout，并且仅在结束原因为 `completed` 时请求启动器以退出状态 0 有界关闭。[Headless 推理进度](../feature/2026-08-21-headless-reasoning-progress.zh.md)负责实时 stderr 投影；结束原因为 `error` 时，其持久化错误码与消息写入 stderr，驱动器的意外失败也写入 stderr 并以 1 退出。

`@deepseek-ai/dsh-agent-default-model` 拥有与传输无关的默认值，供没有会话级选择的 Agent 使用。`AgentDefaultModelConfig` 提供 `ctx.agentDefaultModel` 并注册 `agent-default-model` Settings 分节。组合配置提供 `{provider, model}`，用户设置还可以提供 `reasoningEffort`。`currentSelection()` 返回当前的完整选择，`saveSelection()` 则写入完整分节，因此不含强度的选择会清除已存强度。`dsh-base` 提供组合条目。直接创建与 Session Controller Remote 调用均消费该服务；Session Controller 负责会话级优先级、模型校验与已接受 Web 选择的持久化。

`loadProfile` 识别安装过程拥有的精确 headless 元组（`dsh-base`、`dsh-web-app`、`dsh-headless`），将其规范化为随附的 headless 模板，并保留 manifest（元数据清单）的其他所有字段。带额外项、缺少项或顺序不同的组合包列表归用户所有，保持不变。

本 Agent Note 负责 headless 的传输与完成约定；[headless 推理进度](../feature/2026-08-21-headless-reasoning-progress.zh.md)负责成功运行时的 stderr 输出。[应用持有自己的命令行](2026-08-06-app-owned-command-line.zh.md)负责当前的 `dsh --profile headless` 语法；原 [`dsh run` 决策](../../archived/feature/2026-08-08-dsh-run-headless-command.md)记录已被取代的启动器持有语法，[Web 配置树启动与传输分层](2026-07-24-web-config-tree-boot-and-transport-layering.zh.md)负责 Web 插件树，[默认模型跟随选择器](../feature/2026-08-07-default-model-follows-the-picker.zh.md)负责共享 Agent 默认值的持久化。

## 验证

包测试围绕脚本化 Agent 工厂使用真实的会话存储与 Agent 注册表，固定空闲态到空闲态的聚合、延迟异步完成、终止态模型诊断、其他未完成退出、直接失败、Loader 加载期间的 dispose（资源释放），以及退出前 flush 的顺序。组装后的无密钥快照通过回放的工具往返驱动 `dsh --profile headless`，记录一条带 `source.kind: 'user'` 的 `user/message`，并在 stderr 暴露推理进度与终止态模型失败。构建后二进制验收通过已发布入口访问 mock DeepSeek 端点，并要求推理流出现在 stderr、最终文本出现在 stdout 且退出状态为 0。配置转储验收排除随附 headless 树中的所有 Host、Web 与 Client 包；PTY 关闭覆盖要求不出现观察行，并在有界时间内完成 dispose。

## 考虑过的替代方案

| 替代方案 | 约定不匹配之处 |
|---|---|
| 保留 `dsh-web-app`，但隐藏观察行 | 进程仍会打开端口并携带 Host、Web 与浏览器插件树。 |
| 围绕浏览器 RPC 构建纯 Host 一次性组合包 | 本地一次性入口没有客户端边界。 |
| 使用进程内 Connection carrier 实现产品级协议覆盖 | 产品执行会仅为测试无关协议而依赖该协议。 |
| 为 headless 单独提供提供方／模型配置 | 直接创建与 Web 创建会拥有彼此独立的默认值和持久化。 |
| 省略 PTC mode 与会话持久化 | 两项能力都属于一次性 Agent 执行，而不是 Web 呈现。 |
| 规范化所有包含 Web 与 headless 组合包的元组 | 组合包列表是扩展面；只有精确的安装过程所属元组可以安全分类。 |

## 后果

`dsh --profile headless` 提供本地 Agent 任务，而不是浏览器观察、Host API 或 HTTP。需要这些能力的用户选择 `dsh web`。没有推理内容的成功运行会保持 stderr 为空，有推理内容的运行则在那里流式输出提供方报告的内容；完成结果在持久化 flush 后推导，持久化会话仍可供后续工具使用。初始用户消息记录 `source.kind: 'user'`，因此不携带浏览器 request id。

Connection carrier 覆盖保留在 Connection 包中。自定义一次性 profile 可以显式包含 Host 或 Web 组合包；随附 profile 与可识别的安装过程所属元组均不含 Web。
