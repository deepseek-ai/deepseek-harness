# Agent Note: 有界验证冷空白会话

Status: implemented

[English](2026-08-13-bounded-cold-blank-verification.md) | 中文

## Problem

Web 会话树会隐藏空白 Session，并把当前选中的空白项复用为 New Session。已附加 Session 可以从内存事件日志派生空白状态，但 `session.list` 通常不会加载每一份冷日志。把所有已物化的冷 Session 都视为非空，会暴露旧版本留下的空 Session；反过来，把 projection cache 中的 `blank: true` 当成当前事实，则可能在日志已经前进而 fail-soft cache 仍然陈旧时隐藏真实对话。

同一份冷列表还曾用 JSONL 工件的 mtime 作为 `updatedAt`。打开 Session 会追加 `session/end-seed`，因此即使没有真人 prompt，单纯拾起也会刷新 mtime，并把该 Session 提升到最近使用的对话之前。

## Decision

`dsh-api-session-controller` 注册 `sessionListMetadata` 投影，其中包含 `blank` 与 `lastPromptAt`。已附加摘要直接用同一组函数折叠实时日志。`blank` 只在 `turn/start` 时从 true 单调变为 false；`lastPromptAt` 只在来源 kind 为 `user` 的 `user/message` 上更新。

冷摘要信任缓存的 `blank: false`，因为已包含 `turn/start` 的 checkpoint 前缀会始终保持非空。cache miss 无法证明当前日志为空，因而按 `blank: false` 提供，让 Session 保持可见。早先的物理大小探测——`locate()` 路径加上门控一次精确 `readFrom(id, 0)` 折叠的 `coldBlankProbeMaxBytes` 资格阈值——随该 seam 的路径查询一并移除（[导出与预发布裁剪](../simplification/2026-08-27-persistence-export-and-pre-release-trims.zh.md)）。Persistence 快照提示不会重新引入它：listing 保持 metadata/cache-only，绝不打开冷正文。

`updatedAt` 取 `createdAt` 与 `lastPromptAt` 中较晚者。cache miss 或陈旧 checkpoint 只会让 Session 排得偏旧，而不会因无关的文件写入被提升。

## Alternatives considered

**信任缓存的 `blank: true`。** 拒绝，因为 projection cache 有意允许持久日志前进到 checkpoint 之后。首个 `turn/start` 之后若发生崩溃或 fail-soft 写入失败，真实对话就会被隐藏，客户端还可能把它复用为 New Session。

**读取每一份冷日志。** 拒绝，因为列表延迟与 I/O 会随所有已存对话的总字节数增长；未经核验的冷条目转而向保持可见降级。

**把空白状态与最近时间存入权威 persistence index。** 暂缓，因为交付的 JSONL provider 首行不可变，需要增加带有顺序写入要求的第二份持久工件。仓库外 provider 只有定义更新原子性、版本与恢复语义后才可使用自己的索引。更广泛的精确索引设计仍由[最后活动提案](../../proposed/architecture/2026-07-29-durable-last-activity-index.zh.md)负责。

**继续按 mtime 排序 JSONL。** 拒绝，因为 mtime 记录包括拾起边界在内的每一次工件写入，而非最近真人 prompt；其错误方向会把未经操作的 Session 提升到列表开头。

## Consequences

陈旧 cache 无法隐藏已存的 `turn/start`，且冷列表不做任何工件 I/O：冷行只从缓存投影提供。没有缓存非空投影的空白冷 Session 保持可见，缺失或延迟的最近时间 cache 条目回退到 `createdAt`。这些都是保守降级：UI 可能多显示一条空记录，或把 Session 排得偏低，但不会隐藏真实对话，也不会因为单纯打开而把会话提升到前面。

网关自有投影是网关 fiber 的 effect；卸载网关会移除该 key。单元覆盖固定了拒绝陈旧 true、复用单调 false、cache miss 保持可见、真人 prompt 最近时间和 fiber 销毁。
