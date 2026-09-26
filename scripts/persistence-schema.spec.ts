import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectLogEvents } from './gen-persistence-catalog.ts'
import { extractPersistenceSchema } from './persistence-schema.ts'
import { classifyPersistenceChange, parsePersistenceSnapshot } from './persistence-changes.ts'
import { canonicalizeSchema, isArbitraryJsonSchema, schemaDigest, type PersistenceSchemaInventory } from './persistence-schema-model.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3 })
})

function put(root: string, file: string, source: string): void {
  const path = join(root, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, source)
}

function fixture(payload: string, options: { surface?: string; event?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-persistence-schema-'))
  roots.push(root)
  put(root, 'tsconfig.host.json', JSON.stringify({ compilerOptions: {
    target: 'es2024', module: 'esnext', moduleResolution: 'bundler', strict: true, skipLibCheck: true,
    types: [], paths: {
      '@deepseek-ai/dsh-session/types': ['./packages/core/session/src/types.ts'],
      '@fixture/payload': ['./packages/domain/payload/src/types.ts'],
    },
  }, include: ['packages/**/src/**/*.ts'] }))
  put(root, 'packages/core/session/package.json', '{"name":"@deepseek-ai/dsh-session"}')
  put(root, 'packages/domain/payload/package.json', '{"name":"@fixture/payload"}')
  put(root, 'packages/session/session-persistence-jsonl/src/format.ts', "interface HeaderLine {type: 'session'; version: number; id: string; delegationDepth: number}\nexport {}\n")
  put(root, 'packages/domain/payload/src/types.ts', payload)
  put(root, 'packages/core/session/src/types.ts', `
import type { Payload } from '@fixture/payload'
export interface SessionHeader { version: 3; id: string; createdAt: number }
export interface SessionEventMap {
  /** One recorded payload. */
  'test/record': Payload
  ${options.event ?? ''}
}
export type SurfaceEventType = ${options.surface ?? 'never'}
export type SessionEvent<T extends keyof SessionEventMap = keyof SessionEventMap> = {
  [K in keyof SessionEventMap]: { type: K; seq: number; time: number; data: SessionEventMap[K] }
    & (K extends SurfaceEventType ? { surfaceOp: 'append' | { replace: number } } : { surfaceOp?: never })
}[T]
`)
  return root
}

function event(inventory: PersistenceSchemaInventory, name = 'test/record'): string {
  const root = inventory.roots.find(root => root.event === name)
  if (root === undefined) throw new Error(`missing test event ${name}`)
  return root.digest
}

describe('persistent source type extraction', () => {
  it('keeps authored names and anonymous declaration locations without synthesized traversal names', () => {
    const root = fixture('interface Section { text: string }\nexport interface Payload { inserted: { source: { kind: "hooks-codex"; sections: Section[] } }[] }')
    const inventory = extractPersistenceSchema(root)
    expect(inventory.types.flatMap(type => type.names).every(name => name.includes('#'))).toBe(true)
    expect(inventory.types.some(type => type.names.includes('packages/domain/payload/src/types.ts#Section'))).toBe(true)
    expect(inventory.types.some(type => type.names.length === 0 && type.sources.includes('packages/domain/payload/src/types.ts:2'))).toBe(true)
    expect(inventory.types.some(type => type.schema.nodes[0]?.kind === 'array' && type.names.length === 0)).toBe(true)
    expect(parsePersistenceSnapshot(inventory)).toEqual(inventory)
  })

  it('ignores alias names, files, documentation, readonly, brands and property order', () => {
    const left = fixture('declare const brand: unique symbol; type Id = string & {readonly [brand]: "Id"}; export interface Payload { readonly id: Id; value?: number }')
    const right = fixture('type Renamed = string; /** Different documentation. */ export type Payload = {value?: number; id: Renamed}')
    expect(event(extractPersistenceSchema(left))).toBe(event(extractPersistenceSchema(right)))
  })

  it.each([
    ['nested field order',
      'export interface Payload {\n  id: string\n  detail: {\n    label: string\n    count?: number\n  }\n}',
      'export interface Payload {\n  detail: {\n    count?: number\n    label: string\n  }\n  id: string\n}'],
    ['anonymous union order',
      'export type Payload =\n  { a: string }\n  | { b: number }\n  | { c?: boolean }',
      'export type Payload =\n  { c?: boolean }\n  | { b: number }\n  | { a: string }'],
    ['recursive union order',
      'export type Payload =\n  { a: string; next?: Payload }\n  | { b: number; next?: Payload }\n  | null',
      'export type Payload =\n  null\n  | { next?: Payload; b: number }\n  | { next?: Payload; a: string }'],
    ['intersection and distributed union order',
      'type A = { a: string } | { b: number }; type B = { c: boolean }; export type Payload = A & B',
      'type A = { b: number } | { a: string }; type B = { c: boolean }; export type Payload = B & A'],
    ['index signature order',
      'export interface Payload { [key: string]: string | number; [key: number]: number }',
      'export interface Payload { [key: number]: number; [key: string]: number | string }'],
    ['type declaration order',
      'interface A { a: string }\ninterface B { b: number }\nexport type Payload = A | B',
      'interface B { b: number }\ninterface A { a: string }\nexport type Payload = B | A'],
    ['merged declaration order',
      'export interface Payload { a: string }\nexport interface Payload { b: number }',
      'export interface Payload { b: number }\nexport interface Payload { a: string }'],
    ['mapped key order',
      'export type Payload = { [K in "a" | "b" | "c"]: string }',
      'export type Payload = { [K in "c" | "b" | "a"]: string }'],
    ['explicit enum member order',
      'enum Value {\n  A = "a",\n  B = "b",\n}\nexport interface Payload { value: Value }',
      'enum Value {\n  B = "b",\n  A = "a",\n}\nexport interface Payload { value: Value }'],
  ])('keeps every root and type digest unchanged by %s', (_name, before, after) => {
    const root = fixture(before)
    const inventory = extractPersistenceSchema(root)
    put(root, 'packages/domain/payload/src/types.ts', after)
    const reordered = extractPersistenceSchema(root)
    expect(reordered.roots).toEqual(inventory.roots)
    expect(reordered.types.map(({ digest, schema }) => ({ digest, schema })))
      .toEqual(inventory.types.map(({ digest, schema }) => ({ digest, schema })))
  })

  it.each([
    ['tuple positions', 'export type Payload = [string, number]', 'export type Payload = [number, string]'],
    ['implicit enum values', 'enum Value { A, B }; export interface Payload { value: Value.A }', 'enum Value { B, A }; export interface Payload { value: Value.A }'],
  ])('changes the digest when reordering changes %s', (_name, before, after) => {
    const root = fixture(before)
    const digest = event(extractPersistenceSchema(root))
    put(root, 'packages/domain/payload/src/types.ts', after)
    expect(event(extractPersistenceSchema(root))).not.toBe(digest)
  })

  it('keeps header, envelope and event digests unchanged when root declarations are reordered', () => {
    const record = "  /** One recorded payload. */\n  'test/record': Payload"
    const other = "/** Another recorded payload. */\n  'test/other': { value: number }"
    const root = fixture('export interface Payload { id: string }', {
      surface: "'test/record' | 'test/other'",
      event: other,
    })
    const inventory = extractPersistenceSchema(root)
    const source = readFileSync(join(root, 'packages/core/session/src/types.ts'), 'utf8')
    const reordered = source
      .replace(`${record}\n  ${other}`, `  ${other}\n${record}`)
      .replace('version: 3; id: string; createdAt: number', 'createdAt: number; id: string; version: 3')
      .replace("'test/record' | 'test/other'", "'test/other' | 'test/record'")
      .replace('type: K; seq: number; time: number; data: SessionEventMap[K]', 'data: SessionEventMap[K]; time: number; seq: number; type: K')
    expect(reordered.indexOf("'test/other':")).toBeLessThan(reordered.indexOf("'test/record':"))
    put(root, 'packages/core/session/src/types.ts', reordered)
    put(root, 'packages/session/session-persistence-jsonl/src/format.ts', "interface HeaderLine {delegationDepth: number; id: string; version: number; type: 'session'}\nexport {}\n")
    const result = extractPersistenceSchema(root)
    expect(result.roots).toEqual(inventory.roots)
    expect(result.types.map(({ digest, schema }) => ({ digest, schema })))
      .toEqual(inventory.types.map(({ digest, schema }) => ({ digest, schema })))
  })

  it('materializes generic, conditional and mapped aliases into their concrete properties', () => {
    const generic = fixture('type Box<T> = { [K in keyof T]: T[K] extends string ? string[] : T[K] }; export type Payload = Box<{label: string; count?: number}>')
    const concrete = fixture('export interface Payload {count?: number; label: string[]}')
    expect(event(extractPersistenceSchema(generic))).toBe(event(extractPersistenceSchema(concrete)))
  })

  it('retains transitive recursion without depending on alias factoring', () => {
    const self = fixture('export interface Payload { value: string; next?: Payload }')
    const mutual = fixture('interface Other {next?: Payload; value: string} export interface Payload {value: string; next?: Other}')
    const changed = fixture('interface Other {next?: Payload; value: number} export interface Payload {value: string; next?: Other}')
    const digest = event(extractPersistenceSchema(self))
    expect(event(extractPersistenceSchema(mutual))).toBe(digest)
    expect(event(extractPersistenceSchema(changed))).not.toBe(digest)
  })

  it('includes independent Host modules that augment nested payload maps without event declarations', () => {
    const root = fixture('export interface NestedMap {first: {value: string}}; export type Payload = NestedMap[keyof NestedMap]')
    const before = extractPersistenceSchema(root)
    put(root, 'packages/domain/extension/src/index.ts', "import '@fixture/payload'; declare module '@fixture/payload' {interface NestedMap {second: {value: number}}}")
    const after = extractPersistenceSchema(root)
    expect(collectLogEvents(root)).toHaveLength(1)
    expect(event(after)).not.toBe(event(before))
    const data = after.types.find(item => item.schema.nodes[0]?.kind === 'union' && item.schema.nodes.some(node => node.kind === 'primitive' && node.type === 'number'))
    expect(data).toBeDefined()
  })

  it('discovers plugin event merges and keeps ordinary event additions out of the envelope digest', () => {
    const root = fixture('export interface Payload {id: string}')
    const before = extractPersistenceSchema(root)
    put(root, 'packages/domain/extension/src/index.ts', `import '@deepseek-ai/dsh-session/types'; declare module '@deepseek-ai/dsh-session/types' {
interface SessionEventMap {
/** A plugin event. */
'plugin/new': { optional?: boolean }
}}
`)
    const after = extractPersistenceSchema(root)
    expect(after.roots.some(root => root.event === 'plugin/new')).toBe(true)
    expect(after.roots.find(root => root.kind === 'envelope')?.digest).toBe(before.roots.find(root => root.kind === 'envelope')?.digest)
    expect(event(after)).toBe(event(before))
  })

  it('includes JSX-module events and rejects unsupported inherited declarations there', () => {
    const root = fixture('export interface Payload {id: string}')
    put(root, 'packages/domain/extension/src/index.tsx', `import '@deepseek-ai/dsh-session/types'; declare module '@deepseek-ai/dsh-session/types' {
interface SessionEventMap {
/** A JSX-module event. */
'plugin/tsx': { value: number }
}}
`)
    const config = join(root, 'tsconfig.host.json')
    const settings = JSON.parse(readFileSync(config, 'utf8')) as { include: string[] }
    settings.include.push('packages/**/src/**/*.tsx')
    writeFileSync(config, JSON.stringify(settings))
    expect(extractPersistenceSchema(root).roots.some(root => root.event === 'plugin/tsx')).toBe(true)
    put(root, 'packages/domain/extension/src/index.tsx', `import '@deepseek-ai/dsh-session/types';
interface Extra { 'plugin/inherited': {value: number} }
declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap extends Extra {} }
`)
    expect(() => extractPersistenceSchema(root)).toThrow('uses extends')
  })

  it('rejects an event map whose compiler vocabulary exceeds the discovered source corpus', () => {
    const root = fixture("import '../../../../vendor/events.ts'; export interface Payload {id: string}")
    put(root, 'vendor/events.ts', `import '@deepseek-ai/dsh-session/types'; declare module '@deepseek-ai/dsh-session/types' {
interface SessionEventMap {
/** A contribution outside the package source corpus. */
'outside/event': { value: number }
}}
`)
    expect(() => extractPersistenceSchema(root)).toThrow('omitted: outside/event')
  })

  it('keeps surface metadata strict and optional field additions visible', () => {
    const old = extractPersistenceSchema(fixture('export interface Payload {id: string}'))
    const optional = extractPersistenceSchema(fixture('export interface Payload {id: string; detail?: string}'))
    const surface = extractPersistenceSchema(fixture('export interface Payload {id: string}', { surface: "'test/record'" }))
    expect(event(old)).not.toBe(event(optional))
    expect(event(old)).not.toBe(event(surface))
    expect(surface.roots.find(root => root.event === 'test/record')?.surface).toBe(true)
    expect(surface.roots.find(root => root.kind === 'envelope')?.digest).not.toBe(old.roots.find(root => root.kind === 'envelope')?.digest)
  })

  it('tracks the physical JSONL header independently of the logical Session header', () => {
    const root = fixture('export interface Payload {id: string}')
    const before = extractPersistenceSchema(root)
    put(root, 'packages/session/session-persistence-jsonl/src/format.ts', "interface HeaderLine {type: 'session'; version: number; id: string; delegationDepth: number; marker?: string}\nexport {}\n")
    const after = extractPersistenceSchema(root)
    expect(after.roots.find(root => root.key === 'JsonlHeaderLine')?.digest).not.toBe(before.roots.find(root => root.key === 'JsonlHeaderLine')?.digest)
    expect(after.roots.find(root => root.key === 'SessionHeader')?.digest).toBe(before.roots.find(root => root.key === 'SessionHeader')?.digest)
  })

  it('keeps arbitrary JSON structural while explicitly identifying unknown and any', () => {
    const root = fixture('type Arbitrary = null | boolean | number | string | Arbitrary[] | {[key: string]: Arbitrary}; export interface Payload {json: Arbitrary; opaque: unknown; unsafe: any}')
    const model = extractPersistenceSchema(root)
    expect(model.types.some(item => isArbitraryJsonSchema(item.schema))).toBe(true)
    expect(model.types.filter(item => item.schema.nodes[0]?.kind === 'opaque').map(item => item.schema.nodes[0]))
      .toEqual(expect.arrayContaining([{ kind: 'opaque', reason: 'unknown' }, { kind: 'opaque', reason: 'any' }]))
    put(root, 'packages/domain/payload/src/types.ts', 'type Arbitrary = null | boolean | number | string | Arbitrary[]; export interface Payload {json: Arbitrary; opaque: unknown; unsafe: any}')
    const changed = extractPersistenceSchema(root)
    expect(event(changed)).not.toBe(event(model))
    expect(changed.types.some(item => isArbitraryJsonSchema(item.schema))).toBe(false)
  })

  it('rejects invalid reachable declaration files despite inherited skipLibCheck', () => {
    const root = fixture("export type { Payload } from './declared.js'")
    put(root, 'packages/domain/payload/src/declared.d.ts', 'type Bad = ReturnType<42>; export interface Payload {value: Bad}')
    expect(() => extractPersistenceSchema(root)).toThrow('TS2344')
  })

  it('preserves authored declaration-file any without checking unrelated declarations', () => {
    const root = fixture("export type { Payload } from './declared.js'")
    put(root, 'packages/domain/payload/src/declared.d.ts', 'type Declared = any; export interface Payload {value: Declared}; type Unrelated = ReturnType<42>')
    const model = extractPersistenceSchema(root)
    expect(model.types.some(item => item.schema.nodes[0]?.kind === 'opaque' && item.schema.nodes[0].reason === 'any')).toBe(true)
  })

  it('locates named transitive definitions at their declarations instead of their references', () => {
    const root = fixture("import type { Detail as ImportedDetail } from './detail.js'\nexport interface Payload { first: ImportedDetail; second: ImportedDetail }")
    put(root, 'packages/domain/payload/src/detail.ts', '/** Detailed payload. */\nexport interface Detail { code: string; done: true }\n')
    const model = extractPersistenceSchema(root)
    const detail = model.types.find(item => item.names.includes('packages/domain/payload/src/detail.ts#Detail'))
    expect(detail?.sources).toEqual(['packages/domain/payload/src/detail.ts:2'])
  })

  it('keeps shared scalar declaration metadata at real aliases and omits plain property references', () => {
    const root = fixture([
      'type Label = string',
      "type Done = 'done'",
      'export interface Payload {',
      '  label: Label',
      '  other: string',
      '  state: Done',
      "  fallback: 'done'",
      '  count: number',
      '}',
    ].join('\n'))
    const model = extractPersistenceSchema(root)
    const string = model.types.find(item => item.schema.nodes[0]?.kind === 'primitive' && item.schema.nodes[0].type === 'string')
    const literal = model.types.find(item => item.schema.nodes[0]?.kind === 'literal' && item.schema.nodes[0].value === 'done')
    const number = model.types.find(item => item.schema.nodes[0]?.kind === 'primitive' && item.schema.nodes[0].type === 'number')
    expect(string?.names).toEqual(['packages/domain/payload/src/types.ts#Label'])
    expect(string?.sources).toEqual(['packages/domain/payload/src/types.ts:1'])
    expect(literal?.names).toEqual(['packages/domain/payload/src/types.ts#Done'])
    expect(literal?.sources).toEqual(['packages/domain/payload/src/types.ts:2'])
    expect(number?.names).toEqual([])
    expect(number?.sources).toEqual([])
  })

  it('uses the declaration of an anonymous object literal and never its containing property', () => {
    const root = fixture('export interface Payload {\n  detail:\n    { code: string }\n}')
    const model = extractPersistenceSchema(root)
    const detail = model.types.find((item) => {
      const node = item.schema.nodes[0]
      return node?.kind === 'object' && node.properties.length === 1 && node.properties[0]?.name === 'code'
    })
    expect(detail?.sources).toEqual(['packages/domain/payload/src/types.ts:3'])
  })

  it.each([
    ['missing type', 'export interface Payload {value: Missing}', 'TS2304'],
    ['callable value', 'export interface Payload {value: () => void}', 'callable data'],
    ['class instance', 'export class Instance {value: string = ""}; export interface Payload {value: Instance}', 'class instances'],
    ['required undefined', 'export interface Payload {value: string | undefined}', 'no supported JSON'],
    ['unresolved template', 'export interface Payload {value: `prefix-${string}`}', 'no supported JSON'],
    ['empty object type', 'export type Payload = {}', 'unconstrained empty object'],
    ['symbol property', 'declare const key: unique symbol; export interface Payload {[key]: string; value: number}', 'symbol-keyed data'],
    ['conflicting merged property', 'export interface Payload {value: string}; export interface Payload {value: number}', 'TS2717'],
    ['class intersection', 'class Instance {value: string = ""}; export type Payload = Instance & {extra: string}', 'class instances'],
    ['invalid generic alias', 'type Bad = ReturnType<42>; export interface Payload {value: Bad}', 'TS2344'],
  ])('rejects %s rather than weakening the schema', (_name, source, error) => {
    expect(() => extractPersistenceSchema(fixture(source))).toThrow(error)
  })

  // Repository-wide TypeScript extraction and reachable-node hashing use the Windows coverage test budget.
  it('includes every real repository event and fingerprints every reachable node', { timeout: 90_000 }, () => {
    const root = resolve(import.meta.dirname, '..')
    const model = extractPersistenceSchema(root)
    expect(model.roots.filter(root => root.kind === 'event').map(root => root.event).sort())
      .toEqual(collectLogEvents(root).map(event => event.name).sort())
    expect(model.roots.some(root => root.kind === 'header')).toBe(true)
    expect(model.roots.some(root => root.kind === 'envelope')).toBe(true)
    const digests = new Set(model.types.map(type => type.digest))
    for (const root of model.roots) {
      expect(schemaDigest(root.schema)).toBe(root.digest)
      for (let node = 0; node < root.schema.nodes.length; node++) {
        expect(digests.has(schemaDigest(canonicalizeSchema(root.schema.nodes, node)))).toBe(true)
      }
    }
  })
})

describe('explicitly reserved JSON properties', () => {
  function extractedEvent(source: string) {
    const model = extractPersistenceSchema(fixture(source))
    const root = model.roots.find(root => root.event === 'test/record')
    if (root === undefined) throw new Error('missing reserved-property fixture event')
    return root
  }

  it('classifies a value added to a reserved field as a changed type', () => {
    const before = extractedEvent('export interface Payload { id: string;\n/** @persistenceReserved */\ntool?: never }')
    const after = extractedEvent('export interface Payload { id: string; tool?: string }')
    expect(classifyPersistenceChange(before, after)).toEqual([expect.objectContaining({
      path: 'event:test/record.data.tool', kind: 'type-changed', requiresVersionBump: true,
    })])
  })

  it.each(['never', 'undefined', 'never | undefined'])('retains a marked optional %s property as never', (value) => {
    const root = extractedEvent(`interface Reserved {\n/** @persistenceReserved */\ntool?: ${value}\n}\nexport interface Payload extends Reserved { id: string }`)
    const reserved = root.schema.nodes.flatMap(node => node.kind === 'object'
      ? node.properties.filter(property => property.name === 'tool').map(property => ({ optional: property.optional, value: root.schema.nodes[property.type] }))
      : [])
    expect(reserved).toEqual([{ optional: true, value: { kind: 'primitive', type: 'never' } }])
  })

  it('keeps unmarked optional never and undefined fields erased', () => {
    const before = extractedEvent('export interface Payload { id: string; tool?: never; missing?: undefined }')
    const after = extractedEvent('export interface Payload { id: string }')
    expect(before).toEqual(after)
  })

  it.each([
    'Required<Reserved>',
    '{ [Key in keyof Reserved]?: string }',
  ])('rejects a reserved property rewritten by %s', (mapped) => {
    expect(() => extractedEvent(`interface Reserved {\n/** @persistenceReserved */\ntool?: never\n}\nexport type Payload = ${mapped} & {id: string}`))
      .toThrow('@persistenceReserved must remain an optional never or undefined property')
  })

  it.each([
    ['required field', 'export interface Payload { id: string;\n/** @persistenceReserved */\ntool: never }'],
    ['string field', 'export interface Payload { id: string;\n/** @persistenceReserved */\ntool?: string }'],
    ['nullable field', 'export interface Payload { id: string;\n/** @persistenceReserved */\ntool?: null }'],
    ['unknown field', 'export interface Payload { id: string;\n/** @persistenceReserved */\ntool?: unknown }'],
    ['tag arguments', 'export interface Payload { id: string;\n/** @persistenceReserved value */\ntool?: never }'],
    ['duplicate tag', 'export interface Payload { id: string;\n/** @persistenceReserved\n * @persistenceReserved */\ntool?: never }'],
    ['non-property tag', '/** @persistenceReserved */\nexport interface Payload { id: string }'],
    ['unreachable misuse', 'interface Unused {\n/** @persistenceReserved */\ntool?: string }\nexport interface Payload { id: string }'],
  ])('rejects %s', (_name, source) => {
    expect(() => extractedEvent(source)).toThrow('@persistenceReserved requires one argument-free marker on an optional never or undefined property')
  })
})

function sourceFixture(producers: string, role: 'user' | 'developer' = 'user'): string {
  const root = fixture(`export type Payload = import('../../../llm/llm/src/message.js').${role === 'user' ? 'UserMessage' : 'DeveloperMessage'}`)
  put(root, 'packages/llm/llm/src/message.ts', `
export interface MessageSourceMap {
  semantic: {kind: 'semantic'; value: string}
  ${producers}
}
export type MessageSource = MessageSourceMap[keyof MessageSourceMap]
export interface MessageBase {
  /** @persistenceSource user developer */
  source: MessageSource
}
export interface UserMessage extends MessageBase {
  role: 'user'
}
export interface DeveloperMessage extends MessageBase {
  role: 'developer'
}
`)
  return root
}

const ATTRIBUTION = '/** @persistenceAttribution */'

describe('source compatibility authoring', () => {
  it.each(['user', 'developer'] as const)('records the %s binding and qualifies complete wire-kind groups', (role) => {
    const before = extractPersistenceSchema(sourceFixture('', role))
    const after = extractPersistenceSchema(sourceFixture(`${ATTRIBUTION} unrelatedMapKey: {kind: 'attribution'} & ({form?: never} | {form: 'notice'; summary: string})`, role))
    expect(after.formatVersion).toBe(2)
    const root = after.roots.find(root => root.kind === 'event')!
    const property = root.schema.nodes.flatMap(node => node.kind === 'object' ? node.properties : []).find(property => property.compatibility !== undefined)!
    expect(property.compatibility).toEqual({ version: 1, policy: 'session-source-attribution', binding: `session.${role}-message.source`,
      discriminator: 'kind', unknownKinds: 'preserve', attributionKinds: ['attribution'] })
    expect(classifyPersistenceChange(before.roots.find(root => root.kind === 'event')!, root))
      .toEqual([expect.objectContaining({ kind: 'attribution-kind-added', requiresVersionBump: false })])
    expect(parsePersistenceSnapshot({ ...after, types: [] })).toEqual({ ...after, types: [] })
  })

  it('binds inherited source declarations only on explicitly eligible required roles', () => {
    const root = sourceFixture("system: {kind: 'system-prompt'}; model: {kind: 'model'}; tool: {kind: 'tool'}")
    const core = 'packages/llm/llm/src/message.ts'
    put(root, core, readFileSync(join(root, core), 'utf8') + `
export interface SystemMessage extends MessageBase {role: 'system'; source: MessageSourceMap['system']}
export interface AssistantMessage extends MessageBase {role: 'assistant'; source: MessageSourceMap['model']}
export interface ToolMessage extends MessageBase {role: 'tool'; source: MessageSourceMap['tool']}
export interface UnlistedRole extends MessageBase {role: 'other'}
export interface OptionalRole extends MessageBase {role?: 'user'}
export interface BroadRole extends MessageBase {role: 'user' | 'developer'}
export interface OverriddenUser extends MessageBase {role: 'user'; source: MessageSource}
`)
    put(root, 'packages/domain/payload/src/types.ts', `
import type * as M from '../../../llm/llm/src/message.js'
export interface Payload {
  user: M.UserMessage
  developer: M.DeveloperMessage
  system: M.SystemMessage
  assistant: M.AssistantMessage
  tool: M.ToolMessage
  bare: M.MessageBase
  unlisted: M.UnlistedRole
  optional: M.OptionalRole
  broad: M.BroadRole
  override: M.OverriddenUser
  unrelated: {role: 'user'; source: M.MessageSource}
}
`)
    const schema = extractPersistenceSchema(root).roots.find(root => root.kind === 'event')!.schema
    const payload = schema.nodes.find(node => node.kind === 'object' && node.properties.some(property => property.name === 'unrelated'))!
    if (payload.kind !== 'object') throw new Error('missing payload fixture')
    const bindings = Object.fromEntries(payload.properties.map((property) => {
      const message = schema.nodes[property.type]
      if (message?.kind !== 'object') throw new Error('missing message fixture')
      return [property.name, message.properties.find(property => property.name === 'source')?.compatibility?.binding]
    }))
    expect(bindings).toEqual({
      user: 'session.user-message.source', developer: 'session.developer-message.source',
      system: undefined, assistant: undefined, tool: undefined, bare: undefined, unlisted: undefined,
      optional: undefined, broad: undefined, override: undefined, unrelated: undefined,
    })
  })

  it('keeps roles outside the annotation list strict', () => {
    const root = sourceFixture('', 'developer')
    const core = 'packages/llm/llm/src/message.ts'
    put(root, core, readFileSync(join(root, core), 'utf8').replace('@persistenceSource user developer', '@persistenceSource user'))
    const schema = extractPersistenceSchema(root)
    expect(schema.formatVersion).toBe(1)
    expect(schema.roots.flatMap(root => root.schema.nodes).flatMap(node => node.kind === 'object' ? node.properties : [])
      .every(property => property.compatibility === undefined)).toBe(true)
  })

  it.each(['', 'user user', 'assistant', 'user developer tool'])('rejects invalid eligible role list %s', (roles) => {
    const root = sourceFixture('')
    const core = 'packages/llm/llm/src/message.ts'
    put(root, core, readFileSync(join(root, core), 'utf8').replace('@persistenceSource user developer', `@persistenceSource ${roles}`))
    expect(() => extractPersistenceSchema(root)).toThrow('invalid @persistenceSource binding')
  })

  it('keeps qualification independent of map-key spelling, source order and union-arm order', () => {
    const left = sourceFixture(`${ATTRIBUTION} left: {kind: 'attribution'} & ({form?: never} | {form: 'notice'; summary: string})`)
    const right = sourceFixture(`${ATTRIBUTION} right: ({summary: string; form: 'notice'} | {form?: never}) & {kind: 'attribution'}`)
    expect(extractPersistenceSchema(left).roots).toEqual(extractPersistenceSchema(right).roots)
  })

  it('finds producer-owned qualifications in independently compiled module augmentations', () => {
    const root = sourceFixture('')
    const before = extractPersistenceSchema(root)
    put(root, 'packages/llm/llm/src/producer.ts', `import './message.js'
declare module './message.js' {
  interface MessageSourceMap {
    ${ATTRIBUTION}
    catalogKey: {kind: 'external-producer'}
  }
}`)
    const after = extractPersistenceSchema(root)
    expect(classifyPersistenceChange(before.roots.find(root => root.kind === 'event')!, after.roots.find(root => root.kind === 'event')!))
      .toEqual([expect.objectContaining({ kind: 'attribution-kind-added', requiresVersionBump: false })])
  })

  it('does not qualify unmarked additions or structurally equal unbound fields', () => {
    const before = sourceFixture('')
    const after = sourceFixture("unmarked: {kind: 'new'}")
    expect(classifyPersistenceChange(extractPersistenceSchema(before).roots.find(root => root.kind === 'event')!,
      extractPersistenceSchema(after).roots.find(root => root.kind === 'event')!).some(change => change.requiresVersionBump)).toBe(true)
    const left = fixture("export interface Payload { source: {kind: 'old'} }")
    const right = fixture("export interface Payload { source: {kind: 'old'} | {kind: 'new'} }")
    expect(classifyPersistenceChange(extractPersistenceSchema(left).roots.find(root => root.kind === 'event')!,
      extractPersistenceSchema(right).roots.find(root => root.kind === 'event')!).some(change => change.requiresVersionBump)).toBe(true)
  })

  it.each([
    [`${ATTRIBUTION} broad: {kind: string}`, 'one literal wire kind'],
    [`${ATTRIBUTION} optional: {kind?: 'new'}`, 'one literal wire kind'],
    [`${ATTRIBUTION} ambiguous: {kind: 'a'} | {kind: 'b'}`, 'one literal wire kind'],
    [`${ATTRIBUTION} duplicate: {kind: 'semantic'}`, 'conflicting attribution'],
    [`${ATTRIBUTION} first: {kind: 'same'};\n${ATTRIBUTION} second: {kind: 'same'; value: number}`, 'conflicting attribution'],
    ['broadUnmarked: {kind: string}', 'invalid source compatibility'],
    ...['model', 'tool', 'system-prompt', 'compact-checkpoint', 'dsh-session-title-llm', 'tool-registry', 'runtime-context', 'plugin']
      .map(kind => [`${ATTRIBUTION} forbidden: {kind: '${kind}'}`, 'invalid source compatibility']),
    ["/** @persistenceAttribution yes */ invalid: {kind: 'new'}", 'invalid @persistenceAttribution'],
    ['/** @persistenceAttribution\n * @persistenceAttribution */ duplicateTag: {kind: \'new\'}', 'invalid @persistenceAttribution'],
  ])('rejects invalid producer declaration %s', (producer, error) => {
    expect(() => extractPersistenceSchema(sourceFixture(producer))).toThrow(error)
  })

  it.each(['auto-review', 'compact-basic', 'ptc-mode'])('rejects reserved producer kind %s as new attribution', (kind) => {
    for (const role of ['user', 'developer'] as const) {
      const root = sourceFixture(`${ATTRIBUTION} reintroduced: {kind: '${kind}'}`, role)
      expect(() => extractPersistenceSchema(root)).toThrow('invalid source compatibility')
    }
  })

  it('rejects attribution and binding annotations outside their declared owners', () => {
    const misplaced = sourceFixture('')
    put(misplaced, 'packages/domain/payload/src/types.ts', `${ATTRIBUTION} export interface Payload {kind: 'new'}`)
    expect(() => extractPersistenceSchema(misplaced)).toThrow('must annotate a MessageSourceMap producer property')
    const source = sourceFixture('')
    put(source, 'packages/domain/payload/src/types.ts', "export interface Payload {role: 'user';\n/** @persistenceSource user */\nsource: {kind: 'new'}}")
    expect(() => extractPersistenceSchema(source)).toThrow('invalid @persistenceSource binding')
  })
})
