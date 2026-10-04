# Agent Note: 投递的提醒以「用户安排的定时消息」为固定文本

Status: implemented

[English](2026-09-24-scheduled-message-framing.md) | 中文

## Problem

到期的提醒以生产者 kind 为 `schedule` 的 user-role 消息进入其原 Session。在本决策之前，两个渲染器都用一句关于如何处理其载荷的固定指令开篇：单次投递要求模型把 `reminder_prompt_json` 作为不可信的提醒内容呈现、而不是新的用户指令；周期批次投递对 `reminders_json` 中的每个 `reminder_prompt` 提出同样的要求。于是这条消息断言自身内容不可信，而没有说明它来自哪里。

## Decision

[`packages/schedule/schedule/src/domain.ts`](../../../../packages/schedule/schedule/src/domain.ts) 中的 `renderReminderFraming` 与 `renderRecurringReminderBatchFraming` 都输出同一条固定行，即模块常量 `SCHEDULED_MESSAGE_FRAMING`：`This is a scheduled message from the user`；它是该块的第二行，位于方括号标记（`[SCHEDULE REMINDER]`、`[SCHEDULE REMINDER BATCH]`）之后。动态字段行不变：单次消息仍追加 `schedule_id_json`、`occurrence_at`、`reminder_prompt_json`，周期批次仍追加 `reminders_json`。

这条固定行说明消息的来源：绑定到该 Session 的一条定时任务。模型读到固定块中带有它的 user-role 消息时，会把随后的提醒载荷（单次消息的 `reminder_prompt_json`、批次的 `reminders_json`）当作用户安排的内容，而 Host 无法证明该文本由用户键入：`schedule_create` 与 `schedule_update` 允许模型写入提示词，模型写入的提示词可以带上模型从网页、文件或命令输出中读到的文本。旧固定行把该载荷标记为不可信，本决策有意去掉这一指令，因此接受「模型生成的文本以用户来源行投递」这一残留风险。再引入条件：一旦出现经由模型写入提示词完成注入的实例，就恢复一句把载荷限定为提醒文本、而非新指令的说明；包内五处固定断言与 Web e2e 的 `expectReminderFraming` 是「此类改动必须是有意为之」的检查。固定行无法被动态字段伪造，这由编码保证：schedule id 与提示词是 JSON 字符串，发生时点是经校验的规范 RFC 3339 值，且各自只占一行，因此带有换行或形如 `occurrence_at:` 的提示词无法向该块增加固定行。[Host 拥有的定时消息](2026-09-16-host-schedule-storage.zh.md) 记下的其余决策不变，包括通过 Session controller 投递以及保存的投递记录。

## Alternatives considered

**保留「不可信内容」指令。** 它断言提示词是不可信输入，而投递的消息并不需要这一断言：提示词写在绑定该定时任务的 Session 内——由模型通过 `schedule_create` 与 `schedule_update` 写入，或由用户在 Web 任务详情中写入——投递本身就是该 Session 中的普通 user-role 消息。

**只改周期批次那一行。** 单次与周期投递会对同类消息的来源给出不同说法，此后每次改措辞都要分别改两个渲染器。现在两条路径读同一个常量。

## Consequences

两个投递路径的模型可见提醒文本都改变，因此在该决策之前记录的 Session 日志重建出的是旧的固定文本；Web 中渲染该投递消息的通知在展开时显示新的一行。其余不动：没有 session 事件、存储字段、客户端代码、协议或持久化格式变化，投递文本仍可从日志重建。

提示词文本不携带作者保证。它写在绑定该定时任务的 Session 内——由模型通过 `schedule_create` 与 `schedule_update` 写入，或由用户在 Web 任务详情中写入——模型创建的提醒可以把模型从网页、文件或命令输出中读到的文本原样写入。任务的 Session 绑定限定的是哪个 Session 的模型能访问该任务；它不是调用方鉴权，也不说明提示词内容的来源。本决策中记下该残留风险与再引入条件。

没有录制会话快照覆盖提醒投递，本次也没有新增：已提交夹具中没有 `schedule` 消息，`snapshots/web/schedule-catalog` 只记录任务查询。构成该夹具还缺两项 harness 能力：没有场景补丁能控制 `packages/schedule/schedule/src/runtime.ts` 读取的墙上时钟；快照 harness 播种的是 Session，而不是承载 Host 任务的 schedule storage domain，那些任务行只在 Web 测试里手工写入。因此本次记录缺失的 harness 支持，而不新增夹具。投递文本改由 `packages/schedule/schedule/tests/{domain,daily,weekly,cron}.spec.ts` 中五处整串断言，以及 `apps/web/tests/schedule-after.e2e.ts` 中在装配后请求上断言该行、覆盖单次与周期两条路径的 `expectReminderFraming` 固定。
