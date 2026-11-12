// @vitest-environment jsdom
/** Natural reminders of the Session the visible, focused main view retains. */
import { Context } from '@deepseek-ai/cordis'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionPendingInteraction } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionReadSnapshot } from '../src/client/model.ts'
import { UiSessionStatus } from '../src/client/status.ts'
import type { SessionReadState } from '../src/types.ts'

const viewed = 'viewed' as SessionId
const other = 'other' as SessionId
const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
})

function bench() {
  const ctx = new Context()
  roots.push(ctx)
  ctx.provide('remote', { $on: () => () => {} } as never)
  const row = (id: SessionId, mainView: boolean) => ({
    id, displayTitle: id, running: false, retainedBy: mainView ? { mainView: 1 } : {}, blank: false, updatedAt: 1,
  })
  const list = createSnapshotStore<SessionListState>({
    ids: [viewed, other], phase: 'ready', projectionsBySession: {},
    byId: { [viewed]: row(viewed, true), [other]: row(other, false) },
  })
  const record = (id: SessionId, value: Partial<SessionReadState>): SessionReadState => ({
    sessionId: id, completedTurn: 1, failed: true, readTurn: 0, manualUnread: false, ...value,
  })
  const opened = (id: SessionId) => ({
    sessionId: id, session: createSnapshotStore<{ readonly openState: string; readonly running?: boolean }>({ openState: 'open' }),
  })
  const bindings = new Map([viewed, other].map(id => [id, opened(id)]))
  const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const service = new UiSessionStatus(ctx, { list, binding: (id: SessionId) => bindings.get(id) as never },
    createSnapshotStore<ReadonlyMap<SessionId, SessionPendingInteraction>>(new Map()))
  const reading: { set(value: SessionReadSnapshot): void } = service.reading.state
  reading.set({ ready: true, items: { [viewed]: record(viewed, {}), [other]: record(other, {}) } })
  const status = (id: SessionId) => service.getSnapshot().get(id)
  const view = (id: SessionId) => {
    list.update((draft) => {
      for (const key of [viewed, other]) draft.byId[key] = row(key, key === id)
    })
  }
  const openState = (id: SessionId, state: string) => { bindings.get(id)!.session.set({ openState: state }) }
  const snapshot = (id: SessionId, value: { readonly openState: string; readonly running?: boolean }) => {
    bindings.get(id)!.session.set(value)
  }
  return { ctx, reading, record, focus, visibility, status, view, openState, service, snapshot }
}

it('hides the natural reminder of the viewed Session until the window loses focus or visibility', () => {
  const b = bench()
  expect(b.status(viewed)).toMatchObject({ completionUnread: false, completionFailed: false })
  expect(b.status(other)).toMatchObject({ completionUnread: true, completionFailed: true })

  b.focus.mockReturnValue(false)
  window.dispatchEvent(new Event('blur'))
  expect(b.status(viewed)).toMatchObject({ completionUnread: true, completionFailed: true })
  b.focus.mockReturnValue(true)
  window.dispatchEvent(new Event('focus'))
  expect(b.status(viewed)?.completionUnread).toBe(false)

  b.visibility.mockReturnValue('hidden')
  document.dispatchEvent(new Event('visibilitychange'))
  expect(b.status(viewed)?.completionUnread).toBe(true)
})

it('keeps a manual reminder of the viewed Session visible', () => {
  const b = bench()
  b.reading.set({ ready: true, items: { [viewed]: b.record(viewed, { readTurn: 1, manualUnread: true }) } })
  expect(b.status(viewed)).toMatchObject({ completionUnread: true, completionFailed: true })
})

it('shows an unacknowledged completion again after the main view switches to another Session', () => {
  const b = bench()
  b.view(other)
  expect(b.status(viewed)).toMatchObject({ completionUnread: true, completionFailed: true })
  expect(b.status(other)).toMatchObject({ completionUnread: false, completionFailed: false })
})

it('shows the natural reminder of the viewed Session until that Session is open', () => {
  const b = bench()
  b.openState(viewed, 'loading')
  expect(b.status(viewed)).toMatchObject({ completionUnread: true, completionFailed: true })
  b.openState(viewed, 'error')
  expect(b.status(viewed)?.completionUnread).toBe(true)
  b.openState(viewed, 'open')
  expect(b.status(viewed)).toMatchObject({ completionUnread: false, completionFailed: false })
})

it('does not rebuild the table when the viewed Session snapshot changes without an open-state change', () => {
  const b = bench()
  const before = b.service.getSnapshot()
  const changed = vi.fn()
  b.service.subscribe(changed)
  const rebuild = vi.spyOn(b.service.reading.state, 'getSnapshot')
  b.snapshot(viewed, { openState: 'open', running: true })
  expect(rebuild).not.toHaveBeenCalled()
  expect(b.service.getSnapshot()).toBe(before)
  expect(changed).not.toHaveBeenCalled()
})
