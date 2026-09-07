---
description: "可选的按步骤时钟上下文，包含当前时间、浏览器时区与经过时长，供启用或调优本插件的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-time-context

[English](README.md) | 中文

## 概述

`dsh-time-context` 给模型一只时钟：在符合条件的步骤上，它追加一条持久、带来源的读数，包含当前时间、附加到当前开放请求的浏览器时区，以及自前一条模型可见消息以来的经过时长。它帮助模型按用户的浏览器时区解释未明确限定时区的日期与时间；时区来源混杂或缺失时，它告诉模型去询问。本插件需主动启用：默认组合不启用它，Schedule Web overlay 会挂载它。正的 `refreshIntervalMs` 会减少读数累积的频率；省略或设为 `0` 时，每个符合条件的步骤都会注入。

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

当模型需要按用户所在时区解释未限定的日期与时间，且请求本地浏览器时区可用或已配置的回退值可接受时，挂载此插件。每次注入都是持久历史中额外的一条 user 角色消息；当按步骤读数超出对话需要时，用 `refreshIntervalMs` 调度。

### 模型能得到什么

每条注入读数包含三行：带数字偏移与 IANA 时区、形如 ISO 的时间戳，该请求的浏览器时区策略，以及以紧凑整秒单位表示的经过时长。第 1 步从最新一条先前模型可见消息起测量；后续步骤从同一轮次中前一个 time-context 事件起测量。缺少基线时报告 `unavailable`，挂钟时间倒退时把经过时长钳制为零。

### 配置

最小挂载无需任何配置。正的 `refreshIntervalMs` 会抑制距最近一次注入不足该毫秒数的注入；省略或设为 `0` 时，每个信号尚未中止且将进入步骤的合格 pre-step 都会注入。

```yaml
- name: '@deepseek-ai/dsh-time-context'
  config:
    timeZone: Asia/Shanghai
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `timeZone` | 进程时区 | 当前开放轮次没有唯一浏览器时区时的显示回退时区 |
| `refreshIntervalMs` | `0`（每个合格步骤） | 同一会话中两次持久注入之间的最小毫秒数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-time-context)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 选择时区

当当前开放轮次只包含一个经 Host 校验的浏览器时区时，时间戳按该请求本地时区格式化。浏览器来源信息缺失或混杂时，配置的 `timeZone` 格式化显示；省略它则在插件加载时解析一次 Node 进程时区，每个显式回退值都经 `Intl.DateTimeFormat` 校验。解析后的指令告诉模型按所选时区解释未限定的日期与时间；来源信息混杂或不可用时，则要求用户澄清。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释插件的设计；可观察行为见[使用本包](#use-this-package)。

### 设计理念

插件前置注册一个 `agent/pre-step` 监听器，先委托下游，需要注入且下游决策进入步骤时追加一条带来源的 `UserMessage`。每个读数都使用确切的快照来源 `{ kind: 'plugin', plugin: 'time-context', form: 'snapshot', sections: [{ name: 'time-context', text }] }`，不变式伴生插件会校验该形状，根据原始 `user-rpc` 消息重新派生当前轮次的浏览器策略，并检查时间戳时区与经过时长基线。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：pre-step 监听器、到期调度、读数组合 |
| [`src/request-zone.ts`](src/request-zone.ts) | 从开放轮次 `user-rpc` 来源派生浏览器时区策略 |
| [`src/timestamp.ts`](src/timestamp.ts) | `Intl.DateTimeFormat` 创建与时间戳格式化 |
| [`src/invariant.ts`](src/invariant.ts) | 快照约定的不变式伴生插件 |

### 主要流程

需要注入时，插件采样挂钟时间，从开放轮次的 `user-rpc` 消息派生浏览器时区策略，解析显示时区（请求本地或回退），并渲染三行读数。正数间隔调度会扫描原始持久会话事件，查找最新一条归因于插件的消息——包括被压缩（compaction）遮蔽的读数——因此调度无需进程本地缓存也能在恢复后存续。读数记录的是已进入的步骤，不是已完成或已传输的请求；后续准备失败时，该读数可能留在历史中。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

包级约定不够用时阅读以下页面。它们从设计决策进入挂载本插件的组合与穷尽式配置。

- [Schedule 用户指南](../../../docs/user/guide/schedule.zh.md)——挂载本插件的官方配置路径。
- [context 组地图](../README.zh.md)——相邻的请求上下文包。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-time-context)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 准备期时间上下文

#### 模型看到的内容

每条注入消息包含三行。`<timestamp>` 是带数字偏移和 IANA 时区、形如 ISO 的时间戳；持续时间使用紧凑的整秒单位。

##### 第一步

```markdown
Time sampled while preparing turn <turn>, step 1: <timestamp>
Browser time zone for this request: <iana-zone-or-mixed-or-unavailable-policy>.
Elapsed since the preceding model-visible message: <duration-or-unavailable>.
```

##### 后续步骤

```markdown
Time sampled while preparing turn <turn>, step <step>: <timestamp>
Browser time zone for this request: <iana-zone-or-mixed-or-unavailable-policy>.
Elapsed since the preceding step context: <duration-or-unavailable>.
```

#### Token 影响

每个读数都会累积，直到压缩将其遮蔽。正数间隔会减少新增读数；省略或设为 `0` 时，每次合格的准备尝试都会添加一条。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明时钟上下文何时不合适。它们是当前包约束。

- **仅限提示词来源信息**：浏览器时区上下文用于指导自然语言解释，但不会悄然填入另一工具所要求的时区字段。
- **混合轮次会询问**：如果同一个开放轮次包含来自不同浏览器时区的提示词，模型会收到要求澄清的指令，而不会猜测哪个时区拥有未限定的时间。
- **回退值不代表用户权威**：浏览器来源信息缺失或混杂时，配置或进程时区用于格式化时钟，但面向模型的策略仍要求澄清。
- **整秒显示**：时间戳与持续时间省略亚秒精度，尽管持久事件时间保留毫秒。
- **压缩之间的历史成本**：省略或设为 `0` 时，每次合格尝试都会保留一条读数；正数间隔可以降低但无法消除该成本，也可能使后续请求缺少新鲜的浏览器时区指导。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
