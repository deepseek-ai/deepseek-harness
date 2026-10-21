import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Duplex, PassThrough } from 'node:stream'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createProgramEvaluator } from '../src/evaluators/index.ts'
import type { ProgramEvaluator, ProgramFormat, ProgramImportHandler, ProgramImportRequest, ProgramImportResult } from '../src/evaluators/types.ts'
import { JsonChannel } from '../src/channel.ts'
import { decodePtcJsonWire } from '../src/json-wire.ts'
import { runNodeMain } from '../src/process.ts'
import { runPersistentMain } from '../src/persistent-process.ts'
import { runProgram } from '../src/bootstrap.ts'
import type { ProgramBootData, ProgramToHost } from '../src/protocol.ts'

type EvaluationResult = Parameters<Parameters<ProgramEvaluator['evaluate']>[1]>[0]
const formats = ['function-body', 'script', 'repl'] as const

function evaluator(format: ProgramFormat, handler?: ProgramImportHandler) {
  const instance = createProgramEvaluator(format, () => {}, handler)
  onTestFinished(() => { instance.close() })
  const run = (code: string) => new Promise<EvaluationResult>((resolve) => {
    try { instance.evaluate(code, resolve) } catch (error: unknown) { resolve({ ok: false, error }) }
  })
  const value = async (code: string): Promise<unknown> => {
    const result = await run(code)
    if (!result.ok) throw result.error
    return result.value
  }
  const expression = (source: string) => value(`${format === 'function-body' ? 'return ' : ''}${source}`)
  return { ...instance, run, value, expression }
}

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ptc-imports-'))
  onTestFinished(async () => { await rm(directory, { recursive: true, force: true }) })
  return realpath(directory)
}

async function moduleFixture(files: Record<string, string>) {
  const directory = await temporaryDirectory()
  await Promise.all(Object.entries(files).map(async ([name, source]) => {
    const path = join(directory, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, source)
  }))
  return { directory, url: (name: string) => pathToFileURL(join(directory, name)).href }
}

it('intercepts ESM package imports, re-exports, redirects and retained dynamic imports with their own filenames', async () => {
  const fixture = await moduleFixture({
    'entry.mjs': 'export * from "fixture-package"',
    'node_modules/fixture-package/package.json': JSON.stringify({ type: 'module', exports: { import: './index.js', require: './missing.cjs' } }),
    'node_modules/fixture-package/index.js': `
      import { counter, Counter } from 'runner:static';
      export { read } from 'runner:redirect';
      export { counter, Counter };
      export const next = () => counter.next();
      export const later = async () => (await import('./lazy.mjs')).run();
      export const metadata = [import.meta.url, import.meta.filename, import.meta.dirname, import.meta.main, import.meta.resolve('./lazy.mjs')];
    `,
    'node_modules/fixture-package/read.mjs': 'import { counter } from "runner:redirected"; export const read = () => counter.value',
    'node_modules/fixture-package/lazy.mjs': `
      import { counter } from 'runner:lazy-static';
      export async function run() {
        const { counter: again } = await import('runner:dynamic');
        return [counter === again, again.next()];
      }
    `,
  })
  class Counter { value = 0; next() { return ++this.value } }
  const counter = new Counter()
  const exports = { counter, Counter }
  const requests: ProgramImportRequest[] = []
  const e = evaluator('script', async (request) => {
    requests.push(request)
    if (request.specifier === 'runner:redirect') return { type: 'redirect', specifier: './read.mjs' }
    return request.specifier.startsWith('runner:') ? { type: 'module', exports } : { type: 'default' }
  })
  e.globals.expected = counter
  await e.value(`var imported = await import(${JSON.stringify(fixture.url('entry.mjs'))})`)
  expect(await e.expression('[imported.counter === expected, imported.counter instanceof imported.Counter, imported.next(), imported.read()]'))
    .toEqual([true, true, 1, 1])
  expect(await e.expression('imported.later()')).toEqual([true, 2])
  const packagePath = join(fixture.directory, 'node_modules/fixture-package')
  expect(await e.expression('imported.metadata')).toEqual([
    fixture.url('node_modules/fixture-package/index.js'), join(packagePath, 'index.js'), packagePath, false,
    fixture.url('node_modules/fixture-package/lazy.mjs'),
  ])
  for (const [specifier, file] of [
    ['runner:static', 'index.js'], ['runner:redirect', 'index.js'], ['runner:redirected', 'read.mjs'],
    ['runner:lazy-static', 'lazy.mjs'], ['runner:dynamic', 'lazy.mjs'],
  ] as const) {
    expect(requests).toContainEqual({ specifier, referrer: join(packagePath, file), attributes: {} })
  }
})

