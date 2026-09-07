# Agent Note: Client 从原始 Session 工具事件派生展示

Status: implemented

[English](2026-08-23-client-derived-tool-presentation.md) | 中文

## Problem

Session 历史是持久 journal 接口，工具卡片属于 Client 展示。在 `page`／`follow` 中计算卡片 view 会让历史读取依赖 Tools registry、Agent preset、恢复后的 scope、presenter 执行和临时 UI 类型。

`tool/result` 不重复记录工具名称和参数。Host 端结果展示因此需要 call index 或按 `callId` 回扫；`maxMessages` 不直接限制事件数量，工具密集页面上的重复扫描可能接近二次方成本。

Host 投影还会重复结构化数据。read、diff、search 与 web 结果已在 `tool/result.data.meta` 中持久化有界事实；另一份 view 只增加 Remote payload 与 Client 解码成本，不增加持久语义。

Client 已经拥有完整的工具展示入口。`ui-chat` 将 `tool/call`、`tool/result` 与 Code Dispatch 事件组装成稳定的 `ToolCallBlock`；`ui-tool` 拥有递归调用树、按工具名称分发的 `tool.call.toolview` keyed slot、Generic fallback、卡片模型和 details output；业务 Client 插件可以为自己的工具名称注册 renderer。

Host presenter 与 Client keyed renderer 分担展示会形成对同一事件的两套解释。keyed renderer 是 Web 扩展点，因此中间 Host view 不提供独立 Web 能力。

`ToolDefinition.presentCall`／`presentResult` 仍是保留的 Host API；ACP 采用 automation-only 协议，仓库也没有生产 TUI consumer。是否删除这些定义与 Session 读取是否独立于展示是两个决定。

所需结果是一条原始 Session journal 和一个 Client 展示 owner，且不发生可见退化或顺带增强。专用卡片、交互和 Code Dispatch 拓扑保持稳定，transport 不再携带临时 view。

## Decision

下述展示对等要求不包含已独立批准的[嵌套 terminal 卡片修复](../bug-fix/2026-09-05-nested-terminal-cards.zh.md)；其他展示与所有权约束全部保留。

Session Remote journal 只下发原始、已验证、可持久化的 Session event。`session.page` 和 `session.follow` 不解析工具参数，不查询 Tools registry，不恢复 presenter scope，不执行 `presentCall`／`presentResult`，也不构造或克隆任何 tool view。

Client Conversation 层继续负责工具调用与结果的 identity、配对、生命周期、Code Dispatch 拓扑和稳定 Chat Node。它不解释具体工具名称，也不生成 terminal、diff、read、search 或 web 组件 props。

Client `ui-tool` 继续负责 card model 和具体 renderer。每个 card model 改为直接读取 `ToolCallBlock` 中的工具名称、原始参数、结果内容、错误、持久 metadata、Session cwd 与 Host home，并生成与现有页面相同的组件 props。

Client 不建立第二套 presenter registry。工具名称分发只使用现有 `tool.call.toolview` keyed slot；Client 中的纯 card-model helper 属于 renderer 实现，不成为 Cordis service、公开 registry 或 wire DTO。

Host 的 `ToolDefinition.presentCall`、`ToolDefinition.presentResult`、`ToolCallView`、`ToolResultView` 及现有 presenter 实现全部保留。Session Controller 不调用它们，Client 不导入或消费它们；未来非 Client consumer 是否使用它们不属于本决定。

`ToolOutputDefinition.presentationMeta` 与持久 `tool/result.data.meta` 保留。它们携带模型可见结果文本无法无损表达、而现有专用卡片需要的执行结果事实。Client 直接校验并消费 `meta`，不要求 Host 在历史读取时再把它转换成 view。

### 目标与非目标

| 类别 | 决定 |
|---|---|
| 不存在 | `SessionEventEntry.view`、`SessionToolView`、`SessionToolCallView` |
| 不存在 | `history.ts` 的 `viewFor`、`backscanArgs`、`parseToolCall`、`jsonView` 与 presenter scope lookup |
| 不存在 | follow 中只服务 presentation 的 `openCalls` 与 fallback event scan |
| 不存在 | Client Session 的平行 `views` 数组、Conversation input 的 `view`、Tool block 的 `callView`／`resultView` |
| 派生 | terminal、diff、read、search、web card model 读取 raw block/meta |
| 派生 | Deliverables 读取成功 mutation 的名称与参数 |
| 保留 | Host `ToolDefinition.presentCall`／`presentResult` API、类型、实现与直接测试 |
| 保留 | `output.presentationMeta` 与持久 `tool/result.data.meta` |
| 保留 | Session 日志格式、Remote journal 生命周期与 Conversation identity/topology |
| 保留 | 现有 keyed slot、Generic fallback、Chat、Details 与 Trajectory 结构 |
| 禁止 | 新 Client presenter service、平行 registry 或 wire renderer id |
| 禁止 | 新卡片、视觉改版、交互改版或 Code Dispatch rich-card 增强，[嵌套 terminal 卡片例外](../bug-fix/2026-09-05-nested-terminal-cards.zh.md)除外 |
| 禁止 | 为兼容保留双写、版本协商或旧 `view` 字段 |

## 术语

**原始 Session event**指持久日志中的 `SessionEvent` 事实，包括 `tool/call` 的 `name` 与原始 `arguments` 字符串，以及 `tool/result` 的 `content`、`isError`、结构化错误和可选 `meta`。

