// @vitest-environment jsdom
/** Office operations map onto typed Remote calls while frames pair with the documents' frame-forwarding channels. */
import { officeLease } from './helpers/office-lease.client.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { OfficeOpenRequest } from '../src/types.ts'
import type { FrameRxId } from '@deepseek-ai/dsh-frame-forwarding/types'
import { fakeFrameForwarding } from './helpers/frame-forwarding.client.ts'
import { afterEach, expect, test, vi } from 'vitest'
import { FrameDiscardedError, FrameFailureError } from '@deepseek-ai/dsh-frame-forwarding/src/client/errors.ts'
import { OfficeChannelError, OfficeConnection, type OfficePreviewRemote } from '../src/client/connection.ts'
import { OfficeInput } from '../src/client/input.ts'
import { OfficeFrameTimeoutError } from '../src/client/frame-forwarding.ts'
import type { OfficeOpenProgress, OfficeDocumentId } from '../src/types.ts'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

interface Call {
  method: string
  args: unknown[]
  reply(value?: object): void
  fail(message: string, reason?: 'stale' | 'credit-timeout'): void
}

afterEach(() => {
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})

const id = brandString<OfficeDocumentId>('doc')
const fields = { sessionId: brandString<import('@deepseek-ai/dsh-session/types').SessionId>('session'), address: 'address', owner: brandString<OfficeOpenRequest['owner']>('tab'), revision: 1, path: 'file.docx' }
const area = { x: 0, y: 0, width: 1, height: 1, pixelWidth: 1, pixelHeight: 1 }
const info = { documentType: 'text', renderBackend: 'ganesh', width: 100, height: 200, part: 0, rectangles: '', parts: [] } as const
const native = (rx = 'rx') => ({ documentId: 'doc', info, rendering: { operationTimeoutMs: 30000 }, nativeView: { rx: brandString<FrameRxId>(rx), frameTimeoutMs: 1000 } })

function fakeRemote() {
  const calls: Call[] = []
  const waiting: (() => void)[] = []
  const unary = (method: string) => (...args: unknown[]) => new Promise((resolve) => {
    calls.push({ method, args, reply: (value = {}) => { resolve({ ok: true, value }) },
      fail: (message, reason) => { resolve({ ok: false, error: reason === undefined
        ? new RemoteError('gateway/internal', message, {}) : new RemoteError('office/frame-retry', message, { reason }) }) } })
    for (const wake of waiting.splice(0)) wake()
  })
  let openItems: (signal: AbortSignal) => AsyncIterable<OfficeOpenProgress> = async function* () {
    yield { kind: 'opened', document: native() } as never
  }
  const remote = {
    open: vi.fn((...args: unknown[]) => openItems(args[2] as AbortSignal)),
    ...Object.fromEntries(['info', 'viewport', 'part', 'paint', 'values', 'presentation', 'selection', 'command',
      'input', 'release', 'reconnect', 'pagePreview'].map(method => [method, vi.fn(unary(method))])),
  }
  const next = async (method: string): Promise<Call> => {
    for (;;) {
      const index = calls.findIndex(call => call.method === method)
      if (index >= 0) return calls.splice(index, 1)[0]!
      await new Promise<void>((resolve) => { waiting.push(resolve) })
    }
  }
  const typed: OfficePreviewRemote = remote as never
  return { remote: typed, calls, next, setOpen: (items: typeof openItems) => { openItems = items } }
}

function fixture() {
  const wire = fakeFrameForwarding(), { close } = wire
  const remote = fakeRemote()
  const connection = new OfficeConnection(wire.client, remote.remote, officeLease)
  const open = async () => connection.open(fields)
  return { connection, doc: connection.document(() => id), ...remote, wire, close, open }
}

