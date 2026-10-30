/**
 * Semantic check of the worker module transform (`src/compile/transform.ts`): what the
 * emitted CommonJS body looks like for each module form, how suspension points
 * are rewritten, that line numbers survive, which forms are refused, and that
 * every covered trap form stays fixed.
 *
 * Scope boundary: this file checks the transform itself; the pack-time loop
 * around it is covered end-to-end by the packer's `image-loadable.spec.ts`.
 * Emitted-code assertions are deliberately written against substrings
 * of the real output rather than whole-file goldens: a golden would fail on every
 * helper reordering, which is not the contract. The contract is the observable
 * one — the code parses as script, publishes the right bindings, keeps line
 * count, and routes suspension through `__als`.
 *
 * The trap cases are module forms that break a boot when the transform
 * mishandles them. Five traps cannot recur while the AST pass is the parser,
 * but they stay checked because a future parser swap could reintroduce them.
 */
import { expect, test } from 'vitest'
import { parse } from 'acorn'
import { lowerModuleSource } from '../../src/compile/transform.ts'
import { LOWERING_VERSION, WRAPPER_PARAMS } from '../../src/image-layout.ts'

/**
 * Lower one probe module the way the packer does — the transform's only caller.
 * @param source - Module source under test.
 * @param path - Path the diagnostics name.
 * @returns The emitted body.
 */
const transformModule = (source: string, path = 'probe.js'): string =>
  lowerModuleSource({ filename: path, source }).code

/** Register one comparison as its own case, serialized at call time. */
const check = (label: string, actual: unknown, expected: unknown): void => {
  const [seen, wanted] = [JSON.stringify(actual), JSON.stringify(expected)]
  test(label, () => { expect(seen).toBe(wanted) })
}

/** Assert a substring is present in an emitted body. */
const contains = (label: string, code: string, needle: string): void => {
  test(label, () => { expect(code).toContain(needle) })
}

/** Assert a substring is absent (used for "must survive untouched" cases). */
const lacks = (label: string, code: string, needle: string): void => {
  test(label, () => { expect(code).not.toContain(needle) })
}

/** @returns The error message of a refused transform, or undefined when it succeeded. */
const refusal = (source: string, path = 'probe.js'): string | undefined => {
  try {
    transformModule(source, path)
    return undefined
  } catch (reason) {
    return (reason as Error).message
  }
}

/** Assert the transform refuses a source and names the reason. */
const refuses = (label: string, source: string, fragment: string): void => {
  const message = refusal(source)
  test(label, () => { expect(message).toContain(fragment) })
}

/**
 * The wrapper contract, applied for real: compile the body with the declared
 * parameters and run it. This is the same `new Function` shape the loader uses
 * (module-loader.ts), so a body that compiles here compiles there.
 * @param code - Emitted CommonJS body.
 * @param require - Module resolver the body's `require` calls reach.
 * @param als - Suspension runtime bound to `__als`.
 * @returns The populated `exports` object.
 */
function runBody(
  code: string,
  require: (specifier: string) => unknown = () => ({}),
  als?: unknown,
): Record<string, unknown> {
  const exports: Record<string, unknown> = {}
  const module = { exports }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the wrapper contract under test is a `new Function` body
  const factory = new Function(...WRAPPER_PARAMS, code) as (...args: unknown[]) => void
  factory(exports, require, module, '/vfs/probe.js', '/vfs', { url: 'file:///vfs/probe.js' }, als)
  return exports
}

/** Every emitted body must parse as a script — the transform's own exit gate, re-checked here. */
const parsesAsScript = (label: string, code: string): void => {
  test(label, () => {
    expect(() => parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: false })).not.toThrow()
  })
}

// ---------------------------------------------------------------------------
// 1. The published contract: the three names the packer and loader share.
// ---------------------------------------------------------------------------

