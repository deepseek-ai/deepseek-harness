import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { binSources, excludedEntry, findTopLevelAwaits, scanRepository, sourceCorpus, SOURCE_GLOB } from './verify-no-top-level-await.ts'

const FILE = 'packages/group/pkg/src/entry.ts'

function forms(source: string, file = FILE): string[] {
  return findTopLevelAwaits(file, source).map(violation => violation.what)
}

describe('module-scope await detection', () => {
  it('rejects the process-entry shape the rule exists for', () => {
    expect(forms(`
      const config = parse(process.argv[2])
      const { port } = await startServer(config)
      process.stdout.write(JSON.stringify({ port }))
    `)).toEqual(['await expression'])
  })

  it('reports the offending line number and text', () => {
    expect(findTopLevelAwaits(FILE, 'const a = 1\n  await ready()\n')).toEqual([
      { file: FILE, line: 2, what: 'await expression', text: 'await ready()' },
    ])
  })

  it.each([
    ['a top-level if', 'if (enabled) { await ready() }'],
    ['an else branch', 'if (enabled) {} else await ready()'],
    ['a bare block', '{ await ready() }'],
    ['a try block', 'try { await ready() } catch {}'],
    ['a catch block', 'try { start() } catch { await stop() }'],
    ['a finally block', 'try { start() } finally { await stop() }'],
    ['a loop body', 'for (const item of items) await handle(item)'],
    ['a while body', 'while (pending()) await next()'],
    ['a switch case', 'switch (mode) { case 1: await run() }'],
    ['a conditional expression', 'const value = ready ? await load() : undefined'],
    ['an exported initializer', 'export const value = await load()'],
    ['a class computed member name', 'class Probe { [await key()]() {} }'],
    ['an object computed method name', 'const probe = { [await key()]() {} }'],
  ])('rejects an await nested in %s', (_form, source) => {
    expect(forms(source)).toEqual(['await expression'])
  })

  it('rejects a module-scope for await loop', () => {
    expect(forms('for await (const chunk of stream) handle(chunk)')).toEqual(['for await loop'])
  })

  it('rejects a for await loop nested in a top-level block', () => {
    expect(forms('if (stream) { for await (const chunk of stream) handle(chunk) }')).toEqual(['for await loop'])
  })

  it('rejects a module-scope await using declaration', () => {
    expect(forms('await using handle = await open()')).toEqual(['await using declaration', 'await expression'])
  })

  it('rejects a module-scope await in a TSX module', () => {
    expect(forms('const element = <div>{await label()}</div>', 'packages/group/pkg/src/view.tsx'))
      .toEqual(['await expression'])
  })

  it.each([
    ['a function declaration', 'async function main() { await ready() }'],
    ['a function expression', 'const main = async function () { await ready() }'],
    ['an arrow block body', 'const main = async () => { await ready() }'],
    ['an arrow concise body', 'const main = async () => await ready()'],
    ['an object method', 'const probe = { async run() { await ready() } }'],
    ['a class method', 'class Probe { async run() { await ready() } }'],
    ['a function nested in a top-level block', 'if (enabled) { void (async () => { await ready() })() }'],
    ['a for await loop inside a function', 'async function drain(stream) { for await (const chunk of stream) handle(chunk) }'],
    ['an await using declaration inside a function', 'async function use() { await using handle = open() }'],
    ['a parameter initializer, which runs when the function is called', 'function probe(value = await ready()) {}'],
    ['a class static block, which runs synchronously at class definition', 'class Probe { static { await ready() } }'],
  ])('accepts an await inside %s', (_form, source) => {
    expect(forms(source)).toEqual([])
  })

  it('accepts the word await in strings, templates, and comments', () => {
    expect(forms([
      "const quoted = 'await ready()'",
      'const template = `var { connect } = await import(${JSON.stringify(url)})`',
      '// await ready()',
      '/* for await (const x of y) */',
    ].join('\n'))).toEqual([])
  })

  it('accepts a synchronous using declaration', () => {
    expect(forms('using handle = open()')).toEqual([])
  })
})

