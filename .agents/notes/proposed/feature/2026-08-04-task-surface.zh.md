# Agent Note: 用于结构化会话交互的 Task Surface

Status: proposed

[English](2026-08-04-task-surface.md) | 中文

## 问题

有些任务很难通过交替发送文本消息来完成。比较多个选项、调整计划顺序、审阅表格，或填写一小组关联字段，都更适合在一次结构化交互中处理。agent（智能体）可以描述这类交互，但若不增加永久的产品组件或生成可执行的客户端插件代码，就无法要求 Web 客户端渲染这类交互。

这两种变通方案的职责归属都不合理。产品专用组件要求每种任务形态都新增触发方式并发布新版本。对于只需一个轮次的表单，生成代码所拥有的权限和生命周期成本都远超实际需要。这样做还会把展示界面而非用户结论变成持久产物。

目前缺少这样一份约定：用有界、可回放的描述来定义临时 UI，并让它只属于一个会话和一次工具调用实例。产品应当负责校验、放置、交互机制和提交；agent 应当负责特定任务的文案、数据，以及从受支持组件中作出选择。

## 提案

新增 **Task Surface**：一种由普通 Web 客户端插件渲染、带版本的声明式模型。面向模型提供一个稳定工具 `show_task_surface`，用于发布该模型。调用成功后，当前轮次结束。用户编辑并提交渲染出的面板；Host 将提交内容记录为一条普通的可见用户消息，并开始下一轮。

同时满足以下条件时，Task Surface 是默认的结构化 UI 路径：

- 交互属于当前会话和当前任务；
- 行为可以由已声明的组件集合表达；
- 不需要后台执行或新增运行时权限；
- 有价值的持久结果是用户提交的结论，而不是面板本身。

这里定义的是一个触发方式，不是一组产品启发式规则。agent 会显式调用 `show_task_surface`。用户可以通过普通语言要求 agent 使用 Task Surface。产品不会根据工具名称或任务主题打开专用面板；重复使用也不会自动把 Task Surface 转为插件。

简短的阻塞式问题仍由 [`ask_user_question`](../../archived/feature/2026-07-29-ask-question-web-presentation.md) 处理。纯文本说明仍留在聊天中。跨会话导航、后台行为、新服务或持久自定义 UI 则属于 Generated Client Plugin 工作流。

## 声明式模型

`TaskSurfaceModelV1` 使用 JSON。它包含内容块、输入字段和一个提交标签；不包含代码、回调、选择器、HTML、CSS、可执行产物的 URL，也不包含表达式语言。该类型与核心会话中现有的 `SurfaceManager`/`SurfaceOp` 消息归约类型无关；Task Surface 是一套产品交互协议。

```ts
interface TaskSurfaceModelV1 {
  version: 1
  title: string
  description?: string
  sections: TaskSurfaceSection[]
  fields?: TaskSurfaceField[]
  submit: { label: string }
}

interface TaskSurfaceSection {
  id: string
  title?: string
  layout?: TaskSurfaceLayout
  blocks: TaskSurfaceBlock[]
}

type TaskSurfaceLayout =
  | { kind: 'stack' }
  | { kind: 'grid'; columns: 2 | 3 }

type TaskSurfaceBlock =
  | { kind: 'markdown'; text: string }
  | { kind: 'metrics'; items: { label: string; value: string; detail?: string }[] }
  | { kind: 'table'; columns: { id: string; label: string }[]; rows: Record<string, string | number | boolean | null>[] }
  | { kind: 'diff'; path?: string; before: string | null; after: string; language?: string }
  | { kind: 'notice'; tone: 'neutral' | 'info' | 'warning'; text: string }

type TaskSurfaceField =
  | { kind: 'text'; id: string; label: string; multiline?: boolean; required?: boolean; initial?: string }
  | { kind: 'choice'; id: string; label: string; options: TaskSurfaceOption[]; initial?: string }
  | { kind: 'multi-choice'; id: string; label: string; options: TaskSurfaceOption[]; initial?: string[] }
  | { kind: 'toggle'; id: string; label: string; initial?: boolean }
  | { kind: 'order'; id: string; label: string; options: TaskSurfaceOption[]; initial?: string[] }

interface TaskSurfaceOption { id: string; label: string; detail?: string }
```

渲染器控制字体排印、间距、响应式布局、焦点顺序、键盘行为和主题 token。未指定布局时使用 `stack`；`grid` 布局自带列数，可用宽度无法容纳时会折叠。遇到未知版本或联合类型分支时，系统使用通用工具结果回退，而不是只解释其中一部分。