check('LOWERING_VERSION is a non-empty string', typeof LOWERING_VERSION === 'string' && LOWERING_VERSION.length > 0, true)
check('WRAPPER_PARAMS is the frozen 7-parameter shape', [...WRAPPER_PARAMS], [
  'exports', 'require', 'module', '__filename', '__dirname', '__dsh$meta', '__als',
])
// The wrapper signature is a contract with the loader's `new Function`, so the
// parameters must be valid identifiers in that position.
check(
  'every wrapper parameter is a usable identifier',
  (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval -- proves the parameter names compile where the loader uses them
      new Function(...WRAPPER_PARAMS, 'return 0')
      return true
    } catch {
      return false
    }
  })(),
  true,
)

// ---------------------------------------------------------------------------
// 2. lowerModuleSource: the packer face. `lowered` is the pack-time decision.
// ---------------------------------------------------------------------------

{
  const esm = lowerModuleSource({ filename: 'node_modules/p/index.js', source: 'export const a = 1\n' })
  check('lowered=true for a module that needed rewriting', esm.lowered, true)
  check('lowered code differs from source', esm.code !== 'export const a = 1\n', true)

  // Plain CommonJS with no suspension point is the "pack as-is" case: the
  // collector relies on this to leave 1693-odd entries untouched.
  const plain = 'module.exports = 1\n'
  const cjs = lowerModuleSource({ filename: 'node_modules/p/legacy.cjs', source: plain })
  check('lowered=false for plain CommonJS', cjs.lowered, false)
  check('unlowered code is the input verbatim', cjs.code, plain)

  // A CommonJS body that still contains a suspension point must be rewritten:
  // `await` inside a function is the ALS protocol's business even with no ESM.
  const cjsAwait = lowerModuleSource({
    filename: 'node_modules/p/async.cjs',
    source: 'module.exports = async () => { await 1 }\n',
  })
  check('lowered=true for CommonJS carrying a suspension point', cjsAwait.lowered, true)
  contains('CommonJS await still routes through __als', cjsAwait.code, '__als.pause(')

  // `lowered` must agree with the code/source comparison by construction.
  check('lowered mirrors code !== source', cjsAwait.lowered, cjsAwait.code !== 'module.exports = async () => { await 1 }\n')
}

{
  const direct = lowerModuleSource({
    filename: 'node_modules/p/direct.js',
    source: "import { createRequire } from 'node:module'\ncreateRequire(import.meta.url)('external-package')\n",
  })
  check('literal createRequire call is a module request', direct.moduleRequests, ['node:module', 'external-package'])

  const aliased = lowerModuleSource({
    filename: 'node_modules/p/aliased.js',
    source: "makeRequire(import.meta.url)('aliased-package')\nimport { createRequire as makeRequire } from 'node:module'\n",
  })
  check('aliased createRequire import is indexed before traversal', aliased.moduleRequests, ['aliased-package', 'node:module'])

  const runtimeOnly = lowerModuleSource({
    filename: 'node_modules/p/runtime-only.js',
    source: [
      "import { createRequire } from 'node:module'",
      'const localRequire = createRequire(import.meta.url)',
      "localRequire('stored')",
      "createRequire(new URL('./other.js', import.meta.url))('rebased')",
      "{ const createRequire = () => () => undefined; createRequire(import.meta.url)('block-shadowed') }",
      "function load(createRequire) { createRequire(import.meta.url)('parameter-shadowed') }",
      "for (const createRequire of []) createRequire(import.meta.url)('for-of-shadowed')",
      "switch (0) { case 0: const createRequire = () => () => undefined; createRequire(import.meta.url)('switch-shadowed') }",
    ].join('\n'),
  })
  check('stored, rebased, and shadowed createRequire calls stay runtime-only', runtimeOnly.moduleRequests, ['node:module'])
}

// ---------------------------------------------------------------------------
// 3. Import forms.
// ---------------------------------------------------------------------------

{
  // Side-effect import: a bare require, nothing bound.
  const code = transformModule("import './side-effect.js'\n", 'probe.js')
  contains('side-effect import becomes a bare require', code, 'require("./side-effect.js")')
  parsesAsScript('side-effect import', code)

  const requested: string[] = []
  runBody(code, (specifier) => {
    requested.push(specifier)
    return {}
  })
  check('side-effect import actually requires at run time', requested, ['./side-effect.js'])
}

