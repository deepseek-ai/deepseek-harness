# Agent Note: Typert Gateway 定向方法调用

Status: implemented

[English](2026-08-02-typert-remote-method-calls.md) | 中文

## Problem

Host API Proxy 当时在一个包里同时承担直接方法调用、带状态交互和 Session 事件流。三者的生命周期、路由语义和客户端编程界面不同，继续共用一个业务导出包会让业务 Service、传输协议、状态机和客户端类型彼此耦合。

本决策只涵盖一次请求对应一次结果的定向方法调用。Permission、Approval 等带状态交互以及 Session 事件流仍采用独立设计。

直接方法调用的约定属于实现该行为的业务 Service。业务开发者只需声明哪些方法可以远程调用，无需再同步维护中央 API 接口、路由表、参数转换表、客户端 stub 和 Zod schema。

Host 与 Browser Client 使用独立的 TypeScript Program，因为两边会以不同类型合并同名 Cordis `Context`。Remote 投影不能把完整 Host 声明导入消费端，也不能依赖 Browser 专属类型；未来 TUI 若复用这套编程界面，也只能看到 Remote 标记的方法。本期不实现 TUI 接入，但实现边界不得阻断这种同构复用。

## 决策

业务 Service 继承 `TypertRemoteService`，并通过 `@Remote` 或 `@RemoteScope()` 声明可调用方法；已有其他基类的 Service 可以改用 `bindTypertRemote()` 暴露同一绑定。Typert 从 Host Program 生成 Host 本地反射产物和平台无关的 Remote 消费端投影；Client Program 继续独立生成自己的本地反射产物。

Remote 消费端投影同时包含 `.d.ts`、`.d.ts.map` 和 `.js`。`.d.ts` 只暴露被 Remote decorator 标记的方法，并引用业务包唯一的公共类型符号；`.d.ts.map` 把消费端 API 方法导航回 Host 业务方法实现；`.js` 携带同一约定的 endpoint、参数、Context 和 Zod 信息。Browser Client 在 assembly 层把需要的 Remote JS 贡献集中挂到 Client Remote Service；该投影和 Remote 抽象保持平台无关，以便未来 TUI 复用。

`@deepseek-ai/dsh-api-gateway` 位于 `packages/api/gateway`，提供对称的两个 face：默认入口提供 Host `ctx.typertGateway`，`/client` 入口提供消费端 `ctx.remote`。两边各自在本地消费由同一模型生成的 `InvocationDescriptor`，descriptor 不通过 wire 发送。Remote 数据协议运行在 Connection 共享的 `/api` RPC channel 上；业务调用界面不随 Connection 从 HTTP 迁移到 WebSocket 而改变。

`@deepseek-ai/dsh-api-remotes` 位于 `packages/api/remotes`，是 Gateway 上层的 BFF 层。其 Host 入口注册本应用转发的 Cordis 事件源与随 generation readiness 携带的 Host 事实；`/client` 入口选择应用对外暴露的生成 Remote contribution。Client 入口通过 Cordis 消费共享的 `TypertClientRemote` 约定，而不导入具体 Gateway 实现。

## 组件和 Cordis 服务

| 组件 | Cordis 服务 | 职责 |
|---|---|---|
| `@deepseek-ai/dsh-typert-protocol` | 只声明 `ctx.typert` 的最小协议 | `TypertRemoteService`、decorator、binding 回退、descriptor、lookup/Context 和 Remote map；不依赖 compiler、Zod、Connection 或 Browser |
| Typert registry | `ctx.typert` | 分开保存当前环境 reflection、导入的 Remote contribution、lookup provider 和 Context provider |
| Typert generator/loader | 无新增业务服务 | 从 Host/Client Program 生成三类 `lib` 产物，并把当前环境产物注册到 `ctx.typert` |
| API Gateway 的 Host face | `ctx.typertGateway` | 关联 Host definition 与活 Service，解码参数、解析 receiver 并调用方法 |
| Connection | `ctx.connection` | 独占 HTTP Server/未来 WebSocket、共享 `/api` route、RPC envelope、rpcId、序列化、trust、错误传输、Typert 拦截，以及各 owner 在同一 channel 上注册的精确 Fetch route |
| API Gateway 的 Client face | `ctx.remote`、`ctx.remote.<namespace>` | mount Remote contribution，把每个 namespace 实体化为可追踪的 `remote.<namespace>` 子 Service，并把规范调用交给 `ctx.connection.rpc` |
| API Remotes | 无新增服务 | 负责 Host Agent/Session lookup 策略，并作为 Client 业务的唯一 facade，选择并挂载 `/remote` contribution，同时暴露所选 API 声明 |
| Agent/Session owning 包 | 既有领域服务 | 同时提供静态 interface merge 与运行时 lookup/Context provider |
| Goal 等业务包 | 既有业务 Service | 只声明 binding、Remote 方法和唯一 DTO，并导出生成的 `/remote` 子路径 |

Host Gateway 不依赖 `ctx.agents`、`ctx.sessions`、`ctx.goals` 或 `ctx.webServer` 的具体实现。Client Remote 不理解物理 carrier，Connection 也不理解 Goal、Agent、lookup、`InvocationDescriptor` 或 Remote namespace。

## 业务声明

普通直接调用使用 `@Remote`。现有方法的参数和结果已经是预期的 Remote 约定时，直接装饰该方法，不为此重命名。只有 wire 约定需要不同的请求或结果形态时，才新增 `remoteExport*` 适配器，并由 decorator 参数声明短 API 名。方法需要哪个业务对象，就在顶层参数位置显式声明该对象：

```text
export class GoalService extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'goals')
  }

  create(agent: Agent, request: CreateGoalRequest): GoalView {
    // Existing business method remains unchanged.
  }

  @Remote('create')
  remoteExportCreate(agent: Agent, request: CreateGoalRequest): CreateGoalResult {
    const view = this.create(agent, request)
    return { ref: { id: view.id, revision: view.revision } }
  }
}
```

`goals` 是传给 `super()` 的明确 Cordis service key，并默认作为 wire namespace。只有协议 namespace 确实需要与 service key 不同时，才通过第三个参数传入 `namespace` 选项。

