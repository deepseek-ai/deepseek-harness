---
kind: upgrade-guide
description: "list_agents 改为返回共享容量和 agents 数组，不再直接返回数组。"
---

# 通过 agents 读取 list_agents 成员

[English](guide.md) | 中文

## 变更

`list_agents` 的结构化结果从成员数组改为 `{ running, limit, agents }`。直接遍历结果的调用方须改用 `result.agents`。文本结果在原有成员行前增加一行容量信息。

`running` 统计调用方所在树的已占用子代理槽位，包含启动中、空闲驻留、停止中和外部子代理。它不包含根代理；降低上限后，数值可能超过 `limit`。容量查询仅反映当前情况，不预留名额。

## 迁移

1. 在消费 `list_agents` 结果的代码中，将遍历 `result` 改为遍历 `result.agents`；成员字段保持不变。
2. 通过 `result.running` 和 `result.limit` 获取容量，不要通过成员行数或 `status` 统计占用量。
3. 确认空树返回 `running: 0`，并在 `agents` 中列出根代理；存在活跃外部子代理时，容量占用增加，即使该子代理不在成员列表中。
