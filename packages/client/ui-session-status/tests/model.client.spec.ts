import { expect, it, vi } from 'vitest'
import { RemoteError, type TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionReadModel } from '../src/client/model.ts'
import type { SessionReadState } from '../src/types.ts'

const id = SessionId('reading')
const record = (completedTurn: number, manualUnread = false): SessionReadState => ({
  sessionId: id, completedTurn, failed: false, readTurn: 0, manualUnread,
})

it('replaces reconnect baselines and rejects actions without a current baseline', async () => {
  const mark = vi.fn<TypertClientRemote['sessionStatus']['mark']>()
  const model = new SessionReadModel({ mark })
  await expect(model.mark(id, false)).rejects.toThrow('Reload the page')
  model.replace([record(1)])
  model.accept(record(2))
  expect(model.state.getSnapshot().items[id]?.completedTurn).toBe(2)
  model.disconnected()
  expect(model.state.getSnapshot()).toMatchObject({ ready: false })
  model.replace([])
  expect(model.state.getSnapshot()).toEqual({ items: {}, ready: true })
})

it('keeps newer pushed unread marks when an older read response arrives', async () => {
  const response = Promise.withResolvers<{ ok: true; value: undefined }>()
  const mark = vi.fn<TypertClientRemote['sessionStatus']['mark']>(() => response.promise)
  const model = new SessionReadModel({ mark })
  model.replace([record(1)])
  const pending = model.mark(id, false)
  model.accept(record(3, true))
  response.resolve({ ok: true, value: undefined })
  await pending
  expect(mark).toHaveBeenCalledWith(id, { type: 'read', throughTurn: 1 })
  expect(model.state.getSnapshot().items[id]).toEqual(record(3, true))
})

it('keeps a replaced baseline when an earlier operation completes and preserves records on failure', async () => {
  const response = Promise.withResolvers<{ ok: true; value: undefined }>()
  const mark = vi.fn<TypertClientRemote['sessionStatus']['mark']>(() => response.promise)
  const model = new SessionReadModel({ mark })
  model.replace([record(1)])
  const pending = model.mark(id, true)
  model.disconnected()
  model.replace([])
  response.resolve({ ok: true, value: undefined })
  await pending
  expect(model.state.getSnapshot().items).toEqual({})
  mark.mockRejectedValueOnce(new Error('offline'))
  await expect(model.mark(id, true)).rejects.toThrow('offline')
  expect(model.state.getSnapshot().items).toEqual({})
})

it('sends explicit marks and body acknowledgements with their observed positions', async () => {
  const mark = vi.fn<TypertClientRemote['sessionStatus']['mark']>(async () => ({ ok: true, value: undefined }))
  const model = new SessionReadModel({ mark })
  model.replace([])
  await model.mark(id, false)
  await model.mark(id, true)
  await model.acknowledge(id, 2, false)
  await model.acknowledge(id, 3, true)
  expect(mark.mock.calls).toEqual([
    [id, { type: 'read', throughTurn: 0 }],
    [id, { type: 'unread' }],
    [id, { type: 'acknowledge', throughTurn: 2 }],
    [id, { type: 'read', throughTurn: 3 }],
  ])
  expect(model.state.getSnapshot().items).toEqual({})
})

it('reports business rejection and disables writes without losing reminders', async () => {
  const error = new RemoteError('session-status/unavailable', 'Storage unavailable', {})
  const mark = vi.fn<TypertClientRemote['sessionStatus']['mark']>(async () => ({ ok: false, error }))
  const model = new SessionReadModel({ mark })
  model.replace([record(1)])
  await expect(model.mark(id, false)).rejects.toBe(error)
  expect(model.state.getSnapshot().items[id]).toEqual(record(1))
  model.disconnected()
  expect(model.state.getSnapshot()).toMatchObject({ ready: false })
})

it('accepts the first pushed record for a newly visible Session', () => {
  const model = new SessionReadModel({ mark: vi.fn<TypertClientRemote['sessionStatus']['mark']>() })
  model.replace([])
  model.accept(record(1))
  expect(model.state.getSnapshot().items[id]).toEqual(record(1))
})
