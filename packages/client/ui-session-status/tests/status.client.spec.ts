import { Context } from '@deepseek-ai/cordis'
import type { ISessions, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionPendingInteraction } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'
import { UiSessionStatus } from '../src/client/status.ts'
import { apply as nodeApply } from '../src/index.ts'

const sessionId = (value: string): SessionId => value as SessionId
const pendingQuestion = (id: SessionId) => ({ key: 'question:1', kind: 'question', sessionId: id }) as SessionPendingInteraction
const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
})

function bench() {
  const ctx = new Context()
  roots.push(ctx)
  let statusListener: ((id: SessionId, running: boolean) => void) | undefined
  ctx.provide('remote', {
    $on: (_event: string, listener: (id: SessionId, running: boolean) => void) => {
      statusListener = listener
      return () => { if (statusListener === listener) statusListener = undefined }
    },
  } as never)
  const list = createSnapshotStore<SessionListState>({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} })
  const sessions: Pick<ISessions, 'list'> = { list }
  const pending = createSnapshotStore<ReadonlyMap<SessionId, SessionPendingInteraction>>(new Map())
  const status = () => new UiSessionStatus(ctx, sessions, pending)
  const row = (id: SessionId) => {
    list.update((draft) => {
      if (!draft.ids.includes(id)) draft.ids.push(id)
      draft.byId[id] = { id, displayTitle: id, running: false, retainedBy: {}, blank: false, updatedAt: 1 }
    })
  }
  const setMainView = (id: SessionId, count: number) => {
    list.update((draft) => {
      draft.byId[id] = { ...draft.byId[id]!, retainedBy: count === 0 ? {} : { mainView: count } }
    })
  }
  const emitStatus = (id: SessionId, running: boolean) => {
    if (statusListener === undefined) throw new Error('api-session/status is not subscribed')
    statusListener(id, running)
  }
  return { ctx, list, pending, status, row, setMainView, emitStatus, subscribed: () => statusListener !== undefined }
}

describe('Session running status and completion reminders', () => {
  it('keeps synthetic-row status unknown until an event or Host baseline establishes it', () => {
    const b = bench()
    const id = sessionId('catalog-only')
    b.list.update((draft) => {
      draft.byId[id] = { id, displayTitle: id, running: false, retainedBy: {}, blank: false, updatedAt: 0 }
    })
    const service = b.status()
    expect(service.getSnapshot().get(id)?.running).toBeUndefined()
    expect(service.getSnapshot().get(id)?.completionUnread).toBe(false)

    b.emitStatus(id, true)
    b.list.update((draft) => { draft.byId[id]!.displayTitle = 'Renamed child' })
    expect(service.getSnapshot().get(id)?.running).toBe(true)
    expect(service.getSnapshot().get(id)?.completionUnread).toBe(false)

    b.list.update((draft) => { draft.ids.push(id) })
    expect(service.getSnapshot().get(id)?.running).toBe(false)
    expect(service.getSnapshot().get(id)?.completionUnread).toBe(true)
  })

  it('records non-main completions and lets main-view activity acknowledge them', () => {
    const b = bench()
    const id = sessionId('s1')
    b.row(id)
    const service = b.status()
    const changed = vi.fn()
    const off = service.subscribe(changed)

    expect(service.getSnapshot().get(id)).toEqual({
      running: false,
      pendingInteraction: undefined,
      completionUnread: false,
    })
    b.list.update((draft) => { draft.byId[id]!.running = true })
    expect(service.getSnapshot().get(id)?.running).toBe(true)
    b.list.update((draft) => { draft.byId[id]!.running = false })
    expect(service.getSnapshot().get(id)?.completionUnread).toBe(true)
    b.setMainView(id, 1)
    expect(service.getSnapshot().get(id)?.completionUnread).toBe(false)
    b.setMainView(id, 0)

    b.emitStatus(id, true)
    b.emitStatus(id, false)
    expect(service.getSnapshot().get(id)?.completionUnread).toBe(true)

    b.setMainView(id, 1)
    expect(service.getSnapshot().get(id)?.completionUnread).toBe(false)
    b.emitStatus(id, true)
    b.emitStatus(id, false)
    expect(service.getSnapshot().get(id)?.completionUnread).toBe(false)

    b.setMainView(id, 0)
    b.emitStatus(id, false)
    expect(service.getSnapshot().get(id)?.completionUnread).toBe(false)
    b.emitStatus(id, true)
    b.emitStatus(id, false)
    expect(service.getSnapshot().get(id)?.completionUnread).toBe(true)
    b.emitStatus(id, true)
    expect(service.getSnapshot().get(id)?.completionUnread).toBe(false)
    expect(changed).toHaveBeenCalled()
    off()
  })

  it('records an idle event before the initial catalog baseline and retires absent status later', () => {
    const b = bench()
    const id = sessionId('early')
    b.list.update((draft) => { draft.phase = 'pending' })
    const service = b.status()

    b.emitStatus(id, false)
    expect(service.getSnapshot().get(id)).toEqual({
      running: false,
      pendingInteraction: undefined,
      completionUnread: true,
    })
    b.list.update((draft) => { draft.phase = 'ready' })
    expect(service.getSnapshot().has(id)).toBe(false)
  })

  it('keeps the snapshot reference until a status fact changes', () => {
    const b = bench()
    const id = sessionId('s1')
    b.row(id)
    const service = b.status()
    const changed = vi.fn()
    service.subscribe(changed)
    const before = service.getSnapshot()

    b.emitStatus(id, false)
    b.list.update((draft) => { draft.byId[id]!.displayTitle = 'Renamed' })
    expect(service.getSnapshot()).toBe(before)
    expect(changed).not.toHaveBeenCalled()
    b.emitStatus(id, true)
    expect(service.getSnapshot()).not.toBe(before)
    expect(changed).toHaveBeenCalledOnce()
  })
})

