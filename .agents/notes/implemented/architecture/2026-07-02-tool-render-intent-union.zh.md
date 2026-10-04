# Agent Note: 用于工具调用展示的带标签 render-intent 联合类型

Status: implemented

[English](2026-07-02-tool-render-intent-union.md) | 中文

> render-intent 联合类型对 UI 传输层仍然有效；其 ACP（Agent Client Protocol）映射已被 [ACP 作为仅面向自动化的协议](../simplification/2026-07-23-acp-automation-only-protocol.zh.md)取代。

## 问题

工具通过 `ToolDefinition` 上的两个回调 `presentCall`/`presentResult` 声明其调用在 UI（编辑器的工具调用卡片）中如何渲染，返回 `ToolCallPresentation` / `ToolResultPresentation`，并带有一个可选的 `ToolTerminal` 子结构。这些类型在增量演进中变成了一个**可选字段的集合**：调用侧有 `title`、`kind`、`rawInput`、`content`、`locations`、`terminal`；结果侧有 `title`、`content`、`terminal`；`ToolTerminal` 上有 `cwd`/`output`/`exitCode`/`signal`。职责划分模糊不清：

- 调用侧和结果侧的 `terminal` 字段重叠，bridge 需要将每次调用的 `content` 块、`terminal` 块和 `rawInput` 用临时条件逻辑拼接在一起。
- 哪些组合是*合法的*没有文档说明：一个设置了 `content` 的 `terminal` 调用意味着「卡片上方的描述」；一个设置了 `terminal` 的 generic 调用毫无意义但类型上可表达。类型允许无意义的状态存在。
- 无法表达编辑器最需要的文件工具能力：**diff 卡片**（`{path, oldText, newText}`，Zed 将其渲染为内联 diff / 新文件预览）。`ToolCallPresentation.content` 使用的是 *LLM（大语言模型）* 的 `ContentBlock[]` 词汇（text/image），工具根本无法请求 diff 展示。

一个早先被否决的折叠工具自有呈现提案把富渲染推迟到它能够「在至少有两个真实工具和两个真实消费方验证词汇之后，以带标签 render-intent 联合类型的形式回归」之时。该条件已由多个生产者族，加上 TUI 与宿主/客户端运行时（Web）这些消费方满足。

## 决策

用一个**以 `card` 为标签的可辨识联合类型**替代可选字段集合。工具为每次调用/结果声明一个渲染意图；bridge 根据标签分发。

```ts ignore-check
type FileLocation = { path: string; line?: number }
type FileDiff = { path: string; oldText: string | null; newText: string } // oldText null ⇒ new file

// presentCall → ToolCallView
type ToolCallView = GenericCallView | TerminalCallView | DiffCallView
interface GenericCallView { card: 'generic'; title: string; kind?: ToolCallKind; rawInput?: unknown; content?: ContentBlock[]; locations?: FileLocation[] }
interface TerminalCallView { card: 'terminal'; title: string; description?: string; cwd?: string }
interface DiffCallView { card: 'diff'; title: string; diffs: FileDiff[]; locations?: FileLocation[] }

// presentResult → ToolResultView
type ToolResultView = GenericResultView | TerminalResultView
interface GenericResultView { card: 'generic'; title?: string; content?: ContentBlock[] }
interface TerminalResultView { card: 'terminal'; title?: string; output?: string; exitCode?: number; signal?: string }
```

`card` 在每个变体上都是**必填**的——真正的判别字段，而非可选默认值。bridge 执行 `switch (view.card) { case 'generic': … case 'terminal': … case 'diff': … default: assertNever(view) }`。该联合类型是**封闭的**（遵循 [switch 穷举约定](../../../../AGENTS.md)）：第四种渲染意图（表格、图表）无论如何需要新的 bridge 代码来渲染，因此一个由插件添加但被 bridge 静默丢弃的变体，比编译错误更糟糕。新增变体会在 bridge 的 switch 处中断编译——这正是我们想要的信号。

### 为什么带标签联合类型优于字段集合

- **无效状态变得不可表达。** generic 卡片不能携带终端输出；terminal 卡片不能携带 diff。旧的字段集合允许所有这些组合。
- **消费方分发而非拼接。** 每种卡片一个分支，精确产出该卡片所需的视图，而非调和五个交互关系未文档化的可选字段。
- **`diff` 成为一等意图。** `dsh-tool-fs` 的 write/edit 声明带 `{path, oldText, newText}` 的 `card:'diff'`，让有能力的 UI 无需针对工具名做特殊处理即可渲染行内变更。

