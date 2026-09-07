# 工具编写参考

[English](adding-a-tool.md) | 中文

面向模型的工具必须满足哪些约定，均以本文为准。如需按步骤构建第一个工具，请阅读[构建工具](../user/develop/basic/tool.zh.md)。`packages/shell/tool-bash` 是生产级的三包示例。

## 最小形态

```ts
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'my-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'read_file',
    description: 'Read a file from disk.',          // what the model sees
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path' },
      limit: { type: 'number' },                     // optional by default
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      // args is TYPED from the schema: { path: string; limit?: number }
      // exec carries immutable identity + token; signal is the operational field
      return readFile(args.path, { encoding: 'utf8', signal: exec.signal })
    },
  }))
}
```

注册基于副作用：dispose（资源释放）插件 fiber 即注销该工具。schema 会自动流入系统提示词的组装过程。

## execute() 约定的规则

- **参数已为你校验。** `defineTool` 在 `execute` 运行前，会根据统一的 `ParameterSchemaSpec` 校验模型生成的 `arguments`（类型、必填键、字面量约束、恰好匹配一个分支的联合以及嵌套值），因此 `execute` 内的 args 会匹配 `InferArgs`。显式对象节点必须声明 `additionalProperties: true | false`；隐式参数根对象保持开放。你仍需手动检查 schema DSL 无法表达的约束，例如非空字符串、正数或跨字段规则。直接注册的原始 JSON Schema 工具自行负责输入校验。
- **注册借用你的只读定义。** 类型化的同进程贡献不是序列化边界；注册后不要修改其 schema 或替换回调。`schemas()` 只物化显式的模型可见投影。如需热替换工具，请 dispose 其所属副作用并注册替代品；回调闭包内的可变状态仍是普通的插件状态。
- **执行身份受保护。** 注册表在一次递归遍历中将 `arguments` 物化为分离的无损 JSON，在策略开始前冻结该值，并分配一个不透明的 `exec.token`；`callId`、`name`、`arguments`、`agent`、`token`、必填且由调用方持有的 `signal`，以及可选的外层传输 `parent` token 在整个分发过程中保持不可变。`parent` 仅用于身份标识，不暴露活跃的外层执行。请将 `args` 视为只读输入。只有 around-dispatch 包装器会收到可变视图；它可以替换并恢复必填的 `exec.signal` 以施加截止时间，但不能移除该信号。
- **声明并返回一个规范 JSON 值。** `output.schema` 使用 `ValueSchemaSpec`，根可以是对象、数组、标量或 null。`execute` 只返回推导出的值；注册表将其快照为无损 JSON，完成校验和冻结后，再传给 `output.render(args, value)`。工具主体不要返回内容块，也不要迫使调用方从自然语言中解析 id 和字段。
- **抛出异常或返回无效值意味着 `isError`。** 注册表会捕获异常，并在观察者运行前收敛 schema、渲染器、元数据投影器和无损 JSON 失败。基础设施故障请抛异常。成功的领域结果即使表示不理想的状态，也应写入规范值；其 Native 渲染器可以解释该状态，例如进程以非零状态退出。
- **遵守 `exec.signal`。** 信号触发时取消进行中的工作。
- **使用 `presentationMeta` 投影持久化的卡片数据（可选）。** `output.presentationMeta(args, value)` 从同一个规范值派生可回放的 JSON。核心将其持久化在 `tool/result` 上并传给 `presentResult`，因此需要结果期事实的卡片——例如 `write`／`edit` 的已应用 hunk——无需持久化规范值也能在回放中重现。嵌套 Code 分发没有卡片，因此会跳过该投影器。
- **使用 `exec.agent` 发送异步通知。** `agent.inject({ content, source: { kind: 'plugin', plugin: '<name>' } })` 追加持久化上下文，下一次模型请求会看到它——这不是唤醒（空闲的 agent（智能体）保持空闲）。请防范已 dispose 的 agent（try/catch）。

## 长时间运行的工作

通过 producer 配置控制 `run_in_background`，然后使用 `ctx.jobs.start({ kind, label, owner: exec.agent, run })` 注册任务。注册表会在进入 producer 主体前将已预先中止的调用判为失败；运行时会在 `run()` 启动工作前校验 owner 和任务控制器是否可用，随后提供 id、会话围栏、通用控制工具、通知和 owner cleanup。成功的后台分支会返回类型化的规范句柄，如 `{ kind: 'background', jobId }`；其 Native 渲染器可以保留 `started background job bash-1` 这类供人阅读的自然语言，但 PTC mode 绝不能通过解析该文本取得 id。

