# API Gateway

[English](api-gateway.md) | 中文

本文是 Typert API Gateway 的当前状态参考。它描述业务服务如何声明一元 Remote 方法、构建如何生成 Host 与 Client 约定，以及调用如何复用 Connection 的 RPC 与 `/api` 路由。会话事件、增量数据和其他流协议不属于本文范围；它们可以使用同一个 Connection，但不使用 Remote 方法描述符。

## 编程模型

业务服务通过 `@Remote` 或 `@RemoteScope` 选择对 Client 开放的方法。未标记的方法不会进入生成的 Client 类型或运行时贡献，也不能通过 `ctx.remote` 调用。

`@Remote` 表示调用根 Host Context 中注册的 Cordis 服务。复杂的 Host 对象不能直接跨 wire 传输；业务包必须通过 `TypertLookupMap` 声明它与 wire identity 的关联，并在运行时向 `ctx.typert.lookups` 注册默认解析提供方。例如 `Agent` 参数在 Host 签名中名为 `agent`，生成的 wire 字段为 `agentId`，Gateway 在调用业务方法前将 id 解析为 Host 对象。Host 组合可以用 `ctx.typert.lookups.configure()` 覆盖某个 lookup key 的解析策略，而不改变业务包拥有的参数名、wire 字段或规范类型 symbol。

`@RemoteScope(key)` 表示先通过 `ctx.typert.contexts` 把 identity 解析为一个作用域 Context，再从该 Context 取得服务并调用方法。它适用于方法本身依赖作用域组合、而不需要显式接收 `Agent` 等对象的情形。

服务通常继承 `TypertRemoteService`，让 Cordis 服务 key 与默认 Remote namespace 在构造器中显式绑定。已有其他基类的服务可以改为声明 `readonly typertRemote = bindTypertRemote(this, serviceKey)`；两种方式都会留下可检查的公开 binding，不依赖编译器向构造函数注入 symbol。

```ts
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TypertRemoteService, Remote, RemoteScope } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'

export interface CreateGoalRequest {
  objective: string
}

export interface CreateGoalResult {
  accepted: boolean
}

export class GoalService extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'goals')
  }

  @Remote('create')
  createForClient(
    agent: Agent,
    request: CreateGoalRequest,
    signal: AbortSignal,
  ): CreateGoalResult {
    signal.throwIfAborted()
    return this.create(agent, request)
  }

  @RemoteScope('agent', 'current')
  currentForClient(): CreateGoalResult {
    return { accepted: true }
  }

  private create(_agent: Agent, request: CreateGoalRequest): CreateGoalResult {
    return { accepted: request.objective.length > 0 }
  }
}
```

Remote 方法可以同步返回或返回 Promise。若需要协作式取消，Host 签名的最后一个参数必须是全局类型的 `signal: AbortSignal`；它记录在描述符中而不是进入 `args`，Client 生成的方法则接受最后一个可选的 `AbortSignal`。

Client 使用普通对象上的具体函数，不使用 JavaScript Proxy。直接调用与作用域调用分别出现在 `ctx.remote.<namespace>` 和 `agentCtx.remote.<namespace>`。每个 namespace 都是注册为 `remote.<namespace>` 的可追踪 Cordis 子服务；Client assembly 通过 `ctx.remote.$mount()` 挂载贡献，最后一个方法撤回后该 namespace 随即卸载。依赖声明归实际调用方所有：只有读取 `ctx.remote.<namespace>` 或 `agentCtx.remote.<namespace>` 的业务包才在自己的 `inject` 中同时声明 `remote` 与 `remote.<namespace>`；只负责挂载 contribution 的 assembly，以及不调用该 namespace 的上层运行时，不代业务包声明 namespace 依赖。当一个 `@Remote` 方法恰好有一个 lookup 参数、且同名 `TypertContextMap` 使用相同 wire identity 时，生成的作用域签名会省略该 identity 参数。`@RemoteScope` 只生成作用域调用接口。

