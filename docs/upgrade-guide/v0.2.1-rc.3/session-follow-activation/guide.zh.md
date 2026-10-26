---
kind: upgrade-guide
description: "Session follow 调用方必须显式请求后台 Agent 激活。"
---
# 跟随 Session 时显式请求激活

[English](guide.md) | 中文

## 变更

`session.follow` 在省略 `activate` 时不再自动恢复冷普通 Agent。它只读取开场快照并跟随后续事件，不进行激活。这会影响通过打开历史流使 Agent 可用的集成。随产品提供的 Web Client 显式发送 `activate: true`，保留原有打开行为。

设置 `activate: true` 时，激活在开场快照计算完成后、交付之前开始；该快照不确认 Agent 已就绪。子会话仍不走普通 Agent 激活。

## 迁移

1. 为需要恢复冷普通 Agent 的 `session.follow` 请求添加 `activate: true`，保留原有 `address` 和历史窗口字段。
2. 被动查看器可以省略 `activate` 或设为 `false`。
3. 确认启用激活的流仍返回开场快照，再单独检查 Agent 是否可用。不要把收到快照当作激活完成。

历史与状态观察行为见 [Session Controller 参考](../../../../packages/api/session-controller/README.zh.md)。
