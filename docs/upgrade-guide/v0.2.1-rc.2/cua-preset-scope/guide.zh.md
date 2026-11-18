---
kind: upgrade-guide
description: "独立原生 CUA 组合需要显式选择全局工具注册。"
---

# CUA 默认使用 PTC 会话作用域

[English](guide.md) | 中文

## 变更

原生 CUA 提供方的 `agentPreset` 默认为 `ptc`。工具注册到已有和新建 PTC Agent，即使保存的应用授权配置没有这个新字段也会生效。不包含 Agent preset 注册表的自定义组合不再默认获得全局 CUA 工具。

## 迁移

1. 使用标准 Computer Use 开关时保持默认值，已有应用授权仍可使用。
2. 独立组合若需要全局工具，在 profile patch 或 overlay 的原生 CUA 条目 `config` 下添加 `agentPreset: false`，保留 `allowedApps`、`helperPath` 等其他字段。
3. 重启或等待 HMR 应用后，确认目标 Agent 能在原生模式或 PTC SDK 中使用 `cua`。
