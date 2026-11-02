---
kind: upgrade-guide
description: "新会话重新复用工作区内的空白 Session，不再每次都创建新的 Agent。"
---

# 新会话回到其空白 Session

[English](guide.md) | 中文

## 变更

在 0.2.1-rc.2 中，Web 和 Desktop 的新会话，以及不带选项的 `uiWorkspace.startSession(workspaceId)`，每次调用都创建新的 Session 和 Agent（[此前的指南](../../v0.2.1-alpha.1/new-session-generations/guide.zh.md)）。被留下的空白 Session 不在 Session 树中显示，因此其中未发送的草稿无法再回到。

现在新会话复用工作区内第一个未开始、未归档的空白 Session，由 Host 切换到其默认 preset，没有空白 Session 时才创建。带选项的 `startSession`、`openWorkspace` 和 `connectWorkspace` 采用相同规则；指明 Agent preset 的请求会跳过列出其他 preset 的空白会话，因此创造模式入口等 preset 流程不会接管其他 preset 的草稿。

被复用的空白会话若其 Agent 仍在加载状态，会保留创建时的 preset 装配。新会话不再保证使用当前的 preset 定义。

## 迁移

1. 更改 preset 定义后，在 Agent 于更改之后装配的 Session 中开始对话，例如先重启 Host 再使用新会话；重启后恢复的空白会话会按当前定义装配。
2. 不能接管列出其他 preset 的空白会话的客户端集成，向 `startSession`、`openWorkspace` 或 `connectWorkspace` 传入 `{ agentPreset }`。
3. 确认方式：新会话中输入草稿，打开另一个 Session，再使用新会话，应打开同一个空白会话并显示该草稿。
