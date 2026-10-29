---
kind: upgrade-guide
description: "普通 Session fork 停止记录来源关系，也不再显示为子代理。"
---

# 普通 fork 是独立 Session

[English](guide.md) | 中文

## 变更

普通 fork 复制选定历史并独立继续运行。它们省略 `SessionHeader.parentSession` 及客户端的 `parentSessionId`，不写入替代来源字段。子代理（包括使用 fork backend 的子代理）保留直接创建者。已有日志保留记录中的元数据。

SDK 的 `subagent.started` 排除普通 fork，包括携带父 ID 的历史会话。ACP 列表和恢复允许普通 fork；通过 cwd 和 preset 检查的普通 fork 也可由 headless 沿用。客户端列表不再将它们缩进，也不再把新发现的 fork 插到来源之前；已保存的手动位置保持不变。基于来源的追踪查询、父关系筛选、遥测和远端日志无法还原新普通 fork 的来源。工作区绑定、可选标题递增、继承历史和 seed 边界仍然可用。

Session 格式保持 V4。旧 V4 reader 可能将包含继承投递确认的无父关系 fork 作为损坏日志拒绝，报错为 `current-generation delivery marker names the wrong Session`。已测试的 reader 在授予句柄或截断文件之前拒绝，不提供专门的升级诊断。参见[兼容性决策](../../../../.agents/notes/implemented/architecture/2026-10-23-independent-session-forks.zh.md)。

## 迁移

1. 在恢复新建 fork 之前，升级共享 Session 目录的全部 reader 和 writer。不要编辑旧 header 或删除投递记录来绕过旧 reader 的拒绝。
2. 将消费方中把任意 `parentSession` 视为子代理的检查替换为 `origin === 'subagent'`。继续运行仍要求来自 Session 自身事件区间的有效 descriptor；继承的 descriptor 不建立其身份。
3. 移除依赖持久化来源追踪的普通 fork 工作流。工作区选择等依赖来源的动作保留在 fork 操作期间。
4. 确认普通 fork 不含父字段、携带继承投递记录也能在重启后恢复，且不产生 `subagent.started`；确认真正子代理保留创建者及通知。
