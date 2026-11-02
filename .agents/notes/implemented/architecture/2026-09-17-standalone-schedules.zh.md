# Agent Note: 独立计划任务与 Session 目标

Status: implemented

[English](2026-09-17-standalone-schedules.md) | 中文

## Problem

宿主任务需要全局管理和显式执行目标，并在工作区中可辨认。

## Decision

存储领域、导入器、占位 RRULE 和并行 API 决策由[带类型规则存储与共享重复计算](2026-10-21-schedule-rule-storage.zh.md)替代。保留现有 `schedule` 领域和统一管理 API；下述目标、执行和通知决策保持有效。

目标分为 `session`、`new_once` 和 `new`。`session` 存储一个现有 Session id；创建和编辑会在不激活该 Session 的情况下检查它存在且不属于被委派的子 Agent。`new_once` 在创建任务或重新指定目标时预留 Session id，在首次投递时创建该精确 Session，然后转换为 `session`。`new` 在每次创建尝试前把预留的 Session id 保存在 `pendingDelivery` 中，因此投递失败后的重试使用同一 Session。新建 Session 使用目标中的工作目录和 Agent preset，未提供时使用 Host 默认值。目标指定工作目录时，该 Session 加入在该目录注册的 Workspace（若存在）。该 Session 尚无标题时以任务标题命名；`new` 目标再加上该 Session 的创建时间（精确到分钟，按规则 `DTSTART` 的时区），例如 `Weekday digest · 2026-10-12 09:00`，以便区分各次投递创建的 Session。加入或命名失败只记录日志，不阻止投递。`involvedSessionIds` 按首次参与顺序列出创建和编辑任务的 Agent Session，以及每个现有或预留的目标 Session；`new` 目标创建的 Session 不列入其中。

运行时保留仅补发最新发生时点的行为。它投递不晚于投递判断时刻的最新发生时点，并推进到下一个未来发生时点；耗尽的规则以 `ended` 状态保留在存储中，暂停的任务没有计时器。同一任务的每次投递，无论定时还是立即执行，都在上一次投递的发生时点之后至少 60 秒，立即执行的发生时点是其运行时间；`new` 目标的每次投递都会创建 Session，部署可通过 `newSessionIntervalSeconds` 加大该间隔，默认 60。下一个已存储发生时点满足该间隔时，最小投递间隔从上一次发生时点起算，否则从上一次确认时间起算，因此确认延迟不会累积，延迟的投递也不会推移之后的发生时点；下一个准时的发生时点随后可能在延迟投递之后不足一个间隔到来。投递到复用 Session（`session` 或 `new_once`）的任务在目标 Agent 空闲之前一直占用其执行槽位，期间到期的发生时点合并为之后的一次投递，因此该 Session 最多有该任务的一次待处理投递；`new` 目标不占用槽位，各次启动并行运行，彼此之间只隔投递间隔。目标为 `session` 的到期任务按目标 Session 共享一条消息，After 和 At 任务除外。立即执行与定时投递共用目标解析、投递间隔、Session 收件箱持久化、回执与相关 Session 更新，但保留下一发生时点和状态。二者都拒绝已归档的目的 Session，包括重试时复用的预留 Session，因为已归档会话门禁会阻止该消息唤醒的轮次。Session 收件箱持久化先于任务回执写入，因此两个存储之间崩溃可能重复消息。实现不增加 scheduler、run 或 ownership service。

create、update 或 delete 提交后，Schedule 在独立的链上排队一条变更通知，因此 Session I/O 不会占用变更与投递队列。除操作者之外、Agent 已加载的每个相关 Session 都会收到一条供下一个模型步骤读取的 `schedule` 来源消息，该消息不会启动模型轮次，因此 Session 空闲期间排队的通知会随其下一条输入到达模型，而不会各自作为一个模型轮次运行；消息说明变更类型，并以 JSON 字符串携带任务 id 和标题。没有已加载 Agent 的 Session 不会收到消息，会在下次列出任务时读取当前任务。通知失败会记录日志，但不会回滚已提交的变更。关闭时先排空已排队的通知，再关闭存储。

## Alternatives considered

**要求调用方提供计划任务 id。** 用户可见标题与规范身份用途不同，但接受 id 会暴露冲突与校验策略。Host 生成身份并返回，供后续操作使用。

**保留创建者 Session 所有权。** 所有权会让 list 与 mutation API 保持作用域限制，并与全局管理、重新指定目标和 Session 创建策略冲突。历史参与关系是元数据和通知路由，不是授权。

**通过抽样即将到来的发生时点检查间隔。** 每次发生时点查询都从 `DTSTART` 开始枚举，因此起始时间较早的高频规则会在抽样检查拒绝它之前阻塞 Host 线程，而且抽样无法约束完整序列。改为在枚举之前做静态规则检查，并用每个任务的投递间隔约束间隔。

**增加 scheduler、run 和 notification service。** 现有 Schedule service、存储领域、runtime 和 Session 控制器已按所需规模承担这些职责。新层级只会增加间接性，不改变持久性。

**让新建 Session 保持无标题且不属于任何 Workspace。** 这样的 Session 会作为又一个无标题 Session 出现在拥有其目录的 Workspace 之外，用户无法分辨是哪个任务创建了它，也无法分辨对于 `new` 目标它接收了哪一次投递。加入目标目录处的 Workspace，并以任务标题命名 Session（`new` 再加创建分钟），不需要存储字段。失败只记录日志，因为投递优先于呈现。

## Consequences

任务寿命长于 Agent，并按 id 管理。归档准入报告活动 Session 目标；显式停止删除任务。宿主可用性、跨存储至少一次投递、尽力通知和每次新建目标的无界并发仍是限制。[Schedule 参考](../../../../docs/subsystems/schedule.zh.md)拥有精确的当前契约，[管理升级指南](../../../../docs/upgrade-guide/v0.2.2-alpha.2/schedule-remote-host-tasks/guide.zh.md)说明调用方变更。
