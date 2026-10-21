# 会话投影

[English](session-projection.md) | 中文

会话投影 seam 是一项[能力 seam](../capability-seams.zh.md)：领域 host 插件经由它向客户端载体供给按会话的日志派生状态的当前全量值；三方分别是 Service Definition 与注册表（[dsh-session-projection](../../packages/session/session-projection)，`ctx.sessionProjections`）、领域贡献方（每个领域注册一个纯单元）与载体（[dsh-session-controller](../../packages/api/session-controller) 的历史尾页与 `session/projection` 推送帧）。Host 状态读取方在激活期间要求注册表存在。框架负责驱动，领域负责计算：注册表只订阅一次 `session/event`，并把每个已提交事件折叠进每个单元；领域不持有任何订阅，客户端也从不折叠领域事件——它们收到的是成品值。设计权威：[session-projection RFC](../../.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.zh.md)；驱动、缓存与变更流约定：[包 README](../../packages/session/session-projection/README.zh.md)。

源码：[`packages/session/session-projection/src/index.ts`](../../packages/session/session-projection/src/index.ts)

`ProjectionHandle` 在注销后仍保留同步 reader。`stateOf(session)` 用原有单元折叠新提交的事件，不会重新加入全局快照、检查点或通知。必须等待注册完成才能使用 handle。参见[注册生命周期](../../packages/session/session-projection/README.zh.md)。

```ts type-equiv
/** An effect-owned registration with a reader retained independently of registration. */
interface ProjectionHandle<S> {
  /**
   * Read the current state, including after unregistering, by folding new
   * Session events with this handle's original unit. Do not mutate the live value.
   * @param session - Session whose committed events are folded.
   * @returns the projection state at the Session's current cursor.
   */
  stateOf(session: Session): S
  /**
   * Unregister from global drives and snapshots without invalidating this reader.
   * @returns a promise that resolves when this registration is released.
   */
  dispose(): Promise<void>
}
```