需要在某类隔离 Context 中查找 Service receiver 时使用 `@RemoteScope()`。Scope identity 不进入业务方法参数：

```text
export class ScopedGoalService extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'goals')
  }

  @RemoteScope('agent', 'create')
  remoteExportCreate(request: CreateGoalRequest): Promise<CreateGoalResult> {
    // Runs against the goals service resolved from the Agent Context.
  }
}
```

同一个 endpoint 只能选择一种调用模式。需要显式 `Agent` 参数的流程使用 `@Remote`；需要切换到 Agent Context 再解析 scoped receiver 的流程使用 `@RemoteScope('agent')`，两者不会由 Typert 根据方法体或参数缺失自动猜测。

业务包只依赖轻量的 `@deepseek-ai/dsh-typert-protocol`。它提供 `TypertRemoteService`，以及 decorator、binding 回退、lookup、Remote Scope 和 descriptor 的声明协议，不依赖 TypeScript compiler、Zod、HTTP 或 Client runtime。

支持协作式取消的方法会把 `signal: AbortSignal` 声明为最后一个 Host 参数。这个保留参数不是业务值、lookup 或 JSON 字段。生成的消费方方法将其暴露为最后一个可选参数，因此普通调用保持不变，而拥有取消控制权的调用方可以传入 signal。

## Decorator 与显式 Gateway facet

Decorator 只表达“该方法参与 Remote 约定”，不负责运行时类型反射，也不向 Service constructor 注入隐藏 symbol。`@Remote('create')` 和 `@RemoteScope('agent', 'create')` 的参数是外部方法名；被装饰成员既可以是业务方法本身，也可以是 `remoteExportCreate` 这样的适配器。未给别名时才使用成员名作为外部方法名。继承 `TypertRemoteService` 是 Service 加入 Gateway 的常规显式声明；其 public readonly `typertGateway` 字段使运行时实例上的绑定保持可见。

SRC 模式下，decorator 把方法名和调用模式记录在 Service prototype 上的带版本描述符中。描述符使用稳定的字符串属性名，因此 `remoteMethods()` 可以读取 `dsh-typert-protocol` 另一个已安装副本生成的标记；它不会向 Service 实例、constructor 或方法函数写入任何内容。

LIB 的严格方法发现、类型解析和 descriptor 生成由 Typert compiler 完成。它接受 `TypertRemoteService` 直接 `super()` 调用中的字面量 service key，或显式 binding 回退；生成过程不改写业务源码，也不注入隐藏注册元数据。

## Lookup 与 Remote Scope 注册

Gateway 不内置 Agent、Session 或其他业务对象分支。对象所属包同时提供静态声明和运行时 provider：

```text
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap {
    agent: TypertLookup<Agent, SessionId>
  }
}

ctx.typert.lookups.register('agent', {
  parameter: 'agent',
  wire: 'agentId',
  resolve: sessionId => resolveAgent(sessionId),
})
```

静态声明让 Typert 知道 `Agent` 在 wire 上对应 `SessionId`；运行时 provider 负责把请求中的 `agentId` 解析为当前活的 `Agent` 对象。缺少任一侧时，LIB 构建或最早可解析的运行时注册直接失败。

Agent、Session 等 lookup 对象只能各自占据一个顶层参数位置。普通 JSON request 可以作为另一个完整参数传入，但本设计不支持 `request.agent`、对象解构、对象数组、嵌套 lookup 或从任意复杂结构中搜索 ID。

Remote Scope 使用独立的 merge-extensible map 和 Context provider。Agent 包注册 `agent` provider，负责用 wire identity 找到 Agent Context，并从该 Context 解析 descriptor 指定的 service key；Gateway 不知道 Agent Context 的内部结构。

Client 侧也注册 `agent` Context binder。binder 只负责从一次调用所在的 Context 取得 `SessionId`；它不枚举 Scope，也不逐个复制方法。scoped namespace 由 Cordis Service tracker 自动 rebind 到当前 Agent Context。

## InvocationDescriptor

Typert、SRC 弱解析器、Host Gateway 和 Client Remote 之间只交换一种规范描述：

```text
InvocationDescriptor {
  id: '@deepseek-ai/dsh-goal#goals/create'
  service: 'goals'
  namespace: 'goals'
  method: 'create'
  implementation: 'remoteExportCreate'
  invocation: direct | { context: 'agent', wire: 'agentId' }
  scope?: { context: 'agent', wire: 'agentId' }
  parameters: [
    { name, wire, source: json | lookup, lookup?, codec }
  ]
  cancellation?: { parameter: 'signal' }
  result: codec
  sourceLocation
}
```

`method` 是 endpoint 和 Client Remote 使用的外部短名，`implementation` 是 Host receiver 上的真实成员名；两者相同时可省略 `implementation`。`direct` descriptor 保留原始 Service 实例作为 receiver。Context descriptor 先通过对应 Context provider 找到 scoped Context，再以 descriptor 的 service key 解析 receiver。

严格生成器只在 direct 方法恰好包含一个 lookup 参数、同名 `TypertContextMap` 声明存在且两者使用同一 wire 类型 symbol 时写入 `scope`。`scope.wire` 必须指向该 lookup 参数；它声明消费端可以从调用所在 Context 补入这个参数，不改变 Host receiver 或 endpoint。多个 lookup、缺少 Context 声明或 wire 类型不一致时不生成 scoped 投影，其中类型不一致属于构建错误。

参数顺序来自方法签名，HTTP 字段来自参数名或 lookup 声明。取消 descriptor 只保留最后一个 `signal` 位置，并使其不进入具名 `args`；实际 signal 由 Connection 或直接调用 Gateway 的调用方提供。Gateway 不根据请求内容推断可选字段、Context 类型、lookup 类型或缺失参数，也不会合成业务默认值。

LIB codec 带有只缓存成功结果的 Zod schema factory 和「package + 公共 subpath + export name」的规范 `typeSymbol`。Host Gateway 首次解码严格输入时调用参数与身份 factory。Client contribution 保留同一 codec 元数据，以在挂载时检查严格输入，但不实例化调用 schema；[仅在 Host 校验 Remote 输入](../simplification/2026-09-15-host-only-remote-input-validation.zh.md)规定了这个位置。SRC codec 只标记 `src-json`。

