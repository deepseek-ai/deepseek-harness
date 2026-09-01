# Agent Note: Remote 事件投递（ctx.remote.$on）

Status: implemented

[English](2026-08-10-remote-event-delivery.md) | 中文

## 问题

[Typert Remote 方法调用](../../implemented/architecture/2026-08-02-typert-remote-method-calls.zh.md)最初只覆盖「一次请求一个结果」的定向调用，明确把 Session 事件流与有状态交互留在别处；Host 向消费端的事件需要一个不归 API Proxy 领域所有的投递机制。

Host 拥有 `agent-preset/selected`、`commands/change`、`credentials/reference-updated`、`llm/adapters-updated`、`settings/document-updated` 等单向事件；它们既不依赖 AgentScope，载荷也本来就是 JSON。若每条事件都要穿过 API Proxy 手写帧、Client Runtime 手写桥和 Client 事件别名才能抵达 UI，这些层不会陈述 owner 事件之外的新事实。

那份重复声明还是**有损**的：client 侧写成 `settings/changed(ns: string)`，brand 类型在这一跳被拍平成裸 `string`，与 Remote 方法侧「消费端类型指向业务包唯一符号」的既有契约相反。

## 决策

消费端 Remote 面持有一个事件订阅动词 `ctx.remote.$on(event, listener)`；**名单驱动、原样转发**：

- `packages/api/remotes/src/remote-events.ts` 持有一份带 `emit`／`waterfall` mode 的可转发 Host 事件名单，它同时是「消费端能订阅什么」的唯一控制点。旁边的 `src/types.ts` 由它派生类型投影并填充 selection 座位，按包约定保持纯类型。两个文件**都同时列进本包 Host 与 Client 两个 face 的 `files`**，两侧读同一份。
- wire 上的事件名 **就是 host cordis 事件原名**（`settings/document-updated`），不加 `host/` 前缀；载荷 **就是 host 的实参列表**，逐元素原样过 JSON，无投影、无脱敏、无改名。
- Host source 由 `api/remotes` 注册到 API Gateway；Gateway 在既有 `/api/remote.mux` 上保留内部 logical endpoint `$events`，不增加物理连接，也不让 API Proxy 解释事件。waterfall 结果通过 HTTP 一元 endpoint `$events/result` 返回。
- 事件**签名**不另立表：owner 包把自己的 cordis `Events` 声明搬进 client-safe 的 `./types` 纯类型出口，两侧读**同一份**——`$on` 的 listener 参数、结果和 `next()` 都由 `Events[Event]` 推导。「原样」不需要证明，是构造性成立的。
- 但**只借 cordis 的类型形状，不接 cordis 的事件系统**：投递语义、注册表、异常处置全归 Typert 自己。

一条 `Events` 条目若签名里够到了 host-only 符号（Service、`Agent`、Context 等），处理方式是**把代码拆到能干净落进 `./types` 为止**；不接受「一半留 index、一半搬走」的分裂声明，也不接受在 `./types` 里造结构等价的影子类型。当前名单内各 owner 都从 client-safe 类型出口提供同一份事件声明。

名单内事件全部走这条路径，专用帧与 Client 别名都已删除。模型消费方直接订阅 `llm/adapters-updated` 和 `settings/document-updated`；preset 消费方订阅 `agent-preset/selected`；Session 与动态 Cordis 的无状态通知使用 `emit`；Approval 与 Question 使用 Agent-scoped `waterfall`。真正需要 baseline、投影或去重的数据仍保留专用 Remote stream。

`skills/change`、`tools/change`、`system-prompt/change` 是同形状的纯失效事件但**没有任何已交付消费者**，按「每个抽象都要有当前 owner 与需求」不进名单，只作为扩展位记录在此。

### 消费端契约（dsh-typert-protocol）

type-meta 加事件形状谓词、mode 条目、选择座位和 `TypertClientRemote` 的一个成员；零运行时代码：

