import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Message } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { ModsEngine } from '../src/engine.ts'
import type { OpContext } from '../src/engine.ts'
import { createHostOps, FS_MAX_BYTES, STORE_MAX_BYTES, toolCallResultOf } from '../src/host-ops.ts'
import type { AgentBinding } from '../src/host-ops.ts'
import type { LoadedMod } from '../src/chain.ts'
import { createToolNameAliases } from '../src/tool-names.ts'
import { messageOf, record, requireString, stringify } from '../src/values.ts'

/**
 * The host op table against bare and partially composed contexts: the error a
 * mod's call gets when a service is not composed, the input checks, and the
 * option branches the full-loop bridge tests do not reach.
 */

const dirs: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const mod: LoadedMod = { name: 'unit-mod', version: undefined, root: '/mods/unit-mod', options: {}, order: 0 }

function setup(ctx = new Context()) {
  contexts.push(ctx)
  const registrations = new Map<string, Set<() => void>>()
  const ops = createHostOps({
    ctx,
    aliases: createToolNameAliases(),
    processTimeoutMs: 5_000,
    registrations,
    callOrigins: new Map(),
    modCommands: new Set(),
    modTools: new Set(),
  })
  const engine = new ModsEngine<AgentBinding>({ ops: op => ops[op], stateKey: () => 's', budgetMs: 1000, catchBudgetMs: 100, report: () => {} })
  const context = (agent?: Agent): OpContext<AgentBinding> => ({ mod, binding: { agent }, signal: new AbortController().signal, engine })
  const call = (op: string, input: unknown, agent?: Agent): Promise<unknown> =>
    Promise.resolve().then(() => ops[op]?.(input, context(agent)))
  return { ctx, ops, engine, context, call, registrations }
}

/** The members of an Agent the host ops read; a real Agent is assignable to it, which is what the assertion below relies on. */
interface AgentFacts {
  readonly id: string
  readonly ctx: Context
  readonly options: { readonly model?: string }
  readonly session: {
    readonly id: string
    readonly header: { readonly id: string; readonly createdAt: number; readonly cwd?: string }
    requestHeader(): { readonly config: { readonly provider: string; readonly model: string } } | undefined
    deriveMessages(): Message[]
  }
}

/** A fake agent with the session facts the ops read; its scoped ctx is the root ctx. */
function fakeAgent(ctx: Context, overrides: { cwd?: string; model?: string; requestModel?: string } = {}): Agent {
  const facts: AgentFacts = {
    id: 'fake',
    ctx,
    options: overrides.model === undefined ? {} : { model: overrides.model },
    session: {
      id: 'fake',
      header: { id: 'fake', createdAt: 1, ...overrides.cwd === undefined ? {} : { cwd: overrides.cwd } },
      requestHeader: () => overrides.requestModel === undefined ? undefined : { config: { provider: 'p', model: overrides.requestModel } },
      deriveMessages: (): Message[] => [],
    },
  }
  return facts as Agent
}

