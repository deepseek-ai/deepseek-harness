---
description: "面向工具作者与维护者的工具注册表与执行流水线说明，用于注册、限制、呈现或调试面向模型的工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tools

[English](README.md) | 中文

## 概述

使用 `dsh-tools` 可向模型公开类型化能力、校验调用、执行允许／拒绝／询问策略，并在普通工具失败时返回最终结果而不中止当前轮次。挂载原生或 PTC 根注册表，以选择模型直接调用工具还是通过程序调用工具。工具作者使用 `defineTool` 声明类型化参数与输出、协作式超时、并行安全属性和可选 UI 展示。模型会看到每个获准工具声明的名称、描述与参数 schema；按 agent 设置的限制可缩小该可见集合。

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

`ctx.tools.execute()` 针对 Agent 选中的根注册表的条目运行完整的原始调用批次；每条调用记录都携带其解析出的 `definition`。独立服务调用没有 `agent`；模型步骤之外的程序调用（包括初始化钩子）没有 `log`。没有 `log` 的 Agent 仍提供工具作用域，但不会产生根调用／结果事件。

在任何 agent 调用工具的地方挂载 `dsh-tools` 和一个根注册表：`ctx.tools` 把每个注册送达作用域选中的根注册表。注册一个工具就足以让它可见：根注册表会把它直接声明给模型，或在程序中绑定它。用工具的描述与参数描述向模型说明该工具。

<a id="register-a-tool"></a>
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

定义中的 `guidance` 是既有工具只在该工具可用时显示的系统提示词段：`ctx.tools.register()` 在注册工具的同一个 effect 中注册该段，并且只有当查看方作用域的注册项解析出该定义时才原样渲染它；在随附的 Native 与 PTC 根注册表下，这意味着该作用域可以直接或在程序中调用该工具，因此限制或更近的同名定义会隐藏该段。以同一 `section` 命名的多个工具共享一个段，该段的文本会带上该作用域解析出的工具名称；这些工具必须声明相同的使用指引，因为由最近的注册作用域中最新的注册决定它。新增使用指引不被鼓励（[理由](../../../.agents/notes/implemented/architecture/2026-11-19-composable-tool-registries.zh.md)）；使用指引可以提及另一个插件的工具，而无需检查该工具是否存在。

统一 schema DSL 支持 `string`、`number`、`integer`、`boolean`、`null`、`array`、`object`、仅供作者使用的 `json` 与恰好匹配一个分支的 `oneOf`；`InferValue` 在 16 层容器内保留精确类型，之后加宽为 `JsonValue`。原始 JSON Schema（`JsonSchemaNode`）是与 subagent、工作流和 MCP 共享的协议级对应类型。

<a id="compose-registries"></a>
### 组合注册表

`ctx.tools` 与每个根注册表都实现 `ToolRegistry`：`register(tool)`、`include(registry)`、`get(name, scope?)` 和 `getAll(scope?)`。`include()` 在每次查询时读取另一个注册表的条目，并返回该引入的 disposer；来源注册表仍拥有其定义。来源的 `getAll()` 可能在同一名称下列出多个定义，因此引入它的注册表通过 `get()` 解析每个名称，或把重复的名称视为冲突。`ctx.tools` 上的注册或引入会送达其作用域选中的根注册表，以及下级作用域选中的根注册表，包括稍后加载的根注册表：较近的注册与引入会遮蔽较远的注册与引入；一个作用域以同一名称提供两个不同定义时，以 `INVALID_TOOL_COMPOSITION` 失败。稍后出现的冲突（例如被引入的注册表为某个 Agent 添加第二个定义，或被引入的注册表读取 `ctx.tools`）会使触及该冲突的查找失败；在批次中只有受影响的调用会失败，其结果告诉模型该工具配置错误，部署日志记录失败的消息；失败是歧义时，该消息会点名相互冲突的定义。`ctx.tools.get()` 与 `getAll()` 按查看方作用域返回选中的根注册表的条目：原生根注册表下是每个可见工具，PTC 根注册表下只有 `run_code`。没有可用的根注册表时，它们与 `execute()` 一样抛出 `TOOL_REGISTRY_UNAVAILABLE`。

