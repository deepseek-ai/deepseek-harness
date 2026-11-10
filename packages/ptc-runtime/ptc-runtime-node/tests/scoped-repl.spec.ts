import { sep } from 'node:path'
import { Script, constants, createContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  BINDING_GETTERS, BINDING_VALUES, RESERVED_PREFIX, buildProgramSource, scanProgram, ScopedReplScopes,
  type ScopedReplBinding, type ScopedReplRedeclaration,
} from '../src/evaluators/scoped-repl.ts'

const filename = '/work/ptc-program-1.js'
const scan = (code: string) => scanProgram(code, { filename })
const declarations = (code: string) => Object.fromEntries(scan(code).declarations)
const syntaxError = (code: string): SyntaxError => {
  try { scan(code) } catch (error: unknown) {
    if (error instanceof SyntaxError) return error
    throw error
  }
  throw new Error(`expected a SyntaxError for ${code}`)
}

describe('top-level declarations', () => {
  it('records each keyword, including destructured names, in source order', () => {
    expect(Object.entries(declarations(
      'const a = 1; let b = 2; var c = 3\n'
      + 'const { d, e: [f, , ...g], h = 4, ...i } = o; let [j, k = 5, ...{ length }] = p\n'
      + 'function fn() {} async function af() {} function* gen() {} async function* ag() {} class K {}',
    ))).toEqual([
      ['a', 'const'], ['b', 'let'], ['c', 'var'], ['d', 'const'], ['f', 'const'], ['g', 'const'], ['h', 'const'], ['i', 'const'],
      ['j', 'let'], ['k', 'let'], ['length', 'let'], ['fn', 'function'], ['af', 'function'], ['gen', 'function'], ['ag', 'function'], ['K', 'class'],
    ])
  })

  it('records names bound by computed keys and nested defaults without their expressions', () => {
    expect(declarations('const { [key]: renamed, nested: { deep = fallback } = {} } = source')).toEqual({ renamed: 'const', deep: 'const' })
  })

  it('records var heads of top-level for statements but no other loop bindings', () => {
    expect(declarations(
      'for (var i = 0, [n] = [1]; i < 1; i++) {}\nfor (var key in o) {}\nfor (var item of xs) {}\n'
      + 'for (let j = 0; ;) break\nfor (const x of xs) {}\nfor (i = 0; ;) break\nfor (;;) break\nfor (y in o) {}',
    )).toEqual({ i: 'var', n: 'var', key: 'var', item: 'var' })
  })

  it('collects var declarations inside blocks and statements, but no other block declarations', () => {
    expect(declarations(
      'if (x) { var y = 1; let z = 2; function f() {} } else { var e = 1 }\n{ const w = 1; { var deep = 1 } }\n'
      + 'try { var t = 1 } catch { var u = 1 } finally { var fin = 1 }\ntry {} finally { var onlyFinally = 1 }\n'
      + 'while (false) { var v = 1 }\ndo { var d = 1 } while (false)\nlabel: { var l = 1 }\nswitch (x) { case 1: var sw = 1; default: }\n'
      + 'for (j = 0; ;) { var inFor = 1; break }\nfor (;;) { break }\nfor (k of xs) { var inForOf = 1 }\nfor (const m in o) {}\n'
      + 'if (x) { for (var nestedHead = 0; ;) break }\nouter: for (var labelled = 0; ;) break\nwith (o) { var inWith = 1 }\n'
      + 'if (x) y = 1',
    )).toEqual({
      y: 'var', e: 'var', deep: 'var', t: 'var', u: 'var', fin: 'var', onlyFinally: 'var', v: 'var', d: 'var', l: 'var', sw: 'var',
      inFor: 'var', inForOf: 'var', nestedHead: 'var', labelled: 'var', inWith: 'var',
    })
  })

  it('does not collect var declarations inside nested functions and classes', () => {
    expect(declarations(
      'function outer() { var inner = 1 }\nclass C { static { var s = 1 } method() { var m = 1 } }\n'
      + 'const arrow = () => { var a = 1 }\nif (x) { function nested() { var n = 1 } }',
    )).toEqual({ outer: 'function', C: 'class', arrow: 'const' })
  })

  it.each<[string, Record<string, string>]>([
    ['var dup = 1\nfunction dup() {}', { dup: 'function' }],
    ['function dup() {}\nvar dup = 1', { dup: 'function' }],
    ['function twice() { return 1 }\nfunction twice() { return 2 }', { twice: 'function' }],
    ['var both = 1\nif (x) { var both = 2 }', { both: 'var' }],
  ])('accepts names that a function body may declare more than once, recording function over var: %j', (code, expected) => {
    expect(declarations(code)).toEqual(expected)
  })

  it('accepts await as an identifier inside nested ordinary functions', () => {
    expect(declarations('function plain() { var await = 1; return await }')).toEqual({ plain: 'function' })
  })
})

