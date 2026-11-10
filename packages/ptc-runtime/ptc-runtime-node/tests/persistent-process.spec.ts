import { Duplex, PassThrough } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createProcessRpc } from '../src/rpc.ts'
import { runPersistentMain } from '../src/persistent-process.ts'
import type { ProgramProcess } from '../src/process.ts'
import { decodePtcJsonWire, encodePtcJsonWire } from '../src/json-wire.ts'
import type { ProgramBootData, HostMethods, ProgramMethods } from '../src/protocol.ts'
import { rawPeer } from './raw-peer.ts'

async function setup(limit = 4096, chdir: (cwd: string) => void = () => {}, programFormat: 'repl' | 'script' = 'repl') {
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
    initialized: async () => {},
    invoke: async (global, name, args) => {
      seen.push({ type: 'call', global, name, args })
      return encodePtcJsonWire(42)
    },
    log: (text) => { seen.push({ type: 'log', text }) },
    image: () => {},
    outputLimit: () => { seen.push({ type: 'output-limit' }) },
  }
  const peer = createProcessRpc<ProgramMethods, HostMethods>(host, limit, methods, ['revoke'], () => {})
  const main = runPersistentMain(child, limit, state)
  const close = async () => { peer.$close(); host.destroy(); child.destroy(); await main }
  onTestFinished(close)
  await ready.promise
  const run = (code: string, namespaces: ProgramBootData['namespaces'] = [], maxOutputBytes = 1024, initialization?: string) => {
    return peer.run('/', { code, namespaces, maxOutputBytes, programFormat, retainsState: true,
      ...initialization === undefined ? {} : { initialization } }).then((result) => {
      seen.push({ type: 'done', ...result })
      return result
    })
  }

  return { state, nativeEnvironment, run, seen, peer, main, close, host,
    setCall: (handler: HostMethods['invoke']) => { methods.invoke = handler },
    setInitialized: (handler: HostMethods['initialized']) => { methods.initialized = handler },
  }
}

it('runs initialization before the program in the same REPL and discards its completion', async () => {
  const h = await setup()
  const namespaces = [{ global: 'tools', names: ['echo'] }]
  const initialization = 'globalThis.helper ??= { read: () => tools.echo({}) }; inspect("initialize"); helper'
  expect(decodePtcJsonWire((await h.run('var saved = helper; await helper.read()', namespaces, 1024, initialization)).value)).toBe(42)
  h.setCall(async () => encodePtcJsonWire(43))
  expect(decodePtcJsonWire((await h.run('({ value: await helper.read(), same: helper === saved })', namespaces)).value))
    .toEqual({ value: 43, same: true })
  expect(h.seen.filter(item => item.type === 'log').map(item => item.text)).toEqual(['initialize\n'])
  expect(decodePtcJsonWire((await h.run('42', [], 1024, '')).value)).toBe(42)
})

it.each([false, true])('closes program output and bindings before queued microtasks with initialization %s', async (initialize) => {
  const h = await setup()
  const namespaces = [{ global: 'tools', names: ['echo'] }]
  const result = await h.run(
    'queueMicrotask(() => { inspect("late"); void tools.echo({}).catch(() => {}) }); 42',
    namespaces, 1024, initialize ? 'globalThis.ready = true' : undefined,
  )
  expect(decodePtcJsonWire(result.value)).toBe(42)
  await setImmediate()
  expect(h.seen.filter(item => item.type === 'log' || item.type === 'call')).toEqual([])
  expect(decodePtcJsonWire((await h.run('await tools.echo({})', namespaces)).value)).toBe(42)
  expect(h.seen.filter(item => item.type === 'call')).toHaveLength(1)
})

it('does not adopt a REPL completion Promise without explicit await', async () => {
  const h = await setup()
  expect((await h.run('Promise.resolve(42)')).error?.kind).toBe('invalid-output')
  expect(decodePtcJsonWire((await h.run('await Promise.resolve(42)')).value)).toBe(42)
})

