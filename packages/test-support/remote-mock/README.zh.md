---
description: "Typert Remote 流量的端点具名 mock：一元应答与流脚本的表、活流控制、日志与 Connection 载体面，供测试作者在没有 Host 的情况下启动真实浏览器客户端。"
kind: "package-library"
---

# @deepseek-ai/dsh-remote-mock

[English](README.md) | 中文

## 概述

`dsh-remote-mock` 让测试通过 `mock.remote.<namespace>.<method>`，使用原生 Vitest mock 方法配置 Host 响应。同一组函数应答直接调用与真实 Connection 流量；可复用的表提供默认响应，显式声明的流支持测试驱动的推帧与取消。缺少响应时调用失败，`assertNoUnmatched()` 会在收尾时再次报告。本包无需业务 Host 即可在 Node 或浏览器页面中运行，不导入 DOM、React 或 Node 模块，只从 `devDependencies` 消费。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 何时使用

当测试要启动与 `ctx.remote` 对话的真实客户端插件、并想按端点名脚本化 Host 侧时使用它：整体客户端测试把 `mock.rpc` 绑定到各自的 Connection 实例，单元测试也可以直接调用 `mock.remote`、`dispatch` 或 `open`。端点是 Gateway 的 wire 名（`session/page`、`settings/describe`）；`args` 是调用方的位置参数列表，末尾的 `AbortSignal` 已剥掉；值就是测试登记的东西，原样应答。唯一的声明是端点是一元（`unary`）还是流（`stream`）。

<a id="remote-proxy"></a>
### 使用 Remote Proxy

`mock.remote` 无需方法清单或领域专属 Helper 即可提供每个命名空间和方法。每个访问过的端点使用缓存的原生 Vitest mock；`@vitest/spy.fn` 就是 `vi.fn` 背后的实现，也能在没有 Vitest runner 的浏览器页面中运行。同一个 mock 应答直接调用与 Connection 流量，因此返回值覆盖和调用断言观察的是客户端实际调用的函数：

```text
const mock = RemoteMock.create().load(remoteDefaultResponses)
mock.remote.settings.describe.mockResolvedValue(ok({
  writable: true, hasDocument: false, namespaces: [],
}))
mock.remote.settings.mutate.mockResolvedValueOnce(ok(updatedNamespace))
// After the client writes:
expect(mock.remote.settings.mutate).toHaveBeenCalledWith('locale', operations, revision)
```

使用 `mockResolvedValue` 设置持续响应，使用 `mockResolvedValueOnce` 或 `mockReturnValueOnce` 排队设置响应，使用 `mockImplementation` 按参数决定行为。原生队列按登记顺序消费响应，耗尽后由 mock 的当前实现应答；初始实现读取已登记的默认响应。`mockClear()` 保留响应与队列；`mockReset()` 清除覆盖并恢复初始实现，由它读取最新默认响应。若未配置默认响应，排队响应耗尽后仍会失败，包括可能同步抛错的直接调用。

只有显式 `stream()` 或响应表中的流声明才选择流方法；其余均使用一元 mock。访问方法不会凭空构造成功的业务结果。保存方法引用前先声明流模式：每个端点/模式拥有各自的 mock。命名空间和方法的 `then` 探测及 symbol 读取均无副作用。

`MockedRemote` 使用 Vitest 的深层 mock 类型转换，覆盖完整生成的 `TypertRemoteNamespaceMap`。非空映射保留命名空间与方法名、参数、返回值和原生 spy 类型。映射为空时只有这个测试 Proxy 变成 `any`，允许任意命名空间和方法；它不增补或弱化生产 Remote 声明。不需要复制方法签名、抑制可选生成模块错误或开启编译器级全局 Flag。交付 Remote/mock 改动前运行 `pnpm run typecheck`，生成并检查真实 Client 类型；声明缺失、陈旧或不完整时先重新构建。无构建测试通过或推断为 `any` 都不是严格类型证据。

### 登记默认响应

`load(table)` 安装可复用的 `unary` 值或 handler、`stream` 脚本以及无脚本的 `streams` 声明。`unary(endpoint, value)` 与 `unary(endpoint, fn)` 登记单个默认响应；handler 接收调用方的位置参数，并使用现有请求类型。每个端点仅保存最新默认响应，包括显式 `undefined`；更新默认响应不会清除原生覆盖。`ok(value)` 构造 `{ ok: true, value }`；失败使用 `{ ok: false, error: { code, message, details } }`。有状态 handler、promise 与原生队列均由各测试独立持有：

```text
const initial = { writable: true, hasDocument: false, namespaces: [] }
const mock = RemoteMock.create().load({
  unary: { 'settings/describe': ok(initial) },
})
mock.remote.settings.describe.mockResolvedValueOnce(ok({ ...initial, hasDocument: true }))
```

### 驾驭流

流脚本是一个接收打开时的 `args` 与 `StreamHandle`（`push`、`end`、`fail(error)`、`signal`）的函数；脚本返回后流保持打开，直到句柄结束或失败。`frames(items)` 构造吐完即结束的脚本，`openStream(initial)` 构造吐完后保持打开的脚本。`mock.streams` 控制客户端当前打开着的流，可按打开时的参数过滤；`opened(endpoint, count)` 在该端点被打开达到该次数时 resolve，`drained(endpoint)` 在每条匹配流的消费方都拉完了迄今推入的全部内容时 resolve——打开的流要其消费方再次等待，已定局的流要队列已空（拉完指从队列取走；只有在读循环内处理项的消费方才等于处理完）：

