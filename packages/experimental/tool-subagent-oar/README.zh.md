---
description: "提供一个外部子智能体工具，为每个任务选择已配置的运行时。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-subagent-oar

[English](README.md) | 中文

## 概述

使用一个 `subagent_oar` 工具，为每个独立文本任务选择已配置的外部智能体。配置固定可用的运行时别名及其提供方；模型选择别名，不能更改原生参数或权限。每个任务使用独立上下文并返回子任务 id 和完整名称，完成通知稍后送达父智能体。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待完善事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将此工具与 `@deepseek-ai/dsh-subagent-names` 一起挂载在已配置的外部提供方旁，例如 [OAR 提供方实例](../subagent-oar/README.zh.md)。在组合中将命名、工具和提供方包声明为依赖。

### 适用场景

当一个模型可见入口需要在独立的单次提供方之间选择时，使用此工具。它拒绝继承父对话或支持继续执行的提供方。需要可继续的子智能体或更多子任务配置时，请使用[共享子智能体工具](../../subagent/tool-subagent/README.zh.md)。

### 最小配置

在共享 subagent 服务可用，且 `oar-codex` 和 `oar-claude` 已注册后，在此工具旁挂载一次命名服务：

```yaml
- name: '@deepseek-ai/dsh-subagent-names'
- name: '@deepseek-ai/dsh-experimental-tool-subagent-oar'
  config:
    providers:
      codex: oar-codex
      claude: oar-claude
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `providers` | 必填 | 从模型可见运行时别名映射到已注册提供方名称的非空映射 |
| `toolName` | `subagent_oar` | 工具名称；每个挂载实例需要不同名称 |

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-tool-subagent-oar)定义接受的字段和校验规则。调用要求提供 `runtime`、`description` 和 `prompt`；可选的 `name` 按[命名服务规则](../../subagent/subagent-names/README.zh.md)选择同级路径段；可选的 `cwd` 选择子任务目录，相对路径从父智能体的当前目录解析。提示必须包含子任务需要的上下文。原生安装、认证、模型设置和权限由所选提供方负责。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

[`src/index.ts`](src/index.ts)注册配置的运行时选项，并直接调用 `ctx.subagents.startActivation()`。命名服务预留同级名称，并将已接受的子任务 id 映射到完整名称；子任务的提示就是提交的任务。subagent 服务负责容量、父智能体生命周期、取消、最终记录和完成通知交付。工具调用卡片使用任务描述和提交的参数。释放插件会移除其工具注册；激活管理器继续负责已接受的子任务。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [子智能体服务](../../subagent/subagent/README.zh.md) — 提供方注册和激活所有权。
- [Subagent 命名](../../subagent/subagent-names/README.zh.md) — 同级名称和完整名称查询。
- [OAR 提供方](../subagent-oar/README.zh.md) — 原生运行时配置和权限配置。
- [子智能体子系统](../../../docs/subsystems/subagent.zh.md) — 父智能体完成通知和保留结果。

-----

<a id="model-experience"></a>
## 模型体验

### 外部委派工具

#### 模型看到什么

[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-tool-subagent-oar)定义描述和参数 schema。`runtime` 枚举包含配置的别名。接受任务后，结果包含 `kind: "activation"`、`subagentId` 和 `name`。模型看到 `started subagent <ID>`，下一行是 `name: <full name>`。共享子智能体服务稍后提供子任务的答复或失败通知，以相同的子任务 id 标识外部执行。

#### Token 影响

每个挂载实例添加一个工具 schema。确认和完成通知追加到父上下文；提供方负责子任务的独立上下文和 token 使用。

#### KV Cache 影响

修改配置的别名、工具名称或注册会改变后续请求中的工具 schema。确认和完成通知追加在可复用的父请求前缀之后。

## 已知限制与待完善事项

<a id="known-limitations-and-deferred-work"></a>

工具的选项和执行能力由已配置的提供方固定。

- **仅支持单次提供方：** 子任务上下文独立，工具不提供后续输入、恢复、结构化输出或按调用覆盖原生权限的功能。
- **提供方可用性：** 选择的提供方不存在或已卸载时，调用会失败；其配置的别名会保留在 schema 中，直到此工具的配置改变。
- **名称绑定失败：** 如果已接受的子任务名称无法记录，错误会报告其 id，执行仍由 subagent 服务管理。重试前应检查该子任务的结果；预留的名称会被释放。
- **提供方负责的工作：** 运行时配置、启动取消、进程清理和答复选择遵循所选提供方的文档行为。移除此工具不会撤销已接受的激活。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
