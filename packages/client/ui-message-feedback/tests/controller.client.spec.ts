/**
 * MessageFeedbackController: the browser-local object layer over one Session's
 * message-feedback sidecar. These specs pin the per-item compare-and-set
 * contract — every mutation sends the version last observed, a conflict
 * reconciles from the authoritative item carried by the reply, mutations
 * serialize per Session, and a disposed controller stops publishing.
 */
import { RemoteMock, ok } from '@deepseek-ai/dsh-remote-mock'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageId, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  MessageFeedbackItem, MessageFeedbackVersion,
} from '@deepseek-ai/dsh-message-feedback/types'
import { MessageFeedbackController } from '../src/client/controller.ts'

const SESSION = 's-1' as SessionId
const MSG = 'm-1' as MessageId
const OTHER = 'm-2' as MessageId

const version = (v: string): MessageFeedbackVersion => v as MessageFeedbackVersion

function item(overrides: Partial<MessageFeedbackItem> = {}): MessageFeedbackItem {
  return {
    messageId: MSG,
    rating: 'positive',
    version: version('v1'),
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

let mock: RemoteMock

beforeEach(() => {
  mock = RemoteMock.create()
  mock.remote.messageFeedback.list.mockResolvedValue(ok({ ok: true, value: { items: [] } }))
  mock.remote.messageFeedback.put.mockResolvedValue(ok({ ok: true, value: item() }))
  mock.remote.messageFeedback.delete.mockResolvedValue(ok({ ok: true, value: { absent: true } }))
})

describe('MessageFeedbackController', () => {
  it('seeds the view from one list read and keys items by message id', async () => {
    const seeded = item({ note: 'good' })
    mock.remote.messageFeedback.list.mockResolvedValueOnce(ok({ ok: true, value: { items: [seeded] } }))
    const controller = new MessageFeedbackController(mock.remote.messageFeedback, SESSION)

    expect(controller.getSnapshot().status).toBe('cold')
    expect(await controller.ensure()).toEqual({ ok: true })

    const view = controller.getSnapshot()
    expect(view.status).toBe('ready')
    expect(view.items.get(MSG)).toEqual(seeded)
    expect(mock.remote.messageFeedback.list).toHaveBeenCalledExactlyOnceWith({ sessionId: SESSION })
  })

  it('collapses concurrent loads onto one in-flight read', async () => {
    const controller = new MessageFeedbackController(mock.remote.messageFeedback, SESSION)

    await Promise.all([controller.ensure(), controller.ensure(), controller.refresh()])

    expect(mock.remote.messageFeedback.list).toHaveBeenCalledTimes(1)
  })

  it('sends ifVersion null for a first rating and the observed version afterwards', async () => {
    const first = item({ version: version('v1') })
    const second = item({ version: version('v2'), rating: 'negative' })
    mock.remote.messageFeedback.put.mockImplementation(request => Promise.resolve(ok({
      ok: true,
      value: request.rating === 'positive' ? first : second,
    })))
    const controller = new MessageFeedbackController(mock.remote.messageFeedback, SESSION)

    expect(await controller.rate(MSG, 'positive')).toEqual({ ok: true })
    expect(await controller.rate(MSG, 'negative')).toEqual({ ok: true })

    const puts = mock.remote.messageFeedback.put.mock.calls.map(([request]) => request)
    expect(puts[0]).toMatchObject({ messageId: MSG, rating: 'positive', ifVersion: null })
    expect(puts[1]).toMatchObject({ messageId: MSG, rating: 'negative', ifVersion: version('v1') })
    expect(controller.getSnapshot().items.get(MSG)).toEqual(second)
  })

  it('forwards the entry as note and category and omits absent members', async () => {
    const controller = new MessageFeedbackController(mock.remote.messageFeedback, SESSION)

    await controller.rate(MSG, 'negative', { text: 'helpful', category: 'task-result' })
    await controller.rate(OTHER, 'negative')

    const puts = mock.remote.messageFeedback.put.mock.calls.map(([request]) => request)
    expect(puts[0]).toMatchObject({ note: 'helpful', category: 'task-result' })
    expect(puts[1]).not.toHaveProperty('note')
    expect(puts[1]).not.toHaveProperty('category')
  })

  it('retract deletes a matching rating and ignores an opposite judgment', async () => {
    mock.remote.messageFeedback.list.mockResolvedValueOnce(ok({
      ok: true, value: { items: [item({ note: 'stored', category: 'other' })] },
    }))
    const controller = new MessageFeedbackController(mock.remote.messageFeedback, SESSION)

    expect(await controller.retract(MSG, 'negative')).toEqual({ ok: true })
    expect(await controller.retract(MSG, 'positive')).toEqual({ ok: true })

    expect(mock.remote.messageFeedback.put).not.toHaveBeenCalled()
    expect(mock.remote.messageFeedback.delete).toHaveBeenCalledExactlyOnceWith({
      sessionId: SESSION, messageId: MSG, ifVersion: version('v1'),
    })
  })

  it('never turns a queued stale retraction into a bare rating put', async () => {
    const existing = item({ rating: 'positive', version: version('v1') })
    const replacement = item({ rating: 'negative', version: version('v2') })
    mock.remote.messageFeedback.list.mockResolvedValueOnce(ok({ ok: true, value: { items: [existing] } }))
    mock.remote.messageFeedback.put.mockResolvedValueOnce(ok({ ok: true, value: replacement }))
    const controller = new MessageFeedbackController(mock.remote.messageFeedback, SESSION)
    await controller.ensure()

    const replaced = controller.rate(MSG, 'negative')
    const staleRetraction = controller.retract(MSG, 'positive')

    await expect(replaced).resolves.toEqual({ ok: true })
    await expect(staleRetraction).resolves.toEqual({ ok: true })
    expect(mock.remote.messageFeedback.put).toHaveBeenCalledTimes(1)
    expect(mock.remote.messageFeedback.delete).not.toHaveBeenCalled()
    expect(controller.getSnapshot().items.get(MSG)).toEqual(replacement)
  })

  it('reconciles a version conflict from the authoritative item without refetching', async () => {
    const authoritative = item({ version: version('v9'), rating: 'negative', note: 'changed elsewhere' })
    mock.remote.messageFeedback.put.mockResolvedValueOnce(ok({
      ok: false,
      error: { code: 'version-conflict', current: authoritative },
    }))
    const controller = new MessageFeedbackController(mock.remote.messageFeedback, SESSION)

    expect(await controller.rate(MSG, 'positive')).toEqual({
      ok: false,
      error: { code: 'version-conflict', message: 'feedback changed elsewhere' },
    })

    expect(controller.getSnapshot().items.get(MSG)).toEqual(authoritative)
    expect(mock.remote.messageFeedback.list).toHaveBeenCalledTimes(1)
  })

  it('drops the local item when a conflict reports the feedback is gone', async () => {
    mock.remote.messageFeedback.list.mockResolvedValueOnce(ok({ ok: true, value: { items: [item()] } }))
    mock.remote.messageFeedback.delete.mockResolvedValueOnce(ok({
      ok: false,
      error: { code: 'version-conflict', current: null },
    }))
    const controller = new MessageFeedbackController(mock.remote.messageFeedback, SESSION)
    await controller.ensure()

    expect(await controller.retract(MSG, 'positive')).toMatchObject({ ok: false, error: { code: 'version-conflict' } })
    expect(controller.getSnapshot().items.has(MSG)).toBe(false)
  })

  it('deletes with the observed version and removes the item on success', async () => {
    mock.remote.messageFeedback.list.mockResolvedValueOnce(ok({
      ok: true, value: { items: [item({ version: version('v7') })] },
    }))
    const controller = new MessageFeedbackController(mock.remote.messageFeedback, SESSION)
    await controller.ensure()

    expect(await controller.retract(MSG, 'positive')).toEqual({ ok: true })

    expect(mock.remote.messageFeedback.delete).toHaveBeenCalledExactlyOnceWith({
      sessionId: SESSION, messageId: MSG, ifVersion: version('v7'),
    })
    expect(controller.getSnapshot().items.has(MSG)).toBe(false)
  })

  it('serializes mutations so each one compares against the committed version', async () => {
    let inFlight = 0
    let overlapped = false
    const versions = [version('v1'), version('v2')]
    let index = 0
    mock.remote.messageFeedback.put.mockImplementation(async () => {
      inFlight += 1
      if (inFlight > 1) overlapped = true
      await Promise.resolve()
      inFlight -= 1
      const next = versions[index] ?? version('vN')
      index += 1
      return ok({ ok: true, value: item({ version: next }) })
    })
    const controller = new MessageFeedbackController(mock.remote.messageFeedback, SESSION)

    await Promise.all([controller.rate(MSG, 'positive'), controller.rate(MSG, 'negative')])

    expect(overlapped).toBe(false)
    const puts = mock.remote.messageFeedback.put.mock.calls.map(([request]) => request)
    expect(puts[0]?.ifVersion).toBeNull()
    expect(puts[1]?.ifVersion).toBe(version('v1'))
  })

  it('publishes an error status when the list read is rejected by the Host', async () => {
    mock.remote.messageFeedback.list.mockResolvedValueOnce(ok({
      ok: false, error: { code: 'session-not-found', sessionId: SESSION },
    }))
    const controller = new MessageFeedbackController(mock.remote.messageFeedback, SESSION)

    expect(await controller.ensure()).toMatchObject({ ok: false, error: { code: 'session-not-found' } })
    expect(controller.getSnapshot()).toMatchObject({
      status: 'error',
      error: 'this session is no longer persisted',
    })
  })

  it('notifies subscribers on publication and stops after unsubscribe', async () => {
    const controller = new MessageFeedbackController(mock.remote.messageFeedback, SESSION)
    const listener = vi.fn()
    const unsubscribe = controller.subscribe(listener)

    await controller.ensure()
    const seen = listener.mock.calls.length
    expect(seen).toBeGreaterThan(0)

    unsubscribe()
    await controller.rate(MSG, 'positive')
    expect(listener).toHaveBeenCalledTimes(seen)
  })

  it('contains a throwing subscriber at the observable boundary', async () => {
    const controller = new MessageFeedbackController(mock.remote.messageFeedback, SESSION)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    controller.subscribe(() => { throw new Error('subscriber exploded') })
    const healthy = vi.fn()
    controller.subscribe(healthy)

    await controller.ensure()

    expect(healthy).toHaveBeenCalled()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('refuses mutations and stops publishing once disposed', async () => {
    const controller = new MessageFeedbackController(mock.remote.messageFeedback, SESSION)
    await controller.ensure()
    const listener = vi.fn()
    controller.subscribe(listener)

    controller.dispose()
    const puts = mock.remote.messageFeedback.put.mock.calls.length

    expect(await controller.rate(MSG, 'positive')).toMatchObject({ ok: false, error: { code: 'disposed' } })
    expect(mock.remote.messageFeedback.put).toHaveBeenCalledTimes(puts)
    expect(listener).not.toHaveBeenCalled()
  })

  it('renders a human explanation for every business failure code', async () => {
    const codes = [
      ['session-not-found', 'this session is no longer persisted'],
      ['target-not-found', 'this message is not a persisted assistant message'],
      ['note-blank', 'a note must contain a non-whitespace character'],
      ['note-too-large', 'the note is too long'],
    ] as const
    for (const [code, message] of codes) {
      mock.remote.messageFeedback.list.mockResolvedValueOnce(ok({
        ok: false, error: { code, sessionId: SESSION },
      } as never))
      const controller = new MessageFeedbackController(mock.remote.messageFeedback, SESSION)
      expect(await controller.ensure()).toMatchObject({ ok: false, error: { code } })
      expect(controller.getSnapshot().error).toBe(message)
    }
  })

  it('falls back to the raw code for an unrecognized failure', async () => {
    mock.remote.messageFeedback.list.mockResolvedValueOnce(ok({
      ok: false, error: { code: 'brand-new-code' },
    } as never))
    const controller = new MessageFeedbackController(mock.remote.messageFeedback, SESSION)

    expect(await controller.ensure()).toMatchObject({ ok: false, error: { code: 'brand-new-code' } })
    expect(controller.getSnapshot().error).toBe('brand-new-code')
  })

  it('publishes nothing when the list settles after disposal', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    mock.remote.messageFeedback.list.mockImplementationOnce(async () => {
      await gate
      return ok({ ok: true, value: { items: [item()] } })
    })
    const controller = new MessageFeedbackController(mock.remote.messageFeedback, SESSION)
    const pending = controller.ensure()
    const listener = vi.fn()
    controller.subscribe(listener)

    controller.dispose()
    release()

    expect(await pending).toEqual({ ok: true })
    expect(controller.getSnapshot().items.has(MSG)).toBe(false)
    expect(listener).not.toHaveBeenCalled()
  })

  it('propagates a failed load to a queued mutation without calling the wire', async () => {
    mock.remote.messageFeedback.list.mockResolvedValueOnce(ok({
      ok: false, error: { code: 'session-not-found', sessionId: SESSION },
    }))
    const controller = new MessageFeedbackController(mock.remote.messageFeedback, SESSION)

    expect(await controller.rate(MSG, 'positive')).toMatchObject({
      ok: false,
      error: { code: 'session-not-found' },
    })
    expect(mock.remote.messageFeedback.put).not.toHaveBeenCalled()
  })

  it('keeps a later mutation running after an earlier one settles as a failure', async () => {
    let first = true
    mock.remote.messageFeedback.put.mockImplementation(() => {
      if (first) {
        first = false
        return Promise.resolve({ ok: false as const, error: new RemoteError('gateway/internal', 'first blew up', {}) })
      }
      return Promise.resolve(ok({ ok: true, value: item({ rating: 'negative' }) }))
    })
    const controller = new MessageFeedbackController(mock.remote.messageFeedback, SESSION)

    const [a, b] = await Promise.all([
      controller.rate(MSG, 'positive'),
      controller.rate(MSG, 'negative'),
    ])

    expect(a).toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
    expect(b).toEqual({ ok: true })
    expect(controller.getSnapshot().items.get(MSG)?.rating).toBe('negative')
  })

  it('ignores a conflict reconciliation that lands after disposal', async () => {
    // The mutate() guard only refuses work admitted after disposal, so this
    // exercises commit()'s own guard: the call is already in flight when the
    // fiber unloads, and its authoritative item must not be published.
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    mock.remote.messageFeedback.list.mockResolvedValueOnce(ok({
      ok: true, value: { items: [item({ version: version('v1') })] },
    }))
    mock.remote.messageFeedback.put.mockImplementationOnce(async () => {
      await gate
      return ok({
        ok: false,
        error: { code: 'version-conflict', current: item({ version: version('v2'), rating: 'negative' }) },
      })
    })
    const controller = new MessageFeedbackController(mock.remote.messageFeedback, SESSION)
    await controller.ensure()
    const listener = vi.fn()
    controller.subscribe(listener)
    const pending = controller.rate(MSG, 'negative')

    controller.dispose()
    release()
    await pending

    // publish() drops its listener set on dispose, so no subscriber is told.
    expect(listener).not.toHaveBeenCalled()
  })

  it('drops a delete conflict reconciliation once disposed mid-flight', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    mock.remote.messageFeedback.list.mockResolvedValueOnce(ok({ ok: true, value: { items: [item()] } }))
    mock.remote.messageFeedback.delete.mockImplementationOnce(async () => {
      await gate
      return ok({ ok: false, error: { code: 'version-conflict', current: null } })
    })
    const controller = new MessageFeedbackController(mock.remote.messageFeedback, SESSION)
    await controller.ensure()
    const pending = controller.retract(MSG, 'positive')

    const listener = vi.fn()
    controller.subscribe(listener)
    controller.dispose()
    release()
    await pending

    // The reconciliation still computes, but no subscriber is notified.
    expect(listener).not.toHaveBeenCalled()
  })

  it('leaves the local item untouched when a rating fails for a non-conflict reason', async () => {
    const existing = item({ version: version('v3'), rating: 'positive' })
    mock.remote.messageFeedback.list.mockResolvedValueOnce(ok({ ok: true, value: { items: [existing] } }))
    mock.remote.messageFeedback.put.mockResolvedValueOnce(ok({
      ok: false, error: { code: 'note-too-large', maxBytes: 8, actualBytes: 9 },
    }))
    const controller = new MessageFeedbackController(mock.remote.messageFeedback, SESSION)
    await controller.ensure()

    expect(await controller.rate(MSG, 'negative', { text: 'far too long' })).toMatchObject({
      ok: false,
      error: { code: 'note-too-large' },
    })
    expect(controller.getSnapshot().items.get(MSG)).toEqual(existing)
  })

  it('leaves the local item untouched when a delete fails for a non-conflict reason', async () => {
    const existing = item({ version: version('v4') })
    mock.remote.messageFeedback.list.mockResolvedValueOnce(ok({ ok: true, value: { items: [existing] } }))
    mock.remote.messageFeedback.delete.mockResolvedValueOnce(ok({
      ok: false, error: { code: 'session-not-found', sessionId: SESSION },
    }))
    const controller = new MessageFeedbackController(mock.remote.messageFeedback, SESSION)
    await controller.ensure()

    expect(await controller.retract(MSG, 'positive')).toMatchObject({
      ok: false,
      error: { code: 'session-not-found' },
    })
    expect(controller.getSnapshot().items.get(MSG)).toEqual(existing)
  })

  it('resync serializes behind an in-flight mutation', async () => {
    // Regression: an unserialized reconnect read could land after a newer put
    // and resurrect the version that put had already replaced.
    const order: string[] = []
    let releasePut = (): void => {}
    const putGate = new Promise<void>((r) => { releasePut = r })
    mock.remote.messageFeedback.list.mockImplementation(() => {
      order.push('list')
      return Promise.resolve(ok({ ok: true, value: { items: [item({ version: version('v1') })] } }))
    })
    mock.remote.messageFeedback.put.mockImplementationOnce(async () => {
      order.push('put:start')
      await putGate
      order.push('put:end')
      return ok({ ok: true, value: item({ version: version('v9'), rating: 'negative' }) })
    })
    const controller = new MessageFeedbackController(mock.remote.messageFeedback, SESSION)
    await controller.ensure()

    const rating = controller.rate(MSG, 'negative')
    const resync = controller.resync()
    releasePut()
    await Promise.all([rating, resync])

    // The reconnect read runs only after the mutation settled.
    expect(order.indexOf('list', 1)).toBeGreaterThan(order.indexOf('put:end'))
  })

  it('refuses a mutation disposed while its seeding read is in flight', async () => {
    // Dispose only once the seeding list call has actually started, so the
    // mutation is already past the admission check and must be stopped by the
    // second guard that runs after ensure() resolves.
    let release = (): void => {}
    const gate = new Promise<void>((r) => { release = r })
    let started = (): void => {}
    const listStarted = new Promise<void>((r) => { started = r })
    mock.remote.messageFeedback.list.mockImplementationOnce(async () => {
      started()
      await gate
      return ok({ ok: true, value: { items: [] } })
    })
    const controller = new MessageFeedbackController(mock.remote.messageFeedback, SESSION)
    const pending = controller.rate(MSG, 'positive')

    await listStarted
    controller.dispose()
    release()

    expect(await pending).toMatchObject({ ok: false, error: { code: 'disposed' } })
    expect(mock.remote.messageFeedback.put).not.toHaveBeenCalled()
  })

  it('renders a carrier failure from the Remote envelope', async () => {
    // The generated face folds transport faults into ok:false with a
    // RemoteFailure, so the controller reads them as values, not rejections.
    mock.remote.messageFeedback.list.mockResolvedValueOnce({
      ok: false,
      error: new RemoteError('gateway/internal', 'socket closed', {}),
    })
    const controller = new MessageFeedbackController(mock.remote.messageFeedback, SESSION)

    expect(await controller.ensure()).toEqual({
      ok: false,
      error: { code: 'gateway/internal', message: 'socket closed' },
    })
    expect(controller.getSnapshot()).toMatchObject({ status: 'error', error: 'socket closed' })
  })

  it('renders a carrier failure on a mutation without touching the view', async () => {
    mock.remote.messageFeedback.put.mockResolvedValueOnce({
      ok: false,
      error: new RemoteError('gateway/internal', 'socket closed', {}),
    })
    const controller = new MessageFeedbackController(mock.remote.messageFeedback, SESSION)

    expect(await controller.rate(MSG, 'positive')).toEqual({
      ok: false,
      error: { code: 'gateway/internal', message: 'socket closed' },
    })
    expect(controller.getSnapshot().items.has(MSG)).toBe(false)
  })

  it('renders a carrier failure on a delete', async () => {
    mock.remote.messageFeedback.list.mockResolvedValueOnce(ok({ ok: true, value: { items: [item()] } }))
    mock.remote.messageFeedback.delete.mockResolvedValueOnce({
      ok: false,
      error: new RemoteError('gateway/internal', 'socket closed', {}),
    })
    const controller = new MessageFeedbackController(mock.remote.messageFeedback, SESSION)
    await controller.ensure()

    expect(await controller.retract(MSG, 'positive')).toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
    expect(controller.getSnapshot().items.has(MSG)).toBe(true)
  })
})