{
  // Named imports read the required module at each reference; cycles, live
  // reads, and shadowing are covered in transform-imports.spec.ts.
  const code = transformModule("import { a, b as c } from 'p'\nexport const out = [a, c]\n", 'probe.js')
  parsesAsScript('named imports', code)
  const exports = runBody(code, () => ({ a: 1, b: 2 }))
  check('named import binds by imported name, honouring the alias', exports.out, [1, 2])
}

{
  // Default and namespace imports go through the two interop helpers, which must
  // agree with `Loader.unwrapExports` on the `__esModule` convention.
  const code = transformModule("import d from 'p'\nimport * as ns from 'q'\nexport const seen = [d, ns.x, ns.default]\n", 'probe.js')
  parsesAsScript('default and namespace imports', code)

  // An `__esModule` module: default comes from `.default`, namespace passes through.
  const esModule = { __esModule: true, default: 'D', x: 'X' }
  const withEsm = runBody(code, () => esModule)
  check('default import of an __esModule module reads .default', (withEsm.seen as unknown[])[0], 'D')

  // Some CommonJS bundles mark their export object as __esModule without
  // providing a default export. The default import is still that object.
  const cjsEsModule = { __esModule: true, x: 'X' }
  const withCjsEsModule = runBody(code, () => cjsEsModule)
  check('default import of an __esModule CommonJS module keeps its exports', (withCjsEsModule.seen as unknown[])[0], cjsEsModule)

  // A plain CommonJS module: the module object *is* the default, and the
  // namespace gains a `default` key pointing at it.
  const plain = { x: 'X' }
  const withCjs = runBody(code, () => plain)
  check('default import of plain CommonJS is the module object', (withCjs.seen as unknown[])[0], plain)
  check('namespace of plain CommonJS keeps the named key', (withCjs.seen as unknown[])[1], 'X')
  check('namespace of plain CommonJS synthesizes default', (withCjs.seen as unknown[])[2], plain)
}

// ---------------------------------------------------------------------------
// 4. Export forms, including the live-binding contract.
// ---------------------------------------------------------------------------

{
  const code = transformModule('export const a = 1\nexport function f() {}\nexport class K {}\n', 'probe.js')
  parsesAsScript('exported declarations', code)
  contains('module bodies get the __esModule marker', code, '__esModule')
  contains('use strict is part of the prologue', code, '"use strict"')
  const exports = runBody(code)
  check('exported const is published', exports.a, 1)
  check('exported function is published', typeof exports.f, 'function')
  check('exported class is published', typeof exports.K, 'function')
}

{
  // Local exports are getters, so a later assignment is observable through
  // `exports` — the ESM live-binding property.
  const code = transformModule('export let counter = 0\nexport function bump() { counter += 1 }\n', 'probe.js')
  parsesAsScript('live binding', code)
  const exports = runBody(code)
  check('live binding starts at its initializer', exports.counter, 0)
  ;(exports.bump as () => void)()
  check('live binding observes a later assignment', exports.counter, 1)
  // A getter, not a data property: this is what makes the above work.
  check(
    'exported local is an accessor',
    typeof Object.getOwnPropertyDescriptor(exports, 'counter')?.get,
    'function',
  )
}

{
  // Trap 4: a multi-declarator export publishes every binding.
  const code = transformModule('export const a = 1, b = 2\n', 'probe.js')
  parsesAsScript('multi-declarator export', code)
  const exports = runBody(code)
  check('multi-declarator export publishes every binding', [exports.a, exports.b], [1, 2])
}

