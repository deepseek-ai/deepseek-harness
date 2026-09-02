# 会话持久化

[English](persistence.md) | 中文

事件日志的**持久性 seam**。[session.md](session.zh.md) 描述了内存中的 `Session`：仅追加的 `SessionEvent` 日志即为真源。本页描述如何使该日志持久化：抽象的 `SessionPersistence` 服务、它的提供方模型与随产品交付的 JSONL 后端、flush 检查点、崩溃恢复，以及随日志一同存储的元数据头。日志承载的事件词汇在生成的[持久化日志事件目录](../persistence-catalog.zh.md)中逐项列举。

该 seam 是一个[能力 seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.zh.md)：一个抽象服务（[dsh-session-persistence](../../packages/session/session-persistence)，`ctx.sessionPersistence`）在现有 `SessionEvent` 上暴露 `create`/`open`/`stat`/`list`——**没有平行的持久化事件类型**——其中 `create` 与 `open` 返回逐会话的 `SessionHandle`（`read`/`append`/`flush`/`close`），它承载全部日志访问与单写者所有权。仓库随产品交付 [dsh-session-persistence-jsonl](../../packages/session/session-persistence-jsonl) 作为其 provider；仓库外 provider 可以实现同一服务约定。见[基于句柄的持久化 Agent Note](../../.agents/notes/implemented/architecture/2026-08-27-handle-based-session-persistence.zh.md)与 [session-persistence Agent Note](../../.agents/notes/implemented/architecture/2026-06-14-session-persistence.zh.md)。

## `SessionHandle`——通向已存储会话的一条打开通道

每一次日志读写都经由句柄流动，绝不经由按 id 寻址的服务方法：句柄是未来跨进程写租约将要把守的那扇唯一的门。一种句柄类型同时服务两种访问——在 `read` 句柄上执行修改是运行时的 `SessionReadOnlyError`，而非类型层面的拆分——而进程内单写者所有权使得在已有活跃持有者时第二次 `open(id, 'write')` 以 `SessionAlreadyOwnedError` 拒绝。

```ts type-equiv
/**
 * One open channel onto a stored session. A handle is single-owner state, not
 * a shared service: `read` never backtracks below what this handle already
 * observed, a `write` handle reads its own successful appends, and `close()`
 * is the one teardown (idempotent, uncancellable; `Symbol.asyncDispose`
 * delegates to it). Every operation on a closed handle rejects with
 * `SessionHandleClosedError`.
 *
 * Freshness across handles: once an `append` or `flush` resolves on a write
 * handle, every read STARTED afterwards on the same backend instance — on any
 * handle, or through `stat`/`list` — observes at least that prefix.
 * Reads concurrent with a mutation carry no ordering promise beyond the valid
 * contiguous prefix.
 */
interface SessionHandle extends AsyncDisposable {
  /** The stored session this handle addresses. */
  readonly id: SessionId
  /** The immutable stored header, fixed at `create`/`open`. */
  readonly header: SessionHeader
  /**
   * Exact fork-inherited prefix length stored with the log; `0` when
   * `header.isSeeded` is false. Storage metadata paired with the header for
   * every body read, never part of the replayable event log.
   */
  readonly inheritedEventCount: SessionLogOffset
  /** Whether this handle may mutate the log. */
  readonly access: SessionAccess

  /**
   * Read a slice of the valid contiguous logical log. The slice is a legal log
   * prefix segment: a torn physical tail is never returned, and repeated reads
   * on this handle never observe an older state than a prior read.
   * @param offset - first logical event seq to include; defaults to `0`.
   * @param length - maximum number of events to return; defaults to the rest
   *   of the log. An offset at or past the end returns an empty list.
   * @param options - optional cancellation.
   * @returns the events with `seq >= offset`, at most `length` of them.
   */
  read(offset?: number, length?: number, options?: SessionHandleReadOptions): Promise<readonly SessionEvent[]>

  /**
   * Append a contiguous batch continuing the current logical end. The first
   * event's `seq` MUST equal the stored next-seq; committed events are never
   * rewritten. Persistence is best-effort: on resolution the batch is
   * accepted, ordered, and visible to reads on this backend instance, but
   * only a resolved {@link flush} promises it survives a crash — a backend
   * may buffer or batch physical writes behind append. Rejects with
   * `SessionReadOnlyError` on a read handle and `SessionOwnershipLostError`
   * when write ownership is gone.
   * @param events - the contiguous batch, in seq order.
   * @param options - optional cancellation observed before the write starts.
   */
  append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void>

  /**
   * The durability barrier — the one operation that promises storage: on
   * resolution every acknowledged append is durable and the session is
   * materialized for other processes; an empty created session becomes
   * durably listable here. Callers that must survive a crash flush; a backend
   * whose `append` already persists on resolution treats this as
   * materialize-if-needed. Rejects with `SessionReadOnlyError` on a read
   * handle.
   * @param options - optional cancellation observed before the barrier starts.
   */
  flush(options?: SessionHandleFlushOptions): Promise<void>

  /**
   * Release the handle: a read handle frees local resources; a write handle
   * completes pending durability and releases write ownership. Idempotent,
   * asynchronous, and deliberately not cancellable.
   */
  close(): Promise<void>
}
```

