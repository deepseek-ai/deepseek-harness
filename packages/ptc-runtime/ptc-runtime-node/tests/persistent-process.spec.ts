import { Duplex, PassThrough } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { expect, it, onTestFinished } from 'vitest'
import { createProcessRpc } from '../src/rpc.ts'
import { runPersistentMain } from '../src/persistent-process.ts'
import type { ProgramProcess } from '../src/process.ts'
import { decodePtcJsonWire, encodePtcJsonWire } from '../src/json-wire.ts'
import type { ProgramBootData, HostMethods, ProgramMethods } from '../src/protocol.ts'

async function setup(limit = 4096, chdir: (cwd: string) => void = () => {}) {
  const first = new PassThrough()
  const second = new PassThrough()
  const child = Duplex.from({ readable: first, writable: second })
  const host = Duplex.from({ readable: second, writable: first })
  child.on('error', () => {})
  host.on('error', () => {})
  const state: ProgramProcess = { env: { FIXTURE_SECRET: 'test', PATH: '/native' }, stdout: { write: () => true }, stderr: { write: () => true }, chdir }
  const nativeEnvironment = state.env
  const ready = Promise.withResolvers<true>()
  const seen: Record<string, unknown>[] = []
  const methods: HostMethods = {
    ready: () => { ready.resolve(true) },
    invoke: async (global, name, args) => {
      seen.push({ type: 'call', global, name, args })
      return encodePtcJsonWire(42)
    },
    log: (text) => { seen.push({ type: 'log', text }) },
    outputLimit: () => { seen.push({ type: 'output-limit' }) },
  }
  const peer = createProcessRpc<ProgramMethods, HostMethods>(host, limit, methods, [], () => {})
  const main = runPersistentMain(child, limit, state)
  const close = async () => { peer.$close(); host.destroy(); child.destroy(); await main }
  onTestFinished(close)
  await ready.promise
  const run = (code: string, namespaces: ProgramBootData['namespaces'] = [], maxOutputBytes = 1024) => {
    return peer.run('/', { code, namespaces, maxOutputBytes, retainsState: true }).then((result) => {
      seen.push({ type: 'done', ...result })
      return result
    })
  }

  return { state, nativeEnvironment, run, seen, peer, main, close, host, setCall: (handler: HostMethods['invoke']) => { methods.invoke = handler } }
}

it('keeps an injected process local to the REPL while it runs and after it closes', async () => {
  const hostProcess = globalThis.process
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'process')!
  try {
    const h = await setup()
    expect(globalThis.process === hostProcess).toBe(true)
    expect(decodePtcJsonWire((await h.run('Object.keys(process.env)')).value)).toEqual([])
    expect(globalThis.process === hostProcess).toBe(true)
    await h.close()
    expect(globalThis.process === hostProcess).toBe(true)
  } finally {
    Object.defineProperty(globalThis, 'process', descriptor)
  }
})

