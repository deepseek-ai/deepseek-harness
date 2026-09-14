import { mkdtemp, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { createServer, type Socket } from 'node:net'
import { delimiter, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { PtcBindingFunction, PtcBindingNamespace, PtcRunRequest } from '@deepseek-ai/dsh-ptc-runtime'
import type { Config } from '../src/index.ts'
import { mountRuntime } from './setup.ts'

/** Probe the sandbox independently so Node-runtime launch failures cannot skip enforcement tests. */
const sandboxUsable = await (async () => {
  const probe = new Context()
  try {
    await probe.plugin(Sandbox, {})
    await probe.sandbox.confine([process.execPath, '--version'], { mode: 'read-only', workspaceRoot: process.cwd() })
    return true
  } catch (error: unknown) {
    if (error instanceof SandboxUnavailableError) return false
    throw error
  } finally { await probe.fiber.dispose() }
})()

async function setup(config: Config = {}, mode: 'read-only' | 'workspace-write' | 'danger-full-access' = 'danger-full-access') {
  const root = await mkdtemp(join(homedir(), '.dsh-node-runtime-test-'))
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const runtime = await mountRuntime(ctx, config, { mode, workspaceRoot: cwd })
  const run = (request: PtcRunRequest) => runtime.run(runtime.resolve(request))
  return { ctx, runtime, root, cwd, run }
}

function bindings(functions: Record<string, PtcBindingFunction>): PtcBindingNamespace[] {
  return [{ global: 'tools', functions, errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' } }]
}

describe('Node program process', () => {
  it('runs erasable TypeScript in the resolved directory with an empty environment', async () => {
    const { run, cwd } = await setup()
    const result = await run({ program: 'const n: number = 6; console.log("ready"); return { n: n * 7, cwd: process.cwd(), env: { ...process.env } };', bindings: [] })
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({ n: 42, cwd, env: {} })
    expect(result.logs).toEqual(['ready'])
    expect(result.sandbox).toEqual({ mode: 'danger-full-access', denied: false })
  })

  it('keeps native startup paths available for nested Node creation with an empty model environment', async () => {
    const { run } = await setup()
    const result = await run({
      program: 'const {spawnSync}=await import("node:child_process"); const child=spawnSync(process.execPath,["-e","process.stdout.write(JSON.stringify(Object.keys(process.env)))"],{encoding:"utf8"}); return {env:Object.keys(process.env),status:child.status,error:child.error?.message ?? null,childKeys:JSON.parse(child.stdout || "[]")};',
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    const value = result.value as { env: string[]; status: number | null; error: string | null; childKeys: string[] }
    expect(value.env).toEqual([])
    expect(value.status).toBe(0)
    expect(value.error).toBeNull()
    const nativeKeys = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']
    // CoreFoundation initializes this entry independently when a macOS child starts.
    if (process.platform === 'darwin') nativeKeys.push('__CF_USER_TEXT_ENCODING')
    expect(value.childKeys.filter(key => !nativeKeys.includes(key.toUpperCase()))).toEqual([])
  })

  it.skipIf(process.platform !== 'win32' || !sandboxUsable)('uses the common Windows grant lock and private native temp without exposing ambient values', async () => {
    const { run, root } = await setup({}, 'workspace-write')
    const temp = join(root, 'node-temp')
    const tmp = join(root, 'win32-temp')
    await mkdir(temp)
    await mkdir(tmp)
    onTestFinished(() => { vi.unstubAllEnvs() })
    vi.stubEnv('TEMP', temp)
    vi.stubEnv('TMP', tmp)
    vi.stubEnv('DSH_TEST_RUNTIME_SECRET', 'must-not-inherit')
    const childCode = 'const fs=require("node:fs"); const path=require("node:path"); const temp=require("node:os").tmpdir(); const file=path.join(temp,"native-temp.txt"); fs.writeFileSync(file,"native-temp"); fs.writeFileSync("native-observation.json",JSON.stringify({file,temp,env:Object.keys(process.env)}));'
    const result = await run({
      program: `const {spawnSync}=await import("node:child_process"); const child=spawnSync(process.execPath,["-e",${JSON.stringify(childCode)}],{stdio:"inherit"}); if(child.status!==0) throw new Error(child.error?.message ?? "native child failed"); const native=JSON.parse((await import("node:fs")).readFileSync("native-observation.json","utf8")); return {env:Object.keys(process.env),native,observed:await tools.inspect({path:native.file})};`,
      bindings: bindings({ inspect: async (args) => {
        const path = (args as { path: string }).path
        expect(path.startsWith(`${temp}\\dsh-`)).toBe(true)
        return await readFile(path, 'utf8')
      } }),
    })
    expect(result.error).toBeUndefined()
    const value = result.value as { env: string[]; native: { env: string[]; temp: string }; observed: string }
    expect(value.env).toEqual([])
    expect(value.native.env).not.toContain('DSH_TEST_RUNTIME_SECRET')
    expect(value.native.temp.startsWith(`${temp}\\dsh-`)).toBe(true)
    expect(value.observed).toBe('native-temp')
    expect((await readdir(join(tmp, 'dsh-acl-locks'))).some(name => name.endsWith('.lock'))).toBe(true)
  })

  it('returns binding values and preserves typed binding rejection', async () => {
    const { run } = await setup()
    const result = await run({
      program: 'const value = await tools.echo({ n: 42 }); let rejected; try { await tools.fail({}) } catch (e) { rejected = [e instanceof ToolCallError,e.name,e.toolName,e.message]; } return {value,rejected};',
      bindings: bindings({ echo: async args => args as { n: number }, fail: async () => { throw new Error('denied') } }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({ value: { n: 42 }, rejected: [true, 'ToolCallError', 'fail', 'denied'] })
  })

  it('retains raw native stdout and stderr separately from control frames', async () => {
    const { run } = await setup()
    const result = await run({ program: 'const fs = await import("node:fs"); fs.writeSync(1,"native-out你好"); fs.writeSync(2,"native-err🙂"); return 42;', bindings: [] })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe(42)
    expect(result.logs.join('')).toContain('native-out你好')
    expect(result.logs.join('')).toContain('native-err🙂')
  })

  it.each(['throw new Error("broken")', 'enum E { A }'])('reports program failure for %s', async (program) => {
    const { run } = await setup()
    expect((await run({ program, bindings: [] })).error?.kind).toBe('exception')
  })

  it('rejects lossy program output', async () => {
    const { run } = await setup()
    expect((await run({ program: 'return { value: undefined }', bindings: [] })).error?.kind).toBe('invalid-output')
  })

  it('enforces the combined output cap', async () => {
    const { run } = await setup({ maxOutputBytes: 80 })
    const result = await run({ program: 'console.log("x".repeat(500)); return 42;', bindings: [] })
    expect(result.error?.kind).toBe('output-limit')
    const bytes = Buffer.byteLength(JSON.stringify(result.logs)) + Buffer.byteLength(JSON.stringify(result.error?.message))
    expect(bytes).toBeLessThanOrEqual(80)
  })

  it('uses the default deadline and caps explicit requests', async () => {
    const { runtime } = await setup()
    expect(runtime.timeout).toEqual({ defaultMs: 120_000, maxMs: 600_000 })
    expect(runtime.executionInstructions).toBe('Each call runs in a fresh Node process. Node APIs are available through await import(...). Relative paths use the supplied working directory; process.env starts empty. Direct filesystem access follows this execution\'s sandbox policy.')
    expect(runtime.resolve({ program: '', bindings: [] }).timeoutMs).toBe(120_000)
    expect(runtime.resolve({ program: '', bindings: [], timeoutMs: 900_000 }).timeoutMs).toBe(600_000)
    expect(runtime.resolve({ program: '', bindings: [], timeoutMs: null }).timeoutMs).toBeNull()
    for (const timeoutMs of [0, -1, NaN, Infinity]) expect(() => runtime.resolve({ program: '', bindings: [], timeoutMs })).toThrow()
    await expect(runtime.run({ program: '', bindings: [], cwd: process.cwd(), timeoutMs: 1000 })).rejects.toThrow('sandbox policy')
  })

  it('advertises the capped default when the deployment maximum is lower', async () => {
    const { runtime } = await setup({ timeoutMs: 2000, maxTimeoutMs: 1000 })
    expect(runtime.timeout).toEqual({ defaultMs: 1000, maxMs: 1000 })
    expect(runtime.timeout.defaultMs).toBe(runtime.resolve({ program: '', bindings: [] }).timeoutMs)
  })

  it.each(['for (;;) {}', 'await new Promise(() => {})'])('ends an unfinished program at its elapsed deadline: %s', async (program) => {
    const { run } = await setup({ timeoutMs: 600, graceMs: 50 })
    expect((await run({ program, bindings: [] })).error?.kind).toBe('timeout')
  })

  it('retains console output emitted immediately before a non-yielding program', async () => {
    const { run } = await setup({ timeoutMs: 1000, graceMs: 50 })
    const result = await run({ program: 'console.log("before hot loop"); for (;;) {}', bindings: [] })
    expect(result.error?.kind).toBe('timeout')
    expect(result.logs).toEqual(['before hot loop'])
  })

  it('does not pause the deadline while a binding is pending', async () => {
    const { run } = await setup({ timeoutMs: 1000, graceMs: 50 })
    const result = await run({ program: 'void tools.wait({}); for (;;) {}', bindings: bindings({ wait: () => new Promise(() => {}) }) })
    expect(result.error?.kind).toBe('timeout')
  })

  it.each([{}, { timeoutMs: null }] as const)('cancels a live program and closes its managed process with %j', async (timing) => {
    const { run } = await setup()
    const entered = Promise.withResolvers<undefined>()
    const controller = new AbortController()
    const active = run({ ...timing, program: 'void tools.enter({}); for (;;) {}', signal: controller.signal, bindings: bindings({ enter: async () => { entered.resolve(undefined); return null } }) })
    await entered.promise
    controller.abort('stop')
    expect((await active).error).toEqual({ kind: 'abort', message: 'stop' })
  })

  it('closes a still-running descendant before returning the program result', async () => {
    const { run } = await setup()
    const connected = Promise.withResolvers<undefined>()
    const disconnected = Promise.withResolvers<undefined>()
    let peer: Socket | undefined
    const server = createServer((socket) => {
      peer = socket
      // A terminated peer can reset its connection instead of sending FIN.
      socket.on('error', () => {})
      socket.once('close', () => { disconnected.resolve(undefined) })
      connected.resolve(undefined)
    })
    onTestFinished(async () => {
      peer?.destroy()
      if (server.listening) await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve() })
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('expected bound TCP listener')
    const child = `require('node:net').connect(${address.port},'127.0.0.1')`
    const result = await run({
      program: `const {spawn}=await import("node:child_process"); spawn(process.execPath,["-e",${JSON.stringify(child)}],{stdio:"ignore"}); await tools.connected({}); return 42;`,
      bindings: bindings({ connected: async () => { await connected.promise; return null } }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe(42)
    await disconnected.promise
  })

  it('applies the configured V8 old-generation ceiling to each fresh Node process', async () => {
    const limits: number[] = []
    for (const maxOldGenerationSizeMb of [32, 64]) {
      const { run } = await setup({ maxOldGenerationSizeMb })
      const result = await run({ program: 'return (await import("node:v8")).getHeapStatistics().heap_size_limit;', bindings: [] })
      expect(result.error).toBeUndefined()
      if (typeof result.value !== 'number') throw new Error('expected V8 heap limit')
      limits.push(result.value)
    }
    expect(Number(limits[1]) - Number(limits[0])).toBe(32 * 1024 * 1024)
  })

  it.each([{}, { timeoutMs: null }] as const)('disposes active programs and rejects later execution with %j', async (timing) => {
    const { ctx, run, runtime } = await setup()
    const spec = runtime.resolve({ program: '', bindings: [] })
    const entered = Promise.withResolvers<undefined>()
    const active = run({ ...timing, program: 'await tools.enter({}); await new Promise(() => {})', bindings: bindings({ enter: async () => { entered.resolve(undefined); return null } }) })
    await entered.promise
    await ctx.fiber.dispose()
    expect((await active).error?.kind).toBe('abort')
    await expect(runtime.run(spec)).rejects.toThrow('disposal')
    expect(() => runtime.resolve({ program: '', bindings: [] })).toThrow('disposal')
    expect(runtime.isolation).toBe('process')
  })

  it.each([
    'const fs = await import("node:fs"); const b=Buffer.alloc(4); b.writeUInt32BE(4294967295); fs.writeSync(7,b); await new Promise(()=>{});',
    'const fs = await import("node:fs"); const body=Buffer.from(JSON.stringify({type:"call",id:1,global:"tools",name:"undeclared",args:[]})); const h=Buffer.alloc(4); h.writeUInt32BE(body.length); fs.writeSync(7,Buffer.concat([h,body])); await new Promise(()=>{});',
  ])('refuses hostile program control traffic', async (program) => {
    const { run } = await setup()
    expect((await run({ program, bindings: [] })).error?.kind).toBe('protocol')
  })

  it.skipIf(!sandboxUsable)('applies read-only confinement to direct Node filesystem writes', async () => {
    const { run, cwd } = await setup({}, 'read-only')
    const path = join(cwd, 'denied.txt')
    const result = await run({ program: `await (await import('node:fs/promises')).writeFile(${JSON.stringify(path)}, 'denied')`, bindings: [] })
    expect(result.error?.kind).toBe('exception')
    expect(result.sandbox).toMatchObject({ mode: 'read-only', denied: true })
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.skipIf(process.platform === 'win32' || !sandboxUsable)('starts a confining launcher found only through the execution PATH', async () => {
    const { ctx, runtime, run, root } = await setup({}, 'read-only')
    const confine = ctx.sandbox.confine.bind(ctx.sandbox)
    const policy = runtime.resolve({ program: '', bindings: [] }).sandboxPolicy
    if (policy === undefined || policy.mode === 'danger-full-access') throw new Error('expected confined policy')
    const wrapped = await confine([process.execPath, '--version'], { ...policy, mode: policy.mode })
    const original = wrapped.argv[0]
    if (original === undefined) throw new Error('expected sandbox launcher')
    const executable = await ctx.subprocess.resolveExecutable(original)
    const alias = 'ptc-private-sandbox-launcher'
    await symlink(executable, join(root, alias))
    const previousPath = process.env.PATH
    const substitute = vi.spyOn(ctx.sandbox, 'confine').mockImplementation(async (argv, selected, signal) => {
      const result = await confine(argv, selected, signal)
      return { ...result, argv: [alias, ...result.argv.slice(1)] }
    })
    try {
      process.env.PATH = `${root}${delimiter}${previousPath ?? ''}`
      const result = await run({ program: 'return { env: Object.keys(process.env) };', bindings: [] })
      expect(result.error).toBeUndefined()
      expect(result.value).toEqual({ env: [] })
    } finally {
      substitute.mockRestore()
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
  })

  it.skipIf(!sandboxUsable)('permits workspace writes and denies a symlink to a sibling outside it', async () => {
    const { run, cwd, root } = await setup({}, 'workspace-write')
    const target = join(cwd, 'allowed.txt')
    expect((await run({ program: `await (await import('node:fs/promises')).writeFile(${JSON.stringify(target)}, 'allowed'); return true`, bindings: [] })).value).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('allowed')
    const outside = join(root, 'outside')
    await mkdir(outside)
    await symlink(outside, join(cwd, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    const result = await run({ program: `await (await import('node:fs/promises')).writeFile(${JSON.stringify(join(cwd, 'escape', 'denied.txt'))}, 'denied')`, bindings: [] })
    expect(result.error?.kind).toBe('exception')
    expect(result.sandbox).toMatchObject({ mode: 'workspace-write', denied: true })
    await expect(readFile(join(outside, 'denied.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

it('preserves empty console entries and bounds native output overflow', async () => {
  const { run } = await setup({ maxOutputBytes: 100 })
  const lines = await run({ program: 'console.log("a"); console.log(""); console.log("b")', bindings: [] })
  expect(lines.logs).toEqual(['a', '', 'b'])
  const overflow = await run({ program: 'const fs=await import("node:fs"); fs.writeSync(1,"HEAD-"+"x".repeat(100000));', bindings: [] })
  expect(overflow.error?.kind).toBe('output-limit')
  expect(overflow.logs.join('')).toContain('HEAD-')
  const bytes = Buffer.byteLength(JSON.stringify(overflow.logs)) + Buffer.byteLength(JSON.stringify(overflow.error?.message))
  expect(bytes).toBeLessThanOrEqual(100)
})