descriptor 只存在于两端本地 registry。wire 上只有 `/api` channel、endpoint 和 `{ args }` payload。Client 用自己的 descriptor 把位置参数和 Context identity 映射为具名字段；Host 用自己的 descriptor 校验这些字段、解析 receiver 并调用方法。

## Typert 运行时 registry

```text
ctx.typert.local     Host or Client reflection for this process
ctx.typert.remotes   peer Remote contributions explicitly mounted by a consumer
ctx.typert.lookups   providers and composition policy from wire IDs to Host objects
ctx.typert.contexts  Host Context resolvers and Client Context binders
```

每次注册都返回由调用方 Cordis fiber 持有的 disposer。挂载 Client contribution 时，descriptor 集与具体方法会作为一项有明确所有者的操作统一注册。Host Gateway 只缓存 SRC 所认领的 endpoint 名称集合，并在 Cordis Service 集合发生变化时整体丢弃该集合；它不保留 descriptor、Service 或提供方。调用时会从当前状态解析所有活对象，因此移除 strict definition、Service 或提供方会使相应调用不可用，且不会留下陈旧的活对象。

lookup 注册表会在活 resolver 卸载后保留稳定的 wire 声明。SRC 解析仍会把该参数归类为 lookup，而调用会以 `gateway/lookup-unavailable` 失败；系统绝不会把传入的 ID 重新归类为普通 JSON 业务对象。在同一个 Typert Service 的生命周期内，以不同参数、wire 或规范类型 symbol 重新注册同一 key 会直接失败。

业务对象包和 scoped Context 包通过 `lookups.register()` 与 `contexts.registerHost()` 拥有稳定声明和默认 resolver；Host 组合通过 `lookups.configure()` 与 `contexts.configureHost()` 提供 effect-scoped 异步策略。配置可以先于 provider 注册，但没有活 provider 时不会单独形成可用身份；配置卸载后恢复 provider 默认 resolver。Session Controller 的 `ApiSessionAgentController` 为 `agent`、`session` lookup 和 `agent` Host Context 配置同一个共享 resolver：live Agent 直接复用，普通冷会话自动恢复，并发恢复按 Session ID 去重，subagent ownership fence 则返回 `session/agent-busy`。`session` lookup 返回解析所得 Agent 的 Session，`agent` Host Context 返回其 Context，因此三种投影共用一个恢复生命周期。

Registry 的 Host 根入口拥有完整 `TypertRegistryContract` interface merge；Host 与 Client 共用的 registry 实现位于无环境声明的独立模块。Registry `/client` 入口只引用该共享实现，不经过 Host 根入口，因此不会把 Host Cordis 声明带入 Client Program。

## 唯一类型、符号与 Zod

Remote Client DTS 不复制业务 DTO，也不重新声明一个结构相同的影子类型。它只从不携带 Host Cordis merge 的公共纯类型 subpath 引用原始符号：

```text
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CreateGoalRequest, CreateGoalResult } from '@deepseek-ai/dsh-goal/types'
```

因此 `SessionId`、Agent wire ID、request 和 result 在 Host 与 Browser Client 中都指向同一 TypeScript declaration，未来 TUI 复用时也不需要第二份类型。DTO 的跳转定义、重命名和引用查找回到业务类型的唯一源码位置，而不是停在生成文件中的副本。

Remote 方法本身使用 declaration map 导航。Typert 把 `InvocationModel.location` 固定在 Host 被装饰方法的方法名 token，并在 namespace interface 的对应属性上写入 source-map segment。对于由适配器支撑的 endpoint，TypeScript editor 从 `ctx.remote.models.list` 取得生成 declaration 后，再沿 `typert.remote-client.d.ts.map` 跳到 Host Service 的 `remoteExportList` 远程出口。该出口继续显式调用不改名的存量 `list()`，map 不把 decorator、class 或整个签名误当成方法定义位置。

Typert 为同一 symbol key 生成 wire Zod codec。Host Gateway 用参数与 identity codec 校验输入；Client Remote 信任生成的 TypeScript 参数与成功的 Host 结果，不执行调用 codec。复杂类型无法生成严格 codec 时，LIB 构建失败，不降级为 `unknown` 或无校验 JSON。

Remote 方法引用的命名业务类型必须从纯类型公共 subpath 导出。如果唯一可达入口会带入 Host Service、Cordis `Context` merge 或 Host-only 实现，构建失败并要求业务包提供安全的类型出口。原始值、字面量和 Typert 明确支持的简单组合不需要额外命名。

lookup 参数不会把 `Agent` class 暴露给消费端。Remote 投影引用 lookup 声明中的唯一 ID 类型，例如 `SessionId`；Host 内部仍以唯一的 `Agent` class symbol 完成对象解析。

## 三种产物与两个 TypeScript Program

Host 与 Client 仍然只有两个独立 TypeScript Program，但 Typert 生成三种性质不同的产物：

```text
Host Program
├─ typert.host.js / typert.host.d.ts
│  Host 自身的 Service、Event、Object、schema 和 inbound Gateway 信息
└─ typert.remote-client.js / typert.remote-client.d.ts / typert.remote-client.d.ts.map
   Host Remote 对任意消费环境的 wire 投影

Client Program
└─ typert.client.js / typert.client.d.ts
   Client 自身的 Service、Event、Object 和 schema 信息
```

`remote-client` 是 Host Program 的第二个 emitter，不是第三个 Program，也不是 Client 本地 face。它不包含 Host Cordis merge、Service class、Context class 或实现代码，不进入 Host 本地 reflection registry。

Host lib 构建负责完成严格 Host 分析并产出 Host 本地 artifact 与 Remote 消费端 artifact；Client lib 随后消费 Remote DTS。完整顺序为：

```text
Host lib build
→ 生成 typert.host.{js,d.ts}
→ 生成各业务包 lib/typert.remote-client.{js,d.ts,d.ts.map}
→ 完成 Client lib 和 typert.client 产物
→ Vite 构建 Web
```

