---
description: "可选的按轮次 tmux 位置上下文，供启用或调优 agent 的 session、window 与 pane 感知的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tmux-context

[English](README.md) | 中文

## 概述

`dsh-tmux-context` 告诉模型它的 agent（智能体）进程运行在哪里：在 tmux 状态发生变化的每一轮，它追加一条持久、带来源的读数，命名 tmux session、window 与 pane，以及该 window 的 pane 树布局。它在准备模型请求时每轮采样一次，且仅当进程确实位于所指名的 pane 内时——仅从 tmux 祖先进程继承了 `$TMUX`／`$TMUX_PANE` 的终端会被视为不在 tmux 中，不添加任何内容。位置未变化时不添加任何内容；查询失败是空操作，绝不导致轮次失败。本插件需主动启用，且不属于随附 Web／无头组合。

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

当 agent 进程运行在 tmux 内、且模型需要知道其 window 与 pane 位置时，挂载此插件。每条读数都是持久历史中额外的一条 user 角色消息；位置未变化时不添加任何内容，因此长时会话累积很少。

### 模型能得到什么

在 tmux 状态发生变化的每一轮，模型会收到一条带来源标记的上下文消息，包含 session 名称、window 索引与名称、pane 索引与 id、活动标志，以及紧凑的 pane 树布局。读数只发生在每轮的第一个步骤；轮次中途移动或缩放的 pane 会在下一轮反映。像素尺寸有意省略，相邻 pane 的可见内容从不采集。

### 配置

最小挂载无需任何配置。正的 `refreshIntervalMs` 会额外抑制距最近一次注入不足该毫秒数的注入；省略或设为 `0` 时，只要 tmux 状态自上次注入以来发生变化就注入。

```yaml
- name: '@deepseek-ai/dsh-tmux-context'
  config:
    refreshIntervalMs: 60000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `refreshIntervalMs` | `0`（每个变化轮次） | 同一会话中两次持久注入之间的最小毫秒数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tmux-context)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 何时知道位置

只有当进程的控制终端与 pane 的 `#{pane_tty}` 一致时，才视为位于 tmux 中；从 tmux shell 启动的终端（VS Code 集成终端、桌面启动器）会继承变量但不在 pane 内，因此被视为不在 tmux 中。`ctx.shell` 缺失、环境变量不存在或读数格式非法时是空操作；执行器拒绝会被兜住并记录为警告，而不会使该轮失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释插件的设计；可观察行为见[使用本包](#use-this-package)。

### 设计理念

插件前置注册一个 `agent/pre-step` 监听器，仅在每轮的第一个步骤运行。需要注入时，它通过 `ctx.shell` 执行器服务运行一条只读命令——部署方的沙箱与策略都会应用，插件不拥有任何子进程代码。命令在输出制表符分隔字段前，会比较 `$TMUX_PANE` 的 `#{pane_tty}` 与本进程自身的控制终端，因此继承的环境会被视为不在 tmux 中。插件只在渲染出的状态与上次注入不同时重新注入。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：第一步监听器、shell 查询、变化抑制、调度 |
| — | 不发布运行时不变式伴生入口；每次读取都是外部 tmux 状态的单轮快照，Session 没有可检查的跨事件关系；调度与格式由 pipeline 测试负责。 |

### 主要流程

在每轮的第一个步骤，监听器检查注入是否到期，通过 `ctx.shell` 查询位置，并把渲染状态与该来源最近一次持久注入比较。变化抑制与间隔调度会扫描原始持久会话事件，因此调度可跨压缩（compaction）与恢复的进程存续，无需进程内缓存状态；各会话独立调度。下游在步骤前运行的监听器拒绝或失败时，该读数不会被记录。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

包级约定不够用时阅读以下页面。它们从设计决策进入查询所经由的执行器与穷尽式配置。

- [tmux 位置上下文决策记录](../../../.agents/notes/implemented/feature/2026-07-27-tmux-location-context.zh.md)——基于 tty 的检测与读数形状的设计理由。
- [shell 子系统](../../../docs/subsystems/shell.zh.md)——只读查询所经由的执行器服务。
- [context 组地图](../README.zh.md)——相邻的请求上下文包。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tmux-context)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 准备期 tmux 位置

#### 模型看到的内容

在 tmux 状态发生变化的每一轮，注入一条带来源标记、含以下三行的上下文消息。`<window-layout>` 是 tmux 紧凑的 pane 树描述；pane 与 window 的像素尺寸有意省略，相邻 pane 的内容从不采集。

##### 变化轮次读数

```markdown
tmux location (turn <turn>):
session <session>, window <index> "<name>", pane <index> <pane-id>
window active=<0|1>, pane active=<0|1>, layout <window-layout>
```

#### Token 影响

每条三行读数会累积，直到压缩将其遮蔽。位置未变化以及间隔抑制不会新增内容。

#### KV Cache 影响

仅追加；新增可见内容位于可复用的请求前缀之后，不会使已有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明 tmux 位置上下文何时不合适。它们是当前包约束。

- **仅第一个步骤**——轮次中途移动或缩放的 pane 会在下一轮反映，而非在步骤之间。
- **仅自身位置**——插件从不采集相邻 pane 的可见文本。
- **只有布局，没有尺寸**——省略 pane/window 像素尺寸；仅报告布局树与活动标志。
- **制表符分隔字段**——若 tmux window 名称包含字面两字符序列 `\t`，会使读数分割错误并作为非法读数跳过；常规名称不受影响。
- **基于 tty 的 pane 判定**——只有当进程的控制终端与 `$TMUX_PANE` 的 `#{pane_tty}` 一致时，才视为「位于 tmux 中」。这会有意排除从 tmux 祖先进程继承 `$TMUX`／`$TMUX_PANE` 的终端（如 VS Code 集成终端）。`ps -o tty=` 属于 POSIX；在其或 `#{pane_tty}` 不可用的环境中，该检查即为空操作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
