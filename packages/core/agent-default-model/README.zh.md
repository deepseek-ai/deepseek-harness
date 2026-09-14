---
description: "面向用户与维护者的部署默认模型选择说明，用于选择、配置或调试新创建的 agent（智能体）初始使用哪个模型。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-default-model

[English](README.md) | 中文

## 概述

`dsh-agent-default-model` 在会话未指定模型时，为新创建的 agent 提供共享的默认提供方与模型。使用它可以为所有受支持的 agent 入口统一选择起始模型，其中包括 `dsh --profile headless`。设置可用时，用户可以覆盖已配置的选择（包括推理（reasoning）强度），保存的更改会在后续读取中生效。该默认值作用于整个进程；按会话选择模型仍由创建 agent 的入口负责。

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

在创建 agent 且未显式给出模型路由的任何地方挂载本包。该服务回答一个问题——新 agent 应该使用哪个模型？——因此创建 agent 的入口查询它，而不必重新实现默认值。

### 配置默认值

组合配置项是默认值的基础：它要求提供方与模型，并且不依赖任何设置提供方也能使用。

```yaml
- name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: deepseek
    model: deepseek-chat
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` | 必填 | 新 agent 使用的已注册提供方路由 |
| `model` | 必填 | 新 agent 使用的、由提供方持有的模型 id |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-agent-default-model)是所有受支持字段的完整参考。`reasoningEffort` 刻意不是配置字段：它属于设置层，因此完整保存的选择可以在下一个选定的模型没有推理强度时清除旧值，而组合配置值会再次被继承。

### 读取与更改默认值

`currentSelection()` 为新创建的 agent 返回一份独立的 `{ provider, model, reasoningEffort? }`；`saveSelection()` 为后续 agent 保存完整选择。

```text
const selection = ctx.agentDefaultModel.currentSelection()
await ctx.agentDefaultModel.saveSelection({ provider, model, reasoningEffort: 'high' })
```

未挂载设置提供方时，`saveSelection()` 不执行任何操作，组合配置项仍为当前值。该服务不校验目录成员关系：提供方路由可以服务未在目录中公布的模型；发起模型请求的消费方负责可用性诊断。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释该服务如何实现上述行为；可观察约定已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该服务是一个组合配置项，带有由设置支撑的数据源。插件配置提供基础 `{ provider, model }`；挂载设置提供方后，`agent-default-model` 设置分节成为实时数据源，所有消费方都通过 `currentSelection()` 读取，因此写入设置后无需在注册层面重建。`reasoningEffort` 只存在于设置 schema 中：配置不能携带它，因为新选择清除推理强度后，该值必须保持清除，而不能再次从组合配置中继承。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`AgentDefaultModelConfig` 服务、设置分节安装、`currentSelection`/`saveSelection` |
| — | 未发布运行时不变式配套项；唯一的可变值关系由设置校验负责。 |

### 行为说明

两个公开方法都只是对该数据源进行简单读写：`currentSelection()` 返回一个全新、独立的对象，因此调用方可以持有它，而不会与服务状态共享引用；`saveSelection()` 在存在 `ctx.settings` 时写入完整选择。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

包级约定对大多数消费方已经足够；需要周边领域时再阅读以下页面。

- [Core 子系统](../../../docs/subsystems/core.zh.md)——`Agent` 句柄与 `AgentOptions` 路由选择。
- [agent-loop 包](../agent-loop/README.zh.md)——agent 在请求时如何解析提供方与模型。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-agent-default-model)——每个受支持配置字段及其源声明。
- [core 分组地图](../README.zh.md)——core 各包如何组合。

-----

<a id="model-experience"></a>
## 模型体验

通过该服务提供给入口的 `ModelSelection` 间接影响；模型可见请求由请求组装与提供方适配器负责。

#### KV Cache 影响

更改默认值只影响之后从它解析选择的 agent。请求日志已经指明选择的现有会话仍沿用该选择，因此本服务不会使其已建立的前缀失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定该服务的范围。它们是当前包约束，不是任务积压。

- **单一的进程级默认值**——该服务只拥有一个默认值；按会话的模型选择仍由入口负责。
- **没有设置提供方时无法保留**——未挂载设置提供方时，`saveSelection()` 无法为后续 agent 保留选择。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
