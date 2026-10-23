---
description: "面向工具作者与维护者的工具注册表与执行流水线说明，用于注册、限制、呈现或调试面向模型的工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tools

[English](README.md) | 中文

## 概述

使用 `dsh-tools` 可向模型公开类型化能力、校验调用、执行允许／拒绝／询问策略，并在普通工具失败时返回最终结果而不中止当前轮次。挂载原生或 PTC 执行器以选择模型交互和批次执行行为。工具作者使用 `defineTool` 声明类型化参数与输出、协作式超时、并行安全属性和可选 UI 展示。模型会看到每个获准工具声明的名称、描述与参数 schema；按 agent 设置的限制可缩小该可见集合。

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

`ctx.tools.execute()` 接受完整的原始调用批次。独立服务调用没有 `agent`；模型步骤之外的程序调用（包括初始化钩子）没有 `log`。没有 `log` 的 Agent 仍提供工具作用域，但不会产生根调用／结果事件。

在任何 agent 调用工具的地方挂载 `dsh-tools`：它提供 `ctx.tools`，即每个工具插件注册进去、循环分发所经过的注册表。注册一个工具就足以让它可见——注册表会自动把其 schema 送入系统提示词组装。

### 注册工具

`defineTool` 构建类型化工具定义：面向模型的名称、描述与参数 schema、规范输出声明，以及只返回所声明 JSON 值的 `execute` 主体。模型参数在执行前被校验；无效输入变成普通错误结果。

规范值属于执行过程；Session 记录渲染后的内容及可选展示元数据。替换或脱敏这些内容不会移除程序化调用方可读取的规范值；需要禁止该访问的策略必须阻止执行或替换该值。

```ts
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

declare const ctx: Context

ctx.tools.register(defineTool({
  name: 'read_file',
  description: 'Read a file from disk.',
  parameters: {
    path: { type: 'string', required: true, description: 'Absolute file path' },
    offset: { type: 'number' },
    limit: { type: 'number' },
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  async execute(args, exec) {
    // args is typed: { path: string; offset?: number; limit?: number }
    return readFile(args.path, { encoding: 'utf8', signal: exec.signal })
  },
}))
```

统一 schema DSL 支持 `string`、`number`、`integer`、`boolean`、`null`、`array`、`object`、仅供作者使用的 `json` 与恰好匹配一个分支的 `oneOf`；`InferValue` 在 16 层容器内保留精确类型，之后加宽为 `JsonValue`。原始 JSON Schema（`JsonSchemaNode`）是与 subagent、工作流和 MCP 共享的协议级对应类型。

<a id="conditional-tools"></a>
### 条件工具

`register(definition, { when })` 为每个模型步骤计算一次同步或异步条件。条件接收 `{ agent, modelSelection, signal }`；`modelSelection` 是步骤准备时为该步骤所有请求尝试捕获的提供方、模型与推理强度，与 `AssembleContext.modelSelection` 相同。返回 false 会从执行器的描述、PTC 绑定和执行集合中排除工具。条件抛错会以 `TOOL_ACTIVATION_FAILED` 中止步骤准备，不会被当成正常不可用。条件必须响应取消，不得改变注册或执行工具操作。

`resolve({ agent, modelSelection, signal })` 返回步骤拥有的 `ResolvedToolSet`。将它作为 `toolSet` 传给提示词组装以及该步骤的 `ctx.tools.execute()` 批次，批次结束后释放；同一步骤内的重试复用它。执行器把批次的集合应用到每次调用，包括 PTC 程序的子调用。注册仍由 effect 持有；每份集合只准入原 agent scope 中的原注册。注销、新的限制或同名替换会阻止尚未开始的调用继续使用它；取消之后，调用以共享 pipeline 的取消结果结束。已经开始的操作保留协作取消义务。批次没有已解析集合时，条件工具调用返回 `UNKNOWN_TOOL`。

`get(name, scope, toolSet)`、`definitions(scope, toolSet)` 和 `schemas(scope, toolSet)` 读取已准入集合；省略 `toolSet` 时只查看已注册定义，不计算条件。`executable(name, scope, toolSet)` 是执行时的查找：它应用集合，没有集合时排除条件注册。执行器的描述与分区通过 `AssembleContext.toolSet` 接收同一集合。展示变换不能增删可调用工具。

### 选择执行器

在部署、预设或 Agent 作用域中挂载一个执行器。最近的作用域决定提供者，同一作用域的重复提供者会报错。原生执行器直接公开可见能力；PTC 执行器公开 `run_code` 和生成的 SDK。执行器注册和卸载不触发 `tools/change`；提示词组装和批次执行在运行时解析当前执行器。

