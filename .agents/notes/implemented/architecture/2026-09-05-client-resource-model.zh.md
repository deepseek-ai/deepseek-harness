# Agent Note: 客户端资源模型

Status: implemented

[English](2026-09-05-client-resource-model.md) | 中文

## Problem

右侧 Sidebar 的 tab 正文、聊天卡片或任何别的 slot 组件，常常需要只以地址可知的活数据：agent 刚写的文件，将来的聊天节点或终端。资源模型出现前每个消费方各自取数——文本预览自己持有 Remote 调用与刷新循环——于是每次挂载都重读、两个组件显示同一文件就持有两份、切 tab 卸载正文就丢内容，每种新内容都意味着一个新的专用 hook。

约束来自 tab 记录。tab 必须在打开它的代码不在场时挺过撤销、重做、正文重挂载与热替换，所以记录只能存可序列化的数据：一个地址与导航参数。浏览器页面刷新会重置只在内存中的 Sidebar 状态。因此开启方不能把数据交给正文，注入也不是合适的工具——注入是领域与席位之间注册期的关系，而打开是运行期事件。组件必须只凭地址找到数据，途径是由数据拥有者注册一次的东西。

## Decision

[`packages/client/resources`](../../../../packages/client/resources/README.zh.md)（`@deepseek-ai/dsh-client-resources`）提供 `ctx.resources` 与 `useResource` 全局标准 hook。消费方活读的任何东西都是**资源**，资源只由其**地址**标识，地址的协议命名唯一一个把它变成帧流的**提供方**。

### 地址

资源地址是 `dsh-resource://<type>/…` 形式的 URL。host 是协议键——`ResourceProtocolMap` 的键——路径归协议拥有者。`RESOURCE_SCHEME = 'dsh-resource'` 是唯一的 scheme 常量；`protocolOf(address)` 用 `new URL` 解析字串，要求 `protocol === 'dsh-resource:'`，返回小写 host；解析器拒绝的字串、其它 scheme 或空 host 返回 `undefined`。`dsh-resource` 不是 URL 规范里的特殊 scheme，解析器会保留 host 的大小写并把路径当作不透明串，所以小写化是显式做的，每段路径由定义它的协议做百分号编码。需要作用域的协议把作用域编进路径：`dsh-resource://file/session/<sessionId>/<path>`，`session/<sessionId>` 命名由其 Host 工作区解析相对或绝对路径的 Session（[语法](../../../../packages/util/workspace-path/README.zh.md)）。其它任何 scheme——`sidebar://guide`——是导航地址：它命名一个 tab 而非数据，模型对它回答 `none`（[tab 类型与导航](2026-09-05-sidebar-tab-types-and-navigation.zh.md)）。

### 服务

```ts ignore-check
interface Resources {
  register<P extends ResourceProtocol>(provider: ResourceProvider<P>): () => void
  pin(address: string, signal: AbortSignal): void
  source(address: string): ObservableSnapshot<ResourceSnapshot<unknown>>
}

interface ResourceProvider<P extends ResourceProtocol> {
  readonly protocol: P
  open(address: string, ctx: { readonly signal: AbortSignal }): AsyncIterable<RemoteResult<ResourceProtocolMap[P]>>
}

interface ResourceSnapshot<Value> {
  readonly status: 'none' | 'loading' | 'live' | 'failed'
  readonly value: Value | undefined
  readonly failure: RemoteFailure | undefined
}

type UseResource = <P extends ResourceProtocol>(address: string) => ResourceSnapshot<ResourceProtocolMap[P]>
```

`register` 让每个协议恰有一个提供方：同一协议的第二次注册抛错，注册是挂在注册方插件 fiber 上的 effect，所以协议随插件离开、之后可再注册。`pin` 在不订阅的情况下让资源保持打开直到信号中止；已中止的信号什么也不钉。`source` 是 hook 背后的裸 observable，按地址引用稳定，供 React 之外的调用方使用。值类型在 `ResourceProtocolMap` 里查得，它作为空接口声明在 `ui-slots` 里、与 `SlotMap` 并列——模块增强无法给目标模块添加它没有的导出，而每个消费方本来就依赖 `ui-slots`——各协议拥有者声明合并自己的成员（`file: WorkspaceFileStat`）；resources 包再导出这个类型。

### hook

`useResource` 声明在 `ui-slots` 的 `GlobalStandardProps` 上，因此每个 slot 组件不论作用域都有它，插件经 `ctx.slots.provideRoot({ keyedHooks: { resource: address => resources.source(address) } })` 提供，与 `useSessions` 走同一条根 keyed hook 路径。它不是会话标准 prop：资源的作用域随地址携带，会话作用域之外的组件也要读资源。`useResource<P>(address)` 返回快照：地址协议没有提供方或地址不是资源地址时为 `none`，流已打开、首帧未到时为 `loading`，`live` 携带最新 `ok` 值，`failed` 在最后一个值旁携带最新帧的失败。

### 帧

提供方产出 `RemoteResult` 帧：首帧是当前状态，之后每次变化一帧。`ok` 帧使资源 `live`、替换值、清除失败；`ok: false` 帧使其 `failed`、记下失败、保留最后一个值。失败是数据不是异常：Remote 面本来就把失败折进 `ok: false` 且从不 reject，提供方原样转发这些帧，模型既不捕获也不包装——提供方流里抛出是编程错误，任其冒出。自行结束的流保持最后状态；提供方在中止它的那次释放之后产出的帧被丢弃，迭代器被归还。流只推元数据不推载荷：`file` 的值是 `{ absolutePath, version, bytes? }`，消费方自己经 [Workspace Files 服务](2026-09-05-workspace-files-service.zh.md)读内容。