{
  // Destructuring exports exercise the pattern walker (object, array, rest,
  // default) — every branch of `declaredBindings`.
  const code = transformModule(
    'export const { p, q: renamed, ...restObj } = { p: 1, q: 2, z: 3 }\n'
    + 'export const [first, , third = 30, ...restArr] = [10, 20, undefined, 40, 50]\n',
    'probe.js',
  )
  parsesAsScript('destructuring exports', code)
  const exports = runBody(code)
  check('object pattern export', [exports.p, exports.renamed], [1, 2])
  check('object rest export', exports.restObj, { z: 3 })
  check('array pattern export with hole', [exports.first, exports.third], [10, 30])
  check('array rest export', exports.restArr, [40, 50])
  // The renamed target is what is published; the source key is not a binding.
  check('object pattern publishes the local name, not the source key', 'q' in exports, false)
}

{
  const code = transformModule('const x = 1\nexport { x as y }\n', 'probe.js')
  parsesAsScript('local export clause', code)
  const exports = runBody(code)
  check('local export clause publishes under the exported name', exports.y, 1)
  check('local export clause does not publish the local name', 'x' in exports, false)
}

{
  // Re-export clause: a getter onto the required module, so it also stays live.
  const module: Record<string, unknown> = { a: 1 }
  const code = transformModule("export { a, a as aliased } from 'p'\n", 'probe.js')
  parsesAsScript('re-export clause', code)
  const exports = runBody(code, () => module)
  check('re-export publishes the name', exports.a, 1)
  check('re-export publishes the alias', exports.aliased, 1)
  module.a = 2
  check('re-export is live against the source module', exports.a, 2)
}

{
  // `export *` copies enumerable keys, skips `default`, and must not clobber an
  // existing local export.
  const code = transformModule("export const own = 'local'\nexport * from 'p'\n", 'probe.js')
  parsesAsScript('export all', code)
  const exports = runBody(code, () => ({ extra: 'E', default: 'D', own: 'theirs' }))
  check('export * copies named keys', exports.extra, 'E')
  check('export * skips default', 'default' in exports, false)
  check('export * does not overwrite an existing export', exports.own, 'local')
}

{
  const code = transformModule("export * as ns from 'p'\n", 'probe.js')
  parsesAsScript('export all as namespace', code)
  const exports = runBody(code, () => ({ x: 1 }))
  check('export * as ns publishes a namespace object', (exports.ns as Record<string, unknown>).x, 1)
}

{
  const code = transformModule('export default 42\n', 'probe.js')
  parsesAsScript('default export value', code)
  check('default export lands on exports.default', runBody(code).default, 42)
}

{
  // Documented cost: the function name stops being a module-scope binding, but
  // the named function expression can still refer to itself.
  const code = transformModule('export default function self(n) { return n <= 0 ? 0 : self(n - 1) }\n', 'probe.js')
  parsesAsScript('default export function', code)
  const fn = runBody(code).default as (n: number) => number
  check('default-exported function keeps self-reference', fn(3), 0)
}

{
  const code = transformModule("export { x as default } from 'p'\n", 'probe.js')
  parsesAsScript('re-export as default', code)
  check('re-export as default publishes default', runBody(code, () => ({ x: 'D' })).default, 'D')
}

// ---------------------------------------------------------------------------
// 5. import.meta and dynamic import.
// ---------------------------------------------------------------------------

{
  const code = transformModule('export const here = import.meta.url\n', 'probe.js')
  parsesAsScript('import.meta', code)
  contains('import.meta becomes the wrapper parameter', code, '__dsh$meta')
  check('import.meta.url resolves through the wrapper', runBody(code).here, 'file:///vfs/probe.js')
}

{
  // Dynamic import routes through the same require chain (which is what makes
  // typert-loader's absolute-path `import()` land on the VFS resolver), and the
  // result is namespace-shaped.
  const code = transformModule("export const load = () => import('p')\n", 'probe.js')
  parsesAsScript('dynamic import', code)
  contains('dynamic import becomes the helper call', code, '__dsh$dynImport')
  const load = runBody(code, () => ({ x: 1 })).load as () => Promise<Record<string, unknown>>
  const namespace = await load()
  check('dynamic import resolves to a namespace object', namespace.x, 1)
  check('dynamic import namespace has a default', 'default' in namespace, true)
}

