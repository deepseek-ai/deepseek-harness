---
description: "面向工具作者与维护者的工具注册表与执行流水线说明，用于注册、限制、呈现或调试面向模型的工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tools

[English](README.md) | 中文

## 概述

使用 `dsh-tools` 可向模型公开类型化能力、校验调用、执行允许／拒绝／询问策略，并在普通工具失败时返回最终结果而不中止当前轮次。通过 `mode` 选择原生 Function Calling（函数调用）、[PTC mode](#ptc-mode) 或两者；单个 agent（智能体）可用 `presentAs` 覆盖默认值。工具作者使用 `defineTool` 声明类型化参数与输出、协作式超时、并行安全属性和可选 UI 展示。模型会看到每个获准工具声明的名称、描述与参数 schema；按 agent 设置的限制可缩小该可见集合。

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

在任何 agent 调用工具的地方挂载 `dsh-tools`：它提供 `ctx.tools`，即每个工具插件注册进去、循环分发所经过的注册表。注册一个工具就足以让它可见——注册表会自动把其 schema 送入系统提示词组装。

### 注册工具

`defineTool` 构建类型化工具定义：面向模型的名称、描述与参数 schema、规范输出声明，以及只返回所声明 JSON 值的 `execute` 主体。模型参数在执行前被校验；无效输入变成普通错误结果。

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

### 配置呈现模式

`mode` 配置决定模型看到什么：`native`（每个可见 schema）、`ptc`（只有 `run_code` 加一份生成 SDK）或 `both`。

```yaml
- name: '@deepseek-ai/dsh-tools'
  config:
    mode: native
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mode` | `native` | 可见工具向模型呈现的方式：`native`、`ptc` 或 `both` |
| `maxParallelSubCalls` | `10` | `run_code` 程序重叠子调用的并发上限；`1` 恢复严格串行分发 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tools)是每个受支持字段的穷尽式真源。非原生模式要求已组合的 `ctx.ptcRuntime` 且其语言有已注册的 SDK 渲染器；agent preset 通过 [`dsh-agent-tool-presentation`](../agent-tool-presentation/README.zh.md) 自行选择呈现方式，单个 agent 可用 `presentAs(mode)` 遮蔽默认值。

### 按 agent 限制工具

`ctx.tools.restrict(filter)` 对单个 agent 继承的全局工具应用允许或拒绝掩码；掩码取交集，作用域注册保持可见，限制在 dispose（资源释放）时解除。`ctx.tools.get(name, scope)` 按一个作用域的视角解析工具。使用 Host 本地展示转换器的消费方如需匹配实际执行的定义，会传入发起调用的 agent。`ctx.tools.schemas(scope)` 返回可见 schema（不含 `execute` 函数）。

### 对调用实施策略

`ctx.tools.guard(guard)` 在可扩展的 `tools/pre-execute` waterfall（瀑布式事件）之后注册单调同步守卫：返回的理由会拒绝调用，后续监听器无法把该拒绝重新变为允许。流水线事件给插件更多控制——`tools/pre-execute` 决定允许／拒绝／询问，`tools/execute` 为超时或重试包装分发，`tools/post-execute` 检查或替换结果，`tools/result` 观测冻结的最终结果。

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

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`ToolRuntime` 服务、配置、注册表、执行流水线 |
| [`src/types.ts`](src/types.ts) | `ToolDefinition`、`ToolExecution`、`ToolExecutionResult`、守卫与决策类型 |
| [`src/schema.ts`](src/schema.ts) | `defineTool` DSL：`ValueSchemaSpec`、`ParameterSchemaSpec`、`InferValue`、`InferArgs` |
| [`src/json-schema.ts`](src/json-schema.ts) | 强制执行的原始 JSON Schema 子集与校验 |
| [`src/presentation.ts`](src/presentation.ts) | 带 `card` 标签的 UI 呈现意图 |
| [`src/ptc.ts`](src/ptc.ts) | PTC mode：SDK 生成、`run_code` 分发桥接层、结算 |
| [`src/ts-types.ts`](src/ts-types.ts) | TypeScript SDK 类型渲染 |
| [`src/py-types.ts`](src/py-types.ts) | Python SDK 类型渲染 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式配套 |

