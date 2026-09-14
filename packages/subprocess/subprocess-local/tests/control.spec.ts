import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { SUBPROCESS_CONTROL_ENV } from '@deepseek-ai/dsh-subprocess/control'
import { LocalSubprocessRuntime } from '../src/index.ts'
import { spawnSubprocess } from '../src/spawn.ts'

const fixture = fileURLToPath(new URL('./fixtures/control-child.ts', import.meta.url))
const helper = fileURLToPath(new URL('../../subprocess/src/control.ts', import.meta.url))
let ctx: Context | undefined
let root: string | undefined
let handle: SubprocessHandle | undefined

afterEach(async () => {
  handle?.control?.destroy()
  handle?.terminate()
  await handle?.waitForExit()
  await ctx?.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  ctx = undefined
  root = undefined
  handle = undefined
})

describe('managed subprocess control pipe', () => {
  it('joins an exited range and disposes its paused control endpoint without draining it', async () => {
    ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    handle = ctx.subprocess.spawn({
      argv: [process.execPath, '--input-type=module', '-e',
        'import { Socket } from "node:net"; const c = new Socket({fd:7,readable:true,writable:true}); c.write(Buffer.alloc(4096),()=>c.destroy())'],
      cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 32 }, stderr: { maxBytes: 32 }, control: 'pipe' },
      graceMs: 1000,
    })
    const channel = handle.control
    if (channel === undefined) throw new Error('requested control pipe is absent')
    channel.pause()
    expect(await handle.done).toEqual({ exitCode: 0, signal: null })
    expect(channel.destroyed).toBe(false)
    expect(await handle.waitForExit(AbortSignal.timeout(10_000))).toBe(true)
    await ctx.fiber.dispose()
    expect(channel.destroyed).toBe(true)
    expect(channel.closed).toBe(true)
  }, 15_000)

  it('closes the caller endpoint when service disposal terminates an active program', async () => {
    ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    handle = ctx.subprocess.spawn({
      argv: [process.execPath, '--input-type=module', '-e',
        'import { Socket } from "node:net"; const c = new Socket({fd:7,readable:true,writable:true}); c.write("ready"); setInterval(()=>{},60000)'],
      cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 32 }, stderr: { maxBytes: 32 }, control: 'pipe' },
      graceMs: 1000,
    })
    const channel = handle.control
    if (channel === undefined) throw new Error('requested control pipe is absent')
    await once(channel, 'data')
    await ctx.fiber.dispose()
    expect(channel.destroyed).toBe(true)
    expect(await handle.waitForExit()).toBe(true)
  })

  it('leaves the channel absent on an ordinary spawn', async () => {
    ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    handle = ctx.subprocess.spawn({
      argv: [process.execPath, '-e', 'process.stdout.write("plain")'],
      cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 32 }, stderr: { maxBytes: 32 } },
      graceMs: 1000,
    })
    expect(handle.control).toBeUndefined()
    expect(await handle.done).toEqual({ exitCode: 0, signal: null })
    expect(handle.collected.stdout?.readFrom(0).text).toBe('plain')
    expect(await handle.waitForExit()).toBe(true)
  })

  it.each(['managed', 'fallback'] as const)('returns exact binary control bytes through %s independently of stdio', async (backend) => {
    root = await mkdtemp(join(tmpdir(), 'dsh-control-'))
    ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    const input = Buffer.alloc(256 * 1024)
    for (let index = 0; index < input.length; index++) input[index] = index % 256
    const request: SubprocessSpawnSpec = {
      argv: [process.execPath, fixture, helper, String(input.length)],
      cwd: root,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 }, control: 'pipe' },
      graceMs: 1000,
    }
    handle = backend === 'managed' ? ctx.subprocess.spawn(request) : spawnSubprocess(request)
    const channel = handle.control
    if (channel === undefined) throw new Error('requested control pipe is absent')
    const received = (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of channel) chunks.push(Buffer.from(chunk as Uint8Array))
      return Buffer.concat(chunks)
    })()
    channel.write(input)
    expect(await received).toEqual(input)
    expect(await handle.done).toEqual({ exitCode: 0, signal: null })
    expect(handle.collected.stdout?.readFrom(0).text).toBe('ordinary stdout\n')
    expect(handle.collected.stderr?.readFrom(0).text).toBe('ordinary stderr\n')
    expect(await handle.waitForExit()).toBe(true)
  })

  it('rejects a caller-authored control marker before starting a child', async () => {
    ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    expect(() => ctx?.subprocess.spawn({
      argv: [process.execPath, '-e', 'throw new Error("must not execute")'],
      cwd: process.cwd(),
      env: { [SUBPROCESS_CONTROL_ENV]: 'pipe' },
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 1000,
    })).toThrow('reserved')
  })
})
