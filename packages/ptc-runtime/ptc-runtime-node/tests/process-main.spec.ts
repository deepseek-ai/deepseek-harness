import type { PtcProgramFormat } from '@deepseek-ai/dsh-ptc-runtime'
import { Duplex, PassThrough } from 'node:stream'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createProcessRpc } from '../src/rpc.ts'
import { runNodeMain, type ProgramProcess } from '../src/process.ts'
import type { HostMethods, ProgramBootData, ProgramMethods } from '../src/protocol.ts'
import { decodePtcJsonWire, encodePtcJsonWire } from '../src/json-wire.ts'

function endpoints() {
  const first = new PassThrough()
  const second = new PassThrough()
  const child = Duplex.from({ readable: first, writable: second })
  const host = Duplex.from({ readable: second, writable: first })
  child.on('error', () => {})
  host.on('error', () => {})
  onTestFinished(() => { child.destroy(); host.destroy() })
  return { child, host }
}
function processState(): ProgramProcess { return { env: { FIXTURE_SECRET: 'test' }, stdout: { write: () => true }, stderr: { write: () => true }, exitCode: undefined, chdir: () => {} } }

async function setup(limit = 4096, namespaces: ProgramBootData['namespaces'] = [{ global: 'tools', names: ['echo'] }]) {
  const { child, host } = endpoints()
  const state = processState()
  const nativeEnvironment = state.env
  Object.assign(nativeEnvironment, { SystemRoot: 'C:\\Windows', PATH: '/native/bin', TMP: 'C:\\sandbox-temp', TEMP: 'C:\\sandbox-temp' })
  const ready = Promise.withResolvers<undefined>()
  const logs: string[] = []
  const methods: HostMethods = {
    ready: () => { ready.resolve(undefined) },
    initialized: async () => {},
    invoke: async () => encodePtcJsonWire(42),
    log: (text) => { logs.push(text) },
    image: () => {},
    outputLimit: () => {},
  }
  const peer = createProcessRpc<ProgramMethods, HostMethods>(host, limit, methods, [], () => {})
  const main = runNodeMain(child, limit, state)
  onTestFinished(async () => { peer.$close(); child.destroy(); await main })
  await ready.promise
  const run = (code: string, maxOutputBytes = 1024, programFormat?: PtcProgramFormat, options: Pick<ProgramBootData, 'discardCompletion'> = {}) => peer.run('/', {
    code, ...programFormat === undefined ? {} : { programFormat },
    namespaces, maxOutputBytes, retainsState: false, ...options,
  })
  return { child, host, state, nativeEnvironment, methods, peer, main, logs, run }
}

it('clears the environment and returns a binding result after captured output', async () => {
  const h = await setup()
  h.methods.invoke = async (_global, _name, wire) => {
    const args = decodePtcJsonWire(wire) as { n: number }
    return encodePtcJsonWire(args.n * 2)
  }
  const result = await h.run('const doubled = await tools.echo({ n: 21 }); inspect("got", doubled); return { doubled };')
  expect(decodePtcJsonWire(result.value)).toEqual({ doubled: 42 })
  expect(h.logs).toEqual(['got 42\n'])
  expect(h.state.env).toEqual({})
  expect(h.state.env).not.toBe(h.nativeEnvironment)
  expect(Object.getPrototypeOf(h.state.env)).toBeNull()
  expect(h.nativeEnvironment).toEqual({ SystemRoot: 'C:\\Windows', PATH: '/native/bin', TMP: 'C:\\sandbox-temp', TEMP: 'C:\\sandbox-temp' })
  h.peer.$close()
  await h.main
  expect(h.state.exitCode).toBeUndefined()
})