### 执行与取消

每次类型化调用都会实体化并冻结解析后的参数、分配不透明关联 token，再运行策略与分发。pre-execute 拒绝可以在模型可见原因旁附带 `ToolErrorInfo`；原生与 PTC 持久投影会保留结构化名称、代码与可选用户可见原因，但不会把该详情加入模型内容。取消采用协作式并等待完全停稳：每个工具主体都收到调用方拥有的 `exec.signal` 且必须观测它；调用主体前的取消为 `ABORTED_BEFORE_DISPATCH`，调用主体后的取消只能把成功结果替换为 `ABORTED`。拒绝、包装层失败、工具失败、后置策略失败与超时产生的 `TOOL_TIMEOUT` 仍保留更具体的结果。未知工具与抛出异常的工具都会变成结构化错误（`UNKNOWN_TOOL`），因此调用会失败而不会结束轮次。

### PTC mode

在 `ptc` 或 `both` 下，注册表公开保留的 `run_code` 传输以及按所加载运行时语言生成的确定性 SDK。每个 SDK 绑定捕获冻结的 ToolSchema，经由调度器传入该次执行上下文。已开始的调用在策略之前只记录配对 id、名称和规范化参数；其结算事件保留渲染结果与可选结构化错误。描述与参数 schema 仅临时存活，不进入 Session 事件或 SDK 输出。调用通过复用原生并发约定的每次运行独有池调度。在纯 `ptc` 下，模型直呼其他任何可见工具都会在策略之前解析为 `UNKNOWN_TOOL`——通告面与可调用面保持一致。中间绑定值只存在于执行局部；只有外层 `run_code` 结果有硬大小上限。[执行器塌缩 note](../../../.agents/notes/implemented/bug-fix/2026-08-07-ptc-executor-collapse.zh.md) 拥有该收束约定。

新子调用使用 `<parent>:ptc:<n>` 标识。消费方将这些标识视为不透明值，并通过精确相等关联事件；恢复的历史标识保留原始字节。[PTC mode 决策](../../../.agents/notes/implemented/feature/2026-06-15-ptc.zh.md) 负责持久化命名与恢复规则。

当已挂载运行时支持覆盖时，`run_code` 接受 `timeoutMs`；其 schema 报告配置的默认值和上限、运行时使用说明及 Session 工作目录。Node 默认值为 120,000 ms，上限为 600,000 ms，包含嵌套工具和审批等待。更宽的 `sandbox_permissions` 模式要求非空 `justification`，并在程序启动前获得审批。授权仅用于该次完整执行；常驻 Session 策略与嵌套工具保留各自权限。程序不会自动重放：显式重试被拒程序前，应检查先前已发生的效果。

<a id="extension-points"></a>
### 扩展点

工具插件调用 `ctx.tools.register()`，其 schema 会自动流入提示词组装。`tools/pre-execute` 是可重排的允许／拒绝／询问门禁；`ctx.tools.guard()` 在其后添加单调的拥有方策略；`tools/execute` 为超时、重试或指标包装规范化后的规范分发；`tools/post-execute` 可以替换内容或值、通过反馈阻止，或附加有序上下文；`tools/result` 观测不可变的最终结果。MCP 服务器发现工具后，用服务器的 schema 调用 `ctx.tools.register()`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

包级约定对大多数消费方已经足够；需要周边领域时再阅读以下页面。

- [工具子系统](../../../docs/subsystems/tools.zh.md)——完整流水线类型、schema DSL 与生成的服务 API。
- [生成工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tools)——模型收到的已交付工具 schema。
- [工具执行流水线](../../../docs/tool-execution-pipeline.zh.md)——可视化流水线。
- [添加工具实操手册](../../../docs/cookbook/adding-a-tool.zh.md)——分步骤的工具编写指南。
- [协作式取消 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-19-cooperative-tool-cancellation.zh.md)——完整取消约定。
- [core 分组地图](../README.zh.md)——core 各包如何组合。

-----