已创建的会话自 `create` 完成之刻起即可在本进程内被观察到，而后端可以把物理实体化（纯粹的优化）推迟到第一次 `append` 或 `flush`；其他进程只能看到已实体化的会话，一个在崩溃前从未实体化的会话等于从未存在。

## flush 检查点

`session/event` 是一个*同步*通知；挂载的后端按会话 id 把它路由进活跃写句柄的有界 write-behind 窗口，而不阻塞生产方（后端一次性安装这些监听器，因为持久化已保证每个 id 只有一个活跃写句柄）。第一个待处理事件会开启固定的内部批处理窗口，后续事件会加入但不会重置其截止时间。窗口到期后会通过该会话的写句柄启动一次持久化 `append`；该次写入期间接纳的事件会获得自己的截止时间，并形成后续批次。`session/flush` 会取消等待并排空至完全停稳，因此循环仍将其用作在领取下一个普通轮次之前的顺序与错误观察检查点。后台写入被拒绝时会按序保留对应事件、暂停自动路径，并通过 logger 报告；下一次显式 flush 会重试，并向其调用方响亮地拒绝。`session/disposed` 会执行同样的最终排空并关闭句柄，而 `close()` 本身会经由仍然打开的存储排空已路由的缓冲，因此后端 teardown 的关闭清扫不丢任何数据。该窗口只限制有意的批处理等待，不限制事件循环调度或后端完成持久化的延迟（[决策](../../.agents/notes/implemented/architecture/2026-08-08-bounded-session-persistence-write-batching.zh.md)）。

## 崩溃恢复保留被中断的轮次

