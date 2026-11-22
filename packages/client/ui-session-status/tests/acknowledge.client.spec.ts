// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AgentContext, SessionBinding, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { FixtureSession, type SessionFixtureSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { afterEach, expect, it, vi } from 'vitest'
import { installReadingAcknowledgements } from '../src/client/acknowledge.ts'
import type { SessionReadSnapshot } from '../src/client/model.ts'
import type { SessionReadState } from '../src/types.ts'

const roots: Context[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

interface HarnessOptions {
  /** Manual reminder of the initial record. */
  readonly manual?: boolean
  /** Completed turn of the initial record, also delivered to the body. */
  readonly completedTurn?: number
  /** Whether the main view retains the Session at install time. */
  readonly selected?: boolean
  /** Whether the reading baseline is ready at install time. */
  readonly ready?: boolean
}

function harness({ manual = false, completedTurn = 1, selected = true, ready = true }: HarnessOptions = {}) {
  const ctx = new Context()
  roots.push(ctx)
  const id = SessionId('viewed')
  const state = createSnapshotStore<SessionReadSnapshot>({ ready, items: { [id]: {
    sessionId: id, completedTurn, failed: false, readTurn: 0, manualUnread: manual,
  } } }, { flush: 'sync' })
  const lifecycle = createSnapshotStore<SessionFixtureSnapshot>({
    sessionId: id, pendingSubmissions: [], running: false, subagent: null, removed: false,
    openState: 'open', openError: null, hasMore: false, loadingOlder: false, promptError: null,
    historyLoadStatus: 'idle', historyWasPartial: false,
    blank: false, lastAgentError: null, promptAttempted: false, awaitingFirstTurn: false,
  }, { flush: 'sync' })
  const session = new FixtureSession(id, lifecycle, {})
  const body = (turn: number) => { session.eventSource.append({ type: 'event', event: {
    type: 'turn/end', seq: SessionSeq(turn), time: 0, data: { turn, reason: { kind: 'completed' } },
  } }) }
  if (completedTurn > 0) body(completedTurn)
  const row = (mainView: boolean) => ({
    id, displayTitle: 'Viewed', retainedBy: mainView ? { mainView: 1 } : {}, running: false, blank: false, updatedAt: 1,
  })
  const list = createSnapshotStore<SessionListState>({
    ids: [id], phase: 'ready', projectionsBySession: {}, byId: { [id]: row(selected) },
  }, { flush: 'sync' })
  const bind = (): SessionBinding => ({ sessionId: id, session, eventSource: session.eventSource, ctx: ctx as AgentContext })
  let binding = bind()
  const mark = vi.fn(async (_id: typeof id, _throughTurn: number, _clearManual: boolean) => {})
  let frame: FrameRequestCallback | undefined
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => { frame = undefined })
  const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  installReadingAcknowledgements(ctx, { list, binding: () => binding }, { state, acknowledge: mark })
  const paint = async () => {
    const callback = frame
    frame = undefined
    callback?.(0)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }
  /** Replace the record with the given fields over the current one. */
  const record = (patch: Partial<SessionReadState>) => {
    const current = state.getSnapshot()
    state.set({ ready: true, items: { [id]: { ...current.items[id]!, ...patch } } })
  }
  /** Move the main view to or away from the Session. */
  const select = (on: boolean) => { list.update((draft) => { draft.byId[id] = row(on) }) }
  /** Replace the binding of the still-selected Session. */
  const rebind = () => {
    binding = bind()
    list.set({ ...list.getSnapshot() })
  }
  return { ctx, id, state, body, lifecycle, list, mark, paint, focus, visible, session, record, select, rebind }
}

it('waits for a focused visible main view and an open Session before acknowledging', async () => {
  const b = harness()
  b.visible.mockReturnValue('hidden')
  await b.paint()
  expect(b.mark).not.toHaveBeenCalled()
  b.visible.mockReturnValue('visible')
  b.lifecycle.update((draft) => { draft.openState = 'loading' })
  document.dispatchEvent(new Event('visibilitychange'))
  await b.paint()
  expect(b.mark).not.toHaveBeenCalled()
  b.lifecycle.update((draft) => { draft.openState = 'open' })
  await b.paint()
  expect(b.mark).toHaveBeenCalledExactlyOnceWith(b.id, 1, false)
})

