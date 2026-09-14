---
description: "人机协作能力族的包映射：斜杠命令、一次性审批、权限预设，以及让运行中的 agent（智能体）暂停等待人类决定的问答 seam。"
kind: "package-group"
---

# interaction/：人机协作平面

[English](README.md) | 中文

## 概述

`interaction/` 组覆盖用户引导运行中 agent 的各种方式。斜杠命令适合无需模型往返的即时操作；一次性审批用于敏感操作；权限预设可以同时选择沙箱与审批行为；当 agent 需要信息或决定时，它还可以向用户提问。交互式应用向用户提供这些能力；自动化则通过 ACP（Agent Client Protocol）处理自己的审批。下方包映射说明了每项能力的区别，并链接其完整行为与配置。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

每个包的完整约定以其 README 和对应的子系统参考为准。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`commands/`](commands/README.zh.md) | 让用户输入斜杠命令，直接针对 agent 执行，无需模型往返 | `ctx.commands` |
| [`user-approval/`](user-approval/README.zh.md) | 向组合后的应答者征求一次性允许／拒绝决定；若未获得决定，则默认拒绝 | `ctx.approval` |
| [`permission-presets/`](permission-presets/README.zh.md) | 把沙箱模式与审批策略捆绑为一个面向用户的权限选择器 | `ctx.permissionPresets` |
| [`user-questions/`](user-questions/README.zh.md) | 定义经过校验的问题 schema 与作用域 answerer waterfall，agent 可暂停等待 | `ctx.userQuestions` |
| [`tool-ask-user/`](tool-ask-user/README.zh.md) | 暴露 `ask_user_question` 工具，让模型可以向用户提问并请求其作出决定 | 注册到 `ctx.tools` |

-----

<a id="related-documentation"></a>
## 相关文档

先从子系统参考了解共享词汇，再看相邻的自动化与组合面。

- [命令子系统](../../docs/subsystems/commands.zh.md)——命令注册表语义与 `ctx.commands` 的 Cordis 接口面。
- [审批子系统](../../docs/subsystems/approval.zh.md)——请求／结果词汇、应答者瀑布与按会话策略。
- [权限预设子系统](../../docs/subsystems/permission-presets.zh.md)——预设表与旋钮写穿。
- [用户交互子系统](../../docs/subsystems/user-questions.zh.md)——问题词汇、answerer waterfall 与呈现意图。
- [ACP 组](../acp/README.zh.md)——仅自动化的传输，为其自有 agent 回答审批请求。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