describe('values', () => {
  it('reads records, requires strings, words errors, and encodes JSON', () => {
    expect(record({ a: 1 })).toEqual({ a: 1 })
    expect(record('x')).toEqual({})
    expect(record(null)).toEqual({})
    expect(requireString('ok', 'f')).toBe('ok')
    expect(() => requireString(1, 'the field')).toThrow('the field must be a string')
    expect(messageOf(new Error('e'))).toBe('e')
    expect(messageOf('plain')).toBe('plain')
    expect(stringify({ a: 1 })).toBe('{"a":1}')
    expect(stringify(undefined)).toBeUndefined()
    expect(toolCallResultOf({ isError: false, value: null, content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toEqual({ result: 'ab' })
    expect(toolCallResultOf({ isError: true, error: { message: 'x' }, content: [{ type: 'text', text: 'Error: x' }] })).toEqual({ result: 'Error: x', isError: true })
  })
})

describe('services a deployment did not compose', () => {
  it('names the missing service in each call', async () => {
    const { call, ctx } = setup()
    const agent = fakeAgent(ctx)
    await expect(call('ui.ask', { question: 'q' }, agent)).rejects.toThrow(/dsh-user-questions/)
    await expect(call('command.register', { name: 'x', description: 'd' }, agent)).rejects.toThrow(/dsh-commands/)
    await expect(call('command.run', { command: 'x' }, agent)).rejects.toThrow(/dsh-commands/)
    await expect(call('command.list', {}, agent)).resolves.toEqual([])
    await expect(call('tool.register', { name: 'x', description: 'd' }, agent)).rejects.toThrow(/dsh-tools/)
    await expect(call('tool.call', { tool: 'x' }, agent)).rejects.toThrow(/dsh-tools/)
    await expect(call('tool.list', {}, agent)).resolves.toEqual([])
    await expect(call('tool.list', {})).resolves.toEqual([])
    await expect(call('store.get', { key: 'k' })).rejects.toThrow(/dsh-storage-domain/)
    await expect(call('fs.read', { path: 'x' })).rejects.toThrow(/dsh-fs/)
    await expect(call('process.run', { argv: ['ls'] })).rejects.toThrow(/dsh-subprocess/)
    await expect(call('session.turns', {}, agent)).rejects.toThrow(/turnBoundary projection/)
    // Without a drawn surface the ui calls that would redraw the band are plain no-ops.
    await expect(call('ui.invalidate', {}, agent)).resolves.toBeUndefined()
    await expect(call('ui.invalidate', {})).resolves.toBeUndefined()
    await expect(call('ui.open', { id: 'p' }, agent)).resolves.toMatchObject({ id: 'p', isPlaced: false })
    await expect(call('ui.close', { id: 'p' }, agent)).resolves.toBeUndefined()
    expect(await call('session.usage', {}, agent)).toEqual({ startedAt: 1, context: { window: 0 }, rateLimits: [] })
  })

  it('requires a session for session-bound calls and validates mod input', async () => {
    const { call } = setup()
    for (const op of ['ui.ask', 'command.run', 'command.list', 'prompt.submit', 'session.id', 'session.cwd', 'session.root', 'session.model', 'session.turns', 'session.messages', 'session.usage']) {
      await expect(call(op, {})).rejects.toThrow(`$.${op} needs a session, and this event has none`)
    }
    await expect(call('ui.log', { text: 1, to: 'transcript' })).rejects.toThrow('$.ui.log text must be a string')
    await expect(call('ui.toast', {})).rejects.toThrow('$.ui.toast text must be a string')
    await expect(call('ui.status', { text: 2 })).rejects.toThrow('$.ui.status text must be a string')
    await expect(call('env.set', { name: 'X', value: 1 })).rejects.toThrow('$.env.set value must be a string')
    await expect(call('http.fetch', {})).rejects.toThrow('$.http.fetch url must be a string')
  })
})

describe('session facts from the agent', () => {
  it('falls back from the logged route to the agent option to an empty model, and from the session cwd to the process cwd', async () => {
    const { call, ctx } = setup()
    expect(await call('session.model', {}, fakeAgent(ctx, { requestModel: 'logged', model: 'opt' }))).toBe('logged')
    expect(await call('session.model', {}, fakeAgent(ctx, { model: 'opt' }))).toBe('opt')
    expect(await call('session.model', {}, fakeAgent(ctx))).toBe('')
    expect(await call('session.cwd', {}, fakeAgent(ctx))).toBe(process.cwd())
    expect(await call('session.cwd', {}, fakeAgent(ctx, { cwd: '/work' }))).toBe('/work')
    expect(await call('session.root', {}, fakeAgent(ctx))).toBe(process.cwd())
    expect(await call('session.root', {}, fakeAgent(ctx, { cwd: '/work' }))).toBe('/work')
    expect(await call('session.id', {}, fakeAgent(ctx))).toBe('fake')
    expect(await call('session.messages', {}, fakeAgent(ctx))).toEqual([])
  })
})

describe('files through the filesystem seam', () => {
  it('resolves against the session cwd or the filesystem cwd, enforces the size limits, and reports links', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cc-mods-fs-'))
    dirs.push(root)
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: root })
    const { call } = setup(ctx)
    writeFileSync(join(root, 'small.txt'), 'small')
    writeFileSync(join(root, 'big.txt'), Buffer.alloc(FS_MAX_BYTES + 1, 97))
    symlinkSync(join(root, 'small.txt'), join(root, 'link.txt'))
    symlinkSync(join(root, 'gone.txt'), join(root, 'dangling.txt'))
    expect(await call('fs.read', { path: 'small.txt' })).toBe('small')
    expect(await call('fs.read', { path: 'small.txt' }, fakeAgent(ctx, { cwd: root }))).toBe('small')
    await expect(call('fs.read', { path: 'big.txt' })).rejects.toThrow(/larger than/)
    await expect(call('fs.write', { path: 'out.txt', text: 'x'.repeat(FS_MAX_BYTES + 1) })).rejects.toThrow(/larger than/)
    await expect(call('fs.write', { path: 1, text: 'x' })).rejects.toThrow('$.fs.write path must be a string')
    expect(await call('fs.stat', { path: 'link.txt' })).toEqual({ kind: 'file', size: 5, mtimeMs: 0, isLink: true })
    expect(await call('fs.stat', { path: 'dangling.txt' })).toEqual({ kind: 'other', size: 0, mtimeMs: 0, isLink: true })
    expect(await call('fs.stat', { path: 'small.txt' }, fakeAgent(ctx, { cwd: root }))).toMatchObject({ kind: 'file', isLink: false })
    expect(await call('fs.stat', { path: '.' })).toMatchObject({ kind: 'dir', isLink: false })
    const listed = await call('fs.list', { path: '.' }) as { name: string; kind: string }[]
    expect(listed.map(entry => entry.kind)).toContain('file')
    expect(await call('fs.exists', { path: 'nope' })).toBe(false)
  })
})