```yaml
- name: '@deepseek-ai/dsh-tools'
- name: '@deepseek-ai/dsh-tool-executor-native'
```

Agent 步骤的并发上限使用 [agent-loop 配置](../agent-loop/README.zh.md)。执行器设置参见[原生](../tool-executor-native/README.zh.md)或 [PTC](../tool-executor-ptc/README.zh.md) 包。自定义提供者只需实现 `describe(definitions)` 和 `execute(batch)`，共享流水线为可选项。注册表分别为提示词描述和每次 `ctx.tools.execute()` 批次选择当前作用域的执行器。已接纳批次仍由所选提供者结算，即使该提供者已卸载；根据提供者的卸载策略，结果可能包含取消错误。注册替代提供者之前，新批次会被拒绝。

### 按 agent 限制工具

`ctx.tools.restrict(filter)` 对单个 agent 继承的全局工具应用允许或拒绝掩码；掩码取交集，作用域注册保持可见，限制在 dispose（资源释放）时解除。`ctx.tools.get(name, scope)` 按一个作用域的视角解析工具。使用 Host 本地展示转换器的消费方如需匹配实际执行的定义，会传入发起调用的 agent。`ctx.tools.schemas(scope)` 返回可见 schema（不含 `execute` 函数）。

### 对调用实施策略

`ctx.tools.guard(guard)` 在可扩展的 `tools/pre-execute` waterfall（瀑布式事件）之后注册单调同步守卫：返回的理由会拒绝调用，后续监听器无法把该拒绝重新变为允许。流水线事件给插件更多控制——`tools/pre-execute` 决定允许／拒绝／询问，`tools/execute` 为超时或重试包装分发，`tools/post-execute` 检查或替换结果，`tools/result` 观测冻结的最终结果。

工具的 `projectContent` 在执行后策略之前安装执行期间准备的图文内容。策略仍可替换或阻止这些内容；`finalizeContent` 保留为策略之后的最终内容处理。

### Host 展示描述

工具可以为 Host 本地消费方保留纯函数 `presentCall()` 与 `presentResult()` 方法。内置 Web Client 不消费这些值，而是通过 `tool.call.toolview` 选择 renderer，并从原始调用参数、结果内容、失败状态与持久 metadata 派生 card props。[Client 派生展示决策](../../../.agents/notes/implemented/architecture/2026-08-23-client-derived-tool-presentation.zh.md)负责该 transport 拆分。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释该包如何实现上述行为；可观察约定已在[使用本包](#use-this-package)中完整说明。

### 设计理念

注册表在作用域层中持有类型化 `ToolDefinition`，并在请求时把它们投影为面向模型的 `ToolSchema` 集合——`output`、`execute`、`finalizeContent`、`timeoutMs` 与呈现回调绝不会泄漏到协议上。每次调用都运行一条固定流水线：`tools/pre-execute`（可扩展的允许／拒绝／询问）→ 已注册单调守卫 → `tools/execute`（环绕分发包装层）→ `tools/post-execute`（检查／替换、附加上下文）→ 由定义持有的 `finalizeContent` → 仅观测的 `tools/result` 事件。只有 `tools/execute` 视图可以替换必填信号，注册表会在调用主体前重新融合调用方信号。

### 源码地图

- [`src/index.ts`](src/index.ts) — 插件入口与公共工具 API；作用域工具服务与执行器选择.
- [`src/contracts.ts`](src/contracts.ts) — 工具定义、调用结果、守卫与策略决策.
- [`src/executor.ts`](src/executor.ts) — 执行器描述与批量输入输出.
- [`src/pipeline.ts`](src/pipeline.ts) — 共享的 `prepare`、`dispatch`、`complete` 阶段、阶段结果类型与批次入口。
- [`src/batch.ts`](src/batch.ts) — 并发调度、结果顺序与可选 Session 日志.
- [`src/events.ts`](src/events.ts) — 共享执行策略事件.
- [`src/schema.ts`](src/schema.ts) — 类型化工具定义与面向模型的 schema 投影。
- [`src/json-schema.ts`](src/json-schema.ts) — 支持的 JSON Schema 校验.
- [`src/presentation.ts`](src/presentation.ts) — 工具卡片呈现意图.

### 执行与取消

每次类型化调用都会实体化并冻结解析后的参数、分配不透明关联 token，再运行策略与分发。pre-execute 拒绝可以在模型可见原因旁附带 `ToolErrorInfo`；原生与 PTC 持久投影会保留结构化名称、代码与可选用户可见原因，但不会把该详情加入模型内容。取消采用协作式并等待完全停稳：每个工具主体都收到调用方拥有的 `exec.signal` 且必须观测它；调用主体前的取消为 `ABORTED_BEFORE_DISPATCH`，调用主体后的取消只能把成功结果替换为 `ABORTED`。拒绝、包装层失败、工具失败、后置策略失败与超时产生的 `TOOL_TIMEOUT` 仍保留更具体的结果。未知工具与抛出异常的工具都会变成结构化错误（`UNKNOWN_TOOL`），因此调用会失败而不会结束轮次。

### PTC mode

[PTC 执行器](../tool-executor-ptc/README.zh.md) 负责程序传输、SDK 生成、嵌套分发和图片上下文。

<a id="extension-points"></a>
### 扩展点

工具插件调用 `ctx.tools.register()`，其 schema 会自动流入提示词组装。`tools/pre-execute` 是可重排的允许／拒绝／询问门禁；`ctx.tools.guard()` 在其后添加单调的拥有方策略；`tools/execute` 为超时、重试或指标包装规范化后的规范分发；`tools/post-execute` 可以替换内容或值、通过反馈阻止，或附加有序上下文；`tools/result` 观测不可变的最终结果。MCP 服务器发现工具后，用服务器的 schema 调用 `ctx.tools.register()`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

包级约定对大多数消费方已经足够；需要周边领域时再阅读以下页面。

- [工具子系统](../../../docs/subsystems/tools.zh.md)——完整流水线类型、schema DSL 与生成的服务 API。
- [生成工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-executor-ptc)——模型收到的已交付工具 schema。
- [工具执行流水线](../../../docs/tool-execution-pipeline.zh.md)——可视化流水线。
- [添加工具实操手册](../../../docs/cookbook/adding-a-tool.zh.md)——分步骤的工具编写指南。
- [工具测试工具包](../../test-support/tool-testkit/README.zh.md)——测试和基准测试使用的工具定义与执行 fixture。
- [协作式取消 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-19-cooperative-tool-cancellation.zh.md)——完整取消约定。
- [core 分组地图](../README.zh.md)——core 各包如何组合。

-----

<a id="model-experience"></a>
## 模型体验

### 普通工具 schema

#### 模型看到什么

在普通模式下，模型会看到每个可见定义的确切名称、描述与 JSON Schema；已交付定义记录在生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-executor-ptc)中。agent 作用域的限制、遮蔽与扩展注册会改变该 agent 的最终工具集合。

