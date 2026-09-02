# Agent Note: 移除可变的会话摘要

Status: implemented

[English](2026-06-19-drop-mutable-session-summary.md) | 中文

## 问题

[会话持久化 seam](../architecture/2026-06-14-session-persistence.zh.md) 将会话的日志外元数据拆分为 `dsh-session` 拥有的两种类型：一个不可变的 `SessionHeader`（`version`、`id`、`createdAt`、`cwd?`、`parentSession?`），在创建时一次性写入；一个可变的 `SessionSummary`（`updatedAt`、`title?`、`firstPrompt?`），「可在不触碰仅追加日志的情况下更新」。二者合并为 `SessionMeta = SessionHeader & SessionSummary`，抽象的 `SessionPersistence` 服务为此多出第七个方法 `update(id, summary)`，用于重写摘要。各后端各自实现可变存储：JSONL 在日志旁先写入临时文件再重命名，并以尽力而为的方式原子发布一个独立的 `.summary.json` **伴随文件**；SQLite 则使用 `updated_at`/`title`/`first_prompt` **列**，并在追加事务内更新其中的时间列。

摘要是为未来的会话选择器设计的（通过 `updatedAt` 排序近期会话，用 `title`/`firstPrompt` 做预览）。该选择器从未实现。对整个仓库的审计表明，`SessionSummary` 的整套相关接口都只是在维护**无用状态**：

- `SessionPersistence.update()` **零个生产调用方**（所有 `.update(` 匹配都是 `createHash().update()` 或测试代码）。
- `firstPrompt` 在生产代码中**从未被读取**。
- 会话标题来自持久的 `session/title` 事件，工具卡片标题来自工具 presenter；二者都不读取可变的会话元数据。
- 持久化列表的消费方使用不可变 header 中的标识、创建时间、谱系和 cwd 字段。近期排序和预览派生自日志，而非某个 `updatedAt` 摘要。
- 决定性的一点：活跃的 `Session.header` 类型本来就是 `SessionHeader` 而非 `SessionMeta`——摘要从未存在于活跃会话对象上；它只存在于持久化层，除了自身的约定测试外无人写入、无人读取。

## 决策

彻底删除可变的会话摘要。`SessionSummary` 与 `SessionMeta` 这个名称均不存在；后端存储和返回的元数据仅为 `SessionHeader`。抽象服务不包含 `SessionPersistence.update()`。交付的 JSONL provider 不包含摘要伴随文件机制（`writeSidecar`/`readSidecar`/`touchSummary`/`removeSidecars`/`sidecarPath` 或 load/list 覆盖逻辑），仓库外 provider 实现相同的无摘要服务约定。

摘要原本要提供的一切，在消费方真正需要时都**可从仅追加日志中派生**（`firstPrompt` = 第一条 `user/message`；近期度 = 最后一个事件的 `time` 或文件 mtime），或者已经存在于不可变 header 中（`createdAt`、`cwd`）。唯一*不可*派生的是用户*手动编辑*的标题，但它从未实现，纯属 YAGNI；如果未来真有功能需要，它可以作为独立的日志事件或 header 字段回归。

这次移除收窄公开服务约定与 JSONL 磁盘格式；摘要是有意为未来设计的结果，而非意外；原 Agent Note 描述 `SessionMeta` 之处由 `SessionHeader` 承担，这就是摘要消失的原因。它也简化了当时的[共享持久化写入协调器](../../archived/architecture/2026-06-18-shared-persistence-write-coordinator.md)：没有可变摘要后，那套编排不需要 `updateSummary` 钩子。

## 无需迁移

交付的 JSONL provider 不存在可变摘要格式或迁移路径：它只读写 `SessionHeader` 与仅追加日志。仓库不包含 first-party SQLite Session provider。[JSONL-only 持久化决策](2026-08-30-jsonl-only-session-persistence.zh.md)负责删除 provider 写入的数据库的兼容性切断，并要求 operator 在升级前先用旧 build 导出数据。

## 后果

未来的会话选择器现在必须从日志派生预览/排序信息（或重新引入一个类型化字段），而不能直接读取现成的摘要行。这是正确的代价：为一个尚不存在的功能维护缓存，是每个后端都要承担维护成本、每个约定测试都要承担断言成本的无谓负担。这一原则——**通过的测试固定的是当前行为，不一定是正确行为；行为可能是过去妥协的产物**——现已作为独立约定记录在[根 AGENTS.md](../../../../AGENTS.md) 中，本次变更即为其实例。

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->
