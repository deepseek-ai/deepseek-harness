/** Session status across the real Controller catalog, ui-session pending interactions, and the status service. */
import { expect, onTestFinished, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { SESSION_FORMAT_VERSION, type SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionPendingInteractionBase } from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '../src/client/index.ts'

const it = createClientTest({ roster: webApp.closure(['@deepseek-ai/dsh-client-ui-session-status']) })
const parentId = 'status-parent' as SessionId
const childId = 'status-child' as SessionId

it('reports a failed completion as an error reminder until it is read', async ({ mock, start }) => {
  const record = (turn: number, readTurn: number, failed = false) => ({
    sessionId: parentId, completedTurn: turn, failed, readTurn, manualUnread: false,
  })
  mock.remote.session.list.mockResolvedValue(ok({ items: [{
    sessionId: parentId, updatedAt: 1, running: false, blank: false, agentAvailable: true,
  }] }))
  mock.stream('sessionStatus/follow', (_request, stream) => {
    stream.push({ type: 'baseline', items: [record(1, 0, true)] })
  })
  const client = await start()
  const sessions = client.ctx.sessions
  const status = () => client.ctx.uiSession.sessionStatus.getSnapshot().get(parentId)
  await sessions.refresh()
  await vi.waitFor(() => { expect(status()).toMatchObject({ completionUnread: true, completionFailed: true }) })

  mock.streams.push('sessionStatus/follow', { type: 'changed', state: record(2, 0) })
  await mock.streams.drained('sessionStatus/follow')
  await vi.waitFor(() => { expect(status()).toMatchObject({ completionUnread: true, completionFailed: false }) })

  mock.streams.push('sessionStatus/follow', { type: 'changed', state: record(2, 2, true) })
  await mock.streams.drained('sessionStatus/follow')
  await vi.waitFor(() => { expect(status()).toMatchObject({ completionUnread: false, completionFailed: false }) })

  mock.streams.push('sessionStatus/follow', { type: 'changed', state: record(3, 2, true) })
  await mock.streams.drained('sessionStatus/follow')
  await vi.waitFor(() => { expect(status()).toMatchObject({ completionUnread: true, completionFailed: true }) })

  mock.streams.push('sessionStatus/follow', { type: 'changed', state: record(3, 3, true) })
  await mock.streams.drained('sessionStatus/follow')
  await vi.waitFor(() => { expect(status()).toMatchObject({ completionUnread: false, completionFailed: false }) })
})

it('preserves unlisted child status through metadata updates and main view acknowledgement', async ({ mock, start }) => {
  mock.remote.session.list.mockResolvedValue(ok({ items: [{
    sessionId: parentId, updatedAt: 1, running: false, blank: false, agentAvailable: true,
  }] }))
  mock.remote.session.projections.mockResolvedValue(ok({
    kind: 'sequenced',
    asOfSeq: 0,
    values: { subagentCatalog: [{ id: childId, createdAt: 1, mode: 'continuable', label: 'Child' }] },
  }))
  mock.stream('session/follow', (_request, stream) => {
    stream.push({
      type: 'snapshot',
      header: { version: SESSION_FORMAT_VERSION, id: childId, createdAt: 1, isSeeded: false,
        parentSession: parentId, origin: 'subagent' },
      cursor: -1, records: [], hasMore: false,
      projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 },
    } satisfies SessionFollowFrame)
  })
  const client = await start()
  const sessions = client.ctx.sessions
  const status = client.ctx.uiSession.sessionStatus
  await sessions.refresh()
  await sessions.refreshProjections(parentId)
  await client.flush()
  expect(sessions.list.getSnapshot().ids).toEqual([parentId])
  expect(sessions.binding(childId)).toBeUndefined()
  expect(status.getSnapshot().get(childId)).toMatchObject({ running: undefined, completionUnread: false })

  mock.streams.push('$events', { type: 'emit', event: 'api-session/status', args: [childId, true] })
  await mock.streams.drained('$events')
  await client.flush()
  expect(status.getSnapshot().get(childId)).toMatchObject({ running: true, completionUnread: false })

  mock.streams.push('$events', { type: 'emit', event: 'api-session/activity', args: [parentId, 2] })
  await mock.streams.drained('$events')
  await client.flush()
  expect(sessions.list.getSnapshot().byId[parentId]?.updatedAt).toBe(2)
  expect(status.getSnapshot().get(childId)).toMatchObject({ running: true, completionUnread: false })

  mock.streams.push('$events', { type: 'emit', event: 'api-session/status', args: [childId, false] })
  await mock.streams.drained('$events')
  await client.flush()
  mock.streams.push('sessionStatus/follow', { type: 'changed', state: {
    sessionId: childId, completedTurn: 1, failed: false, readTurn: 0, manualUnread: false,
  } })
  await mock.streams.drained('sessionStatus/follow')
  await client.flush()
  expect(status.getSnapshot().get(childId)).toMatchObject({ running: false, completionUnread: true })

  using reference = sessions.retain(childId, { source: 'mainView' })
  await reference.ready
  expect(sessions.list.getSnapshot().ids).not.toContain(childId)
  mock.streams.push('sessionStatus/follow', { type: 'changed', state: {
    sessionId: childId, completedTurn: 1, failed: false, readTurn: 1, manualUnread: false,
  } })
  await mock.streams.drained('sessionStatus/follow')
  await vi.waitFor(() => {
    expect(status.getSnapshot().get(childId)).toMatchObject({ running: false, completionUnread: false })
  })
  reference.release()
  await client.flush()
  expect(status.getSnapshot().get(childId)?.completionUnread).toBe(false)
})