```ts ignore-check
import type { Events } from '@deepseek-ai/cordis'

type TypertForwardingMode<Event extends keyof Events> =
  unknown extends ThisParameterType<Events[Event]>
    ? TypertEventResult<Event> extends void ? 'emit' : never
    : TypertWaterfallEvent<Event> extends never ? never : 'waterfall'

/** Cordis event names that can cross the Remote Event carrier without a second signature. */
export type TypertForwardableEvent = {
  [Event in keyof Events]: TypertForwardingMode<Event> extends never ? never : Event
}[keyof Events]

/** Event and dispatch mode accepted by the Remote Event source. */
export type TypertForwardableEventEntry = {
  [Event in keyof Events]: TypertForwardingMode<Event> extends infer Mode
    ? Mode extends 'emit' | 'waterfall'
      ? { readonly event: Event; readonly mode: Mode }
      : never
    : never
}[keyof Events]

/** The Host assembly's forwarding selection; api/remotes' allowlist fills it, no other package does. */
export interface TypertRemoteEventSelection {}

/** `$on`'s legal keys: selected, and present in the current compilation face. */
export type TypertRemoteEvent = Extract<keyof Events, keyof TypertRemoteEventSelection>
```

```ts ignore-check
/** Subscribe to one forwarded Host event; the returned disposer belongs to the calling fiber. */
$on<Event extends TypertRemoteEvent>(event: Event, listener: TypertClientEventListener<Event>): () => void
```

`Events` 按程序解析：host 程序里是 host 事件全集，client 程序里是 client 编译面看得见的那些——同一个谓词在两侧各自成立，不需要把 host 声明拖进 client。

**契约只公开消费动词。**`ClientRemoteService` 激活时就把内部唯一的 `$events` pump 注册为 Connection generation source，与当前有无 `$on` 订阅无关；浏览器通过共享 Remote mux 打开 `$events`，进程内组合通过 `connection.rpc.open` 打开同一 logical stream。解码、精确 item 校验和订阅表派发都是 Gateway Client 的私有实现，`TypertClientRemote` 不暴露生产方方法，因此业务插件不能伪造一条 Host 事件。

每次 Host 打开 `$events` 时，API Remotes source factory 先同步挂载所有 allowlist listener，Gateway 随后产出首项 `{ type: 'ready', clientId, host: { home } }`，再开始迭代事件 source。`ConnectionController` 只有在该项到达后才发布 `connected`，因此 baseline 读取不会跑在增量 listener 前面。

物理 mux 断开会让 logical stream 以 `RemoteStreamCarrierError` 结束；Host 返回的 Remote stream error、意外正常结束、非 ready 首项或畸形事件项也会结束当前 generation。Connection 撤回该 generation，在退避后重开 `$events`；Gateway mux 只负责重建物理 WebSocket。转发事件不重放；凡正确性依赖恢复的状态，owner 必须另有查询、cursor 或 opening baseline，不能把 `$on` 当作可靠日志。

Client 以 Remote 实例私有 Cordis key 分发。普通 `emit` 使用 `parallel()` 并隔离 listener 失败；Agent-scoped `waterfall` 在解析出的 Agent Context 上使用 `waterfall()`，允许结果、拒绝或 `next()` 委托。两类注册都归属调用方 fiber，且 Host 事件不会触发 Client 本地同名事件。

### 名单：两个 face 共读的同一份声明

`packages/api/remotes/src/remote-events.ts` 同时列进 `tsconfig.host.json` 与 `tsconfig.client.json` 的 `files`，是名单的**唯一家**；`src/types.ts` 由它派生类型面：

```ts ignore-check
// remote-events.ts — the value
export const API_REMOTE_FORWARDED_EVENTS = [
  { event: 'agent-preset/selected', mode: 'emit' },
  { event: 'approval/request', mode: 'waterfall' },
  ...SESSION_CONTROLLER_REMOTE_EVENTS.map(event => ({ event, mode: 'emit' as const })),
  { event: 'commands/change', mode: 'emit' },
  { event: 'credentials/reference-updated', mode: 'emit' },
  { event: 'cordis/request-run', mode: 'emit' },
  { event: 'cordis/request-run-resolved', mode: 'emit' },
  { event: 'cordis/dynamic-package', mode: 'emit' },
  { event: 'cordis/dynamic-retract', mode: 'emit' },
  { event: 'cordis/inspect-query', mode: 'emit' },
  { event: 'cordis/inspect-query-resolved', mode: 'emit' },
  { event: 'llm/adapters-updated', mode: 'emit' },
  { event: 'settings/document-updated', mode: 'emit' },
  { event: 'user-questions/request', mode: 'waterfall' },
] as const satisfies readonly TypertForwardableEventEntry[]

// types.ts — the type face, derived
export type ApiRemoteForwardedEvent = typeof API_REMOTE_FORWARDED_EVENTS[number]['event']

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteEventSelection extends Record<ApiRemoteForwardedEvent, true> {}
}
```

