import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { createScopedReplEvaluator, type ScopedReplEvaluatorOptions } from '../src/evaluators/scoped-repl-evaluator.ts'
import type { ProgramEvaluator } from '../src/evaluators/types.ts'

type EvaluationResult = Parameters<Parameters<ProgramEvaluator['evaluate']>[1]>[0]

function evaluator(options: Omit<ScopedReplEvaluatorOptions, 'reportError'> = {}) {
  const reports: string[] = []
  const waiters: (() => void)[] = []
  const instance = createScopedReplEvaluator({
    ...options,
    reportError: (message) => {
      reports.push(message)
      waiters.splice(0).forEach((wake) => { wake() })
    },
  })
  onTestFinished(() => { instance.close() })
  const run = (code: string) => new Promise<EvaluationResult>((resolve) => { instance.evaluate(code, resolve) })
  const value = async (code: string): Promise<unknown> => {
    const result = await run(code)
    if (!result.ok) throw result.error
    return result.value
  }
  const failure = async (code: string): Promise<unknown> => {
    const result = await run(code)
    if (result.ok) throw new Error(`expected ${JSON.stringify(code)} to fail`)
    return result.error
  }
  const reported = (): Promise<string> => reports.length > 0
    ? Promise.resolve(reports[reports.length - 1] as string)
    : new Promise((resolve) => { waiters.push(() => { resolve(reports[reports.length - 1] as string) }) })
  return { instance, reports, run, value, failure, reported }
}

const message = (error: unknown): string => error instanceof Error || (typeof error === 'object' && error !== null && 'message' in error)
  ? `${String((error as { name?: unknown }).name)}: ${String((error as { message?: unknown }).message)}`
  : String(error)

/** Filename of the `ordinal`th program submitted to an evaluator created in the current working directory. */
const programFile = (ordinal: number): string => resolve(`.ptc-repl-${ordinal}.js`)

describe('results', () => {
  it.each<[string, unknown]>([
    ['1 + 1', 2],
    ['await Promise.resolve(2)', 2],
    ['const a = 3\na;;;', 3],
    ['(4)', 4],
    ['({ five: 5 })', { five: 5 }],
    ['const { join } = await import("node:path")\njoin("a", "b")', `a${sep}b`],
    ['if (true) { 6 }', undefined],
    ['{ 7 }', undefined],
    ['{ a: 1 }', undefined],
    ['let declared = 8', undefined],
    ['', undefined],
  ])('uses the last top-level expression statement as the completion: %j', async (code, expected) => {
    expect(await evaluator().value(code)).toEqual(expected)
  })

  it('returns a final Promise without awaiting it', async () => {
    const result = await evaluator().run('Promise.resolve(3)')
    expect(result.ok).toBe(true)
    const completion = result.ok ? result.value : undefined
    expect(typeof (completion as { then?: unknown }).then).toBe('function')
    expect(await (completion as Promise<unknown>)).toBe(3)
  })

  it('discards the final expression when the completion option is off', async () => {
    const e = evaluator({ finalExpression: false })
    expect(await e.value('let kept = 1\nkept + 1')).toBeUndefined()
    await e.value('globalThis.seen = kept')
    expect(e.instance.globals.seen).toBe(1)
    expect(message(await e.failure('return 1'))).toBe('SyntaxError: Illegal return statement')
  })

  it.each([true, false])('rejects top-level return before running any statement (strict %s)', async (strict) => {
    const e = evaluator({ strict })
    const error = await e.failure('globalThis.ran = true\nif (ran) {\n  return 1\n}')
    expect(message(error)).toBe('SyntaxError: Illegal return statement')
    expect((error as Error).stack).toContain(`${programFile(1)}:3\n  return 1\n  ^\n`)
    expect(await e.value('typeof ran')).toBe('undefined')
    expect(await e.value('const f = () => { return 2 }\nf()')).toBe(2)
  })

  it('rejects static imports with the scan error and runs nothing', async () => {
    const e = evaluator()
    const error = await e.failure('globalThis.ran = true\nimport { join } from "node:path"')
    expect(message(error)).toBe("SyntaxError: 'import' and 'export' may appear only with 'sourceType: module'")
    const stack = String((error as Error).stack)
    expect(stack).toContain(`${programFile(1)}:2\nimport { join } from "node:path"\n^\n\nSyntaxError: `)
    expect(stack).not.toContain('\n    at ')
    expect(await e.value('typeof ran')).toBe('undefined')
  })
})

