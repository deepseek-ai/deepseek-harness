# Agent Note: token-meter surface fold 改为 plan/commit 两段式原地提交

Status: implemented
Archived: 2026-09-04

[English](2026-08-24-token-meter-surface-fold-plan-commit.md) | 中文

## 问题

`foldSurfaceTokens` 在每个 surface 事件上重建计价 surface：append 分配 `[...nodes, node]`，replacement 先整表复制再 splice。这次复制只为一个性质而存在——抛错必须让调用方的 `ReplayState` 保持原样，使同一条畸形事件在每次重试时以完全相同的方式失败——但它让每条**合法**事件都为此付出 O(surface)。针对该 fold 的基准显示复制占 append 成本的约 99.9%（surface 为 5 万节点时每次 100µs，而估价本身仅 0.1µs），且连续 append 在会话生命周期内累计 O(S²)，恰好集中在用户反馈卡顿的长会话上。token meter 在同步的 `session/event` 发布路径内折叠，这笔成本直接落在 agent loop 的流式 append 上。

## 决定

按 session 核心既有的 `planSurfaceEvent`/`applySurfacePlan` 形态拆分 fold：`planSurfaceTokens` 针对只读 surface 执行所有可失败步骤（消息估价、替换区间解析）并返回 `SurfaceTokenPlan`；`commitSurfaceTokens` 原地应用 plan——append 用 `push`，replacement 用一次 `splice`——并且构造上不可失败。`TokenMeter._foldEvent` 先 plan，再执行剩余的可失败 anchor 校验（step 配对、provider chunk 溯源），最后才 commit，因此重试一致性由执行顺序保证而不再依赖分配。append 从 O(surface) 降为均摊 O(1)；replacement 保留 O(surface) 的 `findIndex`，但不再额外整表复制。

`measure()` 仍以 `structuredClone` + `deepFreeze` 分离结果，所以对 meter 私有数组的原地修改永远不会泄漏给调用方。

## 测试

既有的畸形回放套件已钉住重试一致性（`expectRepeatedFailure` 对越界替换、缺失 step 边界、坏溯源各断言两次相同抛错）。新增一个回归测试覆盖本次改动引入的风险点：surface plan 合法但后续 anchor 校验抛错的事件，必须在反复失败后保持计价 surface 与累计总量未提交——若原地提交顺序错误，抛错模式依然匹配而 surface 会悄悄重复计数。完整的 token-meter 与 compaction 套件通过真实的 prune 与 summary 替换覆盖两个 commit 分支。

## 曾考虑的替代方案

**用 seq→index 映射把 replacement 也做成 O(1)。** 暂缓：每次 splice 引起的下标移动本就迫使映射按替换做 O(surface) 重建，而 replacement 比 append 少几个数量级（仅 compaction 摘要与 prune 批次）。二次项在 append 路径上。

**保留分配并用结构共享（持久化向量）。** 否决：为单个内部数组引入依赖或手搓结构并不划算，plan/commit 的顺序已提供复制原本换取的原子性。

## 后果

该 fold 不再为长会话 append 成本贡献二次项；meter 剩余的每事件成本是 `_sync` 中的 `Session.events` 快照读取（由索引化日志读取工作独立解决，PR #1724/#2907）与固有的 O(内容) 估价。旧的分离结果类型 `SurfaceTokenFold` 已移除；`surface-fold.ts` 为包内部模块，无外部消费者需要变更。[composer 上下文仪表笔记](../feature/2026-08-05-composer-context-meter-breakdown.zh.md)记录了该 fold 周边的投影设计。