it('prevents the program after initialization exceptions and output overflow', async () => {
  const h = await setup()
  await h.run('var entered = 0;')
  expect((await h.run('entered++', [], 4096, 'const =')).error?.kind).toBe('exception')
  const failed = await h.run('entered++', [], 1024, 'throw "initialization failed"')
  expect(failed.error?.kind).toBe('exception')
  expect(failed.error?.message).toContain('initialization failed')
  expect((await h.run('entered++', [], 64, 'inspect("x".repeat(100))')).error?.kind).toBe('output-limit')
  expect(decodePtcJsonWire((await h.run('entered')).value)).toBe(0)
})

it('does not resume the program after initialization reports an asynchronous failure', async () => {
  const h = await setup()
  const failed = await h.run('globalThis.programRan = true', [], 4096,
    'var resume; await new Promise(resolve => { resume = resolve; setImmediate(() => { throw new Error("initialization failed") }) })')
  expect(failed.error?.kind).toBe('exception')
  expect(decodePtcJsonWire((await h.run('resume(); await new Promise(resolve => setImmediate(resolve)); typeof programRan')).value))
    .toBe('undefined')
})

it('does not start the program when initialization catches a revoked binding', async () => {
  const h = await setup()
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  const pending = Promise.withResolvers<ReturnType<typeof encodePtcJsonWire>>()
  onTestFinished(() => { pending.resolve(encodePtcJsonWire(null)) })
  h.setCall(() => { entered.resolve(); return pending.promise })
  const first = h.run('globalThis.programRan = true', [{ global: 'tools', names: ['echo'] }], 1024,
    'try { await tools.echo({}) } catch {}')
  await entered.promise
  await h.peer.revoke()
  expect(await first).toEqual({})
  expect(decodePtcJsonWire((await h.run('typeof programRan')).value)).toBe('undefined')
})

it('waits for Host acceptance before starting the user program', async () => {
  const h = await setup()
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  const accepted: PromiseWithResolvers<void> = Promise.withResolvers()
  const started = vi.fn()
  Object.defineProperty(h.state, 'started', { value: started })
  h.setInitialized(() => { entered.resolve(); return accepted.promise })
  const pending = h.run('process.started(); 42', [], 1024, 'globalThis.helper = {}')
  try {
    await entered.promise
    expect(started).not.toHaveBeenCalled()
    accepted.resolve()
    expect(decodePtcJsonWire((await pending).value)).toBe(42)
    expect(started).toHaveBeenCalledOnce()
  } finally { accepted.resolve(); await pending }
})

it('does not start the user program when Host acceptance rejects', async () => {
  const h = await setup()
  h.setInitialized(async () => { throw new Error('initialization was canceled') })
  const result = await h.run('globalThis.programRan = true', [], 4096, 'globalThis.helper = {}')
  expect(result.error?.kind).toBe('exception')
  expect(result.error?.message).toContain('initialization was canceled')
  expect(decodePtcJsonWire((await h.run('typeof programRan')).value)).toBe('undefined')
})

it('cancels initialization while its Host acceptance is pending', async () => {
  const h = await setup()
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  const accepted: PromiseWithResolvers<void> = Promise.withResolvers()
  h.setInitialized(() => { entered.resolve(); return accepted.promise })
  const pending = h.run('globalThis.programRan = true', [], 1024, 'globalThis.helper = {}')
  try {
    await entered.promise
    await h.peer.revoke()
    expect(await pending).toEqual({})
    expect(decodePtcJsonWire((await h.run('typeof programRan')).value)).toBe('undefined')
  } finally { accepted.resolve(); await pending }
})

