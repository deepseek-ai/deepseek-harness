# Agent Note: Background job completion wakes an idle owner

Status: implemented

[English](2026-08-11-background-job-completion-wakes-an-idle-owner.md) | 中文

## 问题

`tool-jobs` 对模型承诺「任务完成时你会在会话内收到通知——不要忙轮询，也不要 sleep 等待」。这个承诺只在模型仍在工作时成立。完成经由 `agent.inject()` 交付，它只向 next-step inbox 追加而不预留 driver，因此在轮次结束之后才结算的任务会把通知搁在那里，直到某件无关的事情唤醒 agent。最常见的形态恰恰就是会失效的那一种：模型启动一条长命令，告诉用户已经启动，结束轮次，而命令完成后进入了一个无人领取的 inbox。提示词让模型不要轮询，然后什么也没到。

这个缺口被记为一条限制，而不是被推敲过，于是退路成了 `job_output(wait: true)`——同一段提示词并不鼓励的阻塞等待。

本决策取代[后台任务运行时决策](../architecture/2026-06-20-generic-long-running-tool-runtime.zh.md)中的一条事实——完成永不唤醒空闲所有者——并把 teardown 加为 `reported` 的置位方。那份 note 仍拥有其余全部任务运行时决策，因此就地更新而非替换。

交付机制从来不是障碍。自[统一 send 决策](../../archived/architecture/2026-07-22-unified-send-and-coalesced-user-messages.md)起，`Agent.send(message, target, wakeup)` 就覆盖了 `target` × `wakeup` 矩阵，`wakeDriver()` 也已经处理 idle、maintenance 和已取消未收敛三种相位。缺的是「一次完成走哪条通道」这一策略选择，以及该选择所需的界。

## 决策

尚未报告的完成按所有者当时在做什么来选择通道。繁忙的所有者走注入，保持原样。空闲的所有者用 `followup()` 唤醒。

这采纳了[延续管理器](2026-08-06-manager-owned-subagent-settlement-delivery.zh.md)已经为 subagent 结算所采用的交付规则，那里写着「用 steer 而非 inject 是刻意的……这是一条正确性规则，不是部署偏好」。两条路径不重叠：`tool-subagent` 只为一次性后台子 agent 注册 Task，而 continuable 分支在抵达那段代码之前就已返回，因此一个子 agent 恰好由两种机制中的一种交付。

### 繁忙的所有者保留注入

对真正在运行的 driver 而言，`steer()` 与 `inject()` 是同一次交付：对于运行中且未中止的相位，`wakeDriver()` 会提前返回且不设置 latch。二者只在一种所有者上有区别——轮次已取消但尚未收敛，此时 steer 会重定向到下一轮并在收敛时重放唤醒。

在那里注入才是对的。轮次被取消意味着用户按了停止，替他们重新开一轮等于把一次中断洗成了他们没有要求的模型请求。普通情形已由轮次循环覆盖：只要 next-step inbox 还有内容，轮次就无法结束，因此在该检查之前抵达的通知会延长当前轮次，同时结算的多个任务只花掉一步而不是各占一轮。

### 唤醒有界，且该界不是时间

`maxConsecutiveWakes`（默认 3）限制一个所有者由此开启的轮数；超出后通知降级为注入，等待下一轮。领取任何用户撰写的消息都会恢复预算——是领取而非抵达，因为那才是人类输入真正进入某一步的时刻。本插件自己排队的通知永远不会补充它。

设界是因为这条链会自激，而 subagent 结算不会。结算受限于模型派生了多少子 agent；被唤醒的一轮却可能启动某个后台任务，而它的完成又会唤醒同一个所有者，且无人旁观。`dsh run` 不需要单独策略：它唯一的用户消息在第一轮就被领取且不会重复，因此预算单调消耗，进程必然终止。

`completionDelivery: quiet` 为空闲所有者恢复旧通道。它的存在是为了确定性 transcript；后台任务完成会独立保留 `quiet | wakeup`，因为其有界的所有者轮次策略不同于 next-step subagent 报告。

### 销毁自行认领报告

`cancelForTeardown` 现在会把记录标记为 `reported`，与 `kill()` 在取消之后所做的完全一致。当通知只是一次无害的注入时，这处不对称看不出来；而会唤醒的报告方会把它变成每个 teardown 层级一次模型请求，作用在宿主正要销毁的 agent 上。

`reported` 本来就是正确的那个 bit——「kill、read 或 wait 已报告或承诺报告终止状态」——而 teardown 是一次没有调用方的 kill。用它可以让该结算的每一个观察者都保持完整：`onJobDone` 仍会触发，因此运行时不变量与强制失败路径依旧被覆盖，只有通知报告方会安静下来。

