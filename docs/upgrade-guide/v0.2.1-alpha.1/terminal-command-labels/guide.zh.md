---
kind: upgrade-guide
description: "自定义 TerminalBlock 消费者必须为横向溢出的命令行提供本地化的无障碍名称。"
---

# 终端命令标签

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-client-ui-primitives` 的 `TerminalBlockLabels` 要求提供 `commandLine(line: number): string` 格式化函数。此前，调用者不提供命令行的无障碍名称。现在，每条横向溢出的命令行使用这个名称标识可通过键盘聚焦的分组；能够完整显示的行（包括折行后的行）不会增加 Tab 停靠点。这会影响渲染 `TerminalBlock` 的自定义 UI 插件。

## 迁移

1. 为传给 `TerminalBlock` 的每个 labels 对象添加 `commandLine`。参数是原始命令文本的行号，从一开始。
2. 通过插件的语言字典返回本地化名称，例如“命令第 1 行”。名称与原始命令文本分开保留。
3. 重新构建插件。确认长命令可通过键盘聚焦并使用方向键滚动，短命令或折行后的命令则不会增加 Tab 停靠点。
