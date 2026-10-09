---
kind: upgrade-guide
description: "新会话会创建新的 Agent，不再复用已有空 Session。"
---

# 通过新会话创建新的 Agent

[English](guide.md) | 中文

## 变更

在 Web 和 Desktop 中，新会话按当前预设定义创建新的 Session 和 Agent。此前该操作会复用工作区内已有的空 Session，因而可能保留较早的预设定义。

客户端调用 `uiWorkspace.startSession(workspaceId)` 采用相同行为。通过 `openWorkspace` 或 `connectWorkspace` 重连工作区时仍复用符合条件的空 Session。带草稿准备选项的调用保留已有复用与内容规则。已有 Agent 保留其预设组合；切换组合包后，全局可选工具会在其下一次请求时更新。

## 迁移

1. 更改预设定义后，通过新会话创建使用当前定义的 Agent。需要保留原预设组合时，继续使用已有 Session。
2. 重连工作区的客户端集成应使用 `openWorkspace` 或 `connectWorkspace`。准备已有草稿时保留显式草稿准备选项。
3. 确认新 Agent 使用更新后的预设定义；无需重写持久化 Session 文件或 profile patch。
