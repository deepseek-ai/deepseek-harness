---
description: "基于程序的工具执行、生成 SDK 与嵌套调用限制。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-executor-ptc

[English](README.md) | 中文

## 概述

当模型应通过 `run_code` 程序调用工具时，使用此执行器。先挂载兼容的 PTC 运行时和工具注册表。作用域限制决定生成的 SDK；只有 `run_code` 能被直接调用。可配置每个程序的工具调用总数上限，以及并行安全的子调用并发上限。

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
- name: '@deepseek-ai/dsh-tool-executor-ptc'
  config:
    maxSubCallsPerMinute: 1024
    maxParallelSubCalls: 10
```

根 `run_code` 调用是独占调用，按串行执行。`maxParallelSubCalls` 限制每个程序中并行安全的嵌套调用数，默认值为 `10`；值必须是正整数，`1` 表示串行执行。独占调用构成屏障。

`maxSubCallsPerMinute` 默认值为 `1024`，必须是正整数。每次 `run_code` 的工具调用额度为 `floor(最终 timeoutMs / 60000 × maxSubCallsPerMinute)`：Node 默认超时为两分钟，因此允许 2048 次。计算前先应用运行时默认值和超时上限；没有截止时间时，调用额度也没有有限上限。这是总额度，不是滑动窗口，因此可以集中调用。所有工具绑定共用计数，排队调用、无效参数和失败调用也计入。达到上限后，下一次尝试会通过运行时取消路径终止整个程序，取消进行中的子调用，并放弃排队调用，然后返回 `CODE_RUN_FAILED`。与超时一样，捕获绑定错误也不能让程序继续运行；运行时保留的状态会被丢弃。已完成的工具操作仍然生效，新的程序重新计数。

本包将 `ctx.ptcRuntime` 和 `ctx.systemPrompt` 声明为必需注入；带 Agent 的程序要求 `ctx.workingDirectory`。执行器在运行时可用后才激活，并在运行时卸载时撤回。启用 PTC 执行器但未提供运行时会阻止应用启动。已撤回的 PTC 选择不会回退到原生执行。

共享分派事件与 `ptc-mode` 消息来源声明位于 `@deepseek-ai/dsh-tool-executor-ptc/types`；Client 代码通过 `@deepseek-ai/dsh-tool-executor-ptc/client` 导入同一组声明。两个入口都不引入 Host 服务声明。Host 策略扩展通过包主入口的 `import type` 获取 `PtcDispatchLog` 与 `tools/ptc-dispatch-log`，无需挂载执行器。

`/run-code` 入口导出 `createRunCodeTool`，供插件在原生工具旁注册具名程序工具。调用方显式传入运行时及完整的私有 `ToolDefinition` 列表，再将返回的定义注册到所属作用域。即使 Agent 能直接调用其他原生工具，程序也只能调用该列表中的工具；私有定义不进入工具注册表。嵌套调用保留正常审批、guard、派发日志、截图、延后上下文和轮次结束行为。`RunCodeConfig` 提供与本执行器相同且经过校验的调用额度与并发设置。

调用方拥有传入的运行时，必须使其可用至工厂上下文完成销毁。对于保留状态或实施沙箱的运行时，销毁会取消活动的 Agent 程序并等待嵌套调用；Agent 销毁时释放其保留环境。环境初始化由传入[运行时的注册 API](../../ptc-runtime/ptc-runtime/README.zh.md#choose-a-backend)负责；应在提供程序工具前完成注册。工厂将运行时语法和执行说明追加到调用方提供的描述后；私有绑定的说明由调用方提供。

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-executor-ptc)

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

执行器接收完整的原始调用批次，负责解析、调度、取消和可选的模型步骤日志。它复用共享调用流水线来执行策略、工具和结果通知。中止后，它等待已开始的工作完成，并为跳过的调用返回有序错误结果。卸载执行器会中止 Agent 在支持沙箱或保留状态的运行时中执行的程序，并等待其嵌套调用结束。已接纳批次仍由该执行器结算，但可能返回取消错误。

### PTC mode

PTC 执行器公开保留的 `run_code` 传输，以及按所加载运行时语言生成的确定性 SDK。每个 SDK 绑定捕获冻结的 ToolSchema，经由调度器传入该次执行上下文。已开始的调用在策略之前只记录配对 id、名称和规范化参数；其结算事件保留渲染结果、可选展示元数据与结构化错误；元数据由该次调用的规范值投影并冻结，不改变程序读取的值或模型内容。描述与参数 schema 仅临时存活，不进入 Session 事件或 SDK 输出。调用通过复用原生并发约定的每次运行独有池调度。在纯 `ptc` 下，模型直呼仅供程序使用的 SDK 工具都会在策略之前解析为 `UNKNOWN_TOOL`——通告面与可调用面保持一致。中间绑定值只存在于执行局部；只有外层 `run_code` 结果有硬大小上限。

新子调用使用 `<parent>:ptc:<n>` 标识。消费方将这些标识视为不透明值，并通过精确相等关联事件；恢复的历史标识保留原始字节。[PTC mode 决策](../../../.agents/notes/implemented/feature/2026-06-15-ptc.zh.md) 负责持久化命名与恢复规则。

成功且包含图片的子调用结果会成为延后的 user-message 上下文，其 `source.kind` 为 `ptc-mode`。其他 additional context 保留其生产工具的归属。

调用方取消且运行时报告 `abort` 时，`run_code` 等待清理完成，并返回原生工具的取消结果：`AbortError` / `ABORTED`，内容为 `Error: tool call aborted`。保留状态的运行时会附加取消诊断，包括变量被保留还是清空。Agent 在 `turn/end` 中记录具体取消原因，包括 hook 的理由。其他运行时失败保留 `CODE_RUN_FAILED` 及其诊断，即使调用方同时取消。取消可能丢弃保留的运行时状态，也不会撤销已完成的工具操作。

当已挂载运行时支持覆盖时，`run_code` 接受 `timeoutMs`；其 schema 报告配置的默认值和上限以及运行时使用说明。Node 默认值为 120,000 ms，上限为 600,000 ms，包含嵌套工具和审批等待。更宽的 `sandbox_permissions` 模式要求非空 `justification`，并在程序启动前获得审批。schema 提示模型使用当前用户的语言撰写理由。授权仅用于该次完整执行；常驻 Session 策略与嵌套工具保留各自权限。程序不会自动重放：显式重试被拒程序前，应检查先前已发生的效果。 保留状态的 PTC 环境遵循会话文件策略。PTC 观察已提交的 Session 模式变化，并立即取消所有 Node 模式下受影响的调用。后续 PTC 调用等待这些调用的嵌套工具清理后，再解析最新策略。运行时负责进程失效和清理，权限设置保持同步。单次提权省略状态所有者，在临时环境中执行；普通调用仍可访问原环境的变量。

自定义宿主集成保留自己的 `PtcExecutor` 实例，通过 `reset(agent)` 清空该 Agent 的环境；重置不是模型工具或 SDK 绑定。该操作要求运行时保留状态，会取消活动调用、调用 `release(agent)`，并等待进程及已启动嵌套工具的清理，无需程序响应。接纳新程序前，它排入 `Program environment reset; retained variables cleared. Completed tool effects remain.` 上下文。通知消费时写入日志；取消或 Agent 销毁可能在状态已清空后丢弃通知。并发重置共享清理过程。运行时缺失或不受支持时，操作拒绝但不阻止后续准入。清理或通知入队失败会抛出 `CodeResetFailedError`；后续程序报告带宿主重置指引的 `CodeRunFailedError`，直到显式重试成功。重置不会撤销已完成的工具操作。

- [`src/index.ts`](src/index.ts) — 作用域注册、工具描述、批次执行及宿主环境重置。
- [`src/ptc-calls.ts`](src/ptc-calls.ts) — 调用准入和取消；重置等待运行时释放及嵌套工具清理后，才接纳新调用。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工具注册表](../tools/README.zh.md)
- [Agent 循环](../agent-loop/README.zh.md)
- [其他执行器](../tool-executor-native/README.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

### PTC mode schema 与系统提示词

#### 模型看到什么

PTC mode 会公开生成的 [`run_code` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-executor-ptc)、下方 SDK 说明，以及按所加载运行时语言生成的精确 SDK 块。两种运行时语言都将 `code` 列在 `description` 前；这是呈现顺序，不强制 JSON 成员顺序。REPL 与 Script 运行时共用通用工具描述和 SDK 说明；语法与状态规则由各自的 `executionInstructions` 提供。TypeScript bash 示例对函数体运行时返回值，对 REPL 和 Script 运行时打印输出。说明将生成声明明确标为只能在程序内使用的绑定。当当前 `bash` 参数 schema 接受示例参数时，说明还会给出以 `run_code` 包住 `tools.bash(...)` 的完整调用。`tools:sdk` 段使用 first-party 顺序 5000，并关闭提示词变量插值，使两种运行时语言都原样保留工具描述和 schema 中的 `{{…}}` 文本。在 `ptc` 下，提示词还会带上处于更早 first-party 顺序的 `tools:ptc-only` 规则，让模型先读到「可以调用哪些工具」再读「每个工具做什么」。 工具调用额度耗尽时，`run_code` 返回失败结果，说明额度、被拒绝的调用序号、程序已终止，以及可能存在死循环。运行时清理诊断和已捕获的输出仍然可见。

##### 带 bash 的 TypeScript PTC mode SDK 说明

```markdown
## Writing code for run_code

