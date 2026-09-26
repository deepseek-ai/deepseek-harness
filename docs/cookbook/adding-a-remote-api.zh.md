# 实操手册：新增一个 Remote API

[English](adding-a-remote-api.md) | 中文

新增或改动一个 `ctx.remote` 端点按本页五步走：声明方法、声明失败、在包上注册、在 Client 消费、写测试。decorator 语义、lookup 解析、生成管线与 `/api` 路由属于机制，由 [API Gateway 参考](../api-gateway.zh.md)负责；本页给的是每一步的动作与必须遵守的约定。为什么是这套编程面，见 [Typert Remote 方法调用 Agent Note](../../.agents/notes/implemented/architecture/2026-08-02-typert-remote-method-calls.zh.md)；为什么失败面是单个 `RemoteError` 加一张码表，见[失败词汇 Agent Note](../../.agents/notes/implemented/architecture/2026-08-28-ctx-remote-failure-vocabulary.zh.md)。

## 1. 声明 API

owner 是一个 Host 侧 Cordis 服务：继承 `TypertRemoteService` 把 service 键与 wire namespace 一起绑定，再用 `@Remote` 标注对外暴露的方法。业务方法的签名若已符合 wire 约定就直接标注它本身；只有形态需要调整（补 `signal`、换参数顺序、换导出名）才写一个 `remoteExport*` adapter，由它调用不改名的业务方法。lookup 对象（`Agent`、`Session`）只能占顶层参数位，支持协作式取消的方法把 `signal: AbortSignal` 放在最后一位。

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

/** One stored note as a Client reads it. */
export interface NoteRow {
  readonly noteId: string
  readonly title: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    notesController: NotesController
  }
}

export class NotesController extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'notesController', { namespace: 'notes' })
  }

  /**
   * @param agent - lookup parameter the Gateway resolves from its wire identity.
   * @param signal - carrier cancellation, always the final parameter.
   * @returns the notes this Agent's session owns.
   */
  @Remote('list')
  async remoteExportList(agent: Agent, signal: AbortSignal): Promise<NoteRow[]> {
    return await this.list(agent, signal)
  }

  /** The in-process API the adapter above delegates to, unchanged by it. */
  async list(agent: Agent, signal: AbortSignal): Promise<NoteRow[]> {
    signal.throwIfAborted()
    return await Promise.resolve([{ noteId: `${agent.id}-1`, title: 'draft' }])
  }
}
```

## 2. 声明失败

Remote 失败只有一个类 `RemoteError`：域码经 declaration merging 进 `RemoteErrorDetailsMap`，失败点直接 `throw new RemoteError(code, message, details)`。不要建域异常类家族，也不要写出口映射函数；与本端点无关的异常不预先归类，Gateway 会兜底折成 `gateway/internal`。只有"把任意 provider 异常归为一个域码"这一种场景才写 `catch`，并把原始异常挂在 `cause` 上。

码名是 `<域>/<理由>`，声明落点四条：

- 只有一个生产者：声明落生产者包，紧挨抛出点。
- 多个包共同生产：落双方共同依赖的最低层域包（`session/not-found` 在 `core/session`，`workspace/not-found` 在 `dsh-workspace`）。
- 载体码 `gateway/bad-request`、`gateway/cancelled`、`gateway/internal` 已在 protocol 声明，Gateway 基础设施码已在 gateway 声明——直接用，不要复制。
- 不上 wire 的本地失败不进码表，用调用方自己的类型表达。

```ts
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** No stored note carries that id. */
    'note/not-found': { readonly noteId: string }
    /** The store refused an otherwise valid write. */
    'note/rejected': { readonly noteId: string }
  }
}

declare const stored: ReadonlyMap<string, string>
declare function persist(noteId: string, title: string): Promise<void>

