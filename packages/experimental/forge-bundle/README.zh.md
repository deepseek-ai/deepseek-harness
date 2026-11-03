---
description: "从插件页面启用变更请求面板与 worktree Session。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-forge-bundle

[English](README.md) | 中文

## 概述

查看每个 Session 的变更请求、检查与代码差异，在 Git 工作树中开始新 Session，或在对话中让模型创建工作树。在 Web 或 Desktop 的插件页面启用“变更请求与工作树”；发布的 profile 默认禁用该功能。GitHub 状态来自宿主上已登录的 `gh` 命令行；创建本地工作树无需 GitHub 认证。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

打开插件页面，在官方分组中启用“变更请求与工作树”。在 Git 工作区中，发出第一条消息之前在输入框中勾选“工作树”，Session 就会在新的 worktree 中开始。Session 的目录位于 Git 检出中时，标题栏按钮会打开面板。Session 用 `gh pr create` 创建、用 `gh pr view`、`gh pr edit` 或 `gh pr checkout` 打开的 GitHub pull request，以及 Session 所在分支上或之后 `git push` 更新的 pull request，无需额外操作即会作为变更请求出现。在终端运行 `gh auth login --hostname <host>` 登录；缺少登录时，面板会显示这条命令。[面板包](../client-ui-forge/README.zh.md#use-this-package)说明了每个控件。

同一个开关也启用模型的 [`create_worktree`](../tool-worktree/README.zh.md) 工具。关闭后面板和工具一起移除，已有检出目录与分支仍然保留。已选中独立工作树组合包的 profile，请在启用本组合包前按[升级指南](../../../docs/upgrade-guide/v0.2.2-alpha.2/forge-worktree-entry/guide.zh.md)调整配置。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>维护者细节——点击展开</summary>

组合包挂载 Forge 注册表、GitHub 提供方、Session 绑定和工作树模型工具。工具使用顶层 `worktree` 服务；面板在 `optional-forge-panel` 内保留隔离的 `forge-worktree` 服务。两者的配置 id 和创建流程各自独立。面板记录 Session 开始前请求的工作树；模型创建的工作树不会获得面板的恢复记录。这些行使用基于 base 的 profile 提供的 Session 投影、工作目录、文件系统、子进程和沙箱服务。

</details>

-----

<a id="further-exploration"></a>
## 深入探索

[Forge 子系统](../../../docs/subsystems/forge.zh.md) · [Session 绑定](../forge-session/README.zh.md) · [面板](../client-ui-forge/README.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

间接影响：通过 [`create_worktree`](../tool-worktree/README.zh.md#model-experience) 工具，以及以工作树开始的 Session 的[面板目录通知](../client-ui-forge/README.zh.md#model-experience)。

#### KV Cache 影响

启用或关闭组合包会改变模型的工具 schema 列表。调用追加工具结果和目录上下文；参见[工具的缓存行为](../tool-worktree/README.zh.md#model-experience)。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- 只有 GitHub 一个代码托管提供方，且本 Bundle 只服务 github.com；GitHub Enterprise 主机需要用 profile patch 把它列入 `forge-github` 行的 [`hosts`](../forge-github/README.zh.md#use-this-package)。没有提供方识别 GitLab 等其他平台。
- 模型目前还没有读取已绑定变更请求的工具。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