it('clears a manual reminder after the main view switches to its Session and the body arrives', async () => {
  const b = harness({ manual: true, selected: false })
  b.lifecycle.update((draft) => { draft.openState = 'loading' })
  b.select(true)
  await b.paint()
  expect(b.mark).not.toHaveBeenCalled()
  b.lifecycle.update((draft) => { draft.openState = 'open' })
  await b.paint()
  expect(b.mark).toHaveBeenCalledExactlyOnceWith(b.id, 1, true)
})

it('preserves a manual mark made in the open Session until the main view leaves and returns', async () => {
  const b = harness()
  await b.paint()
  expect(b.mark).toHaveBeenCalledExactlyOnceWith(b.id, 1, false)
  b.record({ readTurn: 1, manualUnread: true })
  await b.paint()
  expect(b.mark).toHaveBeenCalledTimes(1)
  b.select(false)
  b.select(true)
  await b.paint()
  expect(b.mark).toHaveBeenLastCalledWith(b.id, 1, true)
})

it('preserves a manual reminder when the window regains focus or visibility', async () => {
  const b = harness()
  await b.paint()
  b.record({ readTurn: 1, manualUnread: true })
  b.focus.mockReturnValue(false)
  window.dispatchEvent(new Event('blur'))
  b.focus.mockReturnValue(true)
  window.dispatchEvent(new Event('focus'))
  document.dispatchEvent(new Event('visibilitychange'))
  await b.paint()
  expect(b.mark).toHaveBeenCalledExactlyOnceWith(b.id, 1, false)
})

it('treats the initial selection as an entry and clears its manual reminder once a late baseline arrives', async () => {
  const b = harness({ manual: true, ready: false })
  await b.paint()
  expect(b.mark).not.toHaveBeenCalled()
  b.record({ manualUnread: true })
  await b.paint()
  expect(b.mark).toHaveBeenCalledExactlyOnceWith(b.id, 1, true)
})

it('does not treat a replaced binding for the same Session as an entry', async () => {
  const b = harness()
  await b.paint()
  b.record({ readTurn: 1, manualUnread: true })
  b.rebind()
  await b.paint()
  expect(b.mark).toHaveBeenCalledExactlyOnceWith(b.id, 1, false)
})

it('acknowledges an earlier manual mark before any turn has completed', async () => {
  const b = harness({ manual: true, completedTurn: 0 })
  await b.paint()
  expect(b.mark).toHaveBeenCalledExactlyOnceWith(b.id, 0, true)
})

it('does not read a new completion before its content arrives, or after disposal', async () => {
  const b = harness()
  b.record({ completedTurn: 2, readTurn: 1 })
  await b.paint()
  expect(b.mark).not.toHaveBeenCalled()
  await b.ctx.fiber.dispose()
  await b.paint()
  expect(b.mark).not.toHaveBeenCalled()
})

it('acknowledges later body progress without clearing manual unread again', async () => {
  const b = harness({ manual: true, completedTurn: 0 })
  await b.paint()
  expect(b.mark).toHaveBeenCalledTimes(1)
  b.body(1)
  b.record({ completedTurn: 1, manualUnread: true })
  await b.paint()
  expect(b.mark.mock.calls).toEqual([[b.id, 0, true], [b.id, 1, false]])
})

it('retains unread after acknowledgement failure and retries on a new view entry', async () => {
  const b = harness()
  const report = vi.spyOn(console, 'error').mockImplementation(() => {})
  b.mark.mockRejectedValueOnce(new Error('offline'))
  await b.paint()
  await b.paint()
  expect(b.mark).toHaveBeenCalledTimes(1)
  expect(report).toHaveBeenCalled()
  b.focus.mockReturnValue(false)
  window.dispatchEvent(new Event('focus'))
  await b.paint()
  expect(b.mark).toHaveBeenCalledTimes(1)
  b.focus.mockReturnValue(true)
  window.dispatchEvent(new Event('focus'))
  await b.paint()
  expect(b.mark).toHaveBeenCalledTimes(2)
})