// ---------------------------------------------------------------------------
// 6. Suspension points. Behaviour is checked against a recording runtime, so
//    these assert the protocol shape rather than re-testing als-runtime.
// ---------------------------------------------------------------------------

/** A recording stand-in for the ALS runtime: proves the emitted calls happen in order. */
function recordingAls(): { als: Record<string, unknown>; calls: string[] } {
  const calls: string[] = []
  const als = {
    pause: (value: unknown) => {
      calls.push('pause')
      return Promise.resolve(value).then(
        settled => ({ ok: true, value: settled, snapshot: 'S' }),
        (error: unknown) => ({ ok: false, error, snapshot: 'S' }),
      )
    },
    resume: (token: { ok: boolean; value?: unknown; error?: unknown }) => {
      calls.push('resume')
      if (token.ok) return token.value
      throw token.error
    },
    snapshot: () => {
      calls.push('snapshot')
      return 'S'
    },
    afterYield: (_snapshot: unknown, sent: unknown) => {
      calls.push('afterYield')
      return sent
    },
    iterator: (value: unknown) => {
      calls.push('iterator')
      const source = value as Record<PropertyKey, unknown>
      const asyncFactory = source[Symbol.asyncIterator] as (() => AsyncIterator<unknown>) | undefined
      if (typeof asyncFactory === 'function') return asyncFactory.call(source)
      const syncFactory = source[Symbol.iterator] as () => Iterator<unknown, unknown>
      const inner = syncFactory.call(source)
      return {
        next: async (...args: unknown[]) => {
          const step = inner.next(...args as [unknown])
          return { done: step.done ?? false, value: await step.value }
        },
        return: async (sent?: unknown) => {
          const step = inner.return?.(sent) ?? { done: true, value: undefined }
          return { done: step.done ?? true, value: await step.value }
        },
      }
    },
    close: async (iterator: AsyncIterator<unknown>) => {
      calls.push('close')
      return iterator.return?.(undefined)
    },
  }
  return { als, calls }
}

{
  const code = transformModule('export const run = async () => await 7\n', 'probe.js')
  parsesAsScript('await rewrite', code)
  contains('await is wrapped in resume(await pause(', code, '__als.resume(await __als.pause(')
  const { als, calls } = recordingAls()
  const run = runBody(code, () => ({}), als).run as () => Promise<number>
  check('await still yields its value', await run(), 7)
  check('await goes pause-then-resume', calls, ['pause', 'resume'])
}

{
  // The rejection path is the half that a naive "snapshot on success" rewrite
  // gets wrong, so it is checked as its own case.
  const code = transformModule(
    "export const run = async () => { try { await Promise.reject(new Error('boom')) } catch (reason) { return `caught:${reason.message}` } }\n",
    'probe.js',
  )
  parsesAsScript('await rejection', code)
  const { als, calls } = recordingAls()
  const run = runBody(code, () => ({}), als).run as () => Promise<string>
  check('rejection surfaces through resume', await run(), 'caught:boom')
  check('rejection path also goes pause-then-resume', calls, ['pause', 'resume'])
}