`markdown` 块复用 `MarkdownText`，并显式指定模型 URL 策略。`MarkdownText` 新增 `remoteImages: 'render' | 'alt-only'`，普通场景仍默认使用 `render`；Task Surface 始终传入 `alt-only`，因此图片语法只渲染替代文本。原始 HTML 和嵌入式媒体仍会被省略，不生成自动链接预览；未经用户显式操作，不会解引用模型提供的任何 URL。普通 HTTP(S) 链接仍可在用户选择后导航。语法高亮分片等固定应用资源继续遵循产品的常规加载策略。

版本 1 有意不支持条件字段、客户端数据获取、图表、文件上传和任意事件处理器。新增任何块或字段类型都属于协议变更，必须在同一变更中加入解析器、渲染器、无障碍行为、回退方式和回放 fixture（测试前置数据）。

Task Surface 服务通过受 schema 校验的配置定义限制。初始默认值为：规范化模型不超过 64 KiB、块不超过 64 个、字段不超过 32 个、表格行不超过 200 行、提交内容不超过 32 KiB。模型内的 ID 必须唯一；字段值必须符合其声明；未知字段会被拒绝。这些限制约束日志、DOM 和提示词成本，但不改变协议。

## 工具与呈现约定

`show_task_surface` 接收 `{ model: TaskSurfaceModelV1 }`。Host 解析并规范化完整模型；若该会话已有一个打开的 Task Surface，则拒绝调用；否则生成 `surfaceId`，并返回带规范化模型的规范值 `{ surfaceId, model }`。`presentationMeta` 持久化 `value.model`，使投影器和执行器不会对规范化结果产生分歧。Native 结果会指明该 Surface，并说明客户端无法渲染面板时，可以通过普通消息绕过它。随后工具调用 `exec.concludeTurn()`，防止 agent 越过所要求的人工检查点继续执行。

工具定义省略 `isConcurrencySafe`。根据现有工具注册表约定，省略该字段会将每次调用归类为独占排序屏障，无需新增 `ToolDefinition` 字段。该工具只会组装到同时挂载 Host 服务和 Web 渲染器的 Web profile 中。版本 1 支持 `native` 和 `both` 工具模式；仅支持 `ptc` 的 profile 不会向模型公布该工具，因为 PTC mode 分发属于嵌套调用，无法把呈现元数据传到外层结果。

浏览器安全的领域包从 `@deepseek-ai/dsh-brand` 以仅类型方式导入 `Branded` 原语，并拥有全部三个 Task Surface ID。根据[规范工具输出约定](../../implemented/architecture/2026-07-20-canonical-tool-output-contract.zh.md)，规范值仅存在于本次执行中。因此，回放通过 `output.presentationMeta(args, value)` 将以下带标签的载荷随 `tool/result.meta` 一并持久化：

```ts
import type { Branded } from '@deepseek-ai/dsh-brand'

type TaskSurfaceId = Branded<'TaskSurfaceId'>
type TaskSurfaceSubmissionId = Branded<'TaskSurfaceSubmissionId'>
type TaskSurfaceDismissalId = Branded<'TaskSurfaceDismissalId'>

interface TaskSurfacePresentationMeta {
  kind: 'dsh/task-surface'
  version: 1
  surfaceId: TaskSurfaceId
  model: TaskSurfaceModelV1
}
```

该工具保留通用 [render intent](../../implemented/architecture/2026-07-02-tool-render-intent-union.zh.md)。带 key 的 Web 行读取 `ToolResultNode` 上已经保留的带标签元数据，无需新增 render-intent 分支或呈现注册表。不支持 Task Surface 的客户端会渲染普通结果内容。

Web 插件按照 [toolview](../../archived/architecture/2026-07-23-toolview-dissolution.md) 和 [slot 注册](../../implemented/architecture/2026-07-22-slot-type-chain-implementation.zh.md)约定，提供两个静态的会话作用域注册项。一个以 `show_task_surface` 为 key 的 `conversation.chat.toolview` 条目将持久 transcript（文本记录）调用实例渲染为简洁摘要和只读回放。现有 `conversation.input.dock` 中的一个 `TaskSurfaceDock` 条目是唯一可操作的挂载点：它读取活动投影，针对确切身份调用 `getActive`，并拥有字段、草稿、提交和关闭操作。Dock 与 transcript 分页相互独立，因此即使 `ToolResultNode` 位于已加载历史窗口之外，活动 Surface 仍可操作。

