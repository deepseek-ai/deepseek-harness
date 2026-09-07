# 消息反馈

[English](feedback.md) | 中文

[`@deepseek-ai/dsh-message-feedback`](../../packages/feedback/message-feedback)拥有针对单条 assistant 消息的可编辑反馈。权威 Session 日志保存 `feedback/message-put` 和 `feedback/message-delete`；不可变的 Session 级备注仍使用 `feedback/record`。三者都是仅写日志的事件，绝不进入模型上下文。

来源：[`packages/feedback/message-feedback/src/types.ts`](../../packages/feedback/message-feedback/src/types.ts)

## 公开类型

```ts type-equiv
/** Opaque compare-and-set token for one exact feedback item revision. */
type MessageFeedbackVersion = Branded<'MessageFeedbackVersion'>
```

```ts type-equiv
/** The human's overall judgment of one assistant message. */
type MessageFeedbackRating = 'positive' | 'negative'
```

```ts type-equiv
/** One current feedback value and its opaque mutation token. */
interface MessageFeedbackItem {
  /** Stable identity of the assistant message inside the owning Session. */
  readonly messageId: MessageId
  /** Overall positive or negative judgment. */
  readonly rating: MessageFeedbackRating
  /** Optional explanation, preserved verbatim after validation. */
  readonly note?: string
  /** Equality-only token replaced by every material create or update. */
  readonly version: MessageFeedbackVersion
  /** Host-assigned creation time in Unix epoch milliseconds. */
  readonly createdAt: number
  /** Host-assigned time of the most recent material update. */
  readonly updatedAt: number
}
```

```ts type-equiv
/** A material creation or edit, retaining its complete current value. */
interface MessageFeedbackPut {
  /** Owning Session; inherited feedback in a fork belongs to its parent. */
  readonly sessionId: SessionId
  /** Value after this mutation, including the original creation time. */
  readonly item: MessageFeedbackItem
}
```

```ts type-equiv
/** A material deletion of one current feedback item. */
interface MessageFeedbackDelete {
  /** Session that owns the deleted feedback. */
  readonly sessionId: SessionId
  /** Message whose feedback was removed. */
  readonly messageId: MessageId
}
```

```ts type-equiv
/** Read all message feedback belonging to one persisted Session lifecycle. */
interface MessageFeedbackListRequest {
  /** Session whose feedback events should be read. */
  readonly sessionId: SessionId
}
```

```ts type-equiv
/** Current feedback values for one Session, in first-creation order. */
interface MessageFeedbackListValue {
  /** Fresh immutable item snapshots. */
  readonly items: readonly MessageFeedbackItem[]
}
```

```ts type-equiv
/** Create or replace feedback for one assistant message. */
interface MessageFeedbackPutRequest {
  /** Persisted Session that owns the target message. */
  readonly sessionId: SessionId
  /** Target assistant-message identity. */
  readonly messageId: MessageId
  /** Desired overall judgment. */
  readonly rating: MessageFeedbackRating
  /** Optional non-blank explanation. */
  readonly note?: string
  /** Observed item version, or `null` to require that no item exists. */
  readonly ifVersion: MessageFeedbackVersion | null
}
```

```ts type-equiv
/** Delete feedback for one message after observing its current version. */
interface MessageFeedbackDeleteRequest {
  /** Session that owns the feedback. */
  readonly sessionId: SessionId
  /** Message whose feedback should be absent after this operation. */
  readonly messageId: MessageId
  /** Observed item version; ignored when the item is already absent. */
  readonly ifVersion: MessageFeedbackVersion
}
```

```ts type-equiv
/** Idempotent deletion acknowledgement. */
interface MessageFeedbackDeleteValue {
  /** Stable postcondition shared by the first deletion and every retry. */
  readonly absent: true
}
```

```ts type-equiv
/** No persisted Session header exists for the requested id. */
interface MessageFeedbackSessionNotFound {
  readonly code: 'session-not-found'
  readonly sessionId: SessionId
}
```

```ts type-equiv
/** The id does not name a derived, append-origin assistant message. */
interface MessageFeedbackTargetNotFound {
  readonly code: 'target-not-found'
  readonly sessionId: SessionId
  readonly messageId: MessageId
}
```

```ts type-equiv
/** A material mutation did not match the addressed item's current version. */
interface MessageFeedbackVersionConflict {
  readonly code: 'version-conflict'
  /** Authoritative current item, or `null` when it does not exist. */
  readonly current: MessageFeedbackItem | null
}
```

```ts type-equiv
/** A supplied note contains no non-whitespace character. */
interface MessageFeedbackNoteBlank {
  readonly code: 'note-blank'
}
```