#### Token 影响

每次请求的固定成本与可见定义成正比。隐藏工具的限制会为该 agent 移除其全部 schema 成本。

#### KV Cache 影响

只要可见定义及其顺序不变，前缀就保持稳定。注册、dispose 或作用域限制可能从第一个改变的 schema token 起使复用失效。

### 工具调用历史与结果

#### 模型看到什么

循环会保留模型发出的参数与注册表的最终内容。任何抛出异常或遭到拒绝的调用，都会转换为确切的 `Error: <message>`；结构化的用户可见失败详情不会加入该消息。PTC mode 只返回外层程序打印的行与呈现后的返回值；两者都为空时返回 `(run_code completed with no output)`；失败时返回 `Error: code run failed (<kind>): <message>`，并根据是否存在已捕获内容，在其后附加 `Captured output:` 与捕获的行。内部分发事件只保留在日志中；成功且含图片的子结果会在外层结果之后作为带来源归属的上下文追加。

#### Token 影响

参数、结果与附加上下文取决于数据，并会重复发送直至压缩（compaction）。隐藏工具的限制还会在模型可以调用这些工具之前移除其 schema。

#### KV Cache 影响

仅追加；新的可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明注册表何时需要特别留意。它们是当前包约束，不是任务积压。

- **并发策略不是事件门禁**：`executionMode()` 直接读取已解析的工具定义；插件只能在自身拥有的定义上声明分类器。
- **`tools/pre-execute` 有意不允许改写 `exec.arguments`**：否则日志记录与呈现的参数会与实际运行内容失去同步；改写设计记录在[拟议的 Agent Note](../../../.agents/notes/proposed/feature/2026-06-30-pre-tool-input-rewrite.zh.md)中。
- **调用方定义的 subagent 与工作流结构化输出仍要求对象根**：这是消费方层面的守卫；共享 schema 词汇与工具输出支持任意 JSON 根。
- **定义中的 `timeoutMs` 仅作声明之用**：注册表绝不会强制执行截止时间；要强制执行，必须使用 `@deepseek-ai/dsh-tool-call-timeout-policy` 包装层。

`defineTool()`、注册表模式投影和系统提示组装会保留 `deferLoading: true`。该标记请求延迟加载工具定义，并不意味着存在 `tool-addition` 记录；提供方执行语义的限制见 [LLM 包](../../../packages/llm/llm/README.zh.md#known-limitations-and-deferred-work)。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