test('opening streams loading stages to their caller and returns the opened document', async () => {
  const extraFields = { ...fields, extra: 1 }
  const f = fixture(), progress = vi.fn(), log = vi.spyOn(console, 'error').mockImplementation(() => {})
  f.setOpen(async function* () {
    yield { kind: 'stage', stage: 'fonts' }
    yield { kind: 'stage', stage: 'engine' }
    yield { kind: 'opened', document: { documentId: 'doc', info, rendering: { operationTimeoutMs: 30000 } } } as never
  })
  expect(await f.connection.open(extraFields,
    progress)).toEqual({ documentId: 'doc', info, rendering: { operationTimeoutMs: 30000 } })
  expect(f.remote.open).toHaveBeenCalledWith('session', { address: 'address', owner: brandString<OfficeOpenRequest['owner']>('tab'), revision: 1, path: 'file.docx' }, expect.any(AbortSignal))
  expect(progress.mock.calls.flat()).toEqual(['fonts', 'engine'])
  f.setOpen(async function* () { yield { kind: 'stage', stage: 'document' } })
  await expect(f.connection.open(fields, () => { throw new Error('observer failed') }))
    .rejects.toThrow('Office open ended without a document.')
  expect(log).toHaveBeenCalledWith(expect.objectContaining({ message: 'observer failed' }))
  f.setOpen(async function* () { yield* []; throw new Error('engine could not open file') })
  await expect(f.open()).rejects.toThrow('engine could not open file')
})

test('each operation calls its typed Remote method and surfaces Host failures', async () => {
  const f = fixture()
  const operations = [
    ['info', () => f.doc.info(), []],
    ['viewport', () => f.doc.viewport({ ...area, pixelSize: 1, twipSize: 15 }), [{ ...area, pixelSize: 1, twipSize: 15 }]],
    ['part', () => f.doc.part(2), [2]],
    ['values', () => f.doc.values({ command: 'ViewRowColumnHeaders', area }), [{ command: 'ViewRowColumnHeaders', area }]],
    ['presentation', () => f.doc.presentation({ action: 'next' }), [{ action: 'next' }]],
    ['selection', () => f.doc.selection('text/html'), ['text/html']],
    ['command', () => f.doc.command({ command: 'SelectAll', arguments: {} }), [{ command: 'SelectAll', arguments: {} }]],
    ['input', () => f.doc.input({ op: 'key', type: 0, character: 0, key: 1024 }), [{ op: 'key', type: 0, character: 0, key: 1024 }]],
    ['release', () => f.connection.release(id), []],
  ] as const
  for (const [method, operation, args] of operations) {
    const result = operation()
    const call = await f.next(method)
    expect(call.args).toEqual(['doc', ...args])
    const status = { documentId: 'doc', [method]: true, ...method === 'info' || method === 'part' ? { info } : {} }
    call.reply(status)
    expect(await result).toEqual(method === 'release' ? undefined : status)
  }
  const unavailable = f.doc.info()
  ;(await f.next('info')).reply({ documentId: id, failed: 'engine stopped' })
  expect(await unavailable).toEqual({ documentId: id, failed: 'engine stopped' })
  const failed = f.doc.info()
  ;(await f.next('info')).fail('Office document is closed.')
  await expect(failed).rejects.toThrow('Office document is closed.')
  await expect(f.connection.requestFrame(id, area, 1)).rejects.toThrow('Office shared rendering is unavailable.')
})

test('engine events reach every listener even when one listener fails', () => {
  const f = fixture(), listener = vi.fn(), log = vi.spyOn(console, 'error').mockImplementation(() => {})
  f.connection.listeners.add(() => { throw new Error('listener failed') })
  f.connection.listeners.add(listener)
  f.connection.dispatch({ documentId: id, event: { kind: 'callback', type: 0, payload: '' } })
  expect(listener).toHaveBeenCalledOnce()
  expect(log).toHaveBeenCalledWith(expect.objectContaining({ message: 'listener failed' }))
})

test('operation deadlines and the pending-request bound reject callers without leaving timers', async () => {
  vi.useFakeTimers()
  const f = fixture()
  await f.open()
  let expired = false
  const late = f.doc.info().catch((error: unknown) => { expired = true; return error })
  const timed = await f.next('info')
  try {
    await vi.advanceTimersByTimeAsync(30000)
    expect(expired).toBe(true)
    expect(await late).toMatchObject({ message: 'Office operation timed out.' })
  } finally { timed.reply(); await late }
  expect(vi.getTimerCount()).toBe(0)
  const admitted = Array.from({ length: 128 }, () => f.doc.info())
  await expect(f.doc.info()).rejects.toThrow('Office input is busy.')
  for (let index = 0; index < 128; index++) (await f.next('info')).reply({ info })
  await Promise.all(admitted)
  expect(vi.getTimerCount()).toBe(0)
})