describe('leading strict directive', () => {
  it.each<[string, boolean]>([
    ['"use strict"\nx', true],
    ["'use strict';", true],
    ['// note\n/* block */ "use strict"\nx', true],
    ['"other directive"; "use strict"\nx', true],
    ['"use strict"', true],
    ['x\n"use strict"', false],
    ['("use strict")', false],
    ['"use\\x20strict"', false],
    ['"other directive"', false],
    ['', false],
  ])('detects "use strict" only among the leading directives: %j', (code, expected) => {
    expect(scan(code).useStrict).toBe(expected)
  })
})

describe('final expression', () => {
  it.each<[string, { statementStart: number; expressionStart: number; expressionEnd: number } | undefined]>([
    ['1 + 1', { statementStart: 0, expressionStart: 0, expressionEnd: 5 }],
    ['let a = 1\na + 1;;;', { statementStart: 10, expressionStart: 10, expressionEnd: 15 }],
    ['(a, b);', { statementStart: 0, expressionStart: 1, expressionEnd: 5 }],
    ['x // trailing', { statementStart: 0, expressionStart: 0, expressionEnd: 1 }],
    ['x <!-- html-like comment', { statementStart: 0, expressionStart: 0, expressionEnd: 1 }],
    ['x\n--> html-like close comment', { statementStart: 0, expressionStart: 0, expressionEnd: 1 }],
    ['"use strict"', { statementStart: 0, expressionStart: 0, expressionEnd: 12 }],
    ['let a = 1', undefined],
    ['if (x) { 1 }', undefined],
    ['{ a: 1 }', undefined],
    ['label: 1', undefined],
    [';;', undefined],
    ['', undefined],
  ])('locates the last non-empty top-level statement: %j', (code, expected) => {
    expect(scan(code).finalExpression).toEqual(expected)
  })
})