### 生产者映射

- `dsh-tool-fs` read → `generic`（`kind:'read'`，附带一个 follow-along `location`）；write → `diff`（`oldText:null`）；edit → `diff`（`oldText:old_string || null`，`newText:new_string ?? ''`）。这与 `claude-agent-acp` 的 `toolInfoFromToolUse` 中 Read/Write/Edit 各分支逐字段对应。
- `dsh-tool-bash` 前台运行 → `terminal` 调用 + `terminal` 结果；`run_in_background` → `generic`。通用 `job_*` 控制工具拥有各自的 generic 卡片。
- `dsh-tool-todo` → `generic`。

### 终端回退的归属

`TerminalResultView` 只携带 `output`/`exitCode`/`signal`。不具备终端能力的 UI 需要一个围栏 ` ```console ` 文本回退；该推导移至 **bridge**（在无能力路径上将 `output` 包裹在围栏代码块中），而非由工具双重编码。这使 bash 工具的结果保持单一结构化形状，并逐字节保留既有的能力门控行为。

terminal 意图只用于展示。harness 仍通过自身的 bash 服务执行命令，从而保留沙箱、环境清理、任务归属和每会话 cwd；UI 只呈现已完成的调用，绝不会成为第二个执行后端。

### 纯函数性保持不变

`presentCall`/`presentResult` 仍然是 `args`（`presentResult` 还有 result）的纯函数——它们在实时流式输出和会话日志回放中都会运行，因此必须具备回放确定性。每个 view 仅从 args 推导：write 的 diff 是新文件风格（`oldText:null`），因为工具在调用时没有旧内容；edit 的 diff 是 `old_string`→`new_string`。

## 曾考虑的替代方案

- **完全删除工具自有的展示**：即本 Agent Note 所取代的那个被否决的 collapse 提案；其自身的结论正是推迟到两个真实工具和两个真实消费方存在后再做此联合类型，该条件现已满足。
- **让 UI 执行 terminal 意图**：否决。这样会绕过 harness 的 bash 策略与归属约定，并把命令执行分裂到不同后端。terminal 卡片描述的是 harness 拥有的执行，绝不授权客户端侧执行。
- **可合并扩展的联合类型**（`ContentBlockMap` 模式）：否决。新的渲染意图无论如何需要新的 bridge 代码来渲染，因此一个被 bridge 静默丢弃的插件添加变体，比封闭联合类型在 bridge 的 `assertNever` switch 处引发的编译错误更糟糕。
- **保留可选字段集合**：即「问题」一节所剖析的现状：无效状态可表达、字段交互无文档、且完全无法请求 diff 卡片。

## 后果

新的渲染意图会在 bridge 的 switch 处引发编译中断——这是有意为之：渲染代码必须先于卡片种类存在。无效的卡片/字段组合现已不可表达，bash 回退推导归 bridge 所有，工具只返回一个结构化形状。第四种卡片（表格、图表）的门槛是在同一个变更中编写其 bridge 分支。

## 非目标

- **实时增量 `terminal_output_delta` 流式输出**与**命令分类**：终端渲染 Agent Note 自身推迟的后续工作，本 Agent Note 不涉及。

## 相关

- 取代早先被否决的折叠工具自有呈现提案（已否决——「等两个真实工具和两个真实消费方，然后做带标签 render-intent 联合类型」）中的推迟决定。该条件现已满足；本 Agent Note 即为那个联合类型。
- 被[结果时已应用 hunk 差异](../../archived/architecture/2026-07-02-result-time-applied-hunk-diffs.md)（已归档）扩展：后者添加了一个持久化的 `meta` 通道，使 write/edit 在结果时输出 `DiffResultView`（应用后的变更：带上下文行的 contextual hunk / 每个 `replace_all` 位点一个，或创建时的整文件 diff）——值/呈现拆分与持久化的 `presentationMeta` 通道现由[规范工具输出约定](../../../../packages/core/tools/README.zh.md)拥有。
- 将 `ToolTerminal` 折入当前 UI 传输层使用的带标签 `terminal` 视图。