describe('scope chain through the evaluator', () => {
  it('carries bindings between evaluations while earlier closures keep theirs', async () => {
    const e = evaluator()
    await e.value('const value = 1\nconst read = () => value')
    await e.value('const value = 2')
    expect(await e.value('[value, read()]')).toEqual([2, 1])
    await e.failure('const value = (() => { throw new Error("failed") })()')
    expect(await e.value('value')).toBe(2)
  })

  it('numbers every submission, including syntax errors, without changing bindings', async () => {
    const e = evaluator()
    await e.value('const a = 1')
    expect((await e.failure('const = 2') as Error).stack).toContain(`${programFile(2)}:1`)
    expect(await e.value('[a, new Error("here").stack]')).toEqual([1, expect.stringContaining(`${programFile(3)}:1`)])
  })

  it('keeps earlier bindings for a program evaluated before the previous program started', async () => {
    const e = evaluator()
    await e.value('const settled = 1')
    const results: EvaluationResult[] = []
    await new Promise<void>((resolve) => {
      e.instance.evaluate('const early = 2', (result) => { results.push(result) })
      e.instance.evaluate('[typeof early, settled]', (result) => {
        results.push(result)
        resolve()
      })
    })
    expect(results.at(-1)).toEqual({ ok: true, value: ['undefined', 1] })
  })

  it('lets later evaluations assign to an earlier const without changing earlier closures', async () => {
    const e = evaluator()
    await e.value('const limit = 1\nconst readLimit = () => limit')
    expect(await e.value('limit = 2;\n[limit, readLimit()]')).toEqual([2, 1])
    expect(await e.value('limit')).toBe(2)
  })

  it('refuses evaluation after close', () => {
    const e = evaluator()
    e.instance.close()
    expect(() => { e.instance.evaluate('1', () => {}) }).toThrow('PTC evaluator is closed')
  })
})

describe('environment', () => {
  it('runs strict programs with an undefined receiver and empty arguments by default', async () => {
    const e = evaluator()
    expect(await e.value('[this === undefined, arguments.length]')).toEqual([true, 0])
    expect(message(await e.failure('undeclared = 1'))).toBe('ReferenceError: undeclared is not defined')
  })

  it('creates shared globals for undeclared assignments when strict mode is off', async () => {
    const e = evaluator({ strict: false })
    await e.value('undeclared = 1')
    expect(await e.value('[undeclared, this === globalThis]')).toEqual([1, true])
    expect(await e.value('with ({ w: 2 }) { globalThis.fromWith = w }\nfromWith')).toBe(2)
  })

  it('honors a program\'s leading "use strict" when strict mode is off, also after copies', async () => {
    const e = evaluator({ strict: false })
    await e.value('var carried = 1')
    expect(message(await e.failure('"use strict"\nleaked = 1'))).toBe('ReferenceError: leaked is not defined')
    expect(await e.value('"use strict";\n[this === undefined, carried]')).toEqual([true, 1])
  })

  it.each([true, false])('keeps top-level var and function declarations off the global object (strict %s)', async (strict) => {
    const e = evaluator({ strict })
    await e.value('var gv = 1\nfunction gf() {}')
    expect(await e.value('[typeof globalThis.gv, typeof globalThis.gf, typeof _, typeof _error]')).toEqual(['undefined', 'undefined', 'undefined', 'undefined'])
  })

  it('provides Node globals and exposes the context object as evaluator globals', async () => {
    const e = evaluator()
    e.instance.globals.injected = 42
    expect(await e.value('[typeof setTimeout, typeof Buffer, typeof fetch, typeof URL, typeof structuredClone, typeof WebAssembly, global === globalThis, injected]'))
      .toEqual(['function', 'function', 'function', 'function', 'function', 'object', true, 42])
  })

  it('rejects code generation from strings and WebAssembly by default', async () => {
    const e = evaluator()
    expect(await e.value('[(() => { try { return eval("1") } catch (error) { return error.name } })(), (() => { try { return new Function("return 1")() } catch (error) { return error.name } })()]'))
      .toEqual(['EvalError', 'EvalError'])
    expect(await e.value('await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])).then(() => "ok", error => error.name)')).toBe('CompileError')
  })

  it('rejects code generation through the context\'s own Function, including the global object\'s prototype chain', async () => {
    const e = evaluator()
    expect(await e.value('[typeof constructor, constructor.constructor === Function]')).toEqual(['function', true])
    expect(message(await e.failure('constructor.constructor("return 1")()'))).toBe('EvalError: Code generation from strings disallowed for this context')
    expect(message(await e.failure('({}).constructor.constructor("return 1")()'))).toBe('EvalError: Code generation from strings disallowed for this context')
  })

  it('still lets main-realm functions copied into the context generate code, so the limit is not isolation', async () => {
    const e = evaluator()
    expect(await e.value('setTimeout.constructor("return 1 + 1")()')).toBe(2)
    expect(await e.value('typeof setTimeout.constructor("return WebAssembly.compile")()')).toBe('function')
  })

  it('allows code generation when enabled, with direct eval seeing copied bindings', async () => {
    const e = evaluator({ codeGeneration: true })
    await e.value('const a = 4')
    expect(await e.value('[eval("a"), new Function("return 3")()]')).toEqual([4, 3])
    expect(await e.value('await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])).then(() => "ok")')).toBe('ok')
  })

  it('loads modules only with dynamic import(), without require, module or built-in module globals', async () => {
    const e = evaluator()
    expect(await e.value('[typeof require, typeof module, typeof fs, typeof path, typeof child_process]')).toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'undefined'])
    expect(await e.value('(await import("node:path")).sep')).toBe(sep)
  })

  it('leaves host bindings named module or require untouched', async () => {
    const e = evaluator()
    Object.defineProperty(e.instance.globals, 'module', { configurable: true, enumerable: true, value: { answer: () => 42 } })
    expect(await e.value('module.answer()')).toBe(42)
    expect(await e.value('module.answer()')).toBe(42)
  })

  it('resolves relative import() from the working directory at creation, after later calls change directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-scoped-repl-'))
    onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
    await Promise.all([mkdir(join(root, 'first')), mkdir(join(root, 'second'))])
    await writeFile(join(root, 'first', 'dep.mjs'), 'export default "first"')
    await writeFile(join(root, 'second', 'dep.mjs'), 'export default "second"')
    await writeFile(join(root, 'second', 'only-second.mjs'), 'export default "only second"')
    const cwd = process.cwd()
    try {
      process.chdir(join(root, 'first'))
      const e = evaluator()
      expect(await e.value('(await import("./dep.mjs")).default')).toBe('first')
      process.chdir(join(root, 'second'))
      expect(await e.value('[(await import("./dep.mjs")).default, process.cwd().endsWith("second"), new Error().stack.includes("first")]')).toEqual(['first', true, true])
      expect((await e.failure('await import("./only-second.mjs")') as { code?: unknown }).code).toBe('ERR_MODULE_NOT_FOUND')
    } finally { process.chdir(cwd) }
  })
})