it('does not acknowledge an unselected or unknown record and tolerates unrelated list updates', async () => {
  const b = harness()
  const selected = b.list.getSnapshot()
  b.list.set({ ...selected, byId: {} })
  window.dispatchEvent(new Event('focus'))
  await b.paint()
  expect(b.mark).not.toHaveBeenCalled()
  b.state.set({ ready: true, items: {} })
  b.list.set(selected)
  await b.paint()
  b.list.set({ ...selected })
  await b.paint()
  expect(b.mark).not.toHaveBeenCalled()
  await b.ctx.fiber.dispose()
})

it('waits for the body to reach the completed turn before acknowledging', async () => {
  const b = harness()
  b.record({ completedTurn: 2, readTurn: 1 })
  await b.paint()
  expect(b.mark).not.toHaveBeenCalled()
  b.body(2)
  await b.paint()
  expect(b.mark).toHaveBeenCalledExactlyOnceWith(b.id, 2, false)
})

it('preserves a manual mark received while the entered Session is loading', async () => {
  const b = harness()
  b.lifecycle.update((draft) => { draft.openState = 'loading' })
  b.record({ manualUnread: true })
  await b.paint()
  b.lifecycle.update((draft) => { draft.openState = 'open' })
  await b.paint()
  expect(b.mark).toHaveBeenCalledExactlyOnceWith(b.id, 1, false)
  window.dispatchEvent(new Event('focus'))
  await b.paint()
  expect(b.mark).not.toHaveBeenCalledWith(b.id, 1, true)
})

it('keeps a pending entry across window blur and clears after the body loads', async () => {
  const b = harness({ manual: true })
  b.lifecycle.update((draft) => { draft.openState = 'loading' })
  await b.paint()
  b.focus.mockReturnValue(false)
  window.dispatchEvent(new Event('blur'))
  b.lifecycle.update((draft) => { draft.openState = 'open' })
  b.focus.mockReturnValue(true)
  window.dispatchEvent(new Event('focus'))
  await b.paint()
  expect(b.mark).toHaveBeenCalledExactlyOnceWith(b.id, 1, true)
})

it('retains an entry while a natural acknowledgement is pending', async () => {
  const b = harness()
  let resolve!: () => void
  b.mark.mockImplementationOnce(() => new Promise<void>((settle) => { resolve = settle }))
  await b.paint()
  expect(b.mark).toHaveBeenCalledExactlyOnceWith(b.id, 1, false)
  b.record({ manualUnread: true })
  b.select(false)
  b.select(true)
  await b.paint()
  expect(b.mark).toHaveBeenCalledTimes(1)
  resolve()
  await b.paint()
  await b.paint()
  expect(b.mark).toHaveBeenLastCalledWith(b.id, 1, true)
})

it('drops an entry after another client clears the manual reminder', async () => {
  const b = harness({ manual: true })
  b.lifecycle.update((draft) => { draft.openState = 'loading' })
  b.record({ manualUnread: false })
  b.record({ manualUnread: true })
  b.lifecycle.update((draft) => { draft.openState = 'open' })
  await b.paint()
  expect(b.mark).toHaveBeenCalledExactlyOnceWith(b.id, 1, false)
})

it('acknowledges a completed turn only after the body advances to the next turn', async () => {
  const b = harness()
  b.record({ completedTurn: 2, readTurn: 1 })
  const start = (turn: number) => { b.session.eventSource.replace([{ type: 'event', event: {
    type: 'turn/start', seq: SessionSeq(turn), time: 0, data: { turn },
  } }], true) }
  start(2)
  await b.paint()
  expect(b.mark).not.toHaveBeenCalled()
  start(3)
  await b.paint()
  expect(b.mark).toHaveBeenCalledExactlyOnceWith(b.id, 2, false)
})
