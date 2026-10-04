# Agent Note: 领域 KV 存储能力 seam 与 workspace 实体

Status: proposed

[English](2026-07-24-domain-kv-storage-and-workspace.md) | 中文

## 问题

host 侧唯一的持久化面是 session 事件日志（`packages/session/session-persistence`：仅追加、一 session 一文件）。凡是"不属于某个 session"的信息就没有落盘处，存在两个已交付需求：

- **workspace 实体**。GUI 要把 workspace 做成真实对象：路径、标题、关联 session 清单。归属关系由 workspace 持有——"哪些 session 属于这个 workspace"不是任何单个 session 自己的事实，塞进 session log 语义不成立。在本设计之前，workspace 只是 sidebar 上按 cwd 分组的视觉概念，没有实体。
- **session 动态元信息**（可预见的第二个消费方）。冷会话列表只读日志首行 header（创建时的不可变快照），title、结束状态这类随会话推进变化的信息拿不到；补齐方向是 sidecar 元数据表——正是一张按 key 高频点更新的 KV 表。

另外，Session 删除需要 `SessionPersistence` 删除原语和 `session.delete` 端点。该空白的设计随本 Note 定案，但实现仍属未来工作。

[Workspace 参考](../../../../packages/workspace/workspace/README.zh.md)定义非破坏性的注册记录移除：删除 Workspace 注册记录会保留相关 Session 及其日志，Session 删除仍是独立的未来工作。因此，下文的级联设计并不是 Workspace GUI 的删除语义。

## 方案

新建 `packages/storage/` 组——`ctx.storage` 存储枢纽（后端注册面 + 数据形式挂载面）、两个后端、domain 领域数据形式——及 workspace 消费方包；给 `SessionPersistence` 扩删除原语。

