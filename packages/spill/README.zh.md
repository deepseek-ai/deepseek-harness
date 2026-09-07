---
description: "文本 spill 能力家族的包映射：存储服务、本地后端与结果策略各自提供什么。"
kind: "package-group"
---

# spill/：文本 spill 能力家族

[English](README.md) | 中文

## 概述

`spill/` 组在模型上下文之外保存全文，并返回定位信息与取回指引。该家族拆分为 `spill/` 中的存储服务、`spill-local/` 中的本地文件系统后端，以及 `spill-policy/` 中的工具结果策略。工具结果 spill 通过 `maxInlineBytes` 按需启用，存储失败时保留原始结果。[会话引用](../context/session-reference/README.zh.md)也直接使用存储来保存被截断的已捕获转录，并负责自己的预览与失败通知；它不需要工具结果策略。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

三个包分别承担 spill 角色；子系统参考文档拥有穷尽式词汇与约定。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`spill/`](spill/README.zh.md) | 存储服务：保存超大文本并返回定位信息与取回指引 | `ctx.spillStore` |
| [`spill-local/`](spill-local/README.zh.md) | 将 spill 文本保存到本机的私有会话级文件 | 注册到 `ctx.spillStore` |
| [`spill-policy/`](spill-policy/README.zh.md) | 用预览和定位信息替换过大的纯文本工具结果 | 监听 `ctx.tools` |

-----

<a id="related-documentation"></a>
## 相关文档

先从子系统参考文档了解共享词汇，再看设计决策。

- [spill 子系统](../../docs/subsystems/spill.zh.md)——`SaveTextSpill`/`SpillRef` 词汇、归属与后端关系。
- [工具输出 spill 决策](../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.zh.md)——存储、保留与工具自有输出处理之间的能力边界。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