现有顶层 `build` 仍表现为先 `build:lib`、再 `build:web`，但 `build:lib` 内部必须先完成 Host 与 Remote artifact，再启动 Client TypeScript 编译。一次干净构建不能依赖上次残留的 `.d.ts`。

即使主要输入是源文件，需要通过编译器解析消费方 surface 的仓库门禁也有相同的前置条件。公共 `typecheck`、`lint` 和 `doc-typecheck` 命令会先执行 Host 约定 pass。门禁调度器仅可在显式的 Typert 约定依赖或完整构建依赖完成后使用对应的 `*:contracts-ready` 变体，使并行 lane 既不会读取缺失的声明，也不会针对同一输出并发运行多个生成器。

## `/remote` 包入口

每个提供 Remote 方法的业务包导出生成的 `/remote` 子路径：

```text
"./remote": {
  "types": "./lib/typert.remote-client.d.ts",
  "default": "./lib/typert.remote-client.js"
}
```

消费代码通过业务包本身选择能力：

```text
import goalsRemote from '@deepseek-ai/dsh-goal/remote'
```

该 import 让 `.d.ts` 的 map augmentation 进入当前 TypeScript project，同时把同一约定的 JS descriptor 作为值交给运行时。未 import 的业务包不会扩展当前 project 的 Remote API 类型。

业务 package 的发布文件必须包含 `lib/typert.remote-client.d.ts.map`。生成 DTS 以 `//# sourceMappingURL=typert.remote-client.d.ts.map` 引用相邻 map；map 中的 source 从 `lib` 相对指向业务源码，例如 `../src/index.ts`。`/remote` export 不单独列出 map，package `files` 负责发布它。该目标是开发期路径：workspace 消费者经 package link 解析它，因此发布产物仍然不含 `src`，已发布的 map 只是解析不到东西。

仅需要静态类型时可以使用 `import type {} from '@deepseek-ai/dsh-goal/remote'`；这种 import 在运行时会被擦除，不会加载 JS，也不能触发任何运行时注册。需要真实调用的环境必须把普通 value import 得到的 contribution 交给 Client Remote Service。

workspace 对 `/remote` 的解析必须明确指向 `lib` 生成物，不能被通用 package-to-`src` paths 规则带回 Host 源码。普通业务 import 仍可按各环境既有规则解析到 SRC 或 LIB。

## 消费端严格 API 类型

Remote DTS 同时扩展平面 endpoint map、direct namespace interface、namespace map 和 scoped map，而不扩展全局 Cordis `Context`：

```text
interface TypertRemoteNamespace$676f616c73 {
  create: (
    agentId: SessionId,
    request: CreateGoalRequest,
    signal?: AbortSignal,
  ) => Promise<RemoteResult<CreateGoalResult>>
}

interface TypertRemoteMap {
  'goals/create': (
    agentId: SessionId,
    request: CreateGoalRequest,
    signal?: AbortSignal,
  ) => Promise<RemoteResult<CreateGoalResult>>
}

interface TypertRemoteNamespaceMap {
  goals: TypertRemoteNamespace$676f616c73
}

interface TypertRemoteScopeMap {
  'agent:goals/create': (
    request: CreateGoalRequest,
    signal?: AbortSignal,
  ) => Promise<RemoteResult<CreateGoalResult>>
}
```

`TypertRemoteMap` 保留规范 endpoint 签名，供协议类型和反射使用。根 Remote 类型直接读取 `TypertRemoteNamespaceMap`，不通过 key-remapped mapped type 间接推导方法；TypeScript Language Service 无法把这种间接属性稳定导航到 declaration map。namespace interface 名由 namespace 的 UTF-8 bytes 编成 hex，`goals` 因而稳定得到 `TypertRemoteNamespace$676f616c73`。不同 package 对同一 namespace 生成同名 interface，依靠 module augmentation 合并各自方法，且 `TypertRemoteNamespaceMap.goals` 始终引用同一类型。

Typert 把 `TypertRemoteScopeMap` 按 Context key 投影到专用 Scope 类型。最终编程界面保持：

```text
ctx.remote.goals.create(agentId, request)
agentCtx.remote.goals.create(request)
```

Agent Scope 自动提供自己的 `SessionId`。因此带 `agent` lookup 的 `@Remote` 方法可以同时生成 root 和 scoped 两种消费端签名；`@RemoteScope('agent')` 方法也省略独立的 Scope identity，但只生成 scoped 签名。根 `Context` 通过 `ctx.remote` 暴露 direct namespace，`AgentContext.remote` 则把该 direct surface 与 scoped surface 取交集。未来 TUI 复用时必须维持相同区分。

每个生成方法都解析为 `Promise<RemoteResult<T>>`：调用把结果报告在 `ok` 分支里而不是 reject，只有装配故障（arity、未挂载的方法、缺失的 Context adapter）仍然抛出。消费方按 `result.ok` 分支，需要区分失败时读 `result.error.code`；失败词汇本身是[单一 Remote 失败类加一张合并码表](2026-08-28-ctx-remote-failure-vocabulary.zh.md)。

`TypertClientRemote` 保持平台无关，Browser Client 通过 `ctx.remote` 暴露它。未来 TUI 若复用该类型，也必须通过专用 Remote 对象和 Agent Scope 使用它，不能把 Host `Context` 当成更宽的 Service 集合；未标记的 public Service 方法不会进入 Remote maps。除生成的 namespace 之外，Gateway client face 还提供 `$mount`、`$on`、`$stream` 与 `$host`——最后这项把连接的固定 Host 事实（`home`、`isLoopback`）作为普通值读取暴露，消费方无需为此注入载体。

## Client Typert 与 API Gateway Client face

一个消费环境的 Typert 同时维护本地信息和从其他环境导入的 Remote 信息，但两者存放在不同 registry：

```text
Typert.local    当前环境自己的反射模型
Typert.remotes  已导入的 Remote contribution
```

`@deepseek-ai/dsh-api-remotes/client` 集中加载需要的 Remote contribution：