`ctx.tools.setRoot(registry)` 为发起调用的作用域安装根注册表，并把其各作用域看到的注册项交给它；不带作用域的调用安装部署默认值。Agent 使用最近的根注册表，每个作用域只允许一个。根注册表不得引入或读取 `ctx.tools`；这样的读取会以 `INVALID_TOOL_COMPOSITION` 失败：要么在 `setRoot()` 中失败，此时该作用域保留先前的选择；要么在之后触及该读取的查找或调用中失败。请通过 `ctx.tools` 注册工具：直接注册到根注册表的工具会跳过作用域的冲突检查，因此之后通过 `ctx.tools` 以同一名称注册另一个定义也会被接受，而下一次 `ctx.tools.getAll()` 会抛出异常。卸载后再次被选中的根注册表仍只保留对注册项的一次引入。选中或卸载根注册表都会发出 `tools/change`；抛出异常的观察者会使这次选择失败；选择失败时会恢复先前的选择，并再次发出 `tools/change`。卸载后的根注册表仍保持选中，但处于不可用状态，因此在安装替代根注册表之前，查找、新批次与提示词组装都会以 `TOOL_REGISTRY_UNAVAILABLE` 失败；已接纳的批次仍通过其根注册表结算。挂载一个根注册表插件：

```yaml
- name: '@deepseek-ai/dsh-tools'
- name: '@deepseek-ai/dsh-tool-registry-native'
```

[原生](../tool-registry-native/README.zh.md)根注册表直接提供每个可见工具；[PTC](../tool-registry-ptc/README.zh.md) 根注册表提供 `run_code`，并把这些工具声明为生成的 SDK。Agent 步骤的并发上限使用 [agent-loop 配置](../agent-loop/README.zh.md)。PTC 根注册表的提示词段遵循普通[段生命周期规则](../system-prompt/README.zh.md)：卸载该根注册表后，下一次组装会使这些段退役。

<a id="per-agent-tools"></a>
### 按 Agent 提供工具

在每个模型步骤之前，AgentLoop 把 `ctx.tools.getAll(agent)` 捕获为 `ToolStep`。该步骤的提示词声明这些条目，其批次调用与程序调用只执行这些确切的定义；模型响应期间注册或替换的工具从下一个步骤起生效，而对已声明、但其提供方已将其移除或为该 Agent 撤下的工具的调用以 `UNKNOWN_TOOL` 失败。模型直接调用根注册表只在程序中绑定的工具时，该调用会在 `tools/pre-execute`、审批、守卫和执行包装层之前以 `UNKNOWN_TOOL` 失败，其消息会列出该步骤可以调用的条目。调用任何地方都未注册的名称，或调用因限制或其提供方而未向该 Agent 提供的工具时，策略照常运行，调用随后在分发时失败。分发恰好运行准备该调用时捕获的定义。请求重试保留该步骤的工具。

工具依赖 Agent 状态的提供方会引入一个 `AgentToolRegistry`（与 `ToolStep`、`NativeToolRegistry` 一起从 `@deepseek-ai/dsh-tools/pipeline` 导出），把该工具注册在其中，并在状态变化时调用 `set(agent, names)`：Agent 创建或恢复时、插件加载时（针对已存在的 Agent）、状态本身变化时，以及空白会话的预设变化（`agent-preset/selected`）把活跃 Agent 移入该提供方所属预设时。步骤使用的是它开始之前已设置的工具。不限作用域的视图列出每个已注册工具，因此限制与 `toolOrder` 可以在 Agent 看到该工具之前指名它；不带 Agent 的调用会到达工具主体，工具主体在需要 Agent 时检查 `exec.agent`。Web 工具在该 Agent 的模型路由、某个凭据或 Web 提供方变化时调用 `set()`；Plan、Office 与 Team 在各自的状态变化时调用它。按 Agent 提供工具的提供方依据自己的注册表为每个 Agent 决定其使用指引，例如 `registry.get(name, agent)`。

### 按 agent 限制工具

`ctx.tools.restrict(filter)` 对单个 agent 继承的工具应用允许或拒绝掩码，包括祖先作用域从其他注册表引入的工具；掩码取交集，该作用域自身的注册与引入保持可见，限制在 dispose（资源释放）时解除。`allow` 中的名称必须是继承的工具名，而 `deny` 可以接受尚无任何来源提供的名称。根注册表把该掩码应用到其条目与程序绑定上，而被限制工具的 `guidance` 对该 agent 停止渲染。需要匹配实际执行的定义的策略读取 `exec.definition`。`projectToolSchema()` 返回定义面向模型的 schema，不含其回调。

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

注册表在作用域层中持有类型化 `ToolDefinition`，并在请求时把它们投影为面向模型的 `ToolSchema` 集合——`output`、`execute`、`finalizeContent`、`timeoutMs` 与呈现回调绝不会泄漏到协议上。内置注册表复用共享流水线：`tools/pre-execute`（可扩展的允许／拒绝／询问）→ 已注册单调守卫 → `tools/execute`（环绕分发包装层）→ `tools/post-execute`（检查／替换、附加上下文）→ 由定义持有的 `finalizeContent` → 仅观测的 `tools/result` 事件。只有 `tools/execute` 视图可以替换必填信号，注册表会在调用主体前重新融合调用方信号。

### 源码地图