test('a refused automatic recovery reports the failure to the document view', async () => {
  const f = fixture(), events = channelEvents(f.connection)
  await f.open()
  f.wire.lose(brandString<FrameRxId>('rx'))
  ;(await f.next('reconnect')).fail('Office document is closed.')
  await vi.waitFor(() => { expect(events.at(-1)).toEqual({ state: 'paused', message: 'Office document is closed.' }) })
})

test('rendering failures are classified by the recovery a view offers', () => {
  const f = fixture()
  expect(f.connection.renderStop(new FrameDiscardedError('lost'))).toBe('recovering')
  expect(f.connection.renderStop(new FrameFailureError('presentation', 'video playback denied'))).toBe('fallback')
  expect(f.connection.renderStop(new OfficeChannelError('paused', 'lost again'))).toBe('paused')
  expect(f.connection.renderStop(new FrameFailureError('producer', 'render failed'))).toBe('fallback')
  expect(f.connection.renderStop('engine exited')).toBe('fallback')
  expect(f.connection.renderStop(new OfficeChannelError('unavailable', 'GPU unavailable'))).toBe('fallback')
})

test('only an expired frame wait, of the view or of the engine, lets a view keep waiting', () => {
  const f = fixture()
  expect(f.connection.frameWaitExpired(new OfficeFrameTimeoutError('Office frame timed out.'))).toBe(true)
  expect(f.connection.frameWaitExpired(new Error('Native texture credit timed out'))).toBe(false)
  expect(f.connection.frameWaitExpired(new Error('Graphite device lost'))).toBe(false)
  expect(f.connection.frameWaitExpired('Native texture credit timed out')).toBe(false)
})

/** Channel progress reported to the mounted View. */
function channelEvents(connection: OfficeConnection) {
  const events: { state: unknown; message?: unknown }[] = []
  connection.listeners.add((reply) => {
    const event = reply.event as { kind: string; state: unknown; message?: unknown }
    if (event.kind === 'channel') events.push({ state: event.state, ...event.message === undefined ? {} : { message: event.message } })
  })
  return events
}

test('paint completion is independent of frame delivery and carries only the acknowledged generation', async () => {
  const f = fixture(); await f.open()
  const painted = f.connection.requestFrame(id, { x: 0, y: 0, width: 30, height: 30, pixelWidth: 2, pixelHeight: 2 }, 7)
  const call = await f.next('paint')
  expect(call.args[1]).toEqual({ x: 0, y: 0, width: 30, height: 30, pixelWidth: 2, pixelHeight: 2, frame: { generation: 7 } })
  call.reply({ width: 2, height: 2 })
  expect(await painted).toEqual({ width: 2, height: 2 })
  expect(f.wire.setViewport).not.toHaveBeenCalled()
})

test('paint queued during channel replacement cannot reuse its generation on the successor channel', async () => {
  const f = fixture(); await f.open()
  const replacement = f.connection.recover(id, 'user')
  const painted = f.connection.requestFrame(id, { x: 0, y: 0, width: 30, height: 30, pixelWidth: 2, pixelHeight: 2 }, 2)
  ;(await f.next('reconnect')).reply({ outcome: 'reconnected', status: native('rx-2') })
  await replacement
  const requested = vi.mocked(f.remote.paint).mock.calls.length
  if (requested !== 0) (await f.next('paint')).reply()
  await expect(painted).resolves.toBeUndefined()
  expect(requested).toBe(0)
})

test('static page pixels use pagePreview without a shared-frame request', async () => {
  const f = fixture(); await f.open()
  const result = f.doc.pagePreview({ x: 0, y: 0, width: 15, height: 15, pixelWidth: 1, pixelHeight: 1 })
  const call = await f.next('pagePreview'), rgba = Uint8Array.of(1, 2, 3, 4)
  expect(call.args[1]).not.toHaveProperty('frame')
  call.reply({ width: 1, height: 1, rgba })
  expect(await result).toEqual({ width: 1, height: 1, rgba })
})