<a id="model-experience"></a>
## 模型体验

### 普通工具 schema

#### 模型看到什么

在普通模式下，模型会看到每个可见定义的确切名称、描述与 JSON Schema；已交付定义记录在生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tools)中。agent 作用域的限制、遮蔽与扩展注册会改变该 agent 的最终工具集合。

#### Token 影响

每次请求的固定成本与可见定义成正比。隐藏工具的限制会为该 agent 移除其全部 schema 成本。

#### KV Cache 影响

只要可见定义及其顺序不变，前缀就保持稳定。注册、dispose 或作用域限制可能从第一个改变的 schema token 起使复用失效。

### PTC mode schema 与系统提示词

#### 模型看到什么

PTC mode 会公开生成的 [`run_code` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tools)、下方 SDK 说明，以及按所加载运行时语言生成的精确 SDK 块。TypeScript 说明会把生成声明明确标为只能在程序内使用的绑定。当当前 `bash` 参数 schema 接受示例参数时，说明还会给出以 `run_code` 包住 `tools.bash(...)` 的完整调用。`tools:sdk` 段使用 first-party 顺序 5000，并关闭提示词变量插值，使两种运行时语言都原样保留工具描述和 schema 中的 `{{…}}` 文本。`both` 会同时公开普通 schema 与此 PTC mode API；在 `ptc` 下，提示词还会带上处于更早 first-party 顺序的 `tools:ptc-only` 规则，让模型先读到「可以调用哪些工具」再读「每个工具做什么」。

##### 带 bash 的 TypeScript PTC mode SDK 说明

```markdown
## Writing code for run_code

`run_code` takes two required arguments: `code` — the body of an async TypeScript function (erasable syntax only — no `enum` or namespaces; type annotations are advisory, the code runs type-stripped) — and `description`, a short summary of what the program does. The declarations below are SDK bindings for this program. A declaration does not make its name a directly callable tool; only names supplied as separate tool schemas may be called directly. When no separate `bash` schema is supplied, invoke a declared `bash` binding inside `run_code`:

`run_code({ code: "return await tools.bash({ command: 'pwd', description: 'Show current directory' })", description: "Show current directory" })`

Inside the program:

- Call tools as `await tools.name(args)` — quoted access for exotic names: `tools["my-tool"](args)`. Every call resolves to the tool's typed canonical JSON value. Tool arguments must be lossless JSON.
- A FAILED tool call rejects with `ToolCallError`, whose `toolName` identifies the failed tool and whose `message` is human-readable — `try/catch` it to handle and continue.
- Independent read-only calls MAY overlap under `Promise.all` (safe calls run concurrently; mutating calls run alone, in submission order). Sequence dependent work with `await`.
- Emit results with `return` and/or `console.log(...)`. Only what you print or return is program output. A successful tool result containing an image is attached after the run so you can inspect it on the next step; every other intermediate result stays out of the conversation, so extract just what you need.

Program-only SDK bindings:
```

#### Token 影响

每次请求的固定成本与可见定义成正比。PTC mode 使用生成的 SDK 文本加一个传输 schema 取代最终工具 schema，但不承诺普遍减少成本。

#### KV Cache 影响

只要 PTC mode 选择、生成的 SDK、传输 schema 与可见工具集合不变，前缀就保持稳定。模式或筛选器变更可能从第一个改变的提示词或 schema token 起使复用失效。

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
- **PTC mode 的 SDK 语言由当前加载的运行时决定，且呈现方式按 agent 而非按工具**：`mode: ptc`/`both` 会拒绝组装提示词，除非 `ctx.ptcRuntime.language` 有已注册的 SDK 渲染器；同一个 agent 内不能让一个工具仅使用 Native，而另一个仅使用 PTC。
- **PTC mode 中间值只存在于执行局部，且没有字节上限**：它们无法从会话回放重建，并可能耗尽进程或 worker 内存；只有外层 `run_code` 输出受 worker 可配置的硬上限约束。
- **每次运行都会获得全新的 `run_code` 状态**：MVP 不采用持久 REPL 风格内核，因为跨调用状态不会出现在日志中。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