```ts type-equiv
/** A supplied note exceeds the configured UTF-8 byte limit. */
interface MessageFeedbackNoteTooLarge {
  readonly code: 'note-too-large'
  readonly maxBytes: number
  readonly actualBytes: number
}
```

```ts type-equiv
/** Failures shared by the public message-feedback operations. */
type MessageFeedbackFailure =
  | MessageFeedbackSessionNotFound
  | MessageFeedbackTargetNotFound
  | MessageFeedbackVersionConflict
  | MessageFeedbackNoteBlank
  | MessageFeedbackNoteTooLarge
```

```ts type-equiv
/** Successful public operation result. */
interface MessageFeedbackSuccess<T> {
  readonly ok: true
  readonly value: T
}
```

```ts type-equiv
/** Rejected public operation result with a stable business failure. */
interface MessageFeedbackRejected<E extends MessageFeedbackFailure> {
  readonly ok: false
  readonly error: E
}
```

```ts type-equiv
/** Result returned by the message-feedback `list` operation. */
type MessageFeedbackListResult =
  | MessageFeedbackSuccess<MessageFeedbackListValue>
  | MessageFeedbackRejected<MessageFeedbackSessionNotFound>
```

```ts type-equiv
/** Result returned by the message-feedback `put` operation. */
type MessageFeedbackPutResult =
  | MessageFeedbackSuccess<MessageFeedbackItem>
  | MessageFeedbackRejected<
    | MessageFeedbackSessionNotFound
    | MessageFeedbackTargetNotFound
    | MessageFeedbackVersionConflict
    | MessageFeedbackNoteBlank
    | MessageFeedbackNoteTooLarge
  >
```

```ts type-equiv
/** Result returned by the message-feedback `delete` operation. */
type MessageFeedbackDeleteResult =
  | MessageFeedbackSuccess<MessageFeedbackDeleteValue>
  | MessageFeedbackRejected<MessageFeedbackSessionNotFound | MessageFeedbackVersionConflict>
```

## 数据与并发

当前条目由 payload 中 `sessionId` 与所属 Session 匹配的权威反馈事件归约得到。每个条目携带好评或差评、可选备注、Host 分配的 `createdAt`/`updatedAt` 时间戳及自己的 opaque version。version 只能用于相等比较，且只与目标消息比较；调用方不能排序或自行合成它。

`put` 采用严格乐观并发：已有条目的每次请求都必须匹配当前 `ifVersion`，即使请求不会改变目标值。冲突会返回权威当前条目（不存在时为 `null`），因此调用方无需额外读取，即可协调丢失响应或并发编辑。删除已经不存在的条目同样成功。按 Session 划分的队列串行执行读取与变更；cold 变更在读取、比较、追加和 flush 期间持有持久化写句柄。匹配版本的无变更操作不追加事件。

## 目标与生命周期权威

live 持有者的内存日志直接提供目标 Session 的观测；cold 读取使用 `SessionPersistence.open(id, 'read')` 句柄，变更则使用写句柄。两条路径都不构造 Session 或 Agent。先由 `stat(id)` 预检明确不存在；`stat` 已确认存在的 Session 若读取失败，会按基础设施故障原样传播。`put` 只接受具有指定 `MessageId` 的非空、append-origin `assistant/message`；replacement-origin、仅承载 usage 的空记录和非 assistant 记录都不是反馈目标。

fork 种子可以包含父 Session 的反馈事件，但 payload 保留父级 `sessionId`，因此不会成为子 Session 的当前反馈。删除条目会追加删除标记；早先的评分与备注仍保留在日志中。

## 持久化与 Remote 约定

成功的消息反馈变更会等待权威持久化完成：live 操作通过所属 Session 追加，并要求有 `ctx.sessions.flush` 监听器参与；cold 操作通过写句柄追加并 flush。持久化故障会原样传播，不会报告成功。`maxNoteBytes` 为必填项，按 UTF-8 字节限制备注文本；Web Host 组合将其设为 `8192`。该包通过 `TypertRemoteService` 与 `@Remote` 发布 Host `messageFeedback.list`、`messageFeedback.put` 和 `messageFeedback.delete` 一元 Remote 约定；下方生成的 Cordis API 是方法级权威。

插件释放会关闭操作接纳，并排空已进入各 Session 队列的工作。

显式启用后，[`session-log-deepseek`](../../packages/session/session-log-deepseek/README.zh.md) 会在后续符合条件的 DeepSeek 请求中，把反馈作为普通 `dsh_session_log` 后缀的一部分传送。记录反馈不会触发 LLM 请求，也不会单独上传 `dsh_feedback`。对于非 DeepSeek 路由，[OTel 后端](../../packages/session/session-telemetry-otel/README.zh.md)可以将权威日志前缀释放至已记录的反馈。命令确认文本确认记录并标识 Session 与匿名用户，不报告遥测策略或投递结果。

