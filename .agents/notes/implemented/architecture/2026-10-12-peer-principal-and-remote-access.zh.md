# Agent Note: Peer 身份属性与 Remote 方法级访问控制

Status: implemented

[English](2026-10-12-peer-principal-and-remote-access.md) | 中文

## 问题

Host 上的 Remote 方法此前无法得知本次调用代表谁，也无法按调用方限制可调用的方法。[`PeerScope`](../../../../packages/typert/protocol/src/types.ts) 的契约曾写明「Who the Peer is and what it may do are not recorded here」；[Connection](../../../../packages/client/connection/src/rpc-host.ts) 只有一个 operator Peer，`admit()` 对每个通过认证的请求都返回它，`/api` 路由与 interceptor 的 Fetch handler 固定使用它而不使用准入结果；[Gateway](../../../../packages/api/gateway/src/index.ts) 在调用方未给出 Peer 时隐式回退到 `operatorPeer()`。

首个非 owner 调用方是 liveshare 读者。读者请求经 Relay 到达 owner 的 liveshare Host 插件，插件此前在 owner 进程内以 operator 身份分派，owner 的 Session 因此把读者的 prompt 当作 owner 本人的输入。PR #3854 为此把 liveshare 语义塞进 session-controller：请求体携带 `origin`，每条 prompt 都写 required 的 `prompt/origin` 事件并按 requestId 关联，controller 内做来源 fold，`serializeAdmission` 扩到全部 prompt，新增 `api-session/external-admission` 钩子；liveshare 自己维护接口白名单 `READ_ENDPOINTS` 并裁剪 list/follow 结果；前端的 `clientWritePolicy` 定义在 ui-conversation，5 个包三种读法，7 处靠「是否注入某回调」隐藏界面。

需要一套通用机制：

- 调用方身份由 Host 进程内代码赋予，wire 上任何字段都无法设置或覆盖。
- 每条调用路径都显式给出 Peer，不存在隐式兜底。
- 方法级权限在后端一处计算、一处把关；前端读同一份结果决定入口显隐，规则变化时自动同步。
- prompt 投递时身份随用户消息落盘，供之后按 turn 判定发起者。

## 决策

### 范围

| 部分 | 内容 |
|---|---|
| Peer 身份 | `PeerScope.principal` 与 `PeerScope.signal`；唯一 Peer 实现 `Peer`（`OperatorPeer` 改名）与 options 构造；删除 operator 概念与所有隐式 Peer 兜底；`connection.browserPeer`、`connection.createPeer()` 与 `fetch(request, peer)`；已 dispose 的 Peer 一律以 `gateway/peer-disposed` 拒绝；`user-rpc` source 落盘 `principal?` |
| 方法级访问控制 | `@Remote` 的 `resources` 读取函数、`TypertResourceMap` 资源种类与 `typert.resources` 注册表（typert-protocol、typert-registry）；Gateway 把调用与转发事件解析为资源；新包 `@deepseek-ai/dsh-api-remote-access`（Host 面 + Client 面）：按 role、binding 与 policy 的 RBAC 判定 `decide(request)`、列表过滤 `allows()`、index 中的首份快照与访问快照流、access hooks |
| 文档 | 一条代码评审标准与术语 |

### 两层概念：principal 与 peer

| 层 | 概念 | 例子 | 数量关系 |
|---|---|---|---|
| 授权层 | principal：调用方身份，权限判定的依据 | 一份分享授权 token 证明的 `share-viewer{shareId, actor}`；本机用户 `{ kind: 'owner' }` | 一个 principal 对应 N 个 peer |
| 连接层 | peer：一条连接的生命周期作用域 | 浏览器连接、liveshare 读者的一条连接 | 每条连接一个 peer |

| 事项 | 归属层 |
|---|---|
| 方法级权限判定、access hooks、访问快照 | principal |
| `source.principal` 落盘 | principal |
| 订阅、stream、连接期注册（`peer.ctx`） | peer |
| 撤销授权 | 两层：撤权后 policy 不为该 principal 给出 binding，其调用一律被拒；创建方 dispose 其名下全部 peer |

principal→peers 的对应表由创建方持有，例如 liveshare 每份授权一个对象，记录该授权下建立的全部 peer。

### Peer 模型

只有 Peer 一个概念、一个实现，删除 operator 概念。

```text
// @deepseek-ai/dsh-typert-protocol
export interface PeerScope {
  readonly id: PeerId
  /** Connection-lifetime registrations; disposed with the Peer. */
  readonly ctx: Context
  /** Caller identity fixed at creation by in-process Host code; no wire field can set it. */
  readonly principal: Principal
  /** Aborted once the Peer is disposed; Remote streams that speak for the Peer end with it. */
  readonly signal: AbortSignal
  /** Forwarded human-interaction participation; independent of authorization. */
  readonly interactions: 'answer' | 'none'
  dispose(): Promise<void>
}

// @deepseek-ai/dsh-client-connection
export class Peer implements PeerScope {
  constructor(owner: Context, options: { readonly principal: Principal; readonly interactions?: 'answer' | 'none' })
}

interface HostConnectionHandle {
  /** The Peer every authenticated browser connection shares; principal { kind: 'owner' }. */
  readonly browserPeer: PeerScope
  /** Network admission: the admitted Peer or the refusal status. */
  admit(request: ConnectionTrustRequest): PeerAdmission
  /** In-process only; disposed with the Context that read `ctx.connection`, or earlier by dispose(). */
  createPeer(options: { readonly principal: Principal; readonly interactions?: 'answer' | 'none' }): PeerScope
}

interface ConnectionFetchHandler {
  fetch(request: Request, peer: PeerScope): Promise<Response>
}
bridge(req, res, apiHandler, peer, maxRequestBodyBytes?)

// @deepseek-ai/dsh-api-gateway
interface InvokeRemoteRequest { …; readonly peer: PeerScope }                 // was `peer?`
wireStream.open(endpoint, payload, uplink, peer: PeerScope, signal)          // was `PeerScope | undefined`
```

| 规则 | 说明 |
|---|---|
| 每条路径显式给出 Peer | 网络路径由 `admit()` 的结果给出；进程内路径由调用方传入。Gateway 删除 `operatorPeer()` 与 `request.peer ?? …`，不再自建 Peer |
| 浏览器连接共享 `browserPeer` | 所有浏览器连接共享一个 Peer，每个使用处都显式引用 `connection.browserPeer`，不存在兜底变量；页内 Host（webworker-runtime）同样显式传 `browserPeer` |
| Host 进程内自动化 | 需要调用 Remote 方法时用 `createPeer({ principal })` 创建自己的 Peer。目前没有这类生产调用方，因此不预置固定的 Host Peer |
| 多 Peer | `createPeer()` 每次返回独立 Peer；liveshare 将用它为读者的每条连接建一个 Peer（在 #3854 侧接入） |
| 交互参与 | `Peer(owner, { principal, interactions? })` 与 `createPeer()` 省略 interactions 时默认 `answer`。`none` 对所有 principal 拒绝 `$events` 与 `$events/result`；交互模式不赋予方法权限。回答型 owner 能接收并回答 waterfall，非 owner 只能接收 RBAC 授权的广播，不能回答 |
| exact Fetch route | file-upload、present-open、media-references、session-log-export、inspector 等 exact route 不经 Gateway；共享 Fetch handler 对非 owner Peer 一律返回 403 |

### 身份类型

```text
// @deepseek-ai/dsh-typert-protocol

/**
 * Merge-extensible caller identities. Each driver declares its own entry.
 * Every entry is a JSON value with a unique literal `kind`, carries no
 * credential, and is safe to persist in a Session log.
 */
export interface PrincipalMap {
  owner: { readonly kind: 'owner' }
}
export type Principal = PrincipalMap[keyof PrincipalMap]

/**
 * @param invocation - `ctx.invocation`; `undefined` outside a Remote call.
 * @returns the caller's principal when it is not the owner; `undefined` for the
 *   owner and for trusted in-process code outside a Remote call.
 */
export function principalOf(invocation: RemoteInvocation | undefined): Principal | undefined
```

读取入口统一为 `this.ctx.invocation.peer.principal`；owner 判断就地写 `principal.kind === 'owner'`，未知 kind 永远不是 owner。外部 driver 在自己的包内用声明合并扩展 `PrincipalMap`；liveshare 的 `share-viewer{ shareId, actor }` 在 #3854 侧声明，此处不改 liveshare。

