# Agent Note: Durable Agent Teams over continuable children

Status: implemented

[English](2026-08-05-agent-teams.md) | 中文

## Problem

subagent seam 已提供 fresh／fork provider、持久 child Session、FIFO follow-up 与可冷恢复 Activation。它的直接 parent control 不提供 peer 通讯、稳定具名 roster 或共享任务 owner。coordinator 可以创建多个 worker，但 worker 无法互相寻址；持久 follow-up 意图只存在于 target inbox；也没有公共 compare-and-set 任务板来阻止陈旧 assignment 更新。

同进程 Agent 还共享一个 checkout。文件系统 edit 工具可以拒绝已观察到的陈旧版本，但 Bash、formatter、generator 与外部 writer 会绕过该屏障。把 teammate name 或 task owner 当作文件锁只会掩盖而不是解决该并发边界。

在公开约定稳定到足以进入已发布 CLI 或 Web bundle 前，Agent Teams 需要显式的源码 checkout 组合。默认工具目录与简单任务行为必须保持不变；而显式请求的 Team 必须能跨越 child Activation settlement 与 mailbox 投递竞争，使 Lead 在进程 teardown 前汇总结果。

## Decision

每个普通运行时 Root 都是一个隐式 Team 的 Lead，Team id 等于该 Root 的 `SessionId`。Team 没有 creation event：Lead pseudo-row 由身份直接存在，持久状态从第一条 member、message 或 task event 开始。roster 是扁平结构，最多包含配置数量、不可变且采用小写 kebab-case 的名字。每个 teammate 都是使用预留 Session id 的 continuable 直接 child；只有 Lead 可以创建或 interrupt teammate。roster 外由 provider 管理的普通 subagent 不是 Team member；普通 fork 是新的 Root，继承的 Team 记录会因 ancestor `TeamId` 被排除。

实现拆分为 `@deepseek-ai/dsh-experimental-agent-team` 与 `@deepseek-ai/dsh-experimental-tool-agent-team`：前者负责 `ctx.agentTeams` 和持久语义，后者负责 scoped schema 与模型指引。每个 Team 工具都声明完整的结果 schema，并把该值渲染为紧凑 JSON，因此编译器会检查每个 `execute` 是否符合对模型的承诺，也没有结果把 token 花在缩进上。部署显式挂载两个插件，并可禁用具有相同模型可见名称的旧 continuable control。显式 delegation 策略只允许在用户要求 Agent Teams 或 teammate 时创建 Team。 两个包都是 `packages/experimental/` 的私有成员；[实验性包决策](../architecture/2026-08-18-experimental-agent-teams-packages.zh.md)负责发布排除、依赖隔离与 promotion。

Lead 必须等待所需工作后才能给出最终答案。进程 teardown 仍是最终生命周期 owner，并会 drain continuation Activation；Team task owner 是持久状态，不会因 idle、interrupt 或进程退出自动释放。

## Provisioning and recovery

创建操作先在 Lead Session 中追加并 flush `team/member` provisioning 快照，再通过选定 fresh 或 fork provider 启动预留的 continuable child。初始 inbox 获准前的失败会追加 failed 快照；成功会先 flush child 中已接受的 inbox 条目，再追加 active。恢复会在初始消息仍处于 pending 或已进入用户消息历史时识别它。名字由第一条 provisioning 记录永久保留，包括失败后也不能复用。dispose 会关闭准入，中止并等待已获准的创建与 mailbox dispatch 事务，再停止 roster 记录的所有 live child；failed child 在 Activation 退出前仍由 cleanup 拥有，cleanup 拒绝会让 dispose 失败。

Root 恢复时会把未终结 provisioning 记录与独立持久 child Session 对账。直接 parent 与 continuable descriptor 匹配，并且已经记录初始用户消息，才能证明准入成功并转为 active；缺失、损坏、provider／lineage 不匹配或缺少已准入消息都会转为 failed。creator 会在同一 Lead 日志 serializer 内重读终态；如果 recovery 在创建成功时先标记 failed，creator 会 drain child 并报告 provisioning conflict，而不是遗留孤儿。这样既无需重建从未保存在 Team 日志中的初始 prompt，也能约束插件 reload 竞争。

fresh child 不继承对话。fork child 只捕获一次 Lead 已完成 turn 前缀，并保留为自己的持久 seed。当前 delegation turn 保持排除，与既有 fork provider 契约一致。

## Mailbox and task transactions

Peer 通讯使用 Lead 日志 mailbox。投递前先追加并 flush `team/message/queued`。target message 会在持久 source metadata 与短模型可见前缀中同时携带稳定 message id 和 sender identity。只有 pending inbox 条目或已记录用户消息完成 flush，Lead 日志才写入 `team/message/delivered` acknowledgement。即时准入按 target 和 queued 日志顺序串行化，恢复按同一顺序重试 queued-minus-delivered，并在冷恢复前折叠 live 或 persisted target 的 inbox／历史状态。每个当前版本 Team payload 都会经过运行时验证后才进入 replay state。Team runtime 从同步准入到 settlement 全程跟踪 dispatch 与异步 acknowledgement 工作；dispose 会关闭准入，并在移除服务前等待两者。当前 waiter 只在所属 Team event flush 成功后被唤醒。