describe('package source corpus', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  function fixture(files: Record<string, string>): string {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-top-level-await-'))
    roots.push(directory)
    mkdirSync(join(directory, 'packages'), { recursive: true })
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(directory, path)), { recursive: true })
      writeFileSync(join(directory, path), text)
    }
    return directory
  }

  it('covers every package source directory with TypeScript or TSX files', () => {
    const directory = fixture({
      'packages/a/one/src/index.ts': 'export const one = 1\n',
      'packages/a/one/src/view.tsx': 'export const view = <div />\n',
      'packages/b/two/src/nested/deep.ts': 'await ready()\n',
      'packages/b/docs-only/README.md': '# no sources\n',
      'packages/b/types-only/src/env.d.ts': 'declare const value: number\n',
    })
    expect(sourceCorpus(directory)).toEqual([
      'packages/a/one/src/index.ts',
      'packages/a/one/src/view.tsx',
      'packages/b/two/src/nested/deep.ts',
      'packages/b/types-only/src/env.d.ts',
    ])
    expect(scanRepository(directory)).toEqual({
      checked: 4,
      excluded: [],
      violations: [
        { file: 'packages/b/two/src/nested/deep.ts', line: 1, what: 'await expression', text: 'await ready()' },
      ],
    })
  })

  it('excludes a source that starts with a shebang line, and only that file', () => {
    const directory = fixture({
      'packages/a/tool/src/cli.ts': '#!/usr/bin/env node\nawait main()\n',
      'packages/a/tool/src/library.ts': 'await load()\n',
      'packages/a/tool/src/view.tsx': '',
    })
    expect(scanRepository(directory)).toEqual({
      checked: 2,
      excluded: [{ file: 'packages/a/tool/src/cli.ts', reason: 'shebang' }],
      violations: [{ file: 'packages/a/tool/src/library.ts', line: 1, what: 'await expression', text: 'await load()' }],
    })
  })

  it('excludes the sources of build outputs a manifest bin field names, in map and string forms', () => {
    const directory = fixture({
      'packages/a/tool/package.json': JSON.stringify({ name: 'tool', bin: { tool: './lib/cli/main.js' } }),
      'packages/a/tool/src/cli/main.ts': 'await main()\n',
      'packages/a/tool/src/main.ts': 'await main()\n',
      'packages/b/view/package.json': JSON.stringify({ name: 'view', bin: 'lib/run.js' }),
      'packages/b/view/src/run.tsx': 'await render()\n',
    })
    expect(scanRepository(directory)).toEqual({
      checked: 1,
      excluded: [
        { file: 'packages/a/tool/src/cli/main.ts', reason: 'bin' },
        { file: 'packages/b/view/src/run.tsx', reason: 'bin' },
      ],
      violations: [{ file: 'packages/a/tool/src/main.ts', line: 1, what: 'await expression', text: 'await main()' }],
    })
  })

  it('checks a source whose bin target is a committed file rather than a build output', () => {
    const directory = fixture({
      'packages/a/tool/package.json': JSON.stringify({ name: 'tool', bin: { tool: './bin.js' } }),
      'packages/a/tool/src/bin.ts': 'await main()\n',
      'packages/a/tool/src/view.tsx': '',
    })
    expect(scanRepository(directory).violations.map(violation => violation.file)).toEqual(['packages/a/tool/src/bin.ts'])
  })

  it('treats only a leading #! as a shebang', () => {
    expect(excludedEntry(FILE, '// #!/usr/bin/env node\nawait main()\n', new Set())).toBeUndefined()
    expect(excludedEntry(FILE, ' #!/usr/bin/env node\n', new Set())).toBeUndefined()
    expect(excludedEntry(FILE, '#!/usr/bin/env node\n', new Set())).toBe('shebang')
  })

  it.each([
    ['an absent bin field', undefined, []],
    ['a lib target', 'lib/cli.js', ['packages/a/tool/src/cli.ts', 'packages/a/tool/src/cli.tsx']],
    ['a dotted lib target in a name map', { tool: './lib/nested/cli.js' }, ['packages/a/tool/src/nested/cli.ts', 'packages/a/tool/src/nested/cli.tsx']],
    ['a committed root file', { tool: './bin.js' }, []],
    ['a non-JavaScript lib file', 'lib/cli.sh', []],
    ['a non-string map value', { tool: 1 }, []],
  ])('maps %s to its source candidates', (_case, bin, expected) => {
    expect(binSources('packages/a/tool', bin)).toEqual(expected)
  })

  it('refuses an empty corpus', () => {
    expect(() => sourceCorpus(fixture({ 'packages/a/one/README.md': '# empty\n' }))).toThrow('empty corpus')
  })

  it('refuses a corpus that no longer holds TSX sources', () => {
    const directory = fixture({ 'packages/a/one/src/index.ts': '', 'packages/a/one/src/view.tsx': '' })
    expect(() => sourceCorpus(directory, 'packages/*/*/src/**/*.ts')).toThrow('no .tsx file')
  })

  it('refuses a glob narrowed to fewer package source directories', () => {
    const directory = fixture({
      'packages/a/one/src/view.tsx': '',
      'packages/b/two/src/index.ts': '',
    })
    expect(() => sourceCorpus(directory, 'packages/a/*/src/**/*.{ts,tsx}')).toThrow('leaves out package sources: packages/b/two/src')
  })

  it('reads the shipped corpus through the documented glob', () => {
    expect(SOURCE_GLOB).toBe('packages/*/*/src/**/*.{ts,tsx}')
    expect(sourceCorpus().length).toBeGreaterThan(0)
  })

  it('passes on the current tree, excluding only the declared executables', () => {
    const result = scanRepository()
    expect(result.violations).toEqual([])
    expect(result.excluded).toEqual([
      { file: 'packages/experimental/webworker-packer/src/bin.ts', reason: 'shebang' },
      { file: 'packages/test-support/llm-mock-server/src/bin.ts', reason: 'shebang' },
    ])
  }, 60_000)
})
