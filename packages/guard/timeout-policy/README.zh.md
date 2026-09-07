---
description: "为配合取消的工具调用设置协作式时间上限，并在超时流程完成后映射为清晰的模型错误，供选择或排查此插件的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-call-timeout-policy

[English](README.md) | 中文

## 概述

工具调用可能会长时间挂起——缓慢的网页抓取、永不返回的搜索——没有上限时模型会无限期等待，拖住整个会话。`dsh-tool-call-timeout-policy` 为声明了限时的调用设置协作式截止时间：它通过 `exec.signal` 请求工具停止，再把已经完成的取消映射为清晰的 `Error: tool call timed out after <ms>ms` 结果。忽略或缓慢处理取消的工具会让调用方继续等待，直到自身完成；本插件绝不会硬性停止下游工作。限时来自每个工具自身的配置，因此插件本身零配置，并随 `dsh` base 组合默认启用。

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

常用路径只有一行：把插件加入组合——`dsh` base 组合已经包含它。配置了限时的工具会被自动保护；其余工具完全不受影响。

### 何时选择

当模型会调用耗时很长的工具、这些工具会遵守 `exec.signal`，且你希望在取消完成后得到可预期的超时答复时，选择它。当工具必须在到达限时后被硬性停止时——插件只能请求工具停止，因此忽略取消的工具会继续运行并让调用方继续等待——以及当你希望为所有工具设置一个统一默认限时时（因为每个工具的限时来自该工具自身的配置），避免使用它。

### 设置

无需任何配置即可挂载插件：

```yaml
- name: '@deepseek-ai/dsh-tool-call-timeout-policy'
```

限时在配置工具的位置设置。例如，`dsh-tool-web` 的 `fetchTimeoutMs`／`searchTimeoutMs` 设置（默认 30,000 ms）把限时放到 `web_fetch` 与 `web_search` 上。没有限时的工具——随附的 `bash`、`read`、`write`、`edit`——绝不会被切断。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-web)列出会产生限时的工具设置。

### 你会得到什么

截止时间触发时，插件会中止派生的 `exec.signal`。下游代码遵守取消且 `next()` 完成后，模型会收到标记为错误的 `Error: tool call timed out after <ms>ms` 工具结果，从而决定重试、调整或放弃。忽略或缓慢处理该信号的工具会让调用方继续等待，并且在自身完成前不会产生超时结果；按时完成的调用保持不变。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释插件如何在每次分发周围设置截止时间并将其映射为 `TOOL_TIMEOUT` 结果，并指出实现它的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

包装层建立在四项承诺之上：

- **强制执行归属，而非库。** `dsh-timeout` 负责时序与分类（`deadline`、`timeoutOf`）；本插件负责 `tools/execute` 上的单次调用接线；各能力负责终止。该拆分记录在[超时截止时间库 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.zh.md) 中。
- **工具声明自己的预算。** `timeoutMs` 位于工具的 `ToolDefinition` 上，从注册表读取（`ctx.tools.get(exec.name, exec.agent)?.timeoutMs`），因此不可能拼错工具名，未声明工具原样委派。
- **作用域分类。** `TOOL_TIMEOUT` 同时用作内部 `deadline` 分类码与结构化错误 `code`；把 `timeoutOf` 限定到它，可避免嵌套的外层截止时间（先触发的另一包装层计时器）被误读为本插件的超时——它读作普通的上游取消。
- **先交换信号，再恢复。** Cordis `next()` 忽略传入参数，因此包装层原地修改共享 `exec`：分发时把派生的截止时间信号换到 `exec` 上，并在 `finally` 中恢复调用方信号，使 `tools/post-execute` 监听器永远看不到本插件可能已中止的信号。

### 截止时间如何设置与映射

一个 `tools/execute` 监听器从注册表读取已分发工具声明的限时（`ctx.tools.get(exec.name, exec.agent)?.timeoutMs`）；没有限时的工具原样委派。对有限时的工具，`deadline(exec.signal, timeoutMs, TOOL_TIMEOUT)` 构建融合信号，包装层在分发时把它换到 `exec` 上并在 `finally` 中恢复，使 `tools/post-execute` 监听器永远看不到派生信号。当包装层自己的计时器触发时——`timeoutOf(d.signal, 'TOOL_TIMEOUT')` 以代码限定作用域，因此嵌套的外层截止时间读作普通的上游取消——已被分发规范化为错误结果的分发结果会被替换为结构化结果：`isError: true`、内容 `Error: tool call timed out after <ms>ms`、错误信息 `{ name: 'ToolTimeoutError', code: 'TOOL_TIMEOUT' }`。

### 与其他包装层组合

多个 `tools/execute` 监听器按 Cordis 注册顺序组合，注册顺序决定语义：超时注册在外层时覆盖整个重试操作，注册在内层时覆盖每次尝试。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`TOOL_TIMEOUT`、`name`／`inject`／`apply`、`tools/execute` 包装层 |
| — | 不发布运行时不变式伴生入口；无状态包装层不拥有包级事件历史。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从工具调用流水线逐步进入超时库拆分、被执行的限时与 guard 组映射。

- [工具子系统参考](../../../docs/subsystems/tools.zh.md)——本包装层挂钩的 `tools/execute` waterfall 与决策形态。
- [超时截止时间库 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.zh.md)——时序／终止拆分以及截止时间为何只通知。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-web)——策略所执行的 `dsh-tool-web` 的 `fetchTimeoutMs`／`searchTimeoutMs` 预算。
- [guard 组映射](../README.zh.md)——同组的 guard 包与循环卫生家族。

-----

<a id="model-experience"></a>
## 模型体验

### 条件工具结果

#### 模型看到什么

此插件不添加提示词或 schema。如果已声明的截止时间先到且下游取消完成，它会用 `Error: tool call timed out after <ms>ms` 与结构化 `TOOL_TIMEOUT` 错误替换提供方结果；否则原结果保持不变。永不完成的下游调用无法产生超时结果。

#### Token 影响

未超时的调用不会增加 token。超时会添加一条会被保留的简短错误结果，并可防止体积更大、较晚返回的提供方结果进入上下文。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明策略何时不合适。它们是当前包约束，不是任务积压。

- **协作式，绝不是硬终止**——截止时间只通过 `exec.signal` 通知；忽略该信号的工具不会在超时时停止，包装层仍停留在 `await next()` 内，模型要等下游完成后才可能收到超时结果。
- **没有统一预算**——只有声明 `timeoutMs` 并将其放在 `ToolDefinition` 上的工具才会获得截止时间；未声明工具（随附的 `bash`、`read`、`write`、`edit` 有意不声明）没有注册表级默认值。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关 Agent Note 为准。

`src/index.ts` 中的 FIXME 要求确定 `@deepseek-ai/dsh-timeout-guard` 改名；[改名台账](../../../.agents/notes/archived/architecture/2026-08-11-repository-naming-contract-and-rename-ledger.md) 已把 `@deepseek-ai/dsh-tool-call-timeout-policy` 记录为既定名称，因此该 FIXME 已陈旧，待代码清理。

</details>