{
  // for-await desugars to an explicit loop; `return()` must run only on abrupt
  // completion, which is the language rule. The two
  // completion paths need two different loop bodies, so they are separate cases.
  const plain = 'export const run = async (src) => { const seen = []\n'
    + 'for await (const item of src) { seen.push(item) }\n'
    + 'return seen }\n'
  const code = transformModule(plain, 'probe.js')
  parsesAsScript('for-await', code)
  contains('for-await uses the iterator helper', code, '__als.iterator(')
  contains('for-await closes on abrupt completion', code, '__als.close(')

  /** An async iterable counting up to `n`, rebuilt per case so state cannot leak. */
  const counting = (n: number): unknown => ({
    [Symbol.asyncIterator]: () => {
      let emitted = 0
      return {
        next: () => Promise.resolve(
          emitted < n ? { done: false, value: ++emitted } : { done: true, value: undefined },
        ),
      }
    },
  })

  // Normal completion: the iterator is exhausted, so `return()` must NOT run.
  const { als, calls } = recordingAls()
  const run = runBody(code, () => ({}), als).run as (src: unknown) => Promise<number[]>
  check('for-await over an async source collects values', await run(counting(2)), [1, 2])
  check('normal completion does not close the iterator', calls.includes('close'), false)

  // Abrupt completion (break), and a sync source whose values are promises
  // (async-from-sync): close must run exactly once.
  const breaking = 'export const run = async (src) => { const seen = []\n'
    + 'for await (const item of src) { seen.push(item); if (item === 2) break }\n'
    + 'return seen }\n'
  const breakingCode = transformModule(breaking, 'probe.js')
  parsesAsScript('for-await with break', breakingCode)
  const { als: als2, calls: calls2 } = recordingAls()
  const run2 = runBody(breakingCode, () => ({}), als2).run as (src: unknown) => Promise<number[]>
  const syncSource = {
    [Symbol.iterator]: () => [Promise.resolve(1), Promise.resolve(2), Promise.resolve(3)][Symbol.iterator](),
  }
  check('for-await accepts a sync source of promises', await run2(syncSource), [1, 2])
  check('break closes the iterator exactly once', calls2.filter(name => name === 'close').length, 1)
}

{
  // Destructuring in the loop head goes through the same binding path.
  const code = transformModule(
    'export const run = async (src) => { const seen = []\nfor await (const { v } of src) seen.push(v)\nreturn seen }\n',
    'probe.js',
  )
  parsesAsScript('for-await destructuring', code)
  const { als } = recordingAls()
  const run = runBody(code, () => ({}), als).run as (src: unknown) => Promise<number[]>
  check('for-await destructures each step', await run([{ v: 1 }, { v: 2 }]), [1, 2])
}

{
  // A non-block body must still be wrapped, or the emitted loop would swallow
  // the following statement.
  const code = transformModule(
    'export const run = async (src) => { let sum = 0\nfor await (const n of src) sum += n\nreturn sum }\n',
    'probe.js',
  )
  parsesAsScript('for-await single-statement body', code)
  const { als } = recordingAls()
  const run = runBody(code, () => ({}), als).run as (src: unknown) => Promise<number>
  check('for-await with a non-block body runs correctly', await run([1, 2, 3]), 6)
}

{
  // `yield` in an async generator: the snapshot is taken before suspending and
  // the consumer's sent value comes back through afterYield.
  const code = transformModule(
    'export async function* gen() { const got = yield 1\nyield got * 2 }\n',
    'probe.js',
  )
  parsesAsScript('yield rewrite', code)
  contains('yield is wrapped in afterYield(snapshot(), yield ...)', code, '__als.afterYield(__als.snapshot(),yield ')
  const { als, calls } = recordingAls()
  const gen = runBody(code, () => ({}), als).gen as () => AsyncGenerator<number, void, number>
  const iterator = gen()
  check('first yield produces its value', (await iterator.next(0)).value, 1)
  check('sent value returns through afterYield', (await iterator.next(21)).value, 42)
  check('yield recorded snapshot and afterYield', calls.filter(name => name === 'afterYield').length >= 1, true)
}

{
  // Statement-position `yield*` desugars into a forwarding loop.
  const code = transformModule(
    'export async function* outer(inner) { yield* inner\nyield "tail" }\n',
    'probe.js',
  )
  parsesAsScript('yield* rewrite', code)
  const { als } = recordingAls()
  const outer = runBody(code, () => ({}), als).outer as (inner: unknown) => AsyncGenerator<unknown, void, unknown>
  const collected: unknown[] = []
  for await (const value of outer(['a', 'b'])) collected.push(value)
  check('yield* forwards inner values then continues', collected, ['a', 'b', 'tail'])
}

// ---------------------------------------------------------------------------
// 7. Line numbers. The debugging contract: a stack frame in a transformed body
//    points at the same line as the artifact it came from.
// ---------------------------------------------------------------------------

/** @returns Line count of a string, counting a trailing newline's line as the last. */
const lineCount = (text: string): number => text.split('\n').length