test('viewport races are retryable but other rendering failures are not', () => {
  const f = fixture()
  expect(f.connection.engineViewportStale(new Error('Native frame viewport is stale'))).toBe(false)
  expect(f.connection.engineViewportStale(new RemoteError('office/frame-retry', 'Native frame viewport is stale', { reason: 'stale' }))).toBe(true)
  expect(f.connection.engineViewportStale(new RemoteError('office/frame-retry', 'credit', { reason: 'credit-timeout' }))).toBe(false)
  expect(f.connection.engineViewportStale(new Error('engine stopped'))).toBe(false)
})

test('channel replacement retires the old receive channel and release closes its successor', async () => {
  const f = fixture(); await f.open()
  const old = f.connection.frameForwardingSession(id)
  const replaced = f.doc.info(); (await f.next('info')).reply(native('replacement')); await replaced
  expect(f.connection.frameForwardingSession(id)).not.toBe(old)
  expect(f.close).toHaveBeenCalledWith('rx')
  const released = f.connection.release(id); (await f.next('release')).reply(); await released
  expect(f.connection.frameForwardingSession(id)).toBeUndefined()
  expect(f.close).toHaveBeenCalledWith('replacement')
})

test('a lost channel reconnects once and notifies mounted views', async () => {
  const f = fixture(); await f.open()
  const events = channelEvents(f.connection)
  f.wire.lose(brandString<FrameRxId>('rx'))
  const reconnect = await f.next('reconnect')
  const also = f.connection.recover(id, 'automatic')
  reconnect.reply({ outcome: 'reconnected', status: native('rx-2') }); await also
  expect(f.remote.reconnect).toHaveBeenCalledOnce()
  expect(events).toEqual([{ state: 'recovering' }, { state: 'reconnected' }])
})

test.each([false, true])('channel loss during slideshow startup drains the input queue (preceding request: %s)', async (preceding) => {
  const f = fixture(); await f.open()
  vi.mocked(f.remote.presentation).mockResolvedValue({ ok: true, value: { documentId: id } })
  const old = f.connection.frameForwardingSession(id)!, queue = new OfficeInput()
  const gate = Promise.withResolvers<undefined>()
  const queued = Promise.withResolvers<undefined>(), admitted = Promise.withResolvers<undefined>()
  const barrier = queue.send(() => gate.promise)
  const doc = f.connection.document(() => id, work => queue.send(() => {
    admitted.resolve(undefined)
    return work()
  }))
  const earlier = preceding ? doc.info() : undefined
  const detach = vi.fn()
  vi.spyOn(old.rx, 'mount').mockReturnValue(detach)
  vi.spyOn(old, 'ready').mockResolvedValue(undefined)
  vi.spyOn(old.rx, 'viewport', 'get').mockReturnValue({ version: 7, width: 800, height: 600, deviceScaleFactor: 1, visible: true })
  const play = old.startPlayback(document.createElement('div'), (control, signal) => {
    const request = doc.playback(old, control, signal)
    queued.resolve(undefined)
    return request
  }, vi.fn(), vi.fn())
  await queued.promise
  f.wire.lose(old.rx.rx)
  const reconnect = await f.next('reconnect'), recovery = f.connection.recover(id, 'automatic')
  gate.resolve(undefined); await barrier; await admitted.promise
  f.connection.ownView(() => queue.send(() => f.connection.release(id)))
  const disposal = f.connection.dispose()
  reconnect.reply({ outcome: 'reconnected', status: native('rx-2') })
  await recovery
  expect(detach).toHaveBeenCalledOnce()
  if (preceding) { (await f.next('info')).reply(native('rx-2')); await earlier }
  await play.ready
  ;(await f.next('release')).reply()
  await disposal
  expect(f.remote.presentation).not.toHaveBeenCalled()
  expect(f.remote.release).toHaveBeenCalledExactlyOnceWith(id)
  expect(f.connection.frameForwardingSession(id)).toBeUndefined()
})

