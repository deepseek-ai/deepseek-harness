---
description: "面向部署方与后端作者的会话遥测捕获 seam 说明，用于选择上报后端、挂载脱敏规则或实现后端约定。"
kind: "package-library"
---

# @deepseek-ai/dsh-session-telemetry

[English](README.md) | 中文

## 概述

`dsh-session-telemetry` 捕获会话活动用于对外上报：它把每个会话事件复制为一条遥测记录，允许部署方脱敏，再交给实现该约定的上报后端。部署方不直接加载本包——它们只加载一个后端（随附的 OpenTelemetry 后端是 `dsh-session-telemetry-otel`），由它注册 `ctx.sessionTelemetry` 并组装捕获协调器。seam 拥有捕获、脱敏与共享披露；批处理、重试、排队与丢失策略属于后端自身的 SDK，止于 `emit()`。每个已挂载后端都披露其部署级共享策略，使确认 surface 能够报告会话是否以及如何被共享。约定与捕获行为在前；实现内部细节放在下方可折叠的开发者章节中。

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

作为部署方，选择一个后端并挂载它，当记录不能以捕获原样离开进程时添加脱敏规则。作为后端作者，实现三成员约定，并以一种捕获模式组装协调器。

### 选择并挂载后端

只加载一个后端插件；它把捕获协调器与投递流水线注册为 `ctx.sessionTelemetry`。重复加载会抛出异常。必需的 [`sharing` 成员](#the-sharing-disclosure) 报告部署模式，不代表会话准入或投递。只有在未挂载任何遥测服务时，消费方才可报告「未配置」。`/feedback` 命令确认记录，不读取此策略。

### 后端约定

后端实现三个成员：`emit(record)` 必须是非阻塞入队，因为它会在会话事件路径上同步执行；可选的 `flush()` 是轮次结束后的即发即忘提示，多数后端为了遵循 SDK 自身的批处理计划而省略它；`shutdown()` 排空已入队记录，并在 SDK 停止后结束，dispose（资源释放）会等待它。实现 `flush()` 的后端必须安排并发 flush 与最终 `shutdown()` 排空的先后顺序。

### 捕获内容

捕获以两种模式之一运行。`live` 捕获在追加时跟随会话事件、在挂载时回放已存活会话并记录生命周期标记；`on-demand` 捕获只在后端通过 `captureSession(session, throughSeq?)` 请求前缀时读取权威会话日志。协调器选项决定是否包含存储历史。每条权威会话事件都按顺序映射为一条 ledger 记录。`assistant/message` 或 `assistant/attempt` 记录会携带完整的嵌入式紧凑 stream，包括失败和重试输出。每条 ledger 记录还携带 `session.id`、`session.format_version`、数值事件身份、可选 header 事实与预先映射的严重级别（`tool/result.isError`、`turn/end` 的错误原因与 `agent-error` 映射为 `error`；其余为 `info`）。

### 共享披露

<a id="the-sharing-disclosure"></a>

每个后端通过 `sharing` 披露部署模式：`full`、`feedback-only` 或 `disabled`。后端还可限制符合条件的 Session。该属性不是投递回执；交接是非阻塞入队，批处理、重试与丢失策略属于后端 SDK。

### 脱敏记录

<a id="the-redact-waterfall"></a>

协调器复制权威事件后，每条外发记录都会立即经过 `sessionTelemetry/record` waterfall（瀑布式事件）。本包不带任何规则：未挂载监听器时，记录以捕获时的原样到达后端，因此导出数据能干净到什么程度，恰恰取决于部署方挂载了什么规则。监听器通过变换 `next()` 的返回值来堆叠；抛出异常的监听器以 fail-closed 方式拦下这一条记录。脱敏只作用于外发副本——权威会话日志永不改写。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释捕获设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

seam 建立在一个边界之上：harness 的职责止于 `emit()`。完整事件捕获、脱敏与 handoff 游标都在这里；批处理、重试、排队与丢失策略属于上报 SDK，本包有意不建模也不包装。设计与被否决的替代方案见[复活 Agent Note](../../../.agents/notes/implemented/feature/2026-07-23-session-telemetry-otel-revival.zh.md)。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Service Definition：`SessionTelemetryBackend`/`SessionTelemetrySink` 约定、记录词汇、`session-telemetry/record` waterfall 声明 |
| [`src/coordinator.ts`](src/coordinator.ts) | 捕获：live 监听器、生命周期本地 on-demand 回放、脱敏、handoff 游标、异常隔离 |

### 捕获流程

实时捕获通过组合 fiber 的 effect 注册 Session 事件、刷新提示、关闭标记与 agent/error 观察器。按需捕获只注册释放 effect，并按历史策略读取请求的权威日志前缀。同步处理器隔离失败，避免影响 agent loop 或其他监听器。

### handoff 游标

模块作用域的 `WeakMap<Session, seq>` 记录已交接而非已投递的最高序号。重新收养同一对象时从该游标之后继续。捕获通常从 `firstLiveSeq` 开始；显式 `includeHistory: true` 从未交接对象的 seq 0 开始，包含恢复或分叉历史。后端负责捕获授权。存储的历史本身不授权捕获；OTel 后端等待新的显式反馈。接收方按 `(session.id, session.format_version, event.seq)` 对重复记录去重。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当 seam 约定不够用时阅读以下页面。它们从随附后端逐步进入子系统参考与决策证据。

- [OpenTelemetry 遥测后端](../session-telemetry-otel/README.zh.md)——部署方加载的随附后端，含模式与导出器配置。
- [会话遥测子系统](../../../docs/subsystems/session-telemetry.zh.md)——能力拆分与类型声明。
- [会话遥测复活决策](../../../.agents/notes/implemented/feature/2026-07-23-session-telemetry-otel-revival.zh.md)——理由、权衡与被否决的替代方案。
- [会话包映射](../README.zh.md)——相邻的持久化、投影、标题与遥测包。

-----

<a id="model-experience"></a>
## 模型体验

无，因为该 seam 观察会话流并把脱敏后的副本交给外部；它不注册任何面向模型的内容。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义部署方能得到的投递与数据保护保证。它们是当前包约束。

- **尽力而为的投递**——游标标记的是已交接而非已投递；在重载窗口内被拆除的会话无法重新收养，崩溃时留在后端队列中的内容会丢失。持久化 outbox（spool、每 sink 游标、at-least-once）推迟到有部署方提出明确的崩溃丢失要求时再实现。
- **不内置脱敏规则**——未挂载 `sessionTelemetry/record` 监听器时，记录以捕获时的原样离开进程，包括文件内容或命令输出中内嵌的任何凭据；向共享 collector 导出的部署方自行负责其规则集。
- **按需脱敏使用当前状态**——未捕获的事件只存在于权威会话日志中；后续的 `captureSession()` 会使用当时挂载的策略，深拷贝并脱敏其当前值，且不存在捕获时的遥测快照或持久化的捕获前 spool。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。全部输出都是权威事件流之外的同步 backend handoff，capture 端不追加 Session 事件，因此没有独立事件或数据关系。
