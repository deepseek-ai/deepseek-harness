# Agent Note：SQLite Session 内容的冷存储

Status: implemented

[English](2026-11-26-sqlite-cold-sessions.md) | 中文

## 问题

[事件行布局](2026-11-25-sqlite-event-rows-and-derived-tables.zh.md)支持索引点读和 SQL 查询。但逐个压缩事件比压缩整个 Session 更占空间，极少重新打开的历史也要承担这部分开销。

## 决策

可配置的后台归档（`coldAfterDays`，默认 `30` 天；设为 `0` 禁用）将符合条件的 Session 在 `<database>.cold/` 下保存为单个 Zstandard 12 级压缩的逻辑 JSONL 帧。SQLite 保留事件标识、信封（`codec` 254）和派生行，在同一事务中记录已同步落盘的归档并清除内联内容。任何 `open()`（读或写）以及从已归档父会话 fork 非空前缀的操作都会在返回前恢复内容，合并同进程并发打开请求，并在写打开时直接复用已解码事件。归档不会改动已有的 JSONL 代次。共享的 fork 历史继续内联存储，使共享 Segment 既不必重复存储，也不会连带恢复无关 Session。作为明确的阶段性设计决策，基于独立线程的在线空间整理（`compactStorage()`，在线程中执行 `VACUUM` 与 `PRAGMA wal_checkpoint(TRUNCATE)`，期间本地数据库写入异步排队等待）保留在 `dsh-session-persistence-sqlite` 内部，不纳入 `SessionPersistence` 公共服务契约，因为其他持久化后端不需要 `VACUUM` 式空间回收且尚无统一的外部触发契约。

## 考虑过的替代方案

- **改变热数据行的压缩方式。** 较大的帧节省空间，但索引点读需要解码相邻事件。
- **使用 3 级或 19 级。** 在同一组 154 个 Session 上，仅测压缩时，12 级比 3 级节省约 22 MiB。19 级再节省约 11 MiB，但压缩耗时约为 12 级的 14 倍。
- **将元数据和内容都移至 JSONL。** 删除事件行会删除其 SQL 索引和事件标识。保留信封后，SQL 不必读取归档就能计数和连接查询。
- **自动压缩数据库文件。** 将空闲页返还给文件系统需要重写数据库文件；释放的页已进入 SQLite freelist 供后续写入原位复用，无需在活跃工作负载期间强加重写锁和临时磁盘开销。
- **直接在 `SessionPersistence` 上公开 `compactStorage()`。** 其他持久化后端均不需要 `VACUUM` 式空间回收，且不存在界面、CLI 或调度触发入口。将 `compactStorage()` 保留为 `dsh-session-persistence-sqlite` 内部实现，可避免单一后端过早限定公共服务契约。

## 后果

在 Apple Silicon macOS（Node 24.22.2）上对 154 个真实语料 Session（242,523 个事件）进行三轮交替独立进程基准测试：归档全部符合条件的 Session 耗时 37.6 秒，通过内部 `compactStorage()` 线程整理数据库耗时 688 ms。总磁盘占用从 364.1 MiB（热 SQLite）降至 151.3 MiB（25.1 MiB 数据库加 126.2 MiB `.cold` 归档），比热 SQLite 小 58.5%，比 Zstandard JSONL（155.6 MiB）还小 2.8%。`list()`（首次 61.2 ms，热态 18.0 ms）、跨 154 个 Session 的 `stat()`（总计 112.9 ms，p50 为 526 µs，而 JSONL 为 5,104 µs）以及派生表 SQL 查询（`session_summary` 0.8 ms、`llm_calls` 9.4 ms、`session_tools` 51.6 ms）均不触发恢复。首次冷态 `open('read') + read()` 的中位数为 42.4 ms，p90 为 328.1 ms（2,896 个事件），最大值为 3.51 秒（26,261 个事件）；恢复后的读取中位数为 6.59 ms，154 个 Session 的末尾 50 事件读取共 441.1 ms（JSONL 为 8,723.1 ms）。在生产 `headless` profile 中恢复归档 Session 并连续运行 5 轮真实工具调用，中位 Session 总耗时 117.4 ms（恢复 54.3 ms + 5 轮运行 63.2 ms，JSONL 为 189.0 ms），p90 Session 总耗时 372.9 ms（恢复 254.8 ms + 5 轮运行 118.0 ms，而 JSONL 仅 5 轮运行即需 205.9 ms）。

[提供者参考](../../../../packages/session/session-persistence-sqlite/README.zh.md#archiving-idle-sessions)说明闲置时间规则、SQL 可见性、备份及[整理数据库](../../../../packages/session/session-persistence-sqlite/README.zh.md#compact-the-store)的方法。[Loader 测试](../../../../packages/session/session-persistence-sqlite/tests/event-rows.e2e.ts)通过内置 headless profile 验证归档、内部 `compactStorage()`、工具查询保留与重新打开行为。