test.each(['stopped mount', 'replaced channel'])('queued playback controls are discarded for a %s', async (ending) => {
  const f = fixture(); await f.open()
  vi.mocked(f.remote.presentation).mockResolvedValue({ ok: true, value: { documentId: id } })
  const session = f.connection.frameForwardingSession(id)!, queue = new OfficeInput(), mount = new AbortController()
  const doc = f.connection.document(() => id, work => queue.send(work))
  const head = doc.info(), blocked = await f.next('info')
  const enable = doc.playback(session, { action: 'stream', enabled: true, streamId: 'old', generation: 3 }, mount.signal)
  const resize = doc.playback(session, { action: 'resize', pixelWidth: 640, pixelHeight: 480 }, mount.signal)
  if (ending === 'stopped mount') mount.abort()
  blocked.reply(native(ending === 'stopped mount' ? 'rx' : 'rx-2')); await head
  expect(await Promise.all([enable, resize])).toEqual([undefined, undefined])
  expect(f.remote.presentation).not.toHaveBeenCalled()
  const release = f.connection.release(id); (await f.next('release')).reply(); await release
})

test.each(['limited', 'unavailable'] as const)('a %s reconnect leaves an observable user recovery state', async (outcome) => {
  const f = fixture(); await f.open(); const events = channelEvents(f.connection)
  const recovery = f.connection.recover(id, 'user')
  ;(await f.next('reconnect')).reply(outcome === 'limited' ? { outcome } : { outcome, reason: 'gpu-compositing-disabled' })
  await recovery
  expect(events.at(-1)?.state).toBe(outcome === 'limited' ? 'paused' : 'unavailable')
})

test.each(['stale', 'credit-timeout'] as const)('Remote %s reason controls retry independently of diagnostic text', async (reason) => {
  const f = fixture()
  await f.open()
  const result = f.connection.requestFrame(id, area, 1).catch((error: unknown) => error)
  ;(await f.next('paint')).fail('Rendering will resume after readiness.', reason)
  const error = await result
  expect(error).toMatchObject({ code: 'office/frame-retry', details: { reason } })
  expect(f.connection.engineViewportStale(error)).toBe(reason === 'stale')
  expect(f.connection.frameWaitExpired(error)).toBe(reason === 'credit-timeout')
  const release = f.connection.release(id)
  ;(await f.next('release')).reply()
  await release
})

