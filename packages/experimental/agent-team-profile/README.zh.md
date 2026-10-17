---
description: "在一个实验性组合包中启用团队协作、工具与 Web 成员和任务看板。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-agent-team-profile

[English](README.md) | 中文

## 概述

`dsh-experimental-agent-team-profile` 让 [Agent Teams](../agent-team/README.zh.md) 的团队协作、工具和 Web 界面通过一个组合包启用。Lead 把subagent 作为 teammate 启动，它们共享任务看板并互相等待；Web 显示成员、共享任务和成员会话。base profile 的委派与消息工具保持可用。本包随 dsh 安装提供，默认关闭，可在插件页开启或添加到已初始化的 profile。

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

### 安装到 profile

将本包添加到已初始化的 profile，然后运行一个要求 Lead 委派工作的任务：

```sh
dsh plugin --profile headless add @deepseek-ai/dsh-experimental-agent-team-profile
dsh --profile headless "Use Agent Teams to split this task between two teammates, wait, and summarize."
```

profile 必须已经包含 `@deepseek-ai/dsh-base`，本层依赖其中的 Subagent 服务、提供方与工具。执行 `dsh plugin --profile <name> remove @deepseek-ai/dsh-experimental-agent-team-profile` 移除本包时，bundle 也会从 profile 的有序层列表中移除。

在 Web 或 Desktop 的插件页开启「智能体团队」，即可同时启用工具与界面。CLI 的 Web profile 也可使用以下命令：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-experimental-agent-team-profile
```

已有 profile 的 `package.json` 中，`dsh.profile.bundles` 应只保留 `@deepseek-ai/dsh-experimental-agent-team-profile`，删除独立的 `@deepseek-ai/dsh-experimental-agent-team-web-profile` 条目。用户 patch 中的 `ui-agent-team` 配置仍然有效。设置已移除 Team 键的用户 patch 会使对应 Team 配置行无法激活；[升级指南](../../../docs/upgrade-guide/v0.2.1-rc.2/agent-team-subagents/guide.zh.md)列出已移除的键与工具。

### 获得的功能

该层增加 Team 领域、任务板和等待工具以及 UI，不禁用基础配置行。Lead 使用 `subagent` 创建全新上下文，或使用 `subagent_fork` 继承历史，通过 `description` 描述任务。标准控制工具使用代理 id。

在 Web 和 Desktop 会话中，[Team UI](../client-ui-agent-team/README.zh.md) 显示成员列表与共享任务看板，并可打开成员会话。同一个组合包开关控制工具与浏览器 UI。插件页通过组合包的 `package.json.icon` 声明读取其[图标](icon.svg)，组合包禁用时也会显示。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包的运行时内容是 [`cordis.patch.yml`](cordis.patch.yml)。在 `dsh-base` 之后应用时，patch 只插入配置行：带 `maxTasks: 256` 的 Team 服务、Team 工具和 UI。UI 插件的 Host 入口不执行逻辑；只有 Web 客户端加载器会挂载其浏览器入口，因此 headless 无需启动 Web 服务。

| 文件 | 职责 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 叠加在 `dsh-base` 之上的有序 patch |
| [`src/index.ts`](src/index.ts) | 空模块入口；patch 是运行时内容 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [实验性包](../README.zh.md)——孵化状态与发布规则。
- [Agent Teams service](../agent-team/README.zh.md)——Team 成员关系、roster 与持久任务板。
- [Agent Teams 工具](../tool-agent-team/README.zh.md)——每个成员获得的任务与等待工具、策略和身份。
- [Agent Teams 浏览器 UI](../client-ui-agent-team/README.zh.md)——成员列表、任务看板与成员会话导航。
- [Base bundle](../../bundle/base/README.zh.md)——本 patch 扩展的 profile 层。

-----

<a id="model-experience"></a>
## 模型体验

### Team 策略与工具

#### 模型会看到什么

Team 策略、身份与 schema 由 [`@deepseek-ai/dsh-experimental-tool-agent-team`](../tool-agent-team/README.zh.md) 所有。本 bundle 只改变 composition：每个 Team 成员获得五个任务与等待工具，而 `subagent`、`subagent_fork`、`send_message`、`list_agents` 与 `interrupt_agent` 保持 base profile 的 schema。

#### Token 影响

本 bundle 会加入 `@deepseek-ai/dsh-experimental-tool-agent-team` 描述的 Team 策略段落、身份声明与五个工具 schema；它自身不增加提示词文本。

#### KV Cache 影响

每个成员（包括 `subagent_fork` 子级）都收到相同的 Team 策略与工具 schema，因此 fork 保留父级请求前缀；启用或禁用本 bundle 会为每个成员同时改变两者。Team 身份通过 runtime-context 快照追加；[Team 工具](../tool-agent-team/README.zh.md#model-experience)定义快照复用方式。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅显式启用**——本包随安装提供但默认关闭；随附 CLI、Web、SDK、ACP 与 Python profile 都不会启用它。
- **Workflow 子级加入 Team**——可继续的 Workflow `agent()` 子级获得相同的 Team 工具、策略和同级消息路由。Lead 的直接子级出现在其成员列表中。
- **共享 checkout**——所有 teammate 都观察同一个工作目录；本 bundle 不提供 worktree 隔离或文件系统锁。
- **需要 base profile**——teammate 通过 `dsh-base` 挂载的 Subagent 服务、提供方与工具创建和联系；本层不是独立 profile。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