```text
import goalsRemote from '@deepseek-ai/dsh-goal/remote'
import sessionsRemote from '@deepseek-ai/dsh-session/remote'

await ctx.remote.$mount(goalsRemote)
await ctx.remote.$mount(sessionsRemote)
```

Client 业务包只引用 `@deepseek-ai/dsh-api-remotes/client`，不直接依赖 API Gateway 或各业务 `/remote` 运行时入口。API Remotes 消费共享的 `TypertClientRemote` 约定和 Cordis `ctx.remote` 服务，再重新导出声明，使所选 Remote map 进入业务编译；新增或移除整套 Client 能力只修改这一处 assembly。

`ctx.remote.$mount()` 把 contribution 注册到 `Typert.remotes`，安装它的 namespace Service 和具体方法，并在它们就绪后才 resolve。调用该方法的 Cordis fiber 持有 disposer。endpoint 重复、同一 namespace/method 模式冲突或 descriptor 与现有类型身份冲突时直接失败。

Client Remote Service 把 `@Remote` descriptor 实体化为 `remote.<namespace>` 子 Service 上的真实函数。函数检查位置参数数量，按 descriptor 的参数顺序构造具名 `args`，不做运行时类型解析，然后调用 `ctx.connection.rpc.call('/api', endpoint, { args }, signal)`。对于支持取消的 descriptor，生成的函数接受最后一个可选 signal，并将其与 contribution 的挂载生命周期合并；因此卸载会取消所有正在进行的 carrier 调用，而调用方也可以单独取消一次调用。

带 `scope` 的 direct descriptor 和 `@RemoteScope` descriptor 都不为每个 Agent Scope 复制函数。Client Remote Service 为每个 namespace 创建一个注册为 `remote.<namespace>` 的 Cordis 子 Service，并在其上实体化 direct 与 scoped 变体。通过 `agentCtx.remote.goals` 取得方法时，accessor 会在返回可调用句柄前捕获当前 Agent Context。方法再通过对应 Context binder 从该 Context 取得 identity。direct scoped 投影用 identity 替代 `scope.wire` 指定的 lookup 位置，Remote Scope descriptor 则把 identity 写入 receiver 的独立 wire 字段；两者都发起同一种 `/api` 调用。

```text
root ctx.remote.goals.create(agentId, request)
  → direct descriptor
  → ctx.connection.rpc.call('/api', 'goals/create', { args })

agentCtx.remote.goals.create(request)
  → remote.goals accessor 捕获 agent Context
  → agent binder 从 caller Context 取得 agentId
  → 用 agentId 补入同一 direct descriptor 的 lookup 参数
  → ctx.connection.rpc.call('/api', 'goals/create', { args })
```

根 `Context` 只 merge direct `TypertClientRemote` surface；`AgentContext` 把该属性替换为 `TypertClientRemote` 与 `TypertRemoteScopeApi<'agent'>` 的交叉，因而 scoped-only 方法不会暴露给 root 代码。若调用方绕过类型从 Root 动态调用 scoped-only 方法，binder 明确报错。若 Client 已有名为 `remote.<namespace>` 的 Cordis service，或两个 contribution 冲突占用同一 namespace/method，mount 直接失败，不覆盖现有服务。

生成的 Remote JS 只包含 descriptor、symbol key 和 codec，不打包 Host Service 实现。Client Remote Service 据此创建真实函数，因此运行时不依赖 JavaScript Proxy；Proxy 可以作为实现选择，但不会成为类型或反射来源。

## 跨环境同构约束

Remote API 是消费端能力，不等同于 Browser API。已交付的运行时实现 Browser Client contribution 挂载、Connection RPC 调用和 Agent Scope 关联。

Remote DTS、Remote JS、`TypertClientRemote`、`InvocationDescriptor`、Remote RPC 数据协议和 Context binder 不得依赖 DOM、Browser module loader 或 HTTP。Browser Client 通过 Connection 把 descriptor 实体化的方法编码为 `/api` RPC 调用。

未来 TUI 可以在不改变业务 decorator、Remote maps 和 API 调用形状的前提下接入同一调用抽象。届时 TUI 可见的 API 仍只能由 `@Remote` 和 `@RemoteScope` 生成，不能因为它与 Host 同进程就绕过 Remote 限制直接暴露 Service 方法。

TUI 的 runtime 挂载、carrier、Agent Scope 关联和 SRC 启动接线均仍延后，不在本决策之内。

Web 本身依赖 `lib/client.js` 等构建产物，因此启动 Web 前要求完整 `build:lib`。Host Remote 约定变化后，开发者需重新执行 lib build，再启动或重启 Web；系统不实现 Remote contract 的增量 watch。

## SRC 与 LIB 运行模式

SRC 面向本地源码启动。`@Remote` 和 `@RemoteScope()` 创建的带版本 prototype 描述符给出方法名和调用模式，运行时从 JavaScript 函数签名读取顺序参数名，并结合已注册 lookup/Context provider 生成弱 descriptor。

例如 `@Remote('create') remoteExportCreate(agent, request, signal)` 解析为外部方法 `create`、实现成员 `remoteExportCreate`、两个顶层业务参数和一个取消注入点；lookup 注册把 `agent` 改写为 wire 字段 `agentId`，`request` 按同名 JSON 参数传递，最后一个 `signal` 则留在 payload 之外。SRC 不启动 `ts.Program`，不使用 preload、loader hook、源码生成或模块改写，也不检查普通 JSON 对象的内部结构。

SRC 无法明确解析的签名会在首次调用解析其 descriptor 时失败；Service 挂载只记录 decorator 标记，不检查 JavaScript 签名。SRC 不会猜测对象解构、默认参数造成的歧义、rest 参数、嵌套 lookup 或复杂类型。

LIB 面向 CI、发布和 Web 前置构建。Typert 扫描完整 Host project，检查 Remote decorator、显式 binding、service key、endpoint 冲突、lookup/Context 声明、公共符号可达性、JSON codec、结果 codec，以及保留的最后一个 `signal` 参数是否具有全局 `AbortSignal` 类型，并生成严格 descriptor。