**持久 metadata**指 `ToolOutputDefinition.presentationMeta` 在工具成功执行时生成并写入 `tool/result.data.meta` 的 JSON 值。它是结果事实的一部分，不是预先排版的 React 或 card DTO。

**Host tool view**指 `ToolDefinition.presentCall`／`presentResult` 返回的 `ToolCallView`／`ToolResultView`；Session Remote 不运输它。

**Client card model**指 `ui-tool/src/client/tool/models/` 下直接供 `TerminalBlock`、`DiffBlock`、`ReadBlock`、`SearchBlock`、`WebBlock` 或 `ToolRow` 使用的纯 props 数据。

**专用卡片**指 terminal、diff、read、search 与 web 的结构化正文；标题、摘要、状态点和普通 IN／OUT 文本仍属于通用工具行。

**对等**指同一受支持输入产生由现有组件、组装与浏览器证据固定的用户可见结果和交互，不要求相同的中间 TypeScript 类型或内部函数调用。

**无增强**指本决定不让被固定为 Generic fallback 的输入获得新专用卡片，也不扩大已有卡片的数据或交互。

## 架构与所有权

### 工具执行与持久化

1. 工具注册 `output.schema`、`output.render` 和可选 `output.presentationMeta`。
2. 成功执行产生 canonical JSON value。
3. Tools runtime 对 value 做快照、schema 校验和冻结。
4. `output.render(args, value)` 生成模型可见 `ContentBlock[]`。
5. 顶层调用若声明 `output.presentationMeta`，runtime 同时生成 JSON-safe metadata。
6. Agent loop 把模型可见结果与 metadata 写入 `tool/result` Session event。
7. Session log 不保存 `ToolCallView` 或 `ToolResultView`。

### Host journal 读取

1. `session.page` 取得 attached 或 persisted 事件。
2. `paginate()` 按 append-origin user／assistant message 边界切页。
3. tail page 通过已注册 projection 的 snapshot/restore 路径取得 baseline。
4. 每个 page entry 只包含 `{event}`。
5. `session.follow` 先建立 listener，再执行 catch-up read、发送 opening cursor 并流式下发连续 `{event}` frame。
6. 两条路径都不为展示解析 preset／Tools scope、解析工具参数、调用 presenter 或建立 call index。

### Client 数据与展示

1. Client Session 保存一个连续 raw event window。
2. `SessionEventSource` 发布只含 event 的 `SessionEventEntry`。
3. `ui-conversation` 在没有 presentation companion 的情况下 fold 每个事件。
4. Chat 与 Trajectory Tool Definition 按 callId 配对顶层 call/result，并组装 Code Dispatch 子树。
5. `RunningToolCall` 与 `ToolResultNode` 保存 raw facts、metadata 与既有 parent identity。
6. `ToolCallTree` 按 wire tool name 分发 `tool.call.toolview`。
7. `ui-tool` 在 render site 从 block 派生 card component props。

### 生产消费者审计

| 对象 | 生产者 | 生产消费者 | 决定 |
|---|---|---|---|
| `presentCall`／`presentResult` | 各 Host 工具 | 可能存在的非 Client caller | 保留在 Session Remote 之外 |
| `SessionEventEntry.view` | 无 | 无 | wire 不存在 |
| `callView`／`resultView` | 无 | 无 | Client model 不存在 |
| `presentationMeta` | Tools runtime | `tool/result`、Client card model 与 Host presenter | 保留的持久输入 |
| fixture presenter mirror | 无 | 无 | fixture 下发 raw metadata |

ACP 不消费 Session tool view，也不映射 Host render intent。仓库没有生产 TUI consumer；Host presenter 保留，但 Session Remote 不作为其 transport。

## 数据流

```text
Tool execute
  -> canonical value
  -> output.render(args, value)
  -> model-visible result content
  -> output.presentationMeta(args, value), when declared
  -> durable tool/result event

Session page/follow
  -> raw Session event envelope
  -> no tool lookup
  -> no preset lookup for presentation
  -> no call backscan
  -> no render-intent serialization

Client SessionEventSource
  -> Conversation Tool Definition
  -> root call/result pairing + Code Dispatch topology
  -> ToolCallBlock(name, argsRaw, content, error, meta)
  -> tool.call.toolview keyed dispatch
  -> Client card model
  -> existing React component
```

这条链路保留一次持久 metadata 投影，因为它发生在 canonical result 尚在内存时；删除的是读取历史时的第二次展示投影。

### 分层责任

| 层 | 负责 | 不负责 |
|---|---|---|
| Tools runtime | 执行、canonical value、模型文本、可重放 metadata | Web 卡片选择和组件 props |
| Session log | 持久事实、顺序、回放 | 临时 card DTO |
| Session Controller | 地址、权限、冷读、分页、follow、projection baseline | tool lookup、presenter、展示 scope |
| Client Session | Remote journal 生命周期与连续窗口 | 工具含义、卡片类型 |
| Conversation Tool Definition | call/result 配对、lifecycle、root/subcall topology | 工具名到组件的解释 |
| `ui-tool` | card model、通用 fallback、Chat/Details 展示 | Session 分页与 Host registry |
| 业务 Client 插件 | 自有 tool name 的 keyed renderer | root/subcall 编排与全局 registry |
| `ui-deliverables` | 当前第一方 mutation 的 produced path | UI card 或 Host render intent |

## Remote 与持久数据约定

### `SessionEventEntry`

