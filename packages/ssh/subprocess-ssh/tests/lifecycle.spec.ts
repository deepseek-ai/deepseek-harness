/** The provider joins unpublished terminal allocations before disposal completes. */
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SshSubprocessRuntime } from '../src/index.ts'

const id = 'a7b17d9c-5ebf-40d8-9e82-3d1ddae8517b'
const spec = { terminalType: 'dumb', argv: ['bash'], cwd: '/workspace', rows: 24, cols: 80, graceMs: 100 }

describe('SSH terminal allocation lifecycle', () => {
  it.each(['prepare', 'connect', 'start'])('joins a pending %s before completing provider disposal', async (stage) => {
    const ctx = new Context()
    const entered = Promise.withResolvers<undefined>()
    const continuation = Promise.withResolvers<undefined>()
    const finished = Promise.withResolvers<{ outcome: { exitCode: number; signal: null }; spills: object }>()
    const socket = new PassThrough()
    const calls: string[] = []
    const gate = async (name: string) => {
      if (name === stage) { entered.resolve(undefined); await continuation.promise }
    }
    ctx.provide('ssh', {
      request: vi.fn(async (method: string) => {
        calls.push(method)
        if (method === 'process.prepare') {
          await gate('prepare')
          return { id, streams: { terminal: { path: '/tmp/terminal', capability: '0'.repeat(64) } } }
        }
        if (method === 'process.start') { await gate('start'); return { pid: 123 } }
        if (method === 'process.done') return finished.promise
        if (method === 'process.terminate') {
          finished.resolve({ outcome: { exitCode: 0, signal: null }, spills: {} })
          return null
        }
        throw new Error(`Unexpected request ${method}`)
      }),
      connectStream: async () => { await gate('connect'); return socket },
      dispose: vi.fn(),
    } as never)
    const fiber = ctx.plugin(SshSubprocessRuntime)
    await fiber
    const runtime = ctx.subprocess
    const allocation = runtime.spawnTerminal(spec)
    const rejected = expect(allocation).rejects.toThrow('disposed')
    await entered.promise
    let disposed = false
    const disposal = fiber.dispose().then(() => { disposed = true })
    await Promise.resolve(undefined)
    expect(disposed).toBe(false)
    continuation.resolve(undefined)
    await rejected
    await disposal
    expect(calls).toContain('process.terminate')
    if (stage !== 'start') expect(calls).not.toContain('process.start')
    expect(socket.destroyed || stage === 'prepare').toBe(true)
    await expect(runtime.spawnTerminal(spec)).rejects.toThrow('disposed')
  })
})
