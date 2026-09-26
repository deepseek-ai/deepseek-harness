# Cookbook: adding a Remote API

English | [中文](adding-a-remote-api.zh.md)

Adding or changing a `ctx.remote` endpoint takes the five steps on this page: declare the method, declare its failures, register it on the package, consume it on the Client, and test it. Decorator semantics, lookup resolution, the generation pipeline, and the `/api` route are the mechanism and belong to the [API Gateway reference](../api-gateway.md); this page gives the action for each step and the conventions it must satisfy. Why the programming interface looks like this is in the [Typert Remote method calls Agent Note](../../.agents/notes/implemented/architecture/2026-08-02-typert-remote-method-calls.md), and why a failure is one `RemoteError` plus a code table is in the [failure vocabulary Agent Note](../../.agents/notes/implemented/architecture/2026-08-28-ctx-remote-failure-vocabulary.md).

## 1. Declare the API

The owner is a Host-side Cordis service: extend `TypertRemoteService` so the service key and the wire namespace are bound together, then mark the exposed methods with `@Remote`. Mark the business method itself when its signature already satisfies the wire conventions; write a `remoteExport*` adapter only when the shape has to change (adding `signal`, reordering parameters, exporting another name), and let that adapter call the unrenamed business method. Lookup objects (`Agent`, `Session`) may only occupy top-level parameter positions, and a method that supports cooperative cancellation takes `signal: AbortSignal` as its final parameter.

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

## 2. Declare the failures

A Remote failure is one class, `RemoteError`: merge the domain codes into `RemoteErrorDetailsMap` through declaration merging and `throw new RemoteError(code, message, details)` at the failure point. Do not build a family of domain error classes, and do not write an exit-mapping function; an exception unrelated to this endpoint is not pre-classified, because the Gateway folds it into `gateway/internal`. Write a `catch` only to classify an arbitrary provider exception as one domain code, and attach the original exception as `cause`.

A code reads `<domain>/<reason>`, and its declaration has four placement rules:

- One producer only: declare it in the producing package, next to the throw.
- Several packages produce it: declare it in the lowest domain package both depend on (`session/not-found` in `core/session`, `workspace/not-found` in `dsh-workspace`).
- The carrier codes `gateway/bad-request`, `gateway/cancelled`, and `gateway/internal` are declared in protocol, and the Gateway infrastructure codes in gateway — use them, never copy them.
- A local failure that never crosses the wire stays out of the code table; express it with the caller's own type.

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

## 3. Register it on the package

`@Remote` must live in a Loader entry plugin package; when the owner is an abstract seam, the controller goes in the matching package under `packages/api/`. The manifest gains the two generated entries and the protocol peer dependency, while on the Client side the `@deepseek-ai/dsh-api-remotes` assembly mounts the contribution and re-exports the type vocabulary that consumers need. Which generated artifact each entry points at, and how the generation pipeline is ordered, are in the [API Gateway reference](../api-gateway.md).

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

Rerun `pnpm run build:lib` after changing a signature, the code table, the namespace, or an export name, because that is what hands the Client its new declarations and codecs; changing only an implementation body needs no regeneration.

## 4. Consume it on the Client

The calling plugin declares both `remote` and `remote.<namespace>` in its `inject`, and the call site writes `ctx.remote.<namespace>.<method>(...)` directly: no `Pick<ClientRemote, …>` narrowing, no hand-written method signature, no wire relay object. The result is a `RemoteResult<T>`, so branch on `if (!result.ok)` in place and discriminate by `code` rather than `instanceof` — a code branch narrows `details` on its own. An exception-flow site writes `throw result.error` (it is a real Error); whoever catches it uses `isRemoteFailure` to tell a Remote failure from a local defect and rethrows the defect. Do not write a defensive catch: a Remote call does not reject, and an assembly mistake should crash.

Fixed Host facts come from `ctx.remote.$host`: `home` and `isLoopback` are plain reads with no subscription and no generation counter, and `home` is `undefined` until the first ready frame. Refresh after a reconnect through `ctx.on('connection/reset')` or a domain's own remote event. When the caller aborts a unary call, the outcome is `gateway/cancelled` on the error branch rather than a throw.

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

## 5. Test it

On the owner side, assert the code that was thrown: recover the failure with `remoteErrorOf` after catching, then compare `code` and the details fields you care about with `toMatchObject` — never deep-compare the error object with `toEqual`, and never assert `instanceof`.

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

A Client-side double returns real instances: take the `RemoteError` and `TestRemote` value imports from `@deepseek-ai/dsh-client-test-runtime`, because a value import from the `api-remotes` facade would load the unbuilt assembly chain. `TestRemote.$host` is a plain field a spec assigns directly.

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

## Verify

1. `pnpm run build:lib`: mandatory once a signature, the code table, the namespace, or an export name changed, because it produces the Client declarations and codecs.
2. `pnpm run typecheck`: both the Host and the Client program, where a code merged into an unreachable package turns red.
3. Run both sides' specs by name: `npx vitest run <owner spec> <client spec>`.
4. Add a recorded-session snapshot when the endpoint reaches a product-visible surface, per the [testing policy](../testing.md).