`send_message` 始终尝试 Steer 投递。running target 在最近的步骤边界收到消息，idle target 启动一个轮次，inactive teammate 则冷恢复。即使临时投递失败让消息保持 queued，成功也表示消息已经持久化。该机制提供进程内重试与 target Session 去重，不宣称跨进程 exactly-once。[Team Steer 消息决策](../../archived/simplification/2026-08-30-team-send-message-steer.md)负责单工具调度的理由。

共享 task 是带 Team-local id 与单调 revision 的完整快照。每次变更都携带 `expectedRevision`。任意 member 可以创建、读取或 claim ready 且无 owner 的任务；Owner 或 Lead 可以编辑和转换；只有 Lead 可以分配给另一个 member。数字 task id 保持在安全整数分配范围内；该范围耗尽时会失败，不会复用 id。依赖必须指向未删除任务，并形成完整 DAG。删除任务保留为 tombstone。`writeScopes` 是规范化路径前缀，只产生重叠诊断，绝不会阻止 claim 或授予写权限。

`wait_agent` 等待调用注册后发生的下一条 roster、mailbox、task 或实时 status 边，避免模型轮询。它不会回放更早的边，因此调用方需要在唤醒或超时后重新读取权威状态。仅限 Lead 的 interrupt 使用 inbox preservation 取消当前 turn，不改变 mailbox 或 task owner。

## Shared checkout boundary

所有 member 使用相同 cwd，并立即观察写入。策略要求 member 切分任务、记录提示性 write scope、为有序工作添加依赖，并由 Lead 检查最终 diff 和运行测试。文件系统 stale-version 拒绝后必须重新读取并 rebase 修改意图。Bash、formatter、codegen 与直接外部写入不具备等价保证。

Worktree isolation 不是 harness runtime 行为。deployment 或 prompt 可以安排独立 worktree，但 Team 领域不会推断 branch、merge 变更或静默改变 cwd。这样保留既有 same-world subagent 与 sandbox 契约。

## Alternatives considered

**用 peer id 扩展 direct-child subagent tool。** 拒绝，因为 parent／child 权限与 Team peer membership 是不同领域。向 continuation seam 增加 peer access 会削弱 exact-parent authorization，仍无法为 roster 与 task 提供持久 owner。

**在 Lead 日志入队前把 mail 存入每个 target Session。** 拒绝，因为 Team 提交发送之后，target materialization 与准入仍可能失败。始终 live 的 Lead Session 是事务 owner；target recording 是 acknowledgement 与去重边界。

**把 task ownership 或 write scope 当作锁。** 拒绝，因为外部 writer 会绕过它们，崩溃 owner 会持久保留，而路径前缀重叠不能证明语义独立。虚假的互斥保证比明确 warning 更危险。

**自动创建隔离 worktree。** 拒绝，因为 worktree 创建、branch 命名、merge 策略、ignored file、构建产物与 cleanup 都是 deployment 选择；它也会改变既有 subagent 与 sandbox 暴露的 same-world 行为。

**在默认工具目录中启用 Team。** 拒绝，因为 scoped Team control 会覆盖同名旧全局工具，主动 delegation 也会给简单任务增加延迟和 token 成本。私有 profile bundle 会插入 Team 并禁用旧 control，同时不向已发布依赖图添加 Team 包。

**使用内存 task board 与 mailbox。** 拒绝，因为 child settlement、HMR 与进程中断会丢失已接受协调状态，并让重试变得含糊。

**让 Team 工具返回未类型化 JSON。** 拒绝，因为未声明的结果类型会让 `execute` 在没有编译错误的情况下偏离对模型的承诺，也会引入在每份 roster、task 与回执上都消耗 token 的缩进。因此每个 Team 工具都声明完整的结果 schema，并由一个共享 helper 紧凑渲染。

## Testing

Package test 以逐文件 100% coverage 覆盖身份、名字与权限检查、provider 选择、预留 id 持久化冲突、child-before-Lead flush 顺序、持久 provisioning 失败与 pending-inbox JSONL 对账、target-local 并发顺序、pending／history 去重、mailbox 限额、flush 后 notification、取消在途创建与 dispatch 的有界 dispose、failed member cleanup、task CAS 与 DAG 校验、write-scope warning、wait cancel／timeout、保留 inbox 的 interrupt、普通 fork 隔离、旧 control shadowing、声明 schema 的紧凑结果渲染与 scoped registration HMR。一条 keyless 产品快照会通过 `dsh --profile headless` 加载私有 Agent Teams profile bundle，并为两个 teammate、依赖任务、peer 投递、等待、完成和汇总固定完整的面向模型工具列表、Team policy 与持久 workflow 投影。CLI e2e 会复用同一个确定性 adapter，并验证带持久 Team 与 child 日志的正常退出。

## Consequences

Lead Session 会随着完整 task／member 快照与 mailbox acknowledgement 增长。该设计用可独立检查的恢复能力换取更紧凑的 delta；配置的 task 与 pending-mail 限额限制 active state，而 deleted 与 delivered 历史会保持 append-only，直到更广泛的 Session retention 生效。

active roster member 可以不驻留，因此 `inactive` 不表示失败，send 可能产生 cold-resume 延迟。临时 inspection、resume 或 inbox 准入失败可能留下持久 queued 消息等待恢复。failed member 会永久占用名字与 member slot，使 provisioning failure 保持可见而不是静默回收身份。

协调可以降低 checkout 冲突概率，但无法消除文件系统 CAS 工具之外的写入。最终 diff 与测试仍是 Lead 的集成边界。