- [`src/index.ts`](src/index.ts) — 插件入口与公共工具 API；送达选中的根注册表的作用域注册，以及批次执行。
- [`src/contracts.ts`](src/contracts.ts) — 工具定义、调用结果、守卫与策略决策.
- [`src/registry.ts`](src/registry.ts) — `ToolRegistry` 与批量输入输出。
- [`src/entries.ts`](src/entries.ts) — 不带作用域的注册与对注册表的实时引入。
- [`src/step.ts`](src/step.ts) — `ToolStep`，即一个模型步骤声明的条目。
- [`src/agent-tools.ts`](src/agent-tools.ts) — `AgentToolRegistry`，即按 Agent 添加的工具。
- [`src/native-registry.ts`](src/native-registry.ts) — `NativeToolRegistry`，其条目是可由模型调用的工具。
- [`src/pipeline.ts`](src/pipeline.ts) — 共享的 `prepare`、`dispatch`、`complete` 阶段、阶段结果类型与批次入口。
- [`src/batch.ts`](src/batch.ts) — 并发调度、结果顺序与可选 Session 日志.
- [`src/events.ts`](src/events.ts) — 共享执行策略事件.
- [`src/schema.ts`](src/schema.ts) — 类型化工具定义与面向模型的 schema 投影。
- [`src/json-schema.ts`](src/json-schema.ts) — 支持的 JSON Schema 校验.
- [`src/presentation.ts`](src/presentation.ts) — 工具卡片呈现意图.

### 执行与取消

每次类型化调用都会实体化并冻结解析后的参数、分配不透明关联 token，再运行策略与分发。pre-execute 拒绝可以在模型可见原因旁附带 `ToolErrorInfo`；原生与 PTC 持久投影会保留结构化名称、代码与可选用户可见原因，但不会把该详情加入模型内容。取消采用协作式并等待完全停稳：每个工具主体都收到调用方拥有的 `exec.signal` 且必须观测它；调用主体前的取消为 `ABORTED_BEFORE_DISPATCH`，调用主体后的取消只能把成功结果替换为 `ABORTED`，抛出的 signal reason，或不具备 `HarnessError` 身份、name 为 `AbortError` 的 `Error`，保留其 message 并携带 `ABORTED`。`tools/execute` 包装层在调用方取消后抛出这类值时按同样方式归类，工具主体尚未开始时为 `ABORTED_BEFORE_DISPATCH`。拒绝、其他包装层失败、工具失败、后置策略失败与超时产生的 `TOOL_TIMEOUT` 仍保留更具体的结果。未知工具与抛出异常的工具都会变成结构化错误（`UNKNOWN_TOOL`），因此调用会失败而不会结束轮次。

### PTC mode

[PTC 注册表](../tool-registry-ptc/README.zh.md)负责程序传输、SDK 生成、嵌套分发和图片上下文。

<a id="extension-points"></a>
### 扩展点

工具插件调用 `ctx.tools.register()`，其 schema 经由选中的根注册表流入提示词组装。`tools/pre-execute` 是可重排的允许／拒绝／询问门禁；`ctx.tools.guard()` 在其后添加单调的拥有方策略；`tools/execute` 为超时、重试或指标包装规范化后的规范分发；`tools/post-execute` 可以替换内容或值、通过反馈阻止，或附加有序上下文；`tools/result` 观测不可变的最终结果。MCP 服务器发现工具后，用服务器的 schema 调用 `ctx.tools.register()`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

包级约定对大多数消费方已经足够；需要周边领域时再阅读以下页面。

- [工具子系统](../../../docs/subsystems/tools.zh.md)——完整流水线类型、schema DSL 与生成的服务 API。
- [生成工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-registry-ptc)——模型收到的已交付工具 schema。
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

在普通模式下，模型会看到每个可见定义的确切名称、描述与 JSON Schema；已交付定义记录在生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-registry-ptc)中。agent 作用域的限制、遮蔽与扩展注册会改变该 agent 的最终工具集合。

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
- **部分工具提示词文本在该工具被限制时仍会保留**：只有定义中的 `guidance` 跟随工具的可用性。用 `systemPrompt.section()` 与工具分开注册的段（例如 bash 的段）在其插件加载期间一直保留。按 Agent 提供工具的提供方（Web、Plan、Office、Team）与 CUA 的段、委派深度上下文、subagent 身份上下文中的 `send_message` 与 `list_agents` 两行，以及 skill（技能）目录消息也是如此。

`defineTool()`、注册表模式投影和系统提示组装会保留 `deferLoading: true`。该标记请求延迟加载工具定义，并不意味着存在 `tool-addition` 记录；提供方执行语义的限制见 [LLM 包](../../../packages/llm/llm/README.zh.md#known-limitations-and-deferred-work)。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
