# 消息反馈

[English](feedback.md) | 中文

[`@deepseek-ai/dsh-message-feedback`](../../packages/feedback/message-feedback)拥有针对单条 assistant 消息的可编辑反馈。它刻意与不可变的 Session 级 `feedback/record` 事件分离：message feedback 是本地 storage-domain 伴随记录（sidecar），不是 Session 日志内容或投影，也不执行遥测交接。

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
/** Read all message feedback belonging to one persisted Session lifecycle. */
interface MessageFeedbackListRequest {
  /** Persisted Session whose sidecar should be read. */
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
  /** Persisted Session that owns the sidecar. */
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

每个 Session 的一条伴随记录包含 header 身份 `{createdAt, cwd}` 和以 `MessageId` 为键的反馈条目。每个条目携带好评或差评、可选备注、Host 分配的 `createdAt`/`updatedAt` 时间戳及自己的 opaque version。version 只能用于相等比较，且只与目标消息比较；调用方不能排序或自行合成它。

`put` 采用严格乐观并发：已有条目的每次请求都必须匹配当前 `ifVersion`，即使请求不会改变目标值。冲突会返回权威当前条目（不存在时为 `null`），因此调用方无需额外读取，即可协调丢失响应或并发编辑。删除已经不存在的条目同样成功。按 Session 划分的队列覆盖检查、读取、冲突判断与整行写入，因此这些保证适用于单个 Host 进程中的并发调用。

## 目标与生命周期权威

live 持有者的内存日志直接提供目标 Session 的观测；cold 目标则通过 `SessionPersistence.open(id, 'read')` 句柄读取，既不会发布或恢复 Agent，也不会写入恢复内容。先由 `stat(id)` 预检明确不存在；`stat` 已确认存在的 Session 若读取失败，会按基础设施故障原样传播。`put` 只接受具有指定 `MessageId` 的非空、append-origin `assistant/message`；replacement-origin、仅承载 usage 的空记录和非 assistant 记录都不是反馈目标。

存储的 `{createdAt, cwd}` 身份必须与检查所得 header 匹配。不匹配按不存在处理：`list` 返回空条目，`put` 则可用绑定当前 header 身份的新记录替换陈旧行。fork 使用新的 Session 身份，即使种子包含相同消息，也不获得伴随记录副本。

## 持久化与 Remote 约定

服务通过 `ctx.storageDomain` 在 `message_feedback` 存储域中保存完整 Session 行。`put` 提交引用目标消息的伴随记录前，身份匹配的 live 目标先经过权威 `ctx.sessions.flush` checkpoint；随后 live 与 cold 路径都会通过一个新开的读句柄从序列零做物理复读，依据该 seam 的新鲜度保证，它至少能观察到已 flush 的前缀。写入伴随记录前会再次校验所得观测，因此目标日志的持久提交始终先于其伴随记录。`maxNoteBytes` 为必填项，按 UTF-8 字节限制备注文本；Web Host 组合将其设为 `8192`。该包通过 `TypertRemoteService` 与 `@Remote` 发布 Host `messageFeedback.list`、`messageFeedback.put` 和 `messageFeedback.delete` 一元 Remote 约定；下方生成的 Cordis API 是方法级权威。

Plugin disposal 会先关闭变更接纳，排空已进入各 Session 队列的工作，然后才关闭 storage domain。

## Web 界面

[`@deepseek-ai/dsh-client-ui-message-feedback`](../../packages/client/ui-message-feedback) 是浏览器侧消费方。`@deepseek-ai/dsh-api-remotes` 挂载生成的 `messageFeedback` 贡献，因此该插件调用 `ctx.remote.messageFeedback`，不接触传输层。

控件是 `conversation.chat.assistant-actions` list slot 的 `feedback` 条目（order 10），该 slot 由 `ui-conversation` 声明，并渲染在已定稿助手消息的 IconActions 行内。`AssistantMessageNode` 携带来自 `assistant/message` 事件的可选 `messageId`。被中断冻结的部分输出没有该字段，渲染点在字段缺失时跳过该 slot。该操作栏每个 Turn 渲染一次，位于收尾的助手消息上：Host 接受每条 append-origin 步骤消息作为目标，但多步骤 Turn 中较早的步骤渲染的是工具行而非可评分正文，因此 UI 暴露的范围比 Host 约定允许的更窄。

每个 Session 一个 `MessageFeedbackController`，支撑该 Session 内所有消息的控件：一次 `list` 读取即填充整段对话，且延迟到首次 hover 或 focus 才发起，而非挂载时触发。每次变更把该 controller 最后观察到的版本作为 `ifVersion` 发送；`version-conflict` 响应携带权威条目，controller 据此对账而不重新拉取。变更按 Session 串行，排队操作与已提交版本比较。`connection/reset` 只刷新已读取过的 Session。

## 边界与限制

- 变更队列仅在进程内生效。storage-domain 没有跨进程条件写，因此多个 Host 写入同一存储根目录时，不提供 compare-and-swap 或防止丢失更新的保证。
- Session persistence 没有持久删除接口。服务不把 `session/disposed` 或 `api-session/removed` 当作删除，因此不伪造级联；在带外移除日志后，孤儿伴随记录可能继续存在。
- 请求若恰好落在 live detach 之后、persistence catalog 物化 header 之前的极短窗口，可能收到 `session-not-found`；调用方应在 retirement materialization 后重试。
- 由于 persistence 没有按 id 读取元数据的操作，cold 请求会扫描完整的 Session snapshot 目录。单个 Session 行也没有条目数或聚合字节上限；在具体消费方拥有行策略之前，`maxNoteBytes` 只限制每条备注。
- 只有 `{createdAt, cwd}` 不同时，header 身份才能识别复用的 id；本约定无法区分保留相同 header 身份的克隆日志。
- Host 约定不记录已认证的 actor 或审计身份，因此假设调用方边界可信。
- Web 控件只出现在对话视图。trajectory 与 waterfall 视图不渲染反馈条目，尽管它们的助手节点携带相同的 `messageId`。
- 该 sidecar 不发布实时帧，因此另一个标签页的评分要等到重连或下一次冲突响应才可见，不会立即出现。
- 备注编辑器不预先校验 `maxNoteBytes`；超长备注在保存时以 `note-too-large` 失败，而不是在输入过程中。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmessagefeedback--messagefeedbackservice"></a>

### `ctx.messageFeedback` — `MessageFeedbackService`

Storage-domain sidecar service. It inspects persisted Session history and never creates or resumes an Agent or Session.

```ts cordis-catalog
/**
 * Read feedback belonging to the current persisted Session lifecycle.
 * A stale row from a reused Session id is invisible.
 * @param request - Session identity to inspect and list.
 * @returns current immutable items or `session-not-found`.
 */
@Remote('list') async list(request: MessageFeedbackListRequest): Promise<MessageFeedbackListResult>

/**
 * Create or replace feedback for one derived append-origin assistant
 * message. Every request must match the addressed item's current version;
 * a matching no-op returns the stored item without changing its revision.
 * @param request - target, desired value, and observed item version.
 * @returns the committed item or an explicit business failure.
 */
@Remote('put') put(request: MessageFeedbackPutRequest): Promise<MessageFeedbackPutResult>

/**
 * Delete one feedback item. Absence is successful regardless of the
 * supplied version; an existing item requires an exact version match.
 * @param request - Session, message, and observed item version.
 * @returns the stable absent postcondition, or an explicit failure.
 */
@Remote('delete') delete(request: MessageFeedbackDeleteRequest): Promise<MessageFeedbackDeleteResult>
```

Source: [`packages/feedback/message-feedback/src/index.ts`](../../packages/feedback/message-feedback/src/index.ts)
<!-- END GENERATED cordis-surface -->
