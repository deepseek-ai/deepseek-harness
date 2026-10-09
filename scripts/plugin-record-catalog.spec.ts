/** Plugin record inventory rejects incomplete declarations without creating compatibility roots. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EXPERIMENTAL_PACKAGE_NAME_EXCEPTIONS } from './experimental-package-policy.ts'
import { collectPluginRecords } from './plugin-record-catalog.ts'
import { persistenceCatalogArtifacts, render, renderPluginRecordCatalog } from './gen-persistence-catalog.ts'
import { extractPersistenceSchema } from './persistence-schema.ts'
import { removeFixtureSafely } from './test-fixture-cleanup.ts'

const roots: string[] = []
const OWNER = 'packages/core/session/src/types.ts'
const RECORDS = 'packages/experimental/bridge/src/records.ts'
const OWNER_SOURCE = '/** Experimental records declared by their owning packages. */\nexport interface PluginRecordMap {}\n'

afterEach(() => {
  for (const root of roots.splice(0)) removeFixtureSafely(root)
})

function put(root: string, file: string, source: string): void {
  const path = join(root, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, source)
}

function fixture(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-record-catalog-'))
  roots.push(root)
  for (const [file, source] of Object.entries({
    'packages/core/session/package.json': '{"name":"@deepseek-ai/dsh-session"}',
    'packages/experimental/bridge/package.json': '{"name":"@deepseek-ai/dsh-experimental-bridge"}',
    [OWNER]: OWNER_SOURCE,
    ...files,
  })) put(root, file, source)
  return root
}

function augmentation(members: string, heritage = ''): string {
  return `export {}\ndeclare module '@deepseek-ai/dsh-session/types' {\n  interface PluginRecordMap ${heritage}{\n${members}\n  }\n}\n`
}

const ENTRY = "    /** Retains a bridge entry. */\n    'plugin:bridge/entry': SavedEntry"