Dock 遵循现有 composer chain 的回退语义。任何 `conversation.composer` 接管都会隐藏包括 `TaskSurfaceDock` 在内的回退 composer 栈，但不会将其卸载；接管结束后，同一个草稿所有者会重新出现。接管方不会获得 Task Surface 操作，也不会创建另一个编辑器。

模型不能选择会话标签页、Dock 顺序、详情栏、模态框、像素位置或 z-index。以后即使改变放置位置，也只是渲染器的决策，不会改变日志中记录的模型。transcript 行绝不会成为第二个编辑器，因此同一个 Surface 不会出现相互竞争的草稿或提交所有者。

## 提交约定

Task Surface 领域通过 Host 传输层公开三个操作。只有 `submit` 会接纳用户消息：

```ts ignore-check
type TaskSurfaceSubmissionPhase = 'queued' | 'claiming'

interface TaskSurfacePendingSubmission {
  submissionId: TaskSurfaceSubmissionId
  messageId: MessageId
  phase: TaskSurfaceSubmissionPhase
}

interface TaskSurfaceService {
  getActive(input: { sessionId: SessionId; surfaceId: TaskSurfaceId }): Promise<GetActiveTaskSurfaceResult>
  submit(input: SubmitTaskSurfaceRequest): Promise<SubmitTaskSurfaceResult>
  dismiss(input: DismissTaskSurfaceRequest): Promise<DismissTaskSurfaceResult>
}

interface SubmitTaskSurfaceRequest {
  sessionId: SessionId
  surfaceId: TaskSurfaceId
  submissionId: TaskSurfaceSubmissionId
  values: Record<string, JsonValue>
  note?: string
}

type SubmitTaskSurfaceResult =
  | { accepted: true; messageId: MessageId; phase: 'queued' }
  | { accepted: false; reason: 'not-open' | 'stale' | 'invalid-submission' | 'submission-pending' }

type GetActiveTaskSurfaceResult =
  | {
      active: true
      callId: ToolCallId
      surfaceId: TaskSurfaceId
      model: TaskSurfaceModelV1
      pending: TaskSurfacePendingSubmission | null
    }
  | { active: false; reason: 'not-open' }

interface DismissTaskSurfaceRequest {
  sessionId: SessionId
  surfaceId: TaskSurfaceId
  dismissalId: TaskSurfaceDismissalId
}

type DismissTaskSurfaceResult =
  | { dismissed: true; eventSeq: number }
  | { dismissed: false; reason: 'not-open' | 'stale' | 'submission-pending' }
```

Host 解析出 `show_task_surface` 的确切成功调用实例，依据其已持久化模型重新校验提交值，并通过普通会话队列接纳响应。该响应成为一条用户角色消息，并使用可合并扩展的消息来源：

```ts ignore-check
interface TaskSurfaceCorrelation {
  version: 1
  submissionId: TaskSurfaceSubmissionId
  callId: ToolCallId
  surfaceId: TaskSurfaceId
  values: Record<string, JsonValue>
}

interface TaskSurfaceUserMessageSource {
  kind: 'user'
  rpcId: RpcId
  taskSurface: TaskSurfaceCorrelation
}
```

`session/queue` 协议条目已经携带完整 `Message`。客户端投影会显式扩展以保留其来源，不再丢失关联信息：

```ts ignore-check
interface QueuedMessage {
  id: InboxItemId
  messageId: MessageId
  placement: 'queued' | 'steering'
  source: MessageSource
  content: readonly ContentBlock[]
  preview: string
  text: string | null
}
```

浏览器安全的领域包拥有 `TaskSurfaceId`、提交和关闭 ID、`TaskSurfaceCorrelation`，以及待处理提交的形态。ApiProxy 拥有传输扩展，负责将关联信息与 `rpcId` 组合。保留 `kind: 'user'` 可维持普通用户消息气泡和提示词语义，额外字段则提供持久关联信息。消息内容是由产品格式化的可读摘要，包括面板标题、标签和提交值，以及可选备注。模型接收相同的文本。结构化来源不是第二条隐藏指令。

