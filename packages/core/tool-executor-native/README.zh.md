---
description: "具有作用域工具和有界批次执行的原生函数调用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-executor-native

[English](README.md) | 中文

## 概述

当模型应直接调用每个可见工具时，使用此执行器。在部署、预设或 Agent 作用域中，将它与工具注册表一同挂载。并行安全调用可以重叠，独占调用构成屏障，结果保留模型顺序。

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

将此行加入已经挂载 `dsh-tools` 的组合。最近作用域的执行器决定工具行为；同一作用域只允许一个执行器。

```yaml
- name: '@deepseek-ai/dsh-tool-executor-native'
```

Agent 步骤使用 [agent-loop 并发配置](../agent-loop/README.zh.md)，循环在每个批次开始时读取一次上限。本插件没有配置字段。直接构造 `NativeToolExecutor` 的调用方可以传入回调，默认返回 `10`；批次未指定 `maxParallelToolCalls` 时，每个工具组读取该回调。上限必须是正整数；`1` 表示串行执行。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

执行器接收完整的原始调用批次，负责解析、调度、取消和可选的模型步骤日志。它复用共享调用流水线来执行策略、工具和结果通知。中止后，它等待已开始的工作完成，并为跳过的调用返回有序错误结果。

- [`src/index.ts`](src/index.ts) — 作用域执行器注册；工具描述和批次执行。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工具注册表](../tools/README.zh.md)
- [Agent 循环](../agent-loop/README.zh.md)
- [其他执行器](../tool-executor-ptc/README.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

### 可见工具

#### 模型看到什么

每个可见工具的 `name`、`description` 和 JSON Schema 参数；不会增加提示词章节。

#### Token 影响

请求成本与可见定义成正比；隐藏定义会移除对应 schema 成本。

#### KV Cache 影响

只要工具描述和顺序不变，前缀就保持稳定。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下约束适用于已开始的调用。

- 同进程工具必须遵守取消信号；执行器无法强制终止忽略信号的工具。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
