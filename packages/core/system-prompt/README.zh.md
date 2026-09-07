---
description: "面向用户与维护者的系统提示词组装说明，用于添加提示词段、变量、工具 schema 来源或配置面向模型的提示词。"
kind: "package-reference"
---

# @deepseek-ai/dsh-system-prompt

[English](README.md) | 中文

## 概述

`dsh-system-prompt` 组装模型在每个步骤之前收到的系统提示词与工具 schema。插件贡献有序提示词段、动态 runtime 上下文、工具 schema 提供方与具名变量；循环每个步骤调用一次 `assemble()`，并把结果渲染为完整模型提示词。该包提供固定 harness 身份、全局部署 persona 前缀与后缀，而 agent 作用域的贡献会为单个 agent 遮蔽全局默认值。配置控制 harness 身份开场白、动态 runtime 上下文、部署 persona 前缀与后缀，以及显式的面向模型工具顺序。需要添加提示词段、提示词变量或工具 schema 来源时请选择本包——它是所有面向模型文案流经的组装点。

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

在任何运行 agent 的地方挂载 `dsh-system-prompt`：它提供 `ctx.systemPrompt`，即每个提示词贡献所落入的注册表。贡献带作用域——通过 `agent.ctx` 注册只影响该 agent，并遮蔽同名全局项。

<a id="configure-the-prompt"></a>
### 配置提示词

配置拥有固定开场白、runtime 上下文、部署 persona 前缀与后缀与工具顺序；其余一切来自已注册的贡献。