`run_code` takes two required arguments: `code`, the body of an async TypeScript function (erasable syntax only — no `enum` or namespaces; type annotations are advisory, the code runs type-stripped), and `description`, a short summary of what the program does. The declarations below are SDK bindings for this program. A declaration does not make its name a directly callable tool; only names supplied as separate tool schemas may be called directly. When no separate `bash` schema is supplied, invoke a declared `bash` binding inside `run_code`:

`run_code({ code: "return await tools.bash({ description: 'Show current directory', command: 'pwd' })", description: "Show current directory" })`

Inside the program:

- Call tools as `await tools.name(args)` — quoted access for exotic names: `tools["my-tool"](args)`. Every call resolves to the tool's typed canonical JSON value. Tool arguments must be lossless JSON.
- A FAILED tool call rejects with `ToolCallError`, whose `toolName` identifies the failed tool and whose `message` is human-readable — `try/catch` it to handle and continue.
- Independent read-only calls MAY overlap under `Promise.all` (safe calls run concurrently; mutating calls run alone, in submission order). Sequence dependent work with `await`.
- Emit results with `return` and/or `console.log(...)`. Only what you print or return is program output. A successful tool result containing an image is attached after the run so you can inspect it on the next step; every other intermediate result stays out of the conversation, so extract just what you need.