产品外壳负责收起和关闭。收起属于本地视图状态，不会发送任何内容。没有待处理提交时，`taskSurface.dismiss({ sessionId, surfaceId, dismissalId })` 会追加一个 `task-surface/dismissed` 会话事件，但不启动轮次；该精确事件会关闭投影，并更新 Dock 和 transcript 行。重试会复用 `dismissalId` 并返回原始结果，不会再追加事件。提交处于 `queued` 或 `claiming` 阶段时，关闭操作会被禁用，Host 也会以 `submission-pending` 拒绝这类请求。

客户端边界上的提交具有事务性。接纳成功会返回处于 `queued` 阶段的确切 `messageId`；在 `queued` 和 `claiming` 两个阶段中，Dock 会禁用所有变更，并且只有匹配的用户消息持久化后，才会清除已持久化的草稿。若请求被拒绝，则保留值供用户继续编辑，并显示返回的原因。双击和传输重试会复用 `submissionId` 并返回第一次调用的结果；只要第一次提交仍在处理中，另一个提交 ID 就会收到 `submission-pending`。对于一个已接受的 Surface，Host 只会接纳一条用户消息。

Task Surface 服务将已接受提交的协调状态记录为 `pending.phase: 'queued'`，客户端则可通过仍在队列中的行所保留的 `source` 关联它。当 Agent 从队列取出该调用实例进行普通提示词接纳时，服务会先同步把同一份待处理记录改为 `claiming`，然后 ApiProxy 才发布不再包含已认领行的普通队列快照。服务会在异步接纳和重新连接期间一直保留这份进程内认领状态，直到匹配的持久 `user/message` 发布，或 Agent 报告终态丢弃。

匹配的 `user/message` 会关闭持久投影并清除认领状态。在持久化之前发生拒绝、取消或 dispose（资源释放）时，系统会报告丢弃、清除认领状态，并让 Surface 保持打开。Dock 绝不会把队列行消失解读为其中任一结果，而会重新读取 `getActive`：`pending.phase: 'claiming'` 会维持禁用状态，`pending: null` 会恢复草稿，`not-open` 会关闭 Dock。`getActive` 会把由日志推导的活动调用实例与这唯一一份进程内待处理记录合并。该记录属于协调状态，不是第二个持久权威来源；Host 重启后，未提交的认领状态不复存在，日志中仍然打开的 Surface 会恢复为可编辑状态。

对于带有 Task Surface 关联信息的行，`session.updateQueue` 会拒绝 `edit` 和 `steer`。编辑会让格式化内容与消息来源所携带的结构化值脱节，而 steering（中途引导）会持久化一条不符合提交生命周期的 `steering/message`。该行仍在队列中时允许 `remove`；它会报告丢弃并恢复为打开的 Surface。行被认领后即已离开通用队列，队列变更会返回 `queue-item-not-found`。Task Surface 服务会持有一份 single-flight 待处理记录，直至提交或丢弃。

## 生命周期与恢复

会话日志是真源。现有[会话投影系统](../architecture/2026-07-27-session-projection-and-command-log.zh.md)中的一个小型 `taskSurface` 单元会折叠成功调用的 Surface 结果元数据和后续用户消息来源，得到以下状态：

```ts ignore-check
interface TaskSurfaceProjection {
  active: { callId: ToolCallId; surfaceId: TaskSurfaceId } | null
}
```

一个会话最多只能有一个打开的 Task Surface。成功的结果会打开它；匹配的 Task Surface 用户消息或关闭事件会将其关闭。后续的普通用户消息也会将其关闭，这是一条显式的绕过路径；在以上任一事件关闭活动调用实例前，再次调用 `show_task_surface` 都会失败。回退和 fork 会通过折叠相应日志推导出活动调用实例；瞬态队列阶段不会被复制，也不会有独立的 Surface 数据库参与其中。

完整模型仍存放在对应的 `tool/result.meta` 中；投影只携带活动身份。`TaskSurfaceDock` 独立于历史行存在，并会响应该身份。`taskSurface.getActive({ sessionId, surfaceId })` 会从会话日志中读取确切调用实例，重新校验其元数据，合并 Task Surface 服务的待处理协调记录，并返回 `{ callId, surfaceId, model, pending }`。调用实例不存在或已经关闭时返回 `not-open`。因此，即使结果位于历史尾段之外，刷新和重新连接仍能恢复可操作的 Surface 及其同进程待处理阶段，而无需把模型复制到每一个投影基线中。

Web 插件将未提交值保存在一个有界、按会话持久化的 slot store 中，并以 `surfaceId` 为 key；这些值永远不会进入会话日志、提示词或长期记忆。已提交值存放在接纳的用户消息中，因此即使浏览器草稿丢失，也不会抹去结论。

