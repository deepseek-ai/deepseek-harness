import { brandNumber } from '@deepseek-ai/dsh-brand'
import { Duplex, PassThrough } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createProcessRpc } from '../src/rpc.ts'
import { runPersistentMain } from '../src/persistent-process.ts'
import type { ProgramProcess } from '../src/process.ts'
import { decodePtcJsonWire, encodePtcJsonWire } from '../src/json-wire.ts'
import type { EvaluationId, ProgramBootData, HostMethods, ProgramMethods } from '../src/protocol.ts'

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
    invoke: async (_id, global, name, args) => {
      seen.push({ type: 'call', global, name, args })
      return encodePtcJsonWire(42)
    },
    log: (_id, text) => { seen.push({ type: 'log', text }) },
    outputLimit: () => { seen.push({ type: 'output-limit' }) },
  }
  const peer = createProcessRpc<ProgramMethods, HostMethods>(host, limit, methods, ['revoke'], () => {})
  const main = runPersistentMain(child, limit, state)
  const close = async () => { peer.$close(); host.destroy(); child.destroy(); await main }
  onTestFinished(close)
  await ready.promise
  let sequence = 0
  const run = (code: string, namespaces: ProgramBootData['namespaces'] = [], maxOutputBytes = 1024) => {
    return peer.run(brandNumber<EvaluationId>(++sequence), '/', { code, namespaces, maxOutputBytes, programFormat, retainsState: true }).then((result) => {
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

it('ignores output and rejects new tool calls from a completed evaluation', async () => {
  const h = await setup()
  const declarations = [{ global: 'tools', names: ['echo'] }]
  await h.run('let finish; let old; const trigger = new Promise(resolve => { finish = resolve }); void trigger.then(async () => { console.log("late"); try { await tools.echo({}) } catch (error) { old = error.message } });', declarations)
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
  const first = h.run('let kept = 42; let effects = []; try { await tools.echo({}); effects.push("then") } catch { effects.push("catch") } finally { effects.push("finally") }', declarations)
  await started.promise
  await h.peer.revoke(brandNumber<EvaluationId>(1))
  expect(await first).toMatchObject({ error: { kind: 'abort' } })
  await h.peer.revoke(brandNumber<EvaluationId>(1))
  if (outcome === 'resolve') pending.resolve(encodePtcJsonWire(42))
  else pending.reject(new Error('late failure'))
  await setImmediate()
  expect(decodePtcJsonWire((await h.run('({ kept, effects })')).value)).toEqual({ kept: 42, effects: ['catch', 'finally'] })
  await h.peer.revoke(brandNumber<EvaluationId>(1))
  expect(decodePtcJsonWire((await h.run('kept + 1')).value)).toBe(43)
})

it.each(['repl', 'script'] as const)('keeps run pending until an arbitrary user Promise settles after %s revocation', async (format) => {
  const h = await setup(4096, undefined, format)
  const resume = Promise.withResolvers<undefined>()
  onTestFinished(() => { resume.resolve(undefined) })
  const started = Promise.withResolvers<undefined>()
  // A host-controlled Promise models asynchronous work outside the managed binding wait.
  Object.defineProperty(h.state, 'wait', { value: () => { started.resolve(undefined); return resume.promise } })
  const first = h.run('var mutation = 0; var serialized = 0; await process.wait(); mutation++; console.log("late"); ({ get value() { serialized++; return 1 } })')
  await started.promise
  const settled = vi.fn()
  void first.then(settled)
  await h.peer.revoke(brandNumber<EvaluationId>(1))
  await setImmediate()
  expect(settled).not.toHaveBeenCalled()
  await expect(h.peer.run(brandNumber<EvaluationId>(2), '/', { code: '1', namespaces: [], maxOutputBytes: 1024, retainsState: true })).rejects.toThrow('invalid or overlapping')
  resume.resolve(undefined)
  expect(await first).toMatchObject({ error: { kind: 'abort' } })
  expect(decodePtcJsonWire((await h.run('({ mutation, serialized })')).value)).toEqual({ mutation: 1, serialized: 0 })
  expect(h.seen.filter(item => item.type === 'log')).toEqual([])
})

it('rejects reused or overlapping runs and ignores revocation of other identities', async () => {
  const h = await setup()
  const data: ProgramBootData = { code: '1', namespaces: [], maxOutputBytes: 1024, retainsState: true }
  await h.peer.revoke(brandNumber<EvaluationId>(1))
  await h.run('1')
  await expect(h.peer.run(brandNumber<EvaluationId>(1), '/', data)).rejects.toThrow('invalid or overlapping')
  const started: PromiseWithResolvers<void> = Promise.withResolvers()
  h.setCall(() => { started.resolve(); return new Promise(() => {}) })
  const first = h.run('await tools.echo({})', [{ global: 'tools', names: ['echo'] }])
  await started.promise
  await expect(h.peer.run(brandNumber<EvaluationId>(3), '/', data)).rejects.toThrow('invalid or overlapping')
  await h.peer.revoke(brandNumber<EvaluationId>(0))
  await h.peer.revoke(brandNumber<EvaluationId>(3))
  await expect(h.peer.run(brandNumber<EvaluationId>(3), '/', data)).rejects.toThrow('invalid or overlapping')
  await h.peer.revoke(brandNumber<EvaluationId>(2))
  await first
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
  h.setCall(async () => { invoked.resolve(); return null })
  const first = h.run('let resumed = false; try { await tools.echo({}); resumed = true } finally { resumed = true }', [{ global: 'tools', names: ['echo'] }])
  await invoked.promise
  expect((await first).error?.kind).toBe('exception')
  await h.peer.revoke(brandNumber<EvaluationId>(1))
  expect(decodePtcJsonWire((await h.run('resumed')).value)).toBe(true)
})