`SessionEventEntry` 保留为 journal entry envelope，只含 `event: SessionWireEvent`。本次不顺带把 page entries 改成裸事件，也不重构 `RemoteJournalStream` 的通用 entry 约定。

`SessionPage.events` 仍是 `SessionEventEntry[]`。

`SessionFollowFrame` 仍是 opening frame 或带 `event` 的 event frame。

删除 `SessionToolCallView`、`SessionToolView` 和 `SessionEventEntry.view`。

Client connection 不再从 `dsh-tools/presentation` 转出 `ToolCallView`／`ToolResultView` 供 Session 消费。

生成 catalog 与 graph 从各自 source owner 派生已收窄的 Remote 类型和 package dependency。

### 持久日志

- `tool/call.data.name` 保持原样。
- `tool/call.data.arguments` 保持模型产生的原始 JSON 字符串。
- `tool/result.data.message.content` 保持模型可见结果。
- `tool/result.data.error` 保持结构化失败身份。
- `tool/result.data.meta` 保持工具私有 JSON 值。
- Client card model 不写入 Session log。
- renderer key 与 Host tool implementation id 不写入 Session log。
- 现有持久 Session 无需迁移，`SESSION_FORMAT_VERSION` 不变。

### `presentationMeta`

`presentationMeta` 不是 Host tool view。它在工具执行完成时读取 canonical value，而该 value 不会持久化；删除它会使下列现有展示无法无损恢复：

- read 的 path、offset、lines、totalLines 与 lang；
- write/edit 的 applied contextual hunks；
- grep/glob 的分组结果、截断标志与总数；
- web_search 的来源字段与 provider answer；
- web_fetch 的最终 URL、HTTP status 与有效截断标志。

Client 对 `meta` 做局部运行时收窄。是否把 `presentationMeta` 改名为更中性的 result metadata 不属于本决定。

## Host 端设计

`SessionHistoryController.page()` 在取得 source events 后只执行分页与现有 projection baseline 计算。attached Session 使用 projection registry snapshot；detached Session 使用该 registry 对 inspected log 的 restore 路径。history 不通过挂载 preset 改变已注册的 projection 集合。

`SessionHistoryController.follow()` 保留 listener-first、opening cursor、gap-free replay、live buffering、取消和 teardown；它不为工具事件维护额外状态。

Controller 不存在 `presenterScopeFor()`、`viewFor()`、`backscanArgs()`、`parseToolCall()` 或 `jsonView()` 路径。page state 不含 presenter scope 或参数 resolver；follow state 不含 `openCalls`、`fallbackEvents` 或 presentation 参数 resolver。每个 page/follow event 只包装成 `{event}`，地址、ownership、cursor、seq 与 projection 逻辑保持完整。

不可变 event 转换 helper 可以保持窄实现或内联；只要 history 不执行 presentation 工作，其名称没有语义。

Session Controller dependency 只在其他 package responsibility 需要时保留；manifest 与 project reference 不含 presentation-only dependency。

### 性能约束

- `page()` 的工具相关工作为零。
- 页面增加 tool result 不增加对既有页面事件的重复扫描。
- `follow()` 不维护展示索引。
- history 不触发 Cordis `tools` service proxy。
- history 不等待 presenter standing scope。
- history 不执行工具参数 JSON parse。
- history 不执行 tool view JSON clone。
- Remote payload 不重复携带 `meta` 已表达的结构化数据。
- Client 不扫描完整 Session event window 生成单个卡片。
- Client 只在对应 immutable Tool block 变化时重新派生 card model。

## Client Session 与 Conversation

Client Session 不含与 raw event window 平行的私有 `views` 数组。`installWindow()`、`prependWindow()` 和 `appendLive()` 只处理 event entries、cursor/hasMore、queue、projection 与通知。

`ConversationEventInput` 只携带 `event`。Conversation assembler 不认识 `SessionToolView`，其 replace/prepend/append、Context identity、Location 与 publication cadence 不变。

Chat 和 Trajectory 的 Tool Definition 都不读取 view，而从事件生成以下数据：

- callId；
- tool name；
- raw arguments；
- turn、step、seq 与 time；
- result content；
- isError 与 structured error；
- result metadata；
- root/subcall parent-child topology；
- interruption synthetic result。

`RunningToolCall` 不含 `callView`。

`ToolResultNode` 不含 `callView` 与 `resultView`。

`ToolCallBlock` 不新增通用 `view`、`card`、`kind` 或 `locations` 字段替代被删除字段。具体展示仍只属于 `ui-tool` 与 keyed renderer。

### Root 与 Code Dispatch 子调用

Host presenter API 描述顶层 call/result。本决定覆盖的 diff、read、search 和 web model 对 Code Dispatch 子调用保留 Generic/flattened 展示；受支持的 terminal 调用使用与根调用相同的适用规则。

Code Dispatch start 与 result event 已经携带 `parentCallId`。Conversation 在每个 child `ToolCallBlock` 上保留这项现有事实，root Session call 则不携带它。diff、read、search 和 web model 只接受没有 `parentCallId` 的 block；terminal model 与原本有意支持嵌套调用的 renderer 接受 child block。

Details panel 原样委托选中的 block。共享 card model 在行与 Details 中应用相同的 terminal 适用规则和非 terminal 子调用限制，因此 Details slot 不需要 placement 字段。

keyed slot 仍按每个子调用的真实 tool name 分发；`parentCallId` 只限制本决定覆盖的 diff/read/search/web 结构化模型。Skill、Cordis 等已经直接读取 raw block 的专用 renderer 保持现状。