export async function rename(noteId: string, title: string): Promise<void> {
  if (!stored.has(noteId)) {
    throw new RemoteError('note/not-found', `no note "${noteId}"`, { noteId })
  }
  try {
    await persist(noteId, title)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw new RemoteError('note/rejected', message, { noteId }, { cause: error })
  }
}
```

## 3. 在包上注册

`@Remote` 必须落在一个 Loader entry 插件包里；owner 是抽象 seam 时把控制器放进 `packages/api/` 下的对应包。包清单要补两个生成入口与 protocol 的 peer 依赖，Client 侧则由 `@deepseek-ai/dsh-api-remotes` 的 assembly 挂载该贡献并按需转口类型词汇。两个入口分别指向哪个生成产物、生成管线如何排序，见 [API Gateway 参考](../api-gateway.zh.md)。

```json
{
  "exports": {
    "./typert": { "types": "./lib/typert.host.d.ts", "default": "./lib/typert.host.js" },
    "./remote": { "types": "./lib/typert.remote-client.d.ts", "default": "./lib/typert.remote-client.js" }
  },
  "peerDependencies": { "@deepseek-ai/dsh-typert-protocol": "workspace:*" },
  "devDependencies": { "@deepseek-ai/dsh-typert-protocol": "workspace:*" }
}
```

改动了签名、码表、namespace 或导出名之后重跑 `pnpm run build:lib`，Client 才拿得到新的声明与 codec；只改实现体不需要重新生成。

## 4. 在 Client 消费

调用插件在 `inject` 里同时声明 `remote` 与 `remote.<namespace>`，调用点直写 `ctx.remote.<namespace>.<method>(...)`：不要用 `Pick<ClientRemote, …>` 窄化、不要手写方法签名、不要造 wire 中转对象。结果是 `RemoteResult<T>`，就地 `if (!result.ok)` 分支，判 `code` 而不是 `instanceof`——code 分支会自动窄化 `details`。异常流的站点写 `throw result.error`（它是真 Error）；接住它的上层用 `isRemoteFailure` 区分 Remote 失败与本地缺陷，本地缺陷继续往上抛。不要写防御性 catch：Remote 调用不 reject，装配错误就该炸。

Host 的固定事实读 `ctx.remote.$host`：`home` 与 `isLoopback` 是普通值读取，没有订阅也没有 generation 计数器，`home` 在第一帧 ready 之前是 `undefined`；重连后的刷新走 `ctx.on('connection/reset')` 或各域自己的 remote 事件。调用方 abort 掉一次一元调用时，结果落在错误分支上的 `gateway/cancelled`，而不是抛出。

```ts ignore-check
import type { Context } from '@deepseek-ai/cordis'
import { isRemoteFailure } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'

export const inject = ['remote', 'remote.notes']

declare const ctx: Context

/** Store-side read: the error branch is handled where the code is meaningful. */
export async function noteTitles(): Promise<readonly string[]> {
  const result = await ctx.remote.notes.list()
  if (!result.ok) {
    if (result.error.code === 'note/not-found') return []
    throw result.error
  }
  return result.value.map(row => row.title)
}

/** Action-side: a Remote failure becomes copy; a local fault keeps crashing. */
export async function renderTitles(): Promise<string> {
  try {
    return (await noteTitles()).join(', ')
  } catch (error: unknown) {
    if (!isRemoteFailure(error)) throw error
    return `unavailable (${error.code})`
  }
}

/** Fixed Host facts as plain reads. */
export function hostLabel(): string {
  const { home, isLoopback } = ctx.remote.$host
  return home ?? (isLoopback ? 'local host' : 'remote host')
}
```

## 5. 测试

owner 侧断言抛出的码：捕获后用 `remoteErrorOf` 取出失败，再用 `toMatchObject` 比对 `code` 与需要的 `details` 字段——不要用 `toEqual` 深比对错误对象，也不要断言 `instanceof`。

```ts
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it } from 'vitest'

declare function rename(noteId: string, title: string): Promise<void>

it('refuses an unknown note before writing', async () => {
  const failure = await rename('n-404', 'fresh title').catch((error: unknown) => error)

  expect(remoteErrorOf(failure)).toMatchObject({
    code: 'note/not-found',
    details: { noteId: 'n-404' },
  })
})
```

Client 侧的替身返回真实例：`RemoteError` 与 `TestRemote` 的值 import 一律取自 `@deepseek-ai/dsh-client-test-runtime`，因为从 `api-remotes` facade 值 import 会拉起尚未构建的装配链。`TestRemote.$host` 是普通字段，spec 直接赋值即可。

```ts ignore-check
import { Context } from '@deepseek-ai/cordis'
import { RemoteError, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { expect, it } from 'vitest'

it('renders the failure code the Host reported', async () => {
  const ctx = new Context()
  const remote = new TestRemote(ctx, {
    notes: {
      list: () => Promise.resolve({
        ok: false as const,
        error: new RemoteError('note/not-found', 'no note "n-404"', { noteId: 'n-404' }),
      }),
    },
  })
  remote.$host = { home: '/home/fixture', isLoopback: true }

  await expect(ctx.remote.notes.list()).resolves.toMatchObject({ error: { code: 'note/not-found' } })
})
```

## 验证

1. `pnpm run build:lib`：签名、码表、namespace 或导出名变过就必须重跑，Client 声明与 codec 由它产出。
2. `pnpm run typecheck`：Host 与 Client 两个 program 都过一遍，码表的 merge 落点错了会在这里红。
3. 点名跑两侧 spec：`npx vitest run <owner spec> <client spec>`。
4. 端点属于产品可见面时补一条录制会话快照，规则见[测试策略](../testing.zh.md)。