[兼容规则](../../packages/session/session-projection/README.zh.md#deprecated-plugin-compatibility)规定旧释放操作、按键读取及其每个键一次的弃用警告。

## 投影单元

`ProjectionDefinition<K, S>` 在各单元内部携带宿主状态类型；注册从 `stateSchema` 推导 `S`，并返回 `ProjectionHandle<S>`。只有客户端可见的 key 合并到 `SessionProjectionMap`，由它约束对应的全量值。`wire` 块使单元对客户端可见，渲染归 slot 体系管，永远不归本层：

```ts type-equiv
/**
 * One domain's state-driven computation unit: a pure synchronous fold plus
 * declarations and an optional client view — never an opaque getter. The framework drives
 * `apply` on every committed session event; the domain holds no
 * subscriptions and owns only the computation. All functions MUST be
 * synchronous (an async unit would tear the carriers' consistency cut), and
 * `state` MUST be plain JSON (the persisted-cache precondition).
 */
interface ProjectionDefinition<K extends string, S> {
  /** The projection key this unit owns. */
  key: K
  /** Validates persisted state before it seeds a fold. */
  stateSchema: ZodType<S>
  /**
   * State for the empty log and its immutable Session metadata.
   * @param header - immutable metadata for the Session being projected.
   * @param inheritedEventCount - exact fork-inherited prefix length.
   * @returns the initial state.
   */
  init(header: SessionHeader, inheritedEventCount: SessionLogOffset): NoInfer<S>
  /**
   * Pure transition: previous state + one committed event → next state. A
   * unit uninterested in an event MUST return the same state reference — an
   * unchanged reference (`Object.is`) produces zero downstream work.
   * @param state - the state covering all prior events.
   * @param event - the next committed session event.
   * @returns the next state (same reference when the event is not the unit's).
   */
  apply(state: NoInfer<S>, event: SessionEvent): NoInfer<S>
  /** Client view. Omit for host-only units. */
  wire?: K extends keyof SessionProjectionMap ? {
    /** Validates the wire payload before it leaves the host. */
    viewSchema: ZodType<SessionProjectionViewValue<SessionProjectionMap[K]>>
    /**
     * State → wire payload (the read-side projection). The live drive keeps
     * the two latest raw results and compares them with `Object.is`; an
     * object-valued view must reuse its reference to suppress publication
     * across internal-only state changes.
     * @param state - the current state.
     * @returns the whole current value for this unit's key.
     */
    view(state: NoInfer<S>): SessionProjectionViewValue<SessionProjectionMap[K]>
    /**
     * Whether a Session summary carries this unit; omitted means `true`.
     * Declare `false` on a key whose map entry carries the
     * `SessionProjectionSummaryExcluded` mark: the runtime key set follows this
     * field, while the client view type follows the mark.
     * @default true
     */
    summary?: boolean
  } : never
  /**
   * Persisted-cache invalidation version: bump whenever the serialized state fields or the
   * fold semantics change, so persisted `(sessionId, key, ver, seq, val)`
   * rows from an older unit are discarded instead of being forward-applied
   * into garbage. Non-negative integer.
   */
  stateVersion: number
}
```

每个对外投影值都是完整读模型。源事件可以携带完整值，也可以携带领域拥有的操作；单元的确定性 `apply` 负责回放，checkpoint 加前向 tail replay 会重建出同一状态。

## 快照与变更流

```ts type-equiv
/**
 * One consistent read cut over every registered client-visible unit for one session.
 * `asOfSeq` is the shared watermark — the seq of the last event every value
 * reflects (`-1` for an empty log).
 */
interface ProjectionSnapshot {
  /** Seq of the last event the values reflect; -1 for an empty log. */
  asOfSeq: SessionSeqCursor
  /** Whole current client value per registered key. */
  values: Partial<SessionProjectionMap>
}
```

```ts type-equiv
/**
 * Change-feed listener: one unit's raw `view` result changed by `Object.is`
 * for one session. `value` is the schema-validated output; `seq` is the
 * unit's watermark at emission (the seq of the event that caused the change).
 */
type ProjectionChangeListener = (
  session: Session,
  key: Extract<keyof SessionProjectionMap, string>,
  value: unknown,
  seq: SessionSeq,
) => void
```

`snapshot(session)` 完全同步：载体在切出页面切片的同一 tick 内读取它，因此 `asOfSeq` 使两次读取使用同一个序号。它只返回客户端视图，并在返回前通过各单元的 `viewSchema` 校验。`handle.stateOf(session)` 可在不计算无关视图的情况下读取一份实时 host 状态；调用方不得修改这一借用引用。state 引用变化时，注册表计算并缓存一次原始 view；只有该结果通过 `Object.is` 判定为变化时才触发变更流，对象 view 若要在仅内部 state 变化时抑制发布就必须保留引用。

## 摘要读取

Session 摘要包含每个已注册客户端视图，但排除 `SessionProjectionMap` 条目带 `SessionProjectionSummaryExcluded<T>` 标记的 key。标记没有运行时表示：它决定客户端视图类型，`wire.summary` 决定运行时键集合，省略即 `true`。map 条目带标记的 key 应声明 `wire.summary: false` 以保持一致；该字段是普通布尔值，类型层不做强制。

`summaryKeys()` 从实时注册派生该集合，并在注册或注销改变 key 表之前持续返回同一实例。摘要消费方把它传给既有的带 key 读取面 —— 缓存 cell 用 `cachedSnapshot(session, keys)`，checkpoint 行用 `viewCheckpoint(rows, keys)`，两者保持各自的水位规则且直接使用 Set、不做复制 —— 因此不存在摘要专用读取面，集合也只有一处定义。

列表行携带的是这个摘要投影，绝不是全量投影：它只承诺摘要键集合，不承诺更多。`snapshot`、`cachedSnapshot` 与 `viewCheckpoint` 在不传 key 子集时仍是完整的，打开的 Session、其 follow 基线与控制基线因此保留每个投影值；`@` 引用只通过同一组带 key 的读取面读取其标签 key。

### 摘要词汇

以下声明构成摘要规则。标记、其剥离、被排除键的判定与摘要值类型声明在纯类型出口；两个读取面共同接受的 key 选择声明在服务模块。

```ts type-equiv
/**
 * One `SessionProjectionMap` entry excluded from Session summary payloads
 * (the Session list row and any other summary read). The mark is type-only;
 * `T` keeps its exact runtime value and wire representation. Wrap only the
 * excluded contributor's own map entry, and place a nullable entry's `null`
 * outside the wrapper (`SessionProjectionSummaryExcluded<Item[]> | null`) so
 * the required symbol cannot absorb that member.
 */
type SessionProjectionSummaryExcluded<T> = T & {
  readonly [sessionProjectionSummaryExcluded]: true
}
```

```ts type-equiv
/**
 * One map entry's client view value: the summary mark stripped. The
 * conditional distributes over a nullable entry's union, so a `| null` member
 * written outside the wrapper survives unchanged.
 */
type SessionProjectionViewValue<T> =
  T extends SessionProjectionSummaryExcluded<infer Value> ? Value : T
```

```ts type-equiv
/** Every client view value, keyed by projection key, with no summary mark. */
type SessionProjectionViewValues = {
  [K in keyof SessionProjectionMap]: SessionProjectionViewValue<SessionProjectionMap[K]>
}
```

```ts type-equiv
/**
 * Keys a Session summary omits: map entries whose non-nullish value carries
 * the summary mark. Nullish members are ignored, so a nullable entry is still
 * recognized when its `null` lives outside the wrapper.
 */
type SessionProjectionSummaryExcludedKey = {
  [K in keyof SessionProjectionMap]:
  NonNullable<SessionProjectionMap[K]> extends SessionProjectionSummaryExcluded<unknown> ? K : never
}[keyof SessionProjectionMap]
```

```ts type-equiv
/**
 * The client values a Session summary carries: every client view value except
 * {@link SessionProjectionSummaryExcludedKey}. A summary read returns these
 * keys only; an opened Session's full snapshot keeps every view value.
 */
type SessionProjectionSummaryValues =
  Omit<SessionProjectionViewValues, SessionProjectionSummaryExcludedKey>
```

```ts type-equiv
/**
 * One read's client-visible key selection: an explicit key list, or a derived
 * set such as {@link SessionProjectionRegistry.summaryKeys}. A set is used as
 * given; only a list is copied into one.
 */
type ProjectionKeySelection =
  | readonly Extract<keyof SessionProjectionMap, string>[]
  | ReadonlySet<Extract<keyof SessionProjectionMap, string>>
```

## 注册表：`ctx.sessionProjections`

`SessionProjectionRegistry`（[签名](#ctxsessionprojections--sessionprojectionregistry)）拥有驱动逻辑：一个 `session/event` 订阅、对所有已注册单元立即执行的 `apply`，以及按会话、按单元保存的水位线缓存。缓存单元惰性构建：若单元在事件产生后才注册，或会话早于注册表存在，第一次访问（事件或读取）会从 `init` 开始折叠内存日志。领域在激活期间等待 `register(definition)`，并保留返回的 handle（句柄）。注册归调用 fiber 所有：最后一次释放会从全局驱动和快照中移除该 key，已有句柄仍可读取。同 key、同版本的注册者共享一个单元；版本不兼容时注册失败。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsessionprojectioncache--sessionprojectioncache"></a>

### `ctx.sessionProjectionCache` — `SessionProjectionCache`

The persisted projection cache service. Opens the `session_projcache` domain at init, checkpoints live sessions on a throttled write-behind (count/interval triggers from Config) plus three mandatory points — session creation, `turn/end`, and session disposal (the live-to-cold moment) — and serves the cached rows for a session header. Every durable write is fail-soft: failures log a warning and the cache self-heals on the next write.

```ts cordis-catalog
/**
 * The zero-I/O listing read: whole values viewed straight from the stored
 * rows (version-matching keys only) of the record bound to the caller's
 * lifecycle. The header is the only identity witness a listing holds, so
 * this face matches the lifecycle identity (`formatVersion`, `createdAt`,
 * `cwd`, `isSeeded`) and not the inherited cut: within one format
 * generation the cut is fixed at fork time, so it distinguishes no
 * lifecycle the other fields do not, and a viewed value never seeds a fold.
 * The view is as stale as the last durable checkpoint but never wrong and
 * never from an unrelated log. Its `asOfSeq` is the lowest watermark among
 * the served rows: the stored record's own position, which the header
 * cannot relate to the log the caller later opens. The Session list
 * therefore labels the block as cached, and the client lets every value the
 * connected Session produces supersede it whatever this number says.
 * @param meta - the listed session's header (identity witness; no log read).
 * @param keys - optional projection keys required by the caller's audience.
 * @returns the viewed block, or `undefined` when no usable row exists for
 *   this lifecycle at the current Session format.
 */
cachedSnapshot( meta: SessionHeader, keys?: ProjectionKeySelection, ): ProjectionSnapshot | undefined

/**
 * Read only a predecessor checkpoint's title as a zero-I/O listing hint.
 *
 * The authoritative Session header supplies the lifecycle identity. A cache
 * checkpoint can lag that log but cannot lead it because writes flush the
 * log first, so a matching predecessor title is a genuine (possibly stale)
 * fact from this Session. The registry still requires the current title
 * projection's row version and schema. No other predecessor projection is
 * exposed: format normalization can change their current meaning, and the
 * {@link cachedSnapshot} / hydration paths continue to reject them.
 * @param meta - authoritative listed Session header.
 * @returns a title-only block at the stored title row's watermark, or
 *   `undefined` when the record is current, newer, unrelated, missing, or
 *   incompatible with the title unit.
 */
cachedPredecessorTitle(meta: SessionHeader): ProjectionSnapshot | undefined

/**
 * Hydrate projection cells for an already-prepared Session without another
 * persistence read. The cache seeds matching rows; the supplied exact log
 * advances every unit to the observation cut. No checkpoint is written
 * because the logical observation may contain recovery events not yet durable.
 * @param session - exact unpublished Session retained by persistence.
 * @param events - exact logical event prefix represented by the observation.
 * @returns all projection values at the event cut.
 */
hydratePrepared( session: Session, events: readonly SessionEvent[], ): ProjectionSnapshot

/**
 * Durably checkpoint one live session NOW (all mandatory points call
 * this; tests and carriers may too). The registry cut is snapshotted at
 * this boundary (states are live references), then the session's record is
 * replaced on the domain's write chain. NOT fail-soft — callers on the
 * fail-soft paths contain it.
 * @param session - the live session to checkpoint.
 * @returns resolution after durability and event emission.
 */
async write(session: Session): Promise<void>

/**
 * Cold-read one session's projections from its complete log. Each unit is
 * seeded from the identity-checked cached rows — the registry skips `apply`
 * for the already-folded prefix (events at or below the row's `seq`) — and
 * the refreshed checkpoint is written back (fail-soft, fire-and-forget), so
 * the first cold read creates the cache row and later ones seed from it.
 * The caller supplies the complete log in seq order: this service never
 * consults the persistence layer.
 * @param meta - the stored session header (identity witness).
 * @param inheritedEventCount - exact inherited prefix length for projection initialization and identity.
 * @param events - the session's complete log, in seq order.
 * @returns the projection cut at the log end.
 */
coldSnapshot( meta: SessionHeader, inheritedEventCount: SessionLogOffset, events: readonly SessionEvent[], ): ProjectionSnapshot
```

Types: [Session](session.zh.md) · [SessionEvent](session.zh.md) · [SessionHeader](persistence.zh.md) · [SessionLogOffset](session.zh.md)

Source: [`packages/session/session-projection-cache/src/index.ts`](../../packages/session/session-projection-cache/src/index.ts)

<a id="ctxsessionprojections--sessionprojectionregistry"></a>

### `ctx.sessionProjections` — `SessionProjectionRegistry`

`ctx.sessionProjections`: the projection unit table and its drive. The service subscribes to `session/event` once; every committed event passes every registered unit's `apply` (eager drive). A changed state reference computes the next client view; the change feed is notified only when its raw result changes by `Object.is`. Cells build lazily — a unit registered after events flowed, or a session older than the registry, folds `init` over the in-memory log on first touch (event or read). Consumers declare `sessionProjections` as a required injection, await registration during activation, and retain its ready handle. Registrants sharing a key share one unit and are counted. The last release removes the unit from live drives, checkpoints, and client snapshots; retained handles still fold new events on demand using the original unit.

```ts cordis-catalog
/**
 * Register one domain's unit on the calling context's fiber. Fiber or handle
 * disposal releases one reference; the final release removes live participation.
 * Retained handles remain readable after release.
 * Callers must await registration before publishing consumers; registration may perform asynchronous work.
 * @param definition - key, state schema, pure unit functions, and stateVersion.
 * @returns an awaitable yielding a ready handle; the callable runtime value is deprecated.
 */
register<K extends keyof SessionProjectionMap, S>( definition: Omit<ProjectionDefinition<K, S>, 'wire'> & { wire: NonNullable<ProjectionDefinition<K, S>['wire']> }, ): Promise<ProjectionHandle<S>>

/**
 * Register one host-only unit. Its state is omitted from client snapshots
 * and always checkpointed like every other unit.
 * Callers must await registration before publishing consumers; registration may perform asynchronous work.
 * @param definition - key, state schema, pure unit functions, and stateVersion.
 * @returns an awaitable yielding a ready handle; the callable runtime value is deprecated.
 */
register<K extends string, S>( definition: ProjectionDefinition<K, S> & { key: Exclude<K, keyof SessionProjectionMap> }, ): Promise<ProjectionHandle<S>>

/**
 * Subscribe to the change feed. The registration is an effect on the
 * calling context's fiber.
 * @param listener - called once per client-visible unit whose raw view changed by `Object.is`, per committed event.
 * @returns the exact disposer that unsubscribes.
 */
onChanged(listener: ProjectionChangeListener): () => void

/**
 * One consistent cut over every registered client-visible unit for one session, read from
 * the watermark cache (missing cells fold lazily over the in-memory log).
 * Fully synchronous — every value and `asOfSeq` reflect the same log
 * position. Each value passes its unit's `viewSchema` before leaving.
 * @param session - the session whose projection values are read.
 * @param keys - optional client-visible outputs; state materialization remains complete.
 * @returns the snapshot; `values` is empty when no selected client-visible unit is registered.
 */
snapshot( session: Session, keys?: ProjectionKeySelection, ): ProjectionSnapshot

/**
 * Read only already-materialized client-visible cells without folding history.
 * Values may trail the live Session and are therefore hints, not a complete
 * baseline. Missing cells are omitted.
 * @param session - attached Session whose cached cells are inspected.
 * @param keys - optional wire keys to view.
 * @returns the lowest common cached cut, or `undefined` when no wire cell exists.
 */
cachedSnapshot( session: Session, keys?: ProjectionKeySelection, ): ProjectionSnapshot | undefined

/**
 * The keys a Session summary carries: every registered client-visible key
 * whose unit does not declare `summary: false`. The returned set is stable —
 * the same instance on every call — until a registration or its disposal
 * changes the key table, so a consumer may hold it across rows. Callers pass
 * it to a key-taking read face such as `cachedSnapshot(session, summaryKeys())`
 * or `viewCheckpoint(rows, summaryKeys())`; those faces use the set as-is.
 * @returns the current summary key set; do not mutate it.
 */
summaryKeys(): ReadonlySet<Extract<keyof SessionProjectionMap, string>>

/**
 * State-level checkpoint of every persisted unit for one session, read
 * from the watermark cache (missing cells fold lazily over the in-memory
 * log). This is the write side of the persisted projection cache: the
 * returned rows are the `(key → {ver, seq, val})` part of the durable
 * `(sessionId, key, ver, seq, val)`
 * rows. Every `val` is a DETACHED structured clone — never the live
 * cell reference: the watermark cache is this registry's authoritative
 * mutable state, and a caller reaching the live reference could corrupt
 * every subsequent snapshot and frame through it (plain JSON by the unit
 * contract, so the clone is total).
 * @param session - the session whose unit states are checkpointed.
 * @returns one row per registered key.
 */
checkpoint(session: Session): ProjectionCheckpoint

/**
 * The stored seq a {@link restore} tail read over `checkpoint` must start
 * at: one event BELOW the lowest usable watermark (a row is usable when
 * its `ver` matches the live unit's `stateVersion`; an absent or mismatched row
 * pulls the floor to `0` — that key must refold the full log). The
 * one-below anchor is load-bearing: the tail then proves how far the
 * stored log still extends, so {@link restore} can detect a log that
 * shrank below a row's watermark (crash-repair truncation) instead of
 * serving the stale row as current — an empty tail read from the anchor
 * yields an end below every watermark and the restore rejects for a full
 * re-read.
 * @param checkpoint - persisted rows for one session (possibly stale or empty).
 * @returns the offset for the stored-log suffix read (`SessionHandle.read`),
 *   or `undefined` when no unit is registered (no read needed —
 *   {@link restore} would serve empty values regardless).
 */
restoreFloor(checkpoint: ProjectionCheckpoint): SessionLogOffset | undefined

/**
 * View a checkpoint's rows without any log read: for every registered
 * client-visible unit whose row's `ver` matches, serve the schema-validated
 * `view` of the schema-validated stored state; mismatched, malformed, or absent rows leave their key
 * absent (a cold or listing consumer treats it as not-yet-available and a
 * fuller read path refolds it). The zero-I/O rung of the read ladder —
 * values are as stale as their rows, never wrong.
 * @param checkpoint - persisted rows for one session (possibly stale or empty).
 * @param keys - optional wire keys to view.
 * @returns whole values per key with a usable row; empty when none.
 */
viewCheckpoint( checkpoint: ProjectionCheckpoint, keys?: ProjectionKeySelection, ): Partial<SessionProjectionMap>

/**
 * Cold read: fold every persisted unit over a stored log suffix, seeding
 * each from its checkpoint row when usable — the one read recipe (cached
 * state + forward tail replay + `view`) applied without a live `Session`.
 * Call with the stored events at or past `restoreFloor(checkpoint)` (a
 * `SessionHandle.read` slice) and that same floor as
 * `baseSeq`; the floor's one-below anchor makes the supplied end honest,
 * so a shrunk log is detected here. A row is usable iff its
 * `ver` matches the live unit's `stateVersion`, it does not predate `baseSeq`
 * (`seq >= baseSeq - 1`), and it does not claim events past the
 * supplied end (`seq <= endSeq`); an unusable row is discarded
 * and its key refolds from `init` — which is only sound over the full
 * log, so a discarded row with `baseSeq > 0` throws (the caller re-reads
 * from seq 0, e.g. after a crash-repair truncation shrank the log below
 * a row's watermark).
 * @param checkpoint - persisted rows for one session (possibly stale or empty).
 * @param events - the stored events with `seq >= baseSeq`, in seq order.
 * @param baseSeq - the seq `events` starts at (its first event's seq when non-empty).
 * @param header - immutable metadata for the Session being restored.
 * @param inheritedEventCount - exact fork-inherited prefix length supplied to unit initialization.
 * @returns the snapshot cut at the supplied log end (`asOfSeq` is the last
 *   supplied event's seq, `baseSeq - 1` for an empty tail) plus the
 *   refreshed checkpoint rows at that cut, ready for a durable write-back.
 */
restore( checkpoint: ProjectionCheckpoint, events: readonly SessionEvent[], baseSeq: SessionLogOffset, header: SessionHeader, inheritedEventCount: SessionLogOffset, ): { snapshot: ProjectionSnapshot; checkpoint: ProjectionCheckpoint }

/**
 * Restore an exact cut and install its states on the supplied prepared Session.
 * A later publication reuses these cells; ordinary live reads and event drive
 * advance any constructor-owned suffix exactly once.
 * @param session - exact prepared Session that owns the restored log prefix.
 * @param checkpoint - persisted rows for this Session lifecycle.
 * @param events - exact events at the observation cut.
 * @param baseSeq - first supplied event sequence.
 * @returns all projection values at the supplied cut.
 */
hydrate( session: Session, checkpoint: ProjectionCheckpoint, events: readonly SessionEvent[], baseSeq: SessionLogOffset, ): ProjectionSnapshot
```

Types: [Session](session.zh.md) · [SessionEvent](session.zh.md) · [SessionHeader](persistence.zh.md) · [SessionLogOffset](session.zh.md)

Source: [`packages/session/session-projection/src/index.ts`](../../packages/session/session-projection/src/index.ts)
<!-- END GENERATED cordis-surface -->