it('reports the effective ui-session pending interaction as the same request object', async ({ start }) => {
  const client = await start()
  const status = client.ctx.uiSession.sessionStatus
  const publish = client.ctx.uiSession.registerPendingInteraction<SessionPendingInteractionBase>(() => 0)
  const request = { key: 'approval:1', kind: 'approval', sessionId: parentId }
  const remove = publish(request, async () => {})
  expect(status.getSnapshot().get(parentId)?.pendingInteraction).toBe(request)
  remove()
  expect(status.getSnapshot().get(parentId)?.pendingInteraction).toBeUndefined()
})

it('applies ordered whole-record reading changes after the baseline', async ({ mock, start }) => {
  const record = (completedTurn: number, readTurn: number) => ({
    sessionId: parentId, completedTurn, failed: false, readTurn, manualUnread: false,
  })
  mock.stream('sessionStatus/follow', (_request, stream) => {
    stream.push({ type: 'baseline', items: [record(1, 0)] })
  })
  const client = await start()
  const status = client.ctx.uiSession.sessionStatus
  await vi.waitFor(() => { expect(status.getSnapshot().get(parentId)?.completionUnread).toBe(true) })
  expect(status.readingReady.getSnapshot()).toBe(true)
  mock.streams.push('sessionStatus/follow', { type: 'changed', state: record(2, 2) })
  await mock.streams.drained('sessionStatus/follow')
  await vi.waitFor(() => { expect(status.getSnapshot().get(parentId)?.completionUnread).toBe(false) })
})

it('retains reminders after a stream ends, replaces the reconnect baseline, and reports terminal failure', async ({ mock, start }) => {
  const report = vi.spyOn(console, 'error').mockImplementation(() => {})
  onTestFinished(() => { report.mockRestore() })
  let generation = 0
  mock.stream('sessionStatus/follow', (_request, stream) => {
    generation++
    stream.push({ type: 'baseline', items: [{
      sessionId: parentId, completedTurn: generation, failed: generation === 2, readTurn: 0,
      manualUnread: false,
    }] })
    if (generation === 1) stream.end()
    else stream.fail(new RemoteError('session-status/unavailable', 'Reading storage unavailable', {}))
  })
  const client = await start()
  const status = client.ctx.uiSession.sessionStatus
  await vi.waitFor(() => {
    expect(status.getSnapshot().get(parentId)).toMatchObject({ completionUnread: true, completionFailed: true })
    expect(status.readingReady.getSnapshot()).toBe(false)
  })
  expect(generation).toBe(2)
  await expect(status.mark(parentId, false)).rejects.toThrow('Reload the page')
  expect(report).toHaveBeenCalledWith(expect.stringContaining('Reminders could not be synchronized'), expect.any(Error))
})
