/** Controlled connection streams exercise the platform-independent native protocol client. */
import { PassThrough, Writable } from 'node:stream'
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import type { NativeChannel } from '../src/native-client.ts'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { NativeClient, NativeError } from '../src/native-client.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

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
  const frames: z.infer<typeof Frame>[] = []
  const stdout = new PassThrough()
  const done: PromiseWithResolvers<void> = Promise.withResolvers()
  const gone: PromiseWithResolvers<void> = Promise.withResolvers()
  const stdin = new Writable({ write(chunk, _encoding, callback) {
    const frame = Frame.parse(JSON.parse(String(chunk)))
    frames.push(frame)
    if ('type' in frame) { cancellations.push(frame); callback(options.cancelWriteError) }
    else { requests.push(frame); callback(options.writeError) }
  } })
  const closed: PromiseWithResolvers<void> = Promise.withResolvers()
  const close = vi.fn(() => { closed.resolve() })
  const waiting: PromiseWithResolvers<void> = Promise.withResolvers()
  const waitForClose = vi.fn(() => { waiting.resolve(); return gone.promise })
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
  return { client, requests, cancellations, frames, stdout, stdin, owner, config, connect: shared.create,
    close, closed: closed.promise, waiting: waiting.promise, waitForClose, done, gone, finish, reply, id }
}

