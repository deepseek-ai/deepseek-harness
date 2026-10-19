---
description: "从 Web 对话标题栏查看实验性共享任务板。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-agent-team

[English](README.md) | 中文

## 概述

此包在 Web 对话标题栏中添加共享任务板面板。Host 投影帧持续更新任务状态，无需刷新控件。普通 subagent（子智能体）导航负责成员列表和队友对话。通过实验性 Agent Teams bundle 选择此包；它不添加模型可见输入。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在根会话的模型与推理等级菜单中打开**使用智能体团队**。新 Session 默认关闭。开启时显示共享任务板入口；成员仍由现有 Subagent 树展示。关闭后保留任务和子代理。开关等待保存后的投影更新，失败由菜单宿主提示。

通过 [`@deepseek-ai/dsh-experimental-agent-team-profile`](../agent-team-profile/README.zh.md) 启用本包。这个组合包同时提供团队服务、工具与 Web 界面。Web Client loader 挂载 `/client` export；root Host export 不执行行为，本包也没有用户配置字段。

### 查看任务板

可开始的 pending 任务使用 idle 灰点，被依赖阻塞的 pending 任务使用 warning 橙点，in-progress 任务使用 ongoing loading，completed 任务使用 done 绿点。

只读任务板显示任务身份、所有者标签、阻塞项、就绪状态、建议写入范围和重叠警告。根负责人显示为“主代理”；其他负责人优先使用 subagent 目录标签，其次为 Session 标题，最后为 Session id。长描述可展开。标题显示任务数量，空任务板提供简短说明。Agent 通过工具修改任务；面板不提供修改控件。投影失败显示在最后有效任务上方。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Client export 通过 Cordis effect 注册语言字典、会话标题栏与模型菜单 slot；它不挂载 Remote namespace。销毁插件 fiber 会移除这些注册。

面板渲染于对话容器之外，并保持在视口内。悬停 150ms 后打开；离开触发器和面板 120ms 后关闭。点击会固定面板并将焦点移入。外部点击和 Escape 关闭面板；焦点原在面板内时，Escape 将其送回。窄标题栏使用点击打开的图标触发器。面板通过 Session 祖先关系解析根并读取其 `agentTeam` 投影。祖先关系不完整或投影数据缺失时，任务板不可用；切换对话时关闭面板。

| 文件 | 职责 |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | 语言字典和标题栏插槽注册 |
| [`src/client/TeamAction.tsx`](src/client/TeamAction.tsx) | 从投影派生的任务板和面板交互状态 |
| [`src/client/locales.ts`](src/client/locales.ts) | 中英文 panel 文案 |
| [`src/index.ts`](src/index.ts) | 不执行行为的 Host entry |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Agent Teams bundle](../agent-team-profile/README.zh.md)——挂载本 Client plugin 的公开 opt-in bundle。
- [Agent Teams 服务](../agent-team/README.zh.md) — 任务和投影行为的权威来源。
- [会话 UI](../../client/ui-conversation/README.zh.md)——稳定 header slot 与 addressed-subagent 导航表层。
- [实验性包](../README.zh.md)——孵化状态与发布规则。

-----

<a id="model-experience"></a>
## 模型体验

无直接影响，因为该浏览器 projection 不注册面向模型的输入。

#### KV Cache 影响

无直接影响；Team 工具与普通会话提交负责后续任何模型可见用途。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **无邮箱时间线** — 面板显示任务，不显示消息。
- **晚启用插件** — 在已经打开的会话中启用 Agent Teams 后，需要刷新页面才能接收其 Team 投影。
- **所有者标签缺失** — Session 或目录元数据尚未读取时显示 id，直到普通加载提供描述。
- **成员导航独立** — 使用普通 subagent 标题栏打开队友对话。
- **没有 lifecycle 或 workspace control**——panel 不能 spawn、rename、delete 或 interrupt teammate，write scope 仍只是提示性 metadata。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