LIB 运行时只加载 `lib` 中的 definition，不启动 TypeScript compiler。Host Gateway 后续的 Service 关联、lookup、Context 解析、调用和响应编码不区分 descriptor 来自 SRC 弱解析还是 LIB 严格生成。

CI 和发布运行 LIB。全仓 coverage 全部切换到 LIB 是独立后续工作，不阻塞本次直接方法调用实现。

## Host Gateway 解析

Host Gateway 向 Connection 注册一个 `/api` interceptor，不维护第二份 endpoint 注册表。ownership matcher 会先检查当前 Typert local 注册表，再查询一份可失效的集合；该集合通过扫描当前 Cordis Service 中的 `typertGateway` binding 与 SRC Remote 标记生成。Cordis Service 发生变化时会整体丢弃该集合，因此 Typert definition 与业务 Service 可以按任意顺序到达，同时既不会在每次请求时重新扫描所有 Service，也不会因任意请求路径而扩大缓存。

每次调用都会重新从当前状态解析 descriptor、receiver、lookup 提供方与 Context 提供方。当前 strict descriptor 优先于 SRC。strict endpoint 一旦出现，即使随后撤回对应 descriptor，`TypertLocalRegistry.hasSeen()` 仍会在注册表剩余生命周期内保持对它的认领并禁止回退 SRC；重新注册 strict descriptor 即可恢复调用。移除 Service 或提供方会让调用明确失败；Gateway 既不保留失效对象，也不会以原始 lookup ID 调用方法。

普通 `@Remote` 调用保留原始 Service 实例作为 receiver。lookup 成功后，Gateway 按 descriptor 的参数顺序调用 `implementation ?? method` 指定的成员；若 descriptor 声明取消，则在这些参数之后追加 carrier signal。

`@RemoteScope('agent')` 调用先由 Agent Context provider 解析 wire identity，再从该 Context 读取 descriptor 的 service key 并调用 scoped receiver。业务方法不会收到隐藏 Context 参数或 Agent ID。

```text
ctx.typertGateway.invoke({ namespace, method, args, signal })
→ 查找本地 InvocationDescriptor 与 live receiver
→ 按参数 descriptor 读取具名 wire 字段
→ codec 解码普通值或 lookup ID
→ lookup provider 把 ID 解析为活对象
→ direct 使用原 Service；context 先解析 scoped Context 和 Service
→ cancellation descriptor 存在时把 signal 追加到业务参数末尾
→ Reflect.apply(receiver[implementation ?? method], receiver, orderedArgs)
```

`ctx.typertGateway.invoke()` 是 carrier-independent 的 Host 入口。它不创建 rpcId、RPC envelope 或 HTTP response；它直接返回未经运行时输出解码的业务结果，或产生由 Connection RPC adapter 映射的 Gateway 错误。

## 共享 `/api` 调用链

Connection 在 HTTP Server 上持有唯一 `/api` route。Gateway 把同步 endpoint ownership 判断和 Remote RPC handler 挂到 Connection：

```text
ctx.connection.rpc.intercept(
  '/api',
  endpoint => ownsRemoteEndpoint(endpoint),
  (endpoint, payload, signal) => {
    const { namespace, method } = parseEndpoint(endpoint)
    const { args } = parsePayload(payload)
    return ctx.typertGateway.invoke({ namespace, method, args, signal })
  },
)
```

Host registry 中存在 strict descriptor、记录过已撤回的 strict descriptor，或 active SRC Service binding 上存在匹配的 `@Remote` 标记时，Gateway 认领该 endpoint。endpoint 一旦被认领，即使 payload 解码、descriptor 解析或调用失败也继续由 Gateway 返回错误；既不匹配精确 Fetch route、也不被 Gateway 认领的 endpoint 返回 404。

Connection Host half 把一个复合 FetchHandler 交给 HTTP bridge。bridge 创建标准 `Request` 后，该 handler 先用 pathname 匹配各 owner 在该 channel 上注册的精确 Fetch route，再匹配该 channel 唯一的 interceptor——即 Gateway——两者都不认领时返回 404。该 channel 上的每条路径复用同一 request/response envelope、rpcId、序列化、trust 与错误传输，失败则携带共享的 `{ code, message, details }` 数据。当前物理映射是：

```text
POST /api/<namespace>/<method>
```

Remote payload 使用具名 JSON 对象，不使用位置数组，也不发送 `InvocationDescriptor`。普通 Goal 调用的 payload slot 是：

```json
{
  "args": {
    "agentId": "session-1",
    "request": {
      "objective": "finish the migration"
    }
  }
}
```

完整链路为：

```text
ctx.remote.goals.create(sessionId, request, signal?)
→ Client InvocationDescriptor 组装 { args: { agentId, request } }
→ Client 合并 caller signal 与 contribution mount lifetime
→ ctx.connection.rpc.call('/api', 'goals/create', { args }, signal)
→ Connection 创建 rpcId 和既有 client-request envelope
→ 当前 carrier 发送 POST /api/goals/create
→ Connection Host half 执行共享 trust，再由 bridge 创建标准 Request
→ 复合 FetchHandler 判断 endpoint ownership 并选择目标 FetchHandler
→ Typert interceptor 调用 ctx.typertGateway.invoke(..., request.signal)
→ Host InvocationDescriptor 解码、lookup、receiver 解析并把 signal 注入 Reflect.apply
→ Connection 写入既有 RPC result 并回送相同 rpcId
→ Client 直接返回 CreateGoalResult
```

Remote 不在 wire 上定义第二层 `{ ok, value/error }` response。成功值与失败都直接使用既有 RPC response 的 `result`，失败分支携带共享的 `{ code, message, details }` 数据。owner、resolver 与 Gateway 抛的都是同一个类 `RemoteError`，其码来自合并后的 `RemoteErrorDetailsMap`：Host 把结构识别出的 `RemoteError` 原样编码上 wire——包括 Gateway 自己的 `gateway/*` 装配码，以及 resolver 的 `session/not-found`、`session/agent-busy`——只把未归类的 throw 折成 `gateway/internal`，并把诊断串留在 message 里。Client face 为 `RemoteResult` 的错误分支重建实例，因此 `throw result.error` 的 throw 语义成立。[失败词汇 Agent Note](2026-08-28-ctx-remote-failure-vocabulary.zh.md) 持有码表、落点规则，以及为什么判别读 `code` 而不用 `instanceof`。

