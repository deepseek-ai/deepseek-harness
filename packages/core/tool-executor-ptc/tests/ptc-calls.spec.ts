import { Context } from '@deepseek-ai/cordis'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SandboxPolicy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { expect, it, onTestFinished, vi } from 'vitest'
import { PtcCalls } from '../src/ptc-calls.ts'

async function setup() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(Sessions)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write' })
  const session = ctx.sessions.create(SessionId('ptc-calls'))
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
    setSandboxMode(ctx.sessions.create(SessionId('another')), 'read-only')
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
  } finally { cleanup.resolve(undefined); await first; await disposed }
})
