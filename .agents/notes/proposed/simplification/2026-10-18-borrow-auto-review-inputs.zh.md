# Agent Note: Auto review 输入在序列化前采用借用

Status: proposed

[English](2026-10-18-borrow-auto-review-inputs.md) | 中文

## Problem

[`snapshotAutoReview()`](../../../../packages/experimental/auto-review/src/index.ts) 读取已冻结的 Session 历史、请求头和工具参数，但还会复制 `session.surface.nodes` 并冻结私有结果。它唯一的调用方 `classifyRisk()` 会立即序列化该结果，中间没有 await，也不会发布结果。

## Proposal

借用 `session.surface.nodes`，返回只读的中间结果，不再调用一次 `deepFreeze()`。保留全部操作校验和最终 `GenerateOptions` 的冻结。[Session 拥有的不可变性](../../implemented/architecture/2026-06-11-dev-invariants-over-deep-readonly.zh.md) 和[仅用于请求的输入冻结](../../implemented/architecture/2026-09-17-persistence-attribution-policy.zh.md) 保持不变。这会移除一次私有数组分配和冻结遍历，同时保持审核请求不变。

## Alternatives considered

**保留中间快照。** 未来若有留存数据或异步读取的消费方，就需要稳定输入。当前没有消费方留存该对象，也没有消费方在渲染前执行 await。

## Acceptance criteria

原生工具和 PTC 请求保留完全相同的文本、来源过滤和操作检查。现有请求冻结与取消断言通过。序列化不修改借用的 Session 或执行数据。

## Risks

未来若引入异步工作或发布中间对象，需要重新考虑所有权。移除最终请求的冻结或数据所有者提供的快照不在本提案范围内。
