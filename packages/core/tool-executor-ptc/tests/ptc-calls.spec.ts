import { Context } from '@deepseek-ai/cordis'
import Sessions, { type SessionId } from '@deepseek-ai/dsh-session'
import SandboxPolicy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { expect, it, onTestFinished, vi } from 'vitest'
import { PtcCalls } from '../src/ptc-calls.ts'
import { CodeRunFailedError } from '../src/errors.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

async function setup() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(Sessions)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write' })
  const session = ctx.sessions.create(brandString<SessionId>('ptc-calls'))
  const calls = new PtcCalls(ctx)
  const mode = () => ctx.sandboxPolicy.resolve({ session }).mode
  const signal = new AbortController().signal
  return { ctx, session, calls, mode, signal }
}

it('commits policy immediately, cancels existing calls, and waits for their complete cleanup before reading the latest mode', async () => {
  const { ctx, session, calls, mode, signal } = await setup()
  const cleanup = Promise.withResolvers<undefined>()
  let oldSignal: AbortSignal | undefined
  const first = calls.run(session.id, signal, mode, async (current) => { oldSignal = current; await cleanup.promise })
  const next = vi.fn(async () => mode())
  try {
    session.append('turn/start', { turn: 1 })
    setSandboxMode(ctx.sessions.create(brandString<SessionId>('another')), 'read-only')
    setSandboxMode(session, 'workspace-write')
    expect(oldSignal?.aborted).toBe(false)
    setSandboxMode(session, 'read-only')
    expect(mode()).toBe('read-only')
    expect(oldSignal?.aborted).toBe(true)
    const second = calls.run(session.id, signal, mode, next)
    expect(next).not.toHaveBeenCalled()
    setSandboxMode(session, 'danger-full-access')
    cleanup.resolve(undefined)
    await first
    expect(await second).toBe('danger-full-access')
  } finally { cleanup.resolve(undefined); await first }
})

it('releases failed calls and allows same-policy calls to overlap', async () => {
  const { session, calls, mode, signal } = await setup()
  const cleanup = Promise.withResolvers<undefined>()
  const first = calls.run(session.id, signal, mode, () => cleanup.promise)
  try {
    await expect(calls.run(session.id, signal, mode, async () => { throw new Error('failed call') })).rejects.toThrow('failed call')
    expect(await calls.run(session.id, signal, mode, async () => 'next')).toBe('next')
  } finally { cleanup.resolve(undefined); await first }
})

it('honors cancellation while waiting for a canceled predecessor', async () => {
  const { session, calls, mode, signal } = await setup()
  const cleanup = Promise.withResolvers<undefined>()
  const first = calls.run(session.id, signal, mode, () => cleanup.promise)
  setSandboxMode(session, 'read-only')
  const controller = new AbortController()
  const next = vi.fn(async () => 'unexpected')
  const second = calls.run(session.id, controller.signal, mode, next)
  const rejected = expect(second).rejects.toThrow('caller canceled')
  controller.abort(new Error('caller canceled'))
  cleanup.resolve(undefined)
  await first
  await rejected
  expect(next).not.toHaveBeenCalled()
})

it('unloads the executor only after calls stop and refuses late admission', async () => {
  const { ctx, session, calls, mode, signal } = await setup()
  const cleanup = Promise.withResolvers<undefined>()
  const stopped = Promise.withResolvers<undefined>()
  const first = calls.run(session.id, signal, mode, async (current) => {
    current.addEventListener('abort', () => { stopped.resolve(undefined) }, { once: true })
    await cleanup.promise
  })
  const disposed = ctx.fiber.dispose()
  try {
    await stopped.promise
    const next = calls.run(session.id, signal, mode, async () => 'unexpected')
    const rejected = expect(next).rejects.toThrow('PTC tool executor disposed')
    cleanup.resolve(undefined)
    await first
    await rejected
    await disposed
    await expect(calls.run(session.id, signal, mode, async () => 'unexpected')).rejects.toThrow('PTC tool executor disposed')
    await expect(calls.run(session.id, signal, mode, async () => 'unexpected')).rejects.toMatchObject({
      name: 'CodeRunFailedError', code: 'CODE_RUN_UNAVAILABLE',
    })
  } finally { cleanup.resolve(undefined); await first; await disposed }
})