{
  // The prologue is emitted without a trailing newline, so a transformed body
  // has exactly as many lines as its source. Anything else is line drift.
  const cases: Array<{ readonly label: string; readonly source: string }> = [
    { label: 'imports and exports', source: "import { a } from 'p'\n\nexport const b = a\n\nexport default b\n" },
    { label: 'await in a function', source: 'export const f = async () => {\n  const v = await g()\n  return v\n}\n' },
    {
      label: 'for-await (body re-emitted)',
      source: 'export const f = async (src) => {\n  for await (const x of src) {\n    use(x)\n  }\n  done()\n}\n',
    },
    {
      label: 'yield* (statement desugared)',
      source: 'export async function* f(inner) {\n  yield* inner\n  after()\n}\n',
    },
    { label: 'export * with following lines', source: "export * from 'p'\nconst tail = 1\nexport { tail }\n" },
    { label: 'multi-line import clause', source: "import {\n  a,\n  b,\n} from 'p'\nexport const out = [a, b]\n" },
  ]
  for (const { label, source } of cases) {
    const code = transformModule(source, 'probe.js')
    check(`line count survives: ${label}`, lineCount(code), lineCount(source))
  }
}

// ---------------------------------------------------------------------------
// 8. Refusals. Every one of these is a form the transform must reject loudly
//    rather than emit something that breaks later.
// ---------------------------------------------------------------------------

refuses('top-level await is refused', 'export const a = 1\nawait boot()\n', 'top-level await')
refuses('top-level for-await is refused', 'for await (const x of src) use(x)\n', 'top-level for-await')
refuses(
  'labeled for-await is refused',
  'export const f = async (src) => { outer: for await (const x of src) { break outer } }\n',
  'labeled for-await',
)
refuses(
  'import attributes are refused',
  "import data from './d.json' with { type: 'json' }\n",
  'import attributes',
)
refuses(
  'value-position yield* is refused',
  'export async function* f(inner) { const v = yield* inner\nuse(v) }\n',
  'yield* is only supported as a statement',
)
refuses(
  'assignment around yield* is refused, never silently dropped',
  'export async function* f(inner) { let v\nv = yield* inner\nuse(v) }\n',
  'yield* is only supported as the whole statement expression',
)
refuses(
  'a call around yield* is refused, never silently dropped',
  'export async function* f(inner) { use(yield* inner) }\n',
  'yield* is only supported as the whole statement expression',
)
refuses(
  'already-lowered source is refused',
  'const x = __als.pause(1)\n',
  'already lowered',
)
refuses('unparseable source is refused', 'export const = \n', 'parse failed')

{
  // A refusal must name the file and the line, which is what makes a build
  // failure actionable.
  const message = refusal('export const a = 1\n\n\nawait boot()\n', 'node_modules/p/index.js')
  check('refusal names the file', message?.includes('node_modules/p/index.js'), true)
  check('refusal names the offending line', message?.includes(':4'), true)
}

// ---------------------------------------------------------------------------
// 9. Trap regressions. Each case is a module form that breaks a boot when the
//    transform mishandles it; the AST pass must keep them fixed.
// ---------------------------------------------------------------------------

{
  // Trap 1: a file with no module syntax can still contain a dynamic import. A
  // transform that skips such files would leave it unrewritten, and it would
  // escape to the host engine's parser.
  const code = transformModule("module.exports = () => import('./x.js')\n", 'probe.js')
  contains('trap 1: dynamic import in a CommonJS file is still rewritten', code, '__dsh$dynImport')
  parsesAsScript('trap 1', code)
}

{
  // Trap 2: `export {}` is a bundler module marker and must be removed before
  // `new Function` parses the body. The needle is the keyword in statement
  // position, since `exports.` in the prologue legitimately contains the same
  // letters.
  const code = transformModule('export {};\n', 'probe.js')
  lacks('trap 2: bare export {} is removed', code, 'export {')
  lacks('trap 2: no export keyword survives', code, 'export;')
  parsesAsScript('trap 2', code)
  check('trap 2: emitted body still marks __esModule', '__esModule' in runBody(code), true)
}

