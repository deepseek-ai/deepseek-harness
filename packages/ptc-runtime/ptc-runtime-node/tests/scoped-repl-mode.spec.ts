import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished } from 'vitest'
import { resolvePersistentExecution } from '../src/configuration.ts'
import { mountRuntime } from './setup.ts'

async function scopedReplRuntime() {
  const { runtime } = await mountRuntime(new Context(), { executionMode: 'persistent-in-memory', replScoped: true })
  const stateOwner = {}
  const run = (program: string) => runtime.run(runtime.resolve({ program, bindings: [], stateOwner }))
  return { runtime, stateOwner, run }
}

it('advertises retained scoped REPL syntax with its complete model guidance', async () => {
  const { runtime } = await scopedReplRuntime()
  expect(runtime.programFormat).toBe('scoped-repl')
  expect(runtime.retainsState).toBe(true)
  expect(runtime.executionInstructions).toBe(
    'The program contains TypeScript REPL statements; only erasable syntax is accepted, with no enum or namespaces. Type annotations are advisory. '
    + 'Top-level declarations and await are supported; top-level return is not supported. '
    + 'Use inspect(...values) to display output. Do not use console. '
    + 'The program runs in strict mode: assigning an undeclared name throws, so use globalThis for intentional globals; eval and new Function are unavailable. '
    + 'Variables, functions, and imported modules remain in memory for this Agent across calls. '
    + 'Each call starts with copies of the top-level bindings left by earlier calls and may declare any of those names again with any keyword. '
    + 'A new declaration applies to this and later calls; functions and still-running code from earlier calls keep the values they captured. '
    + 'Assigning to an earlier name without declaring it, even one declared with const, changes only the copy seen by this and later calls. '
    + 'A let, const, or class declaration cannot read the earlier value of its own name, so let total = total + 1 throws; '
    + 'assign to the name or use a new name instead. A var declaration of an earlier name starts from the earlier value. '
    + 'var declarations become top-level names of the call even inside blocks; other declarations inside blocks stay in their block. '
    + 'Assignments that earlier code makes later, such as from timers, are not visible to later calls; keep shared mutable state in objects. '
    + "If a call fails before a let, const, class, or var declaration of an existing name finishes, later calls keep that name's earlier value. "
    + "Use await import(...) for modules; require is unavailable, and relative specifiers resolve from the working directory of this environment's first call. "
    + "Direct filesystem access follows the environment's launch-time sandbox policy; process.env starts empty. "
    + 'Timeout and cancellation results say whether retained variables were preserved or cleared. '
    + 'Restart, sandbox changes, output overflow, or process failure clears them. '
    + 'Recreate missing variables and resources; conversation history does not restore state. Earlier mutations and tool effects are not rolled back. '
    + 'Approved sandbox escalations use a fresh environment and discard its variables afterward. Await tools and cleanup before returning; unfinished tools reject. '
    + 'After completion, timeout, or cancellation, new tool calls are rejected and captured output is discarded; background work may still change state. '
    + 'Await child-process completion before returning; raw output belongs to the active evaluation.',
  )
})

it.each([
  { executionMode: 'per-call' as const },
  { executionMode: 'vm-script' as const },
  { executionMode: 'vm-script' as const, scriptPersistence: true },
])('rejects replScoped with configuration %j', async (config) => {
  await expect(mountRuntime(new Context(), { ...config, replScoped: true })).rejects.toThrow('replScoped requires executionMode: persistent-in-memory')
})

it('keeps scoped REPL when profile editors merge retained execution settings', async () => {
  expect(resolvePersistentExecution('scoped-repl')).toEqual({ executionMode: 'persistent-in-memory', scriptPersistence: false, replScoped: true })
  const { runtime } = await mountRuntime(new Context(), resolvePersistentExecution('scoped-repl'))
  expect(runtime.programFormat).toBe('scoped-repl')
})

it('redeclares names across calls in one retained process while earlier closures keep their bindings', async () => {
  const { runtime, stateOwner, run } = await scopedReplRuntime()
  expect(await run('const value: number = 1\nconst read = () => value\nvalue')).toMatchObject({ output: [], value: 1 })
  expect(await run('const value = 2\nlet counter = 0\ninspect("redeclared")\nvalue')).toMatchObject({ output: [{ type: 'text', text: 'redeclared\n' }], value: 2 })
  expect(await run('counter = counter + 1;\n[value, read(), counter]')).toMatchObject({ value: [2, 1, 1] })
  expect((await run('return 1')).error?.message).toContain('Return statement is not allowed here')
  await runtime.release(stateOwner)
  expect(await run('typeof value')).toMatchObject({ value: 'undefined' })
})

it('contains asynchronous callback failures like the REPL and keeps retained variables', async () => {
  const { run } = await scopedReplRuntime()
  const failed = await run('let retained = 17\nsetTimeout(() => { throw new Error("async failure") }, 0)\nawait new Promise(resolve => setTimeout(resolve, 20))\nretained')
  expect(failed.error?.message).toContain('Uncaught Error: async failure')
  expect(await run('retained')).toMatchObject({ value: 17 })
  expect(await run('setTimeout(() => { Promise.reject(new Error("late")) }, 0)\nglobalThis.later = true')).toMatchObject({ value: true })
  expect(await run('await new Promise(resolve => setTimeout(resolve, 20))\nretained')).toMatchObject({ value: 17 })
})

