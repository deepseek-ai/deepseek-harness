# Agent Note: PTC preset 不提供通用 workflow 工具

Status: implemented
Archived: 2026-09-04

[English](2026-09-01-ptc-omits-workflow-tool.md) | 中文

## 问题

Web 端随附的 `ptc` preset 会通过生成的 SDK 提供通用 `workflow` 工具。PTC mode 已经把 `run_code` 作为模型编写的组合接口，因此 `workflow` 又增加了一套执行语义不同的编排语言。preset 描述还声称与标准模式能力完全相同，无法说明这个有意的差异。

## 决策

Web 端随附的 `ptc` preset 禁用自身的 `tool-workflow` 配置项。因此，它生成的 PTC mode SDK 不包含 `workflow` 绑定，模型可见的协议约定仍然只有一个 `run_code` 工具。

preset 在隔离的 workflow realm 中保留 `workflow-worker-thread`，因为 `tool-ralph` 使用同一个引擎。PTC mode SDK 继续提供 `ralph`。标准模式与创造模式继续提供 `workflow`，用户自定义 preset 也可以显式挂载该工具。

workflow 包及其持久 Session 事件类型仍然随产品安装。现有 workflow 记录继续正常渲染；这次默认组合变更只会阻止使用随附 `ptc` preset 的 agent 发起新的顶层 workflow 调用。

## 曾考虑的替代方案

**在 PTC mode 中禁用整个 workflow realm。** 不予采用，因为这也会移除 `ralph` 所需的 provider，而 Ralph 固定的全新 agent 循环不是第二套由模型编写的 workflow 语言。

**只在生成的 SDK 中隐藏 `workflow`。** 不予采用，因为只修改呈现会导致可执行工具查找与 preset 声明的组合不一致。禁用 consumer 配置项会同时从注册、查找与呈现中移除该绑定。

**等到 `run_code` 功能完全对等后再移除 `workflow`。** 不予采用，因为随附的 PTC 默认模式就是要以 `run_code` 作为组合接口。在独立评估能力缺口期间，需要声明式 workflow 语义的用户可以选择标准模式或显式自定义 preset。

## 后果

PTC 选择器描述会说明这一例外，不再承诺与标准模式完全对等。真实 Web Loader 组合测试固定 `run_code` 协议工具清单、缺失的 `workflow` SDK 绑定和保留的 `ralph` 绑定。无密钥的 Web PTC 录制会话负责组装提示词证据，preset 测试则固定标准模式与创造模式保持不变。
