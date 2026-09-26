# Agent Note：后台 job 的一个输出环、一个投影、一条事件流

Status: implemented

[English](2026-09-03-jobs-seam-consolidation.md) | 中文

## 问题

job seam 是逐步堆出来的。生产者要把输出声明两次——模型读取的消耗式 `readOutput` 钩子，以及观察者读取的可选 `record: true` 环——注册表也为同一个 job 保留了两套词汇（模型侧的 `JobSnapshot`、会话控制流上的 `SessionJob`、观测线路上的 `JobWireChunk`）。三个监听器家族（`onJobDone`、`onJobsChanged`、`onOutput`）用不同的拥有者过滤投递彼此重叠的事实，注册表自己还跟踪着只有模型侧工具才解释得了的 `reported` 位。合并后设计的评审把接口层称作最薄弱的部分：读者分不清 `read`、`readRecord`、`JobStart`、`RecordingJob` 与 `updateDetail` 里哪些是约定、哪些是历史遗留。

## 决策

- **每个 job 一个环。** `JobSpec` 取代 `JobStart`：spec 声明可选的拉取式 `output` 源（`JobOutputSource`，子进程的 `readFrom` 家族），由注册表按自己的节奏（`dsh-jobs-local` 的 `pumpPollMs`）泵送；每个生产者都收到一个 `JobHandle`，其 `append` 把块推进同一个环。模型的消耗式读取与每个观察者的绝对偏移读取服务同一批字节；`readOutput` 与 `record` 判别字段被移除。shell 生产者把它们的 `observed` 偏移读取器交给注册表，并把沙箱事实折进终态 `detail`；terminal 生产者通过一个计字节的源适配其消耗式发送读取器；subagent 把回答作为 `JobOutcome.result` 返回，结算后的第一次读取携带它一次。
- **两个游标，一份存储。** `JobRegistry.read(id)` 是有状态的模型游标；`JobRegistry.readAt(id, from)` 是无状态的观察者读取。模型读取排除 `log` 块（给观察者的生产者叙述），并渲染 stdout，再接一段 `[stderr]`，与 shell 工具一贯的做法完全一致。
- **`updateProgress` 取代 `updateDetail`。** `JobView.progress` 是实时行，结算时清除；`JobView.detail` 是终态原因，合并了模型 `job_kill` 给出的原因。
- **一个投影。** `JobView`（客户端安全叶子 `@deepseek-ai/dsh-jobs/view`）是模型工具、浏览器名册与观测帧共同消费的形状；`owner` 是会话 id，从不是 `Agent`。
- **直接传入调用方的操作。** `JobRegistry.list`、`get`、`read`、`readAt`、`kill` 与 `wait` 在每次调用时接收调用方会话。省略调用方时仅允许访问无主 job。输出环与浏览器流不需要独立的调用方操作对象。
- **一条事件流。** 带 `{ owner }`、`{ owners: 'scope' }` 或 `{ owners: 'all' }` 过滤的 `events.subscribe(filter, listener)` 取代三个监听器家族。`settled` 标出原因（`producer`、`kill`、`teardown`）；`output` 只携带 id 与新的 total。
- **播报台账移到 `dsh-tool-jobs`。** 注册表不再跟踪 `reported`。工具在等待开始时认领 job（超时或中止则撤回），在 `job_kill` 被接受时也认领；结算事件删除条目，teardown 结算与无主 job 被跳过，投递目标是结算时登记在拥有者会话下的 agent。
- **名册离开会话控制流。** `dsh-api-job-controller` 在 `job.follow` 旁拥有 `job.list({ sessionId })`——每轮聚合过的生命周期提交之后发一次整集帧，从不按追加发——其客户端安装 `ctx.jobs`（`watchRows`、`observe`、一份快照）。`dsh-api-session-controller` 只承载队列与投影；`ui-jobs` 在挂载期间关注其会话的名册，行在 job 进行中或留有保留输出时可展开。

`attachController` 与相对拥有者的 `servesOwner` 门保持原样；没有挂载控制器的生产者是否可以提供 `run_in_background`，因为这个缺口早于本次变更，暂不处理。

## 考虑过的替代方案

- **保留三个监听器并共享一个拥有者过滤。** 它保住了堆出来的名字，却保不住评审要的性质——一个地方就能学会注册表宣布什么——而且 `onJobDone` 的精确拥有者投递正是迫使注册表在每个投影里保留 `Agent` 的原因。
- **把 `reported`留在注册表。** 只有工具知道哪些投递到达了模型（等待的工具结果、kill 的确认）；注册表只能近似，而这个近似正是评审列出的重复播报与漏播报 bug 的来源。
- **把名册留在会话控制流上。** 省了一条 Remote 流，却把会话控制器耦合到 job 注册表，还镜像了一个环的字节数如今直接回答的 `record` 标志（`output.total`）。
- **也把 `log` 块交给模型。** 生产者叙述是给观察者的；模型已经通过 `progress` 与终态 `detail` 收到同样的事实。

## 后果

模型可见文本保持不变：状态行、工具描述与 schema、播报措辞逐字节相同，唯一新增的模型可见事实是 `killed` 状态行现在携带的 kill 原因。需要流式输出的生产者选择拉取源或 `append`，从不格式化消耗式增量。Web 客户端把每个进行中的 job 渲染为可展开，因此从不写输出的 job 显示为空的运行中面板而非静态行。`JobKindMap` 的合并发生在宿主侧，浏览器程序把 `JobView.kind` 视为它认识的 kind 集合，其余当作不透明字符串——名册对它也只做这些。

合并 master 之后的评审跟进收紧了其中四条边。job 的第一个事件永远是 `registered`：通告先于泵，而泵的首轮 drain 同步执行且可能通告输出。已结算的环在模型的首次终态读取之前保留模型游标尚未消费的全部字节，因此在首次 `job_output` 之前结束的 job 不会丢失运行期上限保留的任何内容。`dsh-tool-jobs` 为每次等待调用保存一条带 `live` 标记的认领，调用方 abort 时在 abort 事件里同步清掉该标记，因此注册表的拒绝尚未传回工具之前宣布的结算仍会投递通知；超时的等待只丢弃自己的认领，并发的另一个等待仍覆盖该结算。浏览器把先于锚点发生的观察失败记录为带错误的视图，面板显示提示而不是留白。`@deepseek-ai/dsh-jobs/invariant` 伴生插件校验每个 job 的事件协议（先 `registered`、恰一次结算、最后 `removed`）以及每个通告的投影与注册表自身读取的一致性，这正是[伴生插件规则](../simplification/2026-08-28-omit-unneeded-invariant-companions.zh.md)要求的交叉观察；先前只针对单个视图的字段校验已删除。拉取源保留的 spill 文件是 job 元数据（`JobView.output.spillPaths`，每次泵读取都会上报，读取不再点名时即撤回），不是逐块元数据；模型读取对生产者侧缺口与环淘汰都渲染 shell 工具的丢失输出提示并列出这些文件，即使缺口块本身已被淘汰——本次变更曾引入的 `before this read` 变体已删除。观察生成过程若在流中看到其 job 被移除（拥有者 teardown），以被移除 job 的终态投影收尾，而不是一次失败的读取。被拒绝的后台 spawn 不产生任何进程输出，因此 shell provider 现在把 `spawn failed: …` 提示作为 observed stderr 的整条流提供（消耗式读取仍只折入一次），且 `ShellProcess.observed` 及其两个读取器改为必填：这类失败之后模型的首次 `job_output` 读到的正是 master 的消耗式读取所渲染的内容。