于是**加一个事件只改这一行数组**：类型投影、`$on` 的键面、Host dispatch mode 与转发循环全部从它派生。`ctx.remote.$on('slots/changed', …)`（Client 本地事件）或 `$on('skills/change', …)`（名单没开）都是**编译错误**。

数组声明末尾的 `satisfies` 把 Host 事件词汇与 mode 约束落到同一份名单上：

```ts ignore-check
API_REMOTE_FORWARDED_EVENTS satisfies readonly TypertForwardableEventEntry[]
```

它卡住三件事：**名字合法**（谓词以 `keyof Events` 为基）、**mode 匹配签名**，以及只接受无 scope 的 `void` 通知或带一级 Agent scope、同结果 `next()` 和 Promise 返回的 waterfall。其他 Scope、bail、parallel 与 serial 形状都被排除。

**「原样」不在任何地方证明，而是构造性成立**：`$on` 的 listener 类型取自 owner 包 `./types` 里那一份 cordis `Events` 声明，host 转发读的是同一份，不存在可以彼此偏离的第二份声明。

载荷 JSON-safe 交给运行时：`api/remotes` 的 Host source 在入队前用 `dsh-session` 的 `isJsonValue` 逐元素校验，不合格**抛错 fail loud**（这是名单配置错误，不是外部输入）。

### 线协议（API Gateway Remote mux）

```ts ignore-check
ready     { type, clientId }
emit      { type, event, args }
waterfall { type, event, eventId, agentId, request }
cancel    { type, eventId }
```

Client 以 endpoint `$events` 和 payload `{ args: {} }` 打开 internal logical stream。Gateway 拒绝额外参数、缺失 Host source 和重复 source 注册；source 被撤回时会中止所有由该注册打开的 stream。每个 Client stream 在 `api/remotes` 中拥有独立队列与一组 allowlist listener，因此一个 Client 断开不会消费或撤销另一个 Client 的事件。

Client 要求首项是带非空 `clientId` 与 `host.home` 的 `ready`；后续 item 按 discriminant 精确校验字段。ready 项建立 Connection generation，并提供稳定的 Host 路径显示信息。普通 `emit` 的未知但结构合法事件名在没有订阅者时静默丢弃。waterfall 通过 `eventId` 关联 `$events/result`，并由 `agentId` 选择 Client Agent Context；Client 只回传可无损表示为 JSON 的结果，不在 transport 层重复解释业务字段。

`$events` 是 Gateway 内部 endpoint，不进入生成的 Typert Remote descriptor，也不成为 `ctx.remote.<namespace>`。应用选择仍只存在于 `api/remotes` 的 allowlist 和 Host source；Gateway 只拥有注册、payload 校验与物理传输。

### apps/web 的 browser e2e 属于 Host 面

`apps/web/tests/**` 那批 e2e 在**根 `tsconfig.host.json`** 做类型检查：它们在进程内起真 harness、直接访问 `ctx.connection`、Host `SessionStore.get/create/flush` 与 `ctx.sessionProjectionCache`。**运行时用浏览器 ≠ 类型上属于 Client 程序**——把它们搬进 Client 聚合会报错，因为一个 program 装不下两个 face 对同一个 Context key 的合并。

由此得到一条对本设计要紧的连带纪律：**这些测试从客户端包 import 值或类型，会把该包的整个 project——以及它引用的每个 project——拖进 Host 构建图**。`ui-settings-general`/`ui-settings-models`/`ui-permission`/`ui-commands` 四个消费者 references `api/remotes` 的 client face，而该 face 必须等 host tsdown 生成 `@deepseek-ai/dsh-goal/remote` 才能编译，于是形成构建期死锁：host tsc → api/remotes client face → `goal/remote` → host tsdown → 排在 host tsc 之后。

所需的客户端符号在测试侧**镜像**了一份（`scaffold.ts` 导出镜像后的 welcome-notice 常量，两个 chat e2e 直接引 `dsh-client-runtime/client` 因为 `runtime` 工程本来就在 host 图里），从而让那 4 个消费者离开了 host 图；`apps/cli/tsconfig.json` 里 15 条 client 工程引用随之失去 owner-map 职责，已一并删除。镜像值与源逐字一致，漂移的表现是选择器失配或通知未被抑制，都是响亮失败。

