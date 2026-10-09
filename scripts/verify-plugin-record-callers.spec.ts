import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkDeclaredPluginRecordWrites,
  checkPluginRecordCallers,
  findPluginRecordReferences,
  isAdmittedCaller,
  OWNER_FILE,
  readRepositorySources,
  unescaped,
} from './verify-plugin-record-callers.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A temporary git repository with the given files written and none of them staged. */
function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-record-callers-'))
  roots.push(root)
  execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'pipe' })
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), contents)
  }
  return root
}

const OWNER_SOURCE = 'export function appendPluginRecord(session, type, data) { return commit(session, type, data) }\n'
const EXPERIMENTAL = 'packages/experimental/bridge/src/index.ts'
const RELEASE = 'packages/core/agent/src/index.ts'

/** A source-only compiler fixture whose production map declares one bridge record. */
function declaredRepository(source: string, extra: Record<string, string> = {}): string {
  return repository({
    'tsconfig.host.json': JSON.stringify({
      compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true,
        paths: { '@deepseek-ai/dsh-session': ['./packages/core/session/src/index.ts'],
          '@deepseek-ai/dsh-session/types': ['./packages/core/session/src/types.ts'] } },
      include: ['packages/**/*.ts'],
    }),
    'packages/core/session/package.json': JSON.stringify({ name: '@deepseek-ai/dsh-session' }),
    'packages/experimental/bridge/package.json': JSON.stringify({ name: '@deepseek-ai/dsh-experimental-bridge' }),
    'packages/core/session/src/types.ts': 'export interface PluginRecordMap {}\n',
    [OWNER_FILE]: "import type { PluginRecordMap } from './types.ts'\nexport function appendPluginRecord<K extends keyof PluginRecordMap>(session: object, type: K, data: NoInfer<PluginRecordMap[K]>): number { return 0 }\n",
    'packages/experimental/bridge/src/types.ts': [
      'export interface Entry { value: number }',
      "declare module '@deepseek-ai/dsh-session/types' {",
      '  interface PluginRecordMap {',
      '    /** Stores the bridge state. */',
      "    'plugin:bridge/state': Entry",
      '  }',
      '}',
    ].join('\n'),
    [EXPERIMENTAL]: source,
    ...extra,
  })
}

/** A minimal corpus: the owner, one experimental file, and one release file with the given source. */
function corpus(release: string, extra: Record<string, string> = {}): Map<string, string> {
  return new Map(Object.entries({
    [OWNER_FILE]: OWNER_SOURCE,
    [EXPERIMENTAL]: "import { appendPluginRecord } from '@deepseek-ai/dsh-session'\nappendPluginRecord(session, 'plugin:a', {})\n",
    [RELEASE]: release,
    ...extra,
  }))
}