it('shares an ESM evaluation while concurrent imports wait for its top-level await', async () => {
  const fixture = await moduleFixture({
    'entry.mjs': 'export { answer } from "./shared.mjs"',
    'shared.mjs': 'globalThis.entered(); await globalThis.release; globalThis.executions++; export const answer = 42',
  })
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  const release: PromiseWithResolvers<void> = Promise.withResolvers()
  onTestFinished(() => { release.resolve() })
  const e = evaluator('script', () => ({ type: 'default' }))
  Object.assign(e.globals, { entered: entered.resolve, release: release.promise, executions: 0 })
  const result = e.expression(`Promise.all([import(${JSON.stringify(fixture.url('entry.mjs'))}), import(${JSON.stringify(fixture.url('shared.mjs'))})]).then(values => values.map(m => m.answer))`)
  await entered.promise
  expect(e.globals.executions).toBe(0)
  release.resolve()
  expect(await result).toEqual([42, 42])
  expect(e.globals.executions).toBe(1)
})

it('links ESM cycles and allows top-level await imports outside a waiting cycle', async () => {
  const fixture = await moduleFixture({
    'a.mjs': 'import { b } from "./b.mjs"; export const a = () => "a"; export const answer = b()',
    'b.mjs': 'import { a } from "./a.mjs"; export const b = () => "b" + a()',
    'await.mjs': 'import { answer } from "./a.mjs"; export const result = (await import("./a.mjs")).answer + answer',
  })
  const e = evaluator('script', () => ({ type: 'default' }))
  expect(await e.expression(`(await import(${JSON.stringify(fixture.url('await.mjs'))})).result`)).toBe('baba')
})

it('isolates file ESM caches and globals between Script evaluators', async () => {
  const fixture = await moduleFixture({ 'entry.mjs': 'import { value } from "runner:value"; globalThis.executions++; export { value }' })
  const first = evaluator('script', ({ specifier }) => specifier === 'runner:value' ? { type: 'module', exports: { value: 1 } } : { type: 'default' })
  const second = evaluator('script', ({ specifier }) => specifier === 'runner:value' ? { type: 'module', exports: { value: 2 } } : { type: 'default' })
  first.globals.executions = 0
  second.globals.executions = 0
  const code = `import(${JSON.stringify(fixture.url('entry.mjs'))}).then(m => m.value)`
  expect(await Promise.all([first.expression(code), first.expression(code), second.expression(code)])).toEqual([1, 1, 2])
  expect(first.globals.executions).toBe(1)
  expect(second.globals.executions).toBe(1)
})

it('retains failed ESM linking and evaluation without affecting unrelated imports', async () => {
  const fixture = await moduleFixture({
    'link.mjs': 'import "runner:denied"; globalThis.executions++',
    'evaluate.mjs': 'globalThis.executions++; throw globalThis.failure',
    'good.mjs': 'export const answer = 42',
  })
  const failure = new Error('denied ESM dependency')
  const handler = vi.fn(({ specifier }: ProgramImportRequest): ProgramImportResult => {
    if (specifier === 'runner:denied') throw failure
    return { type: 'default' }
  })
  const e = evaluator('script', handler)
  Object.assign(e.globals, { failure, executions: 0 })
  for (let index = 0; index < 2; index++) {
    for (const name of ['link.mjs', 'evaluate.mjs']) {
      expect(await e.expression(`import(${JSON.stringify(fixture.url(name))}).catch(error => error === failure)`)).toBe(true)
    }
  }
  expect(e.globals.executions).toBe(1)
  expect(handler.mock.calls.filter(([request]) => request.specifier === 'runner:denied')).toHaveLength(1)
  expect(await e.expression(`(await import(${JSON.stringify(fixture.url('good.mjs'))})).answer`)).toBe(42)
})

