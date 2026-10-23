---
description: "基于程序的工具执行、生成 SDK 与嵌套调用限制。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-executor-ptc

[English](README.md) | 中文

## 概述

当模型应通过 `run_code` 程序调用工具时，使用此执行器。先挂载兼容的 PTC 运行时和工具注册表。作用域限制决定生成的 SDK；只有 `run_code` 能被直接调用。可配置并行安全的程序子调用并发上限。

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
    maxParallelSubCalls: 10
```

根 `run_code` 调用是独占调用，按串行执行。`maxParallelSubCalls` 限制每个程序中并行安全的嵌套调用数，默认值为 `10`；值必须是正整数，`1` 表示串行执行。独占调用构成屏障。

本包将 `ctx.ptcRuntime` 和 `ctx.systemPrompt` 声明为必需注入；带 Agent 的程序要求 `ctx.workingDirectory`。执行器在运行时可用后才激活，并在运行时卸载时撤回。启用 PTC 执行器但未提供运行时会阻止应用启动。已撤回的 PTC 选择不会回退到原生执行。

共享分派事件与 `ptc-mode` 消息来源声明位于 `@deepseek-ai/dsh-tool-executor-ptc/types`；Client 代码通过 `@deepseek-ai/dsh-tool-executor-ptc/client` 导入同一组声明。两个入口都不引入 Host 服务声明。Host 策略扩展通过包主入口的 `import type` 获取 `PtcDispatchLog` 与 `tools/ptc-dispatch-log`，无需挂载执行器。

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-executor-ptc)

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

执行器接收完整的原始调用批次，负责解析、调度、取消和可选的模型步骤日志。它复用共享调用流水线来执行策略、工具和结果通知。中止后，它等待已开始的工作完成，并为跳过的调用返回有序错误结果。卸载执行器会中止运行中的沙箱程序，并等待其嵌套调用结束。已接纳批次仍由该执行器结算，但可能返回取消错误。

### PTC mode

PTC 执行器公开保留的 `run_code` 传输以及按所加载运行时语言生成的确定性 SDK。每个 SDK 绑定捕获冻结的 ToolSchema，经由调度器传入该次执行上下文。已开始的调用在策略之前只记录配对 id、名称和规范化参数；其结算事件保留渲染结果、可选展示元数据与结构化错误；元数据由该次调用的规范值投影并冻结，不改变程序读取的值或模型内容。描述与参数 schema 仅临时存活，不进入 Session 事件或 SDK 输出。调用通过复用原生并发约定的每次运行独有池调度。在纯 `ptc` 下，模型直呼其他任何可见工具都会在策略之前解析为 `UNKNOWN_TOOL`——通告面与可调用面保持一致。中间绑定值只存在于执行局部；只有外层 `run_code` 结果有硬大小上限。

新子调用使用 `<parent>:ptc:<n>` 标识。消费方将这些标识视为不透明值，并通过精确相等关联事件；恢复的历史标识保留原始字节。[PTC mode 决策](../../../.agents/notes/implemented/feature/2026-06-15-ptc.zh.md) 负责持久化命名与恢复规则。

成功且包含图片的子调用结果会成为延后的 user-message 上下文，其 `source.kind` 为 `ptc-mode`。其他 additional context 保留其生产工具的归属。

当已挂载运行时支持覆盖时，`run_code` 接受 `timeoutMs`；其 schema 报告配置的默认值和上限以及运行时使用说明。Node 默认值为 120,000 ms，上限为 600,000 ms，包含嵌套工具和审批等待。更宽的 `sandbox_permissions` 模式要求非空 `justification`，并在程序启动前获得审批。schema 提示模型使用当前用户的语言撰写理由。授权仅用于该次完整执行；常驻 Session 策略与嵌套工具保留各自权限。程序不会自动重放：显式重试被拒程序前，应检查先前已发生的效果。 保留状态的 PTC 环境遵循会话文件策略。PTC 观察已提交的 Session 模式变化，并立即取消两种 Node 模式下受影响的调用。后续 PTC 调用等待这些调用的嵌套工具清理后，再解析最新策略。运行时负责进程失效和清理，权限设置保持同步。单次提权省略状态所有者，在临时环境中执行；普通调用仍可访问原环境的变量。

- [`src/index.ts`](src/index.ts) — 配置校验和作用域注册；工具描述和批次执行。

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

PTC mode 会公开生成的 [`run_code` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-executor-ptc)、下方 SDK 说明，以及按所加载运行时语言生成的精确 SDK 块。两种运行时语言都将 `code` 列在 `description` 前；这是呈现顺序，不强制 JSON 成员顺序。TypeScript 说明对函数体运行时使用返回值示例，对 REPL 运行时使用打印输出示例，并把生成声明明确标为只能在程序内使用的绑定。当当前 `bash` 参数 schema 接受示例参数时，说明还会给出以 `run_code` 包住 `tools.bash(...)` 的完整调用。`tools:sdk` 段使用 first-party 顺序 5000，并关闭提示词变量插值，使两种运行时语言都原样保留工具描述和 schema 中的 `{{…}}` 文本。在 `ptc` 下，提示词还会带上处于更早 first-party 顺序的 `tools:ptc-only` 规则，让模型先读到「可以调用哪些工具」再读「每个工具做什么」。

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

#### Token 影响

每次请求的固定成本与可见定义成正比。PTC mode 使用生成的 SDK 文本加一个传输 schema 取代最终工具 schema，但不承诺普遍减少成本。

#### KV Cache 影响

只要 PTC mode 选择、生成的 SDK、传输 schema 与可见工具集合不变，前缀就保持稳定。模式或筛选器变更可能从第一个改变的提示词或 schema token 起使复用失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下约束适用于已开始的调用。

- **PTC mode 的 SDK 语言由当前加载的运行时决定，且呈现方式按 agent 而非按工具**：PTC 会拒绝组装提示词，除非 `ctx.ptcRuntime.language` 有已注册的 SDK 渲染器；同一个 agent 内不能让一个工具仅使用 Native，而另一个仅使用 PTC。
- **PTC mode 中间值只存在于执行局部，且没有字节上限**：它们无法从会话回放重建，并可能耗尽进程或 worker 内存；只有外层 `run_code` 输出受 worker 可配置的硬上限约束。
- **状态由运行时决定**：默认后端每次重新开始；REPL 后端按存活 Agent 保留内存。Agent 销毁时等待环境释放。重启与执行失败可能清除内存；模型说明会指导重新创建缺失变量。程序与结果仍写入 Session 日志，不序列化运行中的对象。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
