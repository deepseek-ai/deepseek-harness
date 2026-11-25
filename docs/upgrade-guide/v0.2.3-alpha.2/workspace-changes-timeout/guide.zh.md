---
kind: upgrade-guide
description: "workspace-changes.timeoutMs 默认值由 30000 改为 3000，单条 git 命令超过 3 秒的轮次不再显示改动文件卡片。"
---

# 工作区改动记录在 3 秒后放弃 git 命令

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-workspace-changes` 插件在 `timeoutMs` 后终止 git 命令，原默认值为 `30000`，现在为 `3000`。工具调用会等待轮初快照，因此工作目录里有大量未忽略的未跟踪文件时，每次工具调用不再卡住最多 30 秒；快照或 diff 命令超过 3 秒时，该轮不记录改动，Web 也不显示该轮的改动文件卡片。从卡片打开的单文件对比同样在 3 秒后放弃。

受影响的是单条快照命令需要 3 秒以上的仓库的 Web 与 Desktop 用户，例如含大量未跟踪内容、磁盘缓存为冷或文件系统较慢。在 `workspace-changes` 条目上显式设置的 `timeoutMs` 保持不变。

## 迁移

1. 如需保留原上限，在 profile patch `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 中加入 `- {id: workspace-changes, config: {timeoutMs: 30000}}`。此后这类仓库中的工具调用会重新等待最多这么久。
2. 如需保留卡片又不等待，把大的未跟踪目录加入仓库的 `.gitignore`。
3. 用 `dsh --profile <profile> --dump-config` 确认 `workspace-changes` 条目显示预期的 `timeoutMs`。
