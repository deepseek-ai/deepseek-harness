/**
 * Import bindings in lowered bodies (`src/compile/transform.ts`): a named or
 * default import is read through its module object at each reference, so a
 * module in an import cycle sees a binding once the exporting module has
 * initialized it, as ES modules do. Covers the cycle itself, live reads, the
 * operation each rewritten reference keeps, shadowing, and the refused forms.
 */
import { describe, expect, test } from 'vitest'
import { lowerModuleSource } from '../../src/compile/transform.ts'
import { WRAPPER_PARAMS } from '../../src/image-layout.ts'

/** @returns The lowered body of one probe module. */
const transformModule = (source: string, path = 'probe.js'): string =>
  lowerModuleSource({ filename: path, source }).code

/**
 * Compile and run one lowered body with the loader's wrapper parameters.
 * @param code - Lowered body.
 * @param require - Module resolver the body's `require` calls reach.
 * @returns The populated `exports` object.
 */
function runBody(code: string, require: (specifier: string) => unknown = () => ({})): Record<string, unknown> {
  const module = { exports: {} as Record<string, unknown> }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the wrapper contract under test is a `new Function` body
  const factory = new Function(...WRAPPER_PARAMS, code) as (...args: unknown[]) => void
  factory(module.exports, require, module, '/vfs/probe.js', '/vfs', { url: 'file:///vfs/probe.js' }, undefined)
  return module.exports
}

/**
 * Lower and load a module graph with the worker loader's CommonJS cycle rule:
 * a module required while it is still evaluating answers its partial exports.
 * @param sources - Module sources by request name.
 * @param entry - The module to load first.
 * @returns The entry module's exports.
 */