Gateway 不处理逐方法权限、调用者身份、幂等或长连接状态。它只把 Connection 的协作式取消传播给显式支持取消的业务方法。共享 channel 上的每个请求——无论是 Typert endpoint 还是精确 Fetch route——都先过 Connection 的浏览器认证与 trusted-host 策略再分发；Gateway 不叠加第二套策略。Connection/WebSocket 迁移后续独立完成。

## Connection 与协议边界

Client Remote Service 负责 Remote contribution、namespace Service 实体化、Scope 绑定以及位置参数与 descriptor 的对应。Gateway 负责 Host descriptor、endpoint ownership、lookup、Context 和业务调用。Connection 把 `/api`、endpoint 和 `{ args }` 作为一个 RPC 调用发送到目标并返回既有 RPC result；它不理解 Goal、Agent、lookup、descriptor 或 Client Remote 类型。

Gateway 只向 Connection 注册 ownership matcher 和 RPC handler，不注册 HTTP route。Connection 把共享 `/api` route 挂到 HTTP Server，并把一个复合 FetchHandler 交给 bridge；该 handler 把精确注册路径分发给它的 route owner、把已认领 endpoint 分发给 Gateway，其余一律 404。未来 Connection transport 可以保留相同顺序，而不改变 Remote payload、业务 decorator、生成的 DTS、Remote API 类型或 Agent Scope 编程界面。

## 包边界

- `@deepseek-ai/dsh-typert-protocol`：轻量 decorator、binding、lookup、Remote Scope 和 descriptor 协议。
- Typert generator：分析 Host/Client Program，生成本地 face 和 Remote 消费端投影，并生成规范 symbol/Zod 信息。
- Typert runtime：分别保存当前环境的 local reflection 与导入的 Remote contribution。
- `@deepseek-ai/dsh-api-gateway`：默认入口关联 Host definition 与 Service，认领 Remote endpoint，校验输入，执行 lookup、解析 Context receiver、调用方法，并向 Connection 注册 `/api` interceptor；`/client` 入口挂载 Remote contribution，创建严格 Remote namespace Service 和方法，并把调用交给 `ctx.connection.rpc`。两个入口共享 Remote 协议，但不互相导入各自的 Cordis interface merge。
- `@deepseek-ai/dsh-api-remotes`：BFF 层；注册本应用转发的 Cordis 事件源与随 generation readiness 携带的 Host home，选择 Client `/remote` contribution，并通过共享的 `TypertClientRemote` 约定向业务包暴露合并后的 Remote 类型。
- Connection：拥有唯一 HTTP Server/未来 WebSocket carrier、共享 `/api` route 与其复合 FetchHandler、各 owner 注册的精确 Fetch route、RPC envelope、rpcId、序列化、trust 和错误传输。
- Agent/Session 等业务对象包：拥有 lookup、Context provider、唯一 ID 类型和纯类型公共出口。
- `@deepseek-ai/dsh-api-session-controller`：配置共享的 `agent`/`session` lookup 与 `agent` Host Context resolver，因此每个接收这些对象的 Remote endpoint 共用同一套恢复与 ownership fence 策略。
- 业务 Service 包：声明 binding、Remote 方法及其 request/result 类型，并导出生成的 `/remote` 子路径。

## 已交付范围与后续工作

已交付的纵向链路是 `@deepseek-ai/dsh-goal/remote → Browser Client Remote → Connection RPC /api → Host Gateway → GoalService.remoteExportCreate()`。同一个带 Agent lookup 的 direct descriptor 同时支持 `ctx.remote.goals.create(agentId, request)` 与 `agentCtx.remote.goals.create(request)`。普通冷会话在 lookup 时由该共享 resolver 恢复，subagent-owned identity 保持 `session/agent-busy` fence；`@RemoteScope('agent')` 仍是独立的 scoped receiver 模式。

Connection 提供共享 channel interceptor 与当前 HTTP carrier 映射。WebSocket 迁移、TUI runtime 与 carrier、TUI Agent Scope 接线、Permission/Approval 状态机、Session 事件流、调用授权、重试、幂等及跨版本协议兼容均不属于本决策。

包拓扑为 `api/remotes → api/gateway → client/connection → host/webserver`。Connection 与 WebServer 在本次变更中保留既有路径；后续将它们移到 `api/connection` 和 `api/webserver` 只会改变包位置，不会改变这些服务边界。

## Alternatives considered

**继续使用中央 API Proxy 包。** 该方案要求业务方法、Host 路由和 Client 接口在多个位置重复声明，也会继续把直接调用、带状态交互和事件流绑在同一生命周期中，因此不采用。

**让 decorator 在运行时完成严格反射。** JavaScript decorator 无法恢复擦除后的 TypeScript 类型、公共符号身份和完整 Zod codec；向 constructor 注入 compiler 私有 symbol 又会隐藏业务类的真实依赖，因此严格信息由 Typert compiler 生成。

**SRC 启动时使用 preload、loader hook 或完整 `ts.Program`。** 这能复用 LIB 分析，但增加所有源码启动入口的要求。SRC 只需要可用的弱 descriptor，因此采用 decorator 标记、函数参数名和显式 provider；严格检查留给 LIB 约定 pass。

**手写 Client interface。** 手写接口不能保证只包含 Remote 标记的方法，也会与 Host 签名、lookup ID 和 Zod schema 漂移，因此 Client 类型从 Host Program 自动投影。

**使用 TypeScript language-service/compiler plugin 让 Client 直接理解 decorator。** 这会让编辑器、Vite、tsc、tsx 和发布消费者都依赖额外插件，接入面过大，因此生成普通 `.d.ts` 和标准 declaration map。

**把完整 Host DTS 导入 Client 或 TUI。** 该方案会带入 Host Service 和 Cordis interface merge，并向消费端暴露未标记方法。Remote DTS 只引用纯类型公共符号并扩展专用 Remote maps。

