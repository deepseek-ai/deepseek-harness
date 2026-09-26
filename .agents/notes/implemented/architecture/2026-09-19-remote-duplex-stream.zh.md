# Agent Note: Remote 双工流：一种流、上行通道与调用上下文

Status: implemented

[English](2026-09-19-remote-duplex-stream.md) | 中文

## 问题

### 现状

`dsh-api-gateway` 在一条 WebSocket 上复用全部 Typert Remote 流，路径固定为 `/api/remote.mux`（`packages/api/gateway/src/stream-protocol.ts`）。一个 Host 方法用 `@Remote({ mode: 'stream' })` 修饰并返回 `Iterable` 或 `AsyncIterable`，就成为一条 Host 到 Client 的逻辑流；可选的末位 `signal: AbortSignal` 是唯一的保留参数，不进线路参数，由网关在解码后的业务参数之后追加（`packages/api/gateway/src/index.ts`）。客户端拿到的生成方法返回一个裸 `AsyncIterable`。

线路帧只有五种：

| 方向 | 帧 | 定义 |
| --- | --- | --- |
| Client 到 Host | `{ type: 'open', streamId, endpoint, payload }` | `stream-protocol.ts` |
| Client 到 Host | `{ type: 'cancel', streamId }` | `stream-protocol.ts` |
| Host 到 Client | `{ type: 'item', streamId, value? }` | `stream-protocol.ts` |
| Host 到 Client | `{ type: 'error', streamId, error: { code, message, details } }` | `stream-protocol.ts` |
| Host 到 Client | `{ type: 'end', streamId }` | `stream-protocol.ts` |

客户端能发的只有打开与取消。解析器 `parseRemoteStreamClientMessage`（`stream-protocol.ts`）对其他任何帧抛错，Host 连接收到后以 1008 关闭整个 socket（`stream-server.ts`）。结论：网关今天只支持"后端 iterable 发到前端"。需要前端向后端持续发数据的功能，各自绕路。

Host 方法也没有"这次调用是谁发起的"这个概念：`InvokeRemoteRequest = { namespace, method, args, signal }`（`packages/api/gateway/src/types.ts`）没有调用者槽位，`RemoteStreamOpener` 的签名是 `(endpoint, payload, signal)`（`stream-server.ts`），WebSocket 只在握手时校一次 cookie。

### 三套各自为政的上行机制

| 功能 | 上行方式 | 位置 | 代价 |
| --- | --- | --- | --- |
| Web 终端按键 | 每次 xterm `onData` 一个 unary RPC `terminal.write(agent, id, attachmentId, data)`，客户端用 promise 链串行化并自限字节预算 | `packages/api/terminal-controller/src/client/model.ts`；Host `src/index.ts` | 一次按键一次 HTTP 往返与鉴权；两条载体靠 `attachmentId` 手工关联；满了报 `inputFull` |
| 文件上传 | `Blob` 或 `ReadableStream` 走 Remote 层之外的原生 `POST /api/session/uploadFileBinary`，`duplex: 'half'` | `packages/client/file-upload/src/client/runtime.ts`；路由 `src/index.ts` | 不经 Typert 描述符，没有类型投影 |
| 审批与提问的回答 | Host 在 `$events` 流上下发 waterfall 帧，Client 用一个独立的 unary RPC `$events/result` 回答，靠 `clientId` 加 `eventId` 关联 | `packages/api/gateway/src/client/remote-events.ts`；Host `index.ts` | 第二套关联键；`index.ts` 记录了由此产生的竞态 |

这三套机制解决的是同一个问题：一条已经打开的逻辑流，客户端想往里写。

### 具体代价

- **两条载体对齐**。终端要用 `attachmentId` 把 `follow` 流与 `write` RPC 关联起来，并用它决定谁拥有输入权。审批要用 `clientId` 把 `$events` 流与 `$events/result` RPC 关联起来。
- **没有顺序保证**。unary RPC 走 HTTP，与 WebSocket 下行互不排序；终端只能在客户端串行化写入来自保顺序。
- **每次上行单独鉴权与查找**。`write(agent, id, attachmentId, data)` 每次解析 `agent`、查终端、校验 attachment。
- **没有 EOF**。客户端无法表达"我这边写完了"，半关闭要再加一个 RPC。
- **取消不覆盖两半**。取消下行流不会取消排队中的上行写；反之亦然。
- **背压各写一套**。下行按 socket 写回调节拍拉迭代器（`stream-server.ts`）；终端用有界 follower 让慢消费者显式失败（`terminal-controller/src/stream.ts`）；上行靠客户端自限 `maxInputBytes`。
- **文档已经过时**。`docs/api-gateway.md:160` 仍写着 Remote 只处理一请求一结果，这一句已经落后于 README 记录的 stream 模式。

### 与后台 job 的关系

后台 job 的进程形双工流面（已存档为草稿 PR，分支 `worktree/job-stdio-stream-pair-archive`）把 job 建成一对镜像的流面，浏览器要接它就需要一条既下行又上行的 Remote 流。它是本 Note 的动机之一，但不是本 Note 的范围：job 要不要一种专用的读写流，是 jobs 那条线自己的架构问题。本 Note 只覆盖传输层。

### 目标

1. 传输层只有一种流，天生双工：下行 `item` / `end` / `error`，上行 `item` / `end`，一个 `streamId`，一个代际。
2. 上行类型与下行类型写在同一个位置：方法的返回类型。
3. Host 方法通过调用上下文取上行；调用上下文同时携带调用者（Peer）。
4. 客户端拿到的不再是裸 `AsyncIterable`，而是一个能读、能写、能关的句柄。
5. 上层协议（snapshot、journal、任何业务自定义的流）不进传输层。

## 决定