it('lets later calls assign to an earlier const and keeps declarations that finished before a failure', async () => {
  const { run } = await scopedReplRuntime()
  expect(await run('const limit = 1\nconst readLimit = () => limit\nlimit')).toMatchObject({ value: 1 })
  expect(await run('limit = 2;\n[limit, readLimit()]')).toMatchObject({ value: [2, 1] })
  expect((await run('let done = 1\nconst limit = await Promise.reject(new Error("tool failed"))')).error?.message).toContain('tool failed')
  expect(await run('[limit, done]')).toMatchObject({ value: [2, 1] })
})

it('reports an asynchronous failure whose error cannot be rendered without ending the process', async () => {
  const { run } = await scopedReplRuntime()
  const failed = await run('let retained = 17\nsetTimeout(() => { const error = new Error("x"); Object.defineProperty(error, "stack", { get() { throw new Error("stack") } }); throw error }, 0)\nawait new Promise(resolve => setTimeout(resolve, 20))\nretained')
  expect(failed.error).toMatchObject({ kind: 'exception', message: 'Uncaught program threw an unrenderable value' })
  expect(await run('retained')).toMatchObject({ value: 17 })
})

it('rejects code containing the reserved prefix before running it', async () => {
  const { run } = await scopedReplRuntime()
  expect((await run('globalThis.ran = true\ntypeof __$binding_getters')).error?.message).toContain("Names starting with '__$binding_' are reserved")
  expect(await run('typeof ran')).toMatchObject({ value: 'undefined' })
})

it('passes a host binding named module through to the program', async () => {
  const { runtime, stateOwner } = await scopedReplRuntime()
  const result = await runtime.run(runtime.resolve({ program: 'await module.answer({})', bindings: [{ global: 'module', functions: { answer: async () => 42 } }], stateOwner }))
  expect(result).toMatchObject({ value: 42 })
})

it('rejects a hashbang line before running the program', async () => {
  const { run } = await scopedReplRuntime()
  expect((await run('#!/usr/bin/env node\n1')).error?.message).toContain('Hashbang lines are not supported')
})

it('does not charge an earlier call\'s asynchronous failure to a later call', async () => {
  const { run } = await scopedReplRuntime()
  // The earlier call's timer fires while the later call is running.
  expect(await run('setTimeout(() => { throw new Error("stale") }, 30)\nlet kept = 1')).toMatchObject({ output: [] })
  expect(await run('await new Promise(resolve => setTimeout(resolve, 100))\nkept')).toMatchObject({ value: 1 })
  expect((await run('kept')).error).toBeUndefined()
})

it('keeps a var declared inside a block of a later call, also when an earlier call declared the name with const', async () => {
  const { run } = await scopedReplRuntime()
  await run('const data = { retries: 1 }')
  expect(await run('try {\n  var data = await Promise.resolve({ retries: 3 })\n} catch (error) {}\ndata.retries')).toMatchObject({ value: 3 })
  expect(await run('data.retries')).toMatchObject({ value: 3 })
})

it('keeps an earlier value when a tool fails inside a later var redeclaration of that name', async () => {
  const { runtime, stateOwner } = await scopedReplRuntime()
  const run = (program: string) => runtime.run(runtime.resolve({
    program, stateOwner,
    bindings: [{ global: 'tools', functions: { loadConfig: async () => { throw new Error('config service unavailable') } } }],
  }))
  expect((await run('var config = { retries: 1 }')).error).toBeUndefined()
  expect((await run('var config = await tools.loadConfig({})\nconfig.retries')).error?.message).toContain('config service unavailable')
  expect(await run('config.retries')).toMatchObject({ value: 1 })
})

it('runs environment initialization once and carries its top-level bindings into later calls', async () => {
  const { runtime, stateOwner, run } = await scopedReplRuntime()
  runtime.registerEnvironmentInitializer('globalThis.fromInit = 1\nconst initConst = 2\ninspect("initialized")')
  expect(await run('inspect(fromInit, initConst)\nconst derived = initConst + 1')).toMatchObject({
    output: [{ type: 'text', text: 'initialized\n' }, { type: 'text', text: '1 2\n' }],
  })
  expect(await run('const initConst = 5\ninspect(initConst, derived)')).toMatchObject({ output: [{ type: 'text', text: '5 3\n' }] })
  await runtime.release(stateOwner)
})

it('keeps Node experimental warnings from an initializer import out of program output while program warnings still print', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-scoped-repl-warning-'))
  onTestFinished(async () => { await rm(directory, { recursive: true, force: true }) })
  await writeFile(join(directory, 'dependency.mjs'), 'export const value = 1')
  const { runtime, stateOwner, run } = await scopedReplRuntime()
  runtime.registerEnvironmentInitializer(`globalThis.dependency = await import(${JSON.stringify(pathToFileURL(join(directory, 'dependency.mjs')).href)})`)
  expect(await run('inspect(dependency.value)')).toMatchObject({ output: [{ type: 'text', text: '1\n' }] })
  const warned = await run('process.emitWarning("program warning")\nawait new Promise(resolve => setTimeout(resolve, 50))')
  expect(warned.output?.map(entry => entry.type === 'text' ? entry.text : '').join('')).toContain('Warning: program warning')
  await runtime.release(stateOwner)
})
