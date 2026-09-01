---
description: "面向部署方与后端作者的会话遥测捕获 seam 说明，用于选择上报后端、挂载脱敏规则或实现后端约定。"
kind: "package-library"
---

# @deepseek-ai/dsh-session-telemetry

[English](README.md) | 中文

## 概述

`dsh-session-telemetry` 捕获会话活动用于对外上报：它把会话事件投影为遥测记录，允许部署方脱敏，再交给实现其约定的上报后端。部署方不直接加载本包——它们只加载一个后端（随附的 OpenTelemetry 后端是 `dsh-session-telemetry-otel`），由它注册 `ctx.sessionTelemetry` 并组装捕获协调器。seam 拥有捕获、脱敏与共享披露；批处理、重试、排队与丢失策略属于后端自身的 SDK，止于 `emit()`。每个已挂载后端都披露其部署级共享策略，使确认 surface 能够报告会话是否以及如何被共享。约定与捕获行为在前；实现内部细节放在下方可折叠的开发者章节中。

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

只加载一个后端插件；它把捕获协调器与自己的投递流水线注册为 `ctx.sessionTelemetry`，重复加载会抛出异常。已挂载后端通过必需的 [`sharing` 成员](#the-sharing-disclosure) 披露共享策略，`/feedback` 的确认文本会渲染它；只有在未挂载任何遥测服务时，消费方才渲染「未配置」。

### 后端约定

后端实现三个成员：`emit(record)` 必须是非阻塞入队，因为它会在会话事件路径上同步执行；可选的 `flush()` 是轮次结束后的即发即忘提示，多数后端为了遵循 SDK 自身的批处理计划而省略它；`shutdown()` 排空已入队记录，并在 SDK 停止后结束，dispose（资源释放）会等待它。实现 `flush()` 的后端必须安排并发 flush 与最终 `shutdown()` 排空的先后顺序。

### 捕获内容

捕获以两种模式之一运行。`live` 捕获在追加时跟随会话事件、在挂载时回放已存活会话并记录生命周期标记；`on-demand` 捕获只在后端通过 `captureSession(session, throughSeq?)` 请求前缀时读取权威会话日志。ledger 记录与会话事件一一对应，唯有一个投影例外：每个 `(turn, step)` 只发出第一条 `assistant/chunk`，因此导出流中的 `seq` 缺口是常态，绝不是丢失信号。每条记录携带事件的完整数据、最小身份属性与预先映射的严重级别（`tool/result.isError`、`turn/end` 的错误原因与 `agent-error` 映射为 `error`；其余为 `info`）。

### 共享披露

<a id="the-sharing-disclosure"></a>

每个后端都通过 seam 的 `sharing` 词汇披露其部署级共享策略：`full`（每个事件在发生时立即交接）、`feedback-only`（在 `feedback/record` 事件释放其之前的未释放前缀之前，不交接任何内容）或 `disabled`（完全不交接任何内容）。已记录反馈条目的确认文本会报告该状态；披露从不声称投递——交接是非阻塞入队，批处理、重试与丢失策略仍归后端 SDK。

### 脱敏记录

<a id="the-redact-waterfall"></a>

每条外发记录在投影后立即经过 `sessionTelemetry/record` waterfall（瀑布式事件）。本包不带任何规则：未挂载监听器时，记录以捕获时的原样到达后端，因此导出数据能干净到什么程度，恰恰取决于部署方挂载了什么规则。监听器通过变换 `next()` 的返回值来堆叠；抛出异常的监听器以 fail-closed 方式拦下这一条记录。脱敏只作用于外发副本——权威会话日志永不改写。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释捕获设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

seam 建立在一个边界之上：harness 的职责止于 `emit()`。捕获、投影、脱敏与 handoff 游标都在这里；批处理、重试、排队与丢失策略属于上报 SDK，本包有意不建模也不包装。设计与被否决的替代方案见[复活 Agent Note](../../../.agents/notes/implemented/feature/2026-07-23-session-telemetry-otel-revival.zh.md)。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Service Definition：`SessionTelemetryBackend`/`SessionTelemetrySink` 约定、记录词汇、`session-telemetry/record` waterfall 声明 |
| [`src/coordinator.ts`](src/coordinator.ts) | 捕获：live 监听器、on-demand 回放、分片投影、脱敏、handoff 游标、异常隔离 |

### 捕获流程

live 捕获通过组合方 fiber 的 effect 注册：`session/created` 收养会话并从 handoff 游标起回放其日志；`session/event` 投影、深拷贝、脱敏并交接，零 I/O；`session/flush` 转发可选的提示并返回 void，使循环所等待的并行任务绝不等待遥测；`session/disposed` 捕获会话的 `shutdown` 标记并退役它；`agent/error` 是唯一的实时总线转发，因为会话事件词汇有意不包含运维错误记录。dispose 会为仍存活的会话捕获 shutdown 标记，然后等待后端的 `shutdown()`。on-demand 捕获只注册 dispose effect，并在请求时读取权威日志。每个同步处理器都运行在异常隔离之内，使失败的后端或规则永远不会饿死其他监听器，也永远不会触及 agent loop。

### handoff 游标

一个模块作用域的 `WeakMap<Session, seq>` 按会话记录已交接（而非已投递）的最高 seq。live 捕获在追加时推进它；on-demand 捕获只在交接所请求的前缀时推进它。未捕获的前缀只留在权威日志中，因此协调器重载不会增加遥测自有的恢复状态；游标缺失时安全退化为从会话构造边界起重新交接，由接收端基于 `(session.id, event.seq)` 的去重吸收。这是对「注册即 effect」纪律的一次有意的、有文档说明的窄例外：条目随其会话消亡，值是单调水位线，丢失它绝不是错误。由此接受的代价与至多一次（at-most-once）投递一致：恢复的会话不会回填上一个进程未能投递的记录。

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
