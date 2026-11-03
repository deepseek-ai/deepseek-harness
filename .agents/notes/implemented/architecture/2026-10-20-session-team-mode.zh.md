# Agent Note: 按 Session 选择 Team 能力

Status: implemented

[English](2026-10-20-session-team-mode.md) | 中文

## Problem

插件级 Team 开关要求用户先修改共享 profile，才能为一个会话选择协作。它可能关闭另一个 Session 的能力，并在会话选项之外留下第二个控件。普通任务仍需要原有工具目录，关闭协作也不能丢弃任务历史或子智能体。

## Decision

基础 bundle 加载 Team 服务与任务工具，Web bundle 加载 Team UI。相关包归属 subagent 与 client 产品组。根 Session 保存的选择控制整棵树的任务工具与 Team 指引，以及根会话中的共享任务板；新 Session 默认关闭。普通 subagent 创建、通信与导航继续可用。

模型与推理等级菜单承载用户选择。根会话的 Subagent 面板在成员下方显示共享任务。关闭 Team 保留日志与子智能体；重新开启恢复任务板。没有保存选择的历史任务板保持开启。profile 加载时移除已停用的可选 bundle 选择，保留配置行覆盖。

无界面部署可设置 `agent-team.defaultEnabled`，在新根会话的启动创建阶段保存初始选择。已保存的选择优先，恢复的 Session 即使没有保存选择也保留原模式。普通分叉独立初始化；子智能体共享当前运行时根的选择。创建阶段通过 Session origin 识别子智能体，因为激活归属在创建监听器结束后才登记。任务访问仍要求当前运行时归属有效。

本决策替代 [Agent Teams](../feature/2026-08-05-agent-teams.zh.md) 中显式选择组合的部分；其持久性、归属与生命周期决策继续有效。[可选 bundle](../process/2026-09-15-shipped-optional-bundles.zh.md)仍约束其他实验性功能。

## Alternatives considered

**保留两个开关。** 安装能力仍是会话控件无法解释或解决的前置条件；用户必须为 Session 决策管理共享 profile 状态。

**在恢复或读取时应用部署默认值。** 修改 profile 将在没有保存选择的情况下改变现有会话的工具。在创建时一次性持久化默认值，可让后续能力选择从 Session 日志重建。

**隐藏插件卡片但不加载 Team。** 新 profile 将无法获得该能力。默认 profile 加载实验性包会违反产品隔离；将相关包移入所属产品组可明确随产品提供的支持。

## Consequences

默认 profile 包含 Team 实现，但开启前不暴露任务工具。自定义组合必须迁移已移除的包名；持久事件名称与任务数据保持不变。[升级指南](../../../../docs/upgrade-guide/v0.2.1-rc.2/session-team-mode/guide.zh.md)负责具体步骤。

验证覆盖默认启动、新 Session 手动开启、独立根、选择持久化、任务保留、旧 profile 迁移和插件开关移除。产品隔离检查使用另一个无关实验性插件作为负对照。
