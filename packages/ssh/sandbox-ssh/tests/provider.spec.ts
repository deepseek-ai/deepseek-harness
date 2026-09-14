/** Each confinement request resolves remotely before any subprocess receives its argv. */
import { Context, Service } from '@deepseek-ai/cordis'
import { SandboxUnavailableError, type SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { SshSandboxProvider } from '../src/index.ts'

const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: '/remote/link/..' }
const completeFacts = {
  argv: ['/usr/bin/bwrap', '--', 'true'], enforcement: 'full', denialSignatures: ['EROFS', 'EACCES'],
  runnerFailureRules: [{ allowedExitCodes: [1], fatalSignatures: ['bwrap:'], informationalLines: ['notice'] }],
}

async function setup(raw: unknown = completeFacts) {
  const dispatch = vi.fn(async (_method: string, _params: unknown, _signal?: AbortSignal) => raw)
  class Connection extends Service {
    constructor(ctx: Context) { super(ctx, 'ssh') }
    async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
      return result.parse(await dispatch(method, params, signal))
    }
  }
  const ctx = new Context()
  const connection = await ctx.plugin(Connection)
  const fiber = await ctx.plugin(SshSandboxProvider)
  onTestFinished(async () => { await fiber.dispose(); await connection.dispose() })
  return { ctx, dispatch }
}

describe('SSH sandbox provider', () => {
  it('awaits remote policy resolution and returns the literal enforcing argv', async () => {
    const state = await setup()
    const result = Promise.withResolvers<typeof completeFacts>()
    state.dispatch.mockReturnValueOnce(result.promise)
    const argv = ['/usr/bin/node', '-e', 'console.log("shell $() ; quotes")']
    const controller = new AbortController()
    let settled = false
    const pending = state.ctx.sandbox.confine(argv, policy, controller.signal).then((value) => { settled = true; return value })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(state.dispatch).toHaveBeenCalledWith('sandbox', { argv, policy }, controller.signal)
    const response = { ...completeFacts, argv: ['/usr/bin/bwrap', '--', ...argv] }
    result.resolve(response)
    expect(await pending).toEqual(response)
  })

  it('obtains current backend facts for every execution policy', async () => {
    const state = await setup()
    expect((await state.ctx.sandbox.confine(['true'], policy)).enforcement).toBe('full')
    const partial = { ...completeFacts, argv: ['/opt/landlock', '--', 'true'], enforcement: 'partial', runnerFailureRules: [{ fatalSignatures: ['runner unavailable'] }] }
    state.dispatch.mockResolvedValueOnce(partial)
    expect(await state.ctx.sandbox.confine(['true'], { ...policy, mode: 'read-only' })).toEqual(partial)
    expect(state.dispatch).toHaveBeenCalledTimes(2)
  })

  it.each([null, { ...completeFacts, argv: [] }, { ...completeFacts, enforcement: 'unknown' }, { ...completeFacts, runnerFailureRules: [{ fatalSignatures: 1 }] }])(
    'refuses malformed backend observations before exposing argv', async (raw) => {
      const state = await setup(raw)
      await expect(state.ctx.sandbox.confine(['true'], policy)).rejects.toBeInstanceOf(SandboxUnavailableError)
      expect(state.dispatch).toHaveBeenCalledTimes(1)
    },
  )

  it.each([new Error('remote disconnected'), 'remote disconnected'])('reports unavailable confinement without fallback or replay', async (error) => {
    const state = await setup()
    state.dispatch.mockRejectedValueOnce(error)
    await expect(state.ctx.sandbox.confine(['true'], policy)).rejects.toMatchObject({ name: 'SandboxUnavailableError', code: 'SANDBOX_UNAVAILABLE' })
    expect(state.dispatch).toHaveBeenCalledTimes(1)
  })

  it('does not send an already-cancelled confinement request', async () => {
    const state = await setup()
    const reason = new Error('cancel before confinement')
    await expect(state.ctx.sandbox.confine(['true'], policy, AbortSignal.abort(reason))).rejects.toBe(reason)
    expect(state.dispatch).not.toHaveBeenCalled()
  })

  it('preserves cancellation while remote resolution is pending', async () => {
    const state = await setup()
    const controller = new AbortController()
    const reason = new Error('cancel during confinement')
    state.dispatch.mockImplementationOnce((_method, _params, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => { reject(reason) }, { once: true })
    }))
    const pending = state.ctx.sandbox.confine(['true'], policy, controller.signal)
    const rejected = expect(pending).rejects.toBe(reason)
    controller.abort(reason)
    await rejected
  })
})
