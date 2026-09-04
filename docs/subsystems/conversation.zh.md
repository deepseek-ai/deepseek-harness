# Conversation 组装

[English](conversation.md) | 中文

Conversation 是 Client `SessionEventLikeEntry` window 与浏览器 view 之间的 target-neutral assembly 层。[`ui-conversation`](../../packages/client/ui-conversation/README.zh.md)拥有 event 与 view registry、每个 `SessionBinding` 对应的 identity-stable binding、Turn/Step Location、增量 Context assembly、target source、共享 shell 与输入编排。[`ui-chat`](../../packages/client/ui-chat/README.zh.md)和 [`ui-trajectory`](../../packages/client/ui-trajectory/README.zh.md)等 target 包拥有各自的 Definition、最终 snapshot 与渲染。

本文定义数据模型与业务自有 Conversation node 的扩展路径。[Web Client 架构](web-client.zh.md)说明该子系统在 Client model 与 Slots 之间的位置；[Conversation Node 组装决策](../../.agents/notes/implemented/architecture/2026-08-09-client-conversation-node-assembly.zh.md)记录其设计理由。

## 数据模型与所有权

Session Controller 拥有连续的已加载逻辑 event window。每个 `SessionEventLikeEntry` 要么是表示一个持久事件的 `{ type: 'event', event: SessionEvent }`，要么是表示一个 Client-only `assistant/live-chunk` 呈现的 `{ type: 'transient', event: AssistantLiveChunkEvent }`；两种内部 event 都公开 `type`、`seq`、`time` 与 `data`。`ui-conversation` 把这些 entry 直接交给 assembler，不另开 history stream。每个 Session 对应一个 `ConversationNodeAssembler`，它应用所有已注册 Definition，并为每个已注册 view target 发布独立 source。

| 概念 | Owner 与用途 |
|---|---|
| Event Definition | 业务包一次匹配一个持久 event 或 Client-only 瞬态 event，以稳定 `(kind, id)` 关联输入、折叠确定性 State，并可选择 materialize 一个 target node。 |
| Context | Engine 为一个 `(kind, id)` 拥有的有序 Match 与当前 State。一个瞬态 event 只占一个 update Match；只有 update 的证据可以保持 pending，直到分页补齐其唯一持久 start。 |
| Location | Engine 根据持久 boundary event 推导的 Session、Turn 或 Step 坐标。Definition 可以向一个 Turn 或 Step 发布类型化数据。 |
| View Definition | Target 包为每个 Session 创建一个增量 builder，并拥有该 target 的最终 snapshot 类型。 |
| View | Chat 或 Trajectory 等 Slot entry 只读取自身 target snapshot，并渲染 target 自有 node。 |

Chat 与 Trajectory 可以识别同一个持久 event family，但各自保留自己的 Definition State 与最终 node payload。共享的 target-neutral 机制只包括 identity routing、有序 replay、Location data、predecessor dependency 与 publication cadence。

## Target 激活

每个 Session 都保留单调增长的 active target 集合。创建或读取 target source 不会激活它。shell 会显式激活持久化选择或新选择的 View，其他消费者则通过 target source 的首个订阅激活 target。首次激活会创建该 target 的 builder，并从当前按 target 索引的 Context 调用一次 `replace()`。后续 flush 对每个 active target 调用 `apply()`，取消订阅不会移除 target。

shell 拥有 View 选择，并在 binding 创建、被选为 current 或 View roster 变化时，于渲染前解析已注册的偏好 View 或 Chat fallback。assembler 只接收解析后的 target id，不自行选择 Chat 或其他默认 target。第三方 View 使用相同的选择与激活操作。

## 可回放 event family

编写 Definition 前先选定稳定的业务 id。构成同一个 Node 的每条事件都必须携带该 id，或只凭自身 payload 独立推导出该 id；Client 绝不能把 update 猜测为属于“最近一个未完成”的 Context。

以一个 review job 为例，事件约定可以是：

| 事件 | 角色 | 必须持久化的事实 |
|---|---|---|
| `review/start` | 唯一 start | `reviewId`、Turn/Step 坐标、标题 |
| `review/progress` | update | 相同的 `reviewId`、坐标、可回放进度 |
| `review/end` | update | 相同的 `reviewId`、坐标、最终摘要 |

跨进程边界使用生产方拥有的 branded id 类型。把 `SessionEventMap` 合并和 payload 类型放在生产方的纯类型导出中，再由 Client 包通过仅类型副作用导入该导出。每个 `(kind, id)` 最多只能有一条 start 事件。单事件业务可以把事件自身的稳定身份（例如 `event.seq`）作为 Definition 内部 id。

系统支持增量事件。如果生产方能以较低成本发出 whole-value checkpoint，应优先采用，因为 start 位于已加载窗口之外时它仍可直接使用。每条 delta 都必须携带稳定 id，并且按照日志 `seq` 升序回放时能够确定性地产生 State；它不能依赖只存在于实时内存中的状态。如果当前历史窗口只有 update，Assembler 会保留一个 pending Context，并在更早分页补齐 start 前不构造 State。如果产品必须在 start 尚未加载时渲染，terminal 或 checkpoint 事件就必须携带足够的完整 fallback 状态，让 Definition 能直接构造结果；不要通过扫描无关事件恢复它。

