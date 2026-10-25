---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-19-session-team-mode

[English](2026-10-19-session-team-mode.md) | 中文

## 概述

通过必读的 team/mode 事件记录根 Session 的智能体团队选择。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-19-session-team-mode
baseline: false
changes:
  - root: "event:team/mode"
    previous: null
    after: "920d87e22b7409bcc7224f8b1dc7f5101c33574c75627c65baab12b85cc96e75"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有 V4 日志仍可读取。没有显式选择时，历史任务使 Team 开启；没有历史任务时保持关闭。旧读取器拒绝未知的必读 team/mode 判别值，避免静默恢复错误模式。普通分叉忽略继承的模式选择，初始保持关闭。不修改已有载荷或 Session 头部版本。

<a id="verification"></a>
## 验证

197 个 Team、工具、模型菜单和客户端定向测试通过；Web 开关与任务板场景的 8 个测试通过。team-session-mode 的 headless 和 TypeScript SDK 人工编写快照覆盖开关命令；Python SDK 原始事件投影保留两次选择。

<a id="dev-note"></a>
## 开发备注

无。