Program-only SDK bindings:
```

##### 工具调用额度耗尽

```markdown
Error: code run failed (abort): run_code exceeded its limit of 2048 tool calls (1024 per minute of its timeout); call 2049 was not dispatched. The run_code program may contain an infinite loop. Check loop termination or split the work into smaller run_code calls.
```

#### Token 影响

每次请求的固定成本与可见定义成正比。PTC mode 使用生成的 SDK 文本加一个传输 schema 取代最终工具 schema，但不承诺普遍减少成本。调用额度不增加 SDK 或 schema 文本；超限诊断通过该次运行的失败结果消耗 token。

#### KV Cache 影响

只要 PTC mode 选择、生成的 SDK、传输 schema 与可见工具集合不变，前缀就保持稳定。模式或筛选器变更可能从第一个改变的提示词或 schema token 起使复用失效。修改 `maxSubCallsPerMinute` 不会改变提示词或 schema token。

### 注册的程序工具

#### 模型可见内容

工厂创建的工具显示调用方提供的名称和描述，并使用与 `run_code` 相同的程序参数、运行时说明和结果渲染。私有绑定不生成直接工具 schema 或 SDK 提示词段落。绑定指引由消费方负责。

#### Token 影响

现有原生工具 schema 中加入一个程序工具 schema。调用方的绑定指引产生相应提示词成本；中间值只有在程序输出它们或嵌套工具提供延后上下文时才进入模型历史。

#### KV Cache 影响

只要调用方描述和运行时设置不变，schema 就保持稳定。初始化在运行时内部执行，不向模型请求添加程序源码。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下约束适用于宿主集成及已开始的调用。

- **没有内置重置控件**：自带的 Loader 插件不通过服务、GUI 控件或 SDK 端点暴露执行器实例。需要重置的宿主必须在自己的组合中挂载并保留 `PtcExecutor`，该集成负责失败后的重试。
- **PTC mode 的 SDK 语言由当前加载的运行时决定，且呈现方式按 agent 而非按工具**：PTC 会拒绝组装提示词，除非 `ctx.ptcRuntime.language` 有已注册的 SDK 渲染器；同一个 agent 内不能让一个工具仅使用 Native，而另一个仅使用 PTC。
- **PTC mode 中间值只存在于执行局部，且没有字节上限**：它们无法从会话回放重建，并可能耗尽进程或 worker 内存；只有外层 `run_code` 输出受 worker 可配置的硬上限约束。
- **状态由运行时决定**：默认后端每次重新开始；Node REPL 和启用 `scriptPersistence: true` 的 Script 模式按存活 Agent 保留内存。Agent 销毁时等待环境释放。重启与执行失败可能清除内存；模型说明会指导重新创建缺失变量。程序与结果仍写入 Session 日志，不序列化运行中的对象。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
