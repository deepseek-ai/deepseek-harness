/** Controlled connection streams exercise the platform-independent native protocol client. */
import { PassThrough, Writable } from 'node:stream'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { NativeChannel } from '../src/native-client.ts'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { NativeClient, NativeError } from '../src/native-client.ts'

const shared = vi.hoisted(() => ({ create: vi.fn() }))

const Request = z.object({ id: z.string(), method: z.string(), params: z.record(z.string(), z.json()) }).strict()
const Cancel = z.object({ type: z.literal('cancel'), id: z.string() }).strict()
const Frame = z.union([Request, Cancel])

function fixture(options: {
  maxRequestBytes?: number
  maxResponseBytes?: number
  timeoutMs?: number
  screenshotTimeoutMs?: number
  graceMs?: number
  writeError?: Error
  cancelWriteError?: Error
  reportDiagnostic?: (message: string) => void
} = {}) {
  const requests: z.infer<typeof Request>[] = []
  const cancellations: z.infer<typeof Cancel>[] = []
  const stdout = new PassThrough()
  const done: PromiseWithResolvers<void> = Promise.withResolvers()
  const gone: PromiseWithResolvers<void> = Promise.withResolvers()
  const stdin = new Writable({ write(chunk, _encoding, callback) {
    const frame = Frame.parse(JSON.parse(String(chunk)))
    if ('type' in frame) { cancellations.push(frame); callback(options.cancelWriteError) }
    else { requests.push(frame); callback(options.writeError) }
  } })
  const closed: PromiseWithResolvers<void> = Promise.withResolvers()
  const close = vi.fn(() => { closed.resolve() })
  const waitForClose = vi.fn(() => gone.promise)
  const channel: NativeChannel = { stdin, stdout, done: done.promise, close, waitForClose }
  shared.create.mockClear().mockReturnValueOnce(channel)
  const owner = { subprocess: { spawn: vi.fn() } }
  const config = {
    helperPath: '/fixture/helper', cwd: '/fixture', axTimeoutMs: 321, timeoutMs: options.timeoutMs ?? 60_000,
    connectTimeoutMs: 5000, screenshotTimeoutMs: options.screenshotTimeoutMs ?? 5000,
    maxRequestBytes: options.maxRequestBytes ?? 1024,
    maxResponseBytes: options.maxResponseBytes ?? 1024, graceMs: options.graceMs ?? 10, textEventIntervalMs: 0.5, maxClickHoldMs: 5000,
  }
  const client = new NativeClient(owner, config, shared.create, options.reportDiagnostic)
  function finish() { done.resolve(); gone.resolve() }
  function reply(value: unknown) { stdout.write(Buffer.from(JSON.stringify(value) + '\n')) }
  function id(index = requests.length - 1) {
    const request = requests[index]
    if (!request) throw new Error('No native request was dispatched')
    return request.id
  }
  onTestFinished(async () => {
    finish()
    await client.dispose().catch(() => undefined)
    stdout.destroy()
    stdin.destroy()
  })
  return { client, requests, cancellations, stdout, stdin, owner, config, connect: shared.create,
    close, closed: closed.promise, waitForClose, done, gone, finish, reply, id }
}