```yaml
- name: '@deepseek-ai/dsh-system-prompt'
  config:
    includeHarnessIdentity: true
    includeRuntimeContext: true
    personaPrefix: 'You are the deployment assistant.'
    toolOrder: ['<unlisted-tools>']
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `includeHarnessIdentity` | `true` | 是否包含顺序为 −1000 的 first-party 固定开场白 `You are an AI agent powered by DeepSeek Harness.`。仅当兼容性部署拥有完整系统提示词时设为 false。 |
| `includeRuntimeContext` | `true` | 是否在组装中包含有序动态 runtime 上下文 |
| `personaPrefix` | `''` | 全局 persona 前缀模板，位于第一方指导之前的顺序 `0` |
| `personaSuffix` | `''` | 全局 `deployment:persona-suffix` 模板，位于第一方指导之后的顺序 `10200` |
| `toolOrder` | — | 显式面向模型工具顺序，含一个 `'<unlisted-tools>'` 其余项标记 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-system-prompt)是每个受支持字段的穷尽式真源。没有恰好一个其余项或存在重复项的 `toolOrder` 列表会在加载时失败；已列名称没有对应已注册工具会使每次 `assemble()` 被拒绝。

### 贡献提示词段

段携带静态或按上下文解析的文本与 `order`；它们先按 order 升序拼接，同号时再按名称的代码单元顺序排列。仓库自带贡献方通过 `ctx.systemPrompt.getSectionOrder(name)` 解析集中分配的位置；runtime-context 贡献方使用 `getContextOrder(name)`。外部贡献可以使用任意有限 order。`complete: true` 段会在组装后成为精确的完整提示词；有效的 complete 段超过一个时，组装会失败。

```text
ctx.systemPrompt.section({
  name: 'tool:bash',
  order: 100,
  text: 'Prefer bash for file and process operations.',
})
```

### 贡献提示词变量

变量在段文本中以 `{{name}}` 引用，并在每次组装时解析；带作用域变量会为该 agent 遮蔽同名全局变量。循环提供 `model` 与 `cwd`；任何插件都可以注册自己拥有的事实。

```text
ctx.systemPrompt.variable('cwd', ({ agent }) => agent?.session.header.cwd)
```

### 贡献工具 schema

工具 schema 提供方在每次组装时求值，并贡献模型可见的 `ToolSchema` 集合；`ToolRuntime` 会自动注册自身，因此大多数工具在此无需手动接线。提供方返回限制后的可见集合，外加 `toolOrder` 使用的限制前名称全集。

### 抑制 runtime 上下文

`suppressRuntimeContext()` 移除调用作用域的所有动态 runtime 上下文贡献，但不禁用拥有底层事实的服务；多个抑制器独立组合，当不再存在抑制器时该 effect 会恢复上下文。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释该包如何实现上述行为；可观察约定已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该包是一个注册表加一条协作式组装流水线。一次 `assemble()` 调用把全局层与所请求作用域的层合并，分离工具参数，先按数值再按名称规范化段顺序，运行按作用域筛选的 `system-prompt/assemble` waterfall（瀑布式事件），把有效的 complete 段恢复为唯一的提示词段，并实施任何活动的 runtime-context 抑制器。段与动态上下文是独立的输入：段成为提示词文本，而上下文在循环下成为模型历史中带来源的 user 角色快照。工具 schema 按设计属于组装结果——「模型获知自己能做什么」是一个连贯整体，尽管适配器把 schema 作为独立 wire 字段传输。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`SystemPrompt` 服务、配置、组装流水线、`renderPrompt` |
| [`src/invariant.ts`](src/invariant.ts) | 不变式配套 |

### 组装与渲染

组装分两阶段完成求值与渲染：`assemble()` 返回文本已求值但尚未插值的段、有序工具 schema，以及每个已注册变量按当前上下文求得的值；`renderPrompt()` 插值 `{{variable}}` 引用、删除空段并用空行连接——严格规则：未知引用、已注册但无值的引用或格式错误的完整组都会抛出，因为格式错误的提示词比明确失败更糟。`toolOrder` 在 waterfall（瀑布式事件）之前规范化收集到的工具（注册顺序只是插件加载产物）；修改列表的 waterfall 监听器对其输出的确定性负责。

### 作用域

带作用域的段、变量与工具提供方会为单个 agent 遮蔽全局项，组装 waterfall 按作用域筛选分发。注册表变更通知（`system-prompt/change`）刻意不经过筛选，因为全局变更影响每个作用域。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

包级约定对大多数消费方已经足够；需要周边领域时再阅读以下页面。

- [系统提示词子系统](../../../docs/subsystems/system-prompt.zh.md)——确切的跨包类型与生成的服务 API。
- [tools 包](../tools/README.zh.md)——其 schema 流入组装的工具注册表。
- [提示词变量 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-05-prompt-variables-and-tool-guidance-ownership.zh.md)——哪些提示词事实归谁所有。
- [第一方提示词顺序 Agent Note](../../../.agents/notes/archived/architecture/2026-08-25-sparse-first-party-prompt-section-orders.md)——稀疏具名顺序分配。
- [core 分组地图](../README.zh.md)——core 各包如何组合。

-----

<a id="model-experience"></a>
## 模型体验

### 系统提示词

#### 模型看到什么

第一方段落依次渲染 harness 身份、部署 persona 前缀（含模型名称介绍）、可复用指令（包括生成的工具 SDK 和结构化输出指导），最后是携带环境信息的后缀：harness 源码（`10000`）、Web 表层（`10100`）和部署 persona 后缀（`10200`）。外部段落的顺序与组装监听器仍决定其最终结果。`includeHarnessIdentity: false` 仅省略这个固定开场白。空段会消失；带作用域的段与变量可以为一个 agent 遮蔽全局项。`system-prompt/assemble` waterfall 决定交付的提示词与工具 schema，除非一个有效段声明自身为 complete——此时该确切段会成为完整的系统提示词，而 waterfall 得到的上下文、工具与变量保持不变。有序动态上下文与段分离，只在存在时才会成为带来源的 user 角色快照；`includeRuntimeContext: false` 或带作用域的抑制器会移除全部这类上下文。

##### harness 身份

```markdown
You are an AI agent powered by DeepSeek Harness.
```

#### Token 影响

启用时，身份是每次请求的固定成本。Persona 前缀、后缀与插件文本在每次请求中重复，成本随渲染内容增长。

#### KV Cache 影响

模型、persona 前缀、工具与前置指令一致时，不同源码路径、本地 Web URL 或 persona 后缀值不会改变可复用的第一方前缀。Persona 前缀变化可能改变靠前的前缀。任何变更都可能从第一个变化的 token 起使复用失效；不保证提供方共享缓存或实际命中率。

### 工具 schema

#### 模型看到什么

对于已交付工具，模型会收到[生成工具 schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tools)中对每个 agent 可见的子集；限制与组装拦截完成后，按配置或字典序排列。扩展可以通过同一注册表贡献其他定义。段与 schema 提供方是独立的组装输入，因此工具限制不会移除独立注册的引导。

#### Token 影响

schema token 在每次请求中重复。限制工具会为该 agent 移除其全部 schema 成本，但不会移除独立提示词段；重排序会改变缓存形状，但不改变语义内容。

#### KV Cache 影响

只要可见 schema 集合、渲染与顺序不变，前缀就保持稳定。注册、限制或重排序可能从第一个变化的 schema token 起使复用失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明提示词组装何时需要特别留意。它们是当前包约束，不是任务积压。

- **部署方编写的提示词文本只来自配置／组合**：此插件拥有全局 persona 前缀与后缀默认值；创建方插件可以注册 agent 作用域的遮蔽项；其他段来自拥有相应事实的插件。不存在终端用户提示词编辑 API。
- **没有表示字面量 `{{…}}` 花括号的转义语法**：每个完整组都会按已注册变量插值；只有实际提示词需要转义时才会实现。
- **`toolOrder` 配置错误在提示词组装（首轮）时出现，而不是启动时**：只有形状违规会在配置加载时抛出。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
