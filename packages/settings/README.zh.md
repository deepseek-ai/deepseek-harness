---
description: "用于插件即时配置的 schema 派生表单。"
kind: "package-group"
---

# settings/——插件配置表单

[English](README.md) | 中文

## 概述

通过各插件 Config schema 派生的表单编辑即时配置。当前 profile patch 保存编辑，Loader 应用更改。插件读取自己的 volatile 引用。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

<a id="packages"></a>
## 包

包 README 负责表单行为；设置参考负责其类型。

| 包 | 用途 | ctx 键 |
|---|---|---|
| [`settings`](settings/README.zh.md) | Config 投影及带修订号的表单编辑 | `settings` |

<a id="related-documentation"></a>
## 相关文档

- [设置参考](../../docs/subsystems/settings.zh.md)——描述符与编辑。
- [配置编辑器](../boot/config-editor/README.zh.md)——profile 持久化。
- [Volatile 配置](../../vendor/loader/README.md)——无需重新挂载的更新。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
