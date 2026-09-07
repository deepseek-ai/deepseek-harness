# Agent Note: Settlement delivery belongs to the continuation manager

Status: implemented

[English](2026-08-06-manager-owned-subagent-settlement-delivery.md) | 中文

## 问题

可继续后台委派是模型唯一一种能够发起、却无法抵达终点的异步操作。其他每一种形态都有取回原语或返回值：后台 bash 命令与一次性后台 subagent 都通过 Task 结算，`job_output(wait: true)` 可以阻塞等待；workflow 与前台 subagent 会把结果返回给调用方。可继续后台 child 只返回它持久化的 id，而父级既没有可等待的对象，也不会被交付任何东西。

由 child 编写的消息补上了这一缺口中协作的那一半：child 可以向直接 parent 发送进度与最终交接。模型选择无法补上其余部分。被 token 上限、模型失败、取消或拆卸终止的 child 可能永远不会发送这种消息，而这些恰恰是等待中的父级最需要被告知的结束方式。可观察到的下游症状包括：父级忙轮询 `list_agents`、向已经结算的 child 反复发送消息，以及部署放弃 `subagent` 转用 `workflow`，因为 workflow 至少会返回点什么。

信号本身早就存在。自可继续 Activation 发布以来，`subagent/end` 就一直携带 `stopReason` 与 `lastAssistantMessage`。缺的是把它变成父级模型能看到的上下文的那个消费者。

## 决策

继续执行管理器自己投递这份记账，就在结束 Activation 的那笔 dispose 事务内部完成。

当驻留 Activation 结算时，`notifySettlement()` 解析该 child 持久化的直接父级，并向它发送一条用户角色消息：先是父级可据以行动的一句结果说明，然后是 child 的最终 assistant 内容，或一句说明它没有产出内容。对每个调用方真正拿到过 id 的 child，投递都是无条件的。它不查询 child 是否上报过，也不保留任何可能让这项承诺变成有条件的记账——正是这种无条件性，才让 `tool-subagent` 能够承诺一条包含结局与可能存在的最终 assistant 消息的运行时通知。在第一条消息被接受之前就回滚的物化保持静默，因为调用方已被告知该 child 未建立。

### 来源信息

该通知携带 `{ kind: 'subagent-settled', form: 'notice', summary, senderSessionId }`，刻意不复用 `send_message` 使用的 `agent-message` kind。Agent 消息是 child 选择的内容；这条消息则是运行时在陈述这个 child 后来怎样了。把两者合并会把 child 从未写过的话算到它头上，也会让持久化日志无法区分「child 说它做完了」和「harness 观察到它停下了」。`notice` 形态还为 UI 提供了这条消息想要的折叠单行呈现，而 `relay` 会把 Agent 往来消息呈现为通信。

### 两条顺序规则，以及为什么归管理器所有

外部 `ctx.on('subagent/end')` listener 看起来更解耦，但它是错的。`SubagentRunEndInfo` 不指名父级；该边触发时 child handle 已被 dispose，因此无法从中恢复父级；而唤醒父级自身结算 watcher 的所有权释放也已经执行过了。管理器在整个 dispose 过程中都持有父级引用，因此这些障碍对它都不存在。

**发送发生在 `releaseOwnership` 之前。** 此刻 parent 的 owned-child set 仍然包含这个 child，因此结算判据不可能成立。改在释放之后投递，则会与一个在下一个 microtask 恢复的 watcher 竞争：它会发现自己没有 child 且处于静止，于是 dispose 一个 Agent，而该 Agent 的 `cancel()` 会清空正装着这条通知的那个 inbox。失效表现是一条静默丢失的消息，任何地方都不会报错。

**驻留 parent 通过私有 `SubagentInbox` 接收它。** 包装层会在同步唤醒发送前立即检查 Activation 的 closing promise，manager 则会在返回前更新 wake generation。最终结算决策会在 child lock 内重新检查该 generation、Session 序号、待处理 Inbox 与 owned-child set，再通过 `runMaintenance()` 占用 Agent 的 idle 阶段，然后关闭准入。这并非对第一条规则的重复保护：`Agent.status` 会把 context maintenance 折叠成 `idle`，而 maintenance 期间的唤醒发送只会预置一次延后唤醒。

两条规则都有测试固定：把顺序反转或去掉记账，测试就会失败。

### 建立期间保持所有权敞开

