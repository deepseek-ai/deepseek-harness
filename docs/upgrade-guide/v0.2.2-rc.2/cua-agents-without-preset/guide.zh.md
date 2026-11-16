---
kind: upgrade-guide
description: "以 preset ID 配置的原生 CUA 提供方现在为未组合 Agent preset 的 Agent 提供 cua_run_code 工具。"
---

# CUA 为未组合 preset 的 Agent 提供 `cua_run_code`

[English](guide.md) | 中文

## 变更

原生 CUA 提供方的 `agentPreset` 为 preset ID（包括默认值 `ptc`）时，以前不为未组合 Agent preset 的 Agent 注册工具，在不包含 preset 注册表的组合中则完全不注册。这类 Agent 现在获得 `cua_run_code` 及其操作指引。使用所配置 preset 的 Agent 仍获得原始 `cua`，使用其他 preset 的 Agent 仍获得 `cua_run_code`，`agentPreset: false` 仍全局注册原始 `cua`。

受影响的是创建 Agent 时不组合 preset 的 Host：`sdk`、`sdk-minimal`、`headless` 和 `acp` profile，以及自定义组合。Web 和 Desktop 会话都会组合 preset，行为不变。受影响的组合如果直接或通过 Computer Use 组合包以 preset ID 挂载该提供方，会观察到：

- 模型请求增加 `cua_run_code` 的 schema 和 CUA 指引。
- 创建 Agent 时等待提供方的专用程序运行时；该运行时或 `workingDirectory` 服务不可用时创建失败，例如报告 `CUA program tool is unavailable`。
- Host 挂载 `@deepseek-ai/dsh-tool-executor-ptc` 时，程序在 `run_code` 中看到 `tools.cua_run_code`。

## 迁移

1. 如需保留原始 `cua`（直接调用，或在 PTC 工具执行器下作为 `tools.cua` 调用），在 profile patch 或 overlay 的提供方条目 `config` 下设置 `agentPreset: false`，保留其他字段。
2. 如需让这些 Agent 不使用 Computer Use，禁用提供方条目，或在该 profile 取消选择 Computer Use 组合包。
3. 启动一个会话，确认模型的工具列表：默认包含 `cua_run_code`，执行第 1 步后包含 `cua`，执行第 2 步后两者都没有。
