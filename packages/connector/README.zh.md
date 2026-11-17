---
description: "connector 分组地图：通过现有 Skill、Shell 与 subprocess 能力把第三方服务接入 agent 的应用插件，以及它们注册到的 CLI 账号 Service 和上游技能 Service。"
kind: "package-group"
---

# connector/ — 应用插件

[English](README.md) | 中文

## 概述

本分组中的每个应用插件安装到 profile 后，即可在对话中使用一个第三方服务。插件组合 skill（技能）、运行时上下文和 subprocess 等现有能力，并把应用特有的配置和模型指引保留在自己的包内。由厂商 CLI 保管用户账号的插件，把这个 CLI 和账号注册到 CLI 账号 Service，由它执行插件的命令和账号操作；上游技能只存在于厂商 GitHub 仓库的插件，把入口技能注册到上游技能 Service，由它下载这些技能。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`cli-account/`](cli-account/README.zh.md) | 保存 CLI 应用插件注册的厂商 CLI 和账号：在运行时上下文中把每个 CLI 的绝对路径告诉模型，让每个插件的账号操作一次只执行一个，并在插件页显示账号 | `ctx.cliAccounts` |
| [`upstream-skills/`](upstream-skills/README.zh.md) | 保存 CLI 应用插件注册的入口技能：从厂商 GitHub 仓库的固定提交下载每个入口索引的上游文件，校验并缓存，再在这些文件之上列出入口技能 | `ctx.upstreamSkills` |

-----

<a id="related-documentation"></a>
## 相关文档

- [Skill 子系统参考](../../docs/subsystems/skills.zh.md)——connector skill 使用的注册表与提供方契约。
- [System prompt](../core/system-prompt/README.zh.md)——排序并渲染运行时上下文的注册表。
- [连接器账号界面](../client/ui-connector-account/README.zh.md)——CLI 应用插件在插件页显示账号的注册表。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
