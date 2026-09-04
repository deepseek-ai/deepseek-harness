# Agent Note: 将打包分片行设为默认 JSONL 布局

Status: implemented
Archived: 2026-09-01

[English](2026-07-26-packed-chunk-rows-by-default.md) | 中文

## 问题

提供方流会产生大量 token 大小的 `assistant/chunk` 增量事件，其重复 JSON 封装可能比载荷本身更大。会话日志必须将每个分片保留为独立的逻辑事件：实时 `session/event` 传递、序号、`sourceEventSeqs`、回放、取消证据和 UI 流式输出都依赖这些边界。

JSONL 存储 seam 可以在不改变逻辑日志的情况下减少这部分封装开销。一段至少包含 3 个连续、同属一个块的增量事件可以编码为一条 `text-chunks`、`reasoning-chunks` 或 `tool-call-chunks` 存储行，解码则会重建每个原始事件、时间戳和序号。一个可信的默认值必须同时覆盖运行时写入器、应用级配置、快照生成器和签入仓库的 fixture（测试前置数据）；否则测试会绕开部署实际写入的布局。

## 决策

`dsh-session-persistence-jsonl` 会将省略的 `packChunks` 解析为 `true`。ACP（Agent Client Protocol）演示包装层公开相同的默认值，所有省略该字段的组合都会继承打包写入。`packChunks: false` 仍是写入侧显式诊断模式，以每个事件一行的形式存储。

读取始终不受选项控制且与布局无关。打包、非打包和混合文件都会加载为相同且连续的 `SessionEvent[]`，因此更改默认值不需要变更会话格式版本，也不需要对磁盘数据执行运行时迁移。该选项只控制新追加的批次，绝不会选择读取器模式。

### 逻辑事件与物理行

JSONL 打包路径保留在 `dsh-session` 的存储 seam，并通过 `packChunkRuns()` 和 `decodeStorageRecord()` 实现。编码器识别精确的增量事件形态，原样保留无法识别的事件，并且只打包至少包含 3 个事件的连续段。打包行属于编码词汇，不是 `SessionEventMap` 成员：它绝不会进入 Session 日志，也不会触发 `session/event`。[打包会话历史传输决策](2026-08-15-packed-session-history-transport.zh.md)会为有界的无损协议区间复用该词汇，而不改变这些事件语义。

JSONL 后端会打包每个持久追加批次。原始模式 `compression: 'none'` 与默认 Zstandard 帧承载相同的逻辑存储记录；为使 fixture 便于评审而选择原始模式，不会禁用打包。仓库中的回放读取器和规范化器会解码共享行格式，而不维护快照专用编解码器。

### 规范快照 fixture

每个签入仓库的会话格式 JSONL fixture 都使用规范打包表示。`scripts/session-fixture-layout.snapshot.ts` 会在整个仓库中发现已跟踪的 `*.jsonl` 文件，以及未被忽略的新增未跟踪 JSONL 文件，选择首条记录为 `session` header 的文件，解码所有正文记录，并拒绝与 `packChunkRuns()` 输出不同的内容。因此，该清单无需维护路径列表即可覆盖 ACP、headless、TUI、`apps/web`、父会话、子会话以及未来的 fixture 名称。

ACP 和 headless 快照运行会采集默认 JSONL 后端的输出。TUI 和 web 的记录模式写入器会在写入 fixture 前，对内存事件应用 `packChunkRuns()`。人工编写的 `packed-chunks` ACP 场景在普通配置下运行，并保留全部 3 种打包行类型；其约定先解码独立的源 fixture 和目标 fixture，再断言二者逐事件相等。

聚焦的包测试保留非打包和混合布局输入，以验证读取器兼容性。这些测试不会让默认快照语料库豁免规范布局要求。

### 在途分支收敛

临时命令 [`scripts/migrate-packed-session-fixtures.ts`](../../../../scripts/migrate-packed-session-fixtures.ts) 让在途分支合并当前 `master` 后可以完成收敛：`pnpm run migrate:packed-session-fixtures` 会发现与永久门禁相同的仓库级 fixture 集合，保留各文件的 header 行，解码现有混合记录，写入规范打包正文，并证明解码结果相等且操作具有幂等性。该命令绝不会调用模型，也不会重新生成 transcript（文本记录）与呈现输出。

只要较旧分支仍可能携带 fixture 改动，测试政策和 ACP 快照 README 就会继续链接该命令。最新的开放 PR（Pull Request）清单确认每个受影响分支均已合并、关闭或符合规范后，[移除提案](../../proposed/process/2026-07-26-remove-packed-session-fixture-migrator.zh.md)会删除该 CLI、包命令、本过渡章节和文档链接，并替换永久门禁中仅适用于该命令的修复指引。共享规范布局转换器与快照门禁保持永久存在。

### 验证约定

JSONL 持久化测试证明：省略选项时会写入打包行，显式传入 `false` 时会按每个事件一行的形式写入，两种形式都会加载为完全相同的事件。规范布局转换器单元测试覆盖 header 保留、非打包转换、非会话 JSONL、已打包输入的幂等性和畸形输入。无密钥快照门禁覆盖每个签入仓库的 fixture 和组装后的回放路径；文档门禁则确保配置默认值与双语约定保持一致。

## 曾考虑的替代方案

**仅翻转后端 schema 默认值。** 这会让包装层默认值、TUI/web 直接序列化器、现有 fixture 与未来 fixture 政策仍然彼此不一致。只有已交付组合及代表这些组合的测试采用相同默认值时，该默认值才有意义。

**快照继续使用非打包格式以便阅读。** 打包行仍会显式保留每个片段和时间戳，共享解码器与规范化器则提供逻辑检查。如果让规模最大的签入仓库消费方采用不同布局，快照覆盖就会绕开已交付的写入路径。

**删除 `packChunks` 并始终打包。** 只保留一个写入器更简单，但每个事件一行的输出仍适用于诊断和聚焦的混合布局兼容性测试。显式停用选项在不削弱默认值的同时，保留了这些现有消费方。

**把分片批量合并为逻辑会话事件。** 这会减少事件数量，但也会延迟或重塑实时传递，重新编号助手消息引用的分片 seq，并要求每个 UI 和回放消费方理解另一种流式单位。物理打包在现有持久化接口背后实现，从而获得存储收益。

**永久保留分支迁移器。** 只读的规范布局转换器与快照门禁负责持续强制执行。只有在途分支仍携带旧 fixture 布局时，会修改仓库内容的命令才有价值，因此移除提案明确限定了其生命周期。

## 后果

常规 JSONL 写入与签入仓库的 fixture 使用更少的物理行，同时精确保留逻辑事件流。运行时读取器接受所有现有布局，操作方也保留显式的非打包诊断模式。按 token 逐行处理原始文件较为不便；错误地将 header 后每一行都视为 `SessionEvent` 的外部工具会更频繁地遇到存储标签，受支持的读取器则会调用 `decodeStorageRecord()`。

仓库会产生大规模机械 fixture diff；评审应依据解码结果相等这一事实和规范布局门禁，而不是逐行、逐 token 检查。仓库还会暂时保留一个分支迁移命令及其链接；单独的移除提案会防止这项过渡辅助机制成为永久的流程接口。