it('keeps an environment while capturing each evaluation and binding replies separately', async () => {
  // REPL diagnostics include Node-version-dependent frames and checkout paths.
  const diagnosticBudget = 65_536
  const h = await setup(diagnosticBudget)
  const declarations = [{ global: 'tools', names: ['echo'], errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' } }]
  expect(await h.run('let count = 1; const saved = tools.echo;', declarations)).toEqual({})
  const result = await h.run('count++; process.stdout.write("raw"); console.log("value", count); await saved({})', declarations)
  expect(decodePtcJsonWire(result.value)).toBe(42)
  expect(h.seen.filter(item => item.type === 'log').map(item => item.text)).toEqual(['raw', 'value 2'])
  expect(h.state.env).toEqual({})
  expect(h.nativeEnvironment).toEqual({ PATH: '/native' })
  const failed = await h.run('throw new Error("failed")', [], diagnosticBudget)
  expect(failed).toMatchObject({ error: { kind: 'exception' } })
  expect((failed.error as { message: string }).message).toContain('failed')
  const syntax = await h.run('const =', [], diagnosticBudget)
  expect(syntax).toMatchObject({ error: { kind: 'exception' } })
  expect(syntax.error?.message).toContain('SyntaxError')
  expect(decodePtcJsonWire((await h.run('count')).value)).toBe(2)
})

it('does not let an old asynchronous exception finish a later evaluation', async () => {
  const h = await setup()
  const declarations = [{ global: 'tools', names: ['echo'] }]
  const first = await h.run('let count = 1; let resume; const pause = new Promise(resolve => { resume = resolve }); setImmediate(() => { throw new Error("async failure") }); await pause; count', declarations)
  expect(first).toMatchObject({ error: { kind: 'exception' } })
  const second = await h.run('resume(); await tools.echo({})', declarations)
  expect(decodePtcJsonWire(second.value)).toBe(42)
  expect(decodePtcJsonWire((await h.run('count')).value)).toBe(1)
  expect(h.seen.filter(item => item.type === 'done')).toHaveLength(3)
})

it('treats leading braces as a statement block with reusable local declarations', async () => {
  const h = await setup()
  await h.run('let count = 0;')
  const block = '{ const local = await Promise.resolve(2); count += local; }'
  await h.run(block)
  await h.run(block)
  expect(decodePtcJsonWire((await h.run('({ count, local: typeof local })')).value)).toEqual({ count: 4, local: 'undefined' })
})

it('contains directory failures and output overflow in the active evaluation', async () => {
  const badDirectory = await setup(4096, () => {
    const error = new Error('directory missing')
    error.stack = 'Error: directory missing'
    throw error
  })
  const failed = await badDirectory.run('1')
  expect(failed).toMatchObject({ error: { kind: 'exception' } })
  expect((failed.error as { message: string }).message).toContain('directory missing')
  const h = await setup()
  await h.run('console.log("x".repeat(100))', [], 20)
  expect(h.seen.some(item => item.type === 'output-limit')).toBe(true)
})

it('closes the process channel when a terminal result cannot fit its write budget', async () => {
  const h = await setup(1024)
  await expect(h.run('"x".repeat(2000)', [], 8000)).rejects.toThrow()
  await h.main
})

it('ignores output and rejects tool calls from a completed evaluation', async () => {
  const h = await setup()
  const declarations = [{ global: 'tools', names: ['echo'] }]
  await h.run('let finish; let old; const trigger = new Promise(resolve => { finish = resolve }); void trigger.then(async () => { console.log("late"); try { await tools.echo({}) } catch (error) { old = error.message } });', declarations)
  const result = await h.run('finish(); await new Promise(resolve => setImmediate(resolve)); old', declarations)
  expect(decodePtcJsonWire(result.value)).toContain('evaluation has ended')
  expect(h.seen.some(item => item.type === 'log' || item.type === 'call')).toBe(false)
  expect(decodePtcJsonWire((await h.run('await tools.echo({})', declarations)).value)).toBe(42)
  expect(h.seen.filter(item => item.type === 'call')).toHaveLength(1)
})

it('rejects unfinished binding waits when a program returns', async () => {
  const h = await setup()
  const pending = Promise.withResolvers<ReturnType<typeof encodePtcJsonWire>>()
  onTestFinished(() => { pending.resolve(encodePtcJsonWire(null)) })
  h.setCall(() => pending.promise)
  await h.run('let rejected; void tools.echo({}).catch(error => { rejected = error.message });', [{ global: 'tools', names: ['echo'] }])
  expect(decodePtcJsonWire((await h.run('rejected')).value)).toContain('ended before the binding completed')
})

it.each([0, 1.5])('rejects an invalid control limit %s', async (limit) => {
  const stream = new PassThrough()
  try {
    await expect(runPersistentMain(stream, limit, { env: {}, stdout: { write: () => true }, stderr: { write: () => true }, chdir: () => {} })).rejects.toThrow('invalid control message limit')
  } finally { stream.destroy() }
})

it('shuts down an idle REPL without creating an evaluation', async () => {
  const h = await setup()
  await h.close()
  expect(h.seen).toEqual([])
})

it('ignores a REPL asynchronous diagnostic after its evaluation has completed', async () => {
  const h = await setup()
  await h.run('setImmediate(() => { throw new Error("completed callback") }); 1')
  await setImmediate()
  expect(decodePtcJsonWire((await h.run('2')).value)).toBe(2)
  expect(h.seen.filter(message => message.type === 'done')).toHaveLength(2)
})
