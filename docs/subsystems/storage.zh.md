# 存储

[English](storage.md) | 中文

存储子系统持久保存一切不属于会话事件日志的数据（会话日志有自己的 seam——见 [persistence.md](persistence.zh.md)）。它是一项可选能力，不属于 agent loop（智能体循环）主干，并按[能力 seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.zh.md) 拆分：枢纽（hub）与 Service Definition（[dsh-storage](../../packages/storage/storage)，`ctx.storage`）、Service Provider（注册为 `json` 的 [dsh-storage-json](../../packages/storage/storage-json) 与注册为 `sqlite` 的 [dsh-storage-sqlite](../../packages/storage/storage-sqlite)），以及 Consumer 数据形式（[dsh-storage-domain](../../packages/storage/storage-domain)，`ctx.storageDomain`，也可经 `ctx.storage.domain` 访问）——它是后端约定的唯一 Consumer，也是其他一切所使用的类型化 API。枢纽自身不做任何 IO：后端拥有介质，数据形式拥有语义，产品包绝不直接触碰后端。设计记录：[领域 KV 存储 Agent Note](../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md)。

源码：[`packages/storage/storage/src/backend.ts`](../../packages/storage/storage/src/backend.ts) · [`packages/storage/storage-domain/src/spec.ts`](../../packages/storage/storage-domain/src/spec.ts) · [`packages/storage/storage-domain/src/events.ts`](../../packages/storage/storage-domain/src/events.ts)

## 枢纽：`ctx.storage`