it('resets from the host while a call is stuck and blocks admission until release and call cleanup finish', async () => {
  const { session, calls, signal } = await setup()
  const cleanup = Promise.withResolvers<undefined>()
  const releaseStarted = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  let activeSignal: AbortSignal | undefined
  const first = calls.run(session.id, signal, () => undefined, async (current) => { activeSignal = current; await cleanup.promise })
  const release = vi.fn(async () => { releaseStarted.resolve(undefined); await released.promise })
  const notify = vi.fn()
  const reset = calls.reset(session.id, release, notify)
  const nextBody = vi.fn(async () => { expect(notify).toHaveBeenCalledOnce(); return 'fresh' })
  const next = calls.run(session.id, signal, () => undefined, nextBody)
  try {
    expect(activeSignal?.aborted).toBe(true)
    expect(calls.reset(session.id, release)).toBe(reset)
    await releaseStarted.promise
    expect(nextBody).not.toHaveBeenCalled()
    expect(await calls.run(brandString<SessionId>('unrelated'), signal, () => undefined, async () => 'independent')).toBe('independent')
    released.resolve(undefined)
    await released.promise
    expect(nextBody).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    cleanup.resolve(undefined)
    await reset
    expect(await next).toBe('fresh')
    expect(release).toHaveBeenCalledTimes(1)
  } finally { cleanup.resolve(undefined); released.resolve(undefined); await Promise.all([first, reset, next]) }
})

it('waits for call cleanup after release fails and refuses code until an explicit reset retry succeeds', async () => {
  const { session, calls, mode, signal } = await setup()
  const cleanup = Promise.withResolvers<undefined>()
  const first = calls.run(session.id, signal, mode, () => cleanup.promise)
  const releaseFailed = Promise.withResolvers<undefined>()
  const reset = calls.reset(session.id, async () => { releaseFailed.resolve(undefined); throw new Error('release failed') })
  const rejection = expect(reset).rejects.toThrow('release failed')
  const nextBody = vi.fn(async () => 'unexpected')
  const next = calls.run(session.id, signal, mode, nextBody)
  const nextRejection = expect(next).rejects.toThrow('release failed')
  try {
    await releaseFailed.promise
    expect(nextBody).not.toHaveBeenCalled()
    cleanup.resolve(undefined)
    await Promise.all([first, rejection, nextRejection])
    await expect(calls.run(session.id, signal, mode, nextBody)).rejects.toThrow(CodeRunFailedError)
    await expect(calls.run(session.id, signal, mode, nextBody)).rejects.toThrow('Ask the host to reset it before running more code')
    expect(nextBody).not.toHaveBeenCalled()
    await calls.reset(session.id, async () => {})
    expect(await calls.run(session.id, signal, mode, async () => 'fresh')).toBe('fresh')
  } finally { cleanup.resolve(undefined); await Promise.allSettled([first, reset, next]) }
})

it('keeps admission blocked if the reset notice cannot be queued', async () => {
  const { session, calls, mode, signal } = await setup()
  await expect(calls.reset(session.id, async () => {}, () => { throw new Error('notice failed') })).rejects.toThrow('notice failed')
  const next = vi.fn(async () => 'fresh')
  await expect(calls.run(session.id, signal, mode, next)).rejects.toThrow('Ask the host to reset it before running more code')
  expect(next).not.toHaveBeenCalled()
  await calls.reset(session.id, async () => {})
  expect(await calls.run(session.id, signal, mode, next)).toBe('fresh')
})

it('waits for an idle reset during executor disposal and refuses further resets', async () => {
  const { ctx, session, calls } = await setup()
  const disposedSignal = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const started = Promise.withResolvers<undefined>()
  const reset = calls.reset(session.id, async () => { started.resolve(undefined); await release.promise })
  await started.promise
  const active = calls.run(brandString<SessionId>('disposal-observer'), new AbortController().signal, () => undefined, async (signal) => {
    signal.addEventListener('abort', () => { disposedSignal.resolve(undefined) }, { once: true })
    await disposedSignal.promise
  })
  const disposed = ctx.fiber.dispose()
  try {
    await disposedSignal.promise
    await expect(calls.reset(session.id, async () => {})).rejects.toThrow('PTC tool executor disposed')
  } finally { release.resolve(undefined); await reset; await active; await disposed }
})


it('waits for externally canceled calls to finish cleanup before admitting their successor', async () => {
  const { session, calls, mode, signal } = await setup()
  const controller = new AbortController()
  const cleanup: PromiseWithResolvers<void> = Promise.withResolvers()
  const first = calls.run(session.id, controller.signal, mode, () => cleanup.promise)
  controller.abort(new Error('caller canceled'))
  const next = vi.fn(async () => 'next')
  const second = calls.run(session.id, signal, mode, next)
  try {
    expect(next).not.toHaveBeenCalled()
    cleanup.resolve()
    await first
    expect(await second).toBe('next')
  } finally { cleanup.resolve(); await Promise.all([first, second]) }
})