{
  // Trap 3/4: every declarator is published, including declarations without an
  // initializer.
  const code = transformModule('export let x, y\nexport const set = () => { x = 1; y = 2 }\n', 'probe.js')
  parsesAsScript('trap 3', code)
  const exports = runBody(code)
  ;(exports.set as () => void)()
  check('trap 3: every declarator is exported, initializer or not', [exports.x, exports.y], [1, 2])
}

{
  // Trap 6: a block comment before a class member named `import` must not be
  // treated as a dynamic import. Renaming `EntryTree.prototype.import` breaks
  // the loading chain at `Entry._init` with
  // "this.parent.tree.import is not a function".
  const source = 'export class A {\n  /** doc */ import(name) { return name }\n}\n'
  const code = transformModule(source, 'probe.js')
  lacks('trap 6: a method named import is not rewritten', code, '__dsh$dynImport')
  parsesAsScript('trap 6', code)
  const A = runBody(code).A as new () => { import: (name: string) => string }
  check('trap 6: the method is still callable under its own name', new A().import('kept'), 'kept')
}

{
  // Trap 7: a comment between `export` and the declaration keyword must not
  // hide the declaration; refusing zod's
  // `export /*@__NO_SIDE_EFFECTS__*/ function` takes 30-odd roster rows down
  // with it.
  const code = transformModule('export /*@__NO_SIDE_EFFECTS__*/ function $constructor(x) { return x }\n', 'probe.js')
  parsesAsScript('trap 7', code)
  check('trap 7: export with an interposed comment still publishes', typeof runBody(code).$constructor, 'function')
}

{
  // `new.target` is also a MetaProperty. Replacing every MetaProperty would
  // make `new.target === Cls` permanently false, silently disabling
  // abstract-seam guards in `jobs` and `llm`.
  const source = 'export class Base {\n  constructor() { this.direct = new.target === Base }\n}\n'
  const code = transformModule(source, 'probe.js')
  contains('trap 8: new.target survives verbatim', code, 'new.target')
  lacks('trap 8: new.target is not replaced by the meta parameter', code, '__dsh$meta')
  parsesAsScript('trap 8', code)
  const Base = runBody(code).Base as new () => { direct: boolean }
  class Derived extends Base {}
  check('trap 8: new.target compares true for a direct construction', new Base().direct, true)
  check('trap 8: new.target compares false for a subclass', new Derived().direct, false)
}

{
  // Shebang handling: `#!` is only legal at offset 0, which the prologue
  // occupies. It is commented out in place so both offsets and the line count
  // stay put.
  const source = '#!/usr/bin/env node\nexport const main = 1\n'
  const code = transformModule(source, 'probe.js')
  lacks('shebang is not left in the emitted body', code, '#!')
  parsesAsScript('shebang', code)
  check('shebang: line count still survives', lineCount(code), lineCount(source))
  check('shebang: the module still works', runBody(code).main, 1)
}

{
  // The exit gate itself: the transform re-parses its own output as a script.
  // Any leftover module syntax or mis-spliced interval fails there, not at load.
  // Re-checked here over a source that exercises several edits at once.
  const source = "import a from 'p'\nexport * from 'q'\nexport const f = async () => { for await (const x of a) { await x } }\n"
  parsesAsScript('exit gate over combined edits', transformModule(source, 'probe.js'))
}

// ---------------------------------------------------------------------------
// 10. Caching: the transform memoizes by source text, and the cache must not
//     leak a different file's result.
// ---------------------------------------------------------------------------

{
  const source = 'export const cached = 1\n'
  const first = transformModule(source, 'a.js')
  const second = transformModule(source, 'b.js')
  check('identical sources return the identical cached body', first === second, true)
  // Distinct sources must not collide.
  check(
    'distinct sources produce distinct bodies',
    transformModule('export const other = 2\n', 'c.js') !== first,
    true,
  )
}
