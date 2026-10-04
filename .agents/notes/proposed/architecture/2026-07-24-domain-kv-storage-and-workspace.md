# Agent Note: Domain KV storage capability seam and the workspace entity

Status: proposed

English | [中文](2026-07-24-domain-kv-storage-and-workspace.zh.md)

## Problem

The host's only persistence surface is the session event log (`packages/session/session-persistence`: append-only, one file per session). Anything that does not belong to a single session has nowhere to live, and two shipped needs exist:

- **The workspace entity.** The GUI needs workspace as a real object: path, title, and the list of owned sessions. Ownership belongs to the workspace — "which sessions belong to this workspace" is not any single session's fact, so writing it into the session log is semantically wrong. Before this design, workspace was only a sidebar visual grouping derived from cwd, with no entity.
- **Dynamic session metadata** (the foreseeable second consumer). Cold session listings read only the first log line (an immutable creation-time snapshot); title, terminal status, and anything that evolves with the session is unavailable. The fix direction is a sidecar metadata table — exactly a KV table with high-frequency per-key updates.

Separately, Session deletion needs a `SessionPersistence` delete primitive and a `session.delete` endpoint. That gap's design is settled in this note, but its implementation remains future work.

The [Workspace reference](../../../../packages/workspace/workspace/README.md) defines non-destructive registration removal: deleting a Workspace registration preserves its Sessions and their logs, while Session deletion remains separate future work. The cascade design below is therefore not the Workspace GUI delete semantic.

## Proposal

Create the `packages/storage/` group — the `ctx.storage` hub (backend registry + data-form mounts), two backends, the domain data form — plus the workspace consumer package; extend `SessionPersistence` with a delete primitive.