### 改动清单

| 位置 | 改动 |
|---|---|
| `dsh-typert-protocol` | `src/types.ts` 提供 forwardable mode 推导、selection 与 Client listener 投影；`TypertClientRemote` 只公开 `$on`。纯类型，零运行时 |
| `api/gateway` | Host 半提供唯一 Remote event source、`$events` stream、pending waterfall 协调和 `$events/result`；Client 半把私有 pump 注册为 Connection generation source，负责 frame 校验和 Cordis 分发 |
| `api/remotes` | `src/remote-events.ts`（带 mode 的名单值）与 `src/types.ts`（键投影 + selection）双列进两个 face；Host 半注册每 Client source，并在入队前校验 JSON；Client 半继续组合生成的 Remote contribution |
| 根 `tsconfig.base.json` | 加 `dsh-settings/types`、`dsh-credentials/types`、`dsh-api-remotes/types` 三条 `paths`，全部指向**源**平面 |
| `dsh-commands` / `dsh-settings` / `dsh-credentials` | `interface Events` 子块移入各自 client-safe 的 `./types`（settings/credentials 新建该出口，brand 与纯类型一并移入，index 继续 re-export 并留住构造器；`files` 补 `lib/types/**/*.js`） |
| `dsh-session` | `isJsonValue` 供 `api/remotes` Host source 校验每个事件参数 |
| `client/runtime` | 删除 Host frame 到 Remote subscription table 的桥；只继续在 Connection generation 建立后发布 `connection/reset` |
| 消费方 | Client 插件直接订阅 `ctx.remote.$on(...)`，type-only 引入 owner 事件声明并把 `'remote'` 加进 `inject` |
| `client/connection` | 提供唯一 generation source 注册位；`ConnectionController` 发布 `$events` ready 携带的 Host 信息，fixture 也从同一 source 产生事件 |
| `apps/web/tests` + `apps/cli` | 客户端符号镜像（见上节）；`apps/cli/tsconfig.json` 删 15 条 client 工程引用 |

## 备选方案

**继续寄生 API Proxy 的 Host downlink。**这样可以复用 Connection generation 和 `connection/reset`，但会让 API Proxy 保留 Remote 事件 allowlist、队列、schema 和 Client Runtime bridge，领域传输也无法随其他 Remote stream 共用生命周期。API Gateway 已有常驻 `/api/remote.mux` 后，`$events` 只增加一个 internal logical stream，不需要第三条 WebSocket，因此转移到 Gateway 的成本和所有权都更合理。

**给 Remote 事件另开第三条物理 WebSocket 或 duplex stream。**独立通道能拥有自己的连接状态，但会重复 Gateway mux 已经提供的认证升级、复用、取消、错误映射和退避重连。内部 `$events` endpoint 保留独立 logical stream，waterfall 结果复用 HTTP 一元调用。

**在 type-meta 立一张独立的 `TypertRemoteEventMap`，让 owner 包 declare-merge 进去**。消费端键集会精确等于「被声明为可远程投递的事件」；代价是每条事件的签名要在 cordis `Events` 之外**再写一遍**，于是需要一条双向 `extends` 的等价性证明来防漂移，还要给三个 owner 包新增 type-meta 依赖。共用同一份 `Events` 声明让等价性变成构造性成立，这张表因此不立。

**让 typert generator 从 host `Events` 声明生成事件投影**（codec + `.d.ts` + 声明映射，与 `/remote` 同族）。generator 已经在分析 host 事件；但它拿不到投影与脱敏语义，且要动生成器与构建面。原样转发这条路本就不需要投影。

**给可转发事件加载荷投影函数**（`{ 事件名, 投影, zod }` 转发表）。能一举覆盖 `models-changed` 的 fan-in 与 workspace 的 view 派生；代价是投影逻辑与载荷类型手工对齐，回到方法侧刚刚消灭的中心表形态。

**把 apps/web 的 browser e2e 搬进 client 聚合**。看似「客户端测试归客户端面」，实测立刻 21 条错：它们用 host 服务，而 client 程序里 `ctx.sessions` 是 `ISessions`。已否。

**给 `directory-picker-browse`/`-native` 做 host/client 双 face 切分**，从根上让客户端包不进 host 图。方向正确（它们确实是未切分的双半包），但改动落在别人属地，而收益只是「构建图更干净」——本设计在测试侧镜像客户端符号之后已经不需要它。**已评估不做**。