## Web 界面

[`@deepseek-ai/dsh-client-ui-message-feedback`](../../packages/client/ui-message-feedback) 是浏览器侧消费方。`@deepseek-ai/dsh-api-remotes` 挂载生成的 `messageFeedback` 贡献，因此该插件调用 `ctx.remote.messageFeedback`，不接触传输层。

控件是 `conversation.chat.assistant-actions` list slot 的 `feedback` 条目（order 10），该 slot 由 `ui-conversation` 声明，并渲染在已定稿助手消息的 IconActions 行内。`AssistantMessageNode` 携带来自 `assistant/message` 事件的可选 `messageId`。被中断冻结的部分输出没有该字段，渲染点在字段缺失时跳过该 slot。该操作栏每个 Turn 渲染一次，位于收尾的助手消息上：Host 接受每条 append-origin 步骤消息作为目标，但多步骤 Turn 中较早的步骤渲染的是工具行而非可评分正文，因此 UI 暴露的范围比 Host 约定允许的更窄。

每个 Session 一个 `MessageFeedbackController`，支撑该 Session 内所有消息的控件：一次 `list` 读取即填充整段对话，且延迟到首次 hover 或 focus 才发起，而非挂载时触发。每次变更把该 controller 最后观察到的版本作为 `ifVersion` 发送；`version-conflict` 响应携带权威条目，controller 据此对账而不重新拉取。变更按 Session 串行，排队操作与已提交版本比较。`connection/reset` 只刷新已读取过的 Session。

## 边界与限制

- 操作队列仅在进程内生效；cold 写入排他性依赖所选持久化提供方。
- 删除只移除当前条目，不会抹除 append-only 日志或已投递后缀中的早先备注。
- 请求若恰好落在 live detach 之后、persistence catalog 物化 header 之前的极短窗口，可能收到 `session-not-found`；调用方应在 retirement materialization 后重试。
- cold 请求读取完整日志；服务没有条目数或聚合字节上限。`maxNoteBytes` 只限制每条备注。
- Host 约定不记录已认证的 actor 或审计身份，因此假设调用方边界可信。
- Web 控件只出现在对话视图。trajectory 与 waterfall 视图不渲染反馈条目，尽管它们的助手节点携带相同的 `messageId`。
- Web 控制器不消费反馈日志事件，因此另一个标签页的评分要等到重连或下一次冲突响应才可见，不会立即出现。
- 备注编辑器不预先校验 `maxNoteBytes`；超长备注在保存时以 `note-too-large` 失败，而不是在输入过程中。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmessagefeedback--messagefeedbackservice"></a>

### `ctx.messageFeedback` — `MessageFeedbackService`

Session-log service; cold operations never construct a Session or Agent.

```ts cordis-catalog
/**
 * Read current feedback from the canonical log.
 * @param request - Session to inspect.
 * @returns immutable items or a definite persistence miss.
 */
@Remote('list') list(request: MessageFeedbackListRequest): Promise<MessageFeedbackListResult>

/**
 * Create or replace feedback after checking its current version.
 * Matching no-ops retain the version and append no event.
 * @param request - Target, desired value, and observed item version.
 * @returns the durable item or an explicit business failure.
 */
@Remote('put') put(request: MessageFeedbackPutRequest): Promise<MessageFeedbackPutResult>

/**
 * Delete one item after checking its version; absence succeeds without an event.
 * @param request - Session, message, and observed item version.
 * @returns the stable absent postcondition or an explicit failure.
 */
@Remote('delete') delete(request: MessageFeedbackDeleteRequest): Promise<MessageFeedbackDeleteResult>
```

Source: [`packages/feedback/message-feedback/src/index.ts`](../../packages/feedback/message-feedback/src/index.ts)

<a id="feedback-events"></a>

### `feedback/*` events

<a id="feedbackcommitted--parallel"></a>

#### `feedback/committed` — parallel

Observe a durable cold feedback mutation without publishing a live Session. Observers run before write ownership is released and must not await another message-feedback operation for this Session. The payload is borrowed read-only; deep-clone it before transferring ownership (for example, to Session.fromRestore).

```ts cordis-catalog
/**
 * Observe a durable cold feedback mutation without publishing a live Session.
 * Observers run before write ownership is released and must not await
 * another message-feedback operation for this Session. The payload is borrowed
 * read-only; deep-clone it before transferring ownership (for example, to Session.fromRestore).
 * @param inspection - committed canonical prefix, including the feedback as its last event.
 * @mode parallel
 */
'feedback/committed'(inspection: SessionInspection): void
```

Types: [SessionInspection](persistence.zh.md)

Source: [`packages/feedback/message-feedback/src/index.ts`](../../packages/feedback/message-feedback/src/index.ts)
<!-- END GENERATED cordis-surface -->
