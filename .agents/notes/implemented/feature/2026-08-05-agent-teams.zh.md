# Agent Note: Durable Agent Teams over continuable children

Status: implemented

[English](2026-08-05-agent-teams.md) | 中文

## Problem

subagent seam 已提供 fresh／fork provider、持久 child Session、FIFO follow-up 与可冷恢复 Activation。它的直接 parent control 不提供 peer 通讯、稳定具名 roster 或共享任务 owner。coordinator 可以创建多个 worker，但 worker 无法互相寻址；持久 follow-up 意图只存在于 target inbox；也没有公共 compare-and-set 任务板来阻止陈旧 assignment 更新。

同进程 Agent 还共享一个 checkout。文件系统 edit 工具可以拒绝已观察到的陈旧版本，但 Bash、formatter、generator 与外部 writer 会绕过该屏障。把 teammate name 或 task owner 当作文件锁只会掩盖而不是解决该并发边界。

Team 协作需要显式开启；[Session 选择](../architecture/2026-10-20-session-team-mode.zh.md)负责选择粒度与默认组合。默认工具目录与简单任务行为必须保持不变；而显式请求的 Team 必须能跨越 child Activation settlement 与 mailbox 投递竞争，使 Lead 在进程 teardown 前汇总结果。

## Decision

每个普通根及其后代组成以根 `SessionId` 标识的 Team；持久任务状态从首个任务事件开始。[subagent 队友](../architecture/2026-10-15-agent-teams-as-subagents.zh.md)负责单一 agent 身份。[仅等待收件箱](../simplification/2026-10-29-inbox-only-agent-wait.zh.md)使任务板变更独立于收件箱等待。普通 Session fork 成为一棵新树的根，并排除继承的 Team 权限。

实现拆分为 `@deepseek-ai/dsh-agent-team` 与 `@deepseek-ai/dsh-tool-agent-team`：前者负责 `ctx.agentTeams` 和持久语义，后者负责 scoped schema 与模型指引。每个 Team 工具都声明完整的结果 schema，并把该值渲染为紧凑 JSON，因此编译器会检查每个 `execute` 是否符合对模型的承诺，也没有结果把 token 花在缩进上。基础 bundle 挂载两个插件；Team 不注册与 subagent control 同名的工具。共享策略声明 Team 可用，并说明协调责任。两个包属于 [subagent 家族](../../../../packages/subagent/README.zh.md)；根 Session 保存的选择控制任务工具与策略。[Session 模式升级指南](../../../../docs/upgrade-guide/v0.2.1-rc.2/session-team-mode/guide.zh.md)说明 profile 迁移。

Lead 必须等待所需工作后才能给出最终答案。进程 teardown 仍是最终生命周期 owner，并会 drain continuation Activation；Team task owner 是持久状态，不会因 idle、interrupt 或进程退出自动释放。

## Profile delegation

[基础 bundle](../../../../packages/bundle/base/README.zh.md) 插入 Team 行，并保留 base 的委派与控制工具；teammate 按[subagent](../architecture/2026-10-15-agent-teams-as-subagents.zh.md)所述使用这些工具启动。普通 Session fork 保留历史；[当前身份处理](../architecture/2026-10-13-team-identity-runtime-context.zh.md)提供 fork 自己的角色。

## Team identity

成员共享统一系统策略和工具模式；执行时强制角色权限。Team 工具解析调用方所属 Team，并使用 Session id 作为任务负责人。[必需运行时身份](../architecture/2026-10-13-team-identity-runtime-context.zh.md)负责身份注入、保留和分叉处理。

## Provisioning and recovery

队友创建和冷恢复属于子代理运行时（[子代理队友](../architecture/2026-10-15-agent-teams-as-subagents.zh.md)）。历史 `team/member` 记录保留阶段和描述并继续可读；Team 不写入新成员记录。

## Mailbox and task transactions

历史 Lead-log mailbox 仍可从原始 Session 日志读取。[仅投影任务的决策](../simplification/2026-10-29-team-task-only-projection.zh.md)取代邮箱投影、检查点保留和 Team 载荷校验。历史排队消息绝不再投递或确认。

member 消息使用 subagent 的 `send_message` 操作，它对 running、idle 和 cold target 使用 Steer，并返回 inbox 接收结果。

共享 task 是带 Team-local id 与单调 revision 的完整快照。每次变更都携带 `expectedRevision`。任意 member 可以创建、读取或 claim ready 且无 owner 的任务；Owner 或 Lead 可以编辑和转换；只有 Lead 可以分配给另一个 member。数字 task id 保持在安全整数分配范围内；该范围耗尽时会失败，不会复用 id。依赖必须指向未删除任务，并形成完整 DAG。删除任务保留为 tombstone。`writeScopes` 是规范化路径前缀，只产生重叠诊断，绝不会阻止 claim 或授予写权限。

