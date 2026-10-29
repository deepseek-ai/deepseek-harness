---
kind: upgrade-guide
description: "Schedule 客户端改用统一的宿主管理 API 和带类型时间记录；已有宿主任务保留现有领域和布局。"
---

# Schedule 使用统一的宿主管理 API

[English](guide.md) | 中文

## 变更

Schedule 管理按 id 寻址宿主全部任务。原生与 Remote API 共用一个服务；移除先前按 Session 绑定的 `delete` 和 `update` 方法。原生创建接收带类型的 `timing`，目录结果通过 `kind` 区分 After、At、Every、Daily、Weekly、Cron 和 RRULE。

现有 `schedule` 领域写入版本 2，读取版本 1 时不进行启动写入，保留路由、封套和布局。SQLite 物理 schema 保持版本 1。升级前备份存储：首次成功的 v2 写入将单元标记为 v2，v1 程序会拒绝打开。降级需要恢复该备份。编辑和投递保存当前行，无需独立迁移命令。插件 README 拥有[存储 schema、升级时机与成本](../../../../packages/schedule/schedule/README.zh.md#storage-format)。

## 迁移

1. 原生调用方使用 `create({ title, prompt, timing, target? }, actorSessionId?, signal?)` 和 `edit(request, actorSessionId?, signal?)`。Remote 调用方使用带 `request` 参数的 `schedule/create` 和 `schedule/edit`。Cron 选择器包装为 `{ kind: "cron", cron: { expression, time_zone } }`，RRULE 包装为 `{ kind: "rrule", rrule }`。模型工具参数继续暴露 RRULE。
2. 将按 Session 绑定的删除替换为 `edit({ id, action: "delete" })`；更新替换为 `edit({ id, action: "update", patch, expectedUpdatedAt? })`。时间编辑使用 `patch.timing`。提供读取的版本，或以 `null` 比较缺失版本；遇到 `schedule_conflict` 时重新读取。
3. `list({ active?, limit?, offset? })` 返回宿主范围的 `{ items, shown, total, limit, offset }`。`catalog()` 返回全部任务；`view({ id })`、`history({ id, limit, before? })` 和 `run({ id })` 无需所有者 Session。从 `target` 读取可复用目的地，从 `targetSessionId` 读取每条回执目的地。
4. 使用包根入口或 `/client` 导出的无前缀类型，包括 `ScheduleRecord`、`ScheduleTiming` 和 `ScheduleCatalogEntry`。读取时间字段前先按 `kind` 收窄。用 `paused` 和 `ended` 替代 `inactive`，并允许创建/变更时间戳缺失。根入口助手 `scheduleView`、`decodeScheduleChange`、`foldScheduleEvents` 和 `SCHEDULE_CHANGE_VERSION` 已移除；历史事件类型仍是冻结的数据声明。[工具升级指南](../schedule-agent-tools/guide.zh.md)列出已移除类型及其替代方式。
5. 确认自动化任务显示已有 Cron 和日历任务，且元数据编辑保留其时间规则与历史。历史 Session 日志提醒仍需显式重建；它们不属于本次宿主任务变更。