### 缺失调用头

结果节点在当前窗口没有配对 call 时，`ToolResultNode.call` 保持 `null`。Client 不扫描窗口、不发额外 RPC，也不根据 result 文本猜测工具名称。

需要名称或参数的专用派生在 `call === null` 时走当前 Generic fallback。只依赖 result metadata 的模型也不借机增强，因为当前 Host `presentResult` 必须先取得配对调用。

older page 后续补入调用头时，Conversation Context 按既有 replay 规则重建，届时才允许生成当前已有的专用卡片。

### 参数与 metadata 收窄

Client 从 `argsRaw` 解析 JSON，解析失败返回 Generic，不抛出 React render 错误。

Chat 与 Details 通过纯 helper 复用同一 block 的解析。未来缓存必须使用 immutable block identity，不能按 callId 建立跨 Session 全局状态。

每个专用模型只检查它需要的字段。Client 不复制完整 Host tool schema，也不调用 Host `defineTool` validator。

合法第一方事件必须与当前 presenter 输出等价。畸形、旧版本或手工修改日志只承诺不崩溃并使用 Generic fallback。

## Client card-model 设计

现有 `ui-tool/src/client/tool/models/` 继续是 Chat 与 Details 共享派生的唯一位置。helper 直接返回组件 props，不返回 `ToolCallView`／`ToolResultView`，也不创建同构的 `ClientToolView` union。

工具名称分支只存在于 `ui-tool` card model、现有 row 分类表，或拥有该工具 keyed renderer 的 Client 插件；不得进入 Session Controller、Client Session、Conversation assembler 或通用 Slot renderer。

未知工具继续由 `GenericToolCard` 显示 name、原始 args、结果 content 与错误。

### 通用工具行

`toolRowModel()` 直接从 `toolName`、`argsRaw`、result content、error、cwd 与 home 派生通用行，并保持以下行为：

- `search`、`read`、`bash`、`write`、`edit`、`code` 与 `others` 分类；
- 现有标题与工具专用标题；
- summary 字段优先级和单行截断；
- 多 query 的逗号拼接；
- cwd 相对化与 home 缩写；
- file path 点击；
- args pretty JSON 与非 JSON 原文 fallback；
- result content flatten 与 structured error fallback；
- running、ok、error 与 stopped 状态。

Generic Host `presentCall` 的 title、kind、rawInput、content 与 locations 当前并不驱动普通 Web 行；Generic `presentResult.content` 也不驱动 Web 输出，因此无需把这些未消费值复制到 Client。

### Terminal 卡片

Client terminal model 从工具名称、调用参数、结果 content、error 与 Session cwd 派生现有 `TerminalBlock` props，不依赖 `parentCallId`。

| 输入 | 保持的结果 |
|---|---|
| 标准 `bash`／`pwsh` 前台 running | terminal prompt、description、cwd、running 状态 |
| 标准前台 success | terminal output、exit code/signal、成功或失败状态点 |
| `run_in_background:true` | Generic 行与原始结果 |
| 工具执行 error | Generic IN／OUT 与错误摘要 |
| persistent `bash`／`pwsh` running | terminal prompt |
| persistent `bash`／`pwsh` settled | Generic flattened result，不新增 exit card |
| `terminal_send` 前台 | terminal prompt 与 output |
| `terminal_send` background/error | Generic 结果 |
| Code Dispatch child | 与根调用相同的 terminal 适用规则与 fallback 规则 |

标准 shell 结果解析末尾 `[exit code: N]` 与 `[killed by signal: X]`。末尾已识别的 spill 策略提示会改用 Generic 输出：在 shell 行中可展开，在 Details 中显示原文，因为退出标记可能被移位或省略。已解析的 marker 从 terminal 正文移除；timeout、sandbox denial 与没有 pill 的 marker 留在正文。

调用 `description` 继续显示在 card 上方并覆盖折叠摘要。workdir 继续按绝对、相对和缺失三种情况处理；相对路径基于 Session cwd，且保留 `.`、`..`、盘符与 UNC root 的归一化。

对于 `terminal_send`，非空 input 与 session id 保持为逐字工具数据；空 input fallback 与 session label 通过 render site 的 conversation locale 解析。

同名普通与 persistent provider 是特殊兼容点。Client 使用当前有效参数与结果特征保留已交付差异；不足以无歧义识别的输入选择 Generic settled 结果，不增加新表现。

TerminalBlock 的 ANSI、光标重放、宽字符、行数上限、展开、复制与辅助技术文本完全不变。

### Diff 卡片

| 输入 | 保持的结果 |
|---|---|
| running `write` | 从 `file_path` 与 `content` 生成 intended added-only diff |
| running `edit` | 从 `file_path`、`old_string`、`new_string` 生成 intended replacement diff |
| running `str_replace_editor create` | 从 `path` 与 `file_text` 生成 intended added-only diff |
| running `str_replace_editor str_replace` | 从 `path`、`old_str` 与 `new_str` 生成 intended replacement diff |
| settled `write`／`edit` success | 从 `meta.diffs` 生成 applied contextual hunks |
| settled `str_replace_editor` | Generic，因为该工具没有 result presenter |
| write create 或 applied metadata 缺失、畸形、为空 | 当前 args fallback |
| error、畸形 args、edit 的 metadata 畸形、Code Dispatch child | Generic |

路径、`oldText:null`、`newText`、结果覆盖调用时 diff、Chat 8 行上限、Details 全高显示和文件打开行为不变。