### Peer 生命周期与撤权

| 事件 | 行为 |
|---|---|
| Gateway 分派 | 第一步检查 `peer.signal.aborted`，已 dispose 即以 `gateway/peer-disposed` 拒绝。对 HTTP、WebSocket 与进程内路径都生效；wire 路径在读取 payload 之前检查，已 dispose 的 Peer 携带畸形 payload 也得到同一错误码 |
| Peer dispose 时的 stream | Remote stream 方法看到的 signal 并入 `peer.signal`，`$events` 流的生命周期同样并入；WebSocket 照旧以 1001 关闭 |
| Peer dispose 时的 unary | 已在执行的 unary 调用不被取消；之后的调用被拒绝 |
| 撤销授权 | 业务包撤权后 policy 不为该 principal 给出 binding，业务包调用 `invalidate(principal)`；创建方按 principal→peers 表 dispose 全部 peer |

### 方法级访问控制

资源类型与 `@Remote` 的 `resources` 读取函数在 `@deepseek-ai/dsh-typert-protocol`；资源种类在 typert 中与 lookups、Contexts 并列：`TypertResourceMap` 声明种类，`typert.resources` 保存每个种类的默认 wire 字段，lookup 与 Host Context adapter 声明其 wire 身份所属的资源种类。Gateway 把一次调用或一个转发事件解析为它访问的资源。判定、列表过滤与访问快照在新包 `@deepseek-ai/dsh-api-remote-access`（`packages/api/remote-access`），该包不读取任何参数字段。Gateway 与领域包对 remote-access 只做 type-only 依赖并 inject `remoteAccess`，值依赖只有 `dsh-typert-protocol`，不为 remote-access 新增 `package-dependency-policy` 条目。role、binding 与 policy 由业务包定义和注册，liveshare 为首个使用方。除内置的 `global` 外，remote-access 与 Gateway 中不出现任何资源种类名，符合 [`packages/api` 只承载通用编排](../../../../docs/defensive-patterns/remote-and-api.zh.md) 的评审规则。

#### 与 RBAC 的对应

| 本设计 | RBAC / IAM 术语 | 含义 |
|---|---|---|
| principal | Subject / Principal | 调用方身份，`PrincipalMap` 的一个条目 |
| Peer | Session（RBAC 会话） | principal 的一条连接；一个 principal 对应 N 个 Peer |
| owner | 超级用户 | 跳过全部检查 |
| action | Action / Permission | Remote 端点 `ns/method`，或转发事件 `event:<name>`；Gateway 内部仍称端点 |
| resource | Resource / Object | `{ kind: 'global' }`，或某个已声明资源种类的 `{ kind, id }` |
| role | Role | 限定一种资源种类的 action 集合，是业务包的普通值 |
| binding | RoleBinding（角色指派） | principal 在某个资源上拥有某个 role，可附 condition |
| condition | Condition（IAM Conditions） | 挂在 binding 上，按请求的 action、资源与参数放行或带原因拒绝 |
| policy | Allow policy | 业务包为一种非 owner principal kind 给出 binding 与可选 `explain` |
| explain | 拒绝说明 | 没有 binding 放行时给出拒绝原因，不改变结论 |
| Gateway | PEP（Policy Enforcement Point） | 解析资源、执行结论 |
| remote-access | PDP（Policy Decision Point） | 计算结论、列表过滤与访问快照 |

| 规则 | 内容 |
|---|---|
| 默认拒绝 | 非 owner 只有在某个 binding 的 role 显式列出该 action 时才被放行；role 未列出的 action、没有 binding 的资源、没有 policy 的 principal kind 一律被拒。所有 Remote 方法都受访问控制，没有单独的可访问标记 |
| 资源之间无继承 | `global` 不是其他资源的上级：`global` 上的授权不蕴含任何会话或工作区上的授权，工作区上的授权也不蕴含其中会话的授权 |
| `global` 授权即显式全局授权 | 调用解析不出任何资源即访问 `global`。把某个 action 放进 `global` 级 role，等于允许该 principal 不受资源限制地调用它，属高危授权；方法被放行后仍可在内部用 `allows(resource)` 逐项细判 |

#### 资源与资源读取（`@deepseek-ai/dsh-typert-protocol`、`@deepseek-ai/dsh-typert-registry`）

```text
/** Merge-extensible resource kinds: the key is the kind, the value declares its identity type. */
export interface TypertResourceMap {}
//   @deepseek-ai/dsh-session/types:   session: TypertResource<SessionId>
//   @deepseek-ai/dsh-workspace/types: workspace: TypertResource<WorkspaceId>

// Runtime registries in typert
ctx.typert.resources.register(kind, { field }): TypertDisposer
ctx.typert.lookups.register(key, { parameter, wire, resource?, … })   // resource: the kind its wire id names
ctx.typert.contexts.registerHost(key, { wire, resource?, … })         // a TypertHostContextAdapter

export interface TypertHostContextAdapter<Wire = unknown> {
  readonly wire: string
  readonly wireTypeSymbol: string
  /** Resource kind the wire identity names; access checks read the identity from args before resolve(). */
  readonly resource?: TypertResourceKind
  resolve(id: Wire): Context | undefined | Promise<Context | undefined>
}

export type RemoteAccessResourceKind = 'global' | TypertResourceKind
export type RemoteAccessResource =
  | { readonly kind: 'global' }
  | { readonly kind: K; readonly id: TypertResourceId<TypertResourceMap[K]> }   // for each declared kind K
export type RemoteAccessResourceOf<K extends RemoteAccessResourceKind> = Extract<RemoteAccessResource, { readonly kind: K }>

/** Per-kind readers, called with the method's positional wire arguments. */
export type TypertResourceReaders<WireArgs extends readonly unknown[]> = {
  readonly [K in TypertResourceKind]?: (...args: WireArgs) => Id | readonly Id[] | undefined   // Id = TypertResourceId<TypertResourceMap[K]>
}

export interface RemoteMethodOptions<WireArgs extends unknown[]> {
  readonly name?: string
  readonly mode?: 'stream'
  readonly resources?: TypertResourceReaders<WireArgs>
}

export function Remote<This extends object, Args extends unknown[], Result>(
  option: string | RemoteMethodOptions<NoInfer<RemoteWireArgs<Args>>>,
): (method: (this: This, ...args: Args) => Result,
     context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>) => void

export interface RemoteScopeOptions<WireArgs extends unknown[]> {
  readonly name?: string
  readonly resources?: TypertResourceReaders<WireArgs>
}

export function RemoteScope<This extends object, Args extends unknown[], Result>(
  key: Extract<keyof TypertContextMap, string>,
  option?: string | RemoteScopeOptions<NoInfer<RemoteWireArgs<Args>>>,
): (method: (this: This, ...args: Args) => Result,
     context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>) => void
```