被持有子代的记账同样守护创建侧：`holdOwnership()` 会在建立或恢复的各个 await（持久化 stat、提供方准备、实体化）之前，把子代 id 预先登记进由续接管理的父代持有集合，因此当调用方仍在创建或恢复某个子代时，空闲的父代不会被判定为已结算——若在结算之后才接纳投递，将会遇到过期的父代身份。返回的释放器只服务失败路径：它只移除本次调用添加的持有；一旦该子代存在活跃 Activation，所有权边就归属于该 Activation 与 `finishDisposal` 的 `releaseOwnership`。没有 Activation 的父代不需要持有（只有本管理器会结算父代），而自身 dispose 事务已经打开的父代会以 `ACTIVATION_CLOSING` 拒绝，而不是建立一个永远无法收到投递的子代。

### 调度

空闲父级得到一个普通的后续轮次。繁忙父级则被 steer 到其最近的 step 边界，因为 `Inbox.claim()` 会在一个边界上整批取走 next-step：四个 child 同时结算时因此只消耗一个 step，而不是四个轮次。采用 steer 而非 inject 是刻意的——驱动运行期间该唤醒是空操作，同时它关闭了「驱动在状态读取与发送之间退出」的那个窗口；否则通知会滞留无人认领，直到别的事件唤醒父级。这是正确性规则而非部署偏好，因此不做成 `Config` 字段。

有一种 `running` 父级是无法 steer 的：轮次已被 cancel 但尚未退出的那种。`Agent.send()` 会把取消之后提交的唤醒输入改投到下一个轮次、闩存这次唤醒，并在被取消的驱动收敛后重放它——只有 disposal 取消从不闩存，那属于下面的拆卸规则。因此通知仍会开启自己的轮次，无需等待无关输入；代价是一次被改投的轮次边界，而不是消息本身。

**自身已开始拆卸的父级不会被唤醒。** 唤醒不是入队操作：对静息 Agent 调用 `Agent.followup()` 会开启一个轮次，而对空闲 Agent 调用 `cancel()` 是文档明确的空操作，不会对之后的轮次设防。因此每条拆卸路径最终都面对一个在线、已取消、仍在注册表中的父级——ACP 桥接层正是在取消其 session agent 与 dispose 它们之间调用 `drainContinuableDescendants()`——于是一条无防护的通知会在一个即将被销毁的 Agent 上发起真实模型请求，而且每层树各一次，因为每层自己的通知又会唤醒它上面那层。`notifySettlement()` 会问 `assertAdmitting()` 问的同一个问题（这条谱系的可继续准入是否已关闭？），并改为 inject。inject 不是持久 mailbox——父级自身的 dispose 会对它做什么，记在「已接受的风险」里——但它是唯一能送达仍在读取自身 inbox 的父级、又不会在不该被唤醒的父级上预置一个轮次的发送方式；而唤醒本可送达的东西一样没有丢失：唤醒开启的那个轮次本身就会在半途被 dispose。

投递绝不会阻塞或使拆卸失败。发送被拒会被记录并丢弃，因为为重试一条通知而保留 child，会把它的整条祖先链永久钉在 `waiting` 上；而父级已离开注册表属于普通结果，不是错误。

### epoch 自己的日志就是全部交代

`epochStopReason()` 从 epoch 自己的日志读取结局，因为拆卸成功与否，对「模型是否报错、是否撞到上限、是否被停下」什么也没说明。只读轮次这件事已经错了两次，而两次的形状相同：在第一个 step 之前被停下的轮次，其 `turn/end` 与「拒绝」或「被清空的认领」产生的平衡空转轮次长得一模一样，于是那道用来跳过后者的过滤，也把真实的结局一起跳过了，转而用上一个轮次的干净收尾作答。持久化检查点（`dsh-session-checkpoint-policy`，存在于每个随附 profile 中）与提示词组装都运行在这个边界上、且都会向外传播，而此时 `Inbox.claim()` 已经把消息取走了——于是父级被告知 child 已完成，而它正在等待的那条投递已被吞掉。在已公布的自动结算通知约定下，这恰恰是父级无法察觉、也不会重试的那一种失败。

缺失的事实从来不属于轮次，而属于 inbox。`Inbox` 会把每次改动连同 `removedCount` 一起记入日志，并给取消标记 `outcome: 'canceled'`，这就把「某个轮次认领了它的输入」与「工作被丢弃且从未运行」区分开来。`dsh-agent` 中的 `foldConsumedWork()` 把两套词汇折叠成一个答案：能为已消费工作作出交代的最新轮次——进入过 step 的，或认领后失败、被停下或被拒绝的——以及此后是否有已接受的工作被取消、而没有任何轮次为它开启过。认领过输入、以 `blocked` 结束的轮次同样是一份交代：产生它的 pre-step 拒绝——hook deny、策略插件——把该轮次认领的消息一并丢弃了，因此通知会说 child 拒绝了任务，而不是完成了任务。只有没认领任何输入的 `blocked` 轮次保持不可见。

