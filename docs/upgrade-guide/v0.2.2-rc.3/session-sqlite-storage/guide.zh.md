---
kind: upgrade-guide
description: "显式启用 SQLite 会导入 Session 历史；导入后，保留的 JSONL 文件不再包含新事件。"
---

# 显式启用 SQLite Session 存储

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-session-persistence-jsonl` 插件此前将 Session 历史写入每个 Session 的 JSONL 文件。`storage` 选项默认值为 `jsonl`。显式设置 `storage: sqlite` 后，写入 `<root>/.segments/sessions.sqlite`。首次打开支持的 JSONL 历史（包括只读打开）会在事务内导入并保留原文件。后续事件写入 SQLite。并发读者等待导入，然后与写入者并存读取 SQLite。

直接读取 JSONL 的外部工具将无法看到新事件。保留的 JSONL 不为已导入 Session 提供回退或降级。浏览器 Worker 明确选择 `storage: jsonl` 和 `compression: none`。

## 迁移

1. 升级前，停止所有写入配置 `root` 的应用，并备份完整根目录。后续备份一起保留数据库、SQLite 辅助文件、路由记录与原 JSONL；复制前停止写入者。
2. 保留现有插件与 `root` 配置即可使用 SQLite。`compression` 控制旧 JSONL 编码，不控制 SQLite。将外部历史读取工具改为使用 [Session 持久化服务](../../../../packages/session/session-persistence/README.zh.md)。
3. 如需启用 SQLite，在打开 Session 前，在插件 `config` 中显式设置 `storage: sqlite`。省略 `storage` 或选择 `storage: jsonl` 会继续输出 JSONL，不导入历史。导入后如需切换存储，为新 Session 使用独立根目录；保留的 JSONL 缺少后续 SQLite 事件。
4. 打开已有 Session，确认能读取历史，追加一个新 turn，再次打开确认该 turn 已持久化。使用 SQLite 时，确认 `.segments` 下存在数据库；不要根据旧 JSONL 未变化判断写入丢失。