describe('plugin record declarations', () => {
  it.each(Object.entries(EXPERIMENTAL_PACKAGE_NAME_EXCEPTIONS))('retains the persisted namespace for %s', (directory, owner) => {
    const namespace = directory.split('/').at(-1)!
    const source = `${directory}/src/records.ts`
    const root = fixture({
      [`${directory}/package.json`]: JSON.stringify({ name: owner }),
      [source]: augmentation(`/** Retains the capability event. */\n'plugin:${namespace}/entry': SavedEntry`),
    })
    expect(collectPluginRecords(root)).toEqual([{
      name: `plugin:${namespace}/entry`, owner, payload: 'SavedEntry', doc: 'Retains the capability event.', source,
    }])
    put(root, source, augmentation("/** Another package event. */\n'plugin:unrelated/entry': SavedEntry"))
    expect(() => collectPluginRecords(root)).toThrow(`must use 'plugin:${namespace}/<name>'`)
  })

  it('accepts an empty inventory only when the owning empty map exists', () => {
    expect(collectPluginRecords(fixture())).toEqual([])
    expect(() => collectPluginRecords(fixture({ [OWNER]: 'export {}\n' })))
      .toThrow('missing exported empty PluginRecordMap')
  })

  it('collects owner, purpose, unexpanded payload annotation and a stable source file', () => {
    const root = fixture({ [RECORDS]: augmentation(ENTRY) })
    const records = collectPluginRecords(root)
    expect(records).toEqual([{
      name: 'plugin:bridge/entry', owner: '@deepseek-ai/dsh-experimental-bridge', payload: 'SavedEntry',
      doc: 'Retains a bridge entry.', source: RECORDS,
    }])
    put(root, RECORDS, `\n\n${augmentation(ENTRY)}`)
    expect(collectPluginRecords(root)).toEqual(records)
  })

  it.each([
    ['optional property', "'plugin:bridge/entry'?: SavedEntry", /required string-literal property/],
    ['index signature', '[name: string]: SavedEntry', /required string-literal property/],
    ['computed name', "['plugin:bridge/entry']: SavedEntry", /required string-literal property/],
    ['identifier name', 'entry: SavedEntry', /required string-literal property/],
    ['method', "'plugin:bridge/entry'(): SavedEntry", /required string-literal property/],
    ['missing type', "'plugin:bridge/entry'", /explicit payload type/],
    ['another owner', "'plugin:other/entry': SavedEntry", /must use 'plugin:bridge\/<name>'/],
    ['missing suffix', "'plugin:bridge': SavedEntry", /must use 'plugin:bridge\/<name>'/],
    ['invalid grammar', "'plugin:bridge/Entry': SavedEntry", /lowercase slash-separated segments/],
  ])('rejects a declaration with %s', (_name, member, error) => {
    const root = fixture({ [RECORDS]: augmentation(`/** Entry. */\n${member}`) })
    expect(() => collectPluginRecords(root)).toThrow(error)
  })

  it('rejects missing prose, Cordis mode tags, inheritance and duplicate names', () => {
    for (const [source, error] of [
      [augmentation("'plugin:bridge/entry': SavedEntry"), /has no description prose/],
      [augmentation("/** Entry.\n * @mode emit\n */\n'plugin:bridge/entry': SavedEntry"), /must not carry a Cordis @mode/],
      [augmentation(ENTRY, 'extends Other '), /without extends or type parameters/],
      [augmentation(`${ENTRY}\n${ENTRY}`), /already declared/],
    ] as const) expect(() => collectPluginRecords(fixture({ [RECORDS]: source }))).toThrow(error)
  })

  it('requires one empty exported map in the session package', () => {
    for (const [source, error] of [
      ['interface PluginRecordMap {}\n', /must export/],
      [`${OWNER_SOURCE}${OWNER_SOURCE}`, /duplicates the owning declaration/],
      [OWNER_SOURCE.replace('{}', "{ 'plugin:session/entry': string }"), /must remain empty/],
      [OWNER_SOURCE.replace('Map {}', 'Map<T> {}'), /without extends or type parameters/],
    ] as const) expect(() => collectPluginRecords(fixture({ [OWNER]: source }))).toThrow(error)
    expect(() => collectPluginRecords(fixture({ [RECORDS]: OWNER_SOURCE }))).toThrow('is outside @deepseek-ai/dsh-session')
  })

  it('finds and rejects record declarations outside experimental production source', () => {
    const root = fixture({
      'packages/core/bridge/package.json': '{"name":"@deepseek-ai/dsh-experimental-bridge"}',
      'packages/core/bridge/src/records.ts': augmentation(ENTRY),
    })
    expect(() => collectPluginRecords(root)).toThrow('must belong to a package declared experimental')
  })

  it('requires the types module augmentation and verifiable package ownership', () => {
    expect(() => collectPluginRecords(fixture({
      [RECORDS]: augmentation(ENTRY).replace("dsh-session/types'", "dsh-session'"),
    }))).toThrow("must augment declare module '@deepseek-ai/dsh-session/types'")
    for (const manifest of ['{}', 'broken json', '{"name":"@external/bridge"}']) {
      expect(() => collectPluginRecords(fixture({
        [RECORDS]: augmentation(ENTRY), 'packages/experimental/bridge/package.json': manifest,
      }))).toThrow(/ownership|must belong/)
    }
  })

  it('omits tests and handles escaped declaration names through syntax discovery', () => {
    const root = fixture({
      'packages/experimental/bridge/tests/fixture.ts': augmentation(ENTRY),
      [RECORDS]: augmentation(ENTRY).replace('PluginRecordMap', '\\u0050luginRecordMap'),
    })
    expect(collectPluginRecords(root).map(record => record.name)).toEqual(['plugin:bridge/entry'])
  })
})

