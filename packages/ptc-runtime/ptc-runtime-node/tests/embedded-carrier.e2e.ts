import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import { mountRuntime } from './setup.ts'

const runtimePath = process.env.DSH_PACKAGED_RUNTIME

describe.skipIf(runtimePath === undefined)('packaged embedded carrier', () => {
  it('retains state across evaluations through the packaged runtime', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-packaged-ptc-'))
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose(); await rm(cwd, { recursive: true, force: true }) })
    const { runtime } = await mountRuntime(ctx, {
      executionMode: 'persistent-in-memory',
      launch: { kind: 'embedded', executable: runtimePath as string },
    })
    const owner = {}
    const run = (program: string) =>
      runtime.run(runtime.resolve({ program, bindings: [], cwd, stateOwner: owner }))

    expect((await run('var retained = 40; retained')).value).toBe(40)
    expect((await run('retained += 2; retained')).value).toBe(42)
    // pkg exposes the packaged tree at this URL; the CUA provider prompt uses the same scheme.
    const bridge = await run('var bridge = await import("file:///snapshot/node/node_modules/@deepseek-ai/dsh-cua/lib/bridge.js"); typeof bridge.connectCua')
    expect(bridge.value).toBe('function')
    await runtime.release(owner)
    expect((await run('typeof retained')).value).toBe('undefined')
  }, 120_000)
})
