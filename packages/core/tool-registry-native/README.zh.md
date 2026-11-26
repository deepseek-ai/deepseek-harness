---
description: "具有作用域工具和有界批次执行的原生函数调用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-registry-native

[English](README.md) | 中文

## 概述

当模型应直接调用每个可见工具时，使用此根注册表。在部署、预设或 Agent 作用域中，将它与工具注册表一同挂载。并行安全调用可以重叠，独占调用构成屏障，结果保留模型顺序。

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

将此行加入已经挂载 `dsh-tools` 的组合。插件在挂载作用域中安装一个原生根注册表：`ctx.tools.setRoot()` 把该作用域中 Agent 看到的注册项交给该根注册表，根注册表再把其中每一项作为可直接调用的条目提供。Agent 使用最近的根注册表，每个作用域只允许一个；根注册表的选择与不可用的根注册表由 [tools 包](../tools/README.zh.md#compose-registries)负责。

```yaml
- name: '@deepseek-ai/dsh-tool-registry-native'
```

Agent 步骤使用 [agent-loop 并发配置](../agent-loop/README.zh.md)，循环在每个批次开始时读取一次上限；对于未设上限的批次，`ctx.tools.execute()` 按 `DEFAULT_MAX_PARALLEL_TOOL_CALLS`（10）运行。上限必须是正整数；`1` 表示串行执行。本插件没有配置字段。自行安装原生根注册表的插件构造 `NativeToolRegistry`（其唯一参数是用于诊断信息的标签），再把它传给 `ctx.tools.setRoot()`，由后者把注册项交给它。根注册表不得引入 `ctx.tools`：这一引入会回读该根注册表自身，因此 `setRoot()` 以 `INVALID_TOOL_COMPOSITION` 拒绝这样的根注册表。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

注册表的条目是它自身的注册加上它所引入注册表的条目，每次查询时读取；作为根注册表，它引入 `setRoot()` 交给它的注册项，因此始终提供该作用域当前的工具。`ctx.tools.execute()` 接收原始调用批次，通过选中的根注册表解析每个调用，并负责参数解析、调度、取消和可选的模型步骤日志。携带 `ToolStep` 的调用只运行该步骤声明的定义，因此同名替换在下一个步骤之前都以 `UNKNOWN_TOOL` 失败。`ctx.tools.execute()` 复用共享调用流水线来执行策略、工具和结果通知。中止后，它等待已开始的工作完成，并为跳过的调用返回有序错误结果。插件卸载后，该作用域的根注册表选择保持不可用，已接纳的批次仍会结算其调用。

- [`src/index.ts`](src/index.ts) — 根注册表插件；`NativeToolRegistry` 定义在 [`dsh-tools/pipeline`](../tools/src/native-registry.ts) 中。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工具注册表](../tools/README.zh.md)
- [Agent 循环](../agent-loop/README.zh.md)
- [PTC 工具注册表](../tool-registry-ptc/README.zh.md)
- [可组合工具注册表决策](../../../.agents/notes/implemented/architecture/2026-11-19-composable-tool-registries.zh.md)

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

- 同进程工具必须遵守取消信号；注册表无法强制终止忽略信号的工具。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