it.each(['function-body', 'repl', 'script'] as const)('provides console in the owning %s realm without replacing the host console', async (format) => {
  const h = await setup()
  const nativeConsole = Object.getOwnPropertyDescriptor(globalThis, 'console')!
  const result = await h.run('inspect(typeof console.log, typeof console.dir, typeof console.table);', 1024, format,
    { discardCompletion: true })
  expect(result).toEqual({})
  expect(h.logs).toEqual(['function function function\n'])
  expect(Object.getOwnPropertyDescriptor(globalThis, 'console')).toEqual(nativeConsole)
})

it('keeps unfinished temporary calls pending and suppresses later logs while awaiting host shutdown', async () => {
  const h = await setup()
  const release = Promise.withResolvers<ReturnType<typeof encodePtcJsonWire>>()
  h.methods.invoke = () => release.promise
  try {
    expect(decodePtcJsonWire((await h.run('void tools.echo({}).catch(() => {}); void tools.echo({}).catch(() => inspect("late rejection")); setImmediate(() => inspect("late timer")); return 42;')).value)).toBe(42)
    await nextTurn()
    expect(h.child.destroyed).toBe(false)
    release.resolve(encodePtcJsonWire(42))
    await nextTurn()
    expect(h.logs).toEqual([])
  } finally { release.resolve(encodePtcJsonWire(null)) }
})

it('rejects a binding call that the host fails during the run', async () => {
  const h = await setup()
  h.methods.invoke = async () => { throw new Error('denied by host') }
  const result = await h.run('try { await tools.echo({}) } catch (error) { return error.message }')
  expect(decodePtcJsonWire(result.value)).toBe('denied by host')
})

it.each(['function-body', 'repl', 'script'] as const)('leaves an unawaited call pending when a temporary %s process closes after the result', async (format) => {
  const h = await setup()
  const pending = Promise.withResolvers<ReturnType<typeof encodePtcJsonWire>>()
  onTestFinished(() => { pending.resolve(encodePtcJsonWire(null)) })
  h.methods.invoke = () => pending.promise
  const code = format === 'function-body' ? 'void tools.echo({}).catch(() => {}); return 42' : 'void tools.echo({}).catch(() => {}); 42'
  expect(decodePtcJsonWire((await h.run(code, 1024, format)).value)).toBe(42)
  h.peer.$close()
  await h.main
  await nextTurn()
  expect(h.state.exitCode).toBeUndefined()
})

it.each([4, 64])('reports exhausted output accounting during the run with a %s-byte limit', async (maxOutputBytes) => {
  const h = await setup()
  const limited = vi.fn()
  h.methods.outputLimit = limited
  expect(await h.run('inspect("x".repeat(100)); return null', maxOutputBytes))
    .toEqual({ error: { kind: 'output-limit', message: `outer output exceeded ${maxOutputBytes} bytes` } })
  if (maxOutputBytes === 4) expect(h.logs).toEqual([])
  await vi.waitFor(() => { expect(limited).toHaveBeenCalledOnce() })
})

it.each([
  ['throw new Error("boom")', 'boom'],
  ['throw "raw-throw"', 'raw-throw'],
  ['const e = new Error("bare"); e.stack = undefined; throw e', 'bare'],
  ['delete missing; return 1', 'Delete of an unqualified identifier in strict mode'],
])('returns bounded program exceptions for %s', async (code, message) => {
  const h = await setup(65_536)
  const result = await h.run(code, 65_536)
  expect(result.error?.kind).toBe('exception')
  expect(result.error?.message).toContain(message)
  expect(result.value).toBeUndefined()
})

it.each(['throw "x".repeat(1_000_000)', 'throw new Error("x".repeat(1_000_000))'])('bounds large diagnostics for %s', async (code) => {
  const h = await setup()
  expect(await h.run(code, 64)).toEqual({ error: { kind: 'output-limit', message: 'outer output exceeded 64 bytes' } })
})