```text
mock.stream('session/follow', openStream([snapshotFrame]))
await mock.streams.opened('session/follow', 1)
mock.streams.push('session/follow', eventFrame, ([request]) => (request as { sessionId: string }).sessionId === SID)
mock.streams.fail('session/follow', new Error('gone'))
await mock.streams.drained('session/follow')
```

失败的流让消费方的下一次读取以给定的 `Error` reject。消费方取消（打开时的 signal 或 iterator 提前 `return()`）会中止 `StreamHandle.signal`、结束迭代而不抛错，并把该流记为 `cancelled`。

### 接上客户端

`mock.rpc` 是 `ClientConnectionRpc` 面。把它作为 `{ transport: { rpc: mock.rpc } }` 传给 Connection 安装函数，或让 `TestClient` 将其绑定到自身实例，每次 Remote 调用就会直达 `dispatch`、每条流直达 `open`，中间没有信封。payload 携带 `{ args }`——整机代理发数组、Gateway 自身端点发一个对象（到达时是一个位置参数）；signal 中止的调用以中止原因 reject。`RemoteMock.create()` 登记一条流 `$events`，用 `{ type: 'ready', clientId, host: { home } }`（host 来自 `RemoteMockOptions.host`，默认 `/home/mock`）应答 Gateway 客户端的打开并保持打开——这正是整机能达到 `connected` 的原因；测试可以像任何流一样覆盖或让它失败。

### 观察与断言

`mock.log.calls(endpoint?)` 列出经 `dispatch` 或 `rpc.call` 的一元调用（`args`、`seq`、实时 `state` 为 `pending` / `answered` / `failed`，以及作为 `result` 的应答值或抛出的错误），`streams(endpoint?)` 列出脚本流的打开记录及其实时 `state` 与 `pushed` 计数，`requests(endpoint?)` 按顺序列出调用与打开的首个位置参数（不带端点时去掉 Gateway 自己带 `$` 前缀的端点），`unmatched()` 列出没找到规则的请求。原生 `.mock.calls` 还包含直接 Proxy 调用；载体的流 mock 会收到末尾的取消信号。`assertNoUnmatched()` 在收尾时报告漏配。`modeOf(endpoint)` 报告显式登记；`endpoints()` 还包含访问过的 Proxy 方法，使装配能够提供它们的命名空间。

### 可能出什么问题

- **请求没有规则**——`dispatch` reject、`open` 抛出 `remote-mock: no rule for <endpoint>; registered: …`，日志记下这次漏配；请登记该端点。
- **payload 不是 `{ args: unknown[] | object }`**——`rpc.call` reject、`rpc.open` 抛 `TypeError`；整机代理发数组形式、Gateway 自身端点发对象形式，所以问题出在手写调用。
- **同一条流上有第二个并发读取**——该读取 reject；Gateway 顺序读取流，因此这指向测试侧误用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计

`dispatch` 与 `open` 接收端点与位置参数；`rpc` 通过 Connection 的已解码载体接口暴露同一个核心。每个 mock 独立持有原生函数及排队覆盖；共享表提供默认响应，不复制 handler 或应答对象。每条脚本流拥有自己的队列、唯一挂起读取和日志条目；`end`、`fail`、消费方取消三者中最先发生者定局。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 公开面转出 |
| [`src/remote-mock.ts`](src/remote-mock.ts) | `RemoteMock`：默认响应、原生 mock、Connection 分发、受控流与缺失响应检查；`ok` |
| [`src/remote-proxy.ts`](src/remote-proxy.ts) | 命名空间／方法查找与生成映射的 mock 类型 |
| [`src/streams.ts`](src/streams.ts) | `frames` / `openStream` 脚本与 `MockStream`（句柄 + `AsyncIterable`） |
| [`src/log.ts`](src/log.ts) | 带共享 `seq` 计数器的日志 |
| — | 不发布运行时不变量伴生件；本测试支持库不拥有任何生产事件流或可变进程状态，其行为由本包测试覆盖。 |

</details>

-----

<a id="model-experience"></a>
## 模型体验

无；本包是浏览器侧测试基础设施，无一物到达模型请求。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅进程内载体**——`rpc` 服务同一 realm 中的 Connection 实例；不提供给浏览器车道测试用的 HTTP 或 WebSocket 载体。
- **值按引用传递**——应答与流项都未经序列化就到达客户端，真实线路会拒绝的非 JSON 值在这里原样通过。
- **不校验值**——一元应答必须是调用方读取的结果（`{ ok, value }` 或 `{ ok: false, error }`）；mock 原样传递它，不检查这些字段。
- **不做 payload 匹配**——规则只按端点匹配；在 handler 内按业务参数判别。
- **原生流覆盖自行管理 iterable**——覆盖返回自有 iterable 时，不参与脚本流日志、`requests`、`opened`、`drained` 以及 `push` / `end` / `fail`；调用方也负责取消。原生调用断言仍然有效。需要这些控制能力的场景应使用已登记的流脚本。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