一个在轮次中途崩溃的日志以打开的 `turn/start` 而无 `turn/end` 结束。持久化**不会**截断或修复它：在长周期任务中，单个轮次可能非常庞大（许多步骤、大量工具输出），而这些事件在崩溃前已被持久追加。它返回物理上有效的连续日志；只有撕裂物理尾部——属于一次从未完成的 append——中不完整的碎片会被丢弃：从中恢复的完整记录（JSONL 后端会部分解码撕裂的 Zstandard 帧）由写路径在句柄的第一次新 append 之前持久重写。修复是读方的职责：resume（agent-loop）通过其写句柄读取已存储的日志，计算 `interruptedTurnClosers`——缺失的工具错误、任何未闭合的 `step/end`，以及一个合成的 `turn/end { reason: { kind: 'interrupted' } }`——并在发布 Session 之前把它们作为普通批次通过同一句柄追加。`interrupted` 是唯一一个不由循环发出的 `TurnEndReason`（见 [session.md](session.zh.md#why-a-turn-ended-turnendreasonmap)）。

因此修复只在写所有权之下写入：活跃会话的写句柄由其生命周期所有者持有，故并发的 `open(id, 'write')` 会以 `SessionAlreadyOwnedError` 拒绝，而不是让修复与活跃轮次竞速。只读观察方（session-query）仅在内存中用同样的闭合事件配平被中断的冷日志，不回写任何内容。

只读观察即 `open(id, 'read')`：句柄提供经过验证的连续前缀切片，绝不返回撕裂尾部，且同一句柄上的重复读取绝不会观察到比先前读取更旧的状态。持久化侧不存在已准备 Session 缓存：session-query 拥有自己的冷读缓存，按 `stat().revision` 变更令牌为每个 id 缓存一个已配平的冷 Session，仅在令牌变化时重新读取。该生命周期由[基于句柄的持久化 Agent Note](../../.agents/notes/implemented/architecture/2026-08-27-handle-based-session-persistence.zh.md)定义；[Session 准备阶段决策](../../.agents/notes/implemented/architecture/2026-08-05-session-preparation.zh.md)记录仍然保留的发布边界 `SessionPreparation`。

## `SessionLocation`——拒绝诊断的产物目标

`SessionLocation` 不是面向消费者的查询：日志访问走会话句柄的 `read`。它仅作为拒绝诊断存在，使 `SessionFormatUnsupportedError` 能指出本构建拒绝解读的原始日志。JSONL 提供其项目/会话目录内 transcript（文本记录）的绝对路径；没有逐会话工件的后端则不提供。

```ts type-equiv
/**
 * A backend-resolved, per-session local artifact location. Carried only by
 * refusal diagnostics ({@link SessionFormatUnsupportedError}) so a user can
 * find the raw log a build refused to interpret; it is not a consumer-facing
 * query — log access goes through a session handle's `read`.
 */
interface SessionLocation {
  /** Backend-specific artifact kind, for example `jsonl`. */
  readonly kind: string
  /** Absolute path to this session's backend-owned artifact. */
  readonly path: string
}
```

<a id="sessionheader--metadata-beside-the-log"></a>

## `SessionHeader`：日志旁的元数据

每个会话的元数据与事件日志**分开**存储：header 携带格式版本、cwd 与 `isSeeded` 谱系 bit，含正文的存储值则在其旁边单独携带精确 inherited cut。二者都不进入 `SessionEventMap`，也不会到达 `deriveMessages()`。logical header 通过 `session.header` 附加，Session 则以 `inheritedEventCount` 暴露其 cut。

源码：[`packages/core/session/src/types.ts`](../../packages/core/session/src/types.ts)

```ts type-equiv
/**
 * Immutable validated storage metadata, kept outside the conversation event log.
 */
interface SessionHeader {
  /**
   * On-disk format version, stamped from {@link SESSION_FORMAT_VERSION} when the
   * session is created. A persistence backend rejects any other version on load
   * (no migration — see the constant).
   */
  readonly version: number
  /** The session's id (mirrors the {@link Session}'s id). */
  readonly id: SessionId
  /** Non-negative safe-integer Unix epoch milliseconds when the session was created. */
  readonly createdAt: number
  /** Absolute working directory the session was created in (if any). */
  readonly cwd?: string
  /** The session this one was forked from (seed lineage), if any. */
  readonly parentSession?: SessionId
  /**
   * Whether this Session contains a fork-inherited event prefix. The exact prefix
   * length is Session state rather than ordinary header metadata.
   */
  readonly isSeeded: boolean
  /**
   * Coarse product classification for a session created as a subagent child.
   * This is presentation metadata, not proof that the child is continuable.
   */
  readonly origin?: 'subagent'
  /**
   * Delegation depth: absent (zero) for a top-level session, parent depth + 1
   * for a subagent child. Persisted so a recursion budget survives restart and
   * resume — a runtime-only depth would reset a resumed child to top-level.
   */
  readonly delegationDepth?: number
  /**
   * Id of the agent preset this session's agent was composed from, when the
   * deployment composes per session. Durable because the preset decides the
   * session's tools and prompt: a resume that restored a different composition
   * would replay history the model can no longer act on.
   */
  readonly agentPreset?: string
}
```

## 格式拒绝：本构建无法可靠读取的日志

后端用 `SessionFormatUnsupportedError` 拒绝无法可靠解读的日志，它与 `SessionPersistenceCorruptionError` 区分，因为数据没有损坏。header 的 `version` 比 `SESSION_FORMAT_VERSION` 新时，消息说明方向（"由更新的 harness 写入，请升级 harness 后打开"）；比它旧时说明本构建没有升级路径。本构建生成词汇表（`KNOWN_SESSION_EVENT_TYPES`，由 `gen-persistence-catalog` 生成）之外的事件类型同样被拒绝，除非该事件的信封带 `ignorable: true`：静默跳过一个不认识的必需事件可能改变日志其余部分的解读方式。后端为每个会话保留独立文件时，消息附上原始日志路径，被拒绝的文本仍然可读。JSONL 后端直接从原始 header 行拒绝外来版本，先于本格式版本的 header 形状校验和任何事件行解码，因此结构完全不同的未来格式仍会报告升级方向，绝不会报"损坏"。仓库外后端必须在自己的物理格式入口执行等价的方向感知拒绝。设计理由与推迟建设的升级器链见 [session-log 版本机制 Agent Note](../../.agents/notes/implemented/architecture/2026-08-10-session-log-version-mechanism.zh.md)。

## `CreateSessionOptions`：seed 与元数据

通过 store 创建 `Session` 时会接收 `seed`（初始回放或 fork 历史）、可选的精确 `inheritedEventCount` 与 `meta`（store 整合进 `SessionHeader` 的存储层字段）。store 填充 `version`/`id` 并为 `createdAt` 提供默认值；调用方可以提供已校验的绝对 `cwd`、`parentSession` 谱系、`isSeeded` 谱系标记、可选的粗粒度 `origin`、`delegationDepth`、用于组装该 agent（智能体）的 `agentPreset` 以及已有的 `createdAt`。seeded 创建必须同时显式提供 seed 与精确 cut，因为继承前缀之后还可能存在 child-owned setup event。`origin: 'subagent'` 让产品导航能够隐藏重复的 child 行；它不证明描述符有效，也不证明 child 可以恢复。

```ts type-equiv
/**
 * Options for creating a {@link Session} via the store. `seed` replays/forks
 * an existing event log; `meta` carries the caller-supplied storage fields the
 * store folds into a {@link SessionHeader}.
 */
interface CreateSessionOptions {
  /** Initial replay or fork history supplied at construction. */
  readonly seed?: readonly SessionEvent[]
  /**
   * Exact fork-inherited prefix length when `meta.isSeeded` is true. A
   * constructor seed may also contain child-owned setup events after this cut.
   */
  readonly inheritedEventCount?: SessionLogOffset
  /**
   * Storage metadata read once before publication. `isSeeded` marks fork
   * lineage; supplying replay history alone does not make it inherited.
   */
  readonly meta?: {
    readonly cwd?: string
    readonly parentSession?: SessionId
    readonly createdAt?: number
    readonly isSeeded?: boolean
    readonly origin?: 'subagent'
    readonly delegationDepth?: number
    readonly agentPreset?: string
  }
}
```

因此，回放/fork 的调用方式为 `ctx.agents.create({ sessionId, seed, meta })`——fork 还会随 `meta.isSeeded: true` 提供 `inheritedEventCount`，且只有经 agent-loop 发布的会话才会持久化，且循环会在发布之前通过新会话的写句柄存储 seed；将一个*持久化*会话恢复为活跃 agent 的调用方式为 `ctx.agents.resume({ resumeSessionId })`。

## 准备与恢复所有权

`SessionStore.prepare()` 接收普通创建选项，或通过 `RestoredSessionOptions` 转移所有权的全新的持久化对象图。恢复分支会就地验证并冻结转移来的 header 与事件，因此调用方不得保留可变别名。`SessionPreparation` 随后持有该精确的未发布 Session，直至发布或回滚；dispose 是同步且幂等的。agent-loop 的 resume 通过该会话的写句柄读取已存储的日志，并在准备之前追加所需的 `interruptedTurnClosers`，以此构建这些对象图。

```ts type-equiv
/**
 * Fresh storage values transferred to {@link SessionStore.prepare} without a
 * second serialization copy. Callers retain no mutable aliases.
 */
interface RestoredSessionOptions {
  /** Fresh detached storage events to validate and freeze in place. */
  readonly seed: SessionEvent[]
  /** Fresh detached storage metadata to validate and freeze in place. */
  readonly meta: SessionHeader
  /** Exact number of fork-inherited leading events decoded from storage. */
  readonly inheritedEventCount: SessionLogOffset
  /** Select the persistence ownership-transfer path. */
  readonly seedSource: 'persistence'
}
```

```ts type-equiv
/** Inputs accepted while constructing an unpublished Session. */
type PrepareSessionOptions =
  | (CreateSessionOptions & { readonly seedSource?: undefined })
  | RestoredSessionOptions
```

```ts type-equiv
/** Options for a preparation whose provider retains unpublished state. */
interface SessionPreparationOptions {
  /** Release provider-owned state when the Session was not published. */
  readonly release?: () => void
}
```

```ts public-api
/**
 * One exact unpublished Session and the provider state that keeps it usable.
 * Disposal is synchronous and idempotent. Providers decide whether release
 * returns the Session to a cache or discards it; publication may consume that
 * state before disposal, making the callback a no-op.
 */
declare class SessionPreparation implements Disposable {
  /** The exact Session to use for setup and publication. */
  readonly session: Session;
  /**
   * Wrap an unpublished Session in one preparation lifetime.
   * @param session - exact unpublished Session.
   * @param options - optional provider release behavior.
   * @returns a preparation disposed after publication or rollback.
   */
  static create(session: Session, options?: SessionPreparationOptions): SessionPreparation;
  /** Release provider state once when this preparation leaves its caller. */
  [Symbol.dispose](): void;
}
```

## 轻量源修订号

派生读取模型的消费方会在加载完整事件日志之前比较一个低开销的不透明修订号。该修订号是来自 `stat`/`list` 的逐后端实例变更令牌：修订号相等可视为日志未变；不相等则不作任何承诺，且写所有权的变动绝不会改变修订号。session-query 以它为键管理冷读缓存；该令牌在 open、read 或 resume 中不起任何作用。

```ts type-equiv
/**
 * Backend-owned token that identifies both one storage source and one revision
 * of a persisted session log.
 */
type SessionPersistenceRevision = Branded<'SessionPersistenceRevision'>
```

```ts type-equiv
/**
 * Lightweight stored-session observation returned by {@link SessionPersistence.stat}
 * and {@link SessionPersistence.list} without reading the full event log.
 */
interface SessionPersistenceSnapshot {
  /** Detached metadata for one stored session. */
  readonly header: SessionHeader
  /** Opaque change token; see {@link SessionPersistence.stat}. */
  readonly revision: SessionPersistenceRevision
  /** Logical event count, when the backend can provide it cheaply from metadata; otherwise absent. */
  readonly eventCount?: number
  /** Physical artifact byte size, when the backend can provide it cheaply (JSONL); otherwise absent. */
  readonly sizeBytes?: number
}
```

可选的 `eventCount`/`sizeBytes` 提示让会话列表的冷空白探测（cold blank probe）仅凭元数据即可限定其工作量（session-controller 配置 `coldBlankProbeMaxEvents`/`coldBlankProbeMaxBytes`），而无需打开任何日志。

## 后端

随产品交付的 provider 实现抽象 `SessionPersistence` 约定（`create`/`open`/`stat`/`list`，逐会话 `SessionHandle` 承载 `read`/`append`/`flush`/`close`，全程可选支持取消），并通过共享的持久化契约套件：

- **[dsh-session-persistence-jsonl](../../packages/session/session-persistence-jsonl)**——逐会话仅追加的逻辑 JSONL 日志，默认存储为带 checksum 的连续 Zstandard frame，也可配置为原始行；具备崩溃安全的原子实体化、逐批 `fsync` 的 append，以及在第一次新 append 之前截断撕裂尾部。`stat`/`list` 携带 `sizeBytes` 与尽力而为的、由 `fs.stat` 派生的修订号。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsessionpersistence--sessionpersistence-abstract-seam"></a>

### `ctx.sessionPersistence` — `SessionPersistence` (abstract seam)

Durable append-only session storage addressed through per-session handles.

Storage semantics shared by every backend: events are contiguous from seq 0 and never rewritten; a torn physical tail is never returned to a reader and is truncated by the write path before its first append; reads validate current-format records only and refuse unknown vocabulary fail-closed. `append` persists best-effort; `flush` — per handle or service-wide — is the durability barrier.

Visibility: a created session is observable through `stat`/`list`/`open` in this process from the moment `create` resolves, even while a backend defers physical materialization (a pure optimization); other processes see the session only once it materializes, and a session that never materialized before a crash never existed. `SessionHandle.flush` forces materialization.

Freshness: once an `append` or `flush` resolves, reads started afterwards on this backend instance observe at least that prefix.

```ts cordis-catalog
/**
 * Create a new stored session and take its write ownership.
 * @param header - the immutable header (id, version, cwd, lineage) to store.
 * @param options - optional cancellation.
 * @returns a `write` handle owned by the caller; close it to release ownership.
 * @throws {SessionAlreadyExistsError} when the id already exists.
 */
abstract create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle>

/**
 * Open an existing stored session.
 *
 * `read` never takes ownership and works while another handle (or process)
 * holds write ownership. `write` atomically claims single-writer ownership;
 * an existing active owner rejects.
 * @param id - the stored session to open.
 * @param access - `read` or `write`.
 * @param options - optional cancellation.
 * @returns the open handle.
 * @throws {SessionPersistenceNotFoundError} when the session does not exist.
 * @throws {SessionAlreadyOwnedError} for `write` when ownership is taken.
 */
abstract open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle>

/**
 * Flush every active write handle owned by this service instance in one
 * durability barrier: each handle's routed live events drain durably and
 * its session materializes, exactly as that handle's own
 * `SessionHandle.flush` would. Read handles buffer nothing and are
 * untouched. A handle closed concurrently counts as flushed — close itself
 * drains durably.
 * @returns resolution once every write handle active at the call has flushed.
 * @throws {AggregateError} naming each session whose flush failed; the
 *   remaining handles still flush.
 */
abstract flush(): Promise<void>

/**
 * Observe one stored session without reading its event log or taking
 * ownership.
 *
 * The snapshot's `revision` is an opaque change token comparable only
 * against revisions from the same service instance and session id: equal
 * revisions may be treated as an unchanged log; unequal revisions promise
 * nothing. Write-ownership churn does not change a revision. It exists for
 * derived read-model caches keyed off `stat`/`list`; it plays no part in
 * open, read, or resume.
 * @param id - the stored session to observe.
 * @param options - optional cancellation.
 * @returns the snapshot, or `undefined` when the session does not exist.
 */
abstract stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined>

/**
 * List every stored session visible to this process, in no promised order.
 * @param options - optional cancellation.
 * @returns one snapshot per stored session.
 */
abstract list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]>
```

Types: [SessionId](core.zh.md)

Source: [`packages/session/session-persistence/src/index.ts`](../../packages/session/session-persistence/src/index.ts)
<!-- END GENERATED cordis-surface -->
