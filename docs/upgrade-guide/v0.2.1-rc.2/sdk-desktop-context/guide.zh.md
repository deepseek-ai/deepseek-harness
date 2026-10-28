---
kind: upgrade-guide
description: 现有 SDK profile 包含原生桌面工具和模型上下文。
---

# SDK 桌面工具与上下文

[English](guide.md) | 中文

## 变更

现有 `sdk` profile 现在包含 `present`、`ask_user_question`、定时任务工具、文件引用说明和时间上下文。它不启动 Web server。默认仍使用原生工具执行；通过[执行器 overlay](../tool-executor-plugins/guide.zh.md) 选择 PTC。`sdk-minimal` 保持不变。

## 迁移

1. 继续选择 `sdk`。通过 `onUserQuestion`（TypeScript）或 `on_user_question`（Python）使用原生协议回答内建问题，或保留进程内的 `user-questions/request` 回答方；没有回答方时，工具报告 `NO_PROVIDER`。
2. 工作目录和模型仍来自 SDK 初始化。SDK profile 不挂载 Web 专用的 checkout 和 GUI 开发上下文。
3. 需要保留之前模型可见工具/上下文组合的自定义配置，可以禁用 `present`、`tool-ask-user`、`tool-schedule`、`file-reference-local`、`deliverable-file-references` 和 `time-context` 配置项。升级前请检查固定的提示词和工具 schema。