### Read 卡片

running `read` 继续只有摘要行。成功 settled `read` 从 result meta 读取 path、offset、lines、totalLines 与 lang，并确认结果是单个文本块且符合 read envelope。

meta 缺失、字段畸形、result envelope 不匹配、error、缺失 call head 或 Code Dispatch child 都走 Generic。路径 label 的 cwd 相对化、home 缩写、语法语言、总行数、Chat 8 行上限与 Details 全高显示不变。

Client 不需要构造 Host `ReadResultView.content`；Generic fallback 始终可直接读取原始 result content。

### Search 卡片

running `grep`／`glob` 继续只有参数摘要。成功结果分别从 `meta.shape:'matches'` 与 `meta.shape:'paths'` 生成 grouped matches 或 path list。

Client 校验 path、lineNumber、line、truncated 与 total。空 matches/paths 是有效卡片；缺失/畸形 meta、未知 shape、error、缺失 call head 与 Code Dispatch child 走 Generic。

`truncated:true` 时继续从原始 result content 显示 recovery locator；未截断时不显示。Chat 8 行上限、Details 全高显示和展开行为不变。

### Web 卡片

running `web_search`／`web_fetch` 继续只有摘要行。成功 search 从 `meta.sources`、`meta.answer`、`meta.truncated` 生成卡片；成功 fetch 从 `meta.url`、`meta.statusCode`、`meta.truncated` 生成卡片。

Client 校验每个 source 的 url、title、snippet 与 publishedAt，并继续只把 http/https URL 渲染为链接。meta 缺失或畸形、error、缺失 call head 与 Code Dispatch child 走 Generic。

search 的 answer、来源顺序、label fallback 与截断提示不变；fetch 的最终 URL、状态、截断提示与 Details 下方原始正文不变。

### 已直接使用 raw block 的 renderer

- Todo row 继续从 args 计算 completed/active 摘要。
- Question row 继续从 result content 与 error 计算等待、回答、取消和中止状态。
- Skill row 继续从 args/result 计算名称与状态。
- Cordis define/run/action rows 继续从 args/result 与各自 Client service 计算。
- 这些 renderer 的 props、slot key、注册顺序与可见结果不变。

## Deliverables

`ui-deliverables` 独立于展示意图派生 mutation 业务事实，因此 produced-file 行为不与卡片截图耦合。

Deliverables Definition 按 callId 观察 root `tool/call` 与成功 `tool/result`，保存最小的 Client-owned mutation candidate，不扫描 Session window，也不依赖 UI renderer。

| 工具 | mutation 判定 | path 来源 |
|---|---|---|
| `write` | 任意成功调用 | `file_path` |
| `edit` | 任意成功调用 | `file_path` |
| `str_replace_editor` | `create`、`str_replace`、`insert` | `path` |
| `str_replace_editor` | `view` | 不产生 path |
| 其他 | 无当前第一方 mutation 语义 | 不产生 path |

失败、interrupted、orphan result、缺失 path 与畸形 args 不产生 deliverable。同一路径保持 first-seen 去重，closing Assistant seq 之后落定的结果继续排除。

本次不新增通用“工具副作用”注册表。Host-only 第三方 presenter 通过 `kind:'edit'`／`locations` 自动加入 Deliverables 的能力被有意移除；未来若有真实第三方 mutation 需求，应由 Client 业务贡献表达，不能恢复 Session view。

## Fixture 与测试数据

Client fixture 删除手写 `presentCall()`、`presentResult()`、`viewFor()` 与 fixture tool-view 类型。它继续产生与真实日志相同的 raw call、result content 和 result meta。

| Fixture | 必须保留的原始事实 |
|---|---|
| terminal | 参数与真实结果 status marker |
| diff | 参数与 result `meta.diffs` |
| read | result meta 的 path/offset/lines/totalLines/lang |
| grep/glob | result meta 的 shape/files 或 paths/truncated/total |
| web | result meta 的 sources/answer 或 url/statusCode/truncated |
| generic/custom | name、argsRaw、content、error |

fixture 不导入 Host 工具包来计算页面展示，也不保留 presenter 镜像。同一 raw fixture 继续驱动 jsdom、built Web snapshot 与 `?fixture` 浏览器路径。

## 展示等价矩阵

“当前展示”由已提交的组件测试、组装测试与 Web browser expected 共同定义。transport 或 ownership 重构不能作为 refresh snapshot 的理由；获批产品变化需要独立证据。

| 场景 | 必须保持的展示 |
|---|---|
| 未知工具 running | Generic 行，工具名与 args 摘要 |
| 未知工具 settled | Generic 行与原始 output |
| malformed args | 安全 Generic fallback |
| orphan result | callId 标题与 Generic output |
| interrupted call | warning/stopped 状态 |
| bash/pwsh 前台 | 当前 terminal prompt、正文、cwd 与状态 |
| bash/pwsh background/error | 当前 Generic IN／OUT |
| persistent shell | 当前 running terminal、settled Generic |
| terminal_send | 当前前台 terminal、后台/error Generic |
| write/edit | 当前 intended/applied diff 与 error fallback |
| read | 当前 running 摘要、settled ReadBlock 与 error fallback |
| grep/glob | 当前 grouped/path card、截断与 recovery |
| web_search/web_fetch | 当前来源/摘要 card 与原始正文 |
| Todo/Question/Skill/Cordis | 当前专用行 |
| Code Dispatch subcall | 满足条件时显示 terminal 卡片；diff/read/search/web 保持 Generic/flattened |
| Chat 与 Details | 同一调用使用相同 card fields |
| Trajectory | 当前 identity、树、选择和 details |
| Deliverables | 当前成功 mutation chips 与链接 |