it('rejects pending ESM dependencies after cleanup without evaluating their exports or parent', async () => {
  const fixture = await moduleFixture({ 'entry.mjs': 'import { answer } from "runner:pending"; globalThis.executed = answer' })
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  const released = Promise.withResolvers<ProgramImportResult>()
  const read = vi.fn(() => 42)
  onTestFinished(() => { released.resolve({ type: 'module', exports: {} }) })
  const e = evaluator('script', ({ specifier }) => {
    if (specifier !== 'runner:pending') return { type: 'default' }
    entered.resolve()
    return released.promise
  })
  const result = e.expression(`import(${JSON.stringify(fixture.url('entry.mjs'))}).catch(error => error.message)`)
  await entered.promise
  e.close()
  released.resolve({ type: 'module', exports: Object.defineProperty({}, 'answer', { enumerable: true, get: read }) })
  expect(await result).toBe('PTC evaluator closed before its import completed')
  expect(read).not.toHaveBeenCalled()
  expect(e.globals.executed).toBeUndefined()
})

it('links native builtins, CommonJS and JSON into ESM while rejecting ESM import attributes', async () => {
  const fixture = await moduleFixture({
    'entry.mjs': 'import path from "node:path"; import cjs from "./native.cjs"; import implicit from "./native.js"; import explicit from "./common/index.js"; import json from "./answer.json" with { type: "json" }; export const answer = [path.basename("/a/b"), cjs.value, implicit.value, explicit.value, json.value]',
    'native.cjs': 'module.exports = { value: 17 }',
    'native.js': 'module.exports = { value: 18 }',
    'common/package.json': '{"type":"commonjs"}',
    'common/index.js': 'module.exports = { value: 19 }',
    'answer.json': '{"value":42}',
  })
  const e = evaluator('script', () => ({ type: 'default' }))
  expect(await e.expression(`import(${JSON.stringify(fixture.url('entry.mjs'))}, { with: { type: 'json' } }).catch(error => error.message)`))
    .toContain('PTC ESM imports do not accept import attributes')
  expect(await e.expression(`(await import(${JSON.stringify(fixture.url('entry.mjs'))})).answer`)).toEqual(['b', 17, 18, 19, 42])
})

it('uses one handler decision for repeated static requests for the same module', async () => {
  const fixture = await moduleFixture({
    'entry.mjs': 'import { first } from "runner:state"; import { second } from "runner:state"; export { third } from "runner:state"; export const values = [first, second]',
  })
  let decisions = 0
  const e = evaluator('script', ({ specifier }) => {
    if (specifier !== 'runner:state') return { type: 'default' }
    const value = ++decisions
    return { type: 'module', exports: { first: value, second: value, third: value } }
  })
  expect(await e.expression(`import(${JSON.stringify(fixture.url('entry.mjs'))}).then(m => [...m.values, m.third])`)).toEqual([1, 1, 1])
  expect(decisions).toBe(1)
})

it.each(['import source module from "node:fs"', 'await import.source("node:fs")'])('rejects a dependency source phase before its handler: %s', async (source) => {
  const fixture = await moduleFixture({ 'entry.mjs': source })
  const handler = vi.fn((): ProgramImportResult => ({ type: 'default' }))
  const e = evaluator('script', handler)
  expect(await e.expression(`import(${JSON.stringify(fixture.url('entry.mjs'))}).catch(error => error.message)`))
    .toBe('PTC importHandler supports evaluation-phase imports only')
  expect(handler).toHaveBeenCalledTimes(1)
})