`Storage`（[签名](#ctxstorage--storage)）是汇合点，不是存储本体。`ctx.storage.backend` 是一张名称 → 后端的表：多个后端并排保持挂载，哪个后端服务哪个消费方由该消费方自己的配置决定（即领域层的路由表），绝不是枢纽全局的选择。`register(name, backend)` 返回 disposer；重复名称与查找未知名称都抛出 `StorageError`。dispose（资源释放）只注销名称——由拥有它的插件在注销之后自行关闭后端。每个后端插件还会发布一个仅用于生命周期的服务键（`storageBackendServiceKey(name)`），数据形式提供方注入它，使自身激活不会与后端注册发生竞态。

数据形式以一张可合并扩展的键 map 挂载到枢纽上：

```ts type-equiv
/**
 * Data forms mountable on the hub, keyed by form name. Form owners extend
 * this map via declaration merging (the domain layer merges
 * `domain: DomainFacility`) and mount the facility in their `apply`.
 */
interface StorageForms {}
```

`mount(form, facility)` 是一个 effect，其 disposer 负责卸载；对同一键的第二次挂载抛出 `duplicate-mount`。`form(form)` 解析已挂载的 facility，在拥有插件加载之前抛出 `form-not-mounted`——组合方应据此安排插件顺序，而不是静默推迟。领域层合并 `domain: DomainFacility`，因此 `ctx.storage.domain` 与 `ctx.storageDomain` 是同一个对象。

## 后端约定

```ts type-equiv
/**
 * One registered backend. A backend owns exactly one medium and shares its
 * lifecycle across all facets; facets are optional members — a backend that
 * cannot serve a data kind simply omits it, and resolution fails loud instead.
 */
interface StorageBackend {
  /** Key-value operations; absent when this backend cannot serve them. */
  readonly kv?: KvFacet

  /**
   * Drain in-flight writes across all open units and release the medium.
   * Idempotent; concurrent and repeated calls resolve once teardown finishes.
   * @returns resolution after the medium is released.
   */
  close(): Promise<void>
}
```

一个后端拥有一个介质（一棵文件树的根目录、一个数据库文件），并提供可选的操作组；`kv` 是唯一已交付的操作组。`KvFacet.open(descriptor)` 打开一个具名 unit——`KvUnitDescriptor` 携带名称、当前格式版本、可选的兼容记录版本、表名清单，以及是否存在全局单例 slot——并返回提供 `loadAll`、`putRecord`、`deleteRecord`、`setGlobal` 和 `close` 的 `KvUnit`。unit 名与表名必须匹配 `UNIT_NAME_RE`（既可安全用作文件名，也可安全用作 SQL 标识符片段）；记录键是任意字符串，绝不进入文件路径。unit 不对并发写入做串行化——顺序由调用方负责——但每次单独调用在介质上都是原子的，且 resolve 后即已持久。`single` 介质上记录的版本不同时拒绝 `version-mismatch`；`per-record` 文档的版本在接受集合之外时读作不存在。无法按该 unit 解析的介质拒绝 `malformed-medium`。[`backend.ts`](../../packages/storage/storage/src/backend.ts) 是逐条款的规范性约定，[`tests/contract.ts`](../../packages/storage/storage/tests/contract.ts) 中的共享一致性套件会针对每个后端检查每项条款。[json 后端](../../packages/storage/storage-json/README.zh.md)以原子方式为每个 unit 整文件重新发布一份人类可读文件；[sqlite 后端](../../packages/storage/storage-sqlite/README.zh.md)在单个数据库中每行存储一份文档，用于频繁更新的数据。

## 声明领域

领域由其拥有包声明一次，形式是一个 spec 对象——它是该领域的身份、布局和记录 schema 的单一来源（schema 用 zod 编写，因此 `z.infer` 让消费方类型无需重复声明）：

```ts type-equiv
/** Static declaration of one domain: identity, version, and record layout. */
interface DomainSpec {
  /** Domain name; must match `UNIT_NAME_RE` (doubles as the backend unit name). */
  readonly name: string
  /** Current domain format version; reads enforce it according to the selected layout. */
  readonly version: number
  /**
   * Medium layout for the backend unit: `single` (the default) stores the
   * whole unit as one document; `per-record` stores each record as its own
   * document, for units whose records are large, sparse, or individually
   * disposable — the projection cache — and scopes version checks per record
   * (an unaccepted record document is discarded, never migrated).
   */
  readonly layout?: 'single' | 'per-record'
  /**
   * Older domain versions whose stored records the current record schemas
   * also accept (the declaring owner vouches for that, typically by
   * declaring the fields older records lack as optional). `per-record` backends
   * read documents stamped with a listed version instead of discarding them,
   * and accept a legacy whole-unit file so stamped for the one-time
   * bootstrap; writes always stamp {@link version}.
   */
  readonly compatibleVersions?: readonly number[]
  /**
   * What `open` does with a stored table record that fails its zod schema.
   * Absent (the default), the whole open rejects with `invalid-record` —
   * right for authoritative data. `'backup-and-skip'` is for domains whose
   * records are disposable derived data: the backend moves the record's
   * document aside (`KvUnit.backupRecord`), the failure is logged with
   * its cause, and the open continues with the record absent. A backend
   * without `backupRecord` (no per-record document to move) falls back
   * to the rejecting default. The global slot always rejects.
   */
  readonly invalidRecords?: 'backup-and-skip'
  /** Optional global singleton slot. */
  readonly global?: DomainGlobalSpec<unknown>
  /** Table declarations keyed by table name; each name must match `UNIT_NAME_RE`. */
  readonly tables: Record<string, DomainTableSpec>
}
```

`defineDomain(spec)` 固定 spec 的字面量类型，并在拥有方的模块加载时、任何介质被触碰之前就明确报错：领域名或表名不匹配 `UNIT_NAME_RE`、版本不是非负整数、global schema 接受 `null`，这些都会抛出（`null` 是介质的「从未写入」哨兵值，可空的 global 一旦存储就无法往返还原）。`domainTable<K, V>(schema)` 声明一张表，其键类型是仅存在于编译期的 phantom 类型（通常是[品牌化 id](core.zh.md#branded-ids)）；`descriptorOf(spec)` 投影出面向后端的 unit 描述符。

## 打开的领域

```ts type-equiv
/** One open domain, typed by its spec. */
interface Domain<S extends DomainSpec> {
  /** Domain name from the spec. */
  readonly name: string
  /** Global singleton handle; a spec without `global` has no usable handle (`never`). */
  readonly global: DomainGlobalHandleOf<S>
  /**
   * Resolve one declared table handle. Handles are stable — repeated calls
   * return the same instance.
   * @param name - Declared table name.
   * @returns the typed table handle.
   */
  table<N extends keyof S['tables'] & string>(name: N): KvTable<TableKeyOf<S, N>, TableValueOf<S, N>>

  /**
   * Close this domain: reject new writes immediately, drain already-queued
   * writes (their events still emit), release the backend unit, then free
   * the domain name for a later open. Idempotent — repeated calls share one
   * teardown. The consumer owns this call (typically as its own `ctx.effect`
   * disposer); the facility closes any domain left open when it unmounts.
   * @returns resolution after the unit is released.
   */
  close(): Promise<void>
}
```

读取是同步的，来自权威的内存态：`KvTable` 暴露 `get`/`entries`/`keys`/`size`（快照迭代器，在排队写入落地期间保持稳定），global 句柄的 `get()` 在第一次 `set` 将 slot 物化到介质之前一直返回 spec 的 `initial`。每次写入——`put`、`delete`、`update`、`global.set`——都在同一条逐领域写链上排队，先在后端完成持久化，再更新内存，最后发出 `domain/changed`；后端写入被拒时内存原样不动，因此读取绝不会偏离介质。`update(key, fn)` 在其写链 slot 上是一次原子的读-改-写（键缺失时拒绝 `missing-key`）；`delete` 一个不存在的键 resolve 为 `false`，不产生写入也不产生事件。返回的记录就是存储的对象本身，不是副本——请经 `put`/`update` 整体替换，绝不要就地修改。

## 领域 facility：`ctx.storageDomain`

`DomainFacility`（[签名](#ctxstoragedomain--domainfacility)）在经过路由的后端之上打开已声明的领域。路由是领域插件的配置，绝不属于枢纽：`backend` 指定必填的默认路由，`routes` 按领域名逐个覆盖。`open(spec)` 按严格顺序执行，每一步失败都使整个调用失败：拒绝已打开或仍在关闭中的名称（`already-open`），解析路由（`backend-not-found`），要求后端具备 `kv` facet（`facet-unsupported`），打开 unit（后端的 `version-mismatch`/`malformed-medium` 原样透传），并按 spec 的 zod schema 校验每条已存储记录和 global（`invalid-record`，附带出错的表与键）。调用方拥有返回的句柄，并用 `Domain.close()` 释放它；插件卸载时仍处于打开状态的领域由 facility 负责关闭，已关闭领域的名称只有在拆除完全结束后才释放出来供重新打开。`get(name)` 是无类型的诊断查找，命中的是每个类型化句柄背后包内私有的 `DomainImpl` 运行时；`closeAll()` 是卸载路径。

## 变更事件：`domain/changed`

每次持久写入都发出一个事件，严格发生在后端确认持久性之后，顺序遵循该领域的写链（[事件条目](#domainchanged--emit)）：

```ts type-equiv
/** Shared location fields of one durable domain change. */
interface DomainChangedBase {
  /** Owning domain name. */
  readonly domain: string
  /** Table name; `''` for a global-singleton write. */
  readonly table: string
  /** Record key; `''` for a global-singleton write. */
  readonly key: string
}
```

```ts type-equiv
/** One durable domain change; a closed union — switch on `operation`. */
type DomainChanged = DomainChangedPut | DomainChangedDeleted
```

`put`（插入、覆写和 global 写入）在 `value` 中携带新快照——绝不携带旧值；需要做差异比较的消费方自行保留上一份快照。`deleted` 是不携带值的墓碑。该事件是通知，不是事务参与者：发出时提交点已经过去，因此同步抛出的监听器会被兜住并记录一条警告，而不会让已经持久的写入被拒绝；发出的值等于发出时刻的内存态。该事件仅限进程内；跨进程的变更推送是一项已记录的限制（[包 README](../../packages/storage/storage-domain/README.zh.md)）。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxstorage--storage"></a>

### `ctx.storage` — `Storage`

The storage hub service. Backends register under `backend`; data forms mount under their `StorageForms` key and are reached as `ctx.storage.<form>`.

```ts cordis-catalog
/**
 * Mount a data-form facility on the hub. Mounting is an effect: the
 * returned disposer unmounts the form.
 * @param form - Form key declared in {@link StorageForms}.
 * @param facility - The facility instance to expose.
 * @returns the disposer that unmounts the form.
 */
mount<K extends keyof StorageForms>(form: K, facility: StorageForms[K]): () => void

/**
 * Resolve a mounted data form.
 * @param form - Form key declared in {@link StorageForms}.
 * @returns the mounted facility.
 */
form<K extends keyof StorageForms>(form: K): StorageForms[K]
```

Source: [`packages/storage/storage/src/index.ts`](../../packages/storage/storage/src/index.ts)

<a id="ctxstoragedomain--domainfacility"></a>

### `ctx.storageDomain` — `DomainFacility`

The mounted domain facility. Opens declared domains over routed backends; one facility instance owns the open-domain table and enforces single-open per domain name.

```ts cordis-catalog
/**
 * Open one declared domain. Steps, each failing the whole call: reject a
 * name that is already open (`already-open`); resolve the backend route
 * (`backend-not-found` passes through from the hub); require its `kv` facet
 * (`facet-unsupported`); open the unit projected from the spec (backend
 * `version-mismatch`/`malformed-medium` pass through); load and validate
 * every stored record against the spec's zod schemas (`invalid-record`
 * with the offending table and key — unless the spec declares
 * `invalidRecords: 'backup-and-skip'` and the unit can move documents aside, in
 * which case the failing record is backed up, logged, and skipped);
 * construct the domain.
 *
 * Lifecycle: the CALLER owns the returned handle and closes it via
 * `Domain.close()` (typically as its own `ctx.effect` disposer) — the
 * facility does not tie the domain to any consumer fiber. Domains still
 * open when the facility unmounts are closed by the plugin disposer.
 * @param spec - The domain declaration, typically from `defineDomain`.
 * @returns the opened domain handle, typed by the spec.
 */
async open<S extends DomainSpec>(spec: S): Promise<Domain<S>>

/**
 * Look up an open domain by name, untyped. Diagnostic surface (the package
 * invariant cross-checks change events against live domain state); typed
 * consumers hold the handle returned by {@link open}.
 * @param name - Domain name.
 * @returns the open domain runtime, or `undefined` when not open.
 */
get(name: string): DomainImpl | undefined

/**
 * Close every domain still open on this facility. The unmount path for
 * consumers that never called `Domain.close()` themselves; closing is
 * idempotent, so double-closing an already-closed domain is harmless.
 * @returns resolution after every unit is released.
 */
async closeAll(): Promise<void>
```

Source: [`packages/storage/storage-domain/src/index.ts`](../../packages/storage/storage-domain/src/index.ts)

<a id="domain-events"></a>

### `domain/*` events

<a id="domainchanged--emit"></a>

#### `domain/changed` — emit

A domain record or the global singleton changed, emitted once per write strictly after the backend acknowledged durability. Events of one domain arrive in its write-chain order.

```ts cordis-catalog
/**
 * A domain record or the global singleton changed, emitted once per write
 * strictly after the backend acknowledged durability. Events of one
 * domain arrive in its write-chain order.
 * @param change - domain, table (`''` for global), key (`''` for global),
 * operation discriminant, and on `put` the new snapshot.
 * @mode emit
 */
'domain/changed'(change: DomainChanged): void
```

Source: [`packages/storage/storage-domain/src/events.ts`](../../packages/storage/storage-domain/src/events.ts)
<!-- END GENERATED cordis-surface -->
