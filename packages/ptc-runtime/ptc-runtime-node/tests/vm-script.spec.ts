import type { PtcProgramFormat } from '@deepseek-ai/dsh-ptc-runtime'
import { expect, it, onTestFinished, vi } from 'vitest'
import { Parser } from 'acorn'
import { createProgramEvaluator } from '../src/evaluators/index.ts'
import type { ProgramEvaluator } from '../src/evaluators/types.ts'
import { processTopLevelAwait } from '../src/evaluators/vm-script-await.ts'

type EvaluationResult = Parameters<Parameters<ProgramEvaluator['evaluate']>[1]>[0]

function evaluator(format: PtcProgramFormat = 'script') {
  const instance = createProgramEvaluator(format, () => {})
  onTestFinished(() => { instance.close() })
  const run = (code: string) => new Promise<EvaluationResult>((resolve) => {
    try { instance.evaluate(code, resolve) } catch (error: unknown) { resolve({ ok: false, error }) }
  })
  const value = async (code: string): Promise<unknown> => {
    const result = await run(code)
    if (!result.ok) throw result.error
    return result.value
  }
  return { ...instance, run, value }
}

it.each<[string, unknown]>([
  ['1 + 2', 3],
  ['Promise.resolve(4)', 4],
  ['await(5)', 5],
  ['await\nPromise.resolve(6)', 6],
  ['(await Promise.resolve(7));;;', 7],
  ['await Promise.resolve(); Promise.resolve(8)', 8],
  ['await Promise.resolve(); let done = true;', undefined],
  ['await Promise.resolve(); if (true) { 9 }', undefined],
  ['#!script\nawait Promise.resolve(10) // trailing comment', 10],
  ['let sum = 0; for await (const item of [1, 2]) sum += item; sum', 3],
  ['for (var name in {a: 1}) { await Promise.resolve() }; name', 'a'],
  ['for (var item of [11]) { await Promise.resolve() }; item', 11],
  ['for (var{x} of [{x: 1}]) { await 0 }; x', 1],
  ['for (var[x] of [[2]]) { await 0 }; x', 2],
  ['for (var/* comment */x of [3]) { await 0 }; x', 3],
  ['for (var/* comment */key in {a: 1}) { await 0 }; key', 'a'],
  ['let first, second = await Promise.resolve(12); [typeof first, second]', ['undefined', 12]],
  ['const {a = 13, ...rest} = await Promise.resolve({b: 14}); const [, x, ...tail] = [0, 15, 16]; [a, rest.b, x, tail[0]]', [13, 14, 15, 16]],
  ['{ var local = await Promise.resolve(17) }; local', 17],
  ['function before() { return 18 }; await Promise.resolve(); before()', 18],
  ['class Box { [await Promise.resolve("value")]() { return 19 } }; new Box().value()', 19],
  ['class Box { static { this.value = 20 }; method() { return 1 } }; await Promise.resolve(); Box.value', 20],
  ['{ class Local {} }; await Promise.resolve(); typeof Local', 'undefined'],
  ['const fn = async function () { return await Promise.resolve(21) }; fn()', 21],
  ['const fn = async () => await Promise.resolve(22); fn()', 22],
  ['const obj = { [await Promise.resolve("value")]: 23 }; obj.value', 23],
  ['const {basename} = await import("node:path"); basename("/a/b")', 'b'],
  ['global === globalThis && typeof Buffer === "function" && typeof setTimeout === "function"', true],
])('evaluates Script completion: %s', async (code, expected) => {
  expect(await evaluator().value(code)).toEqual(expected)
})

it('retains native and transformed declarations, closures, and class identity', async () => {
  const e = evaluator()
  await e.value('let count = 1; const box = {count}; function next() { return ++count }; class Native {}')
  await e.value('const imported = await import("node:path"); class Awaited extends Native {}; function read() { return box };')
  expect(await e.value('[next(), read() === box, new Awaited() instanceof Native, imported.basename("/a/b")]')).toEqual([2, true, true, 'b'])
  expect(await e.run('let count = 9')).toHaveProperty('error.message', expect.stringContaining('already been declared'))
})