test.each([1000, 300000])('document operations use the Host operationTimeoutMs of %s', async (operationTimeoutMs) => {
  vi.useFakeTimers()
  const f = fixture()
  f.setOpen(async function* () { yield { kind: 'opened', document: { ...native(), rendering: { operationTimeoutMs } } } as never })
  await f.open()
  let settled = false
  const request = f.doc.info().catch((error: unknown) => { settled = true; return error })
  const call = await f.next('info')
  try {
    await vi.advanceTimersByTimeAsync(operationTimeoutMs - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
    expect(await request).toMatchObject({ message: 'Office operation timed out.' })
  } finally {
    call.reply(); await request
    const released = f.connection.release(id)
    ;(await f.next('release')).reply()
    await released
  }
  expect(vi.getTimerCount()).toBe(0)
})

test('initial open has no competing Client deadline and preserves the Host timeout failure', async () => {
  vi.useFakeTimers()
  const f = fixture(), opening = Promise.withResolvers<OfficeOpenProgress>(), failure = new Error('Office open exceeded 300000ms.')
  let signal: AbortSignal | undefined, settled = false
  f.setOpen(async function* (lifetime) { signal = lifetime; yield await opening.promise })
  const request = f.open().catch((error: unknown) => { settled = true; return error })
  try {
    await vi.advanceTimersByTimeAsync(60001)
    expect(settled).toBe(false)
    expect(signal?.aborted).toBe(false)
  } finally {
    opening.reject(failure)
    expect(await request).toBe(failure)
  }
  expect(signal?.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})


test('a failed Client attachment releases the opened Host document before rejecting open', async () => {
  const f = fixture(), error = new Error('native receiver unavailable')
  vi.spyOn(f.wire.client, 'connect').mockImplementationOnce(() => { throw error })
  const open = f.open(), rejected = expect(open).rejects.toBe(error)
  const release = await f.next('release')
  expect(release.args).toEqual(['doc'])
  release.reply()
  await rejected
  expect(f.remote.release).toHaveBeenCalledOnce()
  expect(f.connection.frameForwardingSession(id)).toBeUndefined()
})


test.each(['info', 'release', 'presentation'] as const)('%s waits for channel recovery before sending its RPC', async (op) => {
  const f = fixture(); await f.open()
  const recovering = f.connection.recover(id, 'user')
  const request = op === 'presentation' ? f.doc.presentation({ action: 'stop' }) : op === 'info' ? f.doc.info() : f.connection.release(id)
  const call = await f.next('reconnect')
  expect(f.calls).toHaveLength(0)
  call.reply({ outcome: 'reconnected', status: native('rx-2') }); await recovering
  ;(await f.next(op)).reply(native('rx-2')); await request
  if (op !== 'release') { const release = f.connection.release(id); (await f.next('release')).reply(); await release }
})

test('a rejected recovery reports its error and lets queued operations settle on the original channel', async () => {
  const f = fixture(); await f.open()
  const events = channelEvents(f.connection)
  const gate = Promise.withResolvers<never>()
  vi.mocked(f.remote.reconnect).mockImplementationOnce(() => gate.promise)
  const recovering = f.connection.recover(id, 'user'), rejected = expect(recovering).rejects.toBe('disconnected')
  const info = f.doc.info(), paint = f.connection.requestFrame(id, area, 1), release = f.connection.release(id)
  expect(f.calls).toHaveLength(0)
  gate.reject('disconnected'); await rejected
  expect(events.at(-1)).toEqual({ state: 'paused', message: 'disconnected' })
  ;(await f.next('info')).reply(); await info
  ;(await f.next('paint')).reply(); await paint
  ;(await f.next('release')).reply(); await release
  expect(f.close).toHaveBeenCalledOnce()
})

test('an attachment failure on an existing document rejects without releasing the Host document', async () => {
  const f = fixture(); await f.open()
  const error = new Error('receiver unavailable')
  vi.spyOn(f.wire.client, 'connect').mockImplementationOnce(() => { throw error })
  const result = f.doc.info(), rejected = expect(result).rejects.toBe(error)
  ;(await f.next('info')).reply(native('new')); await rejected
  expect(f.remote.release).not.toHaveBeenCalled()
  const release = f.connection.release(id); (await f.next('release')).reply(); await release
})

test('open cleanup reports release failure while preserving the original attachment error', async () => {
  const f = fixture(), error = new Error('receiver unavailable'), warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(f.wire.client, 'connect').mockImplementationOnce(() => { throw error })
  const result = f.open(), rejected = expect(result).rejects.toBe(error)
  ;(await f.next('release')).fail('release failed'); await rejected
  expect(warn).toHaveBeenCalledWith('Office failed open cleanup failed.', expect.objectContaining({ message: 'release failed' }))
})

test('retiring a channel reports cleanup failure and keeps the successor available', async () => {
  const f = fixture(); await f.open()
  const old = f.connection.frameForwardingSession(id)!, close = old.close.bind(old), error = new Error('old receiver close failed')
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(old, 'close').mockImplementationOnce(async () => { await close(); throw error })
  const result = f.doc.info(); (await f.next('info')).reply(native('next')); await result
  expect(warn).toHaveBeenCalledWith('Office retired view cleanup failed.', error)
  expect(f.connection.frameForwardingSession(id)!.rx.rx).toBe('next')
  const release = f.connection.release(id); (await f.next('release')).reply(); await release
})

/** Engine failures reported to the mounted View. */
function failureEvents(connection: OfficeConnection) {
  const events: unknown[] = []
  connection.listeners.add((reply) => {
    if ((reply.event as { kind: string }).kind === 'failure') events.push(reply)
  })
  return events
}

test('failing all documents reports each open document once and rejects later operations except release', async () => {
  const f = fixture(); await f.open()
  const events = failureEvents(f.connection), error = new Error('Office engine events are unavailable: stream ended')
  const reopening = f.open()
  f.connection.failAll(error)
  f.connection.failAll(new Error('second failure'))
  expect(events).toEqual([{ documentId: 'doc', event: { kind: 'failure', error: error.message } }])
  await expect(f.connection.requestFrame(id, area, 1)).rejects.toBe(error)
  // A document whose open completes afterward is released, and its view falls back through the rejection.
  const cleanup = await f.next('release')
  expect(cleanup.args).toEqual(['doc'])
  cleanup.reply(); await expect(reopening).rejects.toBe(error)
  await expect(f.doc.info()).rejects.toBe(error)
  await expect(f.connection.recover(id, 'user')).rejects.toBe(error)
  await expect(f.open()).rejects.toBe(error)
  expect(f.calls).toHaveLength(0)
  const release = f.connection.release(id); (await f.next('release')).reply(); await release
  expect(f.remote.release).toHaveBeenCalledTimes(2)
  expect(events).toHaveLength(1)
})

test('a recovery that completes after all documents failed rejects without reconnecting its views', async () => {
  const f = fixture(); await f.open()
  const events = channelEvents(f.connection), error = new Error('events ended')
  const recovery = f.connection.recover(id, 'user'), rejected = expect(recovery).rejects.toBe(error)
  const reconnect = await f.next('reconnect')
  f.connection.failAll(error)
  reconnect.reply({ outcome: 'reconnected', status: native('rx-2') }); await rejected
  expect(f.connection.frameForwardingSession(id)!.rx.rx).toBe('rx')
  await vi.waitFor(() => { expect(events.at(-1)).toEqual({ state: 'paused', message: 'events ended' }) })
})

test('paints and slideshow transitions answered after all documents failed reject without installing a channel', async () => {
  const f = fixture(); await f.open()
  const error = new Error('events ended')
  const frame = f.connection.requestFrame(id, area, 1), frameRejected = expect(frame).rejects.toBe(error)
  const paint = await f.next('paint')
  const starting = f.doc.presentation({ action: 'start', pixelWidth: 1, pixelHeight: 1, part: 0 }), startRejected = expect(starting).rejects.toBe(error)
  const start = await f.next('presentation')
  f.connection.failAll(error)
  paint.reply({ width: 1, height: 1 }); await frameRejected
  start.reply(native('rx-2')); await startRejected
  expect(f.connection.frameForwardingSession(id)!.rx.rx).toBe('rx')
  expect(f.wire.close).not.toHaveBeenCalled()
})

test('an open answered after all documents failed releases its document and rejects', async () => {
  const f = fixture(), gate = Promise.withResolvers<undefined>(), error = new Error('events ended')
  f.setOpen(async function* () {
    await gate.promise
    yield { kind: 'opened', document: native() } as never
  })
  const opening = f.open(), rejected = expect(opening).rejects.toBe(error)
  expect(f.remote.open).toHaveBeenCalledOnce()
  f.connection.failAll(error)
  gate.resolve(undefined)
  const cleanup = await f.next('release')
  expect(cleanup.args).toEqual(['doc'])
  cleanup.reply(); await rejected
  expect(f.connection.frameForwardingSession(id)).toBeUndefined()
})

test('a failed frame channel fails its document even when no view mounts it', async () => {
  const f = fixture(); await f.open()
  const events = failureEvents(f.connection)
  // Ending the frame-forwarding Client fails every receive channel; the channel settles as `failed`.
  f.wire.dispose()
  expect(await f.connection.frameForwardingSession(id)!.rx.closed).toBe('failed')
  await vi.waitFor(() => { expect(events).toEqual([{ documentId: 'doc', event: { kind: 'failure', error: 'Office frame channel failed.' } }]) })
  expect(f.remote.reconnect).not.toHaveBeenCalled()
})

test('a channel closed without loss or failure neither reconnects nor fails its document', async () => {
  const f = fixture(); await f.open()
  const events = failureEvents(f.connection), rx = f.connection.frameForwardingSession(id)!.rx
  await rx.close()
  expect(await rx.closed).toBe('closed')
  await Promise.resolve()
  expect(events).toEqual([])
  expect(f.remote.reconnect).not.toHaveBeenCalled()
})

test('disposal joins a closing view and waits for remaining releases after another fails', async () => {
  const f = fixture(), pending = Promise.withResolvers<undefined>()
  const release = vi.fn(() => pending.promise)
  const close = f.connection.ownView(release)!
  const closing = close()
  const error = new Error('Release failed')
  f.connection.ownView(async () => { throw error })
  const disposal = f.connection.dispose()
  expect(f.connection.ownView(release)).toBeUndefined()
  expect(close()).toBe(closing)
  pending.resolve(undefined)
  await expect(disposal).rejects.toMatchObject({ errors: [error] })
  expect(release).toHaveBeenCalledOnce()
  await f.connection.dispose()
  f.wire.dispose()
})