| 包 | 路径 | ctx 面 | 本期 |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-storage` | `packages/storage/storage/` | `ctx.storage`（枢纽） | ✓ |
| `@deepseek-ai/dsh-storage-json` | `packages/storage/storage-json/` | 注册后端 `json` | ✓ |
| `@deepseek-ai/dsh-storage-sqlite` | `packages/storage/storage-sqlite/` | 注册后端 `sqlite` | ✓ |
| `@deepseek-ai/dsh-storage-domain` | `packages/storage/storage-domain/` | 挂载 `ctx.storage.domain` | ✓ |
| `@deepseek-ai/dsh-workspace` | `packages/workspace/workspace/` | `ctx.workspaceRegistry` | ✓ |
| `SessionPersistence.delete` 扩面 + 级联删编排 | `packages/session/*` | 既有 seam 新方法 | ✗ future work（本期不动 session 侧） |
| `workspace.*` / `session.delete` RPC、GUI 接线、boot 组装 | — | — | ✗ 下期 |

（workspace 放独立组不放 `packages/host/`：host 组命名规则要求 `dsh-host-*` 前缀，而包名定为 `dsh-workspace`；且 workspace 实体是领域概念，不绑定 host 装配层。与既有 `agent-instructions` 包无关——那是 AGENTS.md 指令加载器。）

依赖方向：`dsh-workspace` → `dsh-domain` → `dsh-storage` ← 两后端。`dsh-workspace` 另依赖 `ctx.sessionPersistence` 的只读面（attach 的 cwd 校验读 session header；服务缺席时 attach 直接拒绝——无法校验即不写账）。session 删除相关的 `ctx.sessions` 运行中检查随级联删一并归入 future work。

### `dsh-storage`：存储枢纽

纯注册枢纽，自身不做 IO，无 Config。`Storage` 服务挂 `ctx.storage`，两个面：`backend`（`BackendRegistry`：`register(name, backend)` 返回 disposer、重名 throw；`get(name)` 未知名 throw `backend-not-found`）与数据形式挂载（`mount(form, facility)` 配 merge-extensible 的 `StorageForms` map，`dsh-domain` merge 进 `domain` 键；未挂载访问 throw `form-not-mounted`）。签名正文见 `packages/storage/storage/src/index.ts` 与 `src/registry.ts`。

**多后端同时挂载**；域→后端的选择是 `dsh-domain` 的配置（见下），不是全局二选一。disposer 语义 = 从表中摘名；后端自身的 close 由后端包的 effect 闭包负责，顺序先摘名后 close。

一个后端是一个**介质 owner**（一棵文件树 root / 一个 db 文件），通过**数据形状 facet** 暴露原语——本期只有 `kv`；session 迁移期加 `log`（见迁移节）。facet 是可选成员，缺席即该后端不支持该形状，解析时 fail loud。`kv` facet 的原语面：`open(descriptor)`（descriptor = 名字/版本/表名清单/有无 global，名字与表名限 `^[a-z][a-z0-9_]*$` 兼作文件名与 SQL 表名段）返回 unit，unit 提供 `loadAll` / `putRecord` / `deleteRecord`（缺 key 为 no-op）/ `setGlobal` / `close`（幂等）；值对后端是不透明 JSON。规范正文（含逐方法 JSDoc）在 `packages/storage/storage/src/backend.ts`。

后端约定（共享约定测试逐条断言，两后端同套件）：

1. `open` 对不存在的介质创建（懒物化允许：可延迟到首写，但 `loadAll` 立即可用返回空表）；对已存在介质载入。
2. 介质上版本 ≠ descriptor.version → `StorageError('version-mismatch')`，不迁移不重建。
3. 持久性：写原语 resolve 后进程崩溃再 open，`loadAll` 必须反映该写入。
4. 后端不承诺 unit 内写并发序——**调用方负责串行**；后端只保证单次调用原子（JSON 整文件替换 / SQLite 单语句）。
5. `deleteRecord` 幂等；`putRecord` 覆写。
6. 任意字符串 key / 任意 JSON 值安全（key 不进文件路径，结构性质）。
7. `close` 幂等；close 后任何操作 → `StorageError('closed')`。

错误词汇是带 code 判别的 `StorageError`，码表：`backend-not-found` / `form-not-mounted` / `duplicate-backend` / `duplicate-mount` / `version-mismatch` / `malformed-medium` / `closed`（`packages/storage/storage/src/error.ts`）。

### `dsh-storage-json`

Config 仅 `root`（必填无默认，schemastery）；apply 在 `ctx.effect()` 里注册后端 `json`，disposer 先摘名再 `backend.close()`。

- 布局 `<root>/<unitName>.json`，一 unit 一文件；目录 0o700、文件 0o600。
- 文件格式（版本戳在头，文件即当前净值，`JSON.stringify(…, null, 2)` 肉眼可读——这是该后端的存在理由）：

```json
{
  "unit": { "name": "workspace", "version": 1 },
  "global": null,
  "tables": { "workspaces": { "<key>": {} } }
}
```

- 写入：任何一次写原语 = 内存态全量序列化 → temp 写 + fsync → rename 原子发布（Windows 变体照抄 session-persistence-jsonl 的 win32 路径）。内存态是权威，盘是投影。
- `loadAll`：open 时整文件 parse；缺 `unit` 头、tables 非对象等 → `malformed-medium`。文件不存在 = 空单元，首写才落盘。

### `dsh-storage-sqlite`

Config 为 `path`（必填，`':memory:'` 允许）+ `journalMode`（枚举，默认 `wal`）；apply 同 json，注册后端 `sqlite`。

- `node:sqlite` `DatabaseSync`；打开序列为 mkdir 0o700 → 不存在则 `open(path,'wx',0o600)` 独占建文件 → `PRAGMA foreign_keys=ON` → journal_mode → 版本检查 → 建表。
- 物理布局版本 `STORAGE_SQLITE_SCHEMA_VERSION = 1` 存 `PRAGMA user_version`：0 → 盖章；≠ → `version-mismatch`。
- DDL（全 STRICT；表名由受限字符集拼接加 `u_` 前缀，杜绝外部输入进 DDL）：

```sql
CREATE TABLE IF NOT EXISTS units (name TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS unit_globals (
  unit TEXT PRIMARY KEY REFERENCES units(name), value TEXT NOT NULL) STRICT;
-- One table per unit/table pair:
CREATE TABLE IF NOT EXISTS "u_<unit>_<table>" (
  key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;             -- value = record JSON document
```

- unit 版本存 `units` 行，descriptor 不符 → `version-mismatch`。行粒度 document-per-row，保住按 key 精确落盘更新（为 session sidecar 这类高频点更新大表留路）；查询需求出现时 JSON1 直查 value 列。
- 写原语单语句即原子，无跨语句事务需求（domain 层无跨表事务，见不做清单）。

### `dsh-domain`：领域数据形式

单实现不抽象；消费方只依赖这层，不直接触后端。

```ts ignore-check
export const Config = z.object({
  backend: z.string().required(),                // required default backend name
  routes: z.dict(z.string()).default({}),        // per-domain override: { workspace: 'sqlite' }
})

export function apply(ctx: Context, config: Config) {
  ctx.effect(() => ctx.storage.mount('domain', new DomainFacility(ctx, config)))
}
```

（facility 卸载顺序：先 dispose 各域（排空写链）再从枢纽摘名——排空期间在途写仍发 `domain/changed`，因此此时域名仍须可解析。）

域声明（spec 对象由拥有该域的包定义导出，是类型与运行时的唯一真源；schema 用 zod，`z.infer` 推导类型不重复声明——记录模型下期要投影成 RPC wire schema，wire 边界全是 zod；schemastery 仍只管插件 Config）：

```ts ignore-check
export interface DomainGlobalSpec<G> { readonly schema: ZodType<G>; readonly initial: G }
export interface DomainTableSpec<K extends string, V> { readonly valueSchema: ZodType<V> }

export interface DomainSpec {
  readonly name: string                          // ^[a-z][a-z0-9_]*$
  readonly version: number
  readonly global?: DomainGlobalSpec<unknown>
  readonly tables: Record<string, DomainTableSpec<string, unknown>>
}

export function defineDomain<S extends DomainSpec>(spec: S): S
export function domainTable<K extends string, V>(schema: ZodType<V>): DomainTableSpec<K, V>
```

`DomainFacility.open(spec)` 精确语义（顺序执行，任一步失败即整体失败）：

1. 同名域已打开 → `DomainError('already-open')`。
2. 后端名 = `config.routes[spec.name] ?? config.backend`；`ctx.storage.backend.get(name)`（未挂载穿透 `backend-not-found`——misconfiguration fails loud）。
3. 后端无 `kv` facet → `DomainError('facet-unsupported')`。
4. `kv.open(descriptorOf(spec))`（descriptor 由 spec 直接投影）。
5. `loadAll()`；每条记录 `valueSchema.parse`，global 过 schema（null 取 `initial`，不落盘，首写才落盘）。失败 → `DomainError('invalid-record', { table, key })`（durable 边界必须校验；写侧不重复校验）。
6. 构造 `Domain` 并注册 `ctx.effect()`：disposer 排空写链 → `unit.close()`。

```ts ignore-check
export interface Domain</* inferred from spec */> {
  readonly name: string
  readonly global: { get(): G; set(value: G): Promise<void> }   // only when spec.global exists
  table<N extends keyof S['tables']>(name: N): KvTable<KeyOf<N>, ValueOf<N>>
}