## Client 扩展约定

`tool.call.toolview` 继续是唯一工具 UI 注册机制。一个工具若要在 Client 获得专用表现，必须由 Client 插件注册自己的 wire tool name。

注册方接收 raw `ToolCallBlock`、Session path 信息和宿主动作，自行校验它认识的 args/meta 字段。注册方不调用 Host tool registry，不依赖 `presentCall`／`presentResult`，也不能要求 `SessionEventEntry.view`。

没有 Client renderer 的工具稳定降级为 Generic。同一 tool name 只能有一个生效 keyed registration，重复 key 继续 loud failure。

Session-scoped slot 可以表达 Client 侧会话差异，但不从 preset 推断 renderer 变体。Host-only presenter 不自动赋予 Web rich card，这是“Host 描述展示”与“Client 插件拥有展示”的明确边界。

## 失败与 fallback

- Client 把 args 与 meta 当作 wire JSON，在消费点收窄。
- 参数 JSON 解析失败走 Generic。
- 已知工具缺少必要字段走 Generic。
- metadata 缺失或畸形走 Generic；成功 `write` 例外，它按当前 presenter 行为保留由参数派生的整文件 diff。
- error result 不因 metadata 存在而显示成功卡片。
- 缺失 call head 不猜测工具名称或参数。
- 未知 metadata 字段被忽略。
- 新 metadata variant 在旧 Client 中走 Generic。
- card-model helper 捕获可预期解析失败，不依赖 React error boundary 完成普通 fallback。
- keyed renderer 自身的意外异常仍由现有 Slot error isolation 处理。

## 同名 Host provider

Host registry 允许不同 scope 为同一 tool name 提供不同定义；Session view 通过 presenter scope 理论上可以按 preset 选择不同 render intent。删除 view 后，Client keyed slot 只观察 wire name，不能观察 Host definition identity。

当前第一方显著实例是普通与 persistent `bash`／`pwsh`。Client 派生使用有效参数与结果特征保持它们的已交付差异，不增加 provider-id wire 字段；无法判别的畸形或自定义同名 provider 输入采用 Generic。

本次不承诺保留第三方同名 provider 仅通过 Host presenter 表达的差异。若未来产品确需同名 provider 的不同 Client 展示，必须定义稳定、非展示性的 Client identity；不得恢复按页 Host view 计算。

## 已交付范围

### Session Controller

- `SessionEventEntry` 只包含 raw event。
- 两个 Session tool-view 类型都不存在。
- history 不含 presentation import、helper 或 page/follow presentation state。
- 地址、分页、follow 与 projection 逻辑仍由 Session owner 负责。
- Host 测试固定 raw journal 约定。

### Session Controller Client

- `Session.views` 不存在。
- EventSource replace/prepend/append delta 保持不变。
- transport、fixture 与 test-support 类型携带 raw entry。
- event identity 与引用稳定性保持不变。

### UI Conversation、Chat 与 Trajectory

- Conversation input 与 Tool block 不含 view 字段。
- Chat/Trajectory Tool Definition 读取 raw event。
- event pairing、Context replay、树与 target snapshot 保持不变。
- child Tool block 保留现有 Code Dispatch `parentCallId`；row 与 Details slot owner props 都不增加独立 placement 字段。

### UI Tool 与 Deliverables

- card model 从 raw block/meta 派生。
- Chat 与 Details 复用相同 helper。
- Generic fallback 与 keyed dispatch 保持不变。
- Deliverables 识别第一方 mutation args。

### Fixture、文档与生成物

- fixture 只发 raw event/meta。
- Session Controller 与 Client README/JSDoc 描述 raw journal 和 Client presentation owner。
- 工具 cookbook 记录 Web Client 接入路径。
- 本文是该决定的 owner；保留的 Host presenter Note 继续拥有各自决定。
- 手写 Remote 类型、dependency、README、pairing record 与 generated reference 保持同步。

## 验证矩阵

### Host

- page 返回连续 raw event entries。
- follow 返回 opening cursor 与连续 raw event entries。
- page/follow 在无 Tools service 时行为相同。
- cold page 不解析或挂载 preset。
- tail page 通过标准 projection registry 计算 baseline；provider 是否存在由 projection composition 决定，不引入 history 侧 setup 路径。
- 地址、ownership、message-aligned boundary 与 tail projection 不变。
- listener-before-read、reconnect catch-up 与 gap repair 不变。
- 大量 tool results 不触发每结果回扫。
- wire 结果不含 view。

`session-history-journal.host.spec.ts` 负责分页、连续性和 history error 行为，不含 presenter 断言。

### Client Conversation

- replace、prepend 与 append 接受无 view entry。
- Chat 与 Trajectory root call/result 配对不变。
- Code Dispatch 树不变。
- result-only fallback 不变。
- interruption synthetic result 不复制 view。
- registry rebuild、older prepend 与 live append 的 Node identity 不变。

### Client card model