describe('syntax errors', () => {
  it('reports top-level return in V8 wording, including inside blocks', () => {
    expect(syntaxError('return 1').stack).toBe(`${filename}:1\nreturn 1\n^\n\nSyntaxError: Illegal return statement`)
    const nested = syntaxError('const a = 1\nif (a) {\n  return a\n}')
    expect(nested.message).toBe('Illegal return statement')
    expect(nested.stack).toBe(`${filename}:3\n  return a\n  ^\n\nSyntaxError: Illegal return statement`)
    expect(syntaxError('for (;;) { try { return } finally {} }').message).toBe('Illegal return statement')
    expect(scan('const f = () => { return 1 }\nf()').finalExpression).toBeDefined()
  })

  it('reports input ending inside a construct as an unexpected end of input', () => {
    expect(syntaxError('function unfinished() {').stack)
      .toBe(`${filename}:1\nfunction unfinished() {\n                       ^\n\nSyntaxError: Unexpected end of input`)
    expect(syntaxError('foo(\n').message).toBe('Unexpected end of input')
  })

  it('keeps acorn messages without their position suffix and shows only the failing line', () => {
    expect(syntaxError('const x = ;').stack).toBe(`${filename}:1\nconst x = ;\n          ^\n\nSyntaxError: Unexpected token`)
    expect(syntaxError('let a = 1\r\nlet a = 2\nlet b = 3').stack)
      .toBe(`${filename}:2\nlet a = 2\n    ^\n\nSyntaxError: Identifier 'a' has already been declared`)
    expect(syntaxError('let a = 1\u2028let a = 2').stack).toBe(`${filename}:2\nlet a = 2\n    ^\n\nSyntaxError: Identifier 'a' has already been declared`)
  })

  it.each<[string, string]>([
    ['using r = make()', 'Using declaration cannot appear in the top level when source type is `script` or in the bare case statement'],
    ['await using r = make()', 'Using declaration cannot appear in the top level when source type is `script` or in the bare case statement'],
    ['import { join } from "node:path"', "'import' and 'export' may appear only with 'sourceType: module'"],
    ['export const shared = 1', "'import' and 'export' may appear only with 'sourceType: module'"],
    ['typeof new.target', "'new.target' can only be used in functions and class static block"],
  ])('rejects what script rules reject at the top level: %s', (code, expected) => {
    expect(syntaxError(code).message).toBe(expected)
  })

  it('leaves strict-mode violations to the compiler', () => {
    expect(declarations('with (o) {}\nlet a = 010')).toEqual({ a: 'let' })
  })

  it.each<[string, number, number]>([
    [`const ${BINDING_VALUES} = 1`, 1, 6],
    [`{ var ${BINDING_GETTERS} = 0 }`, 1, 6],
    ['typeof __$binding_getters', 1, 7],
    ['"__$binding_named in a string"', 1, 1],
    ['let ok = 1\n// __$binding_ in a comment', 2, 3],
    ['const = 1 // __$binding_', 1, 13],
  ])('rejects any occurrence of the reserved prefix before parsing: %j', (code, line, column) => {
    const error = syntaxError(code)
    expect(error.message).toBe(`Names starting with '${RESERVED_PREFIX}' are reserved`)
    expect(error.stack).toMatch(new RegExp(`^/work/ptc-program-1\\.js:${line}\\n[^\\n]*\\n {${column}}\\^\\n\\nSyntaxError: Names starting`))
  })

  it('rejects a hashbang because the generated prefix precedes the program', () => {
    expect(syntaxError('#!/usr/bin/env node\n1').stack).toBe(`${filename}:1\n#!/usr/bin/env node\n^\n\nSyntaxError: Hashbang lines are not supported`)
    expect(declarations('// #!/usr/bin/env node\nconst a = 1')).toEqual({ a: 'const' })
  })

  it('reports exhausted parser stack as a positioned syntax error', () => {
    const error = syntaxError('['.repeat(100_000))
    expect(error.message).toBe('Not enough stack space to parse input')
    expect(error.stack).toMatch(/^\/work\/ptc-program-1\.js:1\n\[+\n {2,}\^\n\nSyntaxError: Not enough stack space to parse input$/)
  })
})

describe('program source', () => {
  const carried: ScopedReplBinding[] = [
    { name: 'a', kind: 'const' }, { name: 'b', kind: 'let' }, { name: 'v', kind: 'var' }, { name: 'f', kind: 'function' }, { name: 'K', kind: 'class' },
  ]

  it('copies var bindings as var and every other binding as let, pushes one getter per binding, and boxes the final expression', () => {
    const code = 'let c = a + b\nc * 2 // done'
    const built = buildProgramSource(code, scan(code), carried, { strict: true, finalExpression: true })
    expect(built.source).toBe(
      '"use strict";(function (__$binding_vals, __$binding_getters) { return async function () {'
      + ' let a = __$binding_vals[0]; let b = __$binding_vals[1]; var v = __$binding_vals[2]; let f = __$binding_vals[3]; let K = __$binding_vals[4];'
      + ' __$binding_getters.push(() => a, () => b, () => v, () => f, () => K, () => c);'
      + '\nlet c = a + b\nreturn { value: (c * 2) } // done\n} })',
    )
    expect(built.bindings).toEqual([...carried, { name: 'c', kind: 'let' }])
  })

  it('omits the strict prefix, copies, getters and completion when they do not apply', () => {
    const code = 'console.log(1)'
    expect(buildProgramSource(code, scan(code), [], { strict: false, finalExpression: false }).source)
      .toBe('(function (__$binding_vals, __$binding_getters) { return async function () {\nconsole.log(1)\n} })')
  })

  it('repeats a leading "use strict" ahead of the copies only when strict mode is not forced', () => {
    const code = '"use strict"\nb'
    const copied: ScopedReplBinding[] = [{ name: 'b', kind: 'let' }]
    expect(buildProgramSource(code, scan(code), copied, { strict: false, finalExpression: true }).source)
      .toBe('(function (__$binding_vals, __$binding_getters) { return async function () {"use strict"; let b = __$binding_vals[0]; __$binding_getters.push(() => b);\n"use strict"\nreturn { value: (b) }\n} })')
    expect(buildProgramSource(code, scan(code), copied, { strict: true, finalExpression: true }).source)
      .toMatch(/^"use strict";\(function \(__\$binding_vals, __\$binding_getters\) \{ return async function \(\) \{ let b/)
  })

  it('keeps a leading parenthesis outside the boxed completion', () => {
    const code = '(a, b);'
    expect(buildProgramSource(code, scan(code), [], { strict: true, finalExpression: true }).source)
      .toContain('\nreturn ({ value: (a, b) });\n} })')
  })

  it('builds source that copies values in and exposes live getters', async () => {
    const code = 'let c = a + 1\nc = c * 10\nc'
    const built = buildProgramSource(code, scan(code), [{ name: 'a', kind: 'const' }], { strict: true, finalExpression: true })
    const factory = new Script(built.source, { filename, lineOffset: -1 }).runInContext(createContext()) as
      (values: unknown[], getters: (() => unknown)[]) => () => Promise<{ value: unknown }>
    const getters: (() => unknown)[] = []
    const completion = await factory([4], getters)()
    expect(completion.value).toBe(50)
    expect(getters.map(read => read())).toEqual([4, 50])
  })
})

/** A scope chain in a plain context with timers; programs run directly, without the evaluator. */
function chain(options: { strict?: boolean; finalExpression?: boolean } = {}) {
  const redeclarations: ScopedReplRedeclaration[][] = []
  const scopes = new ScopedReplScopes({ strict: options.strict ?? true, onRedeclaration: (found) => { redeclarations.push([...found]) } })
  const context = createContext({ setTimeout, setInterval, clearInterval })
  let count = 0
  const compile = (code: string) => scopes.compile(code, { filename: `/work/ptc-program-${++count}.js`, context, finalExpression: options.finalExpression ?? true })
  const run = async (code: string): Promise<unknown> => (await compile(code)())?.value
  const failure = async (code: string): Promise<unknown> => {
    try { await run(code) } catch (error: unknown) { return error }
    throw new Error(`expected ${JSON.stringify(code)} to fail`)
  }
  return { scopes, context, compile, run, failure, redeclarations }
}

const message = (error: unknown): string => error instanceof Error || (typeof error === 'object' && error !== null && 'message' in error)
  ? `${String((error as { name?: unknown }).name)}: ${String((error as { message?: unknown }).message)}`
  : String(error)

describe('scope chain', () => {
  it('carries every declaration keyword into later programs', async () => {
    const c = chain()
    await c.run('const a = 1; let b = 2; var d = 3; function f() { return 4 } class K { static v = 5 }\nconst { e, g: [h] } = { e: 6, g: [7] }')
    expect(await c.run('[a, b, d, f(), K.v, e, h]')).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('accepts every keyword for a name declared earlier', async () => {
    const c = chain()
    for (const declaration of ['var k = 1', 'let k = 2', 'const k = 3', 'class k {}', 'function k() {}', 'var k = "last"']) await c.run(declaration)
    expect(await c.run('k')).toBe('last')
  })

  it.each(['var', 'let', 'const', 'class', 'function'])('lets a later program declare an earlier %s name again with each keyword', async (first) => {
    const declare = (keyword: string, value: number) => keyword === 'class' ? `class n { static v = ${value} }`
      : keyword === 'function' ? `function n() { return ${value} }` : `${keyword} n = ${value}`
    const read = (keyword: string) => keyword === 'class' ? 'n.v' : keyword === 'function' ? 'n()' : 'n'
    for (const second of ['var', 'let', 'const', 'class', 'function']) {
      const c = chain()
      await c.run(declare(first, 1))
      expect(await c.run(`${declare(second, 2)}\n${read(second)}`)).toBe(2)
      expect(await c.run(read(second))).toBe(2)
    }
  })

  it('keeps earlier closures on their own binding after a redeclaration', async () => {
    const c = chain()
    await c.run('const value = 1\nconst read = () => value')
    await c.run('const value = 2')
    expect(await c.run('[value, read()]')).toEqual([2, 1])
  })

  it('keeps earlier callers on the function they captured after a redefinition', async () => {
    const c = chain()
    await c.run('function helper() { return 1 }\nfunction caller() { return helper() }')
    await c.run('function helper() { return 2 }')
    expect(await c.run('[helper(), caller()]')).toEqual([2, 1])
  })

  it('changes only the copy when a later program assigns without declaring', async () => {
    const c = chain()
    await c.run('let s = 1\nglobalThis.readS = () => s')
    await c.run('s = 2')
    expect(await c.run('[s, readS()]')).toEqual([2, 1])
    expect(await c.run('s += 1;\n[s, readS()]')).toEqual([3, 1])
  })

  it('lets later programs assign to copies of every keyword, including const, without changing earlier code', async () => {
    const c = chain()
    await c.run('var v = 1; function f() { return 1 } class K {}; const k = 1\nglobalThis.readK = () => k')
    expect(await c.run('v = 2; f = () => 2; K = 2; k = 3;\n[v, f(), K, k]')).toEqual([2, 2, 2, 3])
    expect(await c.run('k++;\n[k, readK()]')).toEqual([4, 1])
  })

  it('keeps a const read-only in the program that declares it', async () => {
    const c = chain()
    await c.run('const k = 1')
    expect(message(await c.failure('const k = 5\nk = 6'))).toBe('TypeError: Assignment to constant variable.')
    expect(await c.run('k')).toBe(5)
    expect(await c.run('k = 7\nk')).toBe(7)
  })

  it('cannot read the earlier value of a name in its own let, const, or class redeclaration', async () => {
    const c = chain()
    await c.run('let count = 1')
    expect(message(await c.failure('let count = count + 1'))).toBe("ReferenceError: Cannot access 'count' before initialization")
    expect(message(await c.failure('const count = count + 1'))).toBe("ReferenceError: Cannot access 'count' before initialization")
    expect(message(await c.failure('class count extends count {}'))).toBe("ReferenceError: Cannot access 'count' before initialization")
    expect(await c.run('count')).toBe(1)
    expect(await c.run('count = 1\ncount = count + 1')).toBe(2)
  })

  it.each(['var', 'let', 'const', 'function', 'class'])('starts a var redeclaration from the earlier value of a %s binding', async (keyword) => {
    const c = chain()
    const declaration = { function: 'function count() {}', class: 'class count {}' }[keyword] ?? `${keyword} count = 1`
    await c.run(`${declaration}\nglobalThis.earlier = count`)
    expect(await c.run('var count = [count === globalThis.earlier, typeof count]\ncount')).toEqual([true, keyword === 'function' || keyword === 'class' ? 'function' : 'number'])
  })

  it('adds to the earlier value in a var redeclaration that reads its own name', async () => {
    const c = chain()
    await c.run('var count = 1\nglobalThis.readCount = () => count')
    expect(await c.run('var count = count + 1\ncount')).toBe(2)
    expect(await c.run('var count = count + 1;\n[count, readCount()]')).toEqual([3, 1])
  })

  it('shares objects by reference', async () => {
    const c = chain()
    await c.run('const o = { n: 1 }\nglobalThis.readO = () => o.n')
    await c.run('o.n = 2')
    expect(await c.run('[o.n, readO()]')).toEqual([2, 2])
  })

  it('reads earlier bindings when a program is compiled, so later writes by earlier code stay with that code', async () => {
    const c = chain()
    await c.run('let ticks = 0\nglobalThis.liveTicks = () => ticks\nglobalThis.timer = setInterval(() => { ticks++ }, 1)')
    await c.run('await new Promise(resolve => setTimeout(resolve, 20))\nconst seen = ticks')
    expect(await c.run('clearInterval(timer);\n[seen === ticks, liveTicks() > ticks]')).toEqual([true, true])
  })

  it('copies the value an earlier binding holds at each compilation and chains later copies from the previous program', async () => {
    const c = chain()
    await c.run('let n = 1\nglobalThis.bump = () => ++n')
    const bump = c.context.bump as () => number
    bump()
    bump()
    expect(await c.run('n')).toBe(3)
    expect(bump()).toBe(4)
    expect(await c.run('n')).toBe(3)
  })

  it('carries names through programs that never mention them', async () => {
    const c = chain()
    await c.run('const a = 1')
    await c.run('const b = 2')
    await c.run('globalThis.unrelated = true')
    expect(await c.run('[a, b]')).toEqual([1, 2])
  })

  it('does not let earlier functions see names declared later', async () => {
    const c = chain()
    await c.run('function later() { return typeof soon }')
    expect(await c.run('const soon = 1\nlater()')).toBe('undefined')
  })

  it('keeps a still-running earlier program on its own bindings while later programs redeclare them', async () => {
    const c = chain()
    await c.run('globalThis.gate = Promise.withResolvers()')
    const running = c.run('let phase = "first"\nawait gate.promise\nphase')
    expect(await c.run('const phase = "second"\nphase')).toBe('second')
    await c.run('gate.resolve()')
    expect(await running).toBe('first')
    expect(await c.run('phase')).toBe('second')
  })

  it('creates a new class on redeclaration while earlier instances keep the earlier class', async () => {
    const c = chain()
    await c.run('class K { kind() { return "old" } }\nconst k = new K()')
    await c.run('class K { kind() { return "new" } }')
    expect(await c.run('[k instanceof K, k.kind(), new K().kind()]')).toEqual([false, 'old', 'new'])
  })

  it('keeps block-scoped declarations of a later program local to their block', async () => {
    const c = chain()
    await c.run('const a = 1')
    expect(await c.run('{ const a = 5 }\nfor (const a of [6]) {}\ntry { throw 7 } catch (a) {}\na')).toBe(1)
  })

  it('keeps block-level using declarations local and rejects top-level ones', async () => {
    const c = chain()
    expect(await c.run('let disposed = false\n{ using resource = { [Symbol.dispose]() { disposed = true } } }\ndisposed')).toBe(true)
    expect(await c.run('typeof resource')).toBe('undefined')
    expect(message(await c.failure('using top = { [Symbol.dispose]() {} }'))).toMatch(/^SyntaxError: Using declaration cannot appear in the top level/)
  })

  it('runs function-body declarations that module rules would reject', async () => {
    const c = chain()
    expect(await c.run('function f() { return 1 }\nfunction f() { return 2 }\nf()')).toBe(2)
    expect(await c.run('var g = 1\nfunction g() {}\ntypeof g')).toBe('number')
    expect(await c.run('typeof g')).toBe('number')
    expect(await c.run('function plain() { var await = 3; return await }\nplain()')).toBe(3)
  })

  it('treats HTML-like comments as comments, as the compiled Script does', async () => {
    const c = chain()
    await c.run('const x = 5')
    expect(await c.run('x <!-- note')).toBe(5)
    expect(await c.run('x\n--> note')).toBe(5)
  })

  it('hoists function declarations that use copied bindings within the declaring program', async () => {
    const c = chain()
    await c.run('const base = 10')
    expect(await c.run('const result = twice()\nfunction twice() { return base * 2 }\nresult')).toBe(20)
    expect(await c.run('twice()')).toBe(20)
  })

  it('carries async and generator functions, keeping their own captured bindings', async () => {
    const c = chain()
    await c.run('const unit = 2\nasync function scaled(x) { await null; return x * unit }\nfunction* count() { yield unit; yield unit + 1 }')
    await c.run('const unit = 100')
    expect(await c.run('[await scaled(3), [...count()], unit]')).toEqual([6, [2, 3], 100])
  })

  it('resolves a name to the program\'s own later declaration, so reading it first hits that binding\'s TDZ', async () => {
    const c = chain()
    await c.run('let total = 1')
    expect(message(await c.failure('const previous = total\nlet total = previous + 1'))).toBe("ReferenceError: Cannot access 'total' before initialization")
    expect(await c.run('[total, typeof previous]')).toEqual([1, 'undefined'])
  })

  it('keeps the earlier value of a redeclared name whose initializer threw, and drops new uninitialized names', async () => {
    const c = chain()
    await c.run('const data = 1')
    expect(message(await c.failure('const data = (() => { throw new Error("fetch failed") })()'))).toBe('Error: fetch failed')
    expect(message(await c.failure('let data = (() => { throw new Error("again") })()'))).toBe('Error: again')
    expect(message(await c.failure('class data { static { throw new Error("static") } }'))).toBe('Error: static')
    expect(await c.run('data')).toBe(1)
    await c.failure('let fresh = (() => { throw new Error("boom") })()')
    expect(await c.run('typeof fresh')).toBe('undefined')
  })

  it('keeps the earlier value when a redeclaration fails while awaiting', async () => {
    const c = chain()
    await c.run('const data = 1')
    expect(message(await c.failure('const data = await Promise.reject(new Error("tool failed"))'))).toBe('Error: tool failed')
    expect(await c.run('data')).toBe(1)
  })

  it('keeps declarations and assignments that completed before a throw', async () => {
    const c = chain()
    await c.run('let carried = 1')
    await c.failure('let y = 5\ncarried = 2\nthrow new Error("mid")\nlet z = 6')
    expect(await c.run('[y, carried, typeof z]')).toEqual([5, 2, 'undefined'])
  })

  it('keeps the initialized part of a destructuring redeclaration that threw', async () => {
    const c = chain()
    await c.run('const a = "old a"; const b = "old b"')
    await c.failure('const [a, b = (() => { throw new Error("default") })()] = ["new a"]')
    expect(await c.run('[a, b]')).toEqual(['new a', 'old b'])
  })

  it('keeps the earlier value when a failed program does not reach its var redeclaration', async () => {
    const c = chain()
    await c.run('var v = 5')
    await c.failure('throw new Error("early")\nvar v = 6')
    expect(await c.run('v')).toBe(5)
    await c.failure('var v = await Promise.reject(new Error("tool failed"))')
    expect(await c.run('v')).toBe(5)
    await c.failure('var v = 7\nthrow new Error("late")')
    expect(await c.run('v')).toBe(7)
  })

  it('keeps the earlier value of a let binding through a failed var redeclaration in the next program', async () => {
    const c = chain()
    await c.run('let config = { retries: 1 }')
    await c.failure('var config = await Promise.reject(new Error("config service unavailable"))\nconfig.retries')
    expect(await c.run('config.retries')).toBe(1)
  })

  it('carries an assigned undefined from a var redeclaration that ran', async () => {
    const c = chain()
    await c.run('var found = 1')
    await c.failure('var found = undefined\nthrow new Error("after")')
    expect(await c.run('found')).toBeUndefined()
  })

  it('carries an unreached function redeclaration as the new function', async () => {
    const c = chain()
    await c.run('function f() { return "old" }')
    await c.failure('throw new Error("early")\nfunction f() { return "new" }')
    expect(await c.run('f()')).toBe('new')
  })

  it('carries var declarations from for heads and blocks into later programs', async () => {
    const c = chain()
    await c.run('for (var i = 0; i < 3; i++) {}\nif (true) { var inBlock = 1 }\ntry { var inTry = 2 } catch {}')
    expect(await c.run('[i, inBlock, inTry]')).toEqual([3, 1, 2])
  })

  it.each<[string, string]>([
    ['var data = 1', 'number'], ['let data = 1', 'number'], ['const data = 1', 'number'], ['function data() {}', 'function'], ['class data {}', 'function'],
  ])('redeclares an earlier name with a var inside a block while earlier closures keep theirs: %s', async (earlier, earlierType) => {
    const c = chain()
    await c.run(`${earlier}\nglobalThis.readData = () => data`)
    expect(await c.run('try {\n  var data = await Promise.resolve(3)\n} catch (error) {}\ndata')).toBe(3)
    expect(await c.run('[data, typeof readData()]')).toEqual([3, earlierType])
  })

  it('keeps the earlier value through a var redeclaration that does not run or has no initializer', async () => {
    const c = chain()
    await c.run('let cache = 1')
    await c.run('if (false) { var cache = 2 }')
    expect(await c.run('cache')).toBe(1)
    await c.run('var cache')
    expect(await c.run('cache')).toBe(1)
    await c.run('for (var cache of []) {}')
    expect(await c.run('cache')).toBe(1)
  })

  it('does not replace a function declared with a var of the same name in one program by the earlier value', async () => {
    const c = chain()
    await c.run('var both = 1')
    expect(await c.run('function both() { return "function" }\nvar both\nboth()')).toBe('function')
    expect(await c.run('both()')).toBe('function')
  })

  it('does not carry var declarations from nested functions and classes', async () => {
    const c = chain()
    await c.run('function f() { var inner = 1; return inner }\nclass C { static { var s = 1 } }\nf()')
    expect(await c.run('[typeof inner, typeof s, f()]')).toEqual(['undefined', 'undefined', 1])
  })

  it('leaves the chain unchanged after scan or compile errors', async () => {
    const c = chain()
    await c.run('let y = 1')
    expect(message(await c.failure('const = 2'))).toBe('SyntaxError: Unexpected token')
    const collision = await c.failure('globalThis.ran = true\ny++\nlet x = 1; let x = 2') as SyntaxError
    expect(message(collision)).toBe("SyntaxError: Identifier 'x' has already been declared")
    expect(collision.stack).toMatch(/^\/work\/ptc-program-3\.js:3\nlet x = 1; let x = 2\n +\^\n\nSyntaxError: /)
    expect(collision.stack).not.toContain('\n    at ')
    const strictViolation = await c.failure('globalThis.ran = true\ny++\nwith ({}) {}') as SyntaxError
    expect(message(strictViolation)).toBe('SyntaxError: Strict mode code may not include a with statement')
    expect(strictViolation.stack).not.toContain('\n    at ')
    expect(c.context.ran).toBeUndefined()
    expect(message(await c.failure('typeof __$binding_vals'))).toBe(`SyntaxError: Names starting with '${RESERVED_PREFIX}' are reserved`)
    expect(await c.run('y')).toBe(1)
  })

  it('carries many bindings in declaration order', async () => {
    const c = chain()
    await c.run(Array.from({ length: 200 }, (_, index) => `const n${index} = ${index}`).join('\n'))
    expect(await c.run('n0 + n199')).toBe(199)
  })

  it('skips a previous program whose body has not started when compiling the next one', async () => {
    const c = chain()
    await c.run('const settled = 1')
    const unstarted = c.compile('const early = 2')
    expect(await c.run('[typeof early, settled]')).toEqual(['undefined', 1])
    await unstarted()
    expect(await c.run('[typeof early, settled]')).toEqual(['undefined', 1])
  })

  it('reports redeclared names with the keyword of their most recent declaration before compiled programs run', async () => {
    const c = chain()
    await c.run('function f() {}\nlet a = 1\nconst untouched = 1')
    expect(c.redeclarations).toEqual([])
    await c.failure('const f = ;')
    const program = c.compile('const f = 1\nclass a {}')
    expect(c.redeclarations).toEqual([[{ name: 'f', previous: 'function', current: 'const' }, { name: 'a', previous: 'let', current: 'class' }]])
    await program()
    await c.run('untouched')
    await c.run('let f = 2')
    expect(c.redeclarations.at(-1)).toEqual([{ name: 'f', previous: 'const', current: 'let' }])
  })

  it('runs functions defined earlier with their own program filename and native positions', async () => {
    const c = chain()
    await c.run('function boom() {\n  throw new Error("x")\n}')
    const stack = await c.run('let stack\ntry { boom() } catch (error) { stack = error.stack }\nstack') as string
    expect(stack).toContain('/work/ptc-program-1.js:2:9')
    expect(stack).toContain('/work/ptc-program-2.js:2:7')
  })

  it('returns the boxed final expression without awaiting it, or nothing when the completion is disabled', async () => {
    const boxed = await chain().compile('Promise.resolve(3)')()
    expect(typeof (boxed?.value as { then?: unknown }).then).toBe('function')
    expect(await chain({ finalExpression: false }).compile('1 + 1')()).toBeUndefined()
  })

  it('passes dynamic import handling to the compiled Script', async () => {
    const c = chain()
    const program = c.scopes.compile('(await import("node:path")).sep', {
      filename: '/work/ptc-program-1.js', context: c.context, finalExpression: true, importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    })
    expect((await program())?.value).toBe(sep)
  })
})

describe('strict mode', () => {
  it('forces strict mode and reports strict-mode syntax violations from the compiler', async () => {
    const c = chain()
    expect(await c.run('this === undefined')).toBe(true)
    expect(message(await c.failure('undeclared = 1'))).toBe('ReferenceError: undeclared is not defined')
    const violation = await c.failure('with ({}) {}') as SyntaxError
    expect(message(violation)).toBe('SyntaxError: Strict mode code may not include a with statement')
    expect(violation.stack).toMatch(/^\/work\/ptc-program-3\.js:1\nwith \(\{\}\) \{\}\n\^+\n\nSyntaxError: /)
  })

  it('runs programs sloppy when strict mode is off, with shared globals for undeclared assignments', async () => {
    const c = chain({ strict: false })
    await c.run('undeclared = 1')
    expect(await c.run('with ({ w: 2 }) { globalThis.fromWith = w }\n[undeclared, fromWith, this === globalThis]')).toEqual([1, 2, true])
  })

  it('applies a leading "use strict" directive with and without copies when strict mode is off', async () => {
    const c = chain({ strict: false })
    expect(message(await c.failure('"use strict"\nfirst = 1'))).toBe('ReferenceError: first is not defined')
    await c.run('var carried = 1')
    expect(message(await c.failure('"use strict"\nsecond = 2'))).toBe('ReferenceError: second is not defined')
    expect(await c.run("'use strict';\n[this, carried]")).toEqual([undefined, 1])
    expect(await c.run('third = 3;\n[third, this === globalThis]')).toEqual([3, true])
  })

  it('fails later strict programs after a sloppy program declares a name reserved in strict mode', async () => {
    const c = chain({ strict: false })
    await c.run('var package = 1')
    expect(message(await c.failure('"use strict"\n1'))).toBe('SyntaxError: Unexpected strict mode reserved word')
    expect(await c.run('package')).toBe(1)
  })
})
