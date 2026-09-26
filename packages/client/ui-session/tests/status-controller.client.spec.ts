/** Running-state ownership across the real Controller catalog and UI status source. */
import { expect, vi } from 'vitest'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { SESSION_FORMAT_VERSION, type SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types'

const it = createClientTest({ roster: webApp.closure(['@deepseek-ai/dsh-client-ui-session']) })
const parentId = 'status-parent' as SessionId
const childId = 'status-child' as SessionId

it('preserves unlisted child status through metadata updates and main view acknowledgement', async ({ mock, start }) => {
  mock.remote.session.list.mockResolvedValue(ok({ items: [{
    sessionId: parentId, updatedAt: 1, running: false, blank: false, agentAvailable: true,
  }] }))
  mock.remote.session.projections.mockResolvedValue(ok({
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
  const ui = client.ctx.uiSession
  await sessions.refresh()
  await sessions.refreshProjections(parentId)
  await client.flush()
  expect(sessions.list.getSnapshot().ids).toEqual([parentId])
  expect(sessions.binding(childId)).toBeUndefined()
  expect(ui.sessionStatus.getSnapshot().get(childId)).toMatchObject({ running: undefined, completionUnread: false })

  mock.streams.push('$events', { type: 'emit', event: 'api-session/status', args: [childId, true] })
  await mock.streams.drained('$events')
  await client.flush()
  expect(ui.sessionStatus.getSnapshot().get(childId)).toMatchObject({ running: true, completionUnread: false })

  mock.streams.push('$events', { type: 'emit', event: 'api-session/activity', args: [parentId, 2] })
  await mock.streams.drained('$events')
  await client.flush()
  expect(sessions.list.getSnapshot().byId[parentId]?.updatedAt).toBe(2)
  expect(ui.sessionStatus.getSnapshot().get(childId)).toMatchObject({ running: true, completionUnread: false })

  mock.streams.push('$events', { type: 'emit', event: 'api-session/status', args: [childId, false] })
  await mock.streams.drained('$events')
  await client.flush()
  expect(ui.sessionStatus.getSnapshot().get(childId)).toMatchObject({ running: false, completionUnread: true })

  using reference = sessions.retain(childId, { source: 'mainView' })
  await reference.ready
  expect(sessions.list.getSnapshot().ids).not.toContain(childId)
  await vi.waitFor(() => {
    expect(ui.sessionStatus.getSnapshot().get(childId)).toMatchObject({ running: false, completionUnread: false })
  })
  reference.release()
  await client.flush()
  expect(ui.sessionStatus.getSnapshot().get(childId)?.completionUnread).toBe(false)
})