it('checks revocation after accepting an initialization reply', async () => {
  const h = await setup()
  const request: PromiseWithResolvers<string> = Promise.withResolvers()
  const accepted: PromiseWithResolvers<void> = Promise.withResolvers()
  h.setInitialized(() => accepted.promise)
  const wire = rawPeer(h.host, (message) => {
    if (typeof message === 'object' && message !== null && 'm' in message && message.m === 'initialized'
      && 'i' in message && typeof message.i === 'string') request.resolve(message.i)
  })
  const pending = h.run('globalThis.programRan = true', [], 1024, 'globalThis.helper = {}')
  try {
    const id = await request.promise
    await Promise.all([
      wire.send({ t: 's', i: id }),
      wire.send({ t: 'q', m: 'revoke', a: [] }),
    ])
    expect(await pending).toEqual({})
    expect(decodePtcJsonWire((await h.run('typeof programRan')).value)).toBe('undefined')
  } finally { accepted.resolve(); wire.close(); await pending }
})

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
  const result = await h.run('count++; process.stdout.write("raw"); inspect("value", count); await saved({})', declarations)
  expect(decodePtcJsonWire(result.value)).toBe(42)
  expect(h.seen.filter(item => item.type === 'log').map(item => item.text)).toEqual(['raw', 'value 2\n'])
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
  await h.run('inspect("x".repeat(100))', [], 20)
  expect(h.seen.some(item => item.type === 'output-limit')).toBe(true)
})

it('closes the process channel when a terminal result cannot fit its write budget', async () => {
  const h = await setup(1024)
  await expect(h.run('"x".repeat(2000)', [], 8000)).rejects.toThrow()
  await h.main
})

it('ignores output and rejects new tool calls from a completed evaluation', async () => {
  const h = await setup()
  const declarations = [{ global: 'tools', names: ['echo'] }]
  await h.run('let finish; let old; const trigger = new Promise(resolve => { finish = resolve }); void trigger.then(async () => { inspect("late"); try { await tools.echo({}) } catch (error) { old = error.message } });', declarations)
  const result = await h.run('finish(); await new Promise(resolve => setImmediate(resolve)); old', declarations)
  expect(decodePtcJsonWire(result.value)).toBe('PTC evaluation ended')
  expect(h.seen.some(item => item.type === 'log' || item.type === 'call')).toBe(false)
  expect(decodePtcJsonWire((await h.run('await tools.echo({})', declarations)).value)).toBe(42)
  expect(h.seen.filter(item => item.type === 'call')).toHaveLength(1)
})

it.each(['resolve', 'reject'] as const)('rejects an unfinished binding once when a completed program receives a late %s', async (outcome) => {
  const h = await setup()
  const pending = Promise.withResolvers<ReturnType<typeof encodePtcJsonWire>>()
  onTestFinished(() => { pending.resolve(encodePtcJsonWire(null)) })
  h.setCall(() => pending.promise)
  await h.run('let effects = []; void tools.echo({}).then(() => effects.push("then")).catch(() => effects.push("catch")).finally(() => effects.push("finally"));', [{ global: 'tools', names: ['echo'] }])
  if (outcome === 'resolve') pending.resolve(encodePtcJsonWire(42))
  else pending.reject(new Error('late failure'))
  await setImmediate()
  expect(decodePtcJsonWire((await h.run('effects')).value)).toEqual(['catch', 'finally'])
})