describe('verify-plugin-record-callers', () => {
  it.each([
    ['a named import', "import { appendPluginRecord } from '@deepseek-ai/dsh-session'"],
    ['an aliased import', "import { appendPluginRecord as write } from '@deepseek-ai/dsh-session'"],
    ['a re-export', "export { appendPluginRecord } from '@deepseek-ai/dsh-session'"],
    ['a namespace member call', "S.appendPluginRecord(session, 'plugin:a', {})"],
    ['a destructured binding', 'const { appendPluginRecord: write } = S'],
    ['an element access', "S['appendPluginRecord'](session, 'plugin:a', {})"],
    ['a template element access', 'S[`appendPluginRecord`](session, `plugin:a`, {})'],
    ['an escaped identifier', 'S.\\u0061ppendPluginRecord(session, "plugin:a", {})'],
    ['a hexadecimal escape in an element access', "S['\\x61ppendPluginRecord'](session, 'plugin:a', {})"],
    ['a code point escape in an element access', "S['\\u{61}ppendPluginRecord'](session, 'plugin:a', {})"],
    ['needless character escapes in an element access', "S['\\a\\ppendPluginRecord'](session, 'plugin:a', {})"],
    ['a legacy octal escape in an element access', "S['\\141ppendPluginRecord'](session, 'plugin:a', {})"],
    ['a three-digit legacy octal escape for the last character, beside a two-digit one that spells no reference', "S['appendPluginRecor\\144'](session, 'plugin:a\\61', {})"],
    ['an escaped template element access', 'S[`\\x61ppendPluginRecord`](session, `plugin:a`, {})'],
  ])('rejects %s in release package source', (_form, source) => {
    expect(checkPluginRecordCallers(corpus(`${source}\n`))).toEqual([{ file: RELEASE, line: 1, text: source }])
  })

  it('parses JSX and JavaScript sources by extension', () => {
    const files = corpus('', {
      'packages/client/ui/src/view.tsx': 'const view = <div>{S.appendPluginRecord(session, "plugin:a", {})}</div>\n',
      'scripts/tool.mjs': "S['appendPluginRecord'](session, 'plugin:a', {})\n",
    })
    expect(checkPluginRecordCallers(files).map(caller => caller.file))
      .toEqual(['packages/client/ui/src/view.tsx', 'scripts/tool.mjs'])
  })

  it('rejects a string that spells the name across a line continuation', () => {
    expect(checkPluginRecordCallers(corpus("S['append\\\nPluginRecord'](session, 'plugin:a', {})\n"))).toEqual([
      { file: RELEASE, line: 1, text: "S['append\\" },
    ])
  })

  it('reports nothing for escapes that spell no reference, including one that names no code point', () => {
    const source = "const path = 'C:\\\\temp\\\\appendPlugin'\nconst big = '\\u{110000}'\nconst newline = 'a\\nb'\n"
    expect(findPluginRecordReferences(RELEASE, source)).toEqual([])
    // A file the prefilter unescapes can still hold no reference: this escape spells no letter of the name.
    expect(findPluginRecordReferences('packages/core/x/src/legacy.cjs', "S['\\4141ppendPluginRecord']\n")).toEqual([])
    // The AST compares exact string values: " 0appendPluginRecord", as TypeScript decodes this, names nothing.
    expect(findPluginRecordReferences('packages/core/x/src/legacy.cjs', "S['\\400appendPluginRecord']\n")).toEqual([])
  })

  it('unescapes legacy octal escapes as TypeScript decodes them, taking three digits only after 0 to 3', () => {
    // \400 exceeds 0o377, so it is \40 then a literal 0; \141 and \61 stay whole.
    expect([unescaped("'\\400'"), unescaped("'\\141\\61'"), unescaped("'\\0'"), unescaped("'\\777'")]).toEqual(["' 0'", "'a1'", "'\0'", "'?7'"])
  })

  it('ignores comments, JSDoc links, longer strings, other identifiers, and wildcard re-exports', () => {
    const source = [
      '// appendPluginRecord is restricted',
      '/** Plugin state uses {@link appendPluginRecord} in experimental packages. */',
      "const message = 'call appendPluginRecord only from experimental packages'",
      'const appendPluginRecords = 1',
      "export * from '@deepseek-ai/dsh-session'",
    ].join('\n')
    expect(checkPluginRecordCallers(corpus(source))).toEqual([])
  })

  it('admits experimental source, the owner, tests, and this gate', () => {
    for (const file of [
      EXPERIMENTAL,
      OWNER_FILE,
      'packages/session/session-persistence/tests/live-write-contract.ts',
      'apps/web/tests/session.e2e.ts',
      'examples/demo/tests/demo.spec.ts',
      'scripts/verify-plugin-record-callers.spec.ts',
      'scripts/verify-plugin-record-callers.ts',
    ]) expect(isAdmittedCaller(file), file).toBe(true)
    for (const file of [RELEASE, 'packages/core/session/src/surface.ts', 'scripts/tool.ts', 'apps/web/src/main.ts']) {
      expect(isAdmittedCaller(file), file).toBe(false)
    }
  })

  it('reports the line of each reference', () => {
    expect(findPluginRecordReferences(RELEASE, 'const a = 1\n\nS.appendPluginRecord()\n'))
      .toEqual([{ file: RELEASE, line: 3, text: 'S.appendPluginRecord()' }])
  })

  it('refuses a corpus whose owner no longer exports the function', () => {
    for (const owner of [undefined, 'function appendPluginRecord() {}\n', 'export const appendPluginRecord = () => {}\n']) {
      const files = corpus('')
      if (owner === undefined) files.delete(OWNER_FILE)
      else files.set(OWNER_FILE, owner)
      expect(() => checkPluginRecordCallers(files)).toThrow(/no longer exports function appendPluginRecord/)
    }
  })

  it('refuses a corpus without experimental or release package source', () => {
    const withoutExperimental = corpus('')
    withoutExperimental.delete(EXPERIMENTAL)
    const withoutRelease = corpus('')
    withoutRelease.delete(RELEASE)
    for (const files of [withoutExperimental, withoutRelease]) {
      expect(() => checkPluginRecordCallers(files)).toThrow(/lacks experimental or release package source/)
    }
  })

  it('reads tracked and unignored sources outside vendor, skipping other files and deleted ones', () => {
    const root = repository({
      '.gitignore': 'ignored/\n',
      [OWNER_FILE]: OWNER_SOURCE,
      'scripts/tool.mjs': 'export {}\n',
      'ignored/scratch.ts': 'export {}\n',
      'vendor/cordis/src/index.ts': 'export {}\n',
      'docs/page.md': '# Page\n',
      'packages/core/gone/src/index.ts': 'export {}\n',
    })
    execFileSync('git', ['add', '.'], { cwd: root, stdio: 'pipe' })
    rmSync(join(root, 'packages/core/gone/src/index.ts'))
    mkdirSync(join(root, 'packages/core/agent/src'), { recursive: true })
    writeFileSync(join(root, 'packages/core/agent/src/new.ts'), 'export {}\n')

    expect([...readRepositorySources(root).keys()].sort()).toEqual([
      'packages/core/agent/src/new.ts',
      OWNER_FILE,
      'scripts/tool.mjs',
    ])
  })

  it('accepts declared names through renamed imports, inferred aliases, and namespace calls', () => {
    const root = declaredRepository([
      "import { appendPluginRecord as write } from '@deepseek-ai/dsh-session'",
      "import * as session from '@deepseek-ai/dsh-session'",
      'const alias = write',
      "write({}, 'plugin:bridge/state', { value: 1 })",
      "alias({}, 'plugin:bridge/state', { value: 2 })",
      "session.appendPluginRecord({}, 'plugin:bridge/state', { value: 3 })",
    ].join('\n'))
    expect(checkDeclaredPluginRecordWrites(root, readRepositorySources(root))).toEqual([])
  })

  it('rejects undeclared literal names, partially declared unions, and dynamic strings', () => {
    const root = declaredRepository([
      "import { appendPluginRecord as write } from '@deepseek-ai/dsh-session'",
      "declare const union: 'plugin:bridge/state' | 'plugin:bridge/missing'",
      'declare const dynamic: string',
      "write({}, 'plugin:bridge/missing', {})",
      'write({}, union, {})',
      'write({}, dynamic, {})',
    ].join('\n'))
    const errors = checkDeclaredPluginRecordWrites(root, readRepositorySources(root))
    expect(errors.map(error => error.line)).toEqual([4, 5, 6])
    expect(errors.map(error => error.reason)).toEqual([
      expect.stringContaining('not assignable'),
      expect.stringContaining('not assignable'),
      expect.stringContaining('not assignable'),
    ])
  })

  it('does not authorize a production write with a test-only declaration', () => {
    const root = declaredRepository([
      "import { appendPluginRecord } from '@deepseek-ai/dsh-session'",
      "import type { PluginRecordMap } from '@deepseek-ai/dsh-session/types'",
      "const key = 'plugin:bridge/test-only' as const",
      'appendPluginRecord({}, key, {})',
    ].join('\n'), {
      'packages/experimental/bridge/tests/records.spec.ts': [
        'export {}',
        "declare module '@deepseek-ai/dsh-session/types' {",
        "  interface PluginRecordMap { 'plugin:bridge/test-only': object }",
        '}',
      ].join('\n'),
    })
    expect(checkDeclaredPluginRecordWrites(root, readRepositorySources(root))).toHaveLength(1)
  })

  it('accepts finite generic keys and ignores test writes and unrelated function names', () => {
    const root = declaredRepository([
      "import { appendPluginRecord } from '@deepseek-ai/dsh-session'",
      "function write<K extends 'plugin:bridge/state'>(key: K): void { appendPluginRecord({}, key, { value: 1 }) }",
      'function other(type: string): void {}',
      "other('plugin:bridge/missing')",
    ].join('\n'), {
      'packages/experimental/bridge/tests/records.spec.ts': "import { appendPluginRecord } from '@deepseek-ai/dsh-session'\nappendPluginRecord({}, 'plugin:test/state', {})\n",
    })
    expect(checkDeclaredPluginRecordWrites(root, readRepositorySources(root))).toEqual([])
  })

  it('checks an empty production caller set without loading a compiler project', () => {
    const root = declaredRepository('export {}\n')
    rmSync(join(root, 'tsconfig.host.json'))
    expect(checkDeclaredPluginRecordWrites(root, readRepositorySources(root))).toEqual([])
  })

  it('rejects a test declaration imported transitively by production', () => {
    const root = declaredRepository([
      "import { appendPluginRecord } from '@deepseek-ai/dsh-session'",
      "import type { Fixture } from '../tests/fixture.ts'",
      'declare const data: Fixture',
      "appendPluginRecord({}, 'plugin:bridge/test-only', data)",
    ].join('\n'), {
      'packages/experimental/bridge/tests/fixture.ts': [
        'export interface Fixture { value: number }',
        "declare module '@deepseek-ai/dsh-session/types' {",
        "  interface PluginRecordMap { 'plugin:bridge/test-only': Fixture }",
        '}',
      ].join('\n'),
    })
    const errors = checkDeclaredPluginRecordWrites(root, readRepositorySources(root))
    expect(errors).toHaveLength(1)
    expect(errors[0]?.reason).toContain('visible to production but has no production catalogue declaration')
  })

  it('keeps compiler faces separate and rejects unconfigured writer source', () => {
    const compilerOptions = { module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true,
      paths: { '@deepseek-ai/dsh-session': ['./packages/core/session/src/index.ts'],
        '@deepseek-ai/dsh-session/types': ['./packages/core/session/src/types.ts'] } }
    const root = declaredRepository('export {}\n', {
      'tsconfig.host.json': JSON.stringify({ compilerOptions, include: ['packages/core/**/src/**/*.ts'] }),
      'tsconfig.client.json': JSON.stringify({ compilerOptions, include: ['packages/**/src/**/*.ts'] }),
      'packages/experimental/bridge/src/client.ts': "import { appendPluginRecord } from '@deepseek-ai/dsh-session'\nappendPluginRecord({}, 'plugin:bridge/state', { value: 1 })\n",
      'packages/experimental/bridge/tsdown.config.ts': 'const broken: number = "config is not source"\n',
      'packages/experimental/bridge/examples/hook.js': 'export const hook = value => value\n',
    })
    expect(checkDeclaredPluginRecordWrites(root, readRepositorySources(root))).toEqual([])
    writeFileSync(join(root, 'packages/experimental/bridge/examples/write.ts'),
      "import { appendPluginRecord } from '@deepseek-ai/dsh-session'\nappendPluginRecord({}, 'plugin:bridge/state', { value: 1 })\n")
    const errors = checkDeclaredPluginRecordWrites(root, readRepositorySources(root))
    expect(errors).toHaveLength(1)
    expect(errors[0]?.reason).toContain('must be included in a Host or Client compiler face')
  })

  it('checks call, apply, and bound arguments without rejecting declared forwarding', () => {
    const root = declaredRepository([
      "import { appendPluginRecord as write } from '@deepseek-ai/dsh-session'",
      "write.call(undefined, {}, 'plugin:bridge/missing', {})",
      "write.apply(undefined, [{}, 'plugin:bridge/missing', {}])",
      "const missing = [{}, 'plugin:bridge/missing', {}] as const",
      'write.apply(undefined, [...missing])',
      "const bound = write.bind(undefined, {}, 'plugin:bridge/missing', {})",
      'bound()',
      "write.call(undefined, {}, 'plugin:bridge/state', { value: 1 })",
      "write.apply(undefined, [{}, 'plugin:bridge/state', { value: 1 }])",
      "const valid = [{}, 'plugin:bridge/state', { value: 1 }] as const",
      'write.apply(undefined, [...valid])',
      "const validBound = write.bind(undefined, {}, 'plugin:bridge/state', { value: 1 })",
      'validBound()',
      'const partial = write.bind(undefined, {})',
      "partial('plugin:bridge/state', { value: 1 })",
      "partial('plugin:bridge/missing', {})",
      'write(...valid)',
    ].join('\n'))
    const errors = checkDeclaredPluginRecordWrites(root, readRepositorySources(root))
    expect([...new Set(errors.map(error => error.line))]).toEqual([2, 3, 5, 6, 16])
    expect([...new Set(errors.filter(error => error.reason?.includes('plugin:bridge/missing'))
      .map(error => error.line))]).toEqual([2, 3, 5, 6, 16])
  })
})
