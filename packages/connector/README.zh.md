---
description: "connector 分组地图：通过现有 Skill、Shell 与 subprocess 能力把第三方服务接入 agent 的应用插件，以及它们共用的 CLI 账号库。"
kind: "package-group"
---

# connector/ — 应用插件

[English](README.md) | 中文

## 概述

本分组中的每个应用插件安装到 profile 后，即可在对话中使用一个第三方服务。插件组合 skill（技能）、运行时上下文和 subprocess 等现有能力，并把应用特有的配置和模型指引保留在自己的包内。由厂商 CLI 保管用户账号的插件，共用 CLI 账号库来执行命令和账号操作。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`cli-account/`](cli-account/README.zh.md) | 为 CLI 应用插件按绝对路径运行厂商 CLI，在运行时上下文中把这个路径告诉模型，并在 Host 上一次执行一个账号操作 | — |
| [`feishu/`](feishu/README.zh.md) | 打包飞书插件：`feishu-cli` Host 行及其插件页行 | — |
| [`feishu-cli/`](feishu-cli/README.zh.md) | 把官方飞书 `lark-cli` 安装到私有 Shell PATH 上，注册其内嵌 skill，并执行插件页发起的账号操作 | `ctx.feishu`；注册到 `ctx.skills` 与 `ctx.shellEnv` |

-----

<a id="related-documentation"></a>
## 相关文档

- [Skill 子系统参考](../../docs/subsystems/skills.zh.md)——connector skill 使用的注册表与提供方契约。
- [System prompt](../core/system-prompt/README.zh.md)——排序并渲染运行时上下文的注册表。
- [CLI 插件页组件](../client/ui-cli-account/README.zh.md)——CLI 账号库在插件页的一半。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