export interface KvTable<K extends string, V> {
  get(key: K): V | undefined                     // synchronous in-memory snapshot
  entries(): IterableIterator<[K, V]>
  keys(): IterableIterator<K>
  readonly size: number
  put(key: K, value: V): Promise<void>
  delete(key: K): Promise<boolean>               // false when already absent
  /** Atomic read-modify-write on the domain's single write chain; fn is sync-pure. */
  update(key: K, fn: (current: V) => V): Promise<V>   // missing key -> DomainError('missing-key')
}
```

规则：

- **一级 mapping**：key → 记录，不做嵌套表；层级需求用复合 key 或值内字段。两后端因此同构（JSON object 一层 ↔ SQLite 一行）。
- **记录是纯数据**：可直接 JSON 序列化的不可变 POJO；`get`/`entries` 返回值不得原地改（TypeScript readonly 投影，不做运行时冻结）。带行为的领域对象属于消费方包。
- **写串行**：域内一条 promise 链，`put`/`delete`/`update`/`global.set` 全排队；`update` 的 fn 在链上执行，并发不交错。不做 active-record（取出可变对象自动落盘——落盘时机不可控，与整域原子覆写冲突）。
- **版本 fail loud**：盘上版本与 spec 不符直接报错，不迁移不重建（数据不可再生，pre-release 拒绝旧格式）。
- **变更事件**：每次写落盘 resolve 后 emit `domain/changed`（`@mode emit`），逐条发、不带旧值（对齐仓库"新快照 + 操作判别"惯例，范本 `goal/changed`）；payload `DomainChanged` 是 put/deleted 判别联合——域名 + 表名 + key（global 变更两者为 `''`）+ operation，put 支带新快照 value、deleted 支无 value（`packages/storage/storage-domain/src/events.ts`）。此为下期 RPC 推帧的事件源。错误词汇 `DomainError`，码表：`already-open` / `facet-unsupported` / `invalid-record`（带 `{ table, key }`）/ `missing-key` / `closed`。

### Future work：session 侧删除（设计定案，本期不实施）

本节是定案的施工规范，实施期不动语义只动代码；本期 session-persistence 的任何文件都不修改。

```ts ignore-check
export abstract class SessionPersistence extends Service {
  /**
   * Permanently delete one session's stored log.
   * Queued on the per-id write chain (serialized with in-flight appends).
   * Unknown id → reject; un-materialized create intent → cancel it and resolve.
   * After deletion the id behaves as unknown for every subsequent operation.
   */
  abstract delete(id: SessionId): Promise<void>
}
```

- JSONL 后端：unlink 该 session 文件（含 `.zstd` 变体）；文件与 intent 均无 → reject。
- 仓库外后端在自己的介质中原子删除，并保留相同的未知 id 与已取消 intent 结果；本提案不定义其他 first-party 物理路径。
- 删除成功后 emit `'session-persistence/deleted'(id: SessionId)`（`@mode emit`；session-persistence 层事件面，与 `domain/changed` 无关）。派生数据（session-query 全文索引等）订阅自清；持久层不直连索引，崩溃窗口靠派生索引可丢弃重建兜底。

编排层规则（随级联删一起实施；`session.delete` RPC 与 workspace 级联复用同一规则）：

| 检查（按序） | 不满足时 |
| --- | --- |
| 目标（递归时含整棵子树）无一在 `ctx.sessions` 运行 | throw，什么都不删；调用方先 cancel 再删，持久层不反向牵动运行时 |
| 非递归时目标无后代（后代 = `parentSessionId` 传递闭包，由 `list()` header 求得） | throw：默认只能删叶子，`recursive: true` 显式递归 |
| 递归序自底向上（叶→根） | ——中途崩溃只留"子树删一半、祖先在"，重跑收敛，任何时刻无悬空 parent |
| 级联中某 id 已不在盘上 | 跳过（幂等续删）；其余错误中止 |

### `dsh-workspace`

包拥有 `WorkspaceId` brand，暴露 `ctx.workspaceRegistry`。记录 key 为生成的 uuid——path 不做 key：规范化会改写它，引用锚点必须稳定。

```ts ignore-check
export type WorkspaceId = Branded<'WorkspaceId'>
export function WorkspaceId(id: string): WorkspaceId