| 规则 | 内容 |
|---|---|
| 写法 | `@Remote({ name: 'page', resources: { session: (request) => request.address.kind === 'session' ? request.address.sessionId : request.address.childSessionId } })`；Context 方法写 `@RemoteScope('agent')`，由 Agent Context 的 `resource: 'session'` 得到会话资源，需要其他资源时写 `@RemoteScope('agent', { resources: { workspace: (request) => request.workspaceId } })`。多数方法不写 `resources`，由自动解析得到资源 |
| 资源种类 | 资源种类由声明 id 类型的底层包合并：`session: TypertResource<SessionId>` 在 `@deepseek-ai/dsh-session/types`，`workspace: TypertResource<WorkspaceId>` 在 `@deepseek-ai/dsh-workspace/types`。session-controller 引用 commands 包，若在 session-controller 合并，commands 要引用 session-controller，形成 project reference 环。`global` 由 remote-access 内置，没有 id，不进 `TypertResourceMap`；typert 保留该名，`typert.resources.register('global', …)` 抛错 |
| 默认字段与声明 | 拥有该种类的领域在控制器构造时登记默认 wire 字段：`SessionController` 构造函数调用 `typert.resources.register('session', { field: 'sessionId' })`，`WorkspaceController` 构造函数登记 `workspace` → `workspaceId`；同一种类重复登记即抛错。Agent、Session 与 `workspaceFileScope` lookup 声明 `resource: 'session'`，agent 包的 Agent Context 声明 `resource: 'session'` |
| 解析优先级 | 对每个资源种类依次取：① 该方法 `resources` 中该种类的读取函数；② 声明了该种类 `resource` 的每个 lookup 参数贡献其 wire 身份，省略的可选 lookup 参数不贡献；Context 方法的 Context 声明了该种类 `resource` 时，其 wire 身份同样贡献；③ 该种类的默认字段：命名参数中有同名顶层参数就读它，否则读第一个对象参数的同名字段。默认字段只表示一个身份，读到数组即为非法值 |
| 参数来源 | 资源解析与 `decide()` 的 `args` 读取经 Typert 编译类型校验后的命名参数：每个 JSON 参数由其 codec 解码一次，类型未声明的对象字段被移除，分派复用该值，因此调用方无法用未声明字段改变资源；lookup 参数与 Context 身份取 wire 身份，此时不解析 lookup、不激活 Agent |
| 解析结果 | 各种类的资源合在一起即本次调用访问的资源；一个都没有即 `[global]`；解析出资源时只用这些资源，不附加 `global` |
| 读取函数 | 以方法的位置参数调用：按描述符把命名参数映射回方法参数顺序（JSON 位为校验后的值，lookup 位为 wire 身份，取消参数位为调用的 signal）；返回一个 id、id 数组（每个都须被允许）或 `undefined`（该种类无资源） |
| 非法值 | 读取函数抛错或返回空数组，或读到的值（含 Context 的 wire 身份）不是非空字符串即资源非法：Gateway 不询问 `decide()`，直接以 `remote-access/denied`（reason `resource-invalid`）拒绝调用 |
| 完整性 | `resources` 与自动解析必须覆盖方法访问的全部资源。一个资源都没解析出的调用落到 `global`，只有 `global` 级 role 能放行，因而默认被拒；只解析出部分资源时，其余资源不受检查，持有已解析资源授权的 principal 可越权访问它们，由方法作者负责避免 |
| 类型推断 | `@Remote` 与 `@RemoteScope` 读取函数的参数类型从被装饰方法自动推断：工厂参数用 `NoInfer`，`Args` 只从返回的装饰器推断；lookup 参数按 `TypertLookupMap` 映射为 wire 类型（首个参数为 `agent: Agent` 的方法，其读取函数的第一个参数为 `SessionId`）。访问不存在的属性、参数多于方法参数与 `global` 键均为编译错误 |
| 存放 | `resources` 读取函数与 `@Remote` / `@RemoteScope` 的其他元数据一同存在类原型上，随实例构造登记，跨重复安装安全；不进入 Typert 生成物 |
| Context 方法 | `@RemoteScope(key, option?)` 与 `@Remote` 一致：字符串为导出名，对象为 `{ name?, resources? }`。Context 的 wire 身份按声明了 `resource` 的 lookup 参数参与解析，优先级与 lookup 相同，该种类有 `resources` 读取函数时被覆盖；Gateway 在 `resolveReceiverContext` 之前直接从 args 读取该身份，不激活 Agent。Context 未声明 `resource` 时其身份不贡献资源，方法按普通规则解析 |

#### 端点的资源

下表列出 #3854 读者用到的端点及其资源来源。只有 `session/page` 与 `session/follow` 需要显式 `resources`，其余靠 lookup 的 `resource` 或默认字段：

| 端点 | 资源 | 解析来源 | 方法内过滤 |
|---|---|---|---|
| `workspace/follow` | `global` | 无资源 | 是：工作区与会话 |
| `session/control` | `global` | 无资源 | 是：会话 |
| `session/list` | `global`（`_request` 无 `sessionId`） | 无资源 | 是：会话行 |
| `session/modelCatalog` | `global` | 无资源 | 否 |
| `session/canOpenWorkspacePath` | `global` | 无资源 | 否 |
| `llm/listConfigurableProviders` | `global` | 无资源 | 否 |
| `llm/listProviders` | `global` | 无资源 | 否 |
| `commands/list` | session：`args.agentId`（Agent lookup 的 wire 字段） | Agent lookup `resource: 'session'` | 否 |
| `goals/get` | session：`args.agentId` | Agent lookup `resource: 'session'` | 否 |
| `session/attachment` | session：`args.request.sessionId` | 默认字段 | 否 |
| `skills/list` | session：`args.request.sessionId` | 默认字段 | 否 |
| `session/fork` | session：`args.request.sessionId` | 默认字段 | 否 |
| `session/prompt` | session：`args.request.sessionId` | 默认字段 | 否 |
| `session/cancel` | session：`args.request.sessionId` | 默认字段 | 否 |
| `session/projections` | session：`args.request.sessionId` | 默认字段 | 否 |
| `session/page` | session：Session 地址读 `args.request.address.sessionId`；subagent 地址读 `args.request.address.childSessionId` | `resources` | 否 |
| `session/follow` | 同上 | `resources` | 否 |
| `remoteAccess/follow` | `global` | 无资源；remote-access 对任何 principal 放行 | 否 |

subagent 地址读取的是子会话转录，因此其资源是子会话。Client 在重连后会重新读取已知会话的 projections，其中包括 subagent 会话的父会话；没有该父会话授权的读者，其 projection 读取被拒。父会话的授权是否覆盖其 subagent 子会话由 policy 决定，即是否为子会话给出 binding；通用层不推导父资源。

不需要非 owner 访问的方法不做任何声明，没有 role 列出它即被拒。subagent `prompt` 的请求字段为 `parentSessionId` / `childSessionId`，自动解析不到会话，解析为 `global`，因此不得放进任何 `global` 级 role；`session/search` 在方法内按会话逐项过滤命中。`subagents/list` 不是 Remote 端点（`SubagentRuntime.list()` 未标 `@Remote`）。

#### role、binding 与 policy（`@deepseek-ai/dsh-api-remote-access`）

```text
/** Remote endpoint `ns/method`, or `event:<name>` for one forwarded event; endpoint segments never contain `:`. */
export type RemoteAccessAction = RemoteAccessEndpoint | `event:${string}`

/** A named action set over one resource kind; a plain value owned by the business package. */
export interface RemoteAccessRole<K extends RemoteAccessResourceKind> {
  readonly name: string
  readonly resource: K
  readonly actions: readonly RemoteAccessAction[]
}

/** Answer of decide() and of a condition. */
export type RemoteAccessDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string }

/** Refines one binding for one action on its resource; `args` only for a concrete call. */
export type RemoteAccessCondition<K extends RemoteAccessResourceKind> = (request: {
  readonly action: RemoteAccessAction
  readonly resource: RemoteAccessResourceOf<K>
  readonly args?: Readonly<Record<string, unknown>>
}) => RemoteAccessDecision

/** One role on one resource of the role's kind; the resource type follows from the role. */
export type RemoteAccessBinding = {
  [K in RemoteAccessResourceKind]: {
    readonly role: RemoteAccessRole<K>
    readonly resource: RemoteAccessResourceOf<K>
    readonly condition?: RemoteAccessCondition<K>
  }
}[RemoteAccessResourceKind]

/** One access question; the Gateway passes only valid resources, [global] when none. */
export interface RemoteAccessRequest<P extends Principal> {
  readonly principal: P
  readonly action: RemoteAccessAction
  /** Allow only when the action is allowed on every listed resource. */
  readonly resources: readonly RemoteAccessResource[]
  /** Named arguments of a concrete call, validated against their Typert-compiled types with lookup parameters as wire identities; absent for events, snapshots, and list filtering. */
  readonly args?: Readonly<Record<string, unknown>>
}

/** Business rules for one non-owner principal kind; synchronous over in-memory state. */
export interface RemoteAccessPolicy<P extends Principal> {
  bindings(principal: P): readonly RemoteAccessBinding[]
  /** Reason for a request no binding allows; never changes the decision. */
  explain?(request: RemoteAccessRequest<P>): string | undefined
}

/** details of `remote-access/denied` */
export interface RemoteAccessDeniedDetails {
  readonly action: string
  readonly reason: string
}

class RemoteAccessService {            // ctx.remoteAccess; Remote namespace remoteAccess
  registerPolicy<K extends Exclude<keyof PrincipalMap, 'owner'>>(kind: K, policy: RemoteAccessPolicy<PrincipalMap[K]>): () => void
  invalidate(principal?: Principal): void
  decide(request: RemoteAccessRequest<Principal>): RemoteAccessDecision   // Gateway-only
  allows(resource: RemoteAccessResource): boolean              // reads the accessing ctx's invocation
  snapshotFor(principal: Principal): RemoteAccessBaseline      // a page's opening baseline
  follow(signal): AsyncIterable<RemoteAccessFrame>             // remoteAccess/follow
}
```