producer 提供同步的 `cancel`、在资源清理后 settle 且不 reject 的 `done`，以及可选的消费式 `readOutput`（负责有界输出的格式化）。预先中止的调用属于失败，因为此时没有任务，其 id 无法满足成功输出 schema。`ctx.jobs.start()` 发布 id 后，应使用任务自有的取消信号，而不是 `exec.signal`：之后取消外层调用只会停止等待本次调用，不会终止已经发布的工作；该生命周期归 `job_kill`、owner dispose 和服务 teardown 所有。前台工作仍与 `exec.signal` 耦合。流式 producer 的示例和完整约定见[后台任务运行时 Agent Note](../../.agents/notes/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.zh.md)与 `dsh-tool-bash`。

<a id="execution-policy-and-observation"></a>

## 执行策略与观测

尽量不要把部署策略内建到工具中。使用 `tools/pre-execute` 实现可扩展的允许／拒绝／询问策略（见[权限门禁示例](extension-cookbook.zh.md#a-hook-plugin-permission-gate-example)）；使用 `ctx.tools.guard()` 设置最终的单调拒绝，后续监听器无法撤销；使用 `tools/execute` 为分发添加截止时间、重试或指标收集；使用 `tools/post-execute` 替换展示内容或返回值、阻止结果，或附加模型可见上下文；使用 `tools/result` 观测不可变的归一化结果而不改变它。替换内容不会阻止程序化访问 `value`；保密策略会屏蔽或替换该值。沙箱实现也可以在工具的执行器实现中运行；[`dsh-tools` README](../../packages/core/tools/README.zh.md#extension-points) 定义每个扩展点的输入、顺序、返回值和失败行为。

## PTC mode 自动触达你的工具

在 [PTC mode](../../packages/core/tools/README.zh.md) 中，每个可见的已注册工具都可通过 `await tools.<name>(args)` 调用，无需额外集成。生成的 `ToolArgsMap` 和 `ToolOutputMap` 会根据同一组 schema 分别派生精确的参数类型与规范返回类型，调用则重新进入正常的执行流水线。成功调用会解析为策略处理后的最终规范 JSON 值，而不是渲染后的 Native 内容。失败调用会以真正的 `ToolCallError` reject；程序只能检查其 `name`、`toolName` 和可供人阅读的 `message`，无法取得内部错误代码或失败联合。

请把 `output.schema` 设计为实用的程序化 API：直接返回句柄与字段；当标量、数组或 null 确实就是结果时，允许采用相应的根类型；将面向人类的解释放入 `output.render`。中间值只存在于执行期间，不会被持久化或按提示词上限截断，也不设字节上限，因此生产方如实声明的采集边界和进程内存仍然重要。只有外层 `run_code` 日志／结果会受到可配置输出上限和面向模型的 spill 流水线约束。

## 工具在 UI 中的渲染方式

工具的 `output.render` 返回模型可见的内容；其 **UI 卡片** 是另一项独立关注点，通过纯展示投影以及可选的 `presentCall`／`presentResult` 方法声明。请将这些内容与规范值一并设计。没有 UI 展示方法的工具会回退到通用卡片（标题 = 工具名，原始 args 作为输入）。

两个方法都返回一个 **`card` 标签的渲染意图**——选择与你的工具行为匹配的卡片类型：

- `presentCall(args)` → 一个 `ToolCallView`（PENDING 卡片）：
  - `{ card: 'generic', title, kind?, rawInput?, content?, locations? }`——默认。设置 `kind` 获取图标（`read`／`search`／…）；设置 `locations: [{ path, line? }]` 标注工具涉及的文件，使有能力的编辑器跟随／跳转。
  - `{ card: 'terminal', title, description?, cwd? }`——你的调用本身就是 shell 命令。`title` 是命令，`description` 渲染在终端卡片上方。（tool-bash。）
  - `{ card: 'diff', title, diffs, locations? }`——你的调用创建或修改文件。`diffs: [{ path, oldText, newText }]`（新文件时 `oldText: null`）渲染为内联 diff 卡片。（tool-fs `write`／`edit`。）
- `presentResult(args, { content, isError, meta? })` 返回完成后的卡片：
  - `generic` 提供可选的标题和内容。
  - `terminal` 提供原始输出和可选的退出元数据；各 UI 根据自身能力渲染对应视图或回退视图。
  - `diff` 提供已应用的 hunk，通常由 `output.presentationMeta` 派生并通过持久化的 `result.meta` 携带，使回放能重现它们。变更类工具保留 diff 结果，因为完成后的视图会替换 pending 卡片。
  - `read` 提供从持久化 `result.meta` 重建的已完成文件窗口：文件 `path`、从 1 开始的 `offset`、返回的 `lines`（每行保留其文件行号）、`totalLines`，以及可选的 `lang` 高亮提示；不具备 `read` 能力的 UI 回退到原始结果内容。没有 `read` 调用视图——读取调用的 pending 状态保持为 generic 卡片，因为内容只在 `execute` 之后才存在。（tool-fs `read`。）
  - `search` 提供从持久化 `result.meta` 重建的发现型结果：按文件分组的匹配（`shape: 'matches'`，grep）或扁平路径列表（`shape: 'paths'`，glob），外加 `truncated`／`total` 使 UI 永不把被截断的结果当作完整结果呈现。该视图不携带结果文本（无 search 卡片的 UI 回退到原始结果内容），也没有 `search` 调用视图——发现型调用的 pending 状态保持为 generic 卡片，因为匹配只在 `execute` 之后才存在。（tool-fs-search 的 `grep`／`glob`。）
  - `web` 提供已完成的 web 检索，以 `kind: 'search' | 'fetch'` 区分（结构化的搜索来源或抓取摘要），由 `result.meta` 派生；它不携带正文副本，因此不具备 `web` 能力的 UI 回退到原始结果内容。（tool-web `web_search`／`web_fetch`。）

硬性规则（违反会出问题）：

- **纯函数。** 这些方法在实时流式输出和会话日志回放时都会运行，因此必须是 `args`（加 result）的纯函数——不做 I/O、不读会话状态、不用时钟／随机数。diff 从 args 派生（`write` 使用 `oldText: null`，因为调用时的展示器没有文件先前内容）；会话上下文由 UI 适配器而非工具提供。如果你发现自己想在 `presentCall` 内获取文件旧内容或工作目录，请停下：那属于持久结果元数据或适配器，不属于展示器。
- **UI 格式不进入模型结果。** 围栏 ` ```console ` 块、diff、相对化路径均不应仅为服务 UI 而进入规范值或 Native 内容。`output.render` 负责模型可见的自然语言；`presentationMeta` 和卡片展示器负责可回放的 UI 状态。`terminal` 结果视图携带原始输出，由适配器按需添加回退格式。
- **`defineTool` 对展示路径做软校验。** 格式错误或旧版日志中的参数会使包装器返回 `undefined`（通用回退）而非抛异常——展示绝不能导致回放崩溃。

中性词汇定义在 `dsh-tools` 中；工具绝不导入 UI 或传输类型。使用该 API 的消费方把每个 `card` 映射到自己的视图。设计与原因见[渲染意图联合体 Agent Note](../../.agents/notes/implemented/architecture/2026-07-02-tool-render-intent-union.zh.md)；`dsh-tool-fs`（generic/diff）和 `dsh-tool-bash`（terminal）是参考实现。

## Web Client 展示

内置 Web Client 不消费 `presentCall` 或 `presentResult`。Session `page` 与 `follow` 运输原始 `tool/call` 和 `tool/result` 事件，包括持久化的 `result.meta`。Client 插件在 keyed slot `tool.call.toolview` 中注册自己的 wire 工具名称，并从 `ToolCallBlock` 的参数、内容、错误、metadata、现有 Code Dispatch `parentCallId` 与 Session 路径事实派生组件 props。插件在本地校验这些 wire 值，并让格式错误或不受支持的输入回退到 generic 行。

现有 Web 卡片需要模型可见内容无法无损保存的有界结构化结果事实时，使用 `output.presentationMeta(args, value)`。不要在 metadata 中保存 React props 或预选卡片，不要把 Host 工具实现导入浏览器 bundle，也不要建立另一套 Client presenter registry。只定义 Host 展示方法不会增加专用 Web 卡片。[Client 派生展示 Agent Note](../../.agents/notes/implemented/architecture/2026-08-23-client-derived-tool-presentation.zh.md)规定 owner、fallback 与对等要求。

## 验证

遵循[仓库测试策略](../testing.zh.md)和所属包的测试文档。已交付且面向模型或 UI 的变更必须提供其中规定的组装覆盖。
