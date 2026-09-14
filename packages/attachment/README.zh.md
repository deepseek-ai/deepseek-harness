---
description: "持久图片附件能力族的包映射：你可以用图片附件做什么，以及你的图片存放在哪里。"
kind: "package-group"
---

# attachment/：持久附件能力族

[English](README.md) | 中文

## 概述

`attachment/` 组提供持久图片附件：把图片附加到提示词和命令，harness 会把它保存到你的机器上，重新显示在对话历史中，并在后续轮次发送给模型。随附的 `dsh` 组合无需任何设置即可支持这一点。该能力与它的存储拆分为两个包，见下文。已存储的图片在重启后依然存在且永远不会被自动删除，并且只支持光栅图片格式。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

这两个包提供持久图片附件；每个 README 描述其各自部分可以做什么。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`attachment/`](attachment/README.zh.md) | 可用于提示词与命令、会持久保存并回到历史中的图片附件 | `ctx.attachments` |
| [`attachment-local/`](attachment-local/README.zh.md) | 把附加图片存储在本机 `DSH_HOME` 下 | 注册到 `ctx.attachments` |

-----

<a id="related-documentation"></a>
## 相关文档

先从子系统参考了解服务约定，再看能力 seam 表与本地后端的配置面。

- [附件子系统参考](../../docs/subsystems/attachment.zh.md)——服务约定、载荷类型与 `ctx.attachments` 的 Cordis 接口面。
- [能力 seam](../../docs/capability-seams.zh.md)——本家族遵循的 Service Definition / Service Provider / Consumer 拆分。
- [生成配置目录](../../docs/config-catalog.zh.md#deepseek-aidsh-attachment-local)——本地后端的每个受支持字段。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
