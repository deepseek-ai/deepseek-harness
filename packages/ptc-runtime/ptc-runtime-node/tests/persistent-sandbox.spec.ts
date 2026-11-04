import { AsyncLocalStorage } from 'node:async_hooks'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { realpathSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Context } from '@deepseek-ai/cordis'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import { expect, it, onTestFinished, vi } from 'vitest'
import { mountRuntime } from './setup.ts'
import type { Config } from '../src/index.ts'

async function setup(mode: 'read-only' | 'workspace-write' = 'read-only', executionMode: NonNullable<Config['executionMode']> = 'persistent-in-memory') {
  const root = realpathSync.native(await mkdtemp(join(homedir(), '.dsh-persistent-sandbox-')))
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const { runtime } = await mountRuntime(ctx, { executionMode, scriptPersistence: executionMode === 'vm-script' }, { mode, workspaceRoot: cwd })
  const owner = {}
  const run = (program: string) => runtime.run(runtime.resolve({ program, bindings: [], stateOwner: owner }))
  return { root, cwd, ctx, runtime, owner, run }
}

it('retains variables under read-only confinement and denies writes across calls', async () => {
  const { cwd, run } = await setup()
  expect((await run('const fsp = await import("node:fs/promises"); var count = 1;')).error).toBeUndefined()
  expect((await run('++count')).value).toBe(2)
  const result = await run('await fsp.writeFile("denied.txt", String(count))')
  expect(result.sandbox).toMatchObject({ mode: 'read-only', denied: true })
  await expect(readFile(join(cwd, 'denied.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await run('count')).value).toBe(2)
})

it('retains workspace write access while refusing a sibling path', async () => {
  const { root, cwd, run } = await setup('workspace-write')
  expect((await run('const fsp = await import("node:fs/promises"); await fsp.writeFile("inside.txt", "allowed")')).error).toBeUndefined()
  const result = await run(`await fsp.writeFile(${JSON.stringify(join(root, 'outside.txt'))}, "denied")`)
  expect(result.sandbox).toMatchObject({ mode: 'workspace-write', denied: true })
  expect(await readFile(join(cwd, 'inside.txt'), 'utf8')).toBe('allowed')
  await expect(readFile(join(root, 'outside.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('refuses reuse under another policy until the owner has been released', async () => {
  const { cwd, runtime, owner, run } = await setup()
  expect((await run('var retained = 42;')).error).toBeUndefined()
  const spec = runtime.resolve({ program: 'typeof retained', bindings: [], stateOwner: owner, sandboxPolicy: { mode: 'workspace-write', workspaceRoot: cwd } })
  await expect(runtime.run(spec)).rejects.toThrow('release the retained environment')
  await runtime.release(owner)
  expect((await runtime.run(spec)).value).toBe('undefined')
})

// Windows ACL rejects additional roots; its refusal is covered by sandbox-local's runner tests.
it.skipIf(process.platform === 'win32').each(['persistent-in-memory', 'vm-script'] as const)('keeps %s directory grants until the retained process is released', async (executionMode) => {
  const { root, cwd, runtime, owner } = await setup('workspace-write', executionMode)
  const extra = join(root, 'extra')
  await mkdir(extra)
  const target = join(extra, 'memory.txt')
  const roots = [extra]
  const policy = { mode: 'workspace-write' as const, workspaceRoot: cwd, additionalWritableRoots: roots }
  const write = (content: string, additionalWritableRoots: readonly string[] = []) => runtime.run(runtime.resolve({
    program: `await (await import("node:fs/promises")).writeFile(${JSON.stringify(target)}, ${JSON.stringify(content)})`,
    bindings: [],
    stateOwner: owner,
    sandboxPolicy: { ...policy, additionalWritableRoots },
  }))

  expect((await write('initial', roots)).error).toBeUndefined()
  roots[0] = cwd
  expect((await write('retained')).error).toBeUndefined()
  expect(await readFile(target, 'utf8')).toBe('retained')

  await runtime.release(owner)
  expect((await write('denied')).sandbox).toMatchObject({ mode: 'workspace-write', denied: true })
  expect((await write('still denied', [extra])).sandbox).toMatchObject({ mode: 'workspace-write', denied: true })
  expect(await readFile(target, 'utf8')).toBe('retained')

  await runtime.release(owner)
  expect((await write('renewed', [extra])).error).toBeUndefined()
  expect(await readFile(target, 'utf8')).toBe('renewed')
})

// Windows ACL rejects additional roots before launching a process.
it.skipIf(process.platform === 'win32').each([
  { executionMode: 'persistent-in-memory', change: 'add' },
  { executionMode: 'persistent-in-memory', change: 'remove' },
  { executionMode: 'vm-script', change: 'add' },
  { executionMode: 'vm-script', change: 'remove' },
] as const)('uses current grants for the first $executionMode process after a syntax error and grant $change', async ({ executionMode, change }) => {
  const { root, cwd, ctx, runtime, owner } = await setup('workspace-write', executionMode)
  const extra = join(root, 'extra')
  await mkdir(extra)
  const target = join(extra, 'memory.txt')
  const session = ctx.sessions.create(SessionId('first-launch-grants'), { meta: { cwd } })
  const request = { bindings: [], stateOwner: owner }
  const remove = change === 'remove' ? ctx.sandboxPolicy.registerWritableRoot(session, extra) : undefined
  const spawn = vi.spyOn(ctx.subprocess, 'spawn')
  onTestFinished(() => { spawn.mockRestore() })
  expect((await runtime.run(runtime.resolve({
    ...request, program: 'const =', sandboxPolicy: ctx.sandboxPolicy.resolve({ session }),
  }))).error?.kind).toBe('exception')
  expect(spawn).not.toHaveBeenCalled()
  if (change === 'add') ctx.sandboxPolicy.registerWritableRoot(session, extra)
  else remove?.()

  const result = await runtime.run(runtime.resolve({
    ...request, sandboxPolicy: ctx.sandboxPolicy.resolve({ session }),
    program: `await (await import("node:fs/promises")).writeFile(${JSON.stringify(target)}, "memory")`,
  }))
  expect(spawn).toHaveBeenCalledTimes(1)
  if (change === 'add') {
    expect(result.error).toBeUndefined()
    expect(await readFile(target, 'utf8')).toBe('memory')
  } else {
    expect(result.sandbox).toMatchObject({ mode: 'workspace-write', denied: true })
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  }
})

it('fails closed when confinement is unavailable without spawning Node', async () => {
  const { ctx, run } = await setup()
  const confine = vi.spyOn(ctx.sandbox, 'confine').mockRejectedValue(new SandboxUnavailableError('read-only'))
  const spawn = vi.spyOn(ctx.subprocess, 'spawn')
  onTestFinished(() => { confine.mockRestore(); spawn.mockRestore() })
  expect((await run('42')).error?.kind).toBe('sandbox-unavailable')
  expect(spawn).not.toHaveBeenCalled()
})

it('cancels a pending confinement operation before spawning', async () => {
  const { ctx, runtime, owner } = await setup()
  const entered = Promise.withResolvers<undefined>()
  const confinement = Promise.withResolvers<Awaited<ReturnType<typeof ctx.sandbox.confine>>>()
  const confine = vi.spyOn(ctx.sandbox, 'confine').mockImplementation(() => { entered.resolve(undefined); return confinement.promise })
  const spawn = vi.spyOn(ctx.subprocess, 'spawn')
  const controller = new AbortController()
  const pending = runtime.run(runtime.resolve({ program: '42', bindings: [], stateOwner: owner, signal: controller.signal }))
  try {
    await entered.promise
    controller.abort()
    confinement.resolve({ argv: ['unused'], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] })
    expect((await pending).error?.kind).toBe('abort')
    expect(spawn).not.toHaveBeenCalled()
  } finally {
    confinement.resolve({ argv: ['unused'], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] })
    await pending
    confine.mockRestore()
    spawn.mockRestore()
  }
})

it('clears a registered live REPL through the file-policy setter before starting under the new mode', async () => {
  const { ctx, cwd, runtime, owner } = await setup('workspace-write')
  const session = ctx.sessions.create(SessionId('retained-policy-change'), { meta: { cwd } })
  const run = (program: string) => runtime.run(runtime.resolve({
    program, bindings: [], stateOwner: owner, sandboxPolicy: ctx.sandboxPolicy.resolve({ session }),
  }))
  const spawn = vi.spyOn(ctx.subprocess, 'spawn')
  onTestFinished(() => { spawn.mockRestore() })
  expect((await run('const retained = 7; retained')).value).toBe(7)
  const started = spawn.mock.results[0]
  if (started?.type !== 'return') throw new Error('the retained process did not start')
  setSandboxMode(session, 'read-only')
  await started.value.done
  expect((await run('typeof retained')).value).toBe('undefined')
  const denied = await run('await (await import("node:fs/promises")).writeFile("denied-after-switch.txt", "denied")')
  expect(denied.sandbox).toMatchObject({ mode: 'read-only', denied: true })
  await expect(readFile(join(cwd, 'denied-after-switch.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('keeps a one-shot wider policy separate from standing variables and subsequent writes', async () => {
  const { ctx, cwd, runtime, owner } = await setup()
  const session = ctx.sessions.create(SessionId('temporary-policy'), { meta: { cwd } })
  const standing = ctx.sandboxPolicy.resolve({ session })
  const run = (program: string) => runtime.run(runtime.resolve({ program, bindings: [], stateOwner: owner, sandboxPolicy: standing }))
  expect((await run('const retained = 7; retained')).value).toBe(7)
  const result = await runtime.run(runtime.resolve({
    program: 'const temporary = 9; await (await import("node:fs/promises")).writeFile("elevated.txt", typeof retained); temporary',
    bindings: [], sandboxPolicy: { ...standing, mode: 'danger-full-access' },
  }))
  expect(result.value).toBe(9)
  expect(await readFile(join(cwd, 'elevated.txt'), 'utf8')).toBe('undefined')
  expect((await run('({ retained, temporary: typeof temporary })')).value).toEqual({ retained: 7, temporary: 'undefined' })
  expect((await run('await (await import("node:fs/promises")).writeFile("denied.txt", "denied")')).sandbox?.denied).toBe(true)
  await expect(readFile(join(cwd, 'denied.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(ctx.sandboxPolicy.resolve({ session }).mode).toBe('read-only')
})

it('preserves the current execution context for bindings in a reused REPL', async () => {
  const { ctx, cwd, runtime, owner } = await setup('workspace-write')
  const session = ctx.sessions.create(SessionId('binding-context'), { meta: { cwd } })
  const context = new AsyncLocalStorage<string>()
  const run = (program: string) => runtime.run(runtime.resolve({ program, stateOwner: owner,
    sandboxPolicy: ctx.sandboxPolicy.resolve({ session }),
    bindings: [{ global: 'tools', functions: { current: async () => context.getStore() ?? null } }],
  }))
  expect((await context.run('first', () => run('var retained = await tools.current({}); retained'))).value).toBe('first')
  expect((await context.run('second', () => run('await tools.current({})'))).value).toBe('second')
})

it.each(['per-call', 'persistent-in-memory'] as const)('cancels active %s execution after a synchronous policy change', async (executionMode) => {
  const { ctx, cwd, runtime, owner } = await setup('workspace-write', executionMode)
  const session = ctx.sessions.create(SessionId(`active-${executionMode}`), { meta: { cwd } })
  const entered = Promise.withResolvers<undefined>()
  const pending = runtime.run(runtime.resolve({ program: 'await tools.ready({}); await new Promise(() => {})',
    stateOwner: owner, sandboxPolicy: ctx.sandboxPolicy.resolve({ session }),
    bindings: [{ global: 'tools', functions: { ready: async () => { entered.resolve(undefined); return null } } }],
  }))
  await entered.promise
  setSandboxMode(session, 'read-only')
  expect(ctx.sandboxPolicy.resolve({ session }).mode).toBe('read-only')
  expect((await pending).error?.kind).toBe('abort')
})