从日志而不是从活动状态推导，才让它完整。早先的版本会在 cancel 之前立刻采样管理器自己的 Activation，而那样只能看到本管理器即将执行的取消：来自祖先的 `interrupt()`，或某个正在卸载的插件取消它所跟踪的 Agent，都会让该采样为假，通知照旧说 `finished`。它也让「已接受但从未被认领」这一情形没有任何测试能把它与「该判据不存在」区分开。一次对日志的折叠覆盖了所有发起方，而两个半边在被移除时都会让各自的测试失败。

优先级归消费方：已记录的失败或上限优先于取消，因为停下一个已经失败的 child，不会把它的失败变成一次取消。`dsh-agent` 拥有这个 fold，是因为答案所依赖的那个 inbox 标记归它所有，而两个消费方本来就依赖它——这里的可继续 epoch，以及一次性的 `readResult()`（它有同一个漏洞）。

两者的影响都超出通知本身：`subagent/end` 会把 `stopReason` 送到 jsonrpc UI 与 Claude hook 桥接层，而它们此前把被拆卸的、正在跑轮次的 child 报成 `completed`。

### 快照覆盖

三个整体组装的 ACP 场景覆盖该通知：一个不发送消息的 child、一个先发送消息的 child，以及一个被多轮 Agent 消息驱动的 child。三者都需要显式栅栏。通知在 child 拆卸完成后才到达，会与父级当时正在做的事竞争，因此每个场景都会把 child 保持到父级启动轮次结束，再等待该通知开启的那个父级轮次（先 `waitForTurnStart` 到该轮次，再 `waitForTurnEnd`），然后脚本才继续。等待一个运行并未被栅栏保证会产生的轮次不算覆盖：一旦通知落进已经在跑的那个轮次，它就是一次超时。

`subagent-continuable` 是其中固定失败结局的那个。它的 child 最后一个轮次在被强制的持久化检查点上死亡，且未进入任何 step，因此该 transcript 正是上面那条终止原因规则的端到端可见之处：通知说该 child **失败**，把此前的 `SECOND_OK` 作为它最后产出的内容而非结果携带，而父级自己的确认轮次会到达 ACP 客户端。

另有一个无密钥的 headless Loader 快照端到端覆盖用户可见路径。其重放父级省略 `run_in_background` 以覆盖可继续后台默认路径，从不调用 `list_agents`、`send_message` 或 Task 工具，消费管理器写入的 `subagent-settled` 通知，并给出最终答案。child 不发送 Agent 消息，因此该 transcript 只依赖运行时通知。一个仅用于测试的 Loader 栅栏会把父级启动后的请求保持到真实管理器通知进入其 inbox 为止，从 transcript 中排除平台调度差异，但不会伪造该通知。

`subagent-send-message` 场景会让 child 等到 parent 的派生轮次结束，随后让 parent 保持 maintenance，直至结算跟在 child 编写的消息之后到达。恢复的 parent 会先领取 next-step Agent 消息、再领取排队的 next-turn 结算。[消息与结算顺序决策](../bug-fix/2026-08-17-subagent-message-settlement-ordering.zh.md)负责说明这种跨状态顺序。

拒绝与中断两种措辞在单元测试中逐字钉死，而不进入重放 transcript：触发它们需要一个会拒绝的策略插件、或一次在 step 边界被栅栏卡住的取消，而无密钥组装本身并不携带这些；通知通路本身已由整体组装场景端到端钉住。

## 考虑过的替代方案

**给可继续 child 引入 Task。** Task 是一次性契约：一个生产者、一次结算、一个结果。Activation 会执行许多轮次、比其中任何一轮活得更久，并且可以在结束后被恢复。用 Task 包装它，恰好重建了可继续 child 当初为消除而引入的生命周期错配，还会让某一个轮次看起来是终局。

**挂一个外部 `subagent/end` listener。** 因上文三点被否决——payload 里没有父级、child handle 已被 dispose，以及 listener 无法影响的顺序。listener 还必须严格同步才能抢在释放之前，而该 seam 上没有任何东西强制这一点，因此正确的版本只能靠碰巧正确。