- terminal 用 raw args/content 得到已固定的 props。
- diff 用 args/meta 得到已固定的 diffs。
- read 用 meta/content 得到已固定的 lines。
- search 用 meta/content 得到已固定的 grouped/path card 与 recovery。
- web 用 meta/content 得到已固定的 sources/fetch summary。
- unknown、malformed、error、missing-call 与 missing-meta 继续 Generic。
- `parentCallId` 缺失与存在的用例证明 terminal 适用规则一致，并保留 diff、read、search 和 web descendant 的 Generic fallback。
- Chat 与 Details 对同一 block 得到相同 card fields。

### Deliverables

- write/edit 成功产生 `file_path`。
- str_replace_editor create/str_replace/insert 产生 `path`。
- str_replace_editor view 不产生 path。
- failure、interrupted、malformed 与 orphan 不产生 path。
- first-seen 去重与 closing seq cut 不变。

### 组装与浏览器

- terminal、diff、read、search、web browser expected 不刷新并全部通过。
- tool tree、details、trajectory 与 deliverables 的可见断言不改预期。
- built Client 通过真实 Remote page/follow 取得 raw events 后仍显示同样卡片。
- fixture 与真实 Host 使用同一 Client derivation。
- minimal preset 单独固定 persistent shell 行为。

### 静态与文档

- 生产代码不存在 `SessionToolView`／`SessionToolCallView`。
- Session history 不引用 `dsh-tools/presentation`、`ctx.tools`、`presenterScopeFor` 或 `backscanArgs`。
- Client Conversation 不引用 `ToolCallView`／`ToolResultView`。
- Client model 不读取 `callView`／`resultView`。
- fixture 不定义 presenter mirror。
- Host `presentCall`／`presentResult` 与 `presentationMeta` 仍存在。
- 没有新增 Client registry 或 Host→Client presentation hint。
- 受影响的手写类型、README、Agent Note、catalog 与 graph 保持同步。

## 验证命令

修改本决定时使用 `dsh-pre-push-checks` 按最终 diff 选择命令；所需证据包括：

- Session Controller history/transport 聚焦测试；
- ui-chat 与 ui-trajectory Tool Definition 测试；
- ui-tool terminal、diff、read、search、web、row、tree 与 details 测试；
- ui-deliverables produced-files 测试；
- connection fixture 与 Client runtime 测试；
- 受影响 Host/Client TypeScript face；
- lint 与 duplication；
- 受影响源文件 per-file 100% coverage；
- `DSH_SNAPSHOT=replay pnpm run test:web`，不得 refresh 现有展示 golden；
- 手写 Remote 类型与 TypeScript 检查；
- `pnpm run doc-sync`；
- `git diff --check`。

## 已交付不变量

- Session page/follow 不读取 Tools registry 或 presenter scope。
- Session history 不存在 callId backscan、presentation cache 或 view clone。
- Remote Session entry 不携带 view。
- Session 日志与 `SESSION_FORMAT_VERSION` 不变。
- result meta 逐字节通过日志与 Remote 到达 Client。
- Conversation 只从 raw event 组装 ToolCallBlock。
- ToolCallBlock 不含 Host render-intent 字段。
- 五类结构化 card model 只读 raw block 与 Session path facts；只有 diff、read、search 和 web 使用 `parentCallId` 拒绝子调用。
- Generic、Todo、Question、Skill 与 Cordis 行行为不变。
- Deliverables 不依赖 render intent 且保持当前 paths。
- 所有第一方顶层工具的文本、组件、展开内容、状态、链接与排序不变。
- malformed、missing-meta、error、orphan 与 unknown-tool 继续安全 fallback。
- Code Dispatch 的 diff、read、search 和 web 子调用保持 Generic/flattened；terminal 子调用遵循根调用适用规则。
- Chat、Details 与 Trajectory 行为不变。
- 现有 Web browser expected 无需刷新即可通过。
- Host presenter API、实现与直接测试不变。
- ACP 输出不变。
- 没有新下行展示字段或第二套 Client registry。
- 分页成本不再随 result 数量乘以页面事件数增长。
- 下行 payload 不再重复 result meta 的 card DTO。

## Alternatives considered

### 只优化 `backscanArgs`，保留 view

page 前建立一次 `callId → {name,args}` Map 可以把回扫降为线性，live 已有 `openCalls` 快路径；但 Host lookup、preset scope、presenter、JSON clone、重复 payload 和双重所有权仍存在，因此拒绝。

### 在 Client 建 presenter registry

把 `presentCall`／`presentResult` 接口复制到浏览器会与 `tool.call.toolview` slot 重复注册、生命周期、fallback 和覆盖语义；renderer 仍需把 presenter DTO 转成组件 props，因此拒绝。

### 让 Conversation Tool Definition 生成统一 view

这会把工具名称和 UI card 语义放进 target-neutral Conversation owner，并重建与 Host view 同构的中间 DTO，因此拒绝。

### 删除 `presentationMeta`

read 行结构、applied diff、search 分组、web sources 和有效 truncation 无法从模型文本无损恢复；解析自由文本也会把 UI 绑到输出措辞，因此拒绝。

### 持久化 canonical tool result

这会扩大 Session log、暴露内部结果结构、改变持久格式，并可能保存远超展示所需的大对象；已有 metadata 足够，因此拒绝。

### 删除 Host presenter API

一并删除可以继续收缩代码，但本决定保留 Host `presentCall`／`presentResult`；其 API、实现、测试与类型独立于 Session Remote。

### Client 导入 Host 工具实现

工具包包含 Node、filesystem、subprocess 或 provider 依赖，不能进入浏览器 bundle；Client 只消费 raw JSON，并在自己的 renderer 内维护窄解析，因此拒绝。