| Package | Path | ctx surface | This phase |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-storage` | `packages/storage/storage/` | `ctx.storage` (the hub) | ✓ |
| `@deepseek-ai/dsh-storage-json` | `packages/storage/storage-json/` | registers backend `json` | ✓ |
| `@deepseek-ai/dsh-storage-sqlite` | `packages/storage/storage-sqlite/` | registers backend `sqlite` | ✓ |
| `@deepseek-ai/dsh-storage-domain` | `packages/storage/storage-domain/` | mounts `ctx.storage.domain` | ✓ |
| `@deepseek-ai/dsh-workspace` | `packages/workspace/workspace/` | `ctx.workspaceRegistry` | ✓ |
| `SessionPersistence.delete` extension + cascade orchestration | `packages/session/session-persistence*` | new method on the existing seam | ✗ future work (session side untouched this phase) |
| `workspace.*` / `session.delete` RPC, GUI wiring, boot assembly | — | — | ✗ next phase |

(workspace lives in its own group rather than `packages/host/`: the host group's naming rule requires the `dsh-host-*` prefix while this package is named `dsh-workspace`; and the workspace entity is a domain concept, not bound to the host assembly tier. Unrelated to the existing `agent-instructions` package — that is an AGENTS.md instruction loader.)

Dependency direction: `dsh-workspace` → `dsh-domain` → `dsh-storage` ← the two backends. `dsh-workspace` additionally depends on the read-only face of `ctx.sessionPersistence` (attach's cwd check reads the session header; when the service is absent, attach rejects outright — no verification, no bookkeeping). The `ctx.sessions` running-check for session deletion moves into future work together with the cascade.

### `dsh-storage`: the storage hub

A pure registration hub, no IO of its own, no Config. The `Storage` service mounts at `ctx.storage` with two faces: `backend` (a `BackendRegistry`: `register(name, backend)` returns the disposer, duplicate names throw; `get(name)` throws `backend-not-found` for unknown names) and data-form mounting (`mount(form, facility)` over the merge-extensible `StorageForms` map, into which `dsh-domain` merges the `domain` key; unmounted access throws `form-not-mounted`). The signature text lives in `packages/storage/storage/src/index.ts` and `src/registry.ts`.

**Multiple backends stay mounted side by side**; which backend serves a domain is `dsh-domain`'s configuration (below), never a global either-or. Disposer semantics = remove the name from the table; closing the backend itself belongs to the backend package's effect closure, unregister first then close.

A backend is one **medium owner** (a file-tree root / one db file) exposing primitives through **data-shape facets** — only `kv` this phase; the session migration adds `log` (see the migration section). A facet is an optional member: absence means the backend cannot serve that shape, and resolution fails loud. The `kv` facet's primitive surface: `open(descriptor)` (descriptor = name/version/table list/global flag, with names and table names restricted to `^[a-z][a-z0-9_]*$` doubling as file-name and SQL-identifier segments) returns a unit exposing `loadAll` / `putRecord` / `deleteRecord` (missing key is a no-op) / `setGlobal` / `close` (idempotent); values are opaque JSON to the backend. The normative text (with per-method JSDoc) is `packages/storage/storage/src/backend.ts`.

The backend contract (asserted clause by clause by the shared conformance suite, one suite for both backends):

1. `open` creates when the medium holds nothing (lazy materialization allowed: may defer to the first write, but `loadAll` must immediately serve empty tables); loads when the medium exists.
2. A stored version ≠ descriptor.version → `StorageError('version-mismatch')`; no migration, no rebuild.
3. Durability: after a write primitive resolves, a process crash followed by a re-open must observe the write in `loadAll`.
4. The backend does not promise write ordering within a unit — **the caller serializes**; the backend only guarantees each single call is atomic (JSON whole-file replace / SQLite single statement).
5. `deleteRecord` is idempotent; `putRecord` overwrites.
6. Any string key / any JSON value is safe (keys never reach file paths, a structural property).
7. `close` is idempotent; any operation after close → `StorageError('closed')`.

The error vocabulary is `StorageError` with a code discriminant: `backend-not-found` / `form-not-mounted` / `duplicate-backend` / `duplicate-mount` / `version-mismatch` / `malformed-medium` / `closed` (`packages/storage/storage/src/error.ts`).

### `dsh-storage-json`

Config is `root` only (required, no default, schemastery); apply registers backend `json` inside `ctx.effect()`, and the disposer unregisters the name before `backend.close()`.

- Layout `<root>/<unitName>.json`, one file per unit; directory 0o700, files 0o600.
- File format (version stamp in the header; the file is always the current net state, `JSON.stringify(…, null, 2)` human-readable — that legibility is this backend's reason to exist):

```json
{
  "unit": { "name": "workspace", "version": 1 },
  "global": null,
  "tables": { "workspaces": { "<key>": {} } }
}
```

- Writes: every write primitive = full serialization of the in-memory state → temp write + fsync → atomic rename publish (the Windows variant follows session-persistence-jsonl's win32 path). Memory is authoritative, disk is its projection.
- `loadAll`: parse the whole file at open; a missing `unit` header, non-object tables, etc. → `malformed-medium`. A missing file = an empty unit, materialized on first write.

### `dsh-storage-sqlite`

Config is `path` (required, `':memory:'` allowed) plus `journalMode` (enum, default `wal`); apply mirrors json, registering backend `sqlite`.

- `node:sqlite` `DatabaseSync`; the open sequence is mkdir 0o700 → `open(path,'wx',0o600)` exclusive create when missing → `PRAGMA foreign_keys=ON` → journal_mode → version check → create tables.
- Physical layout version `STORAGE_SQLITE_SCHEMA_VERSION = 1` in `PRAGMA user_version`: 0 → stamp; ≠ → `version-mismatch`.
- DDL (all STRICT; table names concatenated from the restricted character set with the `u_` prefix, no external input ever reaches DDL):

```sql
CREATE TABLE IF NOT EXISTS units (name TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS unit_globals (
  unit TEXT PRIMARY KEY REFERENCES units(name), value TEXT NOT NULL) STRICT;
-- One table per unit/table pair:
CREATE TABLE IF NOT EXISTS "u_<unit>_<table>" (
  key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;             -- value = record JSON document
```

- Unit versions live in `units` rows; a descriptor mismatch → `version-mismatch`. Row granularity is document-per-row, preserving precise per-key durable updates (the path left open for high-frequency point-update tables like the session sidecar); when query needs appear, JSON1 reads the value column directly.
- Write primitives are single statements and thus atomic; no cross-statement transactions needed (the domain layer has no cross-table transactions, see the out-of-scope list).

### `dsh-domain`: the domain data form

A single implementation, not abstracted; consumers depend on this layer only and never touch backends directly.

```ts ignore-check
export const Config = z.object({
  backend: z.string().required(),                // required default backend name
  routes: z.dict(z.string()).default({}),        // per-domain override: { workspace: 'sqlite' }
})

export function apply(ctx: Context, config: Config) {
  ctx.effect(() => ctx.storage.mount('domain', new DomainFacility(ctx, config)))
}
```

(Facility unmount order: dispose each domain first (drain its write chain), then remove the name from the hub — in-flight writes still emit `domain/changed` during the drain, so the name must stay resolvable at that point.)

Domain declarations (the spec object is defined and exported by the package that owns the domain — the single source of type and runtime truth; schemas use zod with `z.infer` deriving the types without re-declaration — the record model projects into RPC wire schemas next phase and the wire boundary is all zod; schemastery still owns plugin Config only):

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

`DomainFacility.open(spec)` exact semantics (sequential; any failing step fails the whole open):

1. A domain with this name already open → `DomainError('already-open')`.
2. Backend name = `config.routes[spec.name] ?? config.backend`; `ctx.storage.backend.get(name)` (an unmounted name propagates `backend-not-found` — misconfiguration fails loud).
3. Backend lacks the `kv` facet → `DomainError('facet-unsupported')`.
4. `kv.open(descriptorOf(spec))` (the descriptor is a direct projection of the spec).
5. `loadAll()`; every record passes `valueSchema.parse`, the global passes its schema (null takes `initial`, not persisted — first write materializes). A failure → `DomainError('invalid-record', { table, key })` (the durable boundary must validate; the write side does not re-validate).
6. Construct the `Domain` and register `ctx.effect()`: the disposer drains the write chain → `unit.close()`.

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

Rules:

- **Single-level mapping**: key → record, no nested tables; hierarchical needs use composite keys or fields inside the value. The two backends stay isomorphic as a result (one JSON object level ↔ one SQLite row).
- **Records are plain data**: immutable, directly JSON-serializable POJOs; values returned by `get`/`entries` must not be mutated in place (TypeScript readonly projection, no runtime freezing). Behavior-carrying domain objects belong to consumer packages.
- **Serialized writes**: one promise chain per domain; `put`/`delete`/`update`/`global.set` all queue on it; `update`'s fn runs on the chain, so concurrency cannot interleave. No active-record (pulling out a mutable object that auto-persists — uncontrollable persist timing, in conflict with the whole-unit atomic-rewrite model).
- **Version fails loud**: a stored version differing from the spec throws outright; no migration, no rebuild (the data is not regenerable; pre-release rejects old formats).
- **Change events**: after each write's durability resolves, emit `domain/changed` (`@mode emit`), one per record, no old value (matching the repository's "new snapshot + operation discriminant" convention, template `goal/changed`); the payload `DomainChanged` is a put/deleted discriminated union — domain + table + key (both `''` for global changes) + operation, with the put branch carrying the new snapshot value and the deleted branch carrying none (`packages/storage/storage-domain/src/events.ts`). This is next phase's RPC push-frame event source. The error vocabulary is `DomainError`, codes: `already-open` / `facet-unsupported` / `invalid-record` (with `{ table, key }`) / `missing-key` / `closed`.

### Future work: session-side deletion (design settled, not implemented this phase)

This section is the settled construction spec; the implementation phase changes code only, not semantics. No session-persistence file is modified this phase.

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

- JSONL backend: unlink the session's file (including the `.zstd` variant); neither file nor intent → reject.
- An out-of-tree backend deletes atomically in its own medium and preserves the same unknown-id and canceled-intent results; this proposal defines no other first-party physical path.
- After a successful delete, emit `'session-persistence/deleted'(id: SessionId)` (`@mode emit`; the session-persistence event surface, unrelated to `domain/changed`). Derived data (the session-query full-text index and the like) subscribes and cleans itself; the persistence layer never reaches into indexes, and the crash window is covered by derived indexes being droppable-and-rebuildable.

Orchestration rules (implemented together with the cascade; the `session.delete` RPC and the workspace cascade reuse the same rules):

| Check (in order) | On failure |
| --- | --- |
| No target (the whole subtree when recursive) is running in `ctx.sessions` | throw, delete nothing; callers cancel first then delete — the persistence layer never reaches back into the runtime |
| Non-recursive: the target has no descendants (descendants = the `parentSessionId` transitive closure, derived from `list()` headers) | throw: by default only leaves are deletable; `recursive: true` opts into recursion |
| Recursive order is bottom-up (leaves → root) | — a mid-way crash leaves only "half the subtree deleted, ancestors intact"; re-running the same delete converges, and no dangling parent exists at any moment |
| Some id in the cascade is already gone from disk | skip (idempotent resumption); any other error aborts |

### `dsh-workspace`

The package owns the `WorkspaceId` brand and exposes `ctx.workspaceRegistry`. The record key is a generated uuid — path is not the key: normalization rewrites it, and reference anchors must be stable.

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

- **Path canon**: the stored value = `fs.realpath(input)` (trailing slashes, `..`, and symlinks all resolved); uniqueness = string equality after normalization (a symlink resolving to the same directory counts as a collision). A missing directory makes create reject outright (realpath fails — a workspace must point at an existing directory; "Create new = make the directory" is upper-layer interaction: mkdir first, then create). The session cwd in attach checks follows the same canon. Single-valued cwd + unique path ⇒ one session structurally belongs to at most one workspace; double bookkeeping is impossible on the write side.
- **Title**: a display name, defaults to `basename(path)`, mutable, duplicates allowed. Ownership is never derived from cwd as a fallback — cwd cannot express ordering, and ownership is a workspace-side fact; sessions started headless belong to no workspace.
- Consumers see only the `Workspace` interface; `WorkspaceEntity` stays inside the package (a single implementation does not pre-split a seam). Entities are unique per id (registry cache); the record snapshot is swapped in place after each write, and the outside sees getters only. Every write funnels through the entity's internal `mutate(fn)` → `table.update`, with `updatedAt` refreshed inside mutate. Domain objects never cross RPC; next phase the wire layer projects records into zod wire schemas.
- **Session deletion remains future work.** The [Workspace registry](../../../../packages/workspace/workspace/README.md) provides `ctx.workspaceRegistry.delete(id)` as a metadata-only operation that preserves Sessions and logs. Recursive Session deletion, running checks, and crash-rerun convergence belong to a separate `session.delete` capability.

Consistency doctrine (the ledger = the only ownership authority; the implementation and test baseline):

| Situation | Behavior |
| --- | --- |
| A ledger id has no session on disk | filtered at `list()`/entity projection; pruned by the next mutate; no error (a normal product of deletion crash-consistency) |
| A session's cwd matches a workspace but is not in the ledger | not owned: no merging, no adoption. The GUI may later build an "orphan sessions" area (orphans = the complement of all ledgers) |
| One session in two ledgers | structurally blocked on the write side (attach check); detected at load → throw (externally hand-edited data, never masked) |
| The workspace directory does not exist | record and ledger stay; `status()` = `'missing-dir'`; the storage layer never auto-deletes (the directory may only be temporarily moved) |

### Reuse and the session-backend migration outlook

**Long-term direction**: the pure medium operations inside the Session-persistence JSONL provider may sink into a `dsh-storage` log facet (the Session packages stay; the `SessionPersistence` seam and coordinator semantics do not move — only the file operation layer beneath them does). The motive for reuse: the medium layer owns filesystem operations and cross-platform work such as Windows atomic publication, fsync semantics, and exclusive file creation; business semantics (how a Session appends, when, and what) stay above. A Session log is an append-only stream, a different form from KV, so the interface keeps **medium owner + data-form facets** rather than forcing both through one primitive set.

The current reuse audit (an account already legible before the migration):

| Existing session-persistence logic | Nature | Disposition |
| --- | --- | --- |
| JSONL: temp write + fsync + link/unlink atomic publish, 0o700/0o600 permissions, Windows variant (win32.ts) | pure medium | copied by `dsh-storage-json` this phase (whole-file atomic rewrite is the same protocol); becomes the shared implementation at migration |
| JSONL: line-append, first-line header fast read, zstd per-frame compression | log shape | stays put; moves into the `log` facet at migration |
| coordinator (per-id write chain, lazy materialization, crash repair, flush barrier) | session semantics | never sinks — event-log domain logic whose counterpart here is the domain layer's write chain; each owns its own |
| encodeSegment (id-to-path escaping) | medium utility | unused on the domain side (keys never reach paths); sinks together with the `log` facet (one file per session) at migration |

**This phase does not touch Session-persistence medium code** (only the delete primitive is added). A future log-facet change needs its own consumer and evidence; the table records the remaining JSONL reuse boundary without promising that extraction.

### Test matrix

| Suite | Coverage | Backends |
| --- | --- | --- |
| backend contract (shared suite, written once, run on both) | the seven contract clauses + version rejection + close idempotence | json, sqlite (`:memory:` + temp dirs) |
| registry/mount | duplicate registration, unmounted access, disposer removal | — |
| domain layer | the six open steps, schema rejection, update serialization (concurrent interleaving stress), `domain/changed` per record, global initial-value lazy materialization, routing and `facet-unsupported` | either (json) |
| workspace | create/uniqueness/realpath, attach checks (including rejection when sessionPersistence is absent), the four consistency-doctrine cases | mock domain or json |
| session delete contract (future work, joins runPersistenceContract at implementation) | unknown id, deleted-id reuse, un-materialized intent, serialization with in-flight appends, the deleted event | jsonl |

Snapshots: no model-visible or assembly surface this phase, none added; next phase's RPC wiring brings them with the `workspace.*` domain.

### Out-of-scope list

| Not doing | Trigger | Rework point | Groundwork |
| --- | --- | --- | --- |
| Session deletion (`SessionPersistence.delete`, the deleted event, recursive delete, running checks) | a destructive Session-delete product flow starts | implement the session primitive plus `session.delete`; keep it independent from Workspace registration deletion | orchestration rules and rejection table above remain groundwork; Workspace deletion preserves Sessions and logs |
| The `log` facet and Session-provider migration | any phase after this one | sink JSONL medium operations when a real consumer justifies the facet | the facet organization leaves the option open without committing to extraction |
| Multi-process write protection | two host processes writing one medium | JSON backend file locks; SQLite WAL is natively multi-process | all writes already funnel through the domain's single point; locking touches backends only |
| Cross-process change observation | GUI reconnect awareness | the revision pattern (copy session-persistence) | `domain/changed` already exists in-process |
| Data migration | model changes after the first tagged release | version-driven per-domain migration | versions are on the medium from day one |
| Large-table performance | a thousand-record domain routed to json | point `routes` at sqlite, migrate the data by hand once | routing is configuration; consumers unchanged |
| Multi-segment keys | a real two-segment consumer appears (per-workspace per-session dimension data) | key generics become tuples, SQLite composite primary keys, JSON nested levels | single-level tables are the one-segment special case; no arbitrary-depth nesting; no string-concatenated keys |
| The scope dimension | a "one per workspace" domain appears and composite keys cannot express it | DomainSpec gains a scope declaration + a scope segment in file names (encodeSegment) | the name character set is already restricted; file names cannot collide |
| Cross-table atomic transactions | one business operation touching two tables of one domain atomically | `domain.transact(fn)`; JSON whole-unit rewrite is naturally atomic, SQLite wraps a transaction | — |
| Secondary indexes / conditional queries | in-memory filtering stops scaling (tens of thousands of records) | SQLite JSON1 over the value column, a read-only query facet on the seam | the JSON backend does not follow |
| Moving a session across workspaces | a product need appears | relax the attach check into a "detach first, then attach" orchestration | — |
| Session-delete RPC/GUI | a destructive Session-delete product flow starts | `session.delete` endpoint, wire schema, and explicit confirmation UI | Workspace RPC/GUI is shipped separately; no cascade coupling remains |

## Alternatives considered

- **Reusing session-persistence's coordinator/backends**: event-log semantics (append-only, turn crash repair, lazy materialization) do not match KV overwrite semantics; only the layering idea is borrowed (a coordination layer owns write ordering, backends implement minimal primitives).
- **A workspace-specific storage package, seam extracted later**: the second consumer (the session sidecar) is already foreseeable; generalizing later means touching the interface twice.
- **Merging domain and storage into one layer**: backends would be forced to touch schema validation, change events, and write serialization — domain concerns; split apart, storage backends implement only opaque primitives (the smallest replaceable surface) while the single domain implementation concentrates all domain logic (zod/events/serialization written once, not doubled per backend).
- **JSON backend as jsonl append + tombstones + compaction**: temp+fsync+rename crash safety is equivalent to append; rewriting keeps the file the net current state, human-readable, with no folding/compaction/torn-line tolerance; at domain scale a full rewrite costs the same as appending a line.
- **JSON one file per table**: under whole-file rewrites the file granularity does not affect write cost; merging per domain means fewer files and gives the global singleton a home.
- **SQLite storing a whole domain as one blob row**: any single-record change rewrites the whole domain, forfeiting per-key precise updates — SQLite's only edge over JSON reduced to zero.
- **SQLite generating typed columns from the schema**: a DDL generator is over-engineering; document-per-row suffices, revisit when real query needs appear.
- **One sqlite db file per domain**: contrary to the repository's one-database-many-tables convention.
- **A single whole-store backend choice (the session-persistence single-slot pattern)**: rejected — the hub will carry multiple data forms whose backend preferences (human-readable vs high-frequency point updates) are bound to diverge, and a single slot forces the coarse "swap everything + hand-migrate data" move. The cost is one extra name lookup, backed by fail-loud.
- **path as the workspace key**: normalization/symlink resolution rewrites the path; reference anchors must be stable.
- **Ownership derived from cwd (or merged with the ledger)**: two sources of truth; cwd cannot express ordering; ownership is a workspace-side fact to begin with.
- **Change events carrying the old value**: the repository's change-event convention is "new snapshot + operation discriminant" (the sole exception, fs's before/after, is a method return value rather than an event, because the old value is unrecoverable afterwards and has a diff consumer); consumers needing diffs hold their own previous snapshot.
- **Delete auto-cancelling a running session**: the persistence/orchestration layer reaching back into the runtime dirties the layering; cancel already exists, callers compose it.

## Acceptance criteria

- This phase's four test suites all green: the shared backend contract suite on both json/sqlite, registry/mount disposer semantics, the domain layer (including the six open steps and fail-loud routing), and full workspace semantics (create/attach checks/consistency doctrine).
- `ctx.workspaceRegistry` completes the create → attach → list → metadata-only delete lifecycle under a test assembly.
- Zero diff in the session-persistence packages (the acceptance line for not touching the session side this phase).
- No new snapshots this phase (no model-visible or assembly surface); added next phase with the RPC wiring.

## Risks

- **The repository's first push-mode change event on a persistence surface** (session-persistence polls revisions): the shape has the `goal/changed` template, but "the storage layer emits events" is a new precedent, validated only when next phase's RPC consumes it.
- **The JSON backend's whole-unit rewrite scale premise**: if the second consumer (the session sidecar) lands on the JSON backend at thousand-record scale before being routed to SQLite, the rewrite cost surfaces earlier than expected; the mitigation is exactly `routes` pointing at sqlite.
- **The deletion orchestration's weak dependency on `ctx.sessions`**: a headless assembly without the runtime registry treats it as "no hot sessions", leaving a window (an external process running the session); multi-process is already out of scope, accepted.
- **Facet generalization designed against the future `log` facet without implementing it this phase**: a "reserved shape does not fit" risk; mitigated by organizing both backends' medium code in the sinkable shape from the reuse audit, so when the `log` facet lands only the facet layer moves.