it.each([['resolve', 'repl'], ['reject', 'repl'], ['resolve', 'script'], ['reject', 'script']] as const)('revokes an awaiting program after a late %s in %s', async (outcome, format) => {
  const h = await setup(4096, undefined, format)
  const pending = Promise.withResolvers<ReturnType<typeof encodePtcJsonWire>>()
  const started: PromiseWithResolvers<void> = Promise.withResolvers()
  onTestFinished(() => { pending.resolve(encodePtcJsonWire(null)) })
  h.setCall(() => { started.resolve(); return pending.promise })
  const declarations = [{ global: 'tools', names: ['echo'] }]
  await h.peer.revoke()
  const first = h.run('let kept = 42; let effects = []; try { await tools.echo({}); effects.push("then") } catch { effects.push("catch") } finally { effects.push("finally") }', declarations)
  await started.promise
  await h.peer.revoke()
  expect(await first).toEqual({})
  await h.peer.revoke()
  if (outcome === 'resolve') pending.resolve(encodePtcJsonWire(42))
  else pending.reject(new Error('late failure'))
  await setImmediate()
  expect(decodePtcJsonWire((await h.run('({ kept, effects })')).value)).toEqual({ kept: 42, effects: ['catch', 'finally'] })
  await h.peer.revoke()
  expect(decodePtcJsonWire((await h.run('kept + 1')).value)).toBe(43)
})

it.each(['repl', 'script'] as const)('rejects a binding result followed by revocation before %s user code resumes', async (format) => {
  const h = await setup(4096, undefined, format)
  const request = Promise.withResolvers<string>()
  const response = Promise.withResolvers<ReturnType<typeof encodePtcJsonWire>>()
  h.setCall(() => response.promise)
  const wire = rawPeer(h.host, (message) => {
    if (typeof message === 'object' && message !== null && 'm' in message && message.m === 'invoke'
      && 'i' in message && typeof message.i === 'string') request.resolve(message.i)
  })
  const first = h.run('var effects = []; try { await tools.echo({}); effects.push("then") } catch { effects.push("catch") } finally { effects.push("finally") }', [{ global: 'tools', names: ['echo'] }])
  try {
    const id = await request.promise
    await Promise.all([
      wire.send({ t: 's', i: id, r: encodePtcJsonWire(42) }),
      wire.send({ t: 'q', m: 'revoke', a: [] }),
    ])
    expect(await first).toEqual({})
    expect(decodePtcJsonWire((await h.run('effects')).value)).toEqual(['catch', 'finally'])
  } finally {
    response.resolve(encodePtcJsonWire(null))
    wire.close()
    await first
  }
})

it.each(['repl', 'script'] as const)('keeps run pending until an arbitrary user Promise settles after %s revocation', async (format) => {
  const h = await setup(4096, undefined, format)
  const resume = Promise.withResolvers<undefined>()
  onTestFinished(() => { resume.resolve(undefined) })
  const started = Promise.withResolvers<undefined>()
  // A host-controlled Promise models asynchronous work outside the managed binding wait.
  Object.defineProperty(h.state, 'wait', { value: () => { started.resolve(undefined); return resume.promise } })
  const first = h.run('var mutation = 0; var serialized = 0; await process.wait(); mutation++; inspect("late"); ({ get value() { serialized++; return 1 } })')
  await started.promise
  const settled = vi.fn()
  void first.then(settled)
  await h.peer.revoke()
  await setImmediate()
  expect(settled).not.toHaveBeenCalled()
  await expect(h.peer.run('/', { code: '1', namespaces: [], maxOutputBytes: 1024, retainsState: true })).rejects.toThrow('overlapping PTC evaluation')
  resume.resolve(undefined)
  expect(await first).toEqual({})
  expect(decodePtcJsonWire((await h.run('({ mutation, serialized })')).value)).toEqual({ mutation: 1, serialized: 0 })
  expect(h.seen.filter(item => item.type === 'log')).toEqual([])
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


it('throws for a host-revoked binding and runs user cleanup', async () => {
  const h = await setup()
  const invoked: PromiseWithResolvers<void> = Promise.withResolvers()
  h.setCall(async () => { invoked.resolve(); throw new Error('binding canceled by host') })
  const first = h.run('let resumed = false; try { await tools.echo({}); resumed = true } finally { resumed = true }', [{ global: 'tools', names: ['echo'] }])
  await invoked.promise
  expect((await first).error?.kind).toBe('exception')
  await h.peer.revoke()
  expect(decodePtcJsonWire((await h.run('resumed')).value)).toBe(true)
})
