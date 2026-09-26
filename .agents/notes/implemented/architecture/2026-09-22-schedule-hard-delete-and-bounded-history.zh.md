# Agent Note: Schedule 删除任务行并限制投递历史

Status: implemented

[English](2026-09-22-schedule-hard-delete-and-bounded-history.md) | 中文

## Problem

Schedule domain 是后端每次变更都会重写的单个整 unit JSON 文档，因此任务行中保留的每个字节都会随每次写入增长。已保存的发送记录没有上限：每次确认都会向数组追加，而被删除的任务会保留其行与记录，以便已打开的详情仍能读取。于是文档大小随任务的投递次数变化，删除还引入了一个所有读取方都必须跳过的状态。

## Decision

删除是硬删除。`ScheduleService.delete` 通过 `tasks.delete` 移除存储行，因此任务停止调度、离开 `list` 与 `catalog`，`history` 对相同的 `(sessionId, id)` 返回 `schedule_not_found`；该行已保存的投递记录随行一并移除。任务 schema 没有 `deleted` 字段，也没有任何界面提供回收站或读取已删除任务记录的能力。

投递历史受插件 `Config` 限制：`deliveryHistoryDays`（默认 30，1–3650）与 `deliveryHistoryRecords`（默认 200，1–10000）。`appendDelivery` 在唯一的写入路径上同时应用这两个上限。它保留 `deliveredAt` 不早于「本次追加回执的 `deliveredAt` 减去配置的天数窗口」的记录，在其中保留最新的 `deliveryHistoryRecords` 条，并始终保留本次追加的最近一次回执；发生裁剪时设置 `earlierRecordsUnavailable` 和 `earlierRecordsPruned`，后续追加会保留这两个标志。后者在存储行中可选，用于确认实际删除；仅有旧格式的不可用标志不表示发生过裁剪。历史响应携带当前保留上限，客户端仅在加载完最后一页且历史非空、确认裁剪时显示清理提示。

[Host-owned scheduled messages](2026-09-16-host-schedule-storage.zh.md) 笔记保留其余决策：唯一的权威版本 1 任务 domain、只为活动任务恢复定时器、通过 Session controller 投递到冷会话、目录与详情界面，以及历史解码器与宿主解码器的划分。其状态词汇为 `active` 或 `inactive`；`inactive` 是唯一的非活动名称，客户端筛选行为全部、活动和未运行。该笔记保持活动状态：这是一次部分取代，因此它既未归档也未冻结，仍是上述内容的归属笔记，而它记录的删除与保留决策由本笔记取代。

## Alternatives considered

**保留带 `deleted` 标志的任务行。** 该标志的存在是为了让 `history` 在删除后仍能回答。删除后没有任何代码读取这些记录，而该行把每个提示文本快照都留在存储文档中，还必须手工把它排除在 `list`、`catalog` 和定时器之外。移除该行让删除只有一种含义。

**只按条数设上限。** 仅有条数上限时，投递稀疏的任务会保留任意久远的回执，投递密集时又会丢弃近期的一批回执。天数窗口限制陈旧程度，条数上限限制文档大小。

**以任务而非每条回执为窗口起点。** 把窗口锚定在任务的创建时间或已提交目标上，会丢弃旧任务刚写入的回执。从本次追加回执的 `deliveredAt` 向前计算，使窗口锚定在所要保留的数据上。

**保留无上限的历史，由运维清理。** 该 domain 每次写入都发布整个 unit 文档，因此无上限的历史会让存储文档的大小随投递次数增长。保留上限是存储布局所要求的约束，而不是保留策略偏好。

## Consequences

删除不再提供恢复能力：已删除任务的已保存投递无法再读回，仍需要完整历史的必须在删除前读取。配置的保留策略也会丢弃任务曾经拥有的回执；保留的标志记录窗口发生过裁剪，而不是假装历史完整。

换取的是：持久任务集合只有一种删除语义，存储文档大小由配置而非投递次数决定，且 `inactive` 是唯一的非活动生命周期名称。当某个部署需要更长的投递历史时，应提高插件 `Config` 中的上限。