### 一句话

所有 Remote 流都允许客户端上行。方法的返回类型 `RemoteStream<Out, In = never>` 同时声明下行项与上行项的类型；生成器从中生成两个 codec。Host 方法通过 `this.ctx.invocation.uplink<In>()` 取上行迭代器，通过 `this.ctx.invocation.peer` 知道调用者。客户端生成方法返回 `RemoteStreamHandle<Out, In>`：`for await` 读下行，`send` / `end` 写上行，`dispose` 关。断线重开、游标续传、基线校验都是上层协议的事。

```
                 Client                                             Host
   ─────────────────────────────────              ───────────────────────────────────────────
   const s = remote.job.attach(req, signal)
        │  open { streamId, endpoint, payload } ───────▶  opener(endpoint, payload, uplink, peer, control)
        │                                                     │ prepareInvocation
        │  s.send(v1) → item { streamId, v1 }    ───────▶  inbox.push(v1)   │ invocation = { request, service, peer, signal, uplink() }
        │  s.send(v2) → item { streamId, v2 }    ───────▶  inbox.push(v2)   │ receiverContext.extend({ invocation }).get(service)
        │  s.end()    → end  { streamId }        ───────▶  inbox.end()      │ method(...args, signal)
        │                                        ◀───────  item { streamId, o1 }   │   for await (v of this.ctx.invocation.uplink()) …
        │  for await (o of s) …                  ◀───────  item { streamId, o2 }   │   yield o …
        │  s.dispose() → cancel { streamId }     ───────▶  control.abort()         │ signal aborts; uplink.return()
        │                                        ◀───────  end | error
```

### 术语

| 术语 | 含义 |
| --- | --- |
| 逻辑流 | 一个 `streamId` 标识的一次调用，跨越 `open` 到终止帧 |
| 代际 | 一条逻辑流的一次物理生命期。传输层只认一个代际；断线即失败，重开是上层的事 |
| 下行 | Host 到 Client 的 `item` 序列，以 `end` 或 `error` 终止 |
| 上行 | Client 到 Host 的 `item` 序列，以 `end` 终止（半关闭），或随 `cancel` 一起结束 |
| 半关闭 | 一个方向已结束而另一个方向仍开放 |
| 项 | 一个方向上的一个业务值；每项独立经 codec 校验 |
| inbox | Host 侧每逻辑流一个的有界上行队列 |
| Peer | 连接层被接纳的一方，一个 `PeerScope`；本 Host 只有操作者一个 Peer |
| 调用上下文 | `RemoteInvocation`：本次调用的请求、接收服务、Peer、取消信号与上行入口 |

### 类型签名

```text
// @deepseek-ai/dsh-typert-protocol
/**
 * One Remote stream. Host face: the method returns it, and at runtime it is AsyncIterable<Out>.
 * On the Client face the generated method returns RemoteStreamHandle<Out, In>; each name has exactly one meaning.
 * In is the item type the Client may send uplink; the default never means the method reads no uplink.
 */
export type RemoteStream<Out, In = never> = AsyncIterable<Out> & { readonly [STREAM_UPLINK]?: In }

// Host
@Remote({ mode: 'stream' })
async *attach(request: JobAttachRequest, signal: AbortSignal): RemoteStream<JobFollowFrame, JobInputFrame> {
  const uplink = this.ctx.invocation.uplink<JobInputFrame>()
  void (async () => { for await (const frame of uplink) … })()
  yield …
}

// Generated Client signature: same parameters, returns the handle
attach(request: JobAttachRequest, signal?: AbortSignal): RemoteStreamHandle<JobFollowFrame, JobInputFrame>

// Client usage
const stream = remote.job.attach(req, signal)
for await (const frame of stream) …
stream.send(frame)     // typed as JobInputFrame
stream.end()
stream.dispose()
```

`RemoteStream` 是别名而不是接口，是刻意的：将来若把传输层做成 Node 流形态，只换别名的定义与两端的适配，方法签名、描述符、上层协议都不动。

### Host 面

```text
/** The context of this Remote call. A method reads it through this.ctx.invocation. */
export interface RemoteInvocation {
  readonly request: {
    readonly namespace: string
    readonly method: string
    readonly args: Readonly<Record<string, unknown>>
  }
  /** Cordis service key of the receiving service. */
  readonly service: string
  /** The Peer that initiated the call. In-process carriers and unadmitted calls are the operator. */
  readonly peer: PeerScope
  /** Carrier cancellation: Client cancel, socket closure, uplink failure. */
  readonly signal: AbortSignal
  /**
   * The uplink items of this call. Can be taken once; the second call throws. With an uplink codec
   * in the descriptor each item is decoded to In; without one, items are delivered as unknown with
   * only a JSON-safety check.
   * The iteration ends after the Client's end; when the method ends the downlink, the Gateway calls
   * its return() and drops unconsumed items.
   * The generic In is only the caller's type assertion; runtime decodes per the descriptor and does not cross-check.
   */
  uplink<In = unknown>(): AsyncIterable<In>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Remote call this Context was derived for; undefined on a Context not derived from a Remote call. */
    readonly invocation: RemoteInvocation | undefined
  }
}
```

规则：

1. 任何 `mode: 'stream'` 方法都可以调用 `this.ctx.invocation.uplink()`；unary 方法也可以，但它的流在方法返回时结束，上行项只在方法运行期间可读。
2. `uplink()` 未被调用时，上行项在 inbox 里攒着，直到超限（见背压）或流结束被丢弃。这是刻意的：不读上行的方法不用知道上行存在。
3. `In` 缺省为 `never` 时描述符没有 uplink codec；客户端句柄的 `send` 类型为 `never`，编译期就不能发。运行时若仍有帧到达（手工构造的客户端），按 `unknown` 交付。
4. `this.ctx.invocation` 在非 Remote 调用的 Context 上是 `undefined`；方法内读它时按 TS 的可选处理，或在方法第一行断言。该属性的 accessor 由 `TypertRemoteService` 基类构造时注册一次，任何装有 Remote 服务的组合都能读它。