describe('native helper transport', () => {
  it('sends run cleanup after an interrupted native request has acknowledged its outcome', async () => {
    const f = fixture()
    const active = f.client.request('getState', {}, new AbortController().signal)
    const release = f.client.requestCleanup('releaseHeldKeys', { runId: 'program' })
    expect(f.requests).toHaveLength(1)
    f.reply({ id: f.id(), error: { code: 'NATIVE_CANCELLED', message: 'paused' } })
    await expect(active).rejects.toThrow('paused')
    expect(f.requests.map(frame => frame.method)).toEqual(['getState', 'releaseHeldKeys'])
    f.reply({ id: f.id(), result: { dispatched: true } })
    await expect(release).resolves.toEqual({ dispatched: true })
  })

  it.each(['connection', 'resource'] as const)('shares %s-triggered cleanup and waits for its acknowledgement before closing', async (trigger) => {
    const f = fixture()
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    let cleanup: Promise<void> | undefined
    const release = (): Promise<void> => cleanup ??= f.client.requestCleanup('releaseHeldKeys', { runId: 'shared' })
      .then(() => undefined).finally(() => { remove() })
    const remove = f.client.registerCleanup((canRequest) => { expect(canRequest).toBe(true); entered.resolve(); return release() })
    const pending = trigger === 'resource' ? release() : undefined
    const closing = f.client.dispose()
    expect(f.client.dispose()).toBe(closing)
    expect(f.client.disposed).toBe(true)
    const denied = expect(f.client.request('click', {}, new AbortController().signal)).rejects.toMatchObject({ code: 'NATIVE_CLOSED' })
    expect(() => f.client.registerCleanup(async () => {})).toThrow('closing helper')
    await entered.promise
    expect(f.requests.map(request => request.method)).toEqual(['releaseHeldKeys'])
    expect(f.cancellations).toEqual([])
    expect(f.close).not.toHaveBeenCalled()
    f.reply({ id: f.id(), result: { dispatched: true } })
    await f.waiting
    expect(f.close).toHaveBeenCalledTimes(1)
    expect(f.stdout.destroyed).toBe(false)
    f.finish()
    await Promise.all([closing, pending, denied])
    await release()
    expect(f.requests).toHaveLength(1)
    expect(f.waitForClose).toHaveBeenCalledTimes(1)
    expect(f.stdout.destroyed).toBe(true)
    expect(f.stdin.destroyed).toBe(true)
  })

  it('keeps screenshot diagnostics on the cancellation returned during graceful disposal', async () => {
    const reportDiagnostic = vi.fn<(message: string) => void>()
    const f = fixture({ reportDiagnostic })
    const pending = f.client.request('screenshot', {}, new AbortController().signal, brandString<ToolCallId>('graceful-capture'))
    const result = pending.catch((error: unknown) => error)
    f.reply({ type: 'diagnostic', requestId: 'graceful-capture', stage: 'capture-image.begin', elapsedMs: 2 })
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    f.client.registerCleanup(async () => {
      const release = f.client.requestCleanup('releaseHeldKeys', { runId: 'graceful' })
      entered.resolve()
      await release
    })
    const closing = f.client.dispose()
    await entered.promise
    expect(f.cancellations).toEqual([{ type: 'cancel', id: 'graceful-capture' }])
    f.reply({ id: 'graceful-capture', error: { code: 'NATIVE_CANCELLED', message: 'capture cancelled' } })
    await expect.poll(() => f.requests.map(request => request.method)).toEqual(['screenshot', 'releaseHeldKeys'])
    f.reply({ id: f.id(), result: { dispatched: true } })
    await f.waiting
    expect(reportDiagnostic.mock.calls.flat().join('\n')).not.toContain('host.settled')
    f.finish()
    await closing
    const failure = await result
    expect(failure).toMatchObject({ code: 'NATIVE_CANCELLED' })
    if (!(failure instanceof NativeError)) throw new Error('The screenshot cancellation must retain its native error')
    expect(failure.message).toContain('capture-image.begin')
    expect(failure.message).not.toContain('NATIVE_DISPOSED')
    expect(reportDiagnostic.mock.calls.flat().join('\n')).toContain('host.settled')
  })

  it.each(['write', 'protocol', 'timeout'] as const)('settles a fatal cleanup %s without waiting recursively on disposal', async (kind) => {
    if (kind === 'timeout') vi.useFakeTimers()
    try {
      const f = fixture({ timeoutMs: 25, graceMs: 10,
        ...kind === 'write' ? { writeError: new Error('cleanup pipe failed') } : {},
      })
      const joined: PromiseWithResolvers<void> = Promise.withResolvers()
      let cleanup: Promise<void> | undefined
      const release = (): Promise<void> => cleanup ??= f.client.requestCleanup('releaseHeldKeys', { runId: 'failing' }).then(() => undefined)
      f.client.registerCleanup(() => { joined.resolve(); return release() })
      const pending = release()
      const closing = f.client.dispose()
      const results = Promise.allSettled([pending, closing])
      await joined.promise
      if (kind === 'protocol') f.stdout.write('{invalid}\n')
      if (kind === 'timeout') await vi.advanceTimersByTimeAsync(25)
      await f.closed
      expect(f.close).toHaveBeenCalledTimes(1)
      expect(f.cancellations).toEqual([])
      f.finish()
      const [first, second] = await results
      const code = kind === 'write' ? 'NATIVE_IO' : kind === 'protocol' ? 'NATIVE_PROTOCOL' : 'NATIVE_TIMEOUT'
      expect(first).toMatchObject({ status: 'rejected', reason: { code } })
      expect(second).toMatchObject({ status: 'rejected', reason: { code } })
      if (first?.status !== 'rejected' || second?.status !== 'rejected') throw new Error('Both cleanup callers must settle')
      expect(second.reason).toBe(first.reason)
      expect(f.stdout.destroyed).toBe(true)
      expect(f.stdin.destroyed).toBe(true)
    } finally { if (kind === 'timeout') vi.useRealTimers() }
  })

  it.each(['refusal', 'request-limit'] as const)('invalidates standalone cleanup on %s before another request can enter', async (kind) => {
    const f = fixture(kind === 'request-limit' ? { maxRequestBytes: 32 } : {})
    const cleanup = f.client.requestCleanup('releaseHeldKeys', { runId: 'standalone' })
    const rejected = expect(cleanup).rejects.toMatchObject({ code: kind === 'refusal' ? 'RELEASE_REFUSED' : 'NATIVE_REQUEST_LIMIT' })
    if (kind === 'refusal') f.reply({ id: f.id(), error: { code: 'RELEASE_REFUSED', message: 'release not acknowledged' } })
    // Admission is checked in the same stack as the failed reply or preflight.
    expect(f.close).toHaveBeenCalledTimes(1)
    const denied = expect(f.client.request('click', {}, new AbortController().signal)).rejects.toMatchObject({ code: 'NATIVE_CLOSED' })
    expect(f.requests).toHaveLength(kind === 'refusal' ? 1 : 0)
    await f.waiting
    f.finish()
    await Promise.all([rejected, denied])
  })

  it('closes a timed-out standalone cleanup and ignores its late acknowledgement', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture({ timeoutMs: 25, graceMs: 10 })
      const cleanup = f.client.requestCleanup('releaseHeldKeys', { runId: 'expired' })
      const rejected = expect(cleanup).rejects.toMatchObject({ code: 'NATIVE_TIMEOUT' })
      const id = f.id()
      await vi.advanceTimersByTimeAsync(25)
      expect(f.close).toHaveBeenCalledTimes(1)
      expect(f.cancellations).toEqual([])
      f.reply({ id, result: { dispatched: true } })
      f.finish()
      await rejected
      expect(f.client.disposed).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it.each(['request', 'cleanup'] as const)('retains the original %s failure when connection closure also fails', async (kind) => {
    const reportDiagnostic = vi.fn<(message: string) => void>()
    const f = fixture({ reportDiagnostic })
    const original = new NativeError('NATIVE_IO', 'original connection failure')
    const closeFailure = new Error('connection close acknowledgement failed')
    const pending = kind === 'request'
      ? f.client.request('screenshot', {}, new AbortController().signal, brandString<ToolCallId>('failed-capture'))
      : f.client.requestCleanup('releaseHeldKeys', { runId: 'both-failed' })
    const result = pending.catch((error: unknown) => error)
    if (kind === 'request') f.reply({ type: 'diagnostic', requestId: 'failed-capture', stage: 'capture-image.begin', elapsedMs: 2 })
    f.stdout.emit('error', original)
    await f.waiting
    expect(reportDiagnostic.mock.calls.flat().join('\n')).not.toContain('host.settled')
    f.gone.reject(closeFailure)
    f.done.resolve()
    const failure = await result
    if (!(failure instanceof AggregateError)) throw new Error('Both native and close failures must remain available')
    expect(failure.errors).toEqual([original, closeFailure])
    expect(failure.cause).toBe(original)
    if (kind === 'request') {
      expect(original.message).toContain('capture-image.begin')
      expect(reportDiagnostic.mock.calls.flat().join('\n')).toContain('host.settled')
    }
    expect(f.stdout.destroyed).toBe(true)
    expect(f.stdin.destroyed).toBe(true)
  })

  it('reports the native and close failures with screenshot diagnostics through the tool pipeline', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    ctx.tools.setExecutor(new NativeToolExecutor(ctx))
    const f = fixture()
    ctx.tools.register(defineTool({ name: 'capture_fixture', description: 'Capture the fixture window.', parameters: {},
      output: { schema: { type: 'json' }, render: () => [] },
      execute: async (_args, execution) => f.client.request('screenshot', {}, execution.signal, execution.callId),
    }))
    const running = ctx.tools.execute({ calls: [{ type: 'tool-call', name: 'capture_fixture', id: brandString<ToolCallId>('pipeline-capture'), arguments: '{}' }],
      signal: new AbortController().signal,
    })
    await expect.poll(() => f.requests.length).toBe(1)
    f.reply({ type: 'diagnostic', requestId: 'pipeline-capture', stage: 'capture-image.begin', elapsedMs: 2 })
    f.stdout.emit('error', new NativeError('NATIVE_IO', 'original connection failure'))
    await f.waiting
    f.gone.reject(new Error('connection close acknowledgement failed'))
    f.done.resolve()
    const result = (await running).results[0]?.result
    expect(result?.isError).toBe(true)
    const text = result?.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    expect(text).toContain('NATIVE_IO: original connection failure')
    expect(text).toContain('connection close acknowledgement failed')
    expect(text).toContain('capture-image.begin')
  })

  it('shares an aggregated cleanup failure with disposal without repeating its close failure', async () => {
    const f = fixture()
    const original = new NativeError('NATIVE_IO', 'cleanup dispatch failed')
    const closeFailure = new Error('transport close failed')
    let cleanup: Promise<void> | undefined
    const release = (): Promise<void> => cleanup ??= f.client.requestCleanup('releaseHeldKeys', { runId: 'shared-failure' }).then(() => undefined)
    f.client.registerCleanup(() => release())
    const pending = release()
    const closing = f.client.dispose()
    const results = Promise.allSettled([pending, closing])
    f.stdout.emit('error', original)
    await f.waiting
    f.gone.reject(closeFailure)
    f.done.resolve()
    const [first, second] = await results
    if (first?.status !== 'rejected' || second?.status !== 'rejected') throw new Error('Both callers must receive cleanup failure')
    const failure: unknown = first.reason
    if (!(failure instanceof AggregateError)) throw new Error('Both native and close failures must remain available')
    expect(failure.errors).toEqual([original, closeFailure])
    expect(failure.cause).toBe(original)
    expect(second.reason).toBe(failure)
    expect(f.close).toHaveBeenCalledTimes(1)
    expect(f.waitForClose).toHaveBeenCalledTimes(1)
  })

  it('runs local cleanup after immediate invalidation without another native write', async () => {
    const f = fixture()
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const modes: boolean[] = []
    f.client.registerCleanup(async (canRequest) => { modes.push(canRequest); entered.resolve() })
    f.client.invalidate()
    expect(f.close).toHaveBeenCalledTimes(1)
    const closing = f.client.dispose()
    await entered.promise
    expect(modes).toEqual([false])
    expect(f.requests).toEqual([])
    f.finish()
    await closing
    await expect(f.client.requestCleanup('releaseHeldKeys', {})).rejects.toMatchObject({ code: 'NATIVE_DISPOSED' })
    expect(f.requests).toEqual([])
  })

  it.each(['same', 'additional'] as const)('retains a native failure when registered cleanup reports the %s failure', async (kind) => {
    const f = fixture()
    const original = new NativeError('NATIVE_IO', 'transport failed')
    const local = new Error('local resource cleanup failed')
    const combined = kind === 'same' ? original : new AggregateError([original, local], 'Resource cleanup failed')
    f.client.registerCleanup(async () => { throw combined })
    const pending = f.client.request('getState', {}, new AbortController().signal)
    const rejected = expect(pending).rejects.toBe(combined)
    f.stdout.emit('error', original)
    await f.waiting
    f.finish()
    await rejected
  })

  it('settles queued cleanup registrations without another write after a native refusal', async () => {
    const f = fixture()
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const settled: string[] = []
    for (const runId of ['first', 'second']) f.client.registerCleanup(async () => {
      const request = f.client.requestCleanup('releaseHeldKeys', { runId })
      if (runId === 'first') entered.resolve()
      try { await request } finally { settled.push(runId) }
    })
    const closing = f.client.dispose()
    const rejected = expect(closing).rejects.toMatchObject({ code: 'RELEASE_REFUSED' })
    await entered.promise
    f.reply({ id: f.id(), error: { code: 'RELEASE_REFUSED', message: 'first release failed' } })
    expect(f.close).toHaveBeenCalledTimes(1)
    f.finish()
    await rejected
    expect(f.requests.map(request => request.params.runId)).toEqual(['first'])
    expect(settled.toSorted()).toEqual(['first', 'second'])
  })

  it('submits the screenshot before a diagnostic sink can synchronously cancel it', async () => {
    const controller = new AbortController()
    const f = fixture({ reportDiagnostic: (message) => {
      if (message.includes('host.dispatch')) controller.abort()
    } })
    const pending = f.client.request('screenshot', {}, controller.signal)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'NATIVE_CANCELLED' })
    expect(f.frames.map(frame => 'type' in frame ? 'cancel' : frame.method)).toEqual(['screenshot', 'cancel'])
    f.reply({ id: f.id(), error: { code: 'NATIVE_CANCELLED', message: 'capture stopped' } })
    await rejected
    expect(f.close).not.toHaveBeenCalled()
  })

  it('passes transport limits and connection deadlines to the shared channel', () => {
    const f = fixture({ maxRequestBytes: 4096, maxResponseBytes: 8192, timeoutMs: 1234 })
    expect(f.connect).toHaveBeenCalledExactlyOnceWith(f.owner, f.config)
  })

  it('uses the logged tool invocation ID for the native request and its matching reply', async () => {
    const f = fixture()
    const pending = f.client.request('activate', { appHandle: 'app-one' }, new AbortController().signal, brandString<ToolCallId>('foreground-call'))
    expect(f.id()).toBe('foreground-call')
    f.reply({ id: 'foreground-call', result: { dispatched: true } })
    await expect(pending).resolves.toEqual({ dispatched: true })
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
    const rejected = f.client.request('click', {}, AbortSignal.abort())
    await expect(rejected).rejects.toBeInstanceOf(HarnessError)
    await expect(rejected).rejects.toMatchObject({ name: 'NativeError', code: 'NATIVE_CANCELLED' })
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
      const rejected = pending.catch((error: unknown) => error)
      f.reply({ type: 'diagnostic', requestId: f.id(), stage: 'capture-image.begin', elapsedMs: 1 })
      await vi.advanceTimersByTimeAsync(25)
      expect(f.close).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(10)
      expect(f.close).toHaveBeenCalledTimes(1)
      f.finish()
      const failure = await rejected
      expect(failure).toMatchObject({ code: 'NATIVE_CLEANUP', cause: { code: 'NATIVE_TIMEOUT' } })
      if (!(failure instanceof NativeError) || !(failure.cause instanceof NativeError)) throw new Error('Cancellation cleanup must retain its native cause')
      expect(failure.message).toContain('capture-image.begin')
      expect(failure.cause.message).not.toContain('Screenshot diagnostics')
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

  it.each(['throw', 'callback', 'stdout', 'done'] as const)('preserves the platform startup diagnostic through %s', async (kind) => {
    const failure = new NativeError('NATIVE_STARTUP', 'Windows refused the helper; check application-control policy')
    const f = fixture(kind === 'callback' ? { writeError: failure } : {})
    if (kind === 'throw') vi.spyOn(f.stdin, 'write').mockImplementation(() => { throw failure })
    const pending = f.client.request('getCapabilities', {}, new AbortController().signal)
    const rejected = expect(pending).rejects.toBe(failure)
    if (kind === 'stdout') f.stdout.emit('error', failure)
    if (kind === 'done') f.done.reject(failure)
    await f.closed
    f.finish()
    await rejected
    expect(f.client.disposed).toBe(true)
  })

  it('rejects unsolicited replies and shares one quiescent disposal across callers', async () => {
    const f = fixture()
    f.reply({ id: 'unsolicited', result: [] })
    const first = f.client.dispose()
    const second = f.client.dispose()
    expect(second).toBe(first)
    await f.waiting
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
    const rejected = expect(pending).rejects.toMatchObject({ errors: [expect.objectContaining({ code: 'NATIVE_DISPOSED' }), failure] })
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
    expect(error).toBeInstanceOf(HarnessError)
    expect(error.name).toBe('NativeError')
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
      const pending = f.client.request('screenshot', {}, new AbortController().signal, brandString<ToolCallId>('capture-timeout'))
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
    const pending = f.client.request('screenshot', {}, new AbortController().signal, brandString<ToolCallId>('current'))
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
    const pending = f.client.request('screenshot', {}, new AbortController().signal, brandString<ToolCallId>('capture'))
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