describe('native helper transport', () => {
  it('passes transport limits and connection deadlines to the shared channel', () => {
    const f = fixture({ maxRequestBytes: 4096, maxResponseBytes: 8192, timeoutMs: 1234 })
    expect(f.connect).toHaveBeenCalledExactlyOnceWith(f.owner, f.config)
  })

  it('uses the logged tool invocation ID for the native request and its matching reply', async () => {
    const f = fixture()
    const pending = f.client.request('activate', { appHandle: 'app-one' }, new AbortController().signal, ToolCallId('foreground-call'))
    expect(f.id()).toBe('foreground-call')
    f.reply({ id: 'foreground-call', result: { dispatched: true, verified: false } })
    await expect(pending).resolves.toEqual({ dispatched: true, verified: false })
  })

  it('accepts split UTF-8 replies and preserves native refusal codes without closing the connection', async () => {
    const f = fixture()
    const first = f.client.request('listApps', {}, new AbortController().signal)
    const bytes = Buffer.from(JSON.stringify({ id: f.id(), result: [{ name: '编辑器' }] }) + '\n')
    for (const byte of bytes) f.stdout.write(Buffer.from([byte]))
    expect(await first).toEqual([{ name: '编辑器' }])
    const second = f.client.request('click', { appHandle: 'app-one' }, new AbortController().signal)
    const rejected = expect(second).rejects.toMatchObject({ name: 'NativeError', code: 'STALE_SNAPSHOT', message: 'STALE_SNAPSHOT: Refresh observation' })
    f.reply({ id: f.id(), error: { code: 'STALE_SNAPSHOT', message: 'Refresh observation' } })
    await rejected
    expect(f.client.disposed).toBe(false)
    expect(f.close).not.toHaveBeenCalled()
    const third = f.client.request('getCapabilities', {}, new AbortController().signal)
    f.reply({ id: f.id(), result: null })
    expect(await third).toBeNull()
    expect(f.connect).toHaveBeenCalledTimes(1)
  })

  it.each(['malformed', 'wrong-id', 'both', 'neither', 'empty-code', 'extra-field', 'invalid-utf8', 'extra-frame', 'duplicate-reply'] as const)('invalidates the connection on a %s response before releasing the caller', async (kind) => {
    const f = fixture()
    const pending = f.client.request('listApps', {}, new AbortController().signal)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'NATIVE_PROTOCOL' })
    if (kind === 'malformed') f.stdout.write('{broken}\n')
    else if (kind === 'wrong-id') f.reply({ id: 'not-active', result: [] })
    else if (kind === 'both') f.reply({ id: f.id(), result: [], error: { code: 'failure', message: 'bad' } })
    else if (kind === 'neither') f.reply({ id: f.id() })
    else if (kind === 'empty-code') f.reply({ id: f.id(), error: { code: '', message: 'bad' } })
    else if (kind === 'extra-field') f.reply({ id: f.id(), result: [], extra: true })
    else if (kind === 'invalid-utf8') f.stdout.write(Buffer.concat([Buffer.from(`{"id":"${f.id()}","result":"`), Buffer.from([0xff]), Buffer.from('"}\n')]))
    else if (kind === 'extra-frame') f.stdout.write(JSON.stringify({ id: f.id(), result: [] }) + '\n{}\n')
    else f.stdout.write((JSON.stringify({ id: f.id(), result: [] }) + '\n').repeat(2))
    expect(f.client.disposed).toBe(true)
    expect(f.close).toHaveBeenCalledTimes(1)
    f.finish()
    await rejected
    await expect(f.client.request('listApps', {}, new AbortController().signal)).rejects.toMatchObject({ code: 'NATIVE_CLOSED' })
    expect(f.requests).toHaveLength(1)
  })

  it('counts UTF-8 bytes and the newline against the response limit', async () => {
    const f = fixture({ maxResponseBytes: 128 })
    const first = f.client.request('listApps', {}, new AbortController().signal)
    const base = JSON.stringify({ id: f.id(), result: '' }) + '\n'
    const value = 'x'.repeat(128 - Buffer.byteLength(base))
    f.reply({ id: f.id(), result: value })
    expect(await first).toBe(value)
    const second = f.client.request('listApps', {}, new AbortController().signal)
    const rejected = expect(second).rejects.toMatchObject({ code: 'NATIVE_RESPONSE_LIMIT' })
    const bytes = Buffer.from(JSON.stringify({ id: f.id(), result: value.slice(1) + 'é' }) + '\n')
    expect(bytes).toHaveLength(129)
    f.stdout.write(bytes.subarray(0, 90))
    f.stdout.write(bytes.subarray(90))
    f.finish()
    await rejected
  })

  it('assembles fragmented large responses without repeatedly copying their prefixes', async () => {
    const f = fixture({ maxResponseBytes: 1024 * 1024 })
    const pending = f.client.request('listApps', {}, new AbortController().signal)
    const value = 'x'.repeat(512 * 1024)
    const bytes = Buffer.from(JSON.stringify({ id: f.id(), result: value }) + '\n')
    const concatenate = Buffer.concat.bind(Buffer)
    let copiedBytes = 0
    const copying = vi.spyOn(Buffer, 'concat').mockImplementation((chunks, length) => {
      copiedBytes += length ?? chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
      return concatenate(chunks, length)
    })
    try {
      f.stdout.emit('data', Buffer.alloc(0))
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) f.stdout.write(bytes.subarray(offset, offset + 64 * 1024))
    } finally { copying.mockRestore() }
    expect(await pending === value).toBe(true)
    // Permit an ownership copy plus one complete-frame assembly, independent of pipe chunk count.
    expect(copiedBytes).toBeLessThanOrEqual(bytes.length * 2)
    expect(f.client.disposed).toBe(false)
  })

  it('bounds request bytes before dispatch and keeps acquired handles after a rejected request', async () => {
    const f = fixture({ maxRequestBytes: 128 })
    const envelope = JSON.stringify({ id: '0'.repeat(36), method: 'typeText', params: { text: '' } }) + '\n'
    const text = 'x'.repeat(128 - Buffer.byteLength(envelope))
    const first = f.client.request('typeText', { text }, new AbortController().signal)
    f.reply({ id: f.id(), result: { dispatched: true } })
    await expect(first).resolves.toEqual({ dispatched: true })
    await expect(f.client.request('typeText', { text: text.slice(1) + 'é' }, new AbortController().signal)).rejects.toMatchObject({ code: 'NATIVE_REQUEST_LIMIT' })
    expect(f.requests).toHaveLength(1)
    expect(f.client.disposed).toBe(false)
    expect(f.close).not.toHaveBeenCalled()
    const next = f.client.request('listApps', {}, new AbortController().signal)
    f.reply({ id: f.id(), result: [] })
    await expect(next).resolves.toEqual([])
  })

  it('rejects an oversized unterminated response before retaining another chunk', async () => {
    const f = fixture({ maxResponseBytes: 64 })
    const pending = f.client.request('listApps', {}, new AbortController().signal)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'NATIVE_RESPONSE_LIMIT' })
    f.stdout.write('x'.repeat(65))
    f.stdout.write('late output')
    f.finish()
    await rejected
    expect(f.close).toHaveBeenCalledTimes(1)
  })

  it('preserves a producer response-limit diagnostic and awaits connection invalidation', async () => {
    const f = fixture()
    const pending = f.client.request('screenshot', {}, new AbortController().signal)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'NATIVE_RESPONSE_LIMIT' })
    f.reply({ id: f.id(), error: { code: 'NATIVE_RESPONSE_LIMIT', message: 'Reply exceeded helper byte limit' } })
    expect(f.client.disposed).toBe(true)
    expect(f.close).toHaveBeenCalledTimes(1)
    f.finish()
    await rejected
  })

  it('waits for cancellation acknowledgement and keeps acquired handles on the same connection', async () => {
    const f = fixture()
    const abort = new AbortController()
    const pending = f.client.request('screenshot', { appHandle: 'retained-app' }, abort.signal)
    let settled = false
    const observed = pending.then(() => { settled = true }, (error: unknown) => { settled = true; expect(error).toMatchObject({ code: 'NATIVE_CANCELLED' }) })
    abort.abort()
    await Promise.resolve()
    expect(f.cancellations).toEqual([{ type: 'cancel', id: f.id() }])
    expect(f.close).not.toHaveBeenCalled()
    expect(settled).toBe(false)
    await expect(f.client.request('getState', {}, new AbortController().signal)).rejects.toMatchObject({ code: 'NATIVE_BUSY' })
    f.reply({ id: f.id(), error: { code: 'NATIVE_CANCELLED', message: 'Capture stopped' } })
    await observed
    expect(f.client.disposed).toBe(false)
    const next = f.client.request('getState', { appHandle: 'retained-app' }, new AbortController().signal)
    f.reply({ id: f.id(), result: { snapshotId: 'fresh' } })
    await expect(next).resolves.toEqual({ snapshotId: 'fresh' })
    expect(f.connect).toHaveBeenCalledTimes(1)
    expect(f.stdout.destroyed).toBe(false)
  })

  it('rejects a pre-cancelled operation without writing or invalidating acquired handles', async () => {
    const f = fixture()
    await expect(f.client.request('click', {}, AbortSignal.abort())).rejects.toMatchObject({ code: 'NATIVE_CANCELLED' })
    expect(f.requests).toEqual([])
    expect(f.client.disposed).toBe(false)
  })

  it('refuses overlapping operations without corrupting the active request', async () => {
    const f = fixture()
    const first = f.client.request('getState', {}, new AbortController().signal)
    await expect(f.client.request('click', {}, new AbortController().signal)).rejects.toMatchObject({ code: 'NATIVE_BUSY' })
    expect(f.requests).toHaveLength(1)
    f.reply({ id: f.id(), result: { snapshotId: 'one' } })
    expect(await first).toEqual({ snapshotId: 'one' })
  })

  it('preserves a completed reply when cancellation arrives before its promise continuation', async () => {
    const f = fixture()
    const abort = new AbortController()
    const pending = f.client.request('click', {}, abort.signal)
    f.reply({ id: f.id(), result: { dispatched: true } })
    abort.abort()
    await expect(pending).resolves.toEqual({ dispatched: true })
    expect(f.cancellations).toEqual([])
    expect(f.client.disposed).toBe(false)
  })

  it('accepts a successful reply as cancellation acknowledgement when the reply was already in flight', async () => {
    const f = fixture()
    const abort = new AbortController()
    const pending = f.client.request('screenshot', {}, abort.signal)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'NATIVE_CANCELLED' })
    abort.abort()
    f.reply({ id: f.id(), result: { data: 'late-image' } })
    await rejected
    expect(f.client.disposed).toBe(false)
    expect(f.close).not.toHaveBeenCalled()
  })

  it('expires the operation deadline without closing an acknowledged connection', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture({ timeoutMs: 25 })
      const pending = f.client.request('getState', {}, new AbortController().signal)
      const rejected = expect(pending).rejects.toMatchObject({ code: 'NATIVE_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(25)
      expect(f.cancellations).toEqual([{ type: 'cancel', id: f.id() }])
      expect(f.client.disposed).toBe(false)
      f.reply({ id: f.id(), error: { code: 'NATIVE_CANCELLED', message: 'Request cancelled' } })
      await rejected
      expect(f.close).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('closes only after the cancellation grace expires without an acknowledgement', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture({ timeoutMs: 25, graceMs: 10 })
      const pending = f.client.request('screenshot', {}, new AbortController().signal)
      const rejected = expect(pending).rejects.toMatchObject({ code: 'NATIVE_CLEANUP', cause: { code: 'NATIVE_TIMEOUT' } })
      await vi.advanceTimersByTimeAsync(25)
      expect(f.close).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(10)
      expect(f.close).toHaveBeenCalledTimes(1)
      f.finish()
      await rejected
      expect(f.client.disposed).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('sends cancellation once and preserves the first interruption reason', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture({ timeoutMs: 25 })
      const abort = new AbortController()
      const pending = f.client.request('screenshot', {}, abort.signal)
      const rejected = expect(pending).rejects.toMatchObject({ code: 'NATIVE_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(25)
      abort.abort()
      expect(f.cancellations).toEqual([{ type: 'cancel', id: f.id() }])
      f.reply({ id: f.id(), result: { data: 'late-image' } })
      await rejected
      expect(f.client.disposed).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it.each(['throw', 'callback'] as const)('closes the connection when sending cancellation fails through %s', async (kind) => {
    const failure = new Error('cancel write failed')
    const f = fixture(kind === 'callback' ? { cancelWriteError: failure } : {})
    const abort = new AbortController()
    const pending = f.client.request('screenshot', {}, abort.signal)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'NATIVE_IO', cause: failure })
    if (kind === 'throw') vi.spyOn(f.stdin, 'write').mockImplementation(() => { throw failure })
    abort.abort()
    await f.closed
    f.finish()
    await rejected
  })

  it.each(['stdout-error', 'stdin-error', 'stdout-end', 'stdout-close', 'connection-exit', 'connection-rejection'] as const)('contains %s while an operation is pending', async (kind) => {
    const f = fixture()
    const pending = f.client.request('getState', {}, new AbortController().signal)
    const code = kind.endsWith('-error') ? 'NATIVE_IO' : kind.startsWith('stdout-') ? 'NATIVE_EOF' : 'NATIVE_EXITED'
    const rejected = expect(pending).rejects.toMatchObject({ code })
    if (kind === 'stdout-error') f.stdout.emit('error', new Error('read failed'))
    else if (kind === 'stdin-error') f.stdin.emit('error', new Error('write failed'))
    else if (kind === 'stdout-end') f.stdout.emit('end')
    else if (kind === 'stdout-close') f.stdout.emit('close')
    else if (kind === 'connection-exit') f.done.resolve()
    else f.done.reject(new Error('connection failed'))
    f.gone.resolve()
    if (!kind.startsWith('connection-')) f.done.resolve()
    await rejected
    expect(f.close).toHaveBeenCalledTimes(1)
  })

  it.each(['throw', 'callback'] as const)('invalidates uncertain dispatch after a write %s failure', async (kind) => {
    const failure = new Error('pipe failed')
    const f = fixture(kind === 'callback' ? { writeError: failure } : {})
    if (kind === 'throw') vi.spyOn(f.stdin, 'write').mockImplementation(() => { throw failure })
    const pending = f.client.request('click', {}, new AbortController().signal)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'NATIVE_IO', cause: failure })
    await f.closed
    f.finish()
    await rejected
    expect(f.client.disposed).toBe(true)
    expect(f.close).toHaveBeenCalledTimes(1)
  })

  it('rejects unsolicited replies and shares one quiescent disposal across callers', async () => {
    const f = fixture()
    f.reply({ id: 'unsolicited', result: [] })
    const first = f.client.dispose()
    const second = f.client.dispose()
    expect(second).toBe(first)
    expect(f.waitForClose).toHaveBeenCalledTimes(1)
    f.finish()
    await first
    expect(() => {
      f.stdout.emit('error', new Error('late read error'))
      f.stdin.emit('error', new Error('late write error'))
    }).not.toThrow()
    expect(f.close).toHaveBeenCalledTimes(1)
  })

  it('rejects pending work on disposal and releases streams even when connection cleanup fails', async () => {
    const f = fixture()
    const pending = f.client.request('getState', {}, new AbortController().signal)
    const failure = new Error('cannot close connection')
    const rejected = expect(pending).rejects.toBe(failure)
    const disposing = f.client.dispose()
    const disposalRejected = expect(disposing).rejects.toBe(failure)
    f.gone.reject(failure)
    await disposalRejected
    await rejected
    expect(f.stdout.destroyed).toBe(true)
    expect(f.stdin.destroyed).toBe(true)
  })

  it('keeps native codes available to callers and in the model-visible diagnostic', () => {
    const error = new NativeError('PERMISSION_DENIED', 'Enable Accessibility')
    expect(error.code).toBe('PERMISSION_DENIED')
    expect(error.message).toBe('PERMISSION_DENIED: Enable Accessibility')
  })

  it('uses the shorter screenshot deadline while leaving ordinary operations their configured time', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture({ timeoutMs: 100, screenshotTimeoutMs: 25 })
      const ordinary = f.client.request('getState', {}, new AbortController().signal)
      await vi.advanceTimersByTimeAsync(25)
      expect(f.client.disposed).toBe(false)
      f.reply({ id: f.id(), result: {} })
      await ordinary
      const screenshot = f.client.request('screenshot', {}, new AbortController().signal)
      const rejected = expect(screenshot).rejects.toMatchObject({ code: 'NATIVE_TIMEOUT', message: 'NATIVE_TIMEOUT: Operation exceeded 25ms' })
      await vi.advanceTimersByTimeAsync(25)
      f.reply({ id: f.id(), error: { code: 'NATIVE_CANCELLED', message: 'Capture stopped' } })
      await rejected
      expect(f.client.disposed).toBe(false)
      const next = f.client.request('getState', { appHandle: 'retained-app' }, new AbortController().signal)
      f.reply({ id: f.id(), result: { snapshotId: 'after-timeout' } })
      await expect(next).resolves.toEqual({ snapshotId: 'after-timeout' })
      expect(f.close).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('retains the last screenshot phase after timeout and request cancellation', async () => {
    vi.useFakeTimers()
    try {
      const reportDiagnostic = vi.fn<(message: string) => void>()
      const f = fixture({ timeoutMs: 25, reportDiagnostic })
      const pending = f.client.request('screenshot', {}, new AbortController().signal, ToolCallId('capture-timeout'))
      const rejected = Promise.all([
        expect(pending).rejects.toMatchObject({ code: 'NATIVE_TIMEOUT' }),
        expect(pending).rejects.toThrow('"stage":"capture-image.begin"'),
      ])
      f.reply({ type: 'diagnostic', requestId: 'capture-timeout', stage: 'capture-image.begin', elapsedMs: 2 })
      await vi.advanceTimersByTimeAsync(25)
      f.reply({ id: f.id(), error: { code: 'NATIVE_CANCELLED', message: 'Capture stopped' } })
      await rejected
      expect(f.client.disposed).toBe(false)
      expect(reportDiagnostic.mock.calls.flat().join('\n')).toContain('host.settled')
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('accepts diagnostic and result frames in one chunk and omits unrelated requests and extra fields', async () => {
    const f = fixture()
    const pending = f.client.request('screenshot', {}, new AbortController().signal, ToolCallId('current'))
    f.stdout.write([
      { type: 'diagnostic', requestId: 'previous', stage: 'old.begin', elapsedMs: 1 },
      { type: 'diagnostic', requestId: 'current', stage: 'ax-geometry.begin', elapsedMs: 3, title: 'private' },
      { id: 'current', error: { code: 'WINDOW_CHANGED', message: 'Window changed' } },
    ].map(frame => JSON.stringify(frame) + '\n').join(''))
    await expect(pending).rejects.toMatchObject({ code: 'WINDOW_CHANGED', message:
      'WINDOW_CHANGED: Window changed\nScreenshot diagnostics:\n'
      + '[cua-screenshot] {"requestId":"current","stage":"ax-geometry.begin","elapsedMs":3}',
    })
    expect(f.client.disposed).toBe(false)
  })

  it('rejects malformed diagnostic frames through the same protocol failure path', async () => {
    const f = fixture()
    const pending = f.client.request('screenshot', {}, new AbortController().signal)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'NATIVE_PROTOCOL' })
    f.reply({ type: 'diagnostic', requestId: f.id(), stage: 'capture-image.begin', elapsedMs: 'invalid' })
    f.finish()
    await rejected
    expect(f.close).toHaveBeenCalledTimes(1)
  })

  it('bounds retained screenshot diagnostics and keeps successful results out of model text', async () => {
    const reportDiagnostic = vi.fn<(message: string) => void>()
    const f = fixture({ reportDiagnostic })
    const pending = f.client.request('screenshot', {}, new AbortController().signal, ToolCallId('capture'))
    for (let index = 0; index < 200; index++) {
      f.reply({ type: 'diagnostic', requestId: 'capture', stage: `phase-${index}`, elapsedMs: index })
    }
    f.reply({ id: 'capture', result: { data: 'image' } })
    await expect(pending).resolves.toEqual({ data: 'image' })
    const retained = reportDiagnostic.mock.calls.map(call => call[0]).find(value => value.includes('discarded'))
    expect(retained).toContain('Earlier screenshot diagnostic records were discarded')
    expect(retained).not.toContain('"stage":"phase-0"')
    expect(retained).toContain('"stage":"phase-199"')
    expect(Buffer.byteLength(retained!.split('\n').slice(1).join(''))).toBeLessThanOrEqual(8192)
    expect(reportDiagnostic.mock.calls.flat().join('\n')).toContain('host.reply')
  })

  it('does not let a Host diagnostic sink replace a screenshot result', async () => {
    const f = fixture({ reportDiagnostic: () => { throw new Error('log sink failed') } })
    const pending = f.client.request('screenshot', {}, new AbortController().signal)
    f.reply({ id: f.id(), result: { data: 'image' } })
    await expect(pending).resolves.toEqual({ data: 'image' })
  })
})
