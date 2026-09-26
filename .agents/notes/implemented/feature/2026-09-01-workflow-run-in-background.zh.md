# Agent Note：workflow 运行经任务注册表获得 `run_in_background`

状态：已实现

Update：随 [jobs seam 收敛](../architecture/2026-09-03-jobs-seam-consolidation.zh.md)，该运行注册的是 `JobSpec`（没有 `record` 标志），通过 `JobHandle.append` 与 `updateProgress` 叙述进度，并把渲染后的值作为 `JobOutcome.result` 返回，模型在结算后的第一次读取携带它一次。

[English](2026-09-01-workflow-run-in-background.md) | 中文

## 问题

`workflow` 调用会阻塞父级轮次直到整个脚本结算：一次长编排（扇出到数百个文件的审计）把模型按在原地耗完全部墙钟时间，模型无法继续工作，人类看不到实时进度，取消是唯一出口。其他每个长时执行面——bash、pwsh、一次性 subagent——都早已有通往 `ctx.jobs` 的 `run_in_background` 路径。[record 合并](../architecture/2026-09-01-jobs-absorb-activity-record.zh.md)删掉前台 workflow 的 activity 镜像时，也明确承诺实时 workflow 叙述会以后台 record 任务的形式回归。

## 决策

`workflow` 工具获得 `run_in_background: true`（在 `enableRunInBackground` 配置生效时公开并受理，默认开启）：调用把运行注册为自有的 `kind: 'workflow'` 任务并声明观察 record，立刻返回 `{ kind: 'background', jobId, runId }`。

- **运行属于任务，不属于工具步骤。** 引擎运行在任务 starter 内启动且不带 `exec.signal`；取消路径是 `job_kill`、任务列表的停止控件与 owner 释放，各自把原因转发进 `run.cancel`。引擎的同步拒绝（meta／解析失败）从 starter 传播出去，因此什么都不注册，模型看到的是普通的可修正错误。
- **结算即任务结算。** `done` 从 `run.result` 链起：先 dispose（释放失败只告警，绝不 reject 进注册表），再停掉镜像，最后映射结束原因——`completed` 在 `JobOutcome.output` 里携带与前台路径相同的渲染返回值（完成播报与 `job_output` 由此送达它），`cancelled` 结算为 `killed` 并把 detail 留给注册表的 kill 原因合并（转发的取消原因就是同一字符串），`error` 以脚本失败消息结算为 `failed`。
- **record 镜像顶替被删的 activity 镜像。** `src/record.ts` 按插件订阅一次 `workflow/phase`、`workflow/log` 与成员生命周期事件，并把它们以 activity 镜像当年写下的同样文本行以 `log` 通道路由进被跟踪运行的 `JobHandle` 面（模型的 `job_output` 从不渲染它们）；`updateProgress` 跟随当前 phase。这里没有收容错误的包装层：`append`／`updateProgress` 是不抛出的表面（结算后的 append 在注册表内丢弃），迟到的事件找不到被跟踪的运行。
- **输出 schema 变为 `kind` 判别联合**（`background` | `foreground`），与 bash 的形态一致；前台包络为对称获得 `kind: 'foreground'`。持久的 run-start／成员／run-end 会话记录在两条路径上都保留 `exec.parent === undefined` 门槛，后台的 run-end 从任务的 `done` 链写出。
- **`workflow` 进入 `JobKindMap`**，由工具包声明合并，与 `pwsh`、`pty` 相同。

## 曾考虑的替代方案

- **工具自带 start／poll 接口**（一个 `workflow_status` 伴生工具）：为单一生产者复制 `job_output`／`job_kill`，还把运行留在 owner 释放与会话头部列表之外；任务注册表本身就是 start／poll 表面。
- **向模型流式中间值**（经 `readOutput` 给部分结果）：workflow 的值就是脚本的单一 return；每个 agent 的中间结果是脚本内部事务（`log()` 经 record 向人类叙述它们）。给天然只有终值的生产者一个消费型模型游标，只会招来轮询循环。
- **把 `exec.signal` 桥接进后台运行：** 已返回的工具步骤的中止（轮次取消）会杀掉模型刚刚有意脱管的工作；bash 的后台路径已立下先例——只有注册表取消它。

## 后果

模型可以点燃长编排后继续工作；人类在会话头部任务列表里看着 phase、log 与成员生命周期流入，并能就地停止运行。后台运行的值只在结算时抵达（此前的 `job_output` 只返回状态）。快照树钉住 schema、提示词与 PTC 桩的变化；回放完整后台运行的 recorded-session 场景延期，记录在包 README 的限制一节。