describe('processes through the subprocess seam', () => {
  it('runs argv with an explicit cwd and env, and reports a signal-terminated child', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    const { call } = setup(ctx)
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-cc-mods-proc-'))
    dirs.push(cwd)
    const run = await call('process.run', {
      argv: ['node', '-e', 'process.stdout.write(process.cwd() + "|" + process.env.CC_MODS_ENV)'],
      init: { cwd, env: { CC_MODS_ENV: 'set' } },
    }) as { exitCode: number; stdout: string }
    expect(run.exitCode).toBe(0)
    expect(run.stdout.endsWith('|set')).toBe(true)
    const viaAgent = await call('process.run', { argv: ['node', '-e', 'process.stdout.write(process.cwd())'] }, fakeAgent(ctx, { cwd })) as { stdout: string }
    expect(viaAgent.stdout.length).toBeGreaterThan(0)
    const bare = await call('process.run', { argv: ['node', '-e', 'process.stdout.write(process.cwd())'] }) as { exitCode: number; stdout: string }
    expect(bare).toEqual({ exitCode: 0, stdout: process.cwd(), stderr: '' })
    // A Windows child that kills itself still reports an exit code, so the signal branch is POSIX evidence.
    if (process.platform !== 'win32') {
      await expect(call('process.run', { argv: ['node', '-e', 'process.kill(process.pid, "SIGKILL")'] })).rejects.toThrow(/was terminated by signal SIGKILL/)
    }
    await expect(call('process.run', { argv: [] })).rejects.toThrow(/non-empty argv/)
    await expect(call('process.run', { argv: ['node', 1] })).rejects.toThrow(/non-empty argv/)
  })
})

describe('the store limit', () => {
  it('refuses a value that would push the plugin past its JSON budget', async () => {
    const ctx = new Context()
    const table = new Map<string, Record<string, unknown>>()
    const domain = {
      table: () => ({
        get: (key: string) => table.get(key),
        put: (key: string, value: Record<string, unknown>) => {
          table.set(key, value)
          return Promise.resolve()
        },
      }),
      close: () => Promise.resolve(),
    }
    ctx.provide('storageDomain', { open: () => Promise.resolve(domain) })
    const { call } = setup(ctx)
    expect(await call('store.keys', {})).toEqual([])
    await call('store.set', { key: 'ok', value: 1 })
    expect(await call('store.keys', {})).toEqual(['ok'])
    await expect(call('store.set', { key: 'big', value: 'x'.repeat(STORE_MAX_BYTES) })).rejects.toThrow(/would exceed/)
    // The limit counts UTF-8 bytes: 1.5 Mi CJK characters are 4.5 MiB of JSON.
    await expect(call('store.set', { key: 'cjk', value: '中'.repeat(1.5 * 1024 * 1024) })).rejects.toThrow(/would exceed/)
    expect(await call('store.set', { key: 'ascii', value: 'y'.repeat(1.5 * 1024 * 1024) })).toBeUndefined()
    await call('store.delete', { key: 'ascii' })
    // Concurrent writes to one plugin's record are serialized, so neither update is lost.
    await Promise.all([call('store.set', { key: 'a', value: 1 }), call('store.set', { key: 'b', value: 2 }), call('store.delete', { key: 'ok' })])
    expect(await call('store.keys', {})).toEqual(['a', 'b'])
    await call('store.set', { key: 'ok', value: 1 })
    await call('store.delete', { key: 'a' })
    await call('store.delete', { key: 'b' })
    expect(await call('store.get', { key: 'ok' })).toBe(1)
    expect(await call('store.get', { key: 'missing' })).toBeUndefined()
    await call('store.delete', { key: 'ok' })
    expect(await call('store.keys', {})).toEqual([])
  })
})

describe('registrations outside a session', () => {
  it('registers commands and tools globally when the raising event has no agent', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(CommandRuntime)
    const { call, registrations, engine } = setup(ctx)
    await call('command.register', { name: 'Global', description: 'global command' })
    await call('tool.register', { name: 'global_tool', description: 'global tool' })
    expect(ctx.tools.schemas().map(tool => tool.name)).toContain('mcp__unit-mod__global_tool')
    expect((await call('tool.list', {}) as { name: string }[]).map(tool => tool.name)).toContain('mcp__unit-mod__global_tool')
    const agent = fakeAgent(ctx)
    expect((await call('command.list', {}, agent) as { name: string; source: string }[])).toEqual([{ name: 'global', description: 'global command', source: 'plugin' }])
    expect([...registrations.keys()]).toEqual([''])
    expect(registrations.get('')?.size).toBe(2)
    void engine
    for (const dispose of registrations.get('') ?? []) dispose()
    expect(ctx.tools.schemas().map(tool => tool.name)).not.toContain('mcp__unit-mod__global_tool')
  })
})

describe('ui.log sinks', () => {
  it('writes transcript lines at info and debug lines at debug', async () => {
    const { call, ctx } = setup()
    const info = vi.fn()
    const debug = vi.fn()
    ctx.logger.info = info as never
    ctx.logger.debug = debug as never
    await call('ui.log', { text: 'seen', to: 'transcript' })
    await call('ui.log', { text: 'hidden', to: 'debug' })
    expect(info).toHaveBeenCalledWith('unit-mod: seen')
    expect(debug).toHaveBeenCalledWith('unit-mod: hidden')
  })
})