#### 调用上下文如何到达方法

机制依赖 Cordis 的两条既有行为：

- `ctx.extend(meta)` 是 `Object.create(parent)` 加自有属性（`vendor/cordis/src/context.ts:99-107`），无注册、无 fiber、不需释放，每次调用派生一个是零成本的。
- `ctx.get(service)` 返回 `createTraceable(ctx, service)` 代理（`vendor/cordis/src/reflect.ts:233-234`，`utils.ts:117-125`）。读 `ctx` 属性直接返回访问方的 Context（`utils.ts:175`）；读方法时用 `createShadowMethod` 包一层，`apply` 时把 `this` 换成 shadow receiver，shadow 上的 `ctx` 是 `ctx.extend({ [symbols.shadow]: origin })`（`utils.ts:149-163`）。
- 网关因此写 `receiverContext.extend({ invocation }).get(descriptor.service)` 取一个调用视图，`Reflect.apply(method, callReceiver, args)`；方法体里 `this.ctx.invocation` 沿原型链读到本次调用。async generator 体延后执行不受影响，因为 `this` 在调用时已绑定为 shadow 对象。

### PeerScope

```text
/** The opaque identity of one Peer. */
export type PeerId = Branded<'PeerId'>

/** One Peer's session on this Host: opened and released by the admitting side; ctx owns connection-lifetime registrations. */
export interface PeerScope {
  readonly id: PeerId
  readonly ctx: Context
  dispose(): Promise<void>
}
```

本 Host 只有一个 Peer：操作者。`@deepseek-ai/dsh-client-connection` 在服务 apply 时用 `createScope(connectionCtx, peer)` 建它，与 Agent 建自己的 scope 是同一机制：Peer 对象就是 ScopeKey，`peer.ctx` 承接连接期效果，`dispose()` 随 connection 释放让 fiber 静默。它以 `connection.operator` 暴露。

| 成员 | 语义 |
| --- | --- |
| `connection.operator: PeerScope` | 唯一的 Peer，随 connection 生灭 |
| `connection.admit(request): PeerAdmission` | 过既有的 `requestRejection`：被拒返回 `{ rejection: 401 \| 403 }`，否则返回 `{ peer: operator }`。将来的接纳方在这里接入 |

网关 `handleUpgrade(req, socket, head, peer)` 为该 socket 绑一个固定 Peer 的 opener，并在 `peer.ctx.effect` 里登记 socket 关闭；scope 已失效时改为直接以 1001 关闭 socket。`InvokeRemoteRequest.peer?` 与 `RemoteStreamOpener` 的 `peer` 形参缺席时按操作者作答，现有进程内调用方零改动；没有 connection 的组合里网关自建的操作者替身同样经 `createScope` 建立，`dispose()` 契约一致。按 id 查 Peer、把载体关联到第二个 Peer、Peer 的开关事件，都等第一个需要多 Peer 的消费者出现时再加。

Peer 不携带访问模型：Peer 是谁、能做什么，由业务插件通过 `peer.ctx` 自行附加。

### Client 面

```text
/** The handle a generated method returns on the Client face. A different name from the Host's RemoteStream, exported from the same entry point. */
export interface RemoteStreamHandle<Out, In> extends AsyncIterable<Out> {
  /** Send one uplink item. Throws on a value that is not lossless JSON, after termination, or after end. */
  send(item: In): void
  /** Half-close the uplink: sends the end frame. Idempotent. */
  end(): void
  /** Cancel the whole logical stream: sends the cancel frame (when no terminal frame has arrived); the downlink iterator ends quietly. */
  dispose(): void
}
```

- 句柄代表一个代际。载体丢失时 `for await` 以 `RemoteStreamCarrierError` 失败，句柄到此结束；要不要重开、带什么参数重开，是上层协议的事。
- `send` 是同步的：入队前做 `isRemoteJsonValue` 校验，非无损 JSON 值同步抛错。浏览器 `WebSocket.send` 没有写回调，发送节流没有意义；Host 侧的 inbox 上限是唯一的背压点。
- 收到终止帧（`end` / `error`）时，mux 客户端在收帧路径上立即停泵并关闭上行队列，之后 `send` / `end` 抛错，不等消费者下一次读。
- `dispose()` 调用载体迭代器的 `return()`，让 `cancel` 帧在无人读下行时也发出；之后句柄的 `next()` 直接结束，缓冲项丢弃。消费者提前 `break` 出 `for await` 等价于 `dispose()`。
- `$stream` 监督器、`RemoteSnapshotStream`、`RemoteJournalStream` 是上层工具，不在传输层内。它们的 `open` 工厂拿到的对象现在就是句柄，`for await` 行为不变；把 `send` 透出到这些上层协议是后续的事。

### 线路帧

```text
export type RemoteStreamClientMessage =
  | { readonly type: 'open'; readonly streamId: string; readonly endpoint: string; readonly payload: unknown }
  | { readonly type: 'item'; readonly streamId: string; readonly value?: unknown }   // new: uplink item
  | { readonly type: 'end'; readonly streamId: string }                              // new: uplink half-close
  | { readonly type: 'cancel'; readonly streamId: string }

/** Frames sent by the Host are unchanged. */
export type RemoteStreamServerMessage =
  | { readonly type: 'item'; readonly streamId: string; readonly value?: unknown }
  | { readonly type: 'error'; readonly streamId: string; readonly error: RemoteStreamFailure }
  | { readonly type: 'end'; readonly streamId: string }
```

