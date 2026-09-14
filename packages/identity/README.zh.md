---
description: "identity 包组：由遥测、反馈与 DeepSeek 提供方请求共享的匿名关联 id，每个 harness home 一个。"
kind: "package-group"
---

# identity/ — 共享身份

[English](README.md) | 中文

## 概述

identity 组为每个 harness home 提供一个匿名 id，该安装的遥测、反馈与 DeepSeek 请求会把它附加到各自的记录上，因此离开同一个 home 的所有内容都能被识别为来自同一套安装，而无需识别用户身份。无需配置任何东西：id 会在这些功能之一首次运行时自动出现，并在文件被删除前保持稳定。本组只有一个包；本页列出本组的组成，包 README 负责细节。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

<a id="packages"></a>
## 包

| 包 | 职责 |
|---|---|
| [`anonymous-user-id`](anonymous-user-id/README.zh.md) | 让每个 harness home 拥有一个匿名 id，遥测、反馈与 DeepSeek 请求把它附加到记录上，使来自同一安装的记录无需识别用户即可被辨认 |

<a id="related-documentation"></a>
## 相关文档

- [会话遥测子系统](../../docs/subsystems/session-telemetry.zh.md)——在导出中携带该 id 的遥测功能。
- [dsh-llm-deepseek](../llm/llm-deepseek/README.zh.md)——在请求中携带该 id 的 DeepSeek 提供方。
- [dsh-command-feedback](../feedback/command-feedback/README.zh.md)——在确认文本中点名该匿名安装的反馈命令。

<a id="dev-note"></a>
## 开发备注

无。
