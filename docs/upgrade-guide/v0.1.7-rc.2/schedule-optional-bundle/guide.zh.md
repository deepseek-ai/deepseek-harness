---
kind: upgrade-guide
description: "Web 组合不再包含 Schedule 的三行；改由“自动化任务”可选 bundle 插入。"
---

# Schedule 移入“自动化任务”可选 bundle

[English](guide.md) | 中文

## 变更

在 v0.1.7-rc.2 中，`@deepseek-ai/dsh-web-app` 以 `disabled: true` 包含 `time-context`、`schedule` 和 `ui-schedule` 三行。在插件管理页或手动开启 Schedule，会向 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 或 `--patch` overlay 写入按 id 定位的覆盖项，例如 `- id: schedule` 加 `disabled: false`。

下一版本从 Web 组合中移除这三行。插件管理页“官方”分组中的“自动化任务”，即 `@deepseek-ai/dsh-experimental-schedule-bundle`，负责插入它们。每个安装都自带该 bundle，默认关闭。

按 id 开启 Schedule 的 profile 升级后会失去 Schedule：loader 警告 `patch: entry schedule not found`（`time-context` 和 `ui-schedule` 同理），`schedule_*` 工具和自动化任务页面消失，已存储的提醒不再投递。已存储的任务和投递记录仍保留在磁盘上。

## 迁移

1. 打开插件管理页，在“官方”分组中找到“自动化任务”并开启。开关会把 `@deepseek-ai/dsh-experimental-schedule-bundle` 追加到 `$DSH_HOME/profiles/<name>/package.json` 的 `dsh.profile.bundles`；手动维护的 profile 需自行添加该条目。
2. 保留为 `schedule`、`time-context` 或 `ui-schedule` 设置其他字段的覆盖项，例如 `deliveryHistoryDays`；bundle 插入这些行后它们重新生效。只设置 `disabled: false` 的覆盖项已无作用，可以删除。
3. 确认：重启 `dsh web`，检查启动日志中这三个 id 不再出现 `patch: entry ... not found` 警告，且侧栏显示“自动化任务”并列出之前存储的提醒。