### 按结果向 Host 查询 presentation

按需 RPC 会把一页读取变成 N 次网络调用，仍需 Host lookup、scope、callId 查找与错误协调，因此拒绝。

### 允许展示增强

将更丰富的 Code Dispatch 卡片、缺失 call head 的推断或其他历史展示增强与所有权变更捆绑，会使快照无法证明对等。本决定拒绝这种捆绑；[嵌套 terminal 卡片例外](../bug-fix/2026-09-05-nested-terminal-cards.zh.md)不放宽非 terminal 子调用限制。

### 接受临时 Generic 退化

先停发 view 再逐步补 Client card 会让 terminal、diff、read、search、web 与 Deliverables 在中间版本退化。Client 对等实现与 Host 删除必须在同一可发布变更中完成。

## Consequences

本决定从 Session 读取中删除 presentation 工作、重复扫描和重复 view payload；代价是保留的 Host presenter 与 Client card derivation 可以独立演进，因此两侧都需要 owner 专属测试，Web 展示对等仍是明确产品约束。

### Client 与 Host 逻辑漂移

同一工具可以有一份 Host render intent 和一份 Client card derivation。两者面向不同消费方，不共享运行路径；不刷新的 browser expected 固定第一方 Web 视觉对等，Host presenter 测试只约束 Host API。

### 同名 provider 无稳定 identity

raw event 只记录 tool name，不记录具体 ToolDefinition。Client 使用有效事件字段保留普通与 persistent shell 的差异；无法判别的自定义或畸形输入回退 Generic，wire 不为理论扩展性增加 hint。

### Metadata 是未知 JSON

旧 Session 可能缺字段，手工修改日志可能带畸形值。每个 Client model 必须局部收窄，不能把未知数组或对象直接传给 UI primitive。

### preset-owned projection 可用性

history 不为当前组合中缺失的 projection unit 补偿。需要在冷读中保持可见的 preset-owned unit，必须由共享的 Session preparation/projection 组合在 restore 前提供其定义；history 不得重新增加 preset mount 或 presenter setup 分支。

### 双 target 同步

Chat 与 Trajectory 各有独立 Tool Definition，两者都携带 raw fields；card derivation 只能留在 `ui-tool`，不能复制进两个 Definition。

### Deliverables 隐性依赖

Deliverables 不是视觉组件，因此 mutation parser 必须与受支持的第一方写工具保持同步；专用测试独立于卡片截图固定 file chips 与 Markdown links。

### Fixture 假绿

fixture 下发 raw event/meta，不下发手写 view。真实 Host 组装覆盖仍然必要，因为 fixture-only snapshot 不能证明 transport 路径。

### 错误刷新快照

本次承诺用户可见输出不变。出现 snapshot diff 时必须修 Client 派生；除非 owner 单独批准具体视觉变化，否则不得 refresh expected。

### 文档漂移

raw journal 或 Client presentation owner 变化时，Agent Note、package README、cookbook、根规则与 generated reference 必须一起更新；Host API 文档保持独立。

### Remote 协议收缩

optional `view` 的缺失是所有 consumer 共同遵守的预发布 wire 类型决定；没有兼容 shim、双写或版本协商。

## 与现有决策的关系

[嵌套 terminal 卡片](../bug-fix/2026-09-05-nested-terminal-cards.zh.md)仅部分取代 terminal 子调用卡片禁令及其展示对等要求。本文继续负责原始 journal 所有权、Client 派生以及 diff/read/search/web 子调用限制。

本文部分取代 [Client 工具展示所有权](../../archived/architecture/2026-08-08-client-tool-presentation-ownership.md) 中“card model 接收 Host view”的实现事实；`ui-tool` 拥有展示、业务插件使用 keyed slot、Conversation 只拥有生命周期与拓扑的核心决定保持不变。

本文保留 [toolview 溶解](../../archived/architecture/2026-07-23-toolview-dissolution.md) 的决定：Client 仍只有 slot 注册模型，不恢复 `ToolViewRegistry`。

本文收窄 [render-intent union](2026-07-02-tool-render-intent-union.zh.md) 的消费范围：Host API 与类型保留，Session Remote 与 Web Client 不消费它。本文独自规定 transport 拆分，不改写该 presenter 决策。

本文更新 [Session 历史与 Remote 事件传输](2026-08-18-session-history-and-event-transport.zh.md) 的 entry 约定：journal 只运输原始 event 与独立 projection baseline，不承载临时 tool view。

本文遵循 [Conversation Node 组装](2026-08-09-client-conversation-node-assembly.zh.md)：Tool Definition 负责事件配对与调用树，具体 card model 留在 `ui-tool`。

本文保留 [规范工具输出约定](2026-07-20-canonical-tool-output-contract.zh.md) 的 result metadata，因为它是无损、可重放 Client 派生的输入。

## Deferred

- Host presenter 若长期没有生产消费者，可由另一项明确决策评估删除；本决定不预判。
- Code Dispatch 子调用的 diff、read、search 和 web 专用卡片仍需独立设计并更新可见快照；terminal 调用由链接的部分取代决策负责。
- 第三方 mutation tool 若要加入 Deliverables，需新增 Client-owned 贡献；本决定不为尚无消费者的扩展性建 registry。
- 同名 provider 若要不同 Client 展示，需先定义稳定、非展示性的 identity；不得恢复按页 Host view。
- Client card model 若需量化性能，可以增加 immutable-block 微基准；已交付架构禁止扫描 Session window。
