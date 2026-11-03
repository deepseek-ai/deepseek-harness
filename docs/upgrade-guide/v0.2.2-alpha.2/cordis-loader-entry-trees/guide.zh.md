---
kind: upgrade-guide
description: "Loader 条目树通过 commit(change) 报告变更，Include 通过 journal 持久化这些变更。"
---

# Loader 条目树变更报告与 Include 持久化

[English](guide.md) | 中文

## 变更

`@deepseek-ai/cordis-plugin-loader` 跟随 Loader 1.0.0-rc.8，`@deepseek-ai/cordis-plugin-include` 跟随 Include 1.1.1。受影响的是 `cordis.yml` 与 patch 文件、继承 `EntryTree` 的代码，以及调用 `applyEntryPatches` 或依赖 Include 写盘的代码。

- 移除了 `EntryTree.write()`。子类改为实现 `commit(change: EntryChange)`，它会同步收到每一次创建、更新、移动、删除和显式 Fiber 保存。内存树实现为空操作。
- `applyEntryPatches(data, patches, warn)` 总是返回克隆后的条目，没有 patch 时也一样，插入行同样会被克隆。调用方不能再通过结果修改输入。
- Include 通过与最新文件协调的 journal 持久化运行时变更。文件编辑在字段冲突时优先，并记录为冲突。对 patch 所拥有字段和插入行的修改会写入父 Include 的 patch。`flush()` 等待待处理的写入，并在仍有未保存变更时拒绝；`refresh()` 和 `stop()` 返回相同的结果。
- Include 会把生成的 id 写回原本没有 id 的文件行。对 patch 插入行（包括 bundle 行）的运行时修改会写入父级的 patch，而不是被 include 的文件。`dsh` profile 根 Include 的父级是内存中的 Loader，因此这类修改（例如 bundle 行自行释放时写入的 `disabled: true`）重启后不再保留；此前整棵已应用 patch 的树会被写入 `cordis.yml`。

## 迁移

1. 在 `EntryTree` 子类中把 `write()` 换成 `commit(change)`。根据 `change.options` 和 `change.legacy` 持久化：缺少 `legacy` 表示创建，缺少 `options` 表示删除。
2. 只修改 `applyEntryPatches` 返回的结果。
3. 需要运行时变更落盘时，await `include.flush()`；对于 patch 所拥有的变更，先 flush 子 Include，再 flush 其父 Include。
4. 启动应用，确认 `flush()` 之后运行时编辑已出现在配置文件中。