describe('plugin record catalogue output', () => {
  it('renders honest empty states in both languages', () => {
    const english = renderPluginRecordCatalog([])
    const chinese = renderPluginRecordCatalog([], 'zh')
    expect(english).toContain('# Experimental Plugin Record Catalog')
    expect(english).toContain('English | [中文](experimental-persistence-catalog.zh.md)')
    expect(english).toContain('No production package currently declares a plugin record.')
    expect(english).toContain('[Session persistence event catalog](persistence-catalog.md)')
    expect(chinese).toContain('[English](experimental-persistence-catalog.md) | 中文')
    expect(chinese).toContain('当前没有生产包声明插件记录。')
    expect(chinese).toContain('[会话持久化事件目录](persistence-catalog.zh.md)')
  })

  it('links the main catalogue to the experimental page without embedding its inventory', () => {
    const english = render([], [])
    const chinese = render([], [], undefined, 'zh')
    expect(english).toContain('[experimental plugin record catalog](experimental-persistence-catalog.md)')
    expect(chinese).toContain('[实验性插件记录目录](experimental-persistence-catalog.zh.md)')
    expect(english).not.toContain('No production package currently declares')
    expect(english).not.toContain('| Record | Owner |')
    expect(chinese).not.toContain('当前没有生产包声明')
    expect(chinese).not.toContain('| 记录 | 所属包 |')
  })

  it('renders compact, sorted rows with escaped annotations and no line-number churn', () => {
    const records = collectPluginRecords(fixture({ [RECORDS]: augmentation(`
      /** Retains state | metadata. */
      'plugin:bridge/state': { value: string | null; marker: 'a  b' }
      ${ENTRY}
    `) }))
    const output = renderPluginRecordCatalog([...records].reverse())
    expect(output).toContain('| `plugin:bridge/entry` | `@deepseek-ai/dsh-experimental-bridge` | Retains a bridge entry. | <code>SavedEntry</code>')
    expect(output).toContain('Retains state \\| metadata.')
    expect(output).toContain("<code>{ value: string &#124; null; marker: 'a  b'; }</code>")
    expect(output).toContain(`[\`${RECORDS}\`](../${RECORDS})`)
    expect(output.indexOf('| `plugin:bridge/entry`')).toBeLessThan(output.indexOf('| `plugin:bridge/state`'))
    expect(output).not.toMatch(/records\.ts:\d/u)
  })

  it('limits record declaration changes to the experimental artifact pair and its metadata', () => {
    const root = fixture({
      'tsconfig.host.json': JSON.stringify({ compilerOptions: {
        target: 'es2024', module: 'esnext', moduleResolution: 'bundler', strict: true, types: [],
        paths: { '@deepseek-ai/dsh-session/types': ['./packages/core/session/src/types.ts'] },
      }, include: ['packages/**/src/**/*.ts'] }),
      [OWNER]: `${OWNER_SOURCE}
export interface SessionHeader { version: 4; id: string; createdAt: number }
export interface SessionEventMap {
  /** One ordinary log event. */
  'test/record': { value: string }
}
/** Declared ordinary event names. */
export type SessionEventType = keyof SessionEventMap
/** Surface placement. */
export type SurfaceOp = 'append'
/** Events which can produce model history. */
export type SurfaceEventType = 'test/record'
/** One persisted event envelope. */
export type SessionEvent<T extends keyof SessionEventMap = keyof SessionEventMap> = {
  [K in keyof SessionEventMap]: { type: K; seq: number; time: number; data: SessionEventMap[K]; surfaceOp: SurfaceOp }
}[T]
`,
      'packages/session/session-persistence-jsonl/src/format.ts': "interface HeaderLine {type: 'session'; version: number; id: string; delegationDepth: number}\nexport {}\n",
    })
    const schema = extractPersistenceSchema(root)
    const empty = persistenceCatalogArtifacts(root, schema)
    const experimentalPaths = [
      'docs/experimental-persistence-catalog.md',
      'docs/experimental-persistence-catalog.zh.md',
      'docs/experimental-persistence-catalog.i18n.yaml',
    ]
    expect(empty.map(artifact => artifact.path)).toEqual([
      'docs/persistence-catalog.md', 'docs/persistence-catalog.zh.md', 'docs/persistence-catalog.i18n.yaml',
      ...experimentalPaths,
      'packages/core/session/src/known-event-types.ts', 'docs/persistence-schema.json',
    ])
    put(root, RECORDS, `interface SavedEntry { value: string }\n${augmentation(ENTRY)}`)
    const declared = persistenceCatalogArtifacts(root, schema)
    expect(declared.filter((artifact, index) => artifact.content !== empty[index]?.content).map(artifact => artifact.path))
      .toEqual(experimentalPaths)
    expect(extractPersistenceSchema(root)).toEqual(schema)
    const nullable = augmentation(ENTRY.replace(': SavedEntry', ': SavedEntry | null'))
    put(root, RECORDS, `interface SavedEntry { value: string }\n${nullable}`)
    const changedAnnotation = persistenceCatalogArtifacts(root, schema)
    expect(changedAnnotation.filter((artifact, index) => artifact.content !== declared[index]?.content).map(artifact => artifact.path))
      .toEqual(experimentalPaths)
    put(root, RECORDS, `interface SavedEntry { nested: { count: number } }\n${nullable}`)
    expect(persistenceCatalogArtifacts(root, schema)).toEqual(changedAnnotation)
    expect(extractPersistenceSchema(root)).toEqual(schema)
  })
})