## 包边界与依赖

该能力在职责变化处拆分为多个包：

| 包 | 职责 |
|---|---|
| `packages/core/agent` 和 `packages/core/agent-loop` | 为已认领的下一轮 inbox 条目提供通用终态结果，让 Host 观察方无需使用 Task Surface 专用类型，即可区分持久接纳和丢弃 |
| `packages/task-surface/task-surface` | 浏览器安全的模型、带品牌类型的 ID、关联和待处理类型、解析器、限制、提交校验器／格式化器、会话事件扩展、投影单元，以及 Host 服务约定 |
| `packages/task-surface/tool-task-surface` | `show_task_surface`、规范输出、呈现元数据、通用 render intent、活动 Surface 检查和 `concludeTurn()` 行为 |
| `packages/client/runtime` | 通用排队消息 `source` 投影和会话作用域的活动投影访问 |
| `packages/client/ui-primitives` | 与 Task Surface 无关的 `MarkdownText.remoteImages` 策略，包括 `alt-only` 图片分支和 URL 策略测试 |
| `packages/client/ui-task-surface` | 静态且可操作的 `TaskSurfaceDock`、带 key 的只读 transcript 行、消费 Task Surface 模型并以 `alt-only` 模式使用 `MarkdownText` 的声明式 Web 渲染器、按会话划分的草稿 store，以及提交客户端 |
| `packages/host/apiproxy` | 类型化的活动 Surface 读取／提交／关闭传输、用户消息来源扩展与传递、队列操作限制，以及认领和终态结果的路由；将校验、待处理协调和接纳委托给 Task Surface 服务 |

`ui-task-surface` 依赖浏览器安全的 Task Surface 领域包、客户端连接与运行时、locale、`ui-conversation` 所声明的 slot 约定、用于注册的 `ui-slots`，以及 `ui-primitives`；`ui-primitives` 不反向依赖 Task Surface。ApiProxy 依赖 Task Surface 服务约定和通用 AgentLoop 终态结果。核心 Agent 包不导入 Task Surface 类型。

该实现依赖现有的消息日志、规范工具输出、带标签的 render intent、会话投影、按会话作用域声明的 slot store 和 slot 生命周期，不依赖在运行时创建客户端插件。Generated Client Plugin 工作流可以使用 Task Surface 展示审阅表单，但两个协议都不拥有或激活另一个协议。

## 交付阶段

1. 实现模型／解析器、`MarkdownText` 模型 URL 策略、投影单元、`show_task_surface`、呈现元数据、只读 Web 行、静态 `TaskSurfaceDock`、活动 Surface 读取，以及带只读块的通用回退。
2. 增加字段、持久化草稿、经 Host 校验的提交／关闭、带品牌类型的关联信息、客户端排队来源传递、Task Surface `queued`/`claiming` 协调、已认领调用实例的终态报告、队列操作限制，以及可见用户消息接纳。
3. 只增加有实际任务依据，并且拥有至少两个消费方或明确通用回退的组件类型。一个单独的显式用户操作可以启动生成客户端插件的编写工作流，但只会创建一个候选方案，绝不会直接将代码转为正式实现。

## 考虑过的替代方案

**增加产品专用触发方式和面板。**不予采用，因为每种新任务形态都会把 agent 行为与已发布的产品组件耦合。产品代码应当定义一套接纳的组件词汇和放置策略；agent 则显式地从中选择。

**从工具调用中渲染任意 HTML、CSS 或 JavaScript。**不予采用，因为这会把临时交互变成可执行的客户端插件代码，却不具备代码所需的构建、预览、评估、批准或回滚生命周期。

**使用大型表单扩展 `userInteraction.ask()`。**本约定不采用这种做法。`ask()` 是一种阻塞式请求／响应操作，适用于正在运行的工具必须先获得简短答案才能继续执行的情况。Task Surface 会结束当前轮次，可以在刷新后继续保持打开，并把结果提交为下一条可见用户消息。

**每次调用都注册一个动态 `conversation.view`。**不予采用，因为视图账本是全局的，而其渲染作用域按会话划分；同时，临时任务身份会变成注册身份。一个静态的会话作用域 Dock 负责交互，一个静态带 key 的行概述已记录的调用实例；两个注册项都不使用调用实例身份。

**只在规范工具值中保留模型。**不予采用，因为规范值不会持久化。回放要求将规范化模型写入 `presentationMeta`。