实时 Assistant delta 作为 Client-only `assistant/live-chunk` update 到达。重连 baseline 会把活跃的进程内紧凑 stream 展开为相同的瞬态 event，持久 `assistant/message` 与 `assistant/attempt` event 则嵌入完整紧凑 stream 供历史回放。瞬态 event 只能充当 update；`start()` 只接收标准 `SessionEvent`。消费 Assistant 输出的 Definition 在同一组 `match()` 与 `update()` 方法里处理 live chunk 与持久 settlement，其他 Definition 直接返回 `null`，无需展开 stream。

## Definition 与类型化 Chat payload

为了完整展示关联关系，下面把生产方声明和 Client 贡献写在同一个代码块里。实际的包族中，branded id 与 `SessionEventMap` 声明留在事件生产方，Definition、Chat data 合并与 renderer 留在 Client 插件。

```ts ignore-check
import { createElement } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type {
  ConversationLocation, ConversationNodeContext,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'

type ReviewId = Branded<'ReviewId'>

interface ReviewStartData {
  readonly reviewId: ReviewId
  readonly turn: number
  readonly step: number
  readonly title: string
}

interface ReviewProgressData {
  readonly reviewId: ReviewId
  readonly turn: number
  readonly step: number
  readonly completed: number
}

interface ReviewEndData {
  readonly reviewId: ReviewId
  readonly turn: number
  readonly step: number
  readonly summary: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Opens one durable review job.
     * @mode emit
     * @param data - stable identity, location, and initial display state.
     */
    'review/start': ReviewStartData
    /**
     * Records replayable progress for one review job.
     * @mode emit
     * @param data - stable identity, location, and latest progress.
     */
    'review/progress': ReviewProgressData
    /**
     * Closes one review job with its final summary.
     * @mode emit
     * @param data - stable identity, location, and final display state.
     */
    'review/end': ReviewEndData
  }
}

interface ReviewChatData {
  readonly title: string
  readonly completed: number
  readonly status: 'running' | 'completed'
  readonly summary?: string
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    'review-job': ReviewChatData
  }
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationStepDataMap {
    'review-job': ReviewChatData
  }
}

interface ReviewState extends ReviewChatData {
  readonly turn: number
  readonly step: number
}

function locationOf(context: ConversationNodeContext): ConversationLocation {
  return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
}

function viewData(state: ReviewState): ReviewChatData {
  return {
    title: state.title,
    completed: state.completed,
    status: state.status,
    ...state.summary === undefined ? {} : { summary: state.summary },
  }
}

const reviewDefinition: ConversationNodeDefinition<ReviewState> = {
  kind: 'review-job',
  target: 'chat',
  match: (event) => {
    if (event.type === 'review/start') {
      return { id: String(event.data.reviewId), role: 'start' }
    }
    if (event.type === 'review/progress' || event.type === 'review/end') {
      return { id: String(event.data.reviewId), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'review/start') throw new Error('review-job requires review/start')
    return {
      turn: match.event.data.turn,
      step: match.event.data.step,
      title: match.event.data.title,
      completed: 0,
      status: 'running',
    }
  },
  update: (context, match) => {
    if (match.event.type === 'review/progress') {
      return { ...context.state, completed: match.event.data.completed }
    }
    if (match.event.type === 'review/end') {
      return { ...context.state, completed: 100, status: 'completed', summary: match.event.data.summary }
    }
    return context.state
  },
  publication: match => match.event.type === 'review/progress'
    ? 'animation-frame'
    : 'immediate',
  buildLocationData: (context, scope) => {
    if (scope !== 'step' || context.state === undefined) return null
    return {
      kind: 'step',
      turn: context.state.turn,
      step: context.state.step,
      key: 'review-job',
      value: viewData(context.state),
    }
  },
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    return {
      key: context.key,
      kind: 'review-job',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start?.event.seq ?? context.matches[0]?.event.seq ?? 0,
      location: locationOf(context),
      visibility: 'visible',
      data: viewData(context.state),
    }
  },
}

function ReviewNodeView({ node }: ChatNodeViewProps<'review-job'>) {
  const text = node.data.summary ?? `${node.data.title}: ${node.data.completed}%`
  return createElement('p', null, text)
}

export const inject = ['uiConversation', 'slots']

export function apply(ctx: ClientContext): void {
  ctx.uiConversation.events.register(reviewDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'review-job',
  }, ReviewNodeView))
}
```

`match(event)` 是身份提取器，不是 fold：它只能收到当前 `SessionEventLike`，并返回 Definition 内部 id 与生命周期角色。命中后，Assembler 通过 `(kind, id)` 定位 Context；标准 event 可触发一次 `start`，标准或 packed event 可把当前 State 交给 `update`。两个函数都必须返回引擎随后采用的 State；推荐返回新的 immutable value，但函数原地修改后返回同一对象时，采用语义也相同。