| 规则 | 内容 |
|---|---|
| owner | Gateway 对 owner 不解析资源、不调用 `decide()`，也不读取任何 policy |
| 注册 | `registerPolicy(kind, policy)` 返回 disposer，业务包在 `ctx.effect()` 中调用。每个非 owner principal kind 至多一个 policy，同一 kind 重复注册抛错；`bindings()` 与 `explain()` 收到的 principal 按 kind 定型 |
| 内置放行 | `remoteAccess/follow` 对任何 principal 放行，每个 Peer 都能读自己的快照 |
| 判定 | 没有该 principal kind 的 policy 以 `no-allow` 拒绝。否则取 `bindings(principal)`，对请求的每个资源线性扫描找一个 binding：资源相等（`kind` 相同，且非 `global` 时 `id` 相同）、role 的 `actions` 含该 action、没有 condition 或 condition 放行；每个资源都找到才放行（AND）。condition 只对资源相等且 role 含该 action 的 binding 调用 |
| 拒绝原因 | 第一个未被放行的资源决定原因，优先级为：该资源上存在匹配 binding 但其 condition 全部拒绝时，取第一个 condition 的原因；否则取 `explain(request)` 的返回值；没有 `explain` 或其返回 `undefined` 时为 `no-allow`。`explain` 只在结论已为拒绝后调用，不改变结论 |
| 失败隔离 | `bindings()`、condition 或 `explain()` 抛错时，本次判定以 `policy-failed` 拒绝；计算快照时 `bindings()` 抛错即该 principal 没有 grant，condition 抛错即该 action 不放行。有问题的规则因此不会破坏共享的 `$events` 事件源、快照流或页面渲染；每次 `invalidate()` 或 policy 变更之后，每个 policy 的第一次失败只记录一次日志 |
| 同步 | `bindings()`、condition 与 `explain()` 同步返回，状态由业务包预先载入内存，以便列表逐项过滤与快照计算 |
| 求值时机 | 每次 `decide()`、`allows()` 与快照计算都调用一次 `bindings()`，不缓存；依赖时间的状态（如过期）即时生效，长流（如 `workspace/follow`、`session/control`）在 binding 增删后的下一次逐项判定即反映；快照只在 `invalidate()` 后重算，业务包在过期等时间事件发生时也须调用 `invalidate()` |
| 通知 | 业务状态变化（授权、撤权、模式切换）改变 binding 或 condition 的结论时，业务包必须调用 `invalidate(principal?)`；快照只在 `invalidate()` 与 policy 注册、撤回后重算 |
| `remote-access/denied` | 只有调用的拒绝变成错误，details `{ action, reason }`，reason 为 condition 或 `explain` 给出的原因、`no-allow`、`policy-failed`，或 Gateway 对非法资源给出的 `resource-invalid`；被拒的事件只是不推送 |
| 必需服务 | Gateway `static inject = ['typert', 'remoteAccess']`；挂载 Gateway 的组合必须挂载 remote-access，[`bundle/base`](../../../../packages/bundle/base/cordis.patch.yml) 紧随 `typert-gateway` 装配；plugin manager 像保护 Gateway 一样保护它，插件页面无法禁用 |

#### 示例：分享读者

以 liveshare 声明的 `share-viewer` principal 为例，说明业务状态到 binding 的推导留在业务包；示例中的 `shares` 代表业务包在内存中持有的分享状态：

```text
const globalReader    = { name: 'share:global-reader',    resource: 'global',    actions: ['session/list', 'session/control', 'workspace/follow', 'session/modelCatalog', 'llm/listProviders', 'commands/list'] }
const sessionReader   = { name: 'share:session-reader',   resource: 'session',   actions: ['session/page', 'session/follow', 'session/list', 'session/control', 'workspace/follow', 'commands/list', 'event:api-session/status', 'event:api-session/added'] }
const workspaceReader = { name: 'share:workspace-reader', resource: 'workspace', actions: ['workspace/follow'] }
const forker          = { name: 'share:forker',           resource: 'session',   actions: ['session/fork'] }
const writer          = { name: 'share:writer',           resource: 'session',   actions: ['session/prompt', 'session/cancel'] }

ctx.effect(() => ctx.remoteAccess.registerPolicy('share-viewer', {
  bindings(viewer) {
    const share = shares.serving(viewer)              // undefined once stopped, expired, or no longer admitted
    if (share === undefined) return []
    const source = { kind: 'session', id: share.sessionId }
    return [
      { role: globalReader, resource: { kind: 'global' } },
      { role: sessionReader, resource: source },
      ...(share.allowsFork ? [{ role: forker, resource: source }] : []),
      ...(share.mode === 'write' ? [{ role: writer, resource: source, condition: sourceWrite(share) }] : []),
      ...shares.forksOf(viewer).flatMap(child => [
        { role: sessionReader, resource: { kind: 'session', id: child.id } },
        ...(child.revoked ? [] : [{ role: writer, resource: { kind: 'session', id: child.id }, condition: childPrompt(child) }]),
      ]),
      ...shares.workspacesShowing(viewer).map(id => ({ role: workspaceReader, resource: { kind: 'workspace', id } })),
    ]
  },
  explain({ principal, action }) {
    return shares.refusal(principal)                  // 'share-expired', 'share-stopped', …
      ?? (action === 'session/prompt' ? 'share-not-writable' : undefined)
  },
}))

// Without args (snapshots, list filtering) a condition answers for the action alone.
const sourceWrite = share => () => share.confined ? allow : deny('source-write-unavailable')
const childPrompt = child => ({ action, args }) =>
  action === 'session/prompt' && args !== undefined && !child.allowsPrompt() ? deny('fork-prompt-refused') : allow
```

| 归属 | 内容 |
|---|---|
| 业务包 | role 的 action 清单；分享状态到 binding 的推导（停止、过期、准入、模式、读者自己的分支、撤销、包含可见会话的工作区）；按请求细化的 condition；面向读者页面的拒绝原因 |
| 通用层 | 资源解析、按资源 AND、role 与 action 匹配、condition 调用、原因优先级、列表过滤、快照计算与失败隔离 |

