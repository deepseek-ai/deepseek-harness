# Agent Note: 模型相对会话引用预算

Status: implemented

[English](2026-09-05-session-reference-model-budget.md) | 中文

## Problem

固定的 64 KiB 引用预算会在大上下文模型上丢弃有用的来源上下文。目标会话头描述上一次请求，而 agent options 为路由提供初始值；两者都不一定标识当前进入步骤所选的模型。

## Decision

[Session-reference](../../../../packages/context/session-reference/README.zh.md) 通过本地 prepend 监听器观察已完成的 `system-prompt/assemble` 瀑布，并把 provider/model 对存入以 Agent 为键的 WeakMap。准备阶段通过可选 LLM 服务解析该路由；首次组装前直接准备则使用 agent options。不带 Agent 的诊断不会更新映射。

每个来源获得 `max(65536, floor(contextWindow × 4 × referenceContextFraction))` 字节，默认比例为 `0.2`。每个 token 四字节是容量估算。显式 `maxReferenceBytes` 跳过模型查询并保持精确值。缺少路由、服务、适配器或容量时保留下限；其他查询失败和取消会传播。缺少适配器不妨碍流中间件处理该路由。

## Alternatives considered

**每步读取会话头或 options。** 实时切换后，两者都可能选中旧模型。完成的组装公开模型选择所捕获的路由。

**在 pre-step 中重新组装或重新分派请求路由。** 这些操作会重复插件效果，并可能捕获不同的选择。本地观察器不需要修改循环或增加公共路由 API。

## Consequences

预算随模型容量增长，不改变投影、保留或预览策略。它仍按来源计算，而不是聚合 token 预留。监听器由 effect 持有并可释放；映射不会保留 agent。聚焦测试覆盖下限、比例换算、显式覆盖、实时选择、元数据缺失、取消、查询错误与监听器移除。
