# Agent Note: 统一 subagent activation

Status: implemented

[English](2026-09-17-unified-subagent-activations.md) | 中文

## 问题

本地一次性执行与可继续驻留分别拥有子级创建、取消、结构化捕获、结果和清理。前台与 Job 支持的工具路径又增加了所有权路径。工作流仍需等待结果，而外部后端需要一次进程执行，无需获得多轮协议。

## 决策

`startActivation()` 是所有提供方的消费者入口。已发布句柄暴露子级身份、结果 promise 和对应 activation 的资源释放。调用方信号仅取消未发布的创建。本地结果等待待处理输入与所拥有的后代结束后才关闭准入，使后代回复能够进入最终答案。本地与外部结果 promise 都在清理和通知结束后完成。父级使用同一个完成 promise 等待；清理失败不覆盖已捕获的执行结果，由 disposal 单独报告。工作流消费者本就等待清理后再继续，因此 activation 所有权不需要独立的结果就绪与释放信号。

本地 spawn 和 fork 提供方只贡献 `prepareContinuable()` 数据，由 subagent 服务拥有 Agent 创建与驻留。独立进程内驱动器包被移除。结构化工具、校验、指令与终止保护附着于一次 activation，并随其关闭。捕获后该 activation 拒绝继续输入；冷恢复重建普通对话，不携带此前的 schema。

ACP、DSH SDK、Codex 和 Claude Code 保留单次执行适配器，共享 activation 容量与所有权，不接受后续消息，也不伪造本地子 Session。父级拥有的 catalog 登记所有本地子级，以及 parent 交付的外部叶子项。本地成员关系独立于结果交付，让已完成的工作流 Session 及其后代仍可被发现。caller 交付由消费方跟踪外部成员关系。外部条目携带 `mode: 'external'`，因为没有可打开的本地 Session。创建时记录一次成员关系；执行与清理不更新目录。执行状态没有必需的消费者，不属于成员记录。caller 交付返回完整结果，parent 交付将完整完成通知加入父级队列。

面向模型的工具始终返回后台子级 ID，并承诺管理器的完成通知。它没有前台开关或 Job 集成。工作流选择调用方投递，等待 activation 结果并在完成前释放句柄；它们不向父子交互添加完成通知或初始返回指导。Headless 完成流程等待其自身子树与后续父级轮次。

父级完成通知会附带最终文本，不受 `send_message` 是否可用或是否调用影响。工具可用不能证明子级已经发送答案：它可能只汇报进展，也可能未调用工具便结束。已经通过工具发送的答案可能出现两次；接受这类重复，可以避免让结果投递依赖模型遵循指令或额外的投递台账。

### 保留的决策

原生 Session 读取器对本地与外部目录条目都拒绝重复的子级成员记录。

[可继续驻留](../feature/2026-07-28-continuable-subagent-conversations.zh.md)、[fork 请求前缀](../architecture/2026-08-10-fork-children-stay-one-shot.zh.md)与[父级拥有的目录](../architecture/2026-09-01-parent-owned-subagent-catalog.zh.md)保留各自独立理由。具名提供方、结果投递与 activation 容量的当前约定见 [subagent 包文档](../../../../packages/subagent/subagent/README.zh.md)；相应的[能力 seam](../../archived/feature/2026-06-21-subagent-capability-seam.md)、[结算投递](../../archived/feature/2026-08-06-manager-owned-subagent-settlement-delivery.md)与[容量](../../archived/feature/2026-09-15-continuable-activation-capacity.md)记录作为历史快照保留。本决策拥有共享入口、外部执行参与以及调用方与父级之间的结果投递选择。

已发布 Session 世代保持不可变。历史一次性描述符仍可读取；移除当前执行路径不构成改写或丢弃持久历史的理由。

## 考虑过的替代方案

**保留独立的外部执行投影。** 它重复父级 catalog 已提供的成员登记、恢复与客户端更新，每次目录快照还会重传全部结果。catalog 仅保留成员关系，完整结果由接收方负责。

**为同步工作流保留本地一次性执行。** 等待结果是消费者需求。仅为提供 promise 而维护第二套 Agent 生命周期会重复取消与清理；activation 可以直接提供该 promise。

**为所有外部后端增加多轮支持。** 这会扩展后端协议、恢复和经过授权的路由，却不是共享所有权的必要条件。适配器保留现有执行能力。

**让所有后台子级使用 Jobs。** Jobs 在 activation 驻留和 Agent 收件箱之外增加第二套工作注册表与取消权限。子级发现和完成已属于 subagent 服务。

**把每个结果都发送给父级。** 工作流已经消费并展示子级结果；再次唤醒会重复上下文，也可能干扰正在等待工作流工具的父级。投递是显式消费者选择，面向模型工具的通知仍无条件提供。

## 后果

同一个管理器控制所有提供方的准入、取消、所有权和资源释放。工作流 API 仍同步收集结果，模型委派则及时结束父级工具 step。外部子级获得共享计数与持久发现，但不获得继续执行能力或独立结果档案。恢复前台或 Job 支持的本地执行，需要 activation 结果收集无法提供的具体能力。

## 验证

聚焦测试覆盖本地 spawn/fork 继承、结构化捕获与无 schema 冷恢复、显式取消、外部目录成员关系、结果与释放顺序、不发父级通知的工作流收集，以及 headless 子树完成。既有回放世代得到保留；更新的录制会话用例覆盖当前面向模型的工具与通知行为。