describe('errors', () => {
  it('keeps first-line columns exact in programs that await', async () => {
    const error = await evaluator().failure('await null; throw new Error("first")')
    expect((error as Error).stack).toContain(`${programFile(1)}:1:19`)
  })

  it('reports synchronous throws without evaluator frames', async () => {
    const error = await evaluator().failure('throw new Error("sync")')
    const frames = String((error as Error).stack).split('\n').slice(1)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toContain(`${programFile(1)}:1:7`)
  })

  it('reports scan failures with the program filename and passes non-Error throws through', async () => {
    const e = evaluator()
    expect((await e.failure('const x = ;') as Error).stack).toBe(`${programFile(1)}:1\nconst x = ;\n          ^\n\nSyntaxError: Unexpected token`)
    expect(message(await e.failure('function unfinished() {'))).toBe('SyntaxError: Unexpected end of input')
    expect(message(await e.failure('const __$binding_vals = 1'))).toBe("SyntaxError: Names starting with '__$binding_' are reserved")
    expect(await e.failure('throw 42')).toBe(42)
  })
})

describe('asynchronous failures', () => {
  it.each<[string, string]>([
    ['setTimeout(() => { throw new Error("late timer") }, 0)', 'Uncaught Error: late timer'],
    ['setTimeout(() => { Promise.reject(new Error("late rejection")) }, 0)', 'Uncaught Error: late rejection'],
    ['void (async () => { await null; throw new Error("detached") })()', 'Uncaught Error: detached'],
    ['const { EventEmitter } = await import("node:events")\nsetTimeout(() => { new EventEmitter().emit("error", new Error("emitter")) }, 0)', 'Uncaught Error: emitter'],
    ['setTimeout(() => { throw 42 }, 0)', 'Uncaught 42'],
    ['setTimeout(() => { throw { code: 42 } }, 0)', 'Uncaught { code: 42 }'],
    ['setTimeout(() => { Promise.reject({ code: 43 }) }, 0)', 'Uncaught { code: 43 }'],
    ['setTimeout(() => { const error = new Error("message kept"); error.stack = undefined; throw error }, 0)', 'Uncaught Error: message kept'],
    ['setTimeout(() => { const error = new Error("x"); Object.defineProperty(error, "stack", { get() { throw new Error("stack") } }); throw error }, 0)',
      'Uncaught program threw an unrenderable value'],
    ['setTimeout(() => { const error = new Error("replaced stack"); error.stack = { toString() { throw new Error("toString") } }; throw error }, 0)',
      'Uncaught Error: replaced stack'],
    ['setTimeout(() => { const error = new Error("x"); Object.defineProperty(error, "message", { get() { throw new Error("message") } }); error.stack = 1; throw error }, 0)',
      'Uncaught program threw an unrenderable value'],
    ['setTimeout(() => { throw { [Symbol.for("nodejs.util.inspect.custom")]() { throw new Error("inspect") } } }, 0)',
      'Uncaught program threw an unrenderable value'],
  ])('reports failures after completion and keeps variables: %s', async (code, expected) => {
    const e = evaluator()
    await e.value(`let kept = 1\n${code}`)
    expect((await e.reported()).split('\n')[0]).toBe(expected)
    expect(await e.value('kept')).toBe(1)
  })

  it('reports failures while the program is still running', async () => {
    const e = evaluator()
    const order: string[] = []
    const reported = e.reported().then((report) => { order.push(report.split('\n')[0] as string) })
    const finished = e.value('setTimeout(() => { throw new Error("during") }, 0)\nawait new Promise(resolve => setTimeout(resolve, 20))\n"done"')
      .then((value) => { order.push(String(value)) })
    await Promise.all([reported, finished])
    expect(order).toEqual(['Uncaught Error: during', 'done'])
  })
})
