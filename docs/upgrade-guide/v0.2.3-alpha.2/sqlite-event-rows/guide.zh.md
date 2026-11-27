---
kind: upgrade-guide
description: "需手动启用的 SQLite Session 存储改为每个事件一行：frameEvents 设置已移除，现有数据库在首次打开时升级，且早期版本无法再打开。"
---

# 每个事件一行的 SQLite Session 存储

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-session-persistence-sqlite` 过去把事件存为压缩帧，每帧最多 `frameEvents` 个事件。现在每个事件存为一行，事件的序号、类型和时间各占一列，并为模型调用、工具调用和上下文压缩维护派生表。`frameEvents` 设置不再存在。

早期版本写入的数据库 schema 版本为 1。首次打开时会在一个事务内把它升级到版本 3；升级失败时文件保持不变。早期版本拒绝打开版本 3 的数据库。只有把默认 JSONL 提供方替换为本包的 profile 受影响。无共享历史的 Session 闲置满 30 天后默认转入[冷归档](../../../../packages/session/session-persistence-sqlite/README.zh.md#archiving-idle-sessions)（`coldAfterDays: 30`；设为 `0` 可保持全部内容内联）。

本提供方还新增了 `recovery` 设置，默认为 `replace`：发现数据库已损坏时，打开会把文件移到它旁边的 `<name>.unreadable-<时间戳>`，并开始一个空数据库，因此 Session 仍然可用，也不会删除任何已存的字节。设置 `recovery: report` 可保留原先的拒绝行为，人工修复存储根。被其他进程锁住的数据库永远不会被替换：超过 busy 超时后以新增的 `SESSION_STORAGE_LOCKED` 失败，解决办法是关闭那个进程。

## 迁移

1. 停止所有使用该存储根目录的 DSH 进程。
2. 把 `<root>/.segments/sessions.sqlite` 以及同目录下的 `sessions.sqlite-wal`、`sessions.sqlite-shm` 文件复制到备份位置。这份副本是回退到早期版本的唯一途径。
3. 从 `cordis.yml` 或 patch 中该提供方的 `config` 里删除 `frameEvents`。遗留的值会被忽略。
4. 启动 DSH。升级在第一个 Session 打开之前执行，期间进程被阻塞；按我们的测量，每 100 MB 数据库约需四秒，开始时日志会指明。在 SQLite 重新利用释放出的页之前，升级后的文件同时容纳两种布局，所以起初预计是原来的约 2.5 倍；离线执行 `VACUUM` 可缩小到比帧布局多约 45%。如果有帧含有无法读取的数据，会有一条警告指明它：读取失败的位置与以前相同，该帧的字节保留在 `frames_set_aside` 表中。如果升级以 `SESSION_STORAGE_UPGRADE` 失败，文件保持不变：请恢复备份，或继续使用早期版本。
5. 运行 `sqlite3 <root>/.segments/sessions.sqlite "PRAGMA user_version; SELECT count(*) FROM session_summary;"` 确认结果，输出应为 `3` 和已存储的 Session 数量。