解析规则：`item` 精确键 `type` `streamId` 加可选 `value`，`value` 须为无损 JSON 值（`isRemoteJsonValue`）；`end` 精确键 `type` `streamId`。其余形状是帧格式违规，socket 以 1008 关闭。不引入二进制帧。

### 逻辑流状态机

#### Host 侧

```
                open frame
   (none) ───────────────────▶ opening ──── opener resolves ────▶ running
                                  │                                  │
                                  │ item frame: inbox.push           │ item frame: inbox.push
                                  │ end frame: inbox.end             │ end frame: inbox.end (uplink half-close)
                                  │                                  │ method yield: sends item frame
                                  │ cancel frame / socket close ────▶│ cancel frame / socket close: control.abort
                                  ▼                                  ▼
                               aborted ◀───────────────────────── finished (sends end or error frame)
```

`opening` 期间到达的 `item` 帧进入 inbox：`receive()` 是同步的，`open` 帧处理时就创建 `ActiveStream` 与 inbox，而 opener 是异步的。客户端在 `open` 之后立刻发的项不会丢。

#### Client 侧

```
   call generated method ──▶ await socket ──▶ send open ──▶ handle usable
                                                            │ send(v): sends item; end(): sends end
                                                            │ downlink: inbox.next() → yield; end → ends; error → throws
                                                            │ downlink terminates first: send/end throw
                                                            │ dispose or caller signal abort: sends cancel (when no terminal frame has arrived)
```

### 半关闭与结束语义

| 上行 | 下行 | 结果 |
| --- | --- | --- |
| 客户端 `end` | 仍开放 | Host 的 `uplink()` 迭代结束；方法继续产出。这是 stdin EOF 的形状 |
| 仍开放 | Host 方法结束，发 `end` | 客户端句柄终止，之后 `send` / `end` 抛错；Host 调用 `uplink` 迭代器的 `return()`，未消费项丢弃 |
| 仍开放 | Host 方法抛错，发 `error` | 同上；客户端下行以 `RemoteError` 失败 |
| 客户端 `dispose` 或 signal 中止 | 任意 | 发 `cancel`；Host `control.abort()`，`cancellableStream` 先关 `uplink`，再调方法迭代器的 `return()`；不发终止帧 |
| socket 关闭 | 任意 | Host 中止全部流并等待 `done`；客户端每条流以 `RemoteStreamCarrierError` 失败 |
| `end` 之后又收到 `item` | 任意 | 该流以 `gateway/protocol` 错误帧失败并中止；socket 不关闭 |
| 未知 `streamId` 的 `item` / `end` | 任意 | 忽略，与 `cancel` 相同：Host 结束流并删除 id 后，客户端在途的上行帧属正常现象，不能连累同一 socket 上的其他流 |

### 取消等待的生命周期

`cancellableStream`、`UplinkDecoder.next()` 和 Client 上行泵各自为单次读取创建取消或停止 Promise。读取完成后，`Promise.race` 不会移除另一输入上的 reaction：复用流级未完成 Promise 会保留已完成的竞争及其读取结果，直到该 Promise 完成或不可达。单次读取的 Promise 使取消状态的保留量不随已交付项数增长。

Host 下行在每次读取后清除当前拒绝回调，并在再次读取前检查取消状态。上行解码器只保留尚未完成的读取：取消时拒绝这些读取，正常关闭则以 `done` 唤醒全部读取，包括重叠的读取。Client 泵在每次读取后移除停止 Promise，停止后不再发起读取。源迭代器的释放仍由原有所有者负责；Host 仍先关闭上行，再返回方法迭代器。

### 顺序保证

同一条 socket 上的帧全序到达：一条逻辑流的 `open`、`item`…、`end` 按发送顺序到达 Host；上行项进入 `uplink()` 的顺序就是 `send` 的顺序。上行与下行之间没有跨方向顺序保证；需要请求应答配对的协议自带序号。

### 背压

WebSocket 没有 HTTP/2 那样的每流窗口，一个连接一条串行写链，慢流会拖住同连接的其他流。下行的这一性质不变。上行：

**有界 inbox 加整流失败。** Host 每条逻辑流的 inbox 按帧的 UTF-8 字节计量，上限为网关配置 `streamInboxBytes`（默认 262144），对所有流生效。超限时整条逻辑流以 `gateway/uplink-overflow` 失败：下行一起断，向客户端发 `error` 帧，`uplink()` 迭代器以同一错误结束。数据不丢弃；一个方法不读上行而客户端持续发，是用法错误，由失败显式暴露。

credit 帧留待需要持续大流量上行的消费者出现时再加；inbox 上限就是初始授信，加法是增量。

### 安全与校验

| 项 | 规则 |
| --- | --- |
| 鉴权 | 与今天相同：升级时 `connection.requestRejection(req)`；打开时描述符与查找参数校验。上行项属于一条已鉴权的流，不重复鉴权 |
| Peer | 升级时接纳为一个 `PeerScope`，该 socket 上所有流的 `invocation.peer` 都是它 |
| 项校验 | 有 uplink codec 时逐项严格解码，失败即整条流以既有的 `gateway/input-invalid` 失败（details `{ endpoint, field: 'uplink' }`）；无 codec 时只做 JSON 安全校验 |
| 帧大小 | 单帧沿用 `ws` 的 `maxPayload`；inbox 上限限制累计量 |

### 进程内与 worker 载体

