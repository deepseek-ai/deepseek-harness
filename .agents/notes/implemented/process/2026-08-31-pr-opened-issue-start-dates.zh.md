# Agent Note: 在 PR 创建时设置 Issue 开始日期

Status: implemented

[English](2026-08-31-pr-opened-issue-start-dates.md) | 中文

## 问题

Issue Project 使用 `Start date` 字段记录已规划工作的开始日期，但加入或关联 Issue 不会提供日期值。PR 可以同时标识它所解决的 Issue 和提供相关实现上下文的 Issue；两种关系都表示仓库工作已经开始。

如果每个 PR 事件都更新该字段，编辑、推送或重新打开 PR 会为已有工作补上日期。覆盖已有日期还会丢弃人工规划的日期或较早 PR 记录的日期。

## 决策

Issue 生命周期工作流仅在 `pull_request.opened` 时初始化 `Start date`。工作流读取 PR 的实时正文，保留每个能解析为 Issue 的同仓库引用，把 `created_at` 按配置的 Project 时区转换为日历日期，确保 Issue 是 Project item，并仅在当前值为空时写入配置的 Date 字段。

配置指定 Project 字段和时区。配置缺失会在策略模块加载时失败；字段缺失、字段不是 Date 类型、时间戳无效或 API 请求失败会让首个相关 PR 的工作流失败。

[由事件直接指定的 PR 评审状态命令](2026-08-10-event-directed-pr-review-status.zh.md)继续负责 Status 转换。日期初始化同时包含解决型和信息型 Issue 引用，对 Draft PR 和自动化 PR 同样运行，也不依赖 PR 策略检查是否生效。

## 验证

[Issue 管理测试](../../../../.github/issue-management/policy.test.mjs)覆盖上海时区日期边界、仅 opened 分派、全部保留的 Issue 引用、空值写入、已有值保留、Project item 缺失、字段配置无效和 GraphQL mutation 变量。[工作流测试](../../../../scripts/ci-workflow.spec.ts)要求保留 `pull_request.opened` 订阅。

## 考虑过的替代方案

**使用 Project 内置工作流。** 内置工作流负责固定的 Project item 和 Status 转换；仓库工作流已经负责经过身份验证的 GraphQL mutation，并且能够提供 PR 创建日期。

**处理每个已订阅 PR 事件或运行协调器。** 后续事件可以为已有 PR 和创建后新增的引用补上日期，但这会让该字段成为修复型投影，而不是随 PR 创建的记录，并且会增加重复 Project 读取。

**仅更新解决型 Issue 引用。** 信息型引用同样标识随该 PR 开始实现工作的 Issue，因此日期初始化使用现有的全部引用集合，Status 转换仍只处理解决型引用。

**覆盖已有日期。** 后续 PR 不得替换人工计划或为较早工作写入的日期，因此 mutation 先读取并只处理空值。

## 后果

只有工作流发布后新建的 PR 会初始化日期。创建后新增的引用和现有开放 PR 保持不变，工作流不会扫描已有 Project item 或 PR。

空值读取使重试在通常情况下保持幂等。ProjectV2 没有条件字段更新，因此同时引用同一个空日期 Issue 的 PR 可能都会写入；按 PR 设置的并发控制不会串行化该 Issue，最后一次 mutation 可能胜出。