`buildLocationData(context, scope)` 可以把 Definition 拥有的数据发布到引擎拥有的 Turn 或 Step 上。通过 declaration merging 为每个 key 指定精确 value 类型。同一 Location 内的另一个 Node 可以使用受限 slot hook（例如 `useTurnData(key)`）读取该值，无须取得 Session，也无须扫描 `snapshot.chat.nodes`。

`target` 与 `buildViewNode(context)` 必须同时声明一项由 target 拥有的渲染贡献。把 `context.key` 保留为 React 侧身份，根据持久排序证据选择 `anchorSeq`，并且只返回 renderer 可以直接使用的数据。某个 target Node 一旦发布，就要继续返回同一个 key；需要暂时离开可见流时使用 `visibility: 'hidden'`，不要改为返回 `null` 撤回它。

## Predecessor read

有些 Definition 需要另一个业务 kind 在当前位置之前的最新 State。`start` 会收到 `ConversationContextReader`；应在这里调用 `reader.previous<State>(kind)`，不要接收 Context 集合或扫描事件。Reader 返回当前 start `seq` 之前最近一个已启动 Context 的只读数据。

Assembler 会记录这项依赖。如果后续 older prepend 带来了更近的前序 Context、补齐了原先未知的窗口缺口，或者前序 State 被修订，引擎会从 `start` 重新运行依赖方 Context，并按 `seq` 升序回放其 update。被查询的 Definition 仍负责把有用信息写入自身 State；Reader 不提供业务专用查询方法，也不授予修改其他 Context 的权限。

## Window 更新路径

历史可能从尾部开始一页一页向前请求。Session journal 先校验互不重叠的逻辑 seq range，Assembler 再按每个已接受 input 的首 `seq` 排序并进入 State 回放。

| 路径 | 引擎工作 | Definition 可观察到的行为 |
|---|---|---|
| open、resync 或 gap repair 时 replace | 重建已加载窗口，每条标准 event 或 packed run 对每个 Definition 匹配一次，再回放每个已有 start 的 Context | 先执行 `start`，再按逻辑 `seq` 升序执行其 update；只有 update 的 pending Context 仍没有 State |
| prepend 一页更早历史 | 只匹配新增的更早 input，按 `(kind, id)` 合并进 Context，保留现有 keyed node，并只重放受影响的 Context 与依赖 | 新发现的 scalar start 会激活已收集的 scalar 与 packed update；Location 或前序依赖变化也可能重跑 Context |
| append 一条实时事件 | 每个 Definition 各调用一次 `match`，按 key 查找命中的 Context，只更新该 Context | 对 start 之后的匹配事件执行一次 scalar `update` 并请求一次发布；不扫描已有 Context |

注册 `D` 个 Definition 时，一条新 scalar event 或 packed run 会进行 `D` 次仅当前 input 匹配；命中后的 Context key 查询是常数时间。Definition 代码必须维持这个性质：正常 append 热路径不得遍历完整事件窗口、所有 Context、`context.matches` 或已渲染 Node 集合。累计事实放进 State，同 Turn/Step 共享信息放进 Location data，有索引的前序依赖使用 `reader.previous()`。

`publication` 控制发生 State 变更后何时物化。结构或 terminal 变化使用 `immediate`，高频可见 delta 使用 `animation-frame`，只为后续发布积累 State 时使用 `none`。引擎按日志顺序应用每条 scalar update，并用一次 batch update 应用一个 packed run；该选项只合并视图发布频率。

## 验证要求

添加聚焦测试，证明以下结果：

1. 完整窗口通过 replace 后产生预期的最终 State、Location data、Node payload 与 `anchorSeq`。
2. 只有 update 的尾部窗口保持 pending；prepend 唯一 start 后，结果与完整 replace 相同。
3. 初始历史后继续实时 append，与回放合并后的完整窗口得到相同结果。
4. prepend 更早分页只增加更早的行；数据未变化的既有 keyed Node value 不被替换。
5. 重复的可见 delta 保持 `context.key`，并在请求 `animation-frame` 时每帧最多发布一次。
6. keyed renderer 只消费 `node.data` 与受限 Location hook，不扫描 Session 事件窗口、Context 或 Chat Node。
7. scalar 与 packed Assistant 历史产生相同的最终 State、timing boundary 和 target snapshot；一个 packed run 在 replace、prepend、Location replay 与 registry rebuild 中始终只保留一个 Match。
8. 创建 target source 不执行 builder 工作；显式选择或首次订阅执行一次完整 replace，后续更新送达所有 active target，重复激活不会再次 replace。

流式与中断处理可参考 [`packages/client/ui-chat/src/client/conversation-nodes/assistant.ts`](../../packages/client/ui-chat/src/client/conversation-nodes/assistant.ts)，前序查询可参考 [`inbox.ts`](../../packages/client/ui-chat/src/client/conversation-nodes/inbox.ts) 与 [`message.ts`](../../packages/client/ui-chat/src/client/conversation-nodes/message.ts)，只发布 Turn data 而不创建自有 Node 的例子见 [`packages/client/ui-deliverables`](../../packages/client/ui-deliverables)。