**只生成 Remote DTS，不生成 JS。** 类型可以成立，但运行时无法枚举 endpoint、codec 和 Context 模式，只能依赖 Proxy 或另一份手写注册表，因此同一次 Host 投影同时生成 Remote JS contribution。

**让 `/remote` 的顶层 import 偷偷注册全局状态。** ESM 求值时未必已有目标 Cordis Context，多个 Context、HMR 和 dispose 也无法明确归属，因此普通 value import 只返回 contribution，由环境 assembly 的 Client Remote Service 显式挂载。

**为 Remote 新建独立 transport、HTTP route 或 `/api2` channel。** 这会复制或拆分 Connection 的 Server ownership、rpcId、序列化、trust、错误和未来 WebSocket 生命周期。共享 `/api` interceptor 保留唯一物理 route，并让 Connection 用各 owner 注册的精确 Fetch route 与该 channel 唯一的 interceptor 组合出它。

## 验证

- Goal Service 直接装饰业务签名已经符合 Remote 约定的变更类方法，仅保留 `remoteExportCreate(...)` 把 `GoalView` 适配为 `CreateGoalResult`，无需第二条路由、第二份 codec 或 Client 方法清单。
- 一次干净的 `build:lib` 会在 Client 编译前生成 Host 与消费方 Remote 产物，包括业务包 `/remote` 下的 JS、DTS 和 declaration map。
- `clean` 后，单独运行 `typecheck`、`lint` 或 `doc-typecheck` 都会重新生成 Remote 约定；pre-push 钩子使用同一个已包含约定准备步骤的 typecheck，CI 中的源码消费方则等待一次共享的约定 pass。
- 导入 `@deepseek-ai/dsh-goal/remote` 会加入严格的 `ctx.remote.goals.create(...)` 类型，并可通过 declaration 导航到 `remoteExportCreate`；不导入时不会出现该 namespace。
- 挂载同一次 import 得到的 JS contribution 会提供 endpoint、参数、结果、lookup、Context 和 Zod 反射，并在无需手写 stub 的情况下实体化调用。
- Root 与 Agent-scoped 调用会经过真实的共享 `/api` carrier，将 `agentId` 解析为活 Agent，调用原始 Goal receiver，并通过既有 RPC envelope 返回。
- Agent 与 Session lookup 会共享同一次并发冷恢复；普通冷会话得到恢复后的对象，冷态或 live subagent identity 均在业务调用前返回 `session/agent-busy`。
- Remote 产物与 map 仅包含已标记的方法，不依赖 Browser，从而为未来 TUI 保留相同的消费方边界。
- 生命周期测试会撤回并重新挂载 descriptor、Service、lookup、Context 提供方和 Client namespace；依赖不可用时，调用会失败，且不会使用陈旧调用或回退原始 ID。
- 取消测试覆盖严格生成、SRC 末位参数名识别、Client signal 合并、Connection 到 Gateway 的传播，以及 Host 在 wire `args` 之外的注入。
- 既不匹配精确 Fetch route、也不属于已认领 Remote endpoint 的请求在同一 channel 上返回 404，而已撤回的 route 随即停止服务。

## 后果

Remote API 类型依赖生成的 `lib` 声明，构建与门禁编排必须在对 Host 和 Client 消费方进行编译或语义分析之前完成 Host 约定 pass；顺序错误会使干净环境中的命令依赖陈旧产物。

源码导航依赖 Remote package 同时发布 declaration map 和 map 指向的 `src`。package `files` 漏掉任一侧时类型仍可编译，但消费端跳转会停在生成 DTS，因此 workspace manifest 校验必须把两者作为同一发布约定。

SRC 弱 descriptor 不验证普通 JSON 内部结构。Host Remote 签名变化后，Web 和严格类型消费方必须重新执行 lib build，因为系统没有增量 contract watcher。

公共类型唯一性要求业务 DTO 具有纯类型出口，可能暴露现有包中 Host 类型与实现入口混杂的问题。构建会拒绝这些边界，而不是复制类型掩盖问题。

类型 import 与运行时 contribution 是两种不同效果。`import type {}` 只扩展静态 Remote surface；真实调用环境遗漏 value contribution 时，Client Remote Service 必须以明确的「Remote 未挂载」错误失败。

生成的 Host 与 Client 产物携带匹配的 Zod factory，但 Client Remote 不实例化调用 schema。规范 symbol key、同一生成模型和 Host wire 校验让两侧保持一致，而无需跨 realm 比较 schema 对象 identity。

消费端可以导入 Host 当前未挂载的 Remote contract。类型表示「该协议能力已被消费端选择」，不保证目标进程当前存在对应 Service；运行时 endpoint 不可用必须明确失败。

Connection 的通用 channel API 必须同时适合当前 HTTP carrier 和后续 WebSocket carrier。若 Client Remote 或 Gateway 暴露 `fetch`、HTTP request 或 route handle，WebSocket 迁移会再次穿透 Remote 层，因此这些物理对象必须留在 Connection 内部。

Remote endpoint 使用 Connection 的 `trusted-host` authority。系统默认接受 loopback；LAN 调用方必须通过显式 trusted-host 配置接入，但本层不增加逐方法调用方授权，因此每个 trusted host 都能调用已挂载的 Remote endpoint。

`hasSeen()` 优先保障 strict definition 的安全性，而非 SRC 可用性。strict descriptor 撤回时（例如 HMR 期间），Gateway 会继续认领 endpoint 并报告不可用，而不会回退到弱 SRC descriptor。重新注册即可恢复；只有重启 Typert 注册表才会忘记历史 strict definition。

支持取消的 Remote 签名会接收 Connection 请求的 `AbortSignal`，因此 HTTP 断连或 Client 侧 abort 能在不进入 JSON 协议的情况下传递到正在进行的业务工作。取消仍是协作式的：没有保留末位参数的方法会继续运行；收到 signal 的方法必须将它传给自身支持取消的操作，或自行观测它。

lookup 配置当前以 key 为粒度，因此每个 `agent` 或 `session` 参数都采用同一套冷恢复策略。需要 live-only 语义的特定 Remote 必须等待显式的逐参数或逐 endpoint 策略，不能靠业务实现猜测对象是否刚被恢复。