it('leaves a failed native lexical initializer uninitialized until its context is replaced', async () => {
  const e = evaluator()
  expect(await e.run('const poisoned = (() => { throw new Error("initializer failed") })()')).toMatchObject({ ok: false })
  for (const code of ['poisoned', 'poisoned = 2', 'const poisoned = 3']) expect(await e.run(code)).toMatchObject({ ok: false })
  expect(await e.value('const replacement = 4; replacement')).toBe(4)
  expect(await evaluator().value('const poisoned = 5; poisoned')).toBe(5)
})

it.each([
  'return 1', 'await Promise.resolve(); return 1', 'await Promise.resolve(); const = 1',
  'await Promise.resolve();\nconst = 1', 'await Promise.resolve(); "unterminated',
  'await Promise.resolve(); using resource = null;', 'await using resource = null;',
])('reports a complete-submission syntax error without transformer frames: %s', async (code) => {
  const result = await evaluator().run(code)
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(String(result.error)).toContain('SyntaxError')
    expect(result.error).toHaveProperty('stack', expect.stringContaining('SyntaxError'))
    expect(result.error).toHaveProperty('stack', expect.not.stringContaining('vm-script'))
    expect(result.error).toHaveProperty('stack', expect.not.stringContaining('node:vm'))
  }
})

it('keeps the native syntax location and caret without compiler stack frames', async () => {
  const result = await evaluator().run('const =')
  expect(result).toHaveProperty('error.stack', expect.stringMatching(/ptc-program\.js:1\nconst =\n\s*\^\n\nSyntaxError:/))
  expect(result).toHaveProperty('error.stack', expect.not.stringContaining('vm-script'))
  expect(result).toHaveProperty('error.stack', expect.not.stringContaining('node:vm'))
})

it('reports the syntax heading when the host stack formatter omits the stack', async () => {
  const original = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace')
  Object.defineProperty(Error, 'prepareStackTrace', { configurable: true, value: () => undefined })
  try {
    expect(await evaluator().run('const =')).toHaveProperty('error.stack', "SyntaxError: Unexpected token '='")
  } finally {
    if (original) Object.defineProperty(Error, 'prepareStackTrace', original)
    else Reflect.deleteProperty(Error, 'prepareStackTrace')
  }
})

it('keeps block-scoped disposable bindings local to the awaited evaluation', async () => {
  const e = evaluator()
  expect(await e.value('let disposed = false; { using item = { [Symbol.dispose]() { disposed = true } }; await Promise.resolve(); }; disposed')).toBe(true)
})

it('preserves thrown primitives and the original cross-realm error', async () => {
  const e = evaluator()
  expect(await e.run('throw "failure"')).toEqual({ ok: false, error: 'failure' })
  const original = await e.value('const error = new Error("hidden"); Object.defineProperty(error, "stack", { get() { throw 1 } }); error')
  const result = await e.run('throw error')
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error).toBe(original)
})

it.each(['const invalid = ; await 1\n', 'await\\a\n', 'await  = 1\n'])('leaves earlier or ambiguous syntax to native compilation: %s', (code) => {
  expect(processTopLevelAwait(code)).toBeNull()
})

it('does not transform nested await or a top-level return', () => {
  expect(processTopLevelAwait('async function nested() { await 1 }\n')).toBeNull()
  expect(processTopLevelAwait('return await 1\n')).toBeNull()
  expect(processTopLevelAwait('\n')).toBeNull()
})

it('runs function-body parameters and Promise rejection through the evaluator entry', async () => {
  const e = evaluator('function-body')
  e.globals.answer = 42
  expect(await e.value('return answer')).toBe(42)
  expect(await e.run('throw new Error("rejected")')).toMatchObject({ ok: false, error: { message: 'rejected' } })
  expect(await e.run('const =')).toHaveProperty('error', expect.any(SyntaxError))
})

it('falls back to native errors for input escaping the async wrapper', () => {
  expect(processTopLevelAwait('}); (async () => {\n')).toBeNull()
  expect(processTopLevelAwait('}).call(null); (async () => {\n')).toBeNull()
})

it('reports an unfinished expression at the end of submitted input', () => {
  expect(() => processTopLevelAwait('await null; (\n')).toThrow(SyntaxError)
})

it('preserves parser infrastructure failures without rewriting them as syntax errors', async () => {
  const failure = new Error('parser unavailable')
  const parse = vi.spyOn(Parser, 'parse').mockImplementation(() => { throw failure })
  try {
    expect(() => processTopLevelAwait('await 1\n')).toThrow(failure)
    const result = await evaluator().run('await 1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe(failure)
  }
  finally { parse.mockRestore() }
})