it.each([
  ['tools', 'ToolCallError', 'toolName'],
  ['helpers', 'HelperCallError', 'helperName'],
])('injects the declared rejection class for %s', async (global, name, memberNameProperty) => {
  const h = await setup(4096, [{ global, names: ['x'], errorClass: { name, memberNameProperty } }])
  h.methods.invoke = async () => { throw new Error('denied by host') }
  const result = await h.run(`try { await ${global}.x({}) } catch (error) { return { caught: error instanceof ${name}, name: error.name, member: error.${memberNameProperty}, message: error.message } }`)
  expect(decodePtcJsonWire(result.value)).toEqual({ caught: true, name, member: 'x', message: 'denied by host' })
})

it('sends no binding calls or output notifications after returning its result', async () => {
  const h = await setup()
  const invoked = vi.fn(async () => encodePtcJsonWire(1))
  const limited = vi.fn()
  h.methods.invoke = invoked
  h.methods.outputLimit = limited
  const result = await h.run('setImmediate(() => { void tools.echo({}).catch(() => {}); inspect("x".repeat(2000)) }); return 1', 64)
  expect(decodePtcJsonWire(result.value)).toBe(1)
  await nextTurn()
  await nextTurn()
  expect(invoked).not.toHaveBeenCalled()
  expect(limited).not.toHaveBeenCalled()
  expect(h.logs).toEqual([])
})

it.each([0, -1, 1.5])('rejects an invalid control message limit %s', async (limit) => {
  const { child } = endpoints()
  await expect(runNodeMain(child, limit, processState())).rejects.toThrow('invalid control message limit')
})

it('records malformed host traffic before evaluation as failure', async () => {
  const h = await setup()
  h.host.write(Buffer.from('null\n'))
  await h.main
  expect(h.state.exitCode).toBe(1)
})

it('accepts host shutdown before the first evaluation', async () => {
  const h = await setup()
  h.peer.$close()
  await h.main
  expect(h.state.exitCode).toBeUndefined()
})

it.each([
  'inspect("x".repeat(2000));',
  'return "x".repeat(2000)',
])('closes on control output overflow: %s', async (code) => {
  const h = await setup(1024)
  await expect(h.run(code, 8000)).rejects.toThrow()
  await h.main
  expect(h.state.exitCode).toBe(1)
})

it('records malformed host traffic after completion', async () => {
  const h = await setup()
  await h.run('return 42')
  h.host.write(Buffer.from([0xff, 10]))
  await h.main
  expect(h.state.exitCode).toBe(1)
})


it('captures image selection during execution and revokes it for late or external calls', async () => {
  const h = await setup()
  h.methods.invoke = async () => [{ kind: 'image', id: 'one', attachmentId: 'sha256:image', path: '/image.png', width: 8, height: 4 }]
  const selected = vi.fn()
  h.methods.image = selected
  const done = Promise.withResolvers<undefined>()
  const state = h.state as ProgramProcess & { savedInspect?: (value: unknown) => void; image?: unknown; done?: () => void }
  state.done = () => { done.resolve(undefined) }
  const result = await h.run(`
    process.image = await tools.echo({});
    if (!Object.isFrozen(process.image)) throw new Error("Image must be immutable");
    if (Reflect.ownKeys(process.image).join() !== "attachmentId,path,width,height") throw new Error("Unexpected Image fields");
    if (process.image.attachmentId !== "sha256:image") throw new Error("Unexpected attachment ID");
    let constructorError;
    try { new Image() } catch (error) { constructorError = error.message }
    if (constructorError !== "Images are created by image-producing tools") throw new Error("Image construction succeeded");
    process.savedInspect = inspect;
    const nodeUtil = await import('node:util');
    inspect(nodeUtil.inspect(process.image));
    inspect({ image: process.image });
    setImmediate(() => { inspect(process.image); process.done(); });
  `, 1024, 'script', { discardCompletion: true })
  expect(result.error).toBeUndefined()
  await done.promise
  if (state.savedInspect === undefined) throw new Error('The program did not retain its output function')
  state.savedInspect(state.image)
  expect(selected).toHaveBeenCalledExactlyOnceWith('one')
})
