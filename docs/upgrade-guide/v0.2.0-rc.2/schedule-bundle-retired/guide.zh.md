---
kind: upgrade-guide
description: "“自动化任务”可选 bundle 已移除；Web 组合自行挂载 Schedule。"
---

# “自动化任务” bundle 已移除

[English](guide.md) | 中文

## 变更

在 v0.2.0-rc.2 中，在插件管理页开启“自动化任务”会把 `@deepseek-ai/dsh-experimental-schedule-bundle` 追加到 `$DSH_HOME/profiles/<name>/package.json` 的 `dsh.profile.bundles`。该 bundle 插入 `time-context`、`schedule` 和 `ui-schedule` 三行。

下一版本移除该 bundle。`@deepseek-ai/dsh-web-app` 在每个 Web profile 中挂载 `schedule` 和 `ui-schedule`，`standard`、`cordis` 和 `ptc` preset 声明时钟读数和四个 `schedule_*` 工具；`minimal` 两者都不声明（[详情](../../../subsystems/schedule.zh.md)）。

加载 profile 时会从其 `dsh.profile.bundles` 中删除 `@deepseek-ai/dsh-experimental-schedule-bundle` 并重写 `package.json`；其他 manifest 字段保持不变。已存储的任务和投递记录仍保留在磁盘上并继续使用。

## 迁移

1. 用每个受影响的 profile 启动一次 `dsh`，无需手动编辑。由其他工具写入的 profile 目录需要自行从 `dsh.profile.bundles` 删除该条目。
2. 保留 `cordis.patch.yml` 或 `--patch` overlay 中针对 `schedule` 和 `ui-schedule` 的覆盖项；Web 组合包含这两行。顶层针对 `time-context` 的覆盖项不再匹配任何行，因为时钟行属于 preset（[time-context](../../../../packages/context/time-context/README.zh.md)）；请删除它。
3. 确认：`dsh.profile.bundles` 不再列出该 bundle，插件管理页不再显示异常的“自动化任务”条目，且侧栏显示“自动化任务”并列出之前存储的提醒。