```ts ignore-check
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AgentContext } from '@deepseek-ai/dsh-api-session-controller/client'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'

export const inject = ['remote', 'remote.goals']

declare const ctx: Context
declare const agentCtx: AgentContext
declare const agentId: SessionId

await ctx.remote.goals.create(agentId, { objective: 'ship it' })
await agentCtx.remote.goals.create({ objective: 'ship it' })
```

Client 应用只装配 `@deepseek-ai/dsh-api-remotes`。该包以运行时值导入被选业务包的 `/remote` 子路径，通过 `ctx.remote.$mount()` 挂载贡献，同时重新导出相同文件中的声明合并。增加一个 Host Remote 包是 Client 组合所有者的显式选择；业务组件不需要分别加载 Typert Gateway 或业务包的 Remote JS。

`api-remotes` 装配与 `ctx.remote` 约定不依赖 React；任何 Client 装配能看到的 Host 方法都只限于生成时选择的 Remote 方法。

## 组件职责

| 位置 | 包或入口 | 职责 |
|---|---|---|
| 共享 | `@deepseek-ai/dsh-typert-protocol` | 声明 decorator、Gateway binding、可合并协议映射、调用描述符及提供方类型；不启动 TypeScript 分析，也不注册 Cordis 服务 |
| 构建 | `@deepseek-ai/dsh-typert-generator` | 从 Host `ts.Program` 严格分析 Remote 签名、类型图、lookup、Context 与源码位置，并生成 Host 和 Host-for-Client 产物 |
| Host | `@deepseek-ai/dsh-typert-registry` 与 Loader | 把生成的 Host 描述符、schema 及业务包注册项放入 `ctx.typert`，并持有 lookup 与 Context 提供方 |
| Host | `@deepseek-ai/dsh-api-session-controller` | 负责应用的 Agent/Session 身份策略，并配置对应的 Typert lookup |
| Host | `@deepseek-ai/dsh-api-gateway` | 提供 `ctx.typertGateway`，认领 Remote endpoint，校验请求值，解析对象或 Context，并调用实时 Cordis 服务 |
| Client | `@deepseek-ai/dsh-api-gateway/client` | 提供 `ctx.remote` 与 `remote.<namespace>` 子服务，把生成的描述符挂成具体方法，并通过 Connection 发起和取消调用 |
| Client | `@deepseek-ai/dsh-api-remotes/client` | 显式选择并挂载本应用允许使用的 `/remote` 贡献，向业务代码带入对应的声明合并 |
| 双侧 | `@deepseek-ai/dsh-client-connection` | 提供 RPC carrier、请求关联、信任边界、取消、响应 envelope 与 `/api` HTTP bridge |

API Gateway 包同时拥有 Host dispatcher 与 Client Remote endpoint 两个对等入口，但两侧构建不会进入同一个 `ts.Program`。Host 入口不导入 Client 的 Cordis `Context` 合并，Client 入口也不导入 Host Gateway 服务。

## 严格生成流水线

根构建依次执行 `build:lib:host`、`build:lib:client` 与 `build:web`。Host lib 阶段先运行 `tsc -b tsconfig.host.json`，再运行 `tsdown --env.DSH_BUILD_FACE host`；Typert generator 由正常 Host Project Reference 图编译，并在这次 tsdown 中以 Host aggregate 为唯一 `ts.Program` 种子运行。Client lib 阶段随后运行 `tsc -b tsconfig.client.json` 与 `tsdown --env.DSH_BUILD_FACE client`，使用刚生成的 Remote Client 声明和运行时贡献，但不再次启动 Typert。

两次 tsdown 都接收完整 workspace，且都只打包 `lib/types` 中由对应 tsc 阶段发射的 JavaScript。根配置不扫描 Client 产物、不按包名分类，也不向 tsdown 传维护式 filter；各包的本地配置根据 `DSH_BUILD_FACE` 返回当前阶段的入口。普通 Client 插件在 Client 阶段一起生成 Node loader 入口与 browser bundle。

`api/remotes`、`api/gateway`、`api/session-controller` 与 `api/workspace-controller`（外加 `client/connection`）都拆分 TypeScript face。`api/remotes` 的 Client project 依赖业务包在 Host tsdown 中生成的 `/remote` 声明；根 aggregate 与直接消费方必须分别引用各拆分包自己的 `tsconfig.host.json` 或 `tsconfig.client.json`。`api-remotes` 的 `clientBundle(..., { hostPhase: true })` 让 Host 入口在 Host tsdown 中生成，让 Client tsdown 只生成 browser 入口。Agent/Session lookup 策略位于 `@deepseek-ai/dsh-api-session-controller`，而非 `api-remotes`。

