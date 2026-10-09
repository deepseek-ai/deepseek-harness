# Agent Note: 每个 agent 使用一种工具调用形式

Status: implemented

[English](2026-10-05-native-or-ptc-presentation.md) | 中文

## Problem

混合工具呈现为同一组能力同时携带直接函数 schema 和程序 SDK。它增加了 schema 排序、准入、配置和测试组合，却没有提供独立的执行能力。[PTC 决策](../feature/2026-06-15-ptc.zh.md) 仍负责注册表、运行时和嵌套调用规则。

## Decision

每个 agent 选择 `native` 或 `ptc`。原生呈现公开可见能力的 schema。PTC 呈现仅公开 `run_code` 和生成的 SDK。注册表拒绝配置中的 `both`。同一应用中的不同 preset 可以选择不同的受支持模式。

## Alternatives considered

**保留混合呈现。** 这允许同一个 agent 在每一步选择直接调用或程序，但会重复通告能力信息，并保留第三种准入情况。独立的原生与 PTC agent 提供受支持的选择。

**将混合呈现静默映射到另一种模式。** 任一映射都会改变现有程序或直接调用的执行方式。明确拒绝配置，并提供[升级指南](../../../../docs/upgrade-guide/v0.2.1-alpha.1/tool-presentation-mode/guide.zh.md)，可以让这一选择可见。

## Consequences

agent 不能通过一种混合呈现在直接调用具体工具与 `run_code` 之间切换。重新引入该模式，需要存在具体的行为需求，并有证据表明值得增加这种接口。

共享策略、取消、嵌套上下文和多模态结果测试使用原生或 PTC 配置。较早的 Session 代际及显式保留的记录保持原始字节，并且仍可读取。移除该模式改变的是受支持的配置，而非插件作者使用的注册 API 或受控执行流水线。