function loadGraph(sources: Record<string, string>, entry: string): Record<string, unknown> {
  const cache = new Map<string, { exports: Record<string, unknown> }>()
  const load = (request: string): Record<string, unknown> => {
    const name = request.replace(/^\.\//, '')
    const cached = cache.get(name)
    if (cached !== undefined) return cached.exports
    const source = sources[name]
    if (source === undefined) throw new Error(`no module named ${name}`)
    const module = { exports: {} as Record<string, unknown> }
    cache.set(name, module)
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the wrapper contract under test is a `new Function` body
    const factory = new Function(...WRAPPER_PARAMS, transformModule(source, name)) as (...args: unknown[]) => void
    factory(module.exports, load, module, `/vfs/${name}`, '/vfs', { url: `file:///vfs/${name}` }, undefined)
    return module.exports
  }
  return load(entry)
}

/** @returns The error message of a refused transform, or undefined when it succeeded. */
const refusal = (source: string): string | undefined => {
  try {
    transformModule(source)
    return undefined
  } catch (reason) {
    return (reason as Error).message
  }
}

describe('import cycles', () => {
  test('a module reads an import after the exporting module initializes it', () => {
    // core.js starts first and requires util.js, which requires core.js back while
    // core.js has not yet reached `globalConfig` (the shape of zod's core/util pair).
    const core = loadGraph({
      'core.js': "import { members } from './util.js'\nexport function make() { return members() }\nexport const globalConfig = { jitless: true }\n",
      'util.js': "import { globalConfig } from './core.js'\nexport function members() { return globalConfig.jitless }\n",
    }, 'core.js')
    expect((core.make as () => boolean)()).toBe(true)
  })

  test('a default import reads the exporting module after it finishes', () => {
    const entry = loadGraph({
      'a.js': "import B from './b.js'\nexport const read = () => B()\nexport default function A() { return 'a' }\n",
      'b.js': "import A from './a.js'\nexport default function B() { return A() + 'b' }\n",
    }, 'a.js')
    expect((entry.read as () => string)()).toBe('ab')
  })
})

describe('live reads', () => {
  test('a named import observes a later change on its module', () => {
    const module: Record<string, unknown> = { counter: 1 }
    const exports = runBody(transformModule("import { counter } from 'p'\nexport const read = () => counter\n"), () => module)
    module.counter = 2
    expect((exports.read as () => number)()).toBe(2)
  })

  test('a default import observes a later change on its module', () => {
    const module: Record<string, unknown> = { __esModule: true, default: 1 }
    const exports = runBody(transformModule("import value from 'p'\nexport const read = () => value\n"), () => module)
    module.default = 2
    expect((exports.read as () => number)()).toBe(2)
  })

  test('re-exporting an import through a local export clause stays live', () => {
    const module: Record<string, unknown> = { a: 1 }
    const exports = runBody(transformModule("import { a } from 'p'\nexport { a, a as alias }\n"), () => module)
    module.a = 2
    expect([exports.a, exports.alias]).toEqual([2, 2])
  })

  test('a default import re-exported through a local export clause stays live', () => {
    const module: Record<string, unknown> = { __esModule: true, default: 1 }
    const exports = runBody(transformModule("import value from 'p'\nexport { value }\n"), () => module)
    module.default = 2
    expect(exports.value).toBe(2)
  })
})

describe('rewritten references keep their operation', () => {
  const receiver = function (this: unknown): unknown { return this }

  test('calling a named import passes no receiver', () => {
    const exports = runBody(transformModule("import { f } from 'p'\nexport const seen = f()\n"), () => ({ f: receiver }))
    expect(exports.seen).toBeUndefined()
  })

  test('an optional call of a named import passes no receiver', () => {
    const exports = runBody(transformModule("import { f } from 'p'\nexport const seen = f?.()\n"), () => ({ f: receiver }))
    expect(exports.seen).toBeUndefined()
  })

  test('a named import used as a template tag passes no receiver', () => {
    const exports = runBody(transformModule("import { f } from 'p'\nexport const seen = f`x`\n"), () => ({ f: receiver }))
    expect(exports.seen).toBeUndefined()
  })

  test('new constructs named and default imports, including a member of a default import', () => {
    class Named { readonly kind = 'named' }
    class Inner { readonly kind = 'inner' }
    class Default { static readonly Inner = Inner; readonly kind = 'default' }
    const code = transformModule([
      "import D, { Named } from 'p'",
      'export const made = [new Named().kind, new D().kind, new D.Inner().kind, new D, new Named]',
    ].join('\n'))
    const made = runBody(code, () => ({ __esModule: true, default: Default, Named })).made as unknown[]
    expect(made.slice(0, 3)).toEqual(['named', 'default', 'inner'])
    expect([made[3] instanceof Default, made[4] instanceof Named]).toEqual([true, true])
  })

  test('a shorthand property keeps its key and reads the import', () => {
    const exports = runBody(transformModule("import { a } from 'p'\nexport const object = { a }\n"), () => ({ a: 1 }))
    expect(exports.object).toEqual({ a: 1 })
  })

  test('computed keys, class heritage, typeof, spread, and default export read the import', () => {
    class Base { readonly base = true }
    const code = transformModule([
      "import { key, Base, list } from 'p'",
      'export const object = { [key]: typeof Base, ...list }',
      'export class Derived extends Base {}',
      'export default key',
    ].join('\n'))
    const exports = runBody(code, () => ({ key: 'k', Base, list: ['z'] }))
    expect(exports.object).toEqual({ k: 'function', 0: 'z' })
    expect(new (exports.Derived as new () => { base: boolean })().base).toBe(true)
    expect(exports.default).toBe('k')
  })

  test('a call at the start of a statement does not extend a preceding statement without a semicolon', () => {
    let calls = 0
    const code = transformModule("import d, { f } from 'p'\nexport const a = 1\nf()\nexport const b = 2\nd.bump()\n")
    const exports = runBody(code, () => ({ __esModule: true, default: { bump: () => { calls += 1 } }, f: () => { calls += 1 } }))
    expect([exports.a, exports.b, calls]).toEqual([1, 2, 2])
  })

  test('a call as the body of an if statement stays conditional', () => {
    let calls = 0
    runBody(transformModule("import { f } from 'p'\nif (false) f()\n"), () => ({ f: () => { calls += 1 } }))
    expect(calls).toBe(0)
  })

  test('calling a default import at the start of a statement does not extend the preceding statement', () => {
    let calls = 0
    const exports = runBody(
      transformModule("import d from 'p'\nexport const a = 1\nd()\n"),
      () => ({ __esModule: true, default: () => { calls += 1 } }),
    )
    expect([exports.a, calls]).toEqual([1, 1])
  })

  test('references inside rewritten suspension points are rewritten too', async () => {
    const code = transformModule([
      "import { source, value } from 'p'",
      'export const run = async () => { const seen = []; for await (const item of source) seen.push(item + await value); return seen }',
    ].join('\n'))
    const als = {
      pause: (awaited: unknown) => Promise.resolve(awaited).then(settled => ({ ok: true, value: settled })),
      resume: (token: { value: unknown }) => token.value,
      iterator: (iterable: Iterable<number>) => {
        const inner = iterable[Symbol.iterator]()
        return { next: () => Promise.resolve(inner.next()) }
      },
      close: () => Promise.resolve(),
    }
    const module = { exports: {} as Record<string, unknown> }
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the wrapper contract under test is a `new Function` body
    const factory = new Function(...WRAPPER_PARAMS, code) as (...args: unknown[]) => void
    factory(module.exports, () => ({ source: [1, 2], value: 10 }), module, '/vfs/probe.js', '/vfs', { url: 'file:///vfs/probe.js' }, als)
    expect(await (module.exports.run as () => Promise<number[]>)()).toEqual([11, 12])
  })
})

describe('emitted import statements', () => {
  test('named and default imports declare no locals; namespace imports keep theirs', () => {
    const code = transformModule("import d, { a, b as c } from 'p'\nimport * as ns from 'q'\nexport const out = [d, a, c, ns]\n")
    expect(code).toContain('const __dsh$m1=require("p");')
    expect(code).toContain('const ns=__dsh$ns(__dsh$m2);')
    expect(code).not.toMatch(/const (d|a|c)=/)
    expect(code).toContain('__dsh$m1["b"]')
  })

  test('a reference ahead of its import declaration reads the same module', () => {
    const exports = runBody(transformModule("export const read = () => a\nimport { a } from 'p'\n"), () => ({ a: 1 }))
    expect((exports.read as () => number)()).toBe(1)
  })

  test('a same-named local elsewhere changes nothing in the lines that read the import', () => {
    // The parameter `a` declares an import's name, which sends the module
    // through scope analysis; the shared lines must lower identically.
    const shared = "import d, { a, b } from 'p'\nexport const read = () => [a, b(), { a }, d.x]\nb``\n"
    const plain = transformModule(shared).split('\n')
    const shadowed = transformModule(`${shared}function unrelated(a) { return a }\n`).split('\n')
    expect(shadowed.slice(0, 3)).toEqual(plain.slice(0, 3))
    expect(shadowed[3]).toBe('function unrelated(a) { return a }')
  })
})

/**
 * Cases where a name `x` is also imported: `probe(() => x)` records whether
 * the reference reached the import or a local binding (including one still in
 * its temporal dead zone). Expected values follow ES module scoping; each case
 * gives the same answer under Node's native ES module loader.
 */
const SHADOWING_CASES: ReadonlyArray<readonly [name: string, body: string, expected: 'import' | 'local']> = [
  ['plain reference', 'probe(() => x)', 'import'],
  ['parameter', 'function f(x){ probe(() => x) } f(1)', 'local'],
  ['let later in the same block', '{ probe(() => x); let x = 1 }', 'local'],
  ['var hoisted from a nested block', 'function f(){ probe(() => x); if (1) { var x = 1 } } f()', 'local'],
  ['function declared in a block, read outside', '{ function x(){} } probe(() => x)', 'import'],
  ['class expression name inside the class', 'const C = class x { static m(){ probe(() => x) } }; C.m()', 'local'],
  ['named function expression inside itself', 'const g = function x(){ probe(() => x) }; g()', 'local'],
  ['catch parameter', 'try { throw 1 } catch (x) { probe(() => x) }', 'local'],
  ['destructured catch parameter', 'try { throw { x: 1 } } catch ({ x }) { probe(() => x) }', 'local'],
  ['for-of let inside the loop', 'for (let x of [1]) probe(() => x)', 'local'],
  ['for-of let after the loop', 'for (let x of [1]) {} probe(() => x)', 'import'],
  ['let in a switch case', 'switch (1) { case 1: let x = 1; probe(() => x) }', 'local'],
  ['parameter default naming a later parameter', 'const h = (a = probe(() => x), x) => 0; h()', 'local'],
  ['let in a class static block', 'class K { static { let x = 1; probe(() => x) } }', 'local'],
  ['destructured parameter', 'function f({ a: [x] }) { probe(() => x) } f({ a: [1] })', 'local'],
  ['function declared later in the body', 'function f(){ probe(() => x); function x(){} } f()', 'local'],
  ['label of the same name', 'x: for (;;) { probe(() => x); break x }', 'import'],
  ['class declared later in the block', '{ probe(() => x); class x {} }', 'local'],
  ['parameter of a sibling function', 'function a(x){} function b(){ probe(() => x) } b()', 'import'],
  ['parameter default beside a body var', 'function f(a = probe(() => x)) { var x = 1 } f()', 'import'],
  ['var in a class static block', 'class K { static { var x = 1; probe(() => x) } }', 'local'],
  ['let in a static block, read outside the class', 'class K { static { let x = 1 } }\nprobe(() => x)', 'import'],
  ['rest parameter', 'function f(...x) { probe(() => x) } f(1)', 'local'],
  ['rest element in array destructuring', '{ const [...x] = [1]; probe(() => x) }', 'local'],
  ['rest property in object destructuring', '{ const { ...x } = {}; probe(() => x) }', 'local'],
  ['parameter with a default value', 'function f(x = 1) { probe(() => x) } f()', 'local'],
  ['destructured property with a default value', '{ const { x = 1 } = {}; probe(() => x) }', 'local'],
]

describe('a reference reads the import exactly where ES module scoping resolves to it', () => {
  const imported = Symbol('imported')
  test.each(SHADOWING_CASES)('%s', (_name, body, expected) => {
    const seen: string[] = []
    const probe = (read: () => unknown): void => {
      try {
        seen.push(read() === imported ? 'import' : 'local')
      } catch (reason) {
        if (!(reason instanceof ReferenceError)) throw reason
        seen.push('local')
      }
    }
    const code = transformModule(`import { x } from 'm'\nimport { probe } from 'probe'\n${body}\n`)
    runBody(code, specifier => (specifier === 'm' ? { x: imported } : { probe }))
    expect(seen).toEqual([expected])
  })
})

describe('refused forms', () => {
  test.each([
    ['assigning a named import', "import { x } from 'p'\nx = 1\n"],
    ['updating a named import', "import { x } from 'p'\nexport const f = () => x++\n"],
    ['destructuring into a named import', "import { x } from 'p'\n;({ x } = {})\n"],
    ['assigning a default import', "import d from 'p'\nexport const f = () => { d = 1 }\n"],
    ['assigning a named import in a for-of head', "import { x } from 'p'\nfor (x of []) {}\n"],
  ])('%s fails the transform', (_name, source) => {
    expect(refusal(source)).toMatch(/the import \w+ cannot be assigned \(probe\.js:\d+\)/)
  })

  test('a direct eval in a module with named imports fails the transform', () => {
    expect(refusal("import { x } from 'p'\nexport const f = () => eval('x')\n")).toContain('direct eval')
  })

  test('an optional call of eval is indirect and still lowers', () => {
    expect(refusal("import { x } from 'p'\nexport const f = () => [x, eval?.('1')]\n")).toBeUndefined()
  })

  test('a direct eval in a module without named or default imports still lowers', () => {
    expect(refusal("import * as ns from 'p'\nexport const f = () => eval('ns')\n")).toBeUndefined()
  })

  test('a declaration using the reserved prefix fails the transform', () => {
    expect(refusal("import { x } from 'p'\nfunction f() { const __dsh$m1 = x }\n")).toContain('reserved __dsh$ prefix')
  })
})