每个贡献业务包把生成文件写入自己的 `lib/`，而不是源码目录：

| 文件 | 消费方 | 内容 |
|---|---|---|
| `typert.host.js` | Host Loader | Host face 的运行时反射、严格调用描述符和 schema 注册值 |
| `typert.host.d.ts` | Host 类型系统 | Host face 的生成声明 |
| `typert.remote-client.js` | `api-remotes` | 可挂载的 `TypertRemoteContribution`，包含严格描述符与运行时 codec |
| `typert.remote-client.d.ts` | Client 类型系统 | `TypertRemoteNamespaceMap` 与 `TypertRemoteScopeMap` 的声明合并及 Client-safe 类型引用 |
| `typert.remote-client.d.ts.map` | 编辑器 | 将生成的方法属性映射回 Host 包中的 Remote 方法声明 |

业务包通过 `./typert` 暴露 Host Loader 入口，通过 `./remote` 暴露 Host-for-Client 入口。生成器同时校验这些包 export 及发布文件清单；只有具备相应入口的显式贡献包才会生成产物。

Remote Client 声明中的参数名来自 wire 字段，参数和返回类型则引用原业务包导出的 Client-safe 类型。声明 map 把 `ctx.remote.goals.create` 最终解析到的生成属性映射到带 `@Remote` 的 Host 源方法，因此支持 declaration-map 的编辑器可以从 Client 调用跳到真实实现，而不是停在生成的 `.d.ts`。

严格分析要求 Remote 是公开、非静态、有具体实现的实例方法。方法不能是泛型；参数必须是具名且必填的简单标识符，不能使用解构、默认值、rest 或可选参数。可 JSON 表示的普通类型由 Typert 生成严格 schema；工作区 class 等复杂对象必须具有唯一的 `TypertLookupMap` 声明。lookup 与 Context 包同时负责静态声明合并和运行时提供方注册；缺少任一侧都会导致构建失败，或者首次调用需要该提供方时失败。

## 运行时调用

Remote 调用使用 Connection 的 `/api` 路由。Client Remote 调用 `connection.rpc.call('/api', '<namespace>/<method>', { args }, signal)`；HTTP carrier 对应 `POST /api/<namespace>/<method>`，payload 只包含一个具名 `args` 对象。

Connection 在 HTTP bridge 之前执行 `/api` 的统一信任检查，再在共享 FetchHandler 内分发。Typert Gateway 只认领存在严格描述符或活跃 SRC marker 的两段式 endpoint；功能自有的精确 Fetch 路由处理非 JSON 响应，其他请求返回 404。Connection 拥有传输、RPC id、响应 envelope 和请求取消，Gateway 只拥有 Remote 数据协议和业务分发。替换 Connection carrier 不要求改变 Remote 描述符或 Client 编程接口。

Gateway 每次调用都从当前注册表解析描述符和实时服务，不缓存业务对象。它要求 `args` 的字段集合与描述符完全一致，先用 codec 校验 wire 值，再通过注册的 lookup 或 Context 提供方解析对象或接收者，最后调用 binding 指向的服务方法并校验返回值。缺少提供方、identity 未命中、binding 不一致、参数缺失或多余、schema 失败和方法不存在都会在进入业务代码前或离开业务代码后失败。

lookup 提供方的 `register()` 同时提供稳定声明和默认 resolver；`configure()` 提供由 Host 组合拥有、可异步执行且受 effect 生命周期约束的 resolver。配置可以先于提供方挂载；没有提供方时调用仍以 `gateway/lookup-unavailable` 失败，配置卸载后则恢复提供方默认策略。Session Controller 负责 `agent` 与 `session` 的标准 resolver 语义：复用 live Agent，自动恢复普通冷会话，对并发恢复去重，并拒绝由 subagent routing 拥有的 identity；`session` lookup 返回该 Agent 的 Session。恢复失败与 ownership fence 抛出携带自有码的 `RemoteError`（`session/not-found` 或 `session/agent-busy`），Gateway 原样编码上 wire；只有未归类的 throw 才折成 `gateway/internal`。

