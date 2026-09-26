# Agent Note: 工具调用按 callId 管理准备、派发与结果

Status: implemented

[English](2026-09-22-tool-call-three-phases.md) | 中文

## 问题

模型生成工具参数时，工具名和调用 ID 往往已经可用，但 `tool/call` 要等整条 Assistant 流结束后才到达。一次响应包含多个调用时，前一个调用即使已经生成完整参数，仍要等待后续调用。文件正文也属于 `write` 参数，这段等待可能持续数秒。

只从 `tool/call` 创建工具节点，会把这段时间表现为没有工具活动；把准备中的调用放在 Assistant 片段里，又需要 Group 在 Assistant 与正式 Tool 节点之间切换引用。准备态和正式调用属于同一个工具生命周期，不应由两个节点配合表达。

## 决策

### 同一个 Tool 拥有三个阶段

[Tool Definition](../../../../packages/client/ui-chat/src/client/conversation-nodes/tool.ts) 按 callId 聚合调用，向工具组件提供明确的阶段数据。

| 阶段 | 创建或更新依据 | 可用数据与展示 |
|---|---|---|
| `preparing` | 带调用 ID 和工具名的实时 delta | 调用身份、名称和时间；不提供完整参数，只显示不可展开的一行。可选钩子可读取原始参数前缀。 |
| `start` | `tool/call` | 完整参数；启用工具原有的调用展示。 |
| `result` | `tool/result` | 调用结果，以及当前窗口内可配对的完整参数。 |

参数块结束不触发派发阶段。展示准备态不改变模型请求、工具派发时机、Session 事件或持久化格式，也不把空参数字符串伪装成正式调用。

### start 表示可创建入口

沿用 [Conversation Definition](../../../../packages/client/ui-conversation/src/client/contract/conversation.ts) 的 `match/start/update` 接口和既有角色。持久事件与瞬态 delta 都可以匹配为 start；当前事件序列中最早的 start 初始化 State，后续 Match，包括同 ID 的其他 start，都交给 update。

Tool 的具名 delta 和 `tool/call` 都是创建入口。实时先收到 delta，就从 preparing 创建；历史先收到 `tool/call`，就从 start 创建。匹配函数仍然只读取当前事件，不查询 Context，不增加角色、注册表或旁路缓存。

成功流结束时发布最终 Assistant 消息，瞬态 delta 保留到 `step/end`。每个 `tool/call` 更新已有 callId；Assistant 的实时排序锚点也保留到同一次清理。失败、中断或废弃的流立即移除 delta。清理时，Assembler 从剩余 Match 重新选择 start 并重算 State；未派发的准备节点隐藏，不合成执行结果。

### 最终状态收敛，不重现准备过程

历史分页不把已结束 Assistant 消息展开为实时 delta。重连只恢复仍在生成的活跃流。实时展示可以经历 preparing → start → result，历史回放可以直接经历 start → result；相同持久事件得到相同最终状态即可，不要求中间过程或准备态分组身份一致。

Group 从准备阶段起就聚合 Tool 节点，按工具名分类和计数。AssistantNodeView 不查找工具块，Group 不编码工具 groupPart，也不接替工具生命周期。分组仍遵循[节点输入的分组决策](2026-09-21-conversation-build-groups.zh.md)，Builder 不解释准备态业务。

### 通用行复用现有外壳

[ToolRow](../../../../packages/client/ui-tool/src/client/tool/components/ToolRow.tsx) 在三个阶段复用既有图标、标题和行组件。公共行模型选择工具标题，并组合通用工具名前缀与已有参数摘要。准备阶段没有完整参数或结果，共享参数解析入口直接返回 null，不解析 JSON。既有 slot 钩子绑定可选地提供当前调用的原始前缀，不增加准备态注册机制；ToolRow 禁止准备行展开。

read、read_image、write/edit、search、web、todo、question、details 和通用回退使用这条路径。Bash、Skill、Present、Cordis 等自定义外壳保留自己的准备态分支。不增加自动／自管注册声明，不在 ToolTree 维护另一份工具分类名单。

### 与已有记录的关系

本记录替代[业务节点组装](2026-08-09-client-conversation-node-assembly.zh.md)中“start 只能是持久事件，同一 Context 只能收到一次 start”的限制。该记录的稳定 ID、业务 Definition、Context、Location、前序依赖和目标 Builder 职责继续适用。

## 考虑过的替代方案

**只在 `tool/call` 创建节点。** 无法展示参数生成期间已经确定的工具身份，多调用响应仍有明显空等。

**通过 Assistant 片段和 Group 转接。** 工具需要两种展示来源、额外去重和身份衔接；生命周期归属分散，渲染器还要根据片段标识反查 Assistant 内容。

**保存或回放 preparing。** 准备态只描述当前生成过程，持久调用和结果已经足以重建最终展示；恢复相同中间过程会增加不必要的状态和事件解释。

**新增准备态注册机制。** 通用工具已经共享 ToolRow 和参数模型，已有图标与标题可以直接复用。仅为这一阶段增加声明或配置，会多维护一套工具展示信息。

## 影响

- 工具可以在参数完整前出现，但准备展示不表示工具已经执行，也不暴露依赖参数的交互。
- 同一 ID 的多个 start 被视为同一个生命周期；业务必须为独立调用提供不同 ID，不能再依赖第二个 start 报错检测身份复用。
- 各阶段复用通用行基础组件。write/edit 分离准备态与派发后组件，只有前者订阅原始参数；自定义外壳也可按阶段切换内部组件。
- 不提供部分 JSON 解析或 `useToolCallDelta`。`useToolCallArgumentsPartial` 暴露既有 Step 的原始前缀，不另建累积器；write/edit 只使用其长度展示准备进度。
- 组装测试分别覆盖实时准备态、撤回、活跃流重建、持久历史与分页收敛；组件测试检查无参数展示和阶段切换，录制会话覆盖浏览器中的准备态与重载结果。
