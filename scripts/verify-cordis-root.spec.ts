import { readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createInventoryRepo, gitFixture as git, removeInventoryRepos, writeFixture as write } from './baseline-inventory.fixture.ts'
import {
  CORDIS_ROOT_EXEMPTIONS,
  countCordisRootReads,
  findCordisRootReads,
  scanCordisRootReads,
  verifyCordisRoot,
} from './verify-cordis-root.ts'

const baselinePath = 'scripts/cordis-root.baseline.json'
const sourcePath = 'packages/example/src/index.ts'
const header = "import { Context } from '@deepseek-ai/cordis'\n"
const read = `${header}export const root = (ctx: Context) => ctx[Context.root]\n`
const none = {}

afterEach(removeInventoryRepos)

function fixture(): string {
  return createInventoryRepo(baselinePath, 'export {}\n')
}

function recordBaseline(root: string): string {
  const text = `${JSON.stringify(countCordisRootReads(scanCordisRootReads(root, none)), null, 2)}\n`
  write(root, baselinePath, text)
  return text
}

describe('Cordis root read syntax', () => {
  it.each([
    ['an element access', `${header}ctx[Context.root]`, 1],
    ['a property chain through the root', `${header}ctx[Context.root].loader.await()`, 1],
    ['a bare symbol read', `${header}const key = Context.root`, 1],
    ['a parenthesized class', `${header}ctx[(Context).root]`, 1],
    ['a string-keyed read', `${header}ctx[Context['root']]`, 1],
    ['a destructured read', `${header}const { root } = Context`, 1],
    ['a renamed destructured read', `${header}const { root: key } = Context`, 1],
    ['a renamed import', "import { Context as CordisContext } from '@deepseek-ai/cordis'\nctx[CordisContext.root]", 1],
    ['a namespace import', "import * as cordis from '@deepseek-ai/cordis'\nctx[cordis.Context.root]", 1],
    ['a global symbol key', "ctx[Symbol.for('cordis.root')]", 1],
    ['a template symbol key', 'ctx[Symbol.for(`cordis.root`)]', 1],
    ['a symbol key held in a constant', "const key = 'cordis.root'", 1],
    ['several reads', `${header}ctx[Context.root].on('a', f); ctx[Context.root].on('b', g)`, 2],
    ['a TSX expression', `${header}export const view = <View ctx={ctx[Context.root]} />`, 1],
    ['the symbols table', "import { symbols } from '@deepseek-ai/cordis'\nctx[symbols.root]", 1],
    ['a renamed symbols table', "import { symbols as cordisSymbols } from '@deepseek-ai/cordis'\nctx[cordisSymbols['root']]", 1],
    ['the symbols table of a namespace', "import * as cordis from '@deepseek-ai/cordis'\nctx[cordis.symbols.root]", 1],
    ['root destructured from the symbols table', "import { symbols } from '@deepseek-ai/cordis'\nconst { root } = symbols", 1],
    ['a subpath import', "import { Context } from '@deepseek-ai/cordis/src/index.ts'\nctx[Context.root]", 1],
    ['a default import', "import cordis from '@deepseek-ai/cordis'\nctx[cordis.Context.root]", 1],
    ['an import-equals namespace', "import cordis = require('@deepseek-ai/cordis')\nctx[cordis.Context.root]", 1],
    ['a destructured dynamic import', "const { Context } = await import('@deepseek-ai/cordis')\nctx[Context.root]", 1],
    ['a renamed destructured dynamic import', "const { Context: C } = await import('@deepseek-ai/cordis')\nctx[C.root]", 1],
    ['a namespace dynamic import', "const cordis = await import('@deepseek-ai/cordis')\nctx[cordis.Context.root]", 1],
    ['a destructured require', "const { Context } = require('@deepseek-ai/cordis')\nctx[Context.root]", 1],
    ['a destructuring assignment', `${header}let key; ({ root: key } = Context)`, 1],
    ['a shorthand destructuring assignment', `${header}let root; ({ root } = Context)`, 1],
    ['a parameter default', `${header}function f({ root } = Context) { return root }`, 1],
    ['a nested binding default', `${header}const { a: { root } = Context } = value`, 1],
    ['a computed class member', `${header}class Holder { [Context.root] = undefined }`, 1],
    ['a class extends clause', `${header}class Holder extends mixin(Context.root) {}`, 1],
  ])('finds %s', (_name, text, count) => {
    expect(findCordisRootReads('input.tsx', text)).toHaveLength(count)
  })

  it.each([
    ['comments', `${header}// ctx[Context.root]\n/* Symbol.for('cordis.root') */`],
    ['strings that mention the root', `${header}const text = 'ctx[Context.root]'`],
    ['source text embedded in a template', "const code = `ctx[Symbol.for('cordis.root')]`"],
    ['a type query', `${header}type Root = typeof Context.root`],
    ['a literal type', "type Key = 'cordis.root'"],
    ['a type-only import', "import type { Context } from '@deepseek-ai/cordis'\nctx[Context.root]"],
    ['a type-only specifier', "import { type Context } from '@deepseek-ai/cordis'\nctx[Context.root]"],
    ['a Context from another module', "import { Context } from './context.ts'\nctx[Context.root]"],
    ['another static of Context', `${header}ctx[Context.isolate]`],
    ['a root member of another value', `${header}const dir = project.root`],
    ['a destructured root of another value', `${header}const { root } = project`],
    ['a parameter that shadows the import', `${header}function f(Context: { root: string }) { return Context.root }`],
    ['a local that shadows the import', `${header}{ const Context = project; Context.root }`],
    ['a parameter that shadows a namespace', "import * as cordis from '@deepseek-ai/cordis'\nfunction f(cordis: any) { return cordis.Context.root }"],
    ['an interface member', `${header}interface Holder { [Context.root]: Context }`],
    ['a type literal member', `${header}type Holder = { [Context.root]: Context }`],
    ['an ambient class member', `${header}declare class Holder { [Context.root]: Context }`],
    ['an ambient module member', `${header}declare module 'x' { const key: typeof Context.root; export const value = Context.root }`],
    ['an ambient class field', `${header}class Holder { declare [Context.root]: Context }`],
    ['an implements clause', `${header}class Holder implements Base<typeof Context.root> {}`],
    ['another member of the symbols table', "import { symbols } from '@deepseek-ai/cordis'\nctx[symbols.original]"],
    ['a dynamic import of another module', "const { Context } = await import('./context.ts')\nctx[Context.root]"],
    ['a destructuring assignment of another member', `${header}let isolate; ({ isolate } = Context)`],
  ])('ignores %s', (_name, text) => {
    expect(findCordisRootReads('input.ts', text)).toEqual([])
  })

  it('resolves bindings in JavaScript modules', () => {
    expect(findCordisRootReads('input.mjs', "const { Context } = await import('@deepseek-ai/cordis')\nctx[Context.root]")).toHaveLength(1)
    expect(findCordisRootReads('input.cjs', "const { symbols } = require('@deepseek-ai/cordis')\nfunction f(symbols) { return symbols.root }")).toEqual([])
  })

  it('skips declaration files', () => {
    expect(findCordisRootReads('input.d.ts', `${header}export declare const key: typeof Context.root\nexport const value = Context.root`)).toEqual([])
  })

  it('reports normalized paths and the read line', () => {
    const [found] = findCordisRootReads('packages\\example\\index.ts', `${header}\nctx[Context.root]`)
    expect(found).toMatchObject({ file: 'packages/example/index.ts', line: 3 })
    expect(found?.fingerprint).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('identifies a read by its receiver', () => {
    const fingerprint = (text: string): string | undefined => findCordisRootReads('input.ts', `${header}${text}`)[0]?.fingerprint
    expect(fingerprint('ctx[\n  Context.root /* root */ ]')).toBe(fingerprint('ctx[Context.root]'))
    expect(fingerprint('ctx[Context.root].loader')).toBe(fingerprint('ctx[Context.root].fiber'))
    expect(fingerprint('other[Context.root]')).not.toBe(fingerprint('ctx[Context.root]'))
    expect(findCordisRootReads('input.ts', "other[Symbol.for('cordis.root')]")[0]?.fingerprint)
      .not.toBe(findCordisRootReads('input.ts', "ctx[Symbol.for('cordis.root')]")[0]?.fingerprint)
  })
})

describe('Cordis root read inventory', () => {
  it('accepts a recorded read after formatting without rewriting the baseline', () => {
    const root = fixture()
    write(root, sourcePath, read)
    const baseline = recordBaseline(root)
    write(root, sourcePath, `${header}export const root = (ctx: Context) => ctx[\n  Context.root\n]\n`)
    expect(verifyCordisRoot(root, false, none)).toBe(1)
    expect(verifyCordisRoot(root, true, none)).toBe(1)
    expect(readFileSync(join(root, baselinePath), 'utf8')).toBe(baseline)
  })

  it.each([
    ['another copy of a recorded read', `${read}export const again = (ctx: Context) => ctx[Context.root]\n`],
    ['a read through another receiver', `${header}export const root = (other: Context) => other[Context.root]\n`],
    ['a global symbol key read', "export const root = (ctx: object) => Reflect.get(ctx, Symbol.for('cordis.root'))\n"],
  ])('rejects %s without changing the baseline', (_name, text) => {
    const root = fixture()
    write(root, sourcePath, read)
    const baseline = recordBaseline(root)
    write(root, sourcePath, text)
    expect(() => verifyCordisRoot(root, false, none)).toThrow(/verify-cordis-root: new reads of the Cordis root context/u)
    expect(() => verifyCordisRoot(root, true, none)).toThrow(/verify-cordis-root: new reads of the Cordis root context/u)
    expect(readFileSync(join(root, baselinePath), 'utf8')).toBe(baseline)
  })

  it('rejects a new read when the inventory is empty', () => {
    const root = fixture()
    write(root, sourcePath, read)
    expect(() => verifyCordisRoot(root, false, none)).toThrow(`${sourcePath}:2`)
  })

  it('requires pruning a fixed read', () => {
    const root = fixture()
    write(root, sourcePath, read)
    git(root, 'add', sourcePath)
    recordBaseline(root)
    write(root, sourcePath, 'export {}\n')
    expect(() => verifyCordisRoot(root, false, none)).toThrow(/remove retired baseline entries/u)
    expect(verifyCordisRoot(root, true, none)).toBe(0)
    expect(readFileSync(join(root, baselinePath), 'utf8')).toBe('{}\n')
  })

  it('excludes vendored source', () => {
    const root = fixture()
    write(root, 'vendor/cordis/src/index.ts', read)
    git(root, 'add', '.')
    expect(verifyCordisRoot(root, false, none)).toBe(0)
  })
})

describe('Cordis root read exemptions', () => {
  const exemptPath = 'scripts/root-contract.spec.ts'
  const exemptions = { [exemptPath]: 'pins the root contract' }

  it('leaves an exempt file unscanned', () => {
    const root = fixture()
    write(root, exemptPath, read)
    expect(scanCordisRootReads(root, exemptions)).toEqual([])
    expect(verifyCordisRoot(root, false, exemptions)).toBe(0)
  })

  it.each([
    ['no longer reads the root', (root: string) => { write(root, exemptPath, 'export {}\n') }],
    ['is deleted', (root: string) => { write(root, exemptPath, read); unlinkSync(join(root, exemptPath)) }],
  ])('rejects an exemption whose file %s', (_name, change) => {
    const root = fixture()
    change(root)
    expect(() => verifyCordisRoot(root, false, exemptions))
      .toThrow(`verify-cordis-root: exempt file ${exemptPath} no longer reads the root context`)
  })

  it('names only files that read the root in this repository', () => {
    const root = join(import.meta.dirname, '..')
    for (const file of Object.keys(CORDIS_ROOT_EXEMPTIONS)) {
      expect(findCordisRootReads(file, readFileSync(join(root, file), 'utf8')).length).toBeGreaterThan(0)
    }
  })
})