**将面板存入长期记忆。**不予采用，因为布局和草稿状态不是可复用事实。现有记忆策略可以保留用户提交的结论。

## 验收标准

- 在 `native` 或 `both` 工具模式下，真实模型可以调用一个稳定的 `show_task_surface` schema；调用结束当前轮次；具备相应能力的 Web 客户端在实时运行和回放后都能渲染同一份规范化模型；仅支持 `ptc` 的模式不会向模型公布该工具。
- 静态 `TaskSurfaceDock` 是唯一的编辑器，即使活动结果位于已加载历史窗口之外也仍可操作；带 key 的 toolview 始终是 transcript 的只读摘要和回放。composer 接管会隐藏仍处于挂载状态的 Dock、保留其草稿，并在接管释放后重新显示同一个所有者。
- 每个 `submissionId` 的提交操作恰好生成一条可见用户消息，通过普通队列接纳开始下一轮，并在保留 `source.kind: 'user'` 的同时维持带品牌类型的确切调用实例关联；关闭操作记录一条日志事件，且不启动轮次。
- 客户端排队行保留已关联的消息来源。`getActive` 可在同一进程的重新连接前后公开 `queued` 或 `claiming`；持久化完成后会关闭投影，显式丢弃则会清除待处理状态并让 Surface 保持打开。队列行消失本身不会改变任何 UI 状态。系统会拒绝编辑和 steering，且移除操作只能在认领前成功。
- 刷新、重新连接、会话切换、fork 和回退都生成日志所决定的生命周期状态；`getActive` 可以恢复历史尾段之外的模型和待处理阶段，任何面板、待处理状态或草稿都不会泄漏到其他会话。
- 不受支持的版本、格式错误的元数据以及客户端能力缺失时，系统回退到带普通消息绕过路径的可读工具结果内容；嵌套调用以及已有另一个活动 Surface 时发起的调用都无法打开 Surface，并以失败结束。
- 协议 schema 会校验 ID 字符串，领域 API 始终公开带品牌类型的 ID。模型解析器会在面板可交互前强制校验带标签的布局形态、字段值，以及配置的字节数和数量限制。浏览器测试证明：图片语法会变成替代文本，原始 HTML 和嵌入式媒体不会渲染，而且在用户显式操作前不会请求模型提供的 URL。
- 组件测试覆盖纯键盘操作、焦点恢复、无障碍名称、窄屏布局、两种主题，以及中英文产品界面。
- 无密钥浏览器组合测试覆盖显示、Dock 与只读行的职责归属、窗口外恢复、编辑、接纳被拒后的重试、从 `queued` 到 `claiming` 的转换、丢弃、没有可编辑空档的持久交接、禁止的队列操作、关闭、重新连接和双重提交幂等性。
- 前缀快照表明：无论任务特定模型如何变化，都只存在一个稳定的工具定义；只有调用参数和后续用户结论发生变化。
- 卸载 Web 插件时，其所属 Fiber 会对 Dock、工具行和草稿 store 执行 dispose，但不会改变持久 transcript。

## 风险

第一批组件可能小到无法满足实际任务，也可能大到足以演变成一个粗糙的应用框架。是否新增组件应由使用证据决定；初始组件集不提供表达式语言或网络行为。

Task Surface 的 Markdown 策略舍弃行内图片、媒体和自动链接预览。普通链接仍有用，但只有用户显式操作后，才可以导航或发起请求。

即使设置了字节限制，大型表格和 Markdown 仍可能生成开销较高的 DOM。渲染器必须按需虚拟化或截断内容，同时保留可读回退和明确计数。

填写字段较多时，由产品格式化的提交消息可能过长。格式化器需要使用确定性的紧凑格式，保留每一个提交值，同时避免重复完整显示模型。

在完成持久交接之前一直持有进程内认领状态，会新增一项终态不变量。每条接纳退出路径都必须产生匹配的 `user/message` 或显式丢弃，否则重新连接可能会让 Dock 永久处于禁用状态。

浏览器本地持久化的草稿可能保留敏感的未提交文本。store 需要遵守规定的字节上限、使用按会话划分的 key、在提交成功后显式清除，并采用与现有会话草稿相同的存储策略。

Dock 和 transcript 行以不同角色展示同一个调用实例。将工具行保持为只读，并让 Dock 成为唯一的变更所有者，可以避免草稿冲突，但代价是 Surface 活动期间会出现第二份简洁表示。
