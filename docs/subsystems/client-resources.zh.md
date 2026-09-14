# 客户端资源

[English](client-resources.md) | 中文

客户端资源模型把一个地址变成任何 Web Client 组件都能读的活数据。[`dsh-client-resources`](../../packages/client/resources/README.zh.md) 提供 `ctx.resources` 服务与 `useResource` 全局标准 hook；拥有某类内容的包为它的**协议**注册一个**提供方**，组件按**地址**读取该内容的当前状态，而无需引用拥有者的运行时。右侧 Sidebar 的 tab 是这个模型的第一个消费方（[右侧 Sidebar](sidebar-right.zh.md)）；决策记录见 [客户端资源模型 Agent Note](../../.agents/notes/implemented/architecture/2026-09-05-client-resource-model.zh.md)。

本页是面向开发者的参考：地址怎么写、提供方怎么注册、资源怎么读、状态与失败各是什么意思、模型怎样持有与释放一份资源。

## 地址

资源地址是 `dsh-resource://<type>/…` 形式的 URL。host 命名协议，必须是 `ResourceProtocolMap` 的键；路径归协议自己，由其拥有者逐段做百分号编码。需要作用域的协议把作用域放进路径：`file` 协议的地址形如 `dsh-resource://file/session/<sessionId>/<path>`，其中 path 可以相对工作区根，也可以是保留前导斜杠的绝对路径，用 [`dsh-util-workspace-path`](../../packages/util/workspace-path/README.zh.md) 的 `fileAddressFor(sessionId, cwd, path)` 构造、`parseFileAddress(address)` 读回。模型本身只读 scheme 与 host：`protocolOf(address)` 对 `dsh-resource://` URL 返回小写 host，对其它任何字串返回 `undefined`。其它 scheme 下的地址——Sidebar 的 `sidebar://guide`——不指向资源，读作 `none`。

| 地址 | 协议键 | 读作 |
|---|---|---|
| `dsh-resource://file/session/s1/notes/a.md` | `file` | 会话 `s1` 工作区根下 `notes/a.md` 的元数据（`file` 提供方已注册时） |
| `dsh-resource://file/absolute/home/me/notes.md` | `file` | 可解析，但没有授权 Session，以 `workspace-file/unknown-workspace` 失败；不借用当前或 Tab Session |
| `DSH-RESOURCE://File/session/s1/a` | `file` | 另一份记录：地址按字符串比较，`openResource` 只接受 `fileAddressFor` 生成的规范小写拼写 |
| `sidebar://guide` | — | `none`：导航地址 |
| `/home/me/notes.md` | — | `none`：不是 URL |

## 注册提供方

协议拥有者在 `ResourceProtocolMap` 上声明其值类型，并在自己的 `ctx.effect` 里注册一个提供方，使协议与插件同寿（[提供协议](../../packages/client/resources/README.zh.md#provide-a-protocol)）。`open(address, { signal })` 返回一条 `RemoteResult` 帧流——首帧是当前状态，之后每次变化一帧——并且必须在 `signal` 中止时停下。失败是携带 `RemoteFailure` 的 `ok: false` 帧；流里抛出是编程错误，不会被捕获。

```ts ignore-check
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-resources/client'

interface NoteView { readonly title: string; readonly updatedAt: string }

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap { note: NoteView }
}

export const inject = ['resources', 'remote']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.resources.register<'note'>({
    protocol: 'note',
    async *open(address, { signal }): AsyncIterable<RemoteResult<NoteView>> {
      const id = new URL(address).pathname.slice(1)
      yield await ctx.remote.notes.read(id, signal)
      for await (const change of ctx.remote.notes.follow(id, signal)) yield change
    },
  }), 'my-notes: note resource provider')
}
```

一个协议恰有一个提供方；第二次注册抛错。注册时若该协议的地址已被持有，则立刻打开它们的流；提供方 dispose 时结束这些流，地址读作 `none` 直到提供方回来。

## 读取资源

每个 slot 组件不论作用域都在 props 上收到 `useResource`（[Slots](slots.zh.md)）。`useResource<P>(address)` 以类型参数命名协议，返回该地址的当前快照；订阅就是持有资源的方式，另一个持有者让资源存活时，新挂载的组件立刻读到最新值而不重开流（[读取资源](../../packages/client/resources/README.zh.md#read-a-resource)）。

| `status` | 含义 | `value` | `failure` |
|---|---|---|---|
| `none` | 地址的协议没有注册提供方，或地址不是资源地址 | `undefined` | `undefined` |
| `loading` | 提供方的流已打开、尚未产出 | `undefined` | `undefined` |
| `live` | 最新一帧成功 | 最新的 `ok` 值 | `undefined` |
| `failed` | 最新一帧报告了失败 | 保留的上一个 `ok` 值 | 该帧的 `RemoteFailure` |

```tsx ignore-check
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-api-workspace-files/client'

type Props = PropsRuntime<'sidebar.right.pane.tab'>

export function FileHeader({ useTabInfo, useResource, t }: Props) {
  const { tab } = useTabInfo()
  const meta = useResource<'file'>(tab.contentId)
  if (meta.status === 'failed') return <p role="alert">{t('failed', { code: meta.failure.code })}</p>
  return (
    <header>
      {tab.title}
    </header>
  )
}
```

`failed` 由消费方自己呈现：模型把最后一个值留在失败旁，正文可以带提示显示旧内容而不是一片空白，下一个 `ok` 帧会清除失败。模型本身不产生任何用户可见文案。

## 持有与释放

资源有持有者就存活：一个订阅中的 `useResource`，或一次钉住。`ctx.resources.pin(address, signal)` 在不订阅的情况下让资源保持打开直到 `signal` 中止，已中止的信号什么也不钉；右侧 Sidebar 在每条打开的 tab 记录存续期内钉住其地址，因此切 tab 卸载正文不关流。第一个持有者打开提供方的流；最后一个释放时中止它、丢弃值，并把快照回到 `loading`（有提供方）或 `none`（没有）。提供方在这次释放之后产出的帧被丢弃，迭代器被归还。`ctx.resources.source(address)` 是 hook 背后的裸 observable，按地址引用稳定，供 React 之外的调用方使用；只读它的快照不算持有（[生命周期](../../packages/client/resources/README.zh.md#lifecycle)）。

流只推元数据不推内容。`file` 提供方的值是 `WorkspaceFileStat { absolutePath, version, bytes? }`：首帧来自 Host 的 `stat`，后续观察更新版本。消费方自己经 Workspace Files Remote 命名空间读取内容；Preview 按 tab 独立刷新（[`dsh-api-workspace-files`](../../packages/api/workspace-files/README.zh.md)）。

## 限制

记录在页面存续期内保留：地址的记录在最后一个持有者离开后仍留着，不持有流也不持有值，因此内存随读过的不同地址数增长。忽略 `signal` 的提供方会一直跑到它的下一帧。失败类型是 Remote 面的 `RemoteFailure`，来源不是 Remote 调用的提供方得自己铸一个。拼错的协议或畸形的地址读作 `none`，没有别的诊断。