### 生命周期

每个地址一条记录。持有只控制观察的启停，不控制底层文件或 Session 的生灭。持有者是 hook 的订阅者加 pin；第一个持有者在 `AbortController` 下打开提供方的流，之后的持有者共享它并立刻读到最新值，最后一个释放时中止流并把快照重置为空闲——有提供方注册时为 `loading`，否则为 `none`。地址已被持有时到达的提供方会打开该地址的流；离开的提供方中止它，地址读作 `none`。记录在页面存续期内保留，使 `source(address)` 在 React 渲染到订阅的窗口与 StrictMode 重挂载之间保持引用稳定，否则重建记录会让每次渲染重订阅、重开流。

右侧 Sidebar 的 Tab 域在每条打开的 tab 记录存续期内钉住其地址，所以切 tab 卸载正文不关流、切回读到最新值；撤销恢复的记录是一次新的钉住，模型已放掉的资源会重新读取（[tab 类型与导航](2026-09-05-sidebar-tab-types-and-navigation.zh.md)）。`openResource(address)` 只收资源地址；引导页与文件树这类页面按 kind 打开，从不进入资源模型。

## Alternatives considered

**会话绑定的资源：`useResource` 挂会话标准件、身份为 `(session, address)`。** 第一版形态。被否，因为文件不是会话的事——会话只是路径的授权者——而且模型必须服务会话作用域之外的协议与组件。身份改为只有地址，作用域进入地址语法，hook 移到全局标准件。

**内容进资源流。** 被否：内容可能任意大，流是用来推变化的，不是推载荷。流只带元数据，消费方选择读取并保留多少内容。

**以抛错表达失败，并把非 `RemoteFailure` 的抛出包装成 `gateway/internal`。** 被否：Remote 面从不 reject，所以提供方抛出的任何东西都是 bug，包装它就是把 bug 藏起来不让肇事者看见的 fallback。失败是 `ok: false` 帧；抛出就冒出来。

**`file:/<scope>/<id>/<path>`，再到把作用域放在 authority 位的 `file://<scope>/<id>/<path>`。** 两版更早的语法。单斜杠形态不是平台解析器接受的 URL，每个消费方都得手工解析。把作用域移到 authority 位使它成为 URL，却让每个资源协议各占一个 scheme——`file://`、将来的 `chat://`、`terminal://`——scheme 的集合随协议集合增长，`file://` 地址不再是它在别处的含义，区分资源地址与导航地址需要一张清单。单一 scheme `dsh-resource://<type>/…` 让这个判断只需一次比较，host 留给协议命名，其它所有 scheme 留给导航。

**手写 scheme 前缀解析代替 URL 解析器。** 第一版 `protocolOf` 用正则匹配 scheme。地址成为 URL 后被否：解析器已经决定合法性与大小写，它拒绝的字串应读作「无协议」而不是被解析一半。

**每 tab 一个流 hook，或框架代管的 `useTabResource(fetch)`。** 依次被否：挂在 tab 域上的流 hook 问错了拥有者——`file` 数据必须来自工作区文件服务，聊天数据来自聊天域——而框架代管的 fetch 没有好的缓存键。留下的是 tab 上框架绑定的 `useTabInfo` 加一个按地址的客户端级 `useResource`。

## Consequences

任何 slot 组件只凭地址读活数据，于是开启方只传数据，正文在撤销、正文重挂载或热替换后能从记录重建自己。显示同一地址的两个组件共享一条流，被钉住的地址在正文卸载后仍存活。一个协议的传输只住在一个提供方里，新增协议只是一个声明合并的类型加一次注册。

代价记录在此以免被重新发现。记录不回收：内存随读过的不同地址数增长，而非随读取次数增长。中止合规归提供方；模型会丢弃已释放的流仍产出的帧，却阻止不了忽略信号的提供方跑到下一帧。失败类型是 Remote 面的 `RemoteFailure`，来源不是 Remote 调用的提供方得自己铸一个。导航地址或畸形字串读作 `none` 而非报错，这让混合地址列表渲染起来便宜，却让拼错的协议除了缺值之外没有任何诊断。

## Testing

`packages/client/resources/tests/resources.client.spec.ts` 用脚本化的 feed 驱动注册表：协议归属与注销、无提供方的协议与导航地址都为 `none`、提供方在地址已被持有后到达与在持有中离开、注册随 fiber 消失、首个持有者开流末个关流、一址一源、包括已中止信号在内的 pin、重挂读到最新值且不重开、重开为新流、中止后帧丢弃且迭代器归还、流自行结束、失败帧与最后值并存。`tests/apply.client.spec.ts` 在 `SlotTestRuntime` 里挂载插件，经一个根作用域探针组件验证 `useResource` 到达 props、渲染它即打开提供方的流、dispose 插件同时撤走服务与 hook。

## Deferred

回收空闲记录、与 Remote 面解耦的资源自有失败类型、`chat` 与 `terminal` 协议都还开放；各自等待一个消费方。面向开发者的参考是 [docs/subsystems/client-resources.md](../../../../docs/subsystems/client-resources.zh.md)；消费这个模型的 Sidebar 见 [docs/subsystems/sidebar-right.md](../../../../docs/subsystems/sidebar-right.zh.md)。