| 载体 | 改为 |
| --- | --- |
| `ClientConnectionRpc.open`（`packages/client/connection/src/rpc.ts:245-250`）与 `RpcStreamOpen`（`client/rpc.ts:21-25`） | 追加可选 `uplink?: AsyncIterable<unknown>`；进程内没有帧也没有 inbox，调用方迭代器直接作为 `uplink()` 的源，背压就是迭代器本身的节拍 |
| worker 隧道（`packages/experimental/webworker-runtime`） | 页面新增 `stream-uplink-item` / `stream-uplink-end` 帧；`serveStream` 把它们组装成 `uplink` 交给 `seams.openStream`。同源可信边界：没有 inbox 上限，`end` 之后的项丢弃 |
| `remote-mock`（`packages/test-support/remote-mock`） | `StreamHandle.uplink: AsyncIterable<unknown>`；`rpc.open` 透传 |

进程内载体的 `peer` 缺席即操作者。

### 与 `$events` 的关系

`$events` 是一条保留端点的流；有了上行帧，waterfall 的回答可以成为同一 `streamId` 上的上行项，`clientId` 因 `streamId` 已标识代际而多余，`$events/result` 与 `index.ts:527-529` 的竞态一起消失。不在本 Note 范围，见「后续」。

## 类型与线路定义

### typert protocol（`packages/typert/protocol/src`）

```text
// types.ts
export type RemoteStream<Out, In = never> = AsyncIterable<Out> & { readonly [STREAM_UPLINK]?: In }
export type PeerId = Branded<'PeerId'>
export interface PeerScope { readonly id: PeerId; readonly ctx: Context; dispose(): Promise<void> }
export interface RemoteInvocation { … }              // see Host face
declare module '@deepseek-ai/cordis' { interface Context { readonly invocation: RemoteInvocation | undefined } }

export interface InvocationDescriptor {
  // existing fields unchanged; mode still has only 'stream'
  readonly mode?: 'stream'
  /** Uplink item codec, generated from In of the return type RemoteStream<Out, In>; absent when In is never. */
  readonly uplink?: { readonly codec: TypertCodec }
  readonly cancellation?: { readonly parameter: 'signal' }
  readonly result: TypertCodec
}
```

`Remote` 修饰器、`RemoteMethodOptions`、`RemoteMethodMarker` 恢复为只认 `mode: 'stream'`。

### typert generator（`packages/typert/generator/src`）

- `model.ts`：`InvocationModel.uplink?: { boundary: RemoteBoundaryModel }`。
- `analyzer.ts` `remoteResultType`：对 `mode: 'stream'`，接受的返回类型包装器为 `Iterable<Out>`、`AsyncIterable<Out>`、`RemoteStream<Out, In?>`。识别 `RemoteStream` 的方式与识别标准库 `AsyncIterable` 相同：符号名加声明所在文件（`@deepseek-ai/dsh-typert-protocol` 的 `types.ts`）。第一个类型参数是下行项，第二个存在且不是 `never` 时生成 `uplink` boundary，键名 `${endpoint}:uplink`。
- `emitter.ts`：描述符字面量输出 `uplink: { codec }`；生成的 Client 签名返回 `RemoteStreamHandle<Out, In>`。
- 参数循环不再识别任何名为 `uplink` 的参数。

### 两个名字，一个入口

Host 方法用 `RemoteStream<Out, In>` 声明一条流；Client 持有的是 `RemoteStreamHandle<Out, In>`。两者都从 `@deepseek-ai/dsh-typert-protocol` 主入口导出，句柄接口没有任何 Host 依赖。生成的 Client 契约把返回类型写成 `RemoteStreamHandle<Out, In>`。一个名字只有一个含义：Client 代码从主入口拿到的 `RemoteStream` 永远是声明类型，不会与句柄混淆。

### 网关 Host（`packages/api/gateway/src`）

```text
// types.ts
export interface InvokeRemoteRequest {
  readonly namespace: string
  readonly method: string
  readonly args: Readonly<Record<string, unknown>>
  /** Uplink items; absent is equivalent to an iterator that ends immediately. */
  readonly uplink?: AsyncIterable<unknown>
  /** The Peer that initiated the call; absent means the operator. */
  readonly peer?: PeerScope
  readonly signal?: AbortSignal
}

export interface TypertGatewayWireStream {
  open: (endpoint: string, payload: unknown, uplink: AsyncIterable<unknown>, peer: PeerScope | undefined, signal: AbortSignal) => Promise<AsyncIterable<unknown>>
  failure: (error: unknown) => RemoteStreamFailure
}

// stream-server.ts
export type RemoteStreamOpener = (
  endpoint: string,
  payload: unknown,
  uplink: AsyncIterable<unknown>,
  peer: PeerScope,
  control: AbortController,
) => Promise<AsyncIterable<unknown>>

// index.ts Config addition
/** Uplink inbox limit per logical stream, in UTF-8 bytes of frames (default 262144). */
readonly streamInboxBytes?: number
```

`prepareInvocation`：

```text
const args = await Promise.all(descriptor.parameters.map(parameter => this.resolveParameter(parameter, request.args, endpoint)))
const signal = request.signal ?? NEVER_ABORTED_SIGNAL
const invocation = new GatewayInvocation(
  { namespace: request.namespace, method: request.method, args: request.args },
  descriptor.service,
  request.peer ?? this.operatorPeer(),
  signal,
  new UplinkDecoder(request.uplink ?? EMPTY_ASYNC_ITERABLE, descriptor.uplink?.codec, endpoint, control),
)
const callReceiver = receiverContext.extend({ invocation }).get(descriptor.service) as object
if (descriptor.cancellation !== undefined) args.push(signal)
```

