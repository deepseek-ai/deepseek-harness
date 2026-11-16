---
kind: upgrade-guide
description: "进程内可续聊子 agent 的初始委派任务改为记录成来自父 agent 的 agent-message，不再是 user 消息。"
---

# 子 agent 初始任务改为 agent 消息

[English](guide.md) | 中文

## 变更

由 `subagent-spawn-in-process` 或 `subagent-fork-in-process` 启动的进程内可续聊子 agent，把初始委派任务记录为来自父 agent 的消息。其 `user/message` 的 source 从 `{ "kind": "user" }` 变为 `{ "kind": "agent-message", "form": "relay", "senderSessionId": "<父级 Session id>" }`，正文在任务内容块之前多一个文本块 `Agent <parent name> sent a message: `。子 Session 日志、SDK Session 事件通知和 Python SDK 结果都使用新形式。升级前写入的 Session 保持旧形式。

把 `user` 来源当作真人输入的使用方不再作用于该任务：任务中的 `$skill` 不再加载 skill，任务中的 Session 引用不再展开，Markdown 导出与 turn 大纲不包含该任务，没有真人消息的子会话不再生成回退标题。真人直接发给子 agent 的消息保持 `user` 来源和原文。

## 迁移

1. 如果代码把子会话的第一条 `user` 来源消息当作任务，改为匹配 `senderSessionId` 等于子 Session `parentSession` 的 `agent-message` 来源，并去掉第一个内容块后读取任务文本。对升级前写入的 Session 仍接受 `user`。
2. 如果委派任务依赖 `$skill` 加载 skill，改为在任务中写明 skill 名称，由子 agent 调用 `skill` 工具。
3. 启动一个可续聊子 agent，确认其第一条非上下文 `user/message` 使用 `agent-message` 来源并带有发送方前缀。