### 完成是最后才宣布的

`settle()` 此前释放等待方、标记记录已结算并发布可见集变更的时机，都排在运行完成监听器**之后**。开启轮次的报告方是同步执行的，因此那个顺序会让被唤醒轮次的 `turn/start` 抢在它所响应的那次结算被提交之前落地，也抢在任何 `onJobsChanged` 观察者看到它之前。把完成放到最后宣布，使报告方成为该结算的最后一个观察者，而其他观察者都已先看到它。

## 被否决的替代方案

**在 `JobStart` 上加生产方声明的唤醒位**，对应 Codex 的 `trigger_turn` 与 Kimi 的 `admission` 枚举。从长期看这是更好的形状——`tail -f` 流与两小时构建想要不同答案——但当前没有任何生产方需要区分它们，而仓库要求公共面必须有当下的所有者与需求。加它的自然触发点，是第一个「要让某个任务唤醒而另一个不唤醒」的生产方出现时。

**一个通用的非请求输入队列**并带优先级通道，正如 Claude Code 用来把后台任务、cron、MCP 推送与 hook 合并进同一次排空。DSH 的 inbox 本身就是那个队列——`next-turn`/`next-step` 之上的持久 `agent/inbox/spliced` splice——因此这等于在既有层之上再加一层，只为决定一个 bit。

**拒绝重开一个已经产出可见答复的轮次**，即 Codex 的 `MailboxDeliveryPhase` 闩锁。那条闩锁正是本决策刻意反转的默认值：在模型已经说完话之后唤醒它就是本特性的全部意义，界由唤醒预算来承担。

**在计数之上再加墙钟窗口**。对交互式 agent 而言，慢的那种情形恰恰是想要的——一小时的构建结束、agent 接着干下去，这就是特性本身——而 `dsh run` 已被它无法补充的计数封顶。只有当出现无人值守的长生命周期部署时才值得重新考虑。

**在 owner 排空期间整体压制 `onJobDone`**，与服务级的 `listenersClosed` 对称。它读起来更干净，但会移走一个不只服务于通知的信号：强制失败记录与运行时不变量都会观察 teardown 结算。`reported` 位恰好只否决报告方，别的什么也不否决。

## 影响

- 默认行为改变：空闲所有者现在每次完成会花掉一次模型请求，按所有者、在两次用户消息之间由 `maxConsecutiveWakes` 封顶。想要旧行为的部署设置 `completionDelivery: quiet`。
- `tool-jobs` 的提示词段落无需改动；「任务完成时你会在会话内收到通知」从愿景变成了事实。
- `JobSnapshot.reported` 新增 teardown 作为第四个置位方，记录在 Service Definition 与[子系统参考](../../../../docs/subsystems/jobs.zh.md)中。
- `settle()` 在提交记录并发布可见集变更之后才宣布完成。任何依赖「在释放等待方之前或在 `onJobsChanged` 之前运行」的监听器现在都排在两者之后。
- `tool-bash` 的 real-composition 测试去掉了第二条用户消息：仅靠结算就能把通知带入一个收集输出的轮次。它断言持久结果而非轮次边界，因为命令是否活得比它的轮次久是一场竞态；通道选择改由 `tool-jobs` 单元测试钉住。
- 单元覆盖钉住：空闲唤醒、繁忙注入、quiet 交付、预算耗尽、用户输入恢复预算、插件通知不恢复预算，以及 teardown 静默。

### 已接受的风险

已花掉的预算只由用户输入恢复。耗尽预算的无人值守 agent 要等到其他原因开启轮次时才收走剩余通知，在此期间没有任何机制为它重新充能。

在 `quiet` 下待领于空闲所有者的通知仍会随该所有者释放而消亡，与此前一致：释放时的取消会清空未领取的 inbox，日志保留插入/取消这一对作为记录。[结算交付 note](2026-08-06-manager-owned-subagent-settlement-delivery.zh.md) 承载这需要的离线信箱讨论。

对短命任务而言，完成究竟是延长运行中的轮次还是开启新轮次是一场真实竞态，因此没有哪份编写的 transcript 能同时容纳两种顺序。组装态覆盖断言结果；通道选择由单元测试钉住。

还残留一个微任务窗口：结算若落在轮次循环最后一次检查 inbox 之后、driver 提交 idle 相位之前，读到的仍是 `status === 'running'`，于是走注入且无人唤醒。改用 steer 也堵不上——`wakeDriver()` 只为 maintenance 与取消后的相位设置 latch，不为「最后一次检查与自身退休之间」的 driver 设置。要堵上它需要 `agent-loop` 在最后一次领取之前就发布退休状态，那属于核心 agent 的决策，而非交付策略。