**仅在 child 没有发送消息时投递。** 这是最初的设计。它需要按 Activation 记账，仍会漏掉「发送了进度、随后在给出结果前死掉」的 child，而且最关键的是：它让面向父级的承诺变成有条件的。「通常你会被告知」不是工具描述能陈述的契约，而无法依赖该通知的模型无论如何都会去轮询。

**把投递做成可配置。** 部署开关会把面向模型的文本重新变回「通常」，而这正是本次改动要消除的失效。协议常量与安全不变量保持固定；这就是其中之一。

**修改 `subagent/end` 让它携带父级，由插件负责投递。** 那会为一个包内消费者拓宽已发布的 payload，保留全部顺序风险，并让返回通道重新变成可选插件。以 `terminal(failure)` 扩展包私有的 `ActivationObserver`，则只保留一处终止事实的计算，且不改动任何公开面。

**始终使用 `followup`。** 更简单也更统一，但一批同时结算的 child 会各自消耗一个父级轮次。step 边界的批量语义本来就存在，用它是免费的。

## 后果

- 可继续 child 的父级会为每个已结算 Activation 收到一条消息。因此，做扇出的部署会增加父级轮次；steer 会把同时结算的一批压缩到一个 step。
- `tool-subagent` 在其 schema 中承诺该通知，因为返回通道是服务行为，不是可选插件。
- `Activation` 携带 `parentSession` 与 `announced`。前者存在是因为 child handle 在投递前已被 dispose；后者让被回滚的物化保持静默。
- `foldConsumedWork()` 取代 `dsh-session` 的 `findLastMessageTurnEnd()`，并迁移到 `dsh-agent`——它拥有该 fold 所读取的 inbox 标记；一次性 in-process 路径折叠同一个答案，不会把被中途切断的一次性 child 归类为 `completed`。
- 单元覆盖固定了无条件约定、每种终止原因、空闲与繁忙两种调度、批量语义、维护期回归、释放前顺序、父级已消失，以及一次不得让拆卸失败的发送被拒。
- 三个 ACP 场景使用显式的结算围栏，`subagent-send-message` 固定 Agent 消息先于结算的 next-step 顺序。
- 一个无密钥的 headless Loader 快照固定了「后台启动 → 管理器写入的结算通知 → 父级最终答案」路径，其中没有轮询，也没有 child 编写的消息。

### 已接受的风险

通知只是被投递，而不是被确认。没有持久化 mailbox、回执或重试：不在线的父级会丢失它，child 的 Session 仍是唯一的持久记录。要补上这一点，需要一套带有自身寻址、授权与重放规则的离线 mailbox 协议。

当父级紧接着被 dispose 时（每个拆卸调用方都会这么做），在拆卸期间被 inject 的通知不会被模型读到：dispose 的 cancel 会清除这条未被认领的消息，而日志保留 insert/cancel 这一对作为记录。要让拆卸期投递在 resume 之后仍可读，要么需要上面那套离线 mailbox，要么需要改变 dispose 对持久待处理工作的处理方式。dispose 会丢弃每一条未被认领的 inbox 项，用户输入也不例外，因此改变该行为是一个 core-agent 决策，而不是结算投递的细节。resume 后的父级可以发现 child，但不会收到结局：`list_agents` 只报告存在性与「在线/仅存储」状态——`SubagentListEntry.activity` 就是这么写的——要取回结局，必须通过 `send_message` 去问那个 child。

终止原因的归因是对日志既有 splice 词汇的尽力而为，偏向永不高估成功。`Inbox.remove()` 与拆卸的 `clear()` 写出的取消 splice 完全相同，因此删除一条内容仍保留在别处的消息——`agent-instructions` 清理待处理的 instructions 刷新、或结算自身的 cancel 清掉一条仍在挂起的这类消息——可能被读作「工作被丢弃且从未运行」，把已完成的 child 报成被停下。区分二者需要 `dsh-agent` 提供更丰富的删除词汇；在该词汇可用前，这项误读的范围很窄，且错的方向是让父级复查一个已完成的 child，而永远不是信任一个未完成的 child。

对于深或宽的树，轮次放大是真实存在的，而且按设计不可配置。step 边界的批量语义只能约束同时结算的情形，无法约束分散结算的 child。

Agent 消息与其稍后的结算通知通过 parent 的 next-step FIFO 排序。来自同级 child 的独立结算保留其实际投递顺序，不会虚构同级间的顺序。
