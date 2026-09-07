# Agent Note: 发布前可复用的 Session 准备阶段

Status: implemented
Archived: 2026-09-04

[English](2026-08-05-session-preparation.md) | 中文

## 问题

新建和持久化恢复通过不同构造流程抵达相同的发布边界。这使一项关键不变量不够清楚：设置必须基于一个未发布的 Session 完成，之后系统才能同时公开这个精确 Session 及其 agent。

冷历史检查和 agent（智能体）恢复也曾分别实体化同一份持久会话日志，本 Note 最初以持久化侧的已准备 Session 缓存回答了这一半问题；那一半已在下文中被取代。

## 决策

`SessionPreparation` 持有一个精确的未发布 `Session`，直至发布或回滚。它属于 Session 生命周期，不属于 agent 生命周期或激活机制。新建流程包装 `SessionStore.prepare()` 的结果；持久化恢复通过该会话的写句柄读取已存储的日志、追加 `interruptedTurnClosers`，再包装 `SessionStore.prepare(id, { seed, meta, seedSource: 'persistence' })`——即就地验证并冻结转移对象图的恢复分支。

agent loop（智能体循环）通过同一条设置与发布流水线消费这两种形式：先取得准备对象，围绕 `preparation.session` 构建私有 agent 上下文，等待可选设置完成，再发布该精确 Session 和 agent，并在所有退出路径上对准备对象执行 dispose（资源释放）。发布后，实时生命周期由现有 Session 与 agent 存储接管；`SessionPreparation` 本身不负责任何 agent 行为。

该机制细化了 [agent 生命周期与所有权决策](2026-06-18-agent-lifecycle-and-ownership-contracts.zh.md)中的发布边界，但不替换其所有权模型。

## 已被取代：持久化侧的准备生命周期

本 Note 最初还赋予持久化一个 `prepare(id)`/`inspect(id)` 生命周期：由协调器支撑的、装有冷未发布 Session 的有界 LRU，带独占预留、按 revision 校验的复用，以及在 `prepare`/`load` 内部提交的修复，使历史分页与后续恢复共享一次冷实体化。[基于句柄的持久化 seam](2026-08-27-handle-based-session-persistence.zh.md) 删除了这一切：持久化只暴露句柄，恢复通过其写句柄读取日志并自行负责修复，只读观察方（session-query）拥有自己的冷 Session 缓存，以 `stat().revision` 变更令牌为键。读取复用的目标在该缓存中得以延续；独占预留机制则没有延续，因为写句柄的单写者所有权正是恢复真正需要的排他手段。在已准备缓存有时能提供温 Session 的场景下，恢复要为通过句柄的一次全日志读取付出代价——这是句柄 Note 中记录的、已被接受的成本。

## 边界

- 准备对象是一个可 dispose 的所有权窗口，而不是缓存：dispose 同步且幂等，发布只接受精确的已准备 Session。
- 新建流程绝不隐式认领持久化身份。持久化冲突仍会被拒绝（`SessionAlreadyExistsError`、`SessionAlreadyOwnedError`）。
- 实时 Session 由现有存储持有；准备对象只持有未发布的 Session。

## 验证

agent loop 测试覆盖 create、`createAgent` 与 resume 之间的统一发布流水线，包括设置失败时的回滚、取消与清理，以及 dispose 会释放写句柄（重新以写模式打开可以成功）。Session store 测试覆盖恢复分支的就地验证并冻结的所有权转移。

## 考虑过的替代方案

**由历史读取激活 agent。** 不采用，因为分页会使仅用于查询的 agent 长期保持实时状态，并把缓存退出问题转移到 agent 生命周期。该理由仍然守护着 session-query 冷缓存：观察绝不创建 agent。

**只缓存 `{ meta, events }`。** 当时不采用，因为恢复仍需从缓存值重新构造 Session。在句柄 seam 下，这恰好是读取侧的做法——session-query 按 revision 为只读用途缓存一个冷 Session——而恢复则从句柄读取重建，以温 Session 复用换取唯一的写所有权之门。

**在 agent loop 中增加恢复事务或协调器。** 不采用，因为冷读与 Session 构造属于持久化与 Session 职责。agent loop 只需要统一的 `SessionPreparation` 所有权边界；句柄 seam 保留了这一分工，同时把修复移入循环的恢复路径。

## 后果

新建和恢复共享同一发布协议，同时保持 agent 与 Session 职责分离，且每条退出路径恰好 dispose 一个准备对象。本 Note 最初记录的持久化侧复用后果（共享冷实体化、LRU 上限、预留协调）如今归属于[句柄 Note](2026-08-27-handle-based-session-persistence.zh.md) 以及取代它们的 session-query 缓存。
