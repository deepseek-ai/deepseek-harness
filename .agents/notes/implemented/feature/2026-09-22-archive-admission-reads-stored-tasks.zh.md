# Agent Note：归档准入读取已存储的任务

状态：implemented

[English](2026-09-22-archive-admission-reads-stored-tasks.md) | 中文

## 问题

归档准入在写入归档前询问每个提供方：该 Session 还有什么在跑；随后「停止并归档」再要求它们结束这些工作（[归档仍有工作在跑的 Session](2026-09-21-archive-stops-running-session-work.zh.md)）。Schedule 提供方原先回答的是其归属 runtime 对活会话日志的 fold，因此只有带活 Agent 的 Session 才报告 `schedule` 族，停止也走管理 `delete` 路径。

宿主任务存储在 Schedule 领域文档中，且比其 Session 的 Agent 活得更久（[存储决策](../architecture/2026-09-16-host-schedule-storage.zh.md)），因此那个 fold 已不存在：`ScheduleRuntime.activeRecords()` 已经移除，已存储的任务表是到期提醒唯一能被看见的地方。存储行仍被武装的冷 Session 因此什么也不报告，归档时不会弹出运行态才会弹出的确认对话框，也没有人被告知宿主会继续保留哪条提醒。

## 决策

Schedule 提供方从已存储的宿主任务行回答归档准入，并由停止删除这些行。`workspace/session-activity` 读取 `list({ sessionId })`——绑定到该 Session 且状态为活动的已存储行——把它们作为 `schedule` 族报告，每条任务一项、携带其已存储 id 与 title，并把该族前插到 `next()` 的结果之前，使其他提供方保留各自条目。`workspace/session-stop` 在与工具相同的串行队列的一个槽位里直接删除这些行，因此停止会排在写入尚未完成的创建之后，不会漏掉那个创建即将提交的行；它会尝试每一行，因为留下的行仍会触发；对已经落地的行先通知观察者，再把首个失败交给调用方。是否存活从不参与判断：存储行仍被武装的空闲或冷 Session 会拒绝归档，确认对话框会准确列出这些提醒。两个监听器注册在同一个名为 `schedule.archiveAdmission()` 的 effect 中，卸载插件即一并撤回。

## 已考虑的备选

**只由活着的 Session 报告 `schedule` 族。** 已存储的任务才是权威，且比其 Session 的 Agent 活得更久，因此以存活为条件会让存储行被武装的冷 Session 静默归档，其到期行随后投递进一个被门禁以 `blocked` 收口的回合，在没有模型步的情况下消耗掉这次触发。两种做法在准入上都只需一次读表。

**每行都走公开的管理 `delete` 路径删除。** 在已经持有该槽位的串行队列内部再次进入队列会自锁，因此停止自己删行：同样的持久化变更，每次停止一次通知、一次计时器重算，而不是每行各一次。

**在 runtime 侧保留该 Session 活动任务的镜像。** 镜像会重复权威文档、在重启后漂移、并随 Agent 一起消失——而这正是准入必须仍能回答的情形。

## 后果

准入的代价是一次读已存储的表，而没有活 Agent 的 Session 也能拒绝归档：看起来安静的 Session 现在可能因为其已存储提醒仍被武装而要求确认。停止逐行删除——领域表不提供批量删除——因此删到一半失败时，先前删除已提交；观察者会被告知这些，每一行都已被尝试，首个失败仍交给调用方。由此剩下一处残余：在归档写入与停止之间崩溃，会在已归档的 Session 里留下仍被武装的已存储行；取消归档时它们再次出现；当这类行的目标时刻过去，Schedule runtime 会按自己的定时器选中它并自行 resolve 该 Session 的 Agent——这一步没有门禁，只有 `agent/pre-step` 拒绝模型步——一次性提醒于是把 follow-up 投递进一个被门禁以 `blocked` 收口的回合，该次触发在没有模型步的情况下被消耗。接缝本身未变：workspace 包仍然不认识 Schedule 词汇，而这个提供方只拥有提醒。