`GatewayInvocation.uplink()` 第一次调用返回解码器，第二次抛错。`UplinkDecoder` 是手写迭代器：有 codec 时逐项 `decode(codec, value, endpoint, 'uplink')`，失败即 `control.abort(failure)` 并抛出；无 codec 时只做 `isRemoteJsonValue` 校验。`cancellableStream` 的 `finally` 先关闭解码器（`invocation.close()`）再等待方法迭代器的 `return()`，阻塞在 `uplink.next()` 上的方法得以退出。unary 与 stream 的模式分支恢复为今天的两分支。SRC 回退：描述符无 `uplink` codec，`uplink()` 交付 `unknown`。

### 网关 Host mux（`stream-server.ts`）

```text
interface ActiveStream { readonly control: AbortController; readonly inbox: UplinkInbox; done: Promise<void> }

/** Bounded uplink queue; iterated as the source of uplink(). */
class UplinkInbox implements AsyncIterable<unknown>, AsyncIterator<unknown> {
  constructor(maxBytes: number, onOverflow: (error: RemoteError) => void)
  push(value: unknown, frameBytes: number): void   // push after ended fails the stream with gateway/protocol; overflow calls onOverflow
  end(): void                                        // idempotent
  fail(error: unknown): void                         // ends the iterator with an error on cancel or carrier closure
  next() / return()                                  // hand-written: next races failure, return releases immediately
}
```

`receive(text)` 分派：

```
open   : exists → throw (socket 1008); otherwise create { control, inbox, done } and start the pump
item   : missing → ignore; otherwise inbox.push(value, bytes)
end    : missing → ignore; otherwise inbox.end()
cancel : missing → ignore; otherwise control.abort(new Error('Remote stream cancelled'))
```

`pump` 把 inbox 与该 socket 的 Peer 传给 opener；`finally` 里 `inbox.fail(...)`。以 `RemoteError` 为 reason 的中止由 pump 作为 `error` 帧发出（网关或 mux 发起的失败）；以普通 `Error` 为 reason 的中止（cancel、socket 关闭）不发终止帧。

### 网关 Client（`packages/api/gateway/src/client`）

- `prepareInvocation` 不再剥离任何上行参数；位置参数仍是业务参数加可选 `signal`。
- `invokeStream` 返回 `RemoteStreamHandle`：内部持有一个上行队列，`send` 入队并由泵发 `item` 帧，`end` 发 `end` 帧，`dispose` 中止代际 signal。下行仍是 `openRemoteStream` 返回的迭代器。
- `RemoteStreamMuxClient.open(endpoint, payload, signal, uplink?)`：在发出 `open` 帧后启动上行泵，逐项发 `item`，源结束发 `end`；下行终止或 signal 中止时停泵并调用源的 `return()`（不等待，避免键盘类生成器卡死）；源抛错时 `inbox.fail(error)`，下行以该错误失败，`finally` 按既有规则发 `cancel`。泵检查 `this.socket === socket`，旧代际不往新 socket 上发帧。
- 进程内载体：`connection.rpc.open(channel, endpoint, payload, signal, uplink)`。

## 落点

| 包 | 承载 |
| --- | --- |
| `dsh-typert-protocol`（`types.ts`、`index.ts`） | `RemoteStream`、`RemoteStreamHandle`、`PeerId`、`PeerScope`、`RemoteInvocation`、`ctx.invocation` 声明合并、`InvocationDescriptor.uplink`；修饰器只认 `mode: 'stream'`；`TypertRemoteService` 构造时注册 `invocation` accessor |
| `dsh-typert-registry` | 加载校验 `uplink.codec` 为有效的严格 codec |
| `dsh-typert-generator`（`model.ts`、`analyzer.ts`、`emitter.ts`） | `remoteResultType` 识别 `RemoteStream<Out, In>` 并生成 `uplink` boundary；描述符输出 `uplink: { codec }`；生成的 Client 签名返回 `RemoteStreamHandle<Out, In>`；参数循环只认业务参数与末位 `signal` |
| `dsh-client-connection`（`operator-peer.ts`、`rpc.ts`、`rpc-host.ts`、`index.ts`） | 操作者 `PeerScope`；`connection.operator` 与 `admit`；`/api` 与升级路由经 `admit` 取 Peer；`rpc.open` 的可选 `uplink` |
| `dsh-api-gateway` Host（`stream-protocol.ts`、`stream-server.ts`、`types.ts`、`index.ts`） | `item` / `end` 帧；`UplinkInbox`；`Config.streamInboxBytes`；`GatewayInvocation` 与 `extend({ invocation })`；`UplinkDecoder`；`handleUpgrade(req, socket, head, peer)`；`operatorPeer()` |
| `dsh-api-gateway` Client（`client/index.ts`、`client/stream-client.ts`） | `invokeStream` 返回句柄；上行泵由句柄的队列驱动 |
| `dsh-webworker-runtime`、`dsh-remote-mock` | worker 隧道的两种上行帧与 `serveStream` 组装；`StreamHandle.uplink`；直接代理返回真句柄 |
| 文档 | gateway、api 组、connection、protocol、generator 的 README；`docs/api-gateway`；`docs/subsystems/typert` 的 type-equiv 块；config 与 Cordis 目录 |

## 关键流程时序

### 打开、上行、半关闭、下行结束

```
Client caller      mux client              mux server              gateway                 Host method
   │ attach(req)        │                       │                     │                         │
   │───────────────────▶│ open { id, ep, payload } ──────────────────▶│ create inbox            │
   │ s.send(v1)         │ item { id, v1 } ───────────────────────────▶│ inbox.push(v1)          │
   │                    │                       │                     │ prepareInvocation       │
   │                    │                       │                     │ extend({ invocation })  │
   │                    │                       │                     │── method(req, signal) ─▶│
   │                    │                       │                     │                         │ uplink() → v1
   │ s.send(v2)         │ item { id, v2 } ───────────────────────────▶│ inbox.push(v2)          │ → v2
   │ s.end()            │ end { id } ────────────────────────────────▶│ inbox.end()             │ iteration ends
   │◀── yield o1 ───────│◀────────────────────── item { id, o1 } ─────│◀── yield o1 ────────────│
   │◀── ends ───────────│◀────────────────────── end { id } ──────────│◀── method returns ──────│ gateway calls uplink.return()
```