describe('Session status pending interactions', () => {
  it('carries the exact effective request object and adds Sessions known only by their request', () => {
    const b = bench()
    const listed = sessionId('listed')
    const unlisted = sessionId('unlisted')
    b.row(listed)
    const service = b.status()
    const changed = vi.fn()
    service.subscribe(changed)
    const approval = { key: 'approval:1', kind: 'approval', sessionId: listed } as SessionPendingInteraction
    const question = { key: 'question:1', kind: 'question', sessionId: unlisted } as SessionPendingInteraction

    b.pending.set(new Map([[listed, approval], [unlisted, question]]))
    expect(service.getSnapshot().get(listed)).toEqual({ running: false, pendingInteraction: approval, completionUnread: false })
    expect(service.getSnapshot().get(listed)?.pendingInteraction).toBe(approval)
    expect(service.getSnapshot().get(unlisted)).toEqual({
      running: undefined, pendingInteraction: question, completionUnread: false,
    })
    expect(changed).toHaveBeenCalledOnce()

    b.pending.set(new Map([[listed, approval], [unlisted, question]]))
    expect(changed).toHaveBeenCalledOnce()
    b.pending.set(new Map())
    expect(service.getSnapshot().get(listed)?.pendingInteraction).toBeUndefined()
    expect(service.getSnapshot().has(unlisted)).toBe(false)
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('contains a failing status subscriber and continues dispatch', () => {
    const b = bench()
    const service = b.status()
    const failure = new Error('status subscriber failed')
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    service.subscribe(() => { throw failure })
    const after = vi.fn()
    service.subscribe(after)

    b.pending.set(new Map([[sessionId('s1'), pendingQuestion(sessionId('s1'))]]))

    expect(after).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledWith('[session-status] Session status subscriber failed:', failure)
  })

  it('stops following its sources when its plugin unloads', async () => {
    const b = bench()
    let service: UiSessionStatus | undefined
    const fiber = b.ctx.plugin({
      apply(scope: Context) {
        service = new UiSessionStatus(scope, { list: b.list }, b.pending)
      },
    })
    await fiber.await()
    if (service === undefined) throw new Error('UiSessionStatus did not start')
    expect(b.subscribed()).toBe(true)
    const before = service.getSnapshot()

    await fiber.dispose()

    expect(b.subscribed()).toBe(false)
    b.row(sessionId('later'))
    b.pending.set(new Map([[sessionId('later'), pendingQuestion(sessionId('later'))]]))
    expect(service.getSnapshot()).toBe(before)
  })
})

describe('session-status apply', () => {
  it('provides the status service under ctx.uiSession and publishes it as the root useSessionStatus source', () => {
    const b = bench()
    const provideRoot = vi.fn()
    b.ctx.provide('sessions', { list: b.list } as never)
    b.ctx.provide('slots', { provideRoot } as never)
    b.ctx.provide('uiSession', { pendingInteractions: b.pending } as never)

    apply(b.ctx)

    expect(provideRoot).toHaveBeenCalledOnce()
    const root = provideRoot.mock.calls[0]![0] as { hooks: { sessionStatus: UiSessionStatus } }
    expect(Object.keys(root)).toEqual(['hooks'])
    expect(Object.keys(root.hooks)).toEqual(['sessionStatus'])
    expect(root.hooks.sessionStatus).toBeInstanceOf(UiSessionStatus)
    const provided: unknown = b.ctx.get('uiSession.sessionStatus')
    if (!(provided instanceof UiSessionStatus)) throw new Error('uiSession.sessionStatus is not provided')
    expect(provided.getSnapshot()).toBe(root.hooks.sessionStatus.getSnapshot())
  })

  it('keeps the Host loader half inert', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