const workspaceRecord = z.object({
  path: z.string(),                              // realpath，见下
  title: z.string(),
  sessionIds: z.array(z.string().transform(SessionId)),
  createdAt: z.string(),                         // ISO
  updatedAt: z.string(),
})
export type WorkspaceRecord = z.infer<typeof workspaceRecord>

export const workspaceDomainSpec = defineDomain({
  name: 'workspace', version: 1,
  tables: { workspaces: domainTable<WorkspaceId, WorkspaceRecord>(workspaceRecord) },
})

declare module 'cordis' { interface Context { workspace: WorkspaceRegistry } }

export interface Workspace {
  readonly id: WorkspaceId
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly SessionId[]      // 唯一真相且有序：数组序即展示序
  setTitle(title: string): Promise<void>
  /** Record a session under this workspace (idempotent). Rejects when the session
   *  header's cwd (realpath) differs from this workspace's path. */
  attachSession(sessionId: SessionId): Promise<void>
  detachSession(sessionId: SessionId): Promise<void>
  /** Live directory check, uncached. */
  status(): Promise<'ok' | 'missing-dir'>
}

export class WorkspaceRegistry extends Service {
  constructor(ctx: Context)                      // super(ctx, 'workspaceRegistry')
  // start(): this.domain = await ctx.storage.domain.open(workspaceDomainSpec)
  //          实体缓存 Map<WorkspaceId, WorkspaceEntity> 重建
  create(path: string, title?: string): Promise<Workspace>   // realpath 后撞已有 → reject
  get(id: WorkspaceId): Workspace | undefined
  list(): Workspace[]
  resolveByPath(path: string): Promise<Workspace | undefined> // 同 realpath 口径，故 async
  delete(id: WorkspaceId): Promise<boolean>      // 只删注册记录；目录与 session 日志保留
}
```

- **path 规范**：落盘值 = `fs.realpath(输入)`（尾斜杠、`..`、符号链接全解析）；唯一性 = 规范化后字符串相等（符号链接指向同一目录算撞）。目录不存在时 create 直接 reject（realpath 失败——workspace 必须指向存在目录；"Create new = 建目录"是上层交互，先 mkdir 再 create）。attach 校验的 session cwd 同口径。cwd 单值 + path 唯一 ⇒ 一个 session 结构上最多归属一个 workspace，双重记账写侧不可能。
- **title**：显示名，默认 `basename(path)`，可改，允许重复。归属不用 cwd 派生兜底——cwd 表达不了排序，归属是 workspace 侧事实；headless 直开的 session 不属于任何 workspace。
- 消费方只见 `Workspace` 接口，`WorkspaceEntity` 不出包（单实现不预拆 seam）；实体按 id 唯一（注册表缓存），记录快照写后原地换新，外部只见 getter；所有写收敛到实体内 `mutate(fn)` → `table.update`，`updatedAt` 在 mutate 内统一刷。领域对象不过 RPC，下期 wire 层把记录投影成 zod wire schema。
- **Session 删除仍属未来工作。** [Workspace 注册表](../../../../packages/workspace/workspace/README.zh.md)将 `ctx.workspaceRegistry.delete(id)` 作为仅删除元数据、保留 Session 与日志的操作交付。递归删除 Session、运行中检查和崩溃重跑收敛属于独立的 `session.delete` 能力。

一致性口径（账 = 归属唯一依据；实现与测试基准）：

| 情形 | 行为 |
| --- | --- |
| 账中 id 盘上无 session | `list()`/实体投影时过滤；下次任何 mutate 顺手摘除；不报错（删除崩溃一致性的正常产物） |
| session cwd 匹配某 workspace 但未上账 | 不属于：不合并不收编。GUI 将来可做"游离 session"专区（游离 = 全部账的补集） |
| 同一 session 上两本账 | 写侧结构性堵死（attach 校验）；load 检出 → throw（外部手改数据，不掩盖） |
| workspace 目录不存在 | 记录与账保留，`status()` = `'missing-dir'`；存储层不自动删（目录可能只是暂时挪走） |

### 复用与 session 后端迁移展望

**长期方向**：Session-persistence JSONL provider 的纯介质操作可以下沉到 `dsh-storage` log facet（Session package 保留，`SessionPersistence` seam 与 coordinator 语义不动；只移动下层文件操作）。复用动机是让介质层拥有 Windows 原子发布、fsync 语义与独占建文件等文件系统和跨平台工作，业务语义（Session 如何 append、何时 append、append 什么）留在上层。Session 日志是仅追加流，与 KV 形式不同，因此接口保留**介质 owner + 数据形式 facet**，而不强迫二者共用一套原语。

现状复用审计（迁移前就能看清的账）：

| session-persistence 现有逻辑 | 归属 | 处置 |
| --- | --- | --- |
| JSONL：temp 写 + fsync + link/unlink 原子发布、0o700/0o600 权限、Windows 变体（win32.ts） | 纯介质 | 本期 `dsh-storage-json` 直接抄用（整文件原子覆写正是同一套）；迁移期成为共享实现 |
| JSONL：逐行 append、首行 header 快读、zstd 逐帧压缩 | log 形状 | 留在原地；迁移期进 `log` facet |
| coordinator（per-id 写链、懒物化、崩溃修复、flush 屏障） | session 语义 | 永不下沉——事件日志的领域逻辑，在 domain 层对应的是写串行链，各归各 |
| encodeSegment（id 进路径转义） | 介质工具 | domain 侧 key 不进路径用不到；`log` facet（一 session 一文件）迁移时随之下沉 |

**本期不改 Session-persistence 的介质代码**（只加 delete 原语）。未来 log-facet 变更需要自己的 consumer 与证据；上表记录剩余 JSONL 复用边界，但不承诺一定提取。

### 测试矩阵

| 套件 | 覆盖 | 后端 |
| --- | --- | --- |
| 后端约定（共享套件，一次编写两端跑） | 七条约定 + 版本拒绝 + close 幂等 | json、sqlite（`:memory:` + 临时目录） |
| 注册表/mount | 重复注册、未挂载访问、disposer 摘除 | — |
| domain 层 | open 六步语义、schema 拒绝、update 串行（并发交错压测）、`domain/changed` 逐条、global 初值懒物化、路由与 `facet-unsupported` | 任一（json） |
| workspace | create/唯一性/realpath、attach 校验（含 sessionPersistence 缺席拒绝）、一致性口径四情形 | mock domain 或 json |
| session delete 约定（future work，随实施并入 runPersistenceContract） | 未知 id、已删 id 复用、未物化 intent、与在途 append 串行、deleted 事件 | jsonl |

快照：本期无模型可见面与组装面，不新增；下期 RPC 接线时随 `workspace.*` 域补。

### 不做清单

| 不做 | 触发条件 | 返工点 | 预埋 |
| --- | --- | --- | --- |
| Session 删除（`SessionPersistence.delete`、deleted 事件、递归删除、运行中检查） | 破坏性的 Session 删除产品流启动 | 实现 Session 原语及 `session.delete`；与 Workspace 注册记录删除保持独立 | 上文编排规则和拒绝清单仍是基础；Workspace 删除会保留 Session 与日志 |
| `log` facet 与 Session provider 迁移 | 本期后任意期启动 | 有真实 consumer 证明需要时下沉 JSONL 介质操作 | facet 组织保留选项，但不承诺提取 |
| 多进程并发写保护 | 两 host 进程同写一介质 | JSON 后端文件锁；SQLite WAL 天然多进程 | 写全经 domain 单点串行，加锁只动后端 |
| 跨进程变更观测 | GUI 断线重连感知 | revision 模式（抄 session-persistence） | 进程内已有 `domain/changed` |
| 数据迁移 | 首个 tagged release 后模型再变 | 版本号驱动逐域迁移 | 版本号自第一天入介质 |
| 大表性能 | 千级记录域挂 json | `routes` 改指 sqlite，数据手工导一次 | 路由即配置，消费方零改动 |
| 多段 key | 两段 key 消费方出现（每 workspace 每 session 维度数据） | key 泛型换 tuple、SQLite 复合主键、JSON 嵌套层 | 一级表 = 段数 1 特例；不做任意深度嵌套；不拼字符串 key |
| scope 维度 | "每 workspace 一份"的域出现且复合 key 表达不动 | DomainSpec 加 scope + 文件名 scope 段（encodeSegment） | 名字字符集已收紧，文件名不冲突 |
| 跨表原子事务 | 同域两表一次原子操作需求 | `domain.transact(fn)`；JSON 天然原子，SQLite 包事务 | — |
| 二级索引/条件查询 | 内存过滤不动（万级记录） | SQLite JSON1 查 value 列，加只读 query 面 | JSON 后端不陪跑 |
| session 跨 workspace 移动 | 产品需求出现 | attach 校验放宽为"先 detach 后 attach"编排 | — |
| Session 删除 RPC／GUI | 破坏性的 Session 删除产品流启动 | `session.delete` 端点、wire schema 与明确的确认 UI | Workspace RPC／GUI 已独立交付，不再存在级联耦合 |

## 备选方案

- **复用 session-persistence 的 coordinator/后端**：事件日志语义（仅追加、turn 崩溃修复、懒物化）与 KV 覆写语义不匹配；只借其分层思想（协调层持写序、后端只实现最小原语）。
- **workspace 专用存储包，后续再抽 seam**：第二个消费方（session sidecar）已可预见，届时泛化要再动一次接口。
- **domain 与 storage 合为一层**：后端会被迫接触 schema 校验、变更事件、写串行等领域关切；拆开后 storage 后端只做不透明原语（可替换面最小），domain 单实现收敛全部领域逻辑（zod/事件/串行化只写一遍，不随后端翻倍）。
- **整库单后端二选一（学 session-persistence 单 slot 模式）**：否决——存储枢纽要承载多种数据形式，不同形式/域对后端的偏好（肉眼可读 vs 高频点更新）注定分化，单 slot 会逼出"整体换挂 + 手工导数据"的粗粒度动作。代价是按名查找多一步，fail-loud 兜底。
- **JSON 后端 jsonl 追加 + 墓碑 + 压实（compaction）**：temp+fsync+rename 的崩溃安全与 append 等价；覆写让文件永远是净值、肉眼可读，免掉折叠／压实／断行容错。域规模下整写与追加一行同量级。
- **JSON 一表一文件**：覆写下文件粒度不影响写成本，按域合并文件更少，global 单例有落点。
- **SQLite 整域存单行 blob**：任何一条记录变更都重写整域，失去按 key 精确更新——SQLite 相对 JSON 的唯一优势归零。
- **SQLite 按 schema 生成 typed columns**：DDL 生成器过度建设；document-per-row 足够，查询需求出现再议。
- **每域独立 sqlite db 文件**：与仓库一库多表惯例相反。
- **path 作为 workspace key**：规范化/符号链接解析会改写 path；引用锚点必须稳定。
- **归属用 cwd 派生（或与账合并）**：双真相源；cwd 表达不了排序；归属本就是 workspace 侧事实。
- **变更事件带旧值**：仓库变更事件惯例是"新快照 + 操作判别"（唯一例外 fs 的 before/after 是方法返回值而非事件，因旧值事后不可重建且有 diff 消费方）；需要 diff 的消费方自己持有上次快照。
- **删除自动 cancel 运行中 session**：持久层/编排层反向牵动运行时，层次变脏；cancel 机制已存在，调用方组合即可。

## 验收标准

- 测试矩阵本期四套件全绿：后端约定共享套件在 json/sqlite 双端、注册表/mount disposer 语义、domain 层（含 open 六步与路由 fail-loud）、workspace 全语义（create/attach 校验/一致性口径）。
- `ctx.workspaceRegistry` 可在测试组装下完成 create → attach → list → 仅删除元数据的 delete 生命周期。
- session-persistence 包零 diff（本期不动 session 侧的验收线）。
- 本期无新快照（无模型可见面与组装面）；下期 RPC 接线时补。

## 风险

- **仓库持久化面第一个推式变更事件**（session-persistence 靠 revision 轮询）：形态虽有 `goal/changed` 范本，但"存储层发事件"是新先例，下期 RPC 消费时才能验证形态是否合适。
- **JSON 后端整域覆写的规模前提**：若第二个消费方（session sidecar）在路由到 SQLite 前就以千级记录落在 JSON 后端，整写成本会先于预期显现；缓解即 `routes` 改指 sqlite。
- **删除编排对 `ctx.sessions` 的弱依赖**：headless 组装拿不到运行时注册表时按"无热 session"处理，存在窗口（外部进程正在跑该 session）；多进程本就在不做清单内，接受。
- **facet 泛化以未来的 `log` facet 为设计依据但本期不实现它**：存在"预留形状不合身"的风险；缓解是本期后端介质代码按复用审计表的下沉形状组织，`log` facet 真正落地时只动 facet 层。