`wait_agent` 属于普通 subagent 控制工具，等待当前调用者的下一步收件箱，包括已有待处理输入。任务提交不结束等待、不投递消息，也不启动空闲轮次。需要另一个成员处理任务变更时，Agent 应发送消息。祖先可中断后代，不改变任务归属。

## Shared checkout boundary

所有 member 创建时使用 Lead 的当前目录，并立即观察共享文件系统写入。后续目录变更仅影响各自 Session。任务策略要求 member 认领就绪任务、使用提示性 write scope 和依赖，并在完成工作后完成任务。文件系统 stale-version 拒绝后必须重新读取并 rebase 修改意图。Bash、formatter、codegen 与直接外部写入不具备等价保证。

Team 领域不会推断 branch、创建 worktree、merge 变更或静默改变 cwd。deployment 或调用方可以另外使用[显式工作树创建](2026-09-13-explicit-worktree-creation.zh.md)。这样保留既有 same-world subagent 与 sandbox 契约。

## Web projection

Web panel 读取 Lead Session 的 `agentTeam` 传输投影，因为现有投影流能持续更新浏览器状态，无需独立的 Team 读取 API。Lead 与 teammate 会话均从共享的跨 Session store 选择值。面板不负责投影读取：Session 加载、列表缓存值与控制基线提供数据。

任务面板使用包含就绪和重叠诊断的未删除任务视图，以及最后有效状态旁的 `failure`。历史名册字段仍可解码，但不拥有当前 UI 或分配权限。普通 subagent 导航负责成员发现；任务所有者标签复用 Session 和目录元数据。

发布要求 `apply` 为每个应用的事件返回新状态，且只替换触及的集合。仅邮箱事件保留客户端视图，不发布更新。现有载体向已连接浏览器发送变更后的完整视图；包 README 记录该成本。

## Alternatives considered

**保留独立 Team 通信权限。** 后续的[整树通信决策](../architecture/2026-10-16-tree-wide-agent-communication.zh.md)将路由和授权置于 subagent 运行时；任务板不能授予另一条路由。

**保留持久化 Team 邮箱。** 目标接纳和任务提交是独立操作。历史 Team 邮箱保持可读，当前通信使用目标收件箱。任务提交既不投递消息，也不结束等待。

**把 task ownership 或 write scope 当作锁。** 拒绝，因为外部 writer 会绕过它们，崩溃 owner 会持久保留，而路径前缀重叠不能证明语义独立。虚假的互斥保证比明确 warning 更危险。

**自动创建隔离 worktree。** 拒绝，因为 worktree 创建、branch 命名、merge 策略、ignored file、构建产物与 cleanup 都是 deployment 选择；它也会改变既有 subagent 与 sandbox 暴露的 same-world 行为。

**在默认工具目录中启用 Team。** 拒绝，因为主动协调与 Team 工具 schema 会给简单任务增加延迟和 token 成本。opt-in profile bundle 会插入 Team，同时不向随附依赖图添加 Team 包。

**使用内存 board 与 mailbox。** 任务状态必须经受 settlement、HMR 与中断。历史 mailbox 记录保持可读；消息归属目标 inbox。

**让 Team 工具返回未类型化 JSON。** 拒绝，因为未声明的结果类型会让 `execute` 在没有编译错误的情况下偏离对模型的承诺，也会引入在每份 task 与 wait 结果上都消耗 token 的缩进。因此每个 Team 工具都声明完整的结果 schema，并由一个共享 helper 紧凑渲染。

## Testing

包测试覆盖任务转换、基于树的分配、历史名册和邮箱解码，以及任务提交后收件箱等待保持未完成。普通 subagent 测试覆盖收件箱等待；录制 Team 组合覆盖身份、任务策略和工具。

身份和收件箱等待遵循 [subagent 控制工具](../../../../packages/subagent/tool-subagent-control/README.zh.md)；任务策略遵循 [Team 工具参考](../../../../packages/team/tool-agent-team/README.zh.md)。

## Consequences

Lead Session 保留完整 task 快照以及历史 member 与 mailbox 记录。这优先支持可检查的恢复，而不是紧凑增量；deleted 与 delivered 历史在更广泛的 Session 保留策略生效前仍只追加。

teammate 可能不驻留，因此 `inactive` 不表示失败，发送可能产生冷恢复延迟。历史 pending 邮件永远不会被投递。

协调可以降低 checkout 冲突概率，但无法消除文件系统 CAS 工具之外的写入。最终 diff 与测试仍是 Lead 的集成边界。
