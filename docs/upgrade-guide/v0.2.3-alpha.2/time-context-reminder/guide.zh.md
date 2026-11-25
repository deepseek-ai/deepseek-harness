---
kind: upgrade-guide
description: "time-context 的日志文本加上 system-reminder 外框。"
---

# time-context 提醒记录

[English](guide.md) | 中文

## 变更

新写入的 `source.kind: 'time-context'` 的 `user/message` 记录用 `<system-reminder>` 和 `</system-reminder>` 两行包裹三行读数，使模型把读数当作注入的上下文而不是用户输入。`source.sections[0].text` 仍是不带外框的读数。已有记录不会被重写，因此恢复后的 Session 日志中可能同时存在带外框和不带外框的读数。Session 格式不变。

## 迁移

1. 把按字面匹配 time-context 文本的读取方（例如按 `content[0].text` 的 `Time sampled while preparing` 前缀判断）改为按 `source.kind` 识别这类记录，并从 `source.sections[0].text` 读取读数。
2. 继续接受 `content[0].text` 不带外框的旧记录。读取一个同时含升级前后读数的恢复会话，确认两种记录都能被识别。