it('retains ESM read and parse failures until the evaluator is recreated', async () => {
  const fixture = await moduleFixture({ 'invalid.mjs': 'export const =' })
  const e = evaluator('script', () => ({ type: 'default' }))
  const missing = `import(${JSON.stringify(fixture.url('missing.mjs'))}).catch(error => error.code)`
  const invalid = `import(${JSON.stringify(fixture.url('invalid.mjs'))}).catch(error => error.name)`
  expect(await e.expression(missing)).toBe('ENOENT')
  expect(await e.expression(invalid)).toBe('SyntaxError')
  await writeFile(join(fixture.directory, 'missing.mjs'), 'export const answer = 42')
  await writeFile(join(fixture.directory, 'invalid.mjs'), 'export const answer = 42')
  expect(await e.expression(missing)).toBe('ENOENT')
  expect(await e.expression(invalid)).toBe('SyntaxError')
  const fresh = evaluator('script', () => ({ type: 'default' }))
  expect(await fresh.expression(`(await import(${JSON.stringify(fixture.url('invalid.mjs'))})).answer`)).toBe(42)
})

it('keeps then exports callable from static ESM imports and assimilates them from dynamic imports', async () => {
  const fixture = await moduleFixture({
    'entry.mjs': 'import { then, answer } from "./then.mjs"; export const result = [typeof then, answer]',
    'then.mjs': 'export const answer = 42; export function then(resolve) { resolve(17) }',
  })
  const e = evaluator('script', () => ({ type: 'default' }))
  expect(await e.expression(`(await import(${JSON.stringify(fixture.url('entry.mjs'))})).result`)).toEqual(['function', 42])
  expect(await e.expression(`import(${JSON.stringify(fixture.url('then.mjs'))})`)).toBe(17)
})

it('retains live dynamic native bindings while static imports capture their exports', async () => {
  const source = 'data:text/javascript,export let value = 1; export function update() { value = 2 }'
  const fixture = await moduleFixture({ 'entry.mjs': `export { value } from ${JSON.stringify(source)}` })
  const e = evaluator('script', () => ({ type: 'default' }))
  expect(await e.expression(`(async () => {
    const captured = await import(${JSON.stringify(fixture.url('entry.mjs'))});
    const module = await import(${JSON.stringify(source)});
    module.update();
    return [captured.value, module.value];
  })()`)).toEqual([1, 2])
})