该读者的快照包含 `global`、源会话、自己的每个分支与每个可见工作区上的 grant；`session/list` 同时出现在 `global` 级与 session 级 role 中，见[列表与聚合方法](#list-and-aggregate-methods)。

#### Host 侧鉴权调用顺序

所有调用路径（HTTP `/api`、WebSocket stream、进程内 `fetch(request, peer)` / `invoke` / `stream` / `wireStream.open`）都经过同一段 Gateway 逻辑：

| 步 | 动作 | 失败结果 |
|---|---|---|
| 1 | 准入得到 Peer：网络路径由 Connection `admit()` 给出（`browserPeer`）；进程内路径由调用方传入。Gateway 在读取 wire payload 之前检查 `peer.signal` | 网络准入失败返回 HTTP 401 / 403（不进入 Gateway）；Peer 已 dispose：`gateway/peer-disposed` |
| 2 | 解析端点并做参数字段集校验（`resolveDescriptor`、`assertExactArguments`），再按 Typert 编译类型校验 JSON 参数，每个参数解码一次 | `gateway/invocation-unavailable`、`gateway/ambiguous-endpoint`、`gateway/definition-unavailable`；字段多余或缺失：`gateway/arguments-invalid`；JSON 参数校验失败：`gateway/input-invalid`（owner 与非 owner 相同，先于访问检查） |
| 3 | owner 直通：`principal.kind === 'owner'` 时直接进入第 5 步 | — |
| 4 | 非 owner：Gateway 从第 2 步校验后的参数解析资源（`resources` 读取函数、其次 lookup 参数与 Context 声明的 `resource`、再次默认字段；lookup 与 Context 身份取 wire 身份，不解析 lookup 与 Context），再以校验后的参数为 `args` 询问 `remoteAccess.decide({ principal, action: endpoint, resources, args })`；资源非法时不询问 `decide()`，直接以 `resource-invalid` 拒绝；`deny` 结论变为抛出的错误 | `remote-access/denied`，details `{ action, reason }` |
| 5 | 分派：`resolveReceiverContext`（可能激活 Agent）、lookup 解析（JSON 参数复用第 2 步的值）、调用方法 | 既有错误码不变，如 `gateway/lookup-not-found`、`gateway/context-not-found`、`gateway/input-invalid`、`gateway/service-unavailable`、`gateway/method-unavailable` 与业务错误 |

鉴权（第 3–4 步）位于 lookup 与 Context 解析之前，未授权调用不会激活会话或产生其他副作用。Gateway 新增的错误码只有 `gateway/peer-disposed`；拒绝码 `remote-access/denied` 由 remote-access 声明。

Gateway 自有端点：非 owner 可订阅 `$events`，但从不收到需要回答的 waterfall 帧；`$events/result` 对非 owner 以既有的 `gateway/invocation-unavailable` 拒绝；两者都做第 1 步的检查。

#### 转发事件

`API_REMOTE_FORWARDED_EVENTS` 的 `emit` 条目可以声明 `resources`：以资源种类为键、经 `TypertForwardableEventEntry` 按该事件自身参数定型的读取函数，例如 `{ event: 'api-session/added', mode: 'emit', resources: { session: (summary) => summary.sessionId } }`。API Remotes 把读取函数附在每个转发帧上；对每条非 owner 的 `$events` 流，Gateway 每帧解析一次资源，只有 `remoteAccess.decide({ principal, action: 'event:<name>', resources })` 允许时才推送。

| 规则 | 内容 |
|---|---|
| 已声明事件 | `api-session/activity`、`api-session/added`、`api-session/error`、`api-session/removed` 与 `api-session/status` 声明其 Session |
| 未声明资源 | 未声明 `resources` 或声明为空 `resources: {}` 的事件访问 `global`，只有 `global` 级 role 列出 `event:<name>` 时才送达非 owner |
| 缺失资源 | 事件携带其声明的每个资源，因此读取函数返回 `undefined` 时该事件的资源非法，Gateway 不询问 `decide()`，不送达任何非 owner；调用缺少资源时则为 `global` |
| 整条放行或拒绝 | 允许的事件 payload 原样送达；不按 Peer 裁剪或投影 payload |
| 每个事件一个资源 | 通知至多携带一个资源；集合类变化走 follow 类流（`session/follow`、`session/control`、`workspace/follow`），由这些方法内联经 `allows()` 逐项判定 |
| waterfall | 非 owner 从不收到 waterfall 帧，不经 policy 判定 |
| 非 owner 流的 Host 信息 | 非 owner 的 `$events` 流与 owner 流一样以完整 `host`（含 `home`）打开；`hasLiveClient()` 只统计能回答 waterfall 的 owner 流 |

<a id="list-and-aggregate-methods"></a>
#### 列表与聚合方法

列表、分页与聚合类方法的调用解析为 `global`，由 `global` 级 role 放行；方法内部对每一项调用 `this.ctx.remoteAccess.allows(resource)`，判定当前调用的 action 在该资源上是否被授权（不带 args）。因此列表类 action 同时出现在 `global` 级 role（放行调用）与资源级 role（放行逐项）中：`session/list` 在 `global` 上被授权才能调用，每个会话行还要求 `session/list` 在该会话上被授权。`allows()` 读访问该服务的 Context 上的 invocation，owner 与 Remote 调用之外的进程内代码恒为 true，不过滤。

| 方法 | 过滤对象 |
|---|---|
| `session/list` | 会话行（`session` 资源） |
| `session/search` | 搜索命中（`session` 资源） |
| `session/control` | baseline 的 projections 与 projection 增量（`session` 资源） |
| `workspace/follow` | baseline、`upsert` 帧与 `order` id 中的工作区（`workspace` 资源）、工作区内会话、archived / pinned 会话集合（`session` 资源）。流记录已下发的工作区；某个工作区在下一次变化或新顺序中已不被允许时，发送一个携带完整过滤后状态的 `replace` 增量帧而不是 `remove`，因为 Client 不会复活已移除的 id，访问恢复后该工作区经普通 `upsert` 重新出现。`remove` 帧表示删除，只发给收到过该工作区的调用方 |

#### 访问快照流

```text
// Remote: remoteAccess/follow (stream; every Peer may read its own snapshot)
type RemoteAccessFrame =
  | { readonly type: 'baseline'; readonly owner: true }
  | { readonly type: 'baseline'; readonly owner: false; readonly grants: readonly RemoteAccessGrant[] }
  | { readonly type: 'upsert'; readonly grant: RemoteAccessGrant }
  | { readonly type: 'remove'; readonly resource: RemoteAccessResource }

interface RemoteAccessGrant {
  readonly resource: RemoteAccessResource    // global, or one declared-kind resource
  readonly actions: readonly string[]        // endpoint actions allowed on this resource without args, sorted
}

/** Window global carrying a page's opening baseline. */
export const REMOTE_ACCESS_SNAPSHOT_KEY = '__DSH_REMOTE_ACCESS__'
```

| 行为 | 说明 |
|---|---|
| 首份快照 | `snapshotFor(principal)` 计算页面打开时的 baseline。remote-access 经 `webserver/index-inject` 为 webServer 渲染的每个 index 加入全局变量 `REMOTE_ACCESS_SNAPSHOT_KEY`，值为 owner baseline `{ type: 'baseline', owner: true }`。渲染非 owner 页面的业务包（例如 owner Host 上的 liveshare）在所有 index 注入行之后放置一条把该全局变量赋值为 `snapshotFor(principal)` 的语句；后写的赋值生效，Client 在挂载时读取该全局变量 |
| 订阅 | 每个 Peer 订阅一条访问快照流，其 baseline 取代注入的快照 |
| 计算 | 取该 principal kind 的 policy 的全部 binding，按资源相等归并；每个资源的 `actions` 为这些 binding 的 role 中、经与调用相同的判定（单个资源、不带 args，condition 以无 args 调用）放行的端点 action；只为至少放行一个端点 action 的资源给出 grant。判定与快照同源：同一 principal、action 与资源（不带参数）上，快照答案与 `decide()` 一致 |
| 只含端点 action | `event:<name>` action 不进入快照；前端只据端点 action 决定入口显隐 |
| 增量 | `invalidate()` 或 policy 注册、撤回时重算并推送 `upsert` / `remove`，放行集合变空的资源推送 `remove`；未变化的资源不推送 |
| 生命周期 | 一代快照流在其 signal abort 或 remote-access 服务卸载时结束，因此重载后的服务从新的 baseline 回答每个读者；Client 把结束视为载体中断并重连 |
| owner | 只推送 `{ owner: true }`，前端全部为 true |
| wire 类型 | `actions` 为 `readonly string[]`：Typert 无法为模板字面量类型生成 codec |

access hooks 只按 action 与资源判断，不看调用参数；调用时 condition 可额外读取 args 做更细判断，以服务端结果为准。

#### Client 面

Client 面走框架标准 hook 注入，不引入 React context。组件只经 props 拿到 hook，不 import remote-access 的值。

```text
// @deepseek-ai/dsh-api-remote-access/client
interface ClientRemoteAccess {            // Client service ctx.remoteAccess
  source(kind: TypertResourceKind, id: string, action: string): HostObservable<boolean>
}
GlobalStandardProps.useRemoteAccess: (action: RemoteEndpoint) => boolean                  // remote-access; the global resource

// @deepseek-ai/dsh-client-ui-session (injects remoteAccess)
GlobalStandardProps.useSessionAccess: (sessionId: SessionId, action: RemoteEndpoint) => boolean
SessionStandardProps.useAccess: (action: RemoteEndpoint) => boolean
SessionMaybeStandardProps.useAccess: (action: RemoteEndpoint) => boolean | undefined

// @deepseek-ai/dsh-client-ui-workspace (injects remoteAccess)
GlobalStandardProps.useWorkspaceAccess: (workspaceId: WorkspaceId, action: RemoteEndpoint) => boolean

// RemoteEndpoint = Extract<keyof TypertRemoteMap, string>
```

| 事项 | 定稿 |
|---|---|
| 快照与挂载 | remote-access Client 插件从 index 注入的 baseline 起步（启动时同步读取并校验），订阅快照流，对每个 baseline 一次构建完成，提供 Client 服务 `ctx.remoteAccess.source(kind, id, action)`（身份稳定的布尔 source）并注入 `global` 资源上的 `useRemoteAccess`。入口模块 import 生成的 `/remote` contribution，连同注入的 baseline 交给 `mountAccess(ctx, contribution, initial)` 经 `ctx.remote.$mount` 自行挂载（单测传入假 contribution），先例为 experimental client-ui-cot-translation、voice-input、claude-code-mods；若由 api/remotes 集中挂载，会形成 ui-session → api/remotes → remote-access → ui-session 的 project reference 环 |
| 会话资源 | ui-session 经 `uiSession.provide({ keyedHooks: ['access'], resolve })` 给出本会话答案，会话由框架绑定，与 `useProjection` 相同；`useSessionAccess` 经 `provideRoot` 注入 |
| 工作区资源 | ui-workspace 经 `provideRoot` 注入 `useWorkspaceAccess` |
| 名称区分 | `global` 答案是 `useRemoteAccess`，会话答案是 `useAccess`，两者互不遮蔽；session-maybe 无会话时 `useAccess` 为 `undefined`，调用方按不允许处理，需要 `global` 判断时读 `useRemoteAccess` |
| 双参数调用 | 框架 keyed hook 的标准双参数：`KeyedStandardSource` 为 `(key, member?) => source`；第二个参数为字符串时 hook 读取 resolver 对 `(key, member)` 返回的 source，不带 selector；resolver 对同一参数返回同一 source。既有 `(key, selector?, equal?)` 与 `(selector, equal?)` 调用不变。禁止柯里化形式 |
| 返回值 | 有资源的答案均为布尔值；action 类型来自 `ctx.remote` 的 namespace 与方法 |
| 不回退 | 会话资源上查询非会话方法（如 `useAccess('session/create')`）读该会话资源上的判定结果，不回退 `global` 答案 |
| 无快照 | owner 为 true，快照流终止失败后亦然；没有注入 baseline 或快照流终止失败的非 owner 页面为 false，终止失败会连同错误与“刷新页面”的提示一并报告；断线重连期间保留上次快照；注入的 baseline 格式错误时挂载失败；Host 仍对每次调用执行检查。hook 从不发请求 |
| 示例消费方 | ui-workspace 会话行菜单的 fork 入口读 `useSessionAccess(sessionId, 'session/fork')`，不允许时不渲染；ui-chat turn tail 的分叉按钮读会话资源上的 `useAccess('session/fork')`，不允许时不渲染。替换 #3854 的 `clientWritePolicy` 留给 #3854 |
| 测试 | `@deepseek-ai/dsh-client-test-runtime` 导出 `allowAllAccess` props 与 `allowAllAccessPlugin`；TestClient 像 api-remotes 一样去掉 remote-access 行并装入全允许服务，SlotTestRuntime 在 ui-session 之前装入 |

### 安全不变量

| 不变量 | 依据与落点 |
|---|---|
| principal 只能由进程内 Host 代码在创建 Peer 时给出 | `PeerScope.principal` 只读；`createPeer()` 不对应任何路由 |
| wire 上任何字段都不能设置或覆盖 principal | principal 不来自 args、envelope、header、query 或 cookie。args 顶层多余字段被 `assertExactArguments` 拒绝；payload 必须恰为 `{ args }`；envelope 未知字段被 [`clientRequestSchema`](../../../../packages/client/connection/src/rpc-schema.ts) 丢弃；请求体内同名字段只是业务数据 |
| 浏览器网络准入为 owner | 通过[浏览器 token 认证](../../implemented/architecture/2026-08-24-browser-token-authentication.zh.md)的连接得到 `browserPeer` |
| 没有隐式 Peer | Gateway 与 Connection 都不补默认 Peer；required 参数让漏传在编译期暴露 |
| 已 dispose 的 Peer 不能再分派 | `gateway/peer-disposed` |
| 非 owner 未经授权不能调用 | 只有 binding 的 role 显式列出该 action 且资源匹配时才放行；没有该 kind 的 policy 即拒；Gateway 依赖 `remoteAccess`，缺失时 Gateway 不启动 |
| `global` 授权不蕴含资源授权 | 资源之间无继承；方法内 `allows()` 对每一项独立判定 |
| 未知 principal kind 不是 owner | 只有 `kind === 'owner'` 是 owner |
| 非 owner 不回答 waterfall | `$events` 不给非 owner waterfall 帧，`$events/result` 拒绝非 owner |
| 非 owner 只收到被授权的通知 | 每个转发帧按 `event:<name>` 与其资源判定，被允许才转发给非 owner |

### 消息来源落盘

[session-controller 类型](../../../../packages/api/session-controller/src/types.ts) 的 `MessageSourceMap` 条目增加可选字段：

```text
'user-rpc': {
  kind: 'user'
  rpcId: SessionRequestId
  clientTimeZone?: string
  /** Non-owner caller that submitted this prompt; absent means the owner. */
  principal?: Principal
}
```

在 Remote 调用中构造 `kind: 'user'` + `rpcId` 用户消息 source 的生产者共两处，都在 Remote 方法内调用 `principalOf(this.ctx.invocation)`，返回值非 `undefined` 才写 `principal`：

| 生产者 | 位置 |
|---|---|
| `SessionController.prompt()` 构造 source，`SessionCommandController.prompt(request, source)` 只负责投递 | [`session-controller/src/index.ts`](../../../../packages/api/session-controller/src/index.ts)、[`commands.ts`](../../../../packages/api/session-controller/src/commands.ts) |
| subagent `prompt()`（`BrowserPromptSource`）；没有 role 列出它，非 owner 只能经进程内 Host 代码到达，不能经 Gateway 到达 | [`subagent/src/index.ts`](../../../../packages/subagent/subagent/src/index.ts) |

业务代码不把 principal 当函数参数逐层传递：身份只在 Remote 方法内从 invocation 读一次，向下传的是已构造的 source。Agent inbox 没有可在消息入队时统一补字段的拦截点（`followup` / `steer` 接受已构造的消息，SDK、调度等进程内生产者不在 Remote 调用中），因此按生产者落实，并由代码评审标准约束新增的生产者。

| 事实 | 说明 |
|---|---|
| `kind` 不变 | 仍为 `'user'`；现有 `kind === 'user'` 判断不受影响 |
| owner 消息不变 | owner 调用时不写字段，source 与引入 principal 之前逐字节相同；没有该字段的消息（含全部旧会话）即为 owner |
| 不进入模型请求 | llm 适配器只读 model source（[`llm-deepseek/src/replay.ts`](../../../../packages/llm/llm-deepseek/src/replay.ts)） |
| 会话格式 | 不 bump `SESSION_FORMAT_VERSION`；按 [persistence 类型变更 cookbook](../../../../docs/cookbook/reviewing-persistence-type-changes.zh.md) 为该持久化类型变更记录 acknowledgement |

消费方用法示例（不在本 Note 范围内实现）：工具守卫与 pre-step 复检按 turn 读取该 turn 内用户消息的 `source.principal`，任一条带非 owner principal 即按该调用方判定；同一 turn 混有 owner 与读者消息时取最严格者。

### 代码评审标准与文档

评审标准的正家为 [Remote and API rules](../../../../docs/defensive-patterns/remote-and-api.zh.md) 的「`@Remote` 标在能力方法上」一节：`@Remote({ resources })` 与自动解析必须覆盖方法访问的全部资源；聚合结果逐项经 `allows()` 过滤；调用方身份只读 `invocation.peer.principal`，不从参数读取；每条调用路径显式给出 Peer；业务代码不把 principal 当函数参数传递。

| 文档 | 内容 |
|---|---|
| [`docs/subsystems/typert.md`](../../../../docs/subsystems/typert.zh.md)、[`docs/api-gateway.md`](../../../../docs/api-gateway.zh.md) | `PeerScope`、`RemoteInvocation`、`InvokeRemoteRequest`、显式 Peer、`@Remote` 的 `resources`、访问检查顺序 |
| connection、gateway、typert-protocol、typert-registry、api-remotes、remote-access、session-controller、workspace-controller、ui-session、ui-workspace、ui-slots、client-test-runtime 的 README | 以 Peer / `browserPeer` 取代 operator；remote-access 的 role、binding、policy 契约；access hooks |

### 不在范围与 Future work

- 仅供 API 的 `/connect` 握手、API Cookie、每条 API 连接一个 Peer 与 WebSocket 生命周期见 [Peer 作用域建连握手](2026-10-09-operator-scoped-connect-handshake.zh.md)。
- 浏览器多 Peer（如每标签页一个）：所有浏览器连接共享 `browserPeer`。
- 交互参与属于 Peer；`interactions: 'answer'` 的非 owner 依然只能收到 RBAC 授权的广播，不能回答 owner 的 waterfall；按 principal 处理审批不在本机制内。
- `agent-preset/selected` 等其余转发事件未声明资源，按 `global` 判定；读者需要某个会话事件时，#3854 为其声明资源并在 role 中列出 `event:<name>`。
- liveshare 接入（声明 `share-viewer`、每条读者连接一个 Peer、定义 role 并注册 policy、删除 `origin` / `prompt/origin` / `READ_ENDPOINTS`）：#3854 侧。
- `session/cancel` 归属检查、fork 的 `childSessionId`、`ToolExecutionInput.turn`：不改。
- 资源识别的精确方式（例如 Typert 生成器按 branded id 类型在请求对象中定位字段并写入描述符）：目前用 lookup 与 Context 声明的 `resource`、默认字段加 `resources` 读取函数，以后可替换资源解析而不改 policy 接口。
- exact Fetch route 对非 owner 一律 403 是临时处理；以后由各路由声明访问规则。
- subagent `prompt` 的资源声明待定：其请求字段为 `parentSessionId` / `childSessionId`，目前解析为 `global`。生产者为进程内调用方记录 `source.principal`；没有 role 列出它，非 owner 不能经 Gateway 到达。
- 预定义与聚合 role：出现第二种非 owner principal kind 时，由各领域包以 `@Remote({ roles })` 声明方法所属的通用 role（如 `session:viewer`），各 policy 绑定这些 role；目前 role 由业务包以显式 action 清单定义。

### 与现有 Note 的关系

- [Remote 双工流](../../implemented/architecture/2026-09-19-remote-duplex-stream.zh.md)：部分 supersede。被替换的部分包括：「Peer 不记录身份与权限」「本 Host 只有一个 Peer：operator」「in-process carrier 不给 Peer 即 operator」，以及其替代方案中「Access 机制属于业务语义」的表述；其余（双工流、uplink、`ctx.invocation` 绑定）保持。两篇保持 active 并互链，该 Note 的现行事实已同步更新。
- [浏览器 token 认证](../../implemented/architecture/2026-08-24-browser-token-authentication.zh.md)：不受影响。该 Note 否决「按方法区分特权」针对的是 owner 的认证；通过认证的浏览器仍是 owner 且不受方法级检查。
- [Typert Remote 方法调用](../../implemented/architecture/2026-08-02-typert-remote-method-calls.zh.md)：不受影响；`@Remote` 与 `@RemoteScope` 增加可选的 `resources` 读取函数（`@RemoteScope` 的第二个参数可为 `{ name?, resources? }`），只供 Gateway 的访问检查读取，不改变端点命名、调用模式与生成物。
- [生产方拥有的消息来源](../../implemented/architecture/2026-09-09-producer-owned-message-sources.zh.md)：不受影响；`principal` 由构造 source 的生产者写入。

## 考虑过的替代方案

**独立 `prompt/origin` 事件并按 requestId 关联（#3854 做法）。** 每条 prompt 都写 required 事件，普通会话也无法被旧版本读取；关联要求全部 prompt 串行并维护来源 fold，fold 窗口外的消息失去发起者。

**principal 与 peer 并列挂在 invocation 上。** 同一调用方的身份拆成两处来源，准入点要同时产出并传递两者，任一路径只传其一就会错配。

**保留「Peer 不记录身份」的原约定。** 身份由业务插件经 `peer.ctx` 附加时，每个读取方都要知道由谁附加、如何读取，wire 准入路径也无法保证附加发生。

**保留默认 Peer 兜底（`request.peer ?? …`）。** 隐式默认让漏传 Peer 的调用静默获得 owner 身份；required 参数把漏传变成编译错误。

**新开 source kind。** 现有 `kind === 'user'` 判断都要逐个审视，漏一处就让读者消息在标题、大纲、队列或聊天渲染中消失。

**请求体字段携带身份。** 任何能构造请求体的调用方都能伪造或覆盖它。

**前端 React context 提供资源。** 业务组件不得读 React context；标准 hook 由框架按资源绑定，组件只经 props 拿到。

**由驱动方自行维护端点白名单并裁剪结果（#3854 做法）。** 白名单与结果裁剪都在驱动方内，Gateway 不执行，快照与前端各自推导；role 的 action 清单由通用层执行，列表过滤由方法内的 `allows()` 完成。

**业务包实现 `decide()` / `abstain` 的 provider，并合并多个 provider 的答案。** 每个业务包手写 action × 资源的判别分支，另写一份资源列表供快照，两者靠人工保持一致；policy 只给出 binding，判定与快照由同一份 binding 算出，每种 principal kind 只有一个 policy，不需要合并规则。

**独立的 `@RemoteAccess` 标记。** 默认拒绝已由 role 的显式 action 清单保证，标记只是第二道同意；一个资源都没解析出的方法落到 `global`，只有显式的全局授权能放行。资源读取函数是方法描述信息，放在 `@Remote` 上。

**把无资源的调用称为 `page` 或 `host`。** `page` 描述前端位置而不是资源；`host` 容易被读作这台 Host 上全部资源的上级。`global` 表示不关联任何资源的授权。

**资源继承（GCP 式：`global` 或工作区上的授权覆盖下级资源）。** 列表方法被 `global` 授权放行后需要逐项细判，继承会让任何 `global` 授权蕴含全部会话；无继承时每个资源的授权都由 binding 显式给出。

**role 注册表与预定义聚合 role。** 目前唯一的非 owner principal 由一个业务包管理，role 作为该包的普通值即可；聚合 role 会让新包声明的方法自动进入分享读者的可访问范围，推迟到出现第二种非 owner principal。

**condition 挂在 role 的 action 上。** role 保持为可复用的纯数据；按业务状态细化的判断属于把 role 授予某个 principal 的 binding。

**拒绝原因只由 condition 给出。** 没有 binding 时没有 condition 可以给出原因，读者页面无法区分「分享已过期」「分享不允许写入」等情况；`explain` 只在结论已为拒绝后给出原因，不改变结论。

**全局资源 resolver 注册表（领域包按字段名注册识别函数）。** 字段识别与方法分离，方法改签名时无人提醒，跨包同名字段也会被误认；资源解析采用方法上的默认约定加 per-method `resources`，领域包只登记自己种类的默认字段。

**按点路径声明资源（`'request.address.sessionId'`）。** 路径无法由类型推导约束；`resources` 读取函数的参数类型从被装饰方法推断，拼错即编译失败。

**由生成器按 branded id 类型识别资源字段。** 需要改 Typert 生成物与描述符格式，SRC 描述符没有类型信息；留作 Future work。

**由 api/remotes 集中挂载 remote-access 的 generated contribution。** remote-access Client 依赖 ui-session，ui-session 依赖 api/remotes，集中挂载形成 project reference 环；改为自挂载。

**在 Gateway 内实现判定（带规则的 `check()` 写在 Gateway）。** Gateway 会承载访问控制语义并多出错误码；Gateway 像解析 lookup 一样解析资源，在分派前调用 `remoteAccess.decide()`，规则与拒绝码归 remote-access。

**policy 异步判定。** 列表逐项过滤与快照计算需要同步答案；异步状态由业务包预先载入内存。

**前端按需查询权限。** 请求量随入口数增长，且与规则变化无法同步；快照流由 Host 主动推送，前端同步读取。

**访问检查放在 lookup 解析之后。** lookup 可能激活 Agent，未授权调用会先产生副作用。

**在 remote-access 中登记资源字段（`registerScope`）。** 访问控制包要识别参数字段，而 lookup 本已知道哪个 wire 字段指向 Session；typert 把资源种类与 lookups、Contexts 并列保存，Gateway 在一处解析调用与事件，remote-access 不读取任何参数字段。

**按 Peer 裁剪转发事件的 payload。** 逐事件投影会在每个通知里重复一遍列表过滤；一个事件至多携带一个资源，整条放行或拒绝，集合类变化走内联过滤的 follow 类流。

**首份快照到达前一律回答 true。** 非 owner 页面会短暂显示无权使用的入口；index 携带首份快照，没有快照的页面即无权限。

## 后果

### 验证

| 用例 | 行为 | 测试落点 |
|---|---|---|
| wire 试图设置 principal（args 顶层、payload 并列、envelope、请求体内） | 前两种以参数或 payload 校验拒绝；其余被丢弃或当作业务数据；`invocation.peer` 仍为准入给出的 Peer | Gateway host spec |
| 所有调用路径显式给出 Peer | `InvokeRemoteRequest.peer`、`wireStream.open` 的 peer、`fetch(request, peer)`、`bridge` 的 peer 为 required；Gateway 中不存在兜底；`/api` 路由传递 `admission.peer` | typecheck、Connection host spec |
| 浏览器连接与 `createPeer()` | `browserPeer` 的 principal 为 owner；`createPeer()` 每次返回独立 Peer，随读取 Connection 的 Context 释放；exact route 对非 owner 返回 403 | Connection host spec |
| 已 dispose 的 Peer | 之后的 unary、stream 与 `$events` 分派以 `gateway/peer-disposed` 拒绝，wire payload 畸形时亦然；其名下 stream 结束；运行中的 unary 完成；不影响其他 Peer | Gateway host spec |
| 鉴权顺序 | owner 调用任何方法照常分派且不读取 policy；没有 role 列出的方法对非 owner 以 `remote-access/denied`（`no-allow`）拒绝；访问检查早于 lookup，被拒调用不激活会话 | Gateway host spec |
| policy 注册 | 每个非 owner principal kind 一个 policy，重复注册抛错；disposer 撤回后该 kind 以 `no-allow` 拒绝；随 fiber 撤回 | remote-access host spec |
| 判定 | 每个资源都需要匹配的 binding（AND）；role 不含该 action、资源不相等或 condition 拒绝都不放行；拒绝原因按 condition > `explain` > `no-allow` 取；`explain` 不改变结论；condition 在调用时收到 args，在快照与列表过滤时不收；`bindings()`、condition 或 `explain()` 抛错以 `policy-failed` 拒绝，每个 policy 在两次 `invalidate()` 之间只记录一次日志，事件路径上 owner 流与共享事件源照常；`remoteAccess/follow` 对任何 principal 放行 | remote-access host spec、Gateway host spec |
| 资源解析 | 默认字段（顶层或首个对象参数）得到对应资源；声明了该种类 `resource` 的 lookup 参数得到其 wire 身份；Context 方法从 args 中的 Agent Context 身份得到其 session 资源且不激活 Agent，另可经 `resources` 声明其他资源；`resources` 读取函数覆盖该种类，数组为多个资源，`undefined` 为无；都没有为 `[global]`；抛错、空数组或非非空字符串（含 Context 身份）为非法，Gateway 以 `resource-invalid` 拒绝且不询问 `decide()`；未声明 `resource` 的 Context 按普通规则解析；资源与 `args` 读取校验后的参数，未声明的嵌套字段不改变资源、condition 也读不到它，JSON 参数校验失败在访问检查前返回 `gateway/input-invalid` | Gateway host spec（gateway-access） |
| 资源注册表 | `typert.resources` 每个种类登记一个默认字段，拒绝重复登记与 `global`，并随 fiber 撤回；配置的 lookup resolver 保留 provider 的 `resource`；Host Context adapter 保留其 `resource` | typert-registry spec |
| 转发事件 | 非 owner 的 `$events` 流只在 `event:<name>` 于其资源上被授权时整条收到事件；未声明资源的事件按 `global` 判定；读取函数返回 `undefined` 的事件不送达非 owner，且不询问 `decide()`；owner 全部收到 | Gateway host spec（gateway-access） |
| 首份快照 | `snapshotFor()` 返回 owner baseline 或该 principal 的 grant；remote-access 为渲染的每个 index 注入 owner baseline；Client 从注入的 baseline 起步并拒绝格式错误的快照 | remote-access host 与 client spec |
| 类型推断 | `resources` 读取函数的参数类型从方法推断；lookup 位为 wire 类型；访问不存在的属性、参数多于方法参数与 `global` 键编译失败；binding 的资源种类与 role 不符编译失败 | typert-protocol spec、remote-access spec（类型测试） |
| 列表过滤 | `session/list`、`session/search`、`session/control`、`workspace/follow` 对非 owner 只返回 `allows()` 为 true 的项；已下发工作区失去可见性时 `workspace/follow` 发送 `replace` 增量帧，访问恢复后该工作区重新出现；owner 结果不变 | session-controller / workspace-controller host spec |
| 访问快照 | 快照中的允许集合与 Host 对同一 principal、action、资源（不带参数）的判定一致；只含端点 action；没有放行 action 的资源不出 grant，放行集合变空时推送 `remove`；`invalidate()` 与 policy 注册、撤回后推送增量；被变化结束的等待不残留 abort 监听器；卸载服务即结束所有打开的快照流；owner 只收 `{ owner: true }` | remote-access host spec |
| access hooks | `source()`、`useRemoteAccess`、`useAccess`、`useSessionAccess`、`useWorkspaceAccess` 与快照一致；会话资源上的 `useAccess` 读本会话答案；owner 为 true；没有快照或快照流失败的非 owner 为 false；hook 不发请求 | remote-access client spec、ui-session / ui-workspace client spec |
| keyed hook 双参数 | 第二个参数为字符串时读取 `(key, member)` source；既有调用形式不变 | ui-renderer client spec |
| 非 owner 分派 `session/prompt` | 落盘 user 消息 `source.principal` 等于该 principal；冷恢复后仍读到同一值 | session-controller host spec |
| 进程内以非 owner invocation 调用 subagent `prompt` | 子会话落盘的 user 消息 `source.principal` 等于该 principal | subagent host spec |
| owner 消息 | source 与本变更之前逐字节相同；现有 keyless recorded-session snapshot 不变 | `pnpm run test:snapshot` 不需要重录 |
| 持久化记录 | `verify-persistence-changes` 通过 | doc-sync |

SDK 投影不受影响：TypeScript SDK server 自行构造 `{ kind: 'user' }` 消息（[`sdk/server/src/server.ts`](../../../../packages/sdk/server/src/server.ts)），不经 Gateway，也不投影 source；Python SDK 不读取 user source。

### 代价与限制

- 改动面横跨 protocol、Connection、Gateway、两个领域控制器、subagent、新包与前端，并带破坏性 API 改名；与 pr-5945 在 Connection 与 Gateway 上必然冲突，按迁移清单处理。
- Gateway 依赖 `remoteAccess`：自建组合若挂载 Gateway 而不挂载 remote-access，Gateway 停在等待状态。
- Session 日志会保存读者身份；导出或分享会话时随之外传，每个 principal 种类不得携带凭据。
- 浏览器所有连接共享一个 Peer：dispose 无法按标签页区分，直到浏览器多 Peer 落地。
- 默认字段约定按字段名读取：方法新增同名字段即访问对应资源，评审需留意；精确识别列为 Future work。
- 只解析出部分资源的方法会放行越权：未解析的资源不受检查，由方法作者保证 `resources` 完整。
- role 的 action 是字符串，不与已加载端点核对：拼错或改名后的 action 永不匹配，表现为拒绝。
- `api-session/added` 携带完整的 `SessionSummary`，因此被允许接收它的非 owner 也会得知该会话的 `parentSessionId`。
- 被授权会话的 cwd 与工具路径本就包含 owner 的绝对路径，因此 Gateway 不对非 owner 的 `$events` 流单独隐藏 `home`。
- policy 撤销某个工作区的可见性后，`workspace/follow` 只在该工作区下一次变化或顺序下一次变化时察觉并向非 owner 发送 `replace` 增量帧；仅访问变化不会发送帧。

### 留给 pr-5945 的迁移清单

| 文件 | 迁移 |
|---|---|
| `packages/client/connection/src/peer.ts` | 取代 `operator-peer.ts`；`OperatorPeer` 构造改为 `new Peer(owner, { principal })` |
| `packages/client/connection/src/rpc-host.ts` | `this.operator` 改为 `browserPeer`，principal 为 `{ kind: 'owner' }` |
| `packages/client/connection/src/rpc.ts` | `HostConnectionHandle` 合并 `admitConnection` 与 `browserPeer` / `createPeer` |
| `packages/api/gateway/src/index.ts` | `$events` 打开处的 `peer ?? this.operatorPeer()` 改为显式 Peer；复用 `gateway/peer-disposed` |
| operator-connect 的 Note、升级指南与 subsystems 改动 | operator 术语改写为 Peer / `browserPeer`；API 连接的 Peer 为 `{ kind: 'owner' }` |
