---
description: "从插件页面启用变更请求面板与 worktree Session。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-forge-bundle

[English](README.md) | 中文

## 概述

展示每个 Session 的变更请求及其检查与评审状态，并让新 Session 在自己的 Git worktree 中开始。在 Web 或 Desktop 的插件页面启用“变更请求与工作树”；发布的 profile 默认禁用该功能。GitHub 状态来自宿主上已登录的 `gh` 命令行；没有它时，面板仍会显示分支，工作树选项也照常可用。

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

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>维护者细节——点击展开</summary>

Bundle patch 以宿主行插入 forge 注册表、GitHub 提供方与 Session 绑定，并插入一个隔离 `worktrees` 服务的分组，其中包含一个 worktree 服务行与面板的双端包；该行启用期间，Web 与 Desktop 客户端会加载其客户端部分。隔离让本套件可以与 Git Worktrees 套件共存，后者的模型工具保有自己的服务。这些行依赖每个基于 base 的 profile 都会组合的 Session 投影注册表、工作目录、文件系统、子进程与沙箱服务。

</details>

-----

<a id="further-exploration"></a>
## 深入探索

[Forge 子系统](../../../docs/subsystems/forge.zh.md) · [Session 绑定](../forge-session/README.zh.md) · [面板](../client-ui-forge/README.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

无：组合的包不增加模型工具或提示词；以 worktree 开始的 Session 的目录通知通过工作目录服务告知模型，详见[面板](../client-ui-forge/README.zh.md#model-experience)。

#### KV Cache 影响

Bundle 本身没有影响；worktree 通知见[面板](../client-ui-forge/README.zh.md#model-experience)。

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