Client 卸载一个贡献时会一起移除描述符和具体方法，中止其进行中的调用，并使外部仍持有的陈旧方法句柄拒绝继续调用。Host 上已经注册过的严格 endpoint 被撤回后也不会降级到 SRC 推断，以免热卸载悄然降低校验强度。

## SRC 开发回退

Host 通过 `node --import tsx/esm` 从源码启动时不会执行 Typert 编译插件。标准 decorator 初始化器仍会把方法名和调用模式记录到 Service 原型上的带版本描述符中，`TypertRemoteService` 或 `bindTypertRemote()` 则提供显式服务 binding；Gateway 因而可以在不启动 `ts.Program` 的情况下构造一个较弱的临时描述符。描述符使用稳定的字符串属性名，因此 `remoteMethods()` 能读取协议包另一个已安装副本写入的标记。

SRC 回退从运行中函数解析简单参数名。参数名与某个已注册 lookup 的 `parameter` 相同，例如 `agent` 或 `session`，就使用其 `agentId` 或 `sessionId` wire 字段并在 Host 解析对象；其他参数只检查值是否为无循环、无特殊 prototype 的 JSON-safe 数据。`@RemoteScope` 直接使用已注册 Host Context 提供方的 wire 字段。SRC 不读取 TypeScript 类型，不生成 Zod schema，不推断可选参数，也不支持解构、默认值、rest 或重复参数名。

SRC 只解决 Host 源码进程的分发问题。Client 不会从运行中的 Host 发现 decorator，Client Remote 也拒绝挂载缺少严格 codec 的 SRC 描述符；其类型、codec 和 Remote 注册值始终来自最近一次生成的 `lib/typert.remote-client.*`。

## 开发模式

Web 开发先使用 `pnpm run build` 准备当前 Host、Client 与 Web 产物，然后在两个终端中分别运行源码 Host 和 Client plugin watcher：

```sh
pnpm dsh web
pnpm run dev:web
```

`dsh` 通过 tsx 启动 Host 源码，所以 Host 可以使用 SRC 回退；`dev:web` 只监听带 `dsh.client` 声明的 Client 插件并重写其 `lib/client.js`，它不会分析 Host decorator，也不会生成 Remote Client DTS。

只修改 Remote 方法实现体而不改变约定时，无需重新生成 Typert 文件。新增或删除 decorator、修改导出名、namespace、参数、返回值、lookup、Context 或取消签名时，重新执行有序 lib 构建，让 Host 先生成严格约定，再让 Client 编译并打包新的贡献：

```sh
pnpm run build:lib
```

运行中的 Client watcher 会在重新打包时消费这些生成文件。若已单独运行 `pnpm run build:lib:host` 刷新 Host 约定，也可再运行 `pnpm run build:lib:client` 完成 Client 侧；干净工作树不能跳过 Host 阶段。仅重新编译前端源码不能从 Host decorator 推导新类型。`pnpm run typecheck` 会执行 Host lib 阶段后再运行 Client tsc，CI 与发布构建也使用同一顺序。

## 边界

Remote 只处理有单个请求与单个结果的一元方法调用。会话事件流、分页、增量 reduce、projection 和实体子流需要独立的数据协议与注册模型；即使它们复用 Connection，也不应伪装成 Remote 方法或放入调用描述符。

API 各层按 `remotes → gateway → connection → webserver` 组织。BFF 与 Typert RPC 层位于 `packages/api`；Connection 与 WebServer 位于 `packages/client/connection` 和 `packages/host/webserver`。需要流式或浏览器原生响应的功能注册精确的 Connection Fetch 路由，而不定义 Remote 方法。

lookup 策略按 key 配置，因此所有 `agent` 或 `session` 参数共享冷恢复行为。只接受 live 对象需要显式的逐参数或逐 endpoint 策略，而这种策略并不存在；不能通过业务方法内部猜测对象是否来自恢复。