### 客户端 dispose

```
Client caller      mux client              mux server              gateway                 Host method
   │ s.dispose()        │                       │                     │                         │
   │───────────────────▶│ stop pump; source return() (not awaited)    │                         │
   │◀── iterator ends ──│ cancel { id } ─────────────────────────────▶│ control.abort()         │
   │                    │                       │                     │ cancellableStream: invocation.close() closes uplink
   │                    │                       │                     │ iterator.return() ─────▶│ finally cleanup
   │                    │                       │ no terminal frame   │                         │
```

### inbox 超限

```
Client caller      mux client              mux server                        gateway / Host method
   │ s.send(vN)         │ item { id, vN } ─────▶│ inbox.push: bytes > streamInboxBytes │
   │                    │                       │ onOverflow → control.abort(RemoteError uplink-overflow)
   │                    │                       │                                      │ uplink() ends with that error; method iterator return()
   │◀── throw ──────────│◀──────────────────────│ error { id, uplink-overflow }: the pump sends an error frame because the reason is a RemoteError
```

## 边界矩阵

| 事件 | opening | running | 上行已 end | 下行已终止 |
| --- | --- | --- | --- | --- |
| 收到 `item` | 入 inbox 缓冲 | 入 inbox | 流以 `gateway/protocol` 失败 | 忽略 |
| 收到 `end` | inbox.end | inbox.end | 幂等 | 忽略 |
| 收到 `cancel` | abort | abort | abort | 忽略 |
| inbox 超限 | 流以 `uplink-overflow` 失败 | 同 | 不可能 | 不可能 |
| 解码失败 | 不可能 | 流以 `input-invalid` 失败 | 同 | 不可能 |
| Host 方法结束 | 不可能 | 发 `end`；`uplink.return()` | 发 `end` | 已发 |
| Host 方法抛错 | 发 `error` | 发 `error`；`uplink.return()` | 发 `error` | 已发 |
| socket 关闭 | abort，等 done | 同 | 同 | 无事 |
| Client `send` | 入队，open 后发 | 发 | 抛错 | 抛错 |
| Client `end` | 记录，open 后发 | 发 | 幂等 | 忽略 |
| Client 侧下行先结束 | 不可能 | 停泵；源 `return()`；不发 `end` | 无事 | 无事 |

## 错误码

| 错误码 | 何时 |
| --- | --- |
| `gateway/input-invalid` | 既有：参数 codec 解码失败；新增：上行项解码失败 |
| `gateway/uplink-overflow` | 新增：inbox 超过 `streamInboxBytes` |
| `gateway/protocol` | 新增：`end` 之后的 `item` |
| `gateway/cancelled` | 既有：`signal` 中止 |

新码登记在 `packages/api/gateway/src/remote-error-codes.ts` 与 README 的错误码一节。

## 最小 echo 方法

`packages/api/gateway/tests/echo-stream.host.spec.ts` 让同一个方法分别穿过 WebSocket 载体与进程内载体：

```text
class EchoService extends TypertRemoteService {
  constructor(ctx: Context) { super(ctx, 'echo', { namespace: 'echo' }) }

  @Remote({ mode: 'stream' })
  async *echo(prefix: string, signal: AbortSignal): RemoteStream<string, string> {
    for await (const item of this.ctx.invocation!.uplink<string>()) {
      signal.throwIfAborted()
      yield `${prefix}${item}`
    }
  }
}

// Client
const stream = remote.echo.echo('> ')
stream.send('a'); stream.send('b'); stream.end()
const replies: string[] = []
for await (const reply of stream) replies.push(reply)   // ['> a', '> b']
```

## 考虑过的替代方案

**三处读取循环共用一个取消控制器。** 每处循环已有自己的所有者和不同的关闭行为。单次读取的 Promise 能限制保留状态，不需要把这些职责迁入新抽象。

**要求源迭代器自行取消 `next()`。** Gateway 接受任意 iterable，其待处理读取不一定响应取消或 `return()`。Gateway 仍需独立于源清理来唤醒自己的等待者。

**独立的 `mode: 'duplex'` 加一个与 `signal` 同级的保留参数 `uplink: AsyncIterable<In>`。** 每一处都是特殊逻辑：analyzer 要认第二个保留参数及其位置规则，生成签名多一个参数，加载期要校验 `duplex ⟺ uplink`，mux 不知道方法模式所以网关要替 `'stream'` 方法拒绝上行帧。双工是传输层流的固有性质，不是方法的一种模式：载体本来就有 `streamId`、`open`、`cancel`，上行只是再加两种帧，任何流都能收，不用就不发。

**用装饰器选项声明上行类型，`@Remote({ mode: 'stream', uplink: 'JobInputFrame' })`。** 字符串引用类型名不受编译器约束，重命名即断。返回类型别名把两个类型写在同一个编译器可见的位置。

**运行时传 schema：`uplink(schema)`。** 不经生成器，客户端失去类型投影，与"每项严格 codec"的体系分裂。codec 的来源仍是生成器，方法里的泛型只是断言。

**analyzer 交叉校验 `uplink<In>()` 手填的泛型与返回类型一致。** 业务特化的校验，写错后果由调用方承担，与仓库其他处手填断言一致；不加。

**传输层句柄带重开、游标、`reopen` 钩子。** 断线重开是上层协议的事：job 的续传是 `opened` 帧带 `from`、客户端记住 `next` 再调一次；snapshot 与 journal 各有自己的锚点与分类。传输层只认一个代际。

