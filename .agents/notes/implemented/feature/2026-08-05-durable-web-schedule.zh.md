# Agent Note: 持久定时提醒

Status: implemented

[English](2026-08-05-durable-web-schedule.md) | 中文

[Host 拥有的定时消息决策](../architecture/2026-09-16-host-schedule-storage.zh.md)拥有任务存储、timer 激活、投递、发送记录和任务目录。本记录拥有在该决策之下仍然成立的两个时间决策——显式绝对时间边界与有界固定速率计算——以及二者共有的队列准入边界。

## 问题

在对话中创建的提醒必须始终归属于确切的那个 Session，并且跨进程重启存活。繁忙的 Agent（智能体）、长等待、墙钟变化、cold Session 和持久化失败使简单 timeout 无法满足要求。绝对日历输入与重复唤醒带来两个计时问题，而存储与激活方式的选择并不能回答它们：当重复规则不保存时区时，绝对时间意味着什么；固定间隔在停机后如何追赶，而不重放每一个错过的发生时点。

## 决策

### 显式绝对时间边界

自然语言解释与 Schedule 解析被有意分开（[时区简化](../simplification/2026-08-09-explicit-schedule-time-zone.zh.md)）。每条浏览器提示词只在其对应的持久 user message 上携带由 Host 校验过的 IANA 时区。Time-context 会告诉模型，把未明确限定时区的日期和时间解释为该时区。Schedule 既不导入该插件，也不存储 Session 时区：模型必须把其解释结果转换为带偏移量的 RFC 3339 值，或带显式 `time_zone` 的本地对象。

Schedule 会校验精确的日历形状、偏移量、时区名称，以及严格位于未来、年份为四位数的时点。结构化本地时间落在夏令时缺口内会被拒绝；遇到重叠时选择第一次出现的较早时点。一次性 `at` 或 `after` 记录只存储规范化的 UTC `scheduledAt`，不存储输入的偏移量、本地字段或时区。`daily`、`weekly` 或 `cron` 记录则存储规范化后的本地规则及其显式 `timeZone`（[时间选择器](../../../../packages/schedule/schedule/README.zh.md)）。

### 有界固定速率语义

Every 是固定时长间隔，而不是日历规则。其首个目标是创建时刻加上该间隔。作出到期决策时，整数除法选出不晚于所采样墙钟的最新序列点，以及其后的第一个序列点。选中的发生时点只呈现一次，记录直接推进到未来目标，因此 cold Session 绝不会积累回放任务，延迟执行的模型工作也绝不会使该序列漂移。同一 Session 内到期的 Every、Daily、Weekly 和 Cron 记录共用一条消息，每条记录只贡献其最新一次发生时点（[存储与投递](../architecture/2026-09-16-host-schedule-storage.zh.md)）。

至少五分钟的下限约束唤醒与模型请求频率。系统不存在跨记录的冷却、门控、配额或保留的批次时间戳。如果下一个序列点会超出四位年份存储范围，dispatch 会终结该记录。

### 队列准入不是完成

dispatch 记录的是队列准入，而不是模型完成或用户收到提醒。framing 构造或同步入队失败不会追加 dispatch。follow-up 获得准入后、持久回执前发生崩溃，可能使提醒在恢复后重复；本设计不作 exactly-once 承诺。

## 已考虑的替代方案

**使用 `ctx.jobs`。** Task 拥有进程本地工作、结果和通知，而不是持久任务状态和对话 follow-up。

**持久化 Session 时区并推断本地 `at`。** 这会让一个解释默认值扩散到 Session core、Host create／fork、持久化格式、client 和不匹配恢复中。请求本地的模型指导与显式工具边界消除了这种耦合。

**在 `followup()` 前认领 dispatch，或增加 exactly-once fencing。** claim-first 会在入队失败时静默丢失提醒。跨进程 exactly-once 需要 lease、outbox、acknowledgement 与下游幂等边界，超出了本设计范围。

**为固定间隔增加通用周期规则引擎。** 固定时长间隔只需要锚点运算。共享的周期抽象、全局准入门控和日历求值器会扩大回放与运行时状态，却不能服务于固定速率行为。cron 选择器是独立的钟表规则，拥有自己的 Host 所有方言与求值（[cron 输入](../../../../docs/subsystems/schedule.zh.md#cron-wall-clock-input)）。

## 验证

包测试以逐文件 100% coverage 固定固定速率计算、创建锚点、只追赶最新一次、批次选择、IANA 校验、夏令时缺口与重叠以及时间边界。属性测试会在不同间隔与跳过跨度下比较 Every 计算与回放。

## 后果

- 无需持久 Session 时区状态或从 Schedule 到 time-context 的依赖，绝对时间输入仍然具有确定性。
- 固定间隔始终与其创建锚点对齐，每条逾期记录只呈现一个发生时点，且不会积累回放任务。
- 投递绝不会夸大模型成功或 acknowledgement；队列准入与持久回执之间发生崩溃可能使消息重复。