it.each(formats)('preserves runner objects, closures, constructors and non-JSON values in %s', async (format) => {
  class Counter { #count = 0; next() { return ++this.#count } }
  const counter = new Counter()
  const cyclic: { self?: object } = {}
  cyclic.self = cyclic
  const symbol = Symbol('runner')
  const exports = {
    Counter, counter, alias: counter, cyclic, symbol, missing: undefined,
    map: new Map([['answer', 42]]), twice: (value: number) => value * 2,
    default: counter, ['__proto__']: 'ordinary export', 'odd-name': 17,
  }
  const e = evaluator(format, () => ({ type: 'module', exports }))
  e.globals.expected = counter
  expect(await e.expression(`import('runner:objects').then(m => [
    m.counter === expected, m.counter === m.alias, m.counter === m.default,
    m.counter instanceof m.Counter, m.counter.next(), m.twice(21),
    m.cyclic.self === m.cyclic, m.map.get('answer'), typeof m.symbol,
    Object.hasOwn(m, 'missing'), m.missing === undefined, m.__proto__, m['odd-name'],
  ])`)).toEqual([true, true, true, true, 1, 42, true, 42, 'symbol', true, true, 'ordinary export', 17])
  expect(counter.next()).toBe(2)
})

it.each(formats)('reuses modules by exports identity and consults the handler on each import in %s', async (format) => {
  const object = { count: 1 }
  let exports = { version: 1, object }
  const handler = vi.fn((): ProgramImportResult => ({ type: 'module', exports }))
  const e = evaluator(format, handler)
  expect(await e.expression('Promise.all([import("runner:cached"), import("runner:alias")]).then(([a, b]) => a === b)')).toBe(true)
  exports.version = 2
  object.count = 3
  expect(await e.expression('import("runner:cached").then(m => [m.version, m.object.count])')).toEqual([1, 3])
  exports = { version: 4, object }
  expect(await e.expression('import("runner:cached").then(m => m.version)')).toBe(4)
  expect(handler).toHaveBeenCalledTimes(4)
})

it.each(formats)('delegates native imports and redirects with the original filename and attributes in %s', async (format) => {
  const directory = await temporaryDirectory()
  const first = join(directory, 'first')
  const second = join(directory, 'second')
  await Promise.all([mkdir(first), mkdir(second)])
  await Promise.all([
    writeFile(join(first, 'answer.json'), '{"answer":42}'),
    writeFile(join(second, 'answer.json'), '{"answer":17}'),
  ])
  const requests: ProgramImportRequest[] = []
  const e = evaluator(format, (request) => {
    requests.push(request)
    return request.specifier === 'runner:json' ? { type: 'redirect', specifier: './answer.json' } : { type: 'default' }
  })
  e.globals.holder = {}
  const cwd = process.cwd()
  try {
    process.chdir(first)
    await e.value('holder.load = () => import("runner:json", { with: { type: "json" } });')
    process.chdir(second)
    expect(await e.expression('holder.load().then(m => m.default.answer)')).toBe(42)
    expect(await e.expression('import("./answer.json", { with: { type: "json" } }).then(m => m.default.answer)')).toBe(17)
    expect(await e.expression('import("node:path").then(m => m.basename("/a/b"))')).toBe('b')
  } finally { process.chdir(cwd) }
  expect(requests).toEqual([
    { specifier: 'runner:json', referrer: join(first, 'ptc-program.js'), attributes: { type: 'json' } },
    { specifier: './answer.json', referrer: join(second, 'ptc-program.js'), attributes: { type: 'json' } },
    { specifier: 'node:path', referrer: join(second, 'ptc-program.js'), attributes: {} },
  ])
})

it.each(formats)('keeps rejection catchable without falling back to an installed module in %s', async (format) => {
  const e = evaluator(format, () => { throw new Error('import denied') })
  expect(await e.expression('import("node:path").then(() => "loaded", error => error.message)')).toBe('import denied')
  expect(await e.expression('1 + 2')).toBe(3)
})

it.each(formats)('retains a failed module evaluation for the same exports object in %s', async (format) => {
  const read = vi.fn(() => { throw new Error('export failed') })
  const exports = Object.defineProperty({}, 'value', { enumerable: true, get: read })
  const e = evaluator(format, () => ({ type: 'module', exports }))
  for (let index = 0; index < 2; index++) {
    expect(await e.expression('import("runner:failed").catch(error => error.message)')).toBe('export failed')
  }
  expect(read).toHaveBeenCalledTimes(1)
})

it.each(formats)('preserves JavaScript then-export assimilation in %s', async (format) => {
  const e = evaluator(format, () => ({ type: 'module', exports: { then(resolve: (value: number) => void) { resolve(42) } } }))
  if (format === 'repl') await expect(e.expression('import("runner:then")')).rejects.toThrow('Provided module is not an instance of Module')
  else expect(await e.expression('import("runner:then")')).toBe(42)
})

it.each(['default', 'redirect'] as const)('preserves native then-export results through Script %s loading', async (decision) => {
  const specifier = 'data:text/javascript,export function then(resolve) { resolve({ answer() { return 42 } }) }'
  const handler = vi.fn((): ProgramImportResult => decision === 'default' ? { type: 'default' } : { type: 'redirect', specifier })
  const e = evaluator('script', handler)
  expect(await e.expression(`(await import(${JSON.stringify(decision === 'default' ? specifier : 'runner:then')})).answer()`)).toBe(42)
  expect(handler).toHaveBeenCalledTimes(1)
})

it('keeps async-function grammar and parameter semantics when imports are intercepted', async () => {
  const e = evaluator('function-body', () => ({ type: 'default' }))
  e.globals.answer = 42
  expect(await e.expression('[this === undefined, arguments[0], answer, typeof unbound]')).toEqual([true, 42, 42, 'undefined'])
  expect(await e.run('}; return "escaped"; return async function(){')).toHaveProperty('error', expect.any(SyntaxError))
  expect(await e.run('undeclared = 1')).toHaveProperty('error', expect.any(ReferenceError))
})

it('awaits asynchronous import decisions and propagates rejections in Script', async () => {
  const exports = { answer: () => 42 }
  const e = evaluator('script', async ({ specifier }) => {
    if (specifier === 'runner:denied') throw new Error('import denied')
    return { type: 'module', exports }
  })
  expect(await e.expression('(await import("runner:async")).answer()')).toBe(42)
  expect(await e.expression('import("runner:denied").catch(error => error.message)')).toBe('import denied')
})

it('rejects imports after Script cleanup and ignores late handler results', async () => {
  const gate = Promise.withResolvers<ProgramImportResult>()
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  const handler = vi.fn(() => { entered.resolve(); return gate.promise })
  const e = evaluator('script', handler)
  const result = e.expression('import("runner:pending").catch(error => error.message)')
  await entered.promise
  e.close()
  gate.resolve({ type: 'module', exports: { answer: 42 } })
  expect(await result).toBe('PTC evaluator closed before its import completed')
  await expect(e.expression('import("runner:closed")')).rejects.toThrow('PTC evaluator is closed')
  expect(handler).toHaveBeenCalledTimes(1)
})

it('rejects Script source-phase imports before invoking an evaluation handler', async () => {
  const handler = vi.fn((): ProgramImportResult => ({ type: 'default' }))
  const e = evaluator('script', handler)
  expect(await e.expression('import.source("node:fs").catch(error => error.message)')).toBe('PTC importHandler supports evaluation-phase imports only')
  expect(handler).not.toHaveBeenCalled()
})

it.each(['function-body', 'repl'] as const)('rejects async handlers and consumes their rejected promises in %s', async (format) => {
  const e = evaluator(format, async () => { throw new Error('async handler failed') })
  expect(await e.expression('import("node:path").catch(error => error.message)'))
    .toBe('Native PTC imports require a synchronous importHandler')
})

it.each(['function-body', 'repl'] as const)('keeps simultaneous handlers isolated and releases global bridges on close in %s', async (format) => {
  const before = Object.getOwnPropertySymbols(globalThis)
  const first = evaluator(format, () => ({ type: 'module', exports: { value: 1 } }))
  const second = evaluator(format, () => ({ type: 'module', exports: { value: 2 } }))
  expect(await Promise.all([first.expression('import("runner:same").then(m => m.value)'), second.expression('import("runner:same").then(m => m.value)')]))
    .toEqual([1, 2])
  first.close()
  expect(await second.expression('import("runner:same").then(m => m.value)')).toBe(2)
  expect(await first.run('1')).toHaveProperty('error', expect.any(Error))
  second.close()
  expect(Object.getOwnPropertySymbols(globalThis)).toEqual(before)
})

it('retains import filenames for identical async-function bodies compiled in different directories', async () => {
  const directory = await temporaryDirectory()
  const first = join(directory, 'first')
  const second = join(directory, 'second')
  await Promise.all([mkdir(first), mkdir(second)])
  const e = evaluator('function-body', ({ referrer }) => ({ type: 'module', exports: { referrer } }))
  const functions: Array<() => Promise<{ referrer: string }>> = []
  e.globals.functions = functions
  const cwd = process.cwd()
  try {
    for (const path of [first, second]) {
      process.chdir(path)
      await e.value('functions.push(() => import("runner:origin"))')
    }
    expect(await Promise.all(functions.map(async load => (await load()).referrer)))
      .toEqual([join(first, 'ptc-program.js'), join(second, 'ptc-program.js')])
  } finally { process.chdir(cwd) }
})

async function runner(handler: ProgramImportHandler, retained = false, format: 'script' | 'repl' = 'script') {
  const first = new PassThrough()
  const second = new PassThrough()
  const child = Duplex.from({ readable: first, writable: second })
  const host = Duplex.from({ readable: second, writable: first })
  child.on('error', () => {})
  host.on('error', () => {})
  const state = { env: {}, stdout: { write: () => true }, stderr: { write: () => true }, chdir() {} }
  const ready: PromiseWithResolvers<void> = Promise.withResolvers()
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<Record<string, unknown>>>>()
  let sequence = 0
  const peer = new JsonChannel(host, 100_000, (raw) => {
    const message = raw as { type?: string; id: number; payload: Record<string, unknown> }
    if (message.type === 'ready') ready.resolve()
    else if (message.payload.type === 'done') pending.get(message.id)?.resolve(message.payload)
  }, (error) => { ready.reject(error); for (const completion of pending.values()) completion.reject(error) })
  const main = retained ? runPersistentMain(child, 100_000, state, format, handler) : runNodeMain(child, 100_000, state, format, handler)
  onTestFinished(async () => { peer.close(); child.destroy(); host.destroy(); await main })
  await ready.promise
  const run = async (code: string, programFormat: ProgramFormat = format) => {
    const id = ++sequence
    const completion = Promise.withResolvers<Record<string, unknown>>()
    pending.set(id, completion)
    await peer.send({ type: 'run', id, cwd: process.cwd(), data: { code, programFormat, namespaces: [], maxOutputBytes: 10_000 } satisfies ProgramBootData })
    const result = await completion.promise
    pending.delete(id)
    if (result.error) throw new Error(JSON.stringify(result.error))
    return decodePtcJsonWire(result.value)
  }
  return { run }
}

it.each([false, true])('uses the active evaluation when a retained function imports later (retained entry %s)', async (retained) => {
  let count = 0
  const r = await runner(() => ({ type: 'module', exports: { count: ++count } }), retained)
  await r.run('var saved = () => import("runner:current");')
  expect(await r.run('(await saved()).count')).toBe(1)
  expect(await r.run('(await saved()).count')).toBe(2)
})

it.each(['script', 'repl'] as const)('rejects a finished %s evaluation before a delayed import can invoke the handler', async (format) => {
  const handler = vi.fn((): ProgramImportResult => ({ type: 'default' }))
  const r = await runner(handler, false, format)
  await r.run('var resume; var late = new Promise(resolve => { resume = resolve }).then(() => import("node:path")).catch(error => error.message);')
  expect(await r.run('resume(); await late')).toBe('PTC evaluation has ended; import modules from a new run_code evaluation')
  expect(handler).not.toHaveBeenCalled()
})

it('rejects a late handler result before constructing its module', async () => {
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  const released = Promise.withResolvers<ProgramImportResult>()
  const read = vi.fn(() => 42)
  const r = await runner(() => { entered.resolve(); return released.promise })
  await r.run('var late = import("runner:late").catch(error => error.message);')
  await entered.promise
  const next = r.run('await late')
  released.resolve({ type: 'module', exports: Object.defineProperty({}, 'value', { enumerable: true, get: read }) })
  expect(await next).toBe('PTC evaluation ended before its import completed')
  expect(read).not.toHaveBeenCalled()
})

it.each(formats)('passes the runner handler through the standalone bootstrap for %s', async (programFormat) => {
  const messages: ProgramToHost[] = []
  await runProgram({ postMessage(message) { messages.push(message) }, on() {} }, {
    code: `${programFormat === 'function-body' ? 'return ' : ''}(await import('runner:answer')).answer()`,
    programFormat, namespaces: [], maxOutputBytes: 1000,
  }, { stdout: { write: () => true }, stderr: { write: () => true } }, () => ({ type: 'module', exports: { answer: () => 42 } }))
  expect(messages).toHaveLength(1)
  const completion = messages.find(message => message.type === 'done')
  expect(completion).toBeDefined()
  expect(decodePtcJsonWire(completion?.value)).toBe(42)
})