**客户端 `send` 放在生成方法返回的 `AsyncIterable` 上。** `AsyncIterable` 上挂方法不常规；句柄类型 `RemoteStreamHandle` 显式扩展它。

**照搬 Access 机制。** 访问控制是业务语义，`vouch` 与 `remote/invoke` waterfall 为它服务；本 Note 只需要"这条流是谁的"，`PeerScope` 就够。

**继续用 unary RPC 做上行。** 每次上行一次 HTTP 往返、一次鉴权、一次查找；两条载体没有顺序关系，只能靠客户端串行化；没有 EOF；取消不覆盖两半；每个功能各造一套关联键。

**原生 HTTP 请求体流。** 一次性请求体，与下行流没有关联，不经 Typert 描述符，浏览器对全双工 fetch 的支持不可依赖。

**每条双工流一个独立 WebSocket。** 失去与现有下行流共享的鉴权、心跳与多路复用，每个功能要自己管一条 socket 的生命周期。

**WebTransport 或 HTTP/2 双向流。** 有每流流控，但浏览器与 Node 两侧的支持、代理穿透与 Electron 载体都不成熟；在现有 mux 上加两种帧比换传输层便宜几个量级。

## 后果

- **买到的**：一条流两个方向，终端按键、审批回答、后台任务 stdin 这类交互式场景不再各造一套"一条流加一个 unary"；Host 方法知道调用者；上行类型与下行类型在返回类型里一处声明，上行项来自浏览器，在 Host 逐项严格校验，下行项是 Host 自产的类型值，直接透传；既有 `AsyncIterable<Out>` 方法与 unary 方法的生成物与线路帧完全不变。
- **`this.ctx.invocation` 在非 Remote 调用下是 `undefined`**，方法读它要处理可选；一个只被进程内直接调用的服务方法读到 `undefined` 是正确行为。
- **inbox 上限对所有流生效**：一个不读上行的方法收到大量上行帧会整流失败。这是刻意的显式失败，README 记明。
- **Peer 只有操作者一个**，`admit` 是唯一的接纳点；第一个需要第二个 Peer 的消费者要在 `dsh-client-connection` 加上打开、关联与事件。
- **上行与下行之间没有跨方向顺序保证**；需要请求应答配对的协议自带序号。
- **上层协议尚未透出 `send`**：`$stream`、snapshot、journal 的消费者今天只用下行；它们拿到的对象已经是句柄。
- **worker 隧道与 WebSocket 载体行为不同**：没有 inbox 上限，`end` 之后的项丢弃，因为页面到 worker 是同源可信边界。

## 测试

`gateway-stream.host.spec.ts` 和 `gateway.client.spec.ts` 中的保留对象用例在流保持打开时进行全量 GC，再统计存活的迭代结果。生命周期用例覆盖正常关闭唤醒多个待处理上行读取、两次读取之间的取消、源同步取消后抛错，以及 Client 发送期间流结束。

- `packages/api/gateway/tests/echo-stream.host.spec.ts`：同一个 echo 方法分别穿过 WebSocket 载体与进程内载体。
- 网关 Host：帧解析的精确键校验；`UplinkInbox` 的 opening 缓冲、`end` 后 `item`、超限、未知 `streamId` 忽略、socket 关闭时的收尾；`UplinkDecoder` 有无 codec 两种交付与解码失败中止；`uplink()` 只能取一次；`extend({ invocation })` 视图与 `peer` 的来源；`cancellableStream` 先关 uplink 再 `return()`。
- 网关 Client：句柄的 `send`（JSON 校验、open 前入队、终止后抛错）、`end` 幂等、`dispose` 驱动 `cancel` 帧并结束后续读取；泵的三种退出；终止帧到达即停泵。
- typert：analyzer 对 `RemoteStream<Out, In>`、`RemoteStream<Out>`、`never` 与既有 `AsyncIterable<Out>` 的处理；修饰器选项；registry 加载校验。
- connection：`admit` 的 401、403 与操作者三种结果；操作者经桥与共享处理器到达；随 connection 释放。
- remote-mock、worker 隧道：上行透传；直接代理返回真句柄。
- 既有 stream 与 unary 方法的测试不改期望值即通过。

## 后续

- `$stream` / snapshot / journal 把句柄的 `send` 透出给上层协议。
- Web 终端：一条 `attach` 流取代 `follow` 加 `write` 加 `resize`，`attachmentId` 退场。
- 双工 `$events`：waterfall 的回答成为同一 `streamId` 上的上行项，`$events/result` 与 `clientId` 退场。
- credit 帧：等需要持续大流量上行的消费者出现；inbox 上限就是初始授信。
- `streamInboxBytes` 默认值 262144 对键盘与 stdin 远超需要；若第一个消费者是终端粘贴，可能与 `terminal-controller` 的 `maxInputBytes` 对齐。
- Host 发起的半关闭帧（Host 不再读上行但继续写下行）：没有消费者，不加。
- unary 方法的 `uplink()`：能读到方法运行期间到达的项，语义成立但用处存疑；允许，README 注明。

## 相关

- [Remote 事件投递](2026-08-10-remote-event-delivery.zh.md)：`$events/result` 的 unary 回答路径；「后续」里的双工 `$events` 落地后部分取代它。
- [会话历史与事件传输](2026-08-18-session-history-and-event-transport.zh.md)：`$stream()` 监督器与其上的 journal / snapshot 协议，本 Note 不改它们。
- [Web 侧边栏终端](../feature/2026-09-09-web-sidebar-terminal.zh.md)：终端按键的 unary `write` 与 `attachmentId`；「后续」里的 `attach` 流落地后取代它。