## 验证

钉住该行为的东西：

- Host source 真组合测试：两个 Client stream 各自收到 host emit 的 `{ event, args }`，其中一个断开不会影响另一个；非 JSON 实参会响亮拒绝且不会毒化后续合法事件。
- 类型层负例拒绝未选择事件、非 `void` 的无 scope 事件、非 Agent-scoped waterfall，以及声明 mode 与签名不符的条目。`$on('slots/changed', …)`（Client 本地事件）与 `$on('skills/change', …)`（已声明但未选中）都编译失败——因此 `$on` 的键面恰好等于名单。
- 消费端 `$on('settings/document-updated', …)` 把 `ns` 解析为 `SettingsNamespace`：brand 穿过 wire 存活。
- `$on` 的 disposer 归属调用方 fiber；同一个函数对象订阅两次时两条注册各自独立退订——按 listener 身份做键的表会把它们合并，所以订阅按注册项寻址。
- 普通通知同时收容抛出的 listener 与拒绝所返回 Promise 的 listener；waterfall 测试固定 Client result、`next()`、拒绝、取消、多 Client 首个 claim 和重连重放 pending request。
- Gateway 测试覆盖 source 缺失、重复注册、撤销中止、payload 拒绝、ready 先于事件，以及浏览器与进程内两种 carrier；Client 测试覆盖 generation source 注册边界、描述与增量就绪顺序、物理失败后重开、Host 错误与意外结束、非 ready 首项、畸形事件项、`$events/result` 失败和 dispose quiescence。
- `host/remote-event`、公开 `$dispatch`、Client Runtime bridge 和 API Proxy 的 allowlist 依赖都不存在；各消费方直接观察 owner 事件。

## 后果

- **Gateway 有一个非生成 endpoint**：`$events` 不对应业务 namespace，也不进入 Typert descriptor；它是 Gateway 与 `api/remotes` 之间的内部连接点，同时定义 Client Connection generation 的存活期。严格的空 payload 校验、opening ready 校验和单 source 注册限制它不会演化成第二个手写业务 API。
- **两个文件打破了 api/remotes 的 face 互斥约定**：`src/remote-events.ts` 与 `src/types.ts` 同属两个工程，各自向共享的 `lib/types` 发射一份相同声明。内容逐字节相同、`.tsbuildinfo` 各自独立，实践上无害；README 的构建边界节陈述了这个例外及其成因（`paths` 指向源码面）。
- **生产方保持私有**：业务插件只能调用 `$on`；Host source 注册和 Client 派发都不在 `TypertClientRemote` 上暴露，测试 double 以自己的 `emit` 方法驱动订阅，不伪装成生产接口。
- **畸形实参在 emit 点失败**：`api/remotes` listener 在入队前抛出，因此调用 Host `ctx.emit` 的操作立即看到名单配置错误；队列仍可继续投递后续合法事件。
- **测试侧镜像值可能漂移**：没有任何机制核对 `apps/web/tests` 中镜像的 client 常量与其源；安全网只是漂移会让选择器失配。规则写在 `apps/web/tests/README.md`，由 review 守；grep 级门禁经评估后刻意不做。
- **放弃的能力**：不支持投影或脱敏载荷，不支持 Agent 以外的 Scope，也不为普通通知提供重放。需要可靠恢复的状态必须拥有查询、cursor 或 opening baseline；waterfall 只重放仍处于同一次 Host 调用生命周期内的 pending request。
- **仍有 client 包留在 host 图里**：12 个工程（`connection`、`runtime`、`ui-slots` 等）经未拆分的 `directory-picker-browse`/`-native` 与 `api/gateway → client/connection` 仍可达 host 图。它们都能编译且不再牵连 api/remotes 的 client face，因此没有阻塞本次改动；拆分那些包能减少几个，但经评估后不做。两个 chat e2e 直接引 `dsh-client-runtime/client` 依赖 `runtime` 本来就在图里——属偶然而非保证。
- **本包不发布 invariant companion**：早先的修订曾在活事件总线上断言投递形状（`thisArg === null`、`mode === 'emit'`），这让诊断逻辑与名单值耦合，并使 rolldown 把它提成第三个 bundle chunk——而机械推导的发布文件清单并不携带它。Host 面的 `TypertForwardableEventEntry` 断言已在编译期拒绝这些偏离，包 README 也记录了不再存在独立运行时关系的原因。
