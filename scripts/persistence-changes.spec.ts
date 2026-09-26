/** Current-tree persistence history rejects uncovered and incorrectly acknowledged type changes. */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalizeSchema, schemaDigest } from './persistence-schema-model.ts'
import type { PersistenceRoot, PersistenceSchemaInventory, SchemaNode, SchemaProperty, SourceCompatibility } from './persistence-schema-model.ts'
import { extractPersistenceSchema } from './persistence-schema.ts'
import { persistenceCatalogArtifacts } from './gen-persistence-catalog.ts'
import { createPersistenceFinalizationCheckpoint, loadPersistenceFinalization } from './persistence-finalization.ts'
import {
  classifyPersistenceChange,
  loadPersistenceHistory,
  parseHistoricalPersistenceSnapshot,
  parsePersistenceSnapshot,
  runPersistenceChanges as executePersistenceChanges,
  validatePersistenceHistory,
  verifyPersistenceChanges,
} from './persistence-changes.ts'
import type { PersistenceChangeRecord, PersistenceHistoryEntry, PersistenceTypeChange } from './persistence-changes.ts'

function runPersistenceChanges(
  args: readonly string[], root: string, extract: (root: string) => PersistenceSchemaInventory,
): string {
  return executePersistenceChanges(args, root, extract, (_root, current) => [{
    path: 'docs/persistence-schema.json', content: JSON.stringify(current, null, 2) + '\n',
  }])
}

function jsonResult(source: string): { ok: boolean; files: readonly string[] } {
  return JSON.parse(source) as { ok: boolean; files: readonly string[] }
}

const AUTHORED_PROSE = {
  en: { summary: 'Adds optional metadata.', compatibility: 'Readers may omit the metadata.', verification: 'The focused tests passed.' },
  zh: { summary: '添加可选元数据。', compatibility: '读取方可省略元数据。', verification: '定向测试通过。' },
}

function proseFile(root: string): string {
  const path = join(root, 'prose.json')
  writeFileSync(path, JSON.stringify(AUTHORED_PROSE))
  return path
}

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-persistence-changes-'))
  roots.push(root)
  mkdirSync(join(root, 'docs/persistence-changes'), { recursive: true })
  return root
}

type Shape = 'string' | 'number' | 'boolean' | { readonly [property: string]: Shape }

function typeRoot(key: string, shape: Shape, version = 3): PersistenceRoot {
  const nodes: SchemaNode[] = []
  function add(shape: Shape): number {
    const index = nodes.length
    nodes.push({ kind: 'primitive', type: 'never' })
    nodes[index] = typeof shape === 'string' ? { kind: 'primitive', type: shape } : {
      kind: 'object', indices: [], properties: Object.entries(shape).map(([name, child]) => ({
        name: name.replace(/\?$/u, ''), optional: name.endsWith('?'), type: add(child),
      })),
    }
    return index
  }
  if (key === 'SessionHeader') {
    const index = add(shape)
    const node = nodes[index]!
    if (node.kind !== 'object') throw new Error('header fixture requires an object')
    nodes[index] = { ...node, properties: [...node.properties, { name: 'version', optional: false, type: nodes.length }] }
    nodes.push({ kind: 'literal', value: version })
  } else if (key.startsWith('event:')) {
    add({ data: shape, type: 'string' })
    const node = nodes[0]!
    if (node.kind !== 'object') throw new Error('event fixture requires an object')
    const type = node.properties.find(item => item.name === 'type')!.type
    nodes[type] = { kind: 'literal', value: key.slice(6) }
  } else add(shape)
  const schema = canonicalizeSchema(nodes, 0)
  return { key, kind: ['SessionHeader', 'JsonlHeaderLine'].includes(key) ? 'header' : key === 'SessionEventEnvelope' ? 'envelope' : 'event',
    ...(key.startsWith('event:') ? { event: key.slice(6), surface: false } : {}), schema, digest: schemaDigest(schema) }
}

function inventory(eventShape: Shape = { value: 'string' }, version = 3): PersistenceSchemaInventory {
  return { formatVersion: 1, types: [], roots: [typeRoot('SessionHeader', { id: 'string' }, version), typeRoot('SessionEventEnvelope', { type: 'string' }), typeRoot('event:example/value', eventShape), typeRoot('JsonlHeaderLine', { version: 'number' })] }
}

function entry(
  id: string, schema: PersistenceSchemaInventory, previous: string | null,
  baseline = false, decision: 'same-version' | 'version-bump' = 'same-version',
): PersistenceHistoryEntry {
  return {
    record: { schemaVersion: 1, id, baseline, changes: schema.roots.map(root => ({
      root: root.key, previous, after: root.digest, decision,
    })) },
    snapshot: schema,
  }
}

const BASE_ID = '2026-09-11-baseline'
const NEXT_ID = '2026-09-11-change'

function historicalSurface(operation: 'required' | 'optional' | 'absent', event = 'example/value'): PersistenceSchemaInventory {
  const nodes: SchemaNode[] = [
    { kind: 'object', indices: [], properties: [
      { name: 'type', type: 1, optional: false },
      ...(operation === 'absent' ? [] : [{ name: 'surfaceOp', type: 2, optional: operation === 'optional' }]),
    ] },
    { kind: 'literal', value: event },
    { kind: 'primitive', type: 'string' },
  ]
  const schema = canonicalizeSchema(nodes, 0)
  return { formatVersion: 1, types: [], roots: [{
    key: 'event:example/value', kind: 'event', event: 'example/value', surface: true, schema, digest: schemaDigest(schema),
  }] }
}

describe('historical persistence snapshot parsing', () => {
  it('preserves source paths and fingerprints in historical inventories', () => {
    const snapshot = historicalSurface('required')
    const root = snapshot.roots[0]!
    const sources = ['packages/core/example/src/types.ts']
    const complete = { ...snapshot, types: [{ schema: root.schema, digest: root.digest, names: ['Example'], sources }] }
    expect(parseHistoricalPersistenceSnapshot(complete)).toEqual(complete)
  })

  it.each([':8', ':8:3', '#L8', '#L8-L12'])('rejects source coordinates %s only in historical inventories', (suffix) => {
    const snapshot = historicalSurface('required')
    const root = snapshot.roots[0]!
    const sources = [`packages/core/example/src/types.ts${suffix}`]
    const complete = { ...snapshot, types: [{ schema: root.schema, digest: root.digest, names: [], sources }] }
    expect(() => parseHistoricalPersistenceSnapshot(complete)).toThrow('historical schema sources must omit line numbers')
    expect(parsePersistenceSnapshot(complete)).toEqual(complete)
  })

  it('admits optional surface operations only through the historical parser', () => {
    const snapshot = historicalSurface('optional')
    expect(() => parsePersistenceSnapshot(snapshot)).toThrow('surface metadata')
    expect(parseHistoricalPersistenceSnapshot(snapshot)).toEqual(snapshot)
    expect(parsePersistenceSnapshot(historicalSurface('required'))).toEqual(historicalSurface('required'))
  })

  it('still rejects absent operations, mismatched event tags, and invalid roots', () => {
    expect(() => parseHistoricalPersistenceSnapshot(historicalSurface('absent'))).toThrow('surface metadata')
    expect(() => parseHistoricalPersistenceSnapshot(historicalSurface('optional', 'wrong/tag'))).toThrow('type does not match')
    const snapshot = historicalSurface('optional')
    expect(() => parseHistoricalPersistenceSnapshot({ ...snapshot, roots: snapshot.roots.map(root => ({ ...root, key: 'event:wrong/key' })) })).toThrow('invalid event root key')
    expect(() => parseHistoricalPersistenceSnapshot({ ...snapshot, roots: snapshot.roots.map(root => ({ ...root, surface: false })) })).toThrow('surface metadata')
  })

  it('preserves graph and digest validation in historical mode', () => {
    const snapshot = historicalSurface('optional')
    expect(() => parseHistoricalPersistenceSnapshot({ ...snapshot, roots: snapshot.roots.map(root => ({ ...root, digest: 'f'.repeat(64) })) })).toThrow('digest mismatch')
    expect(() => parseHistoricalPersistenceSnapshot({ ...snapshot, roots: snapshot.roots.map(root => ({ ...root, schema: { root: 0, nodes: [{ kind: 'array', element: 9 }] } })) })).toThrow('unknown schema node')
  })
})

const FINALIZED_ID = '2026-09-18-finalized-v4'
const COMPATIBLE_ID = '2026-09-19-compatible-v4'
const FUTURE_ID = '2026-09-19-future-v5'

function finalize(root: string, current = inventory({ value: 'number' }, 4)): void {
  baseline(root)
  runPersistenceChanges(['--record', FINALIZED_ID, '--prose', proseFile(root)], root, () => current)
  const checkpoint = createPersistenceFinalizationCheckpoint(loadPersistenceHistory(root), current)
  mkdirSync(join(root, 'docs/persistence-changes/finalized'))
  writeFileSync(join(root, 'docs/persistence-changes/finalized/v4.json'), JSON.stringify(checkpoint))
  for (const suffix of ['.md', '.zh.md']) {
    writeFileSync(join(root, `docs/session-format-status${suffix}`), '```yaml session-format-finalization\nlatestFinalizedVersion: 4\n```\n')
  }
}

function contents(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  const visit = (directory: string): void => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = posix.join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else files[path] = readFileSync(join(root, path), 'utf8')
    }
  }
  visit('')
  return files
}

describe('accepted persistence baseline', () => {
  it('keeps metadata-only catalog regeneration and checkpoint capture independent of publication', () => {
    const root = fixture()
    const current = inventory({ value: 'number' }, 4)
    finalize(root, current)
    const metadata = { ...current, roots: [...current.roots].reverse(), types: [{
      ...current.roots[2]!, names: ['RenamedAlias'], sources: ['packages/example/src/types.ts:99'],
    }].map(({ schema, digest, names, sources }) => ({ schema, digest, names, sources })) }
    commitCurrent(root, metadata)
    expect(runPersistenceChanges(['--check'], root, () => metadata)).toContain('roots match')
    expect(createPersistenceFinalizationCheckpoint(loadPersistenceHistory(root), metadata))
      .toEqual(JSON.parse(readFileSync(join(root, 'docs/persistence-changes/finalized/v4.json'), 'utf8')))
    expect(contents(root)['docs/session-format-status.md']).not.toContain('latestReleasedVersion')
  })

  it.each(['optional field', 'ordinary event'] as const)('allows a V4 %s through a new same-version acknowledgement', (kind) => {
    const root = fixture()
    const current = inventory({ value: 'number' }, 4)
    finalize(root, current)
    const after = kind === 'ordinary event'
      ? { ...current, roots: [...current.roots, typeRoot('event:example/new', {})] }
      : inventory({ value: 'number', 'label?': 'string' }, 4)
    const before = contents(root)
    commitCurrent(root, after)
    expect(() => verifyPersistenceChanges(root, after)).toThrow('unacknowledged persistence type changes')
    runPersistenceChanges(['--record', COMPATIBLE_ID, '--prose', proseFile(root)], root, () => after)
    expect(runPersistenceChanges(['--check'], root, () => after)).toContain('roots match')
    const history = loadPersistenceHistory(root)
    expect(history.entries.find(entry => entry.record.id === COMPATIBLE_ID)?.record.changes)
      .toEqual([expect.objectContaining({ decision: 'same-version' })])
    expect(loadPersistenceFinalization(root, history)?.acceptedRecords.has(COMPATIBLE_ID)).toBe(false)
    for (const [path, value] of Object.entries(before).filter(([path]) => path.startsWith('docs/persistence-changes/'))) {
      expect(readFileSync(join(root, path), 'utf8')).toBe(value)
    }
  })

  it.each(['required field', 'changed type'] as const)('refuses a breaking V4 %s before rendering or writing', (kind) => {
    const root = fixture()
    finalize(root)
    const after = inventory(kind === 'required field' ? { value: 'number', label: 'string' } : { value: 'boolean' }, 4)
    const before = contents(root)
    let rendered = false
    const result = JSON.parse(executePersistenceChanges(['--record', FUTURE_ID, '--json'], root, () => after, () => {
      rendered = true
      return []
    })) as { ok: boolean; code: string; changes: PersistenceTypeChange[] }
    expect(result).toMatchObject({ ok: false, code: 'finalized-format-changed' })
    expect(result.changes.length).toBeGreaterThan(0)
    expect(result.changes.some(change => change.requiresVersionBump)).toBe(true)
    expect(rendered).toBe(false)
    expect(contents(root)).toEqual(before)
    commitCurrent(root, after)
    expect(() => verifyPersistenceChanges(root, after)).toThrow('Breaking changes relative to the accepted Session format 4 baseline')
  })

  it('allows qualified V4 attribution additions through a new same-version acknowledgement', () => {
    const root = fixture()
    const source = attributedRoot([EXISTING_SOURCE])
    const current: PersistenceSchemaInventory = { ...inventory({ value: 'number' }, 4), formatVersion: 2,
      roots: [...inventory({ value: 'number' }, 4).roots, source] }
    finalize(root, current)
    const added = attributedRoot([EXISTING_SOURCE, { kind: 'new-attribution' }], { policy: attributionPolicy(['new-attribution']) })
    const after = { ...current, roots: current.roots.map(root => root.key === source.key ? added : root) }
    expect(classifyPersistenceChange(source, added)).toEqual([expect.objectContaining({ kind: 'attribution-kind-added', requiresVersionBump: false })])
    const before = contents(root)
    runPersistenceChanges(['--record', COMPATIBLE_ID, '--prose', proseFile(root)], root, () => after)
    expect(runPersistenceChanges(['--check'], root, () => after)).toContain('roots match')
    expect(loadPersistenceHistory(root).entries.find(entry => entry.record.id === COMPATIBLE_ID)?.record.changes)
      .toEqual([expect.objectContaining({ decision: 'same-version' })])
    for (const [path, value] of Object.entries(before).filter(([path]) => path.startsWith('docs/persistence-changes/'))) {
      expect(readFileSync(join(root, path), 'utf8')).toBe(value)
    }
  })

  it('keeps later unaccepted compatible records editable and rejects a breaking successor without its own version transition', () => {
    const root = fixture()
    finalize(root)
    const first = inventory({ value: 'number', 'label?': 'string' }, 4)
    runPersistenceChanges(['--record', COMPATIBLE_ID, '--prose', proseFile(root)], root, () => first)
    const amended = inventory({ value: 'number', 'label?': 'string', 'extra?': 'boolean' }, 4)
    runPersistenceChanges(['--update', COMPATIBLE_ID], root, () => amended)
    expect(runPersistenceChanges(['--check'], root, () => amended)).toContain('roots match')
    expect(loadPersistenceFinalization(root, loadPersistenceHistory(root))?.acceptedRecords.has(COMPATIBLE_ID)).toBe(false)
    const breaking = inventory({ value: 'number', 'label?': 'number', 'extra?': 'boolean' }, 4)
    const accepted = inventory({ value: 'number' }, 4).roots[2]!
    expect(classifyPersistenceChange(accepted, breaking.roots[2]!).every(change => !change.requiresVersionBump)).toBe(true)
    const before = contents(root)
    expect(() => runPersistenceChanges(['--record', '2026-09-20-breaking-v4', '--prose', proseFile(root)], root, () => breaking))
      .toThrow("this record's own increasing SessionHeader.version")
    expect(contents(root)).toEqual(before)
  })

  it.each(['compatible', 'breaking'] as const)('refuses a %s update to an accepted acknowledgement', (kind) => {
    const root = fixture()
    finalize(root)
    const after = inventory(kind === 'compatible' ? { value: 'number', 'label?': 'string' } : { value: 'boolean' }, 4)
    const before = contents(root)
    expect(() => runPersistenceChanges(['--update', FINALIZED_ID], root, () => after))
      .toThrow('cannot update finalized acknowledgement')
    expect(contents(root)).toEqual(before)
  })

  it('allows a fresh V5 transition while retaining finalized history', () => {
    const root = fixture()
    finalize(root)
    const before = contents(root)
    const after = inventory({ value: 'boolean' }, 5)
    runPersistenceChanges(['--record', FUTURE_ID, '--prose', proseFile(root)], root, () => after)
    expect(runPersistenceChanges(['--check'], root, () => after)).toContain('roots match')
    for (const [path, value] of Object.entries(before).filter(([path]) => path.startsWith('docs/persistence-changes/'))) {
      expect(readFileSync(join(root, path), 'utf8')).toBe(value)
    }
    expect(() => runPersistenceChanges(['--update', FINALIZED_ID], root, () => after)).toThrow('cannot update finalized acknowledgement')
    const later = inventory({ value: 'string' }, 5)
    expect(() => runPersistenceChanges(['--record', '2026-09-20-without-version', '--prose', proseFile(root)], root, () => later))
      .toThrow("this record's own increasing SessionHeader.version")
  })

  it.each([4, 5])('detects a consistently rewritten accepted record while the writer is V%s', (version) => {
    const root = fixture()
    finalize(root)
    const current = inventory({ value: version === 4 ? 'number' : 'boolean' }, version)
    if (version === 5) runPersistenceChanges(['--record', FUTURE_ID, '--prose', proseFile(root)], root, () => current)
    const snapshotPath = join(root, `docs/persistence-changes/${FINALIZED_ID}.schema.json`)
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as PersistenceSchemaInventory
    const replacement = typeRoot('event:example/value', { value: 'number', extra: 'string' })
    const original = snapshot.roots.find(root => root.key === replacement.key)!
    writeFileSync(snapshotPath, JSON.stringify({ ...snapshot,
      roots: snapshot.roots.map(root => root.key === replacement.key ? replacement : root) }))
    for (const suffix of ['.md', '.zh.md']) {
      const path = join(root, `docs/persistence-changes/${FINALIZED_ID}${suffix}`)
      writeFileSync(path, readFileSync(path, 'utf8').replace(original.digest, replacement.digest))
    }
    expect(() => loadPersistenceHistory(root)).not.toThrow()
    expect(() => verifyPersistenceChanges(root, current)).toThrow(`finalized acknowledgement ${FINALIZED_ID} was removed or changed`)
    const before = contents(root)
    expect(() => runPersistenceChanges(['--record', '2026-09-20-later'], root, () => inventory({ value: 'string' }, 6)))
      .toThrow('finalized acknowledgement')
    expect(contents(root)).toEqual(before)
  })

  it.each(['missing checkpoint', 'missing status', 'unpaired status', 'duplicate status', 'invalid checkpoint', 'incomplete roots', 'future checkpoint'] as const)
  ('rejects %s instead of silently disabling finalization', (kind) => {
    const root = fixture()
    finalize(root)
    const checkpoint = join(root, 'docs/persistence-changes/finalized/v4.json')
    const status = join(root, 'docs/session-format-status.md')
    if (kind === 'missing checkpoint') rmSync(checkpoint)
    else if (kind === 'missing status') {
      rmSync(status)
      rmSync(join(root, 'docs/session-format-status.zh.md'))
    } else if (kind === 'unpaired status') writeFileSync(status, readFileSync(status, 'utf8').replace(': 4', ': 5'))
    else if (kind === 'duplicate status') writeFileSync(status, readFileSync(status, 'utf8').repeat(2))
    else if (kind === 'future checkpoint') writeFileSync(join(root, 'docs/persistence-changes/finalized/v5.json'), readFileSync(checkpoint))
    else {
      const data = JSON.parse(readFileSync(checkpoint, 'utf8')) as Record<string, unknown>
      if (kind === 'invalid checkpoint') data.schemaVersion = 2
      else data.roots = {}
      writeFileSync(checkpoint, JSON.stringify(data))
    }
    const before = contents(root)
    expect(() => runPersistenceChanges(['--check'], root, () => inventory({ value: 'number' }, 4))).toThrow(/finaliz|checkpoint/u)
    expect(() => runPersistenceChanges(['--record', FUTURE_ID], root, () => inventory({ value: 'boolean' }, 5)))
      .toThrow(/finaliz|checkpoint/u)
    expect(contents(root)).toEqual(before)
  })

  it('keeps older fixture roots valid when neither finalization status nor checkpoints exist', () => {
    const root = fixture()
    baseline(root)
    expect(loadPersistenceFinalization(root, loadPersistenceHistory(root))).toBeUndefined()
  })
})

function onlyEvent(schema: PersistenceSchemaInventory): PersistenceSchemaInventory {
  return { ...schema, roots: schema.roots.filter(root => root.kind === 'event') }
}

function finishDocuments(root: string, id: string): void {
  for (const suffix of ['.md', '.zh.md']) {
    const path = join(root, 'docs/persistence-changes', id + suffix)
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('TODO: explain this change.', 'Optional payload metadata preserves the recorded value.')
      .replaceAll('TODO: record validation evidence.', 'The focused persistence-history tests passed.'))
  }
}

function commitCurrent(root: string, schema: PersistenceSchemaInventory): void {
  writeFileSync(join(root, 'docs/persistence-schema.json'), JSON.stringify(schema, null, 2) + '\n')
}

function baseline(root: string, schema = inventory()): void {
  runPersistenceChanges(['--baseline', BASE_ID], root, () => schema)
  finishDocuments(root, BASE_ID)
  commitCurrent(root, schema)
}

function unionBody(arms: readonly (readonly SchemaProperty[])[]): PersistenceRoot {
  const nodes: SchemaNode[] = [
    { kind: 'object', indices: [], properties: [{ name: 'data', type: 1, optional: false }] },
    { kind: 'union', types: arms.map((_, index) => 5 + index) },
    { kind: 'primitive', type: 'string' },
    { kind: 'primitive', type: 'number' },
    { kind: 'primitive', type: 'boolean' },
    ...arms.map(properties => ({ kind: 'object' as const, indices: [], properties })),
  ]
  const schema = canonicalizeSchema(nodes, 0)
  return { ...typeRoot('event:example/value', {}), schema, digest: schemaDigest(schema) }
}

function versionedEvent(variants: readonly { version: number; mode: string; extra?: boolean }[]): PersistenceRoot {
  const nodes: SchemaNode[] = [
    { kind: 'object', indices: [], properties: [
      { name: 'data', type: variants.length === 1 ? 3 : 1, optional: false },
      { name: 'type', type: 3 + variants.length * 3, optional: false },
    ] },
    { kind: 'union', types: variants.map((_, index) => 3 + index * 3) },
    { kind: 'primitive', type: 'string' },
  ]
  for (const variant of variants) {
    const index = nodes.length
    nodes.push({ kind: 'object', indices: [], properties: [
      { name: 'version', type: index + 1, optional: false },
      { name: 'mode', type: index + 2, optional: false },
      ...(variant.extra ? [{ name: 'extra', type: 2, optional: false }] : []),
    ] }, { kind: 'literal', value: variant.version }, { kind: 'literal', value: variant.mode })
  }
  nodes.push({ kind: 'literal', value: 'example/value' })
  const schema = canonicalizeSchema(nodes, 0)
  return { ...typeRoot('event:example/value', {}), schema, digest: schemaDigest(schema) }
}

describe('persistence change classification', () => {
  it.each([1, 2])('acknowledges a higher payload version while preserving %s old variant(s) and the V4 checkpoint', (count) => {
    const root = fixture()
    const variants = [{ version: 0, mode: 'one-shot' }, { version: 0, mode: 'continuable' }].slice(0, count)
    const oldEvent = versionedEvent(variants)
    const nextEvent = versionedEvent([...variants, { version: 1, mode: 'unknown', extra: true }])
    const before = { ...inventory({}, 4), roots: [...inventory({}, 4).roots.filter(root => root.kind !== 'event'), oldEvent] }
    finalize(root, before)
    const after = { ...before, roots: before.roots.map(root => root.kind === 'event' ? nextEvent : root) }
    expect(classifyPersistenceChange(oldEvent, nextEvent))
      .toEqual([expect.objectContaining({ kind: 'payload-version-added', requiresVersionBump: false })])
    runPersistenceChanges(['--record', COMPATIBLE_ID, '--prose', proseFile(root)], root, () => after)
    verifyPersistenceChanges(root, after)
  })

  it('rejects changes to old payloads, missing versions, non-increasing versions, and removal of old readers', () => {
    const variants = [{ version: 0, mode: 'one-shot' }, { version: 0, mode: 'continuable' }]
    const before = versionedEvent(variants)
    for (const after of [
      versionedEvent([...variants, { version: 0, mode: 'unknown' }]),
      versionedEvent([...variants, { version: -1, mode: 'unknown' }]),
      versionedEvent([...variants, { version: 0.5, mode: 'unknown' }]),
      versionedEvent([{ version: 0, mode: 'one-shot', extra: true }, variants[1]!, { version: 1, mode: 'unknown' }]),
      versionedEvent([{ version: 1, mode: 'unknown' }]),
    ]) expect(classifyPersistenceChange(before, after).some(change => change.requiresVersionBump)).toBe(true)
    const expanded = versionedEvent([...variants, { version: 1, mode: 'unknown' }])
    expect(classifyPersistenceChange(expanded, before).some(change => change.requiresVersionBump)).toBe(true)
    expect(classifyPersistenceChange({ ...before, surface: true }, { ...expanded, surface: true })
      .some(change => change.requiresVersionBump)).toBe(true)
    expect(classifyPersistenceChange({ ...before, kind: 'header' }, { ...expanded, kind: 'header' })
      .some(change => change.requiresVersionBump)).toBe(true)
    const unversioned = unionBody([[{ name: 'mode', type: 2, optional: false }]])
    expect(classifyPersistenceChange(unversioned, expanded).some(change => change.requiresVersionBump)).toBe(true)
  })

  it('treats a new optional payload subtree as one additive change even with required descendants', () => {
    const before = typeRoot('event:example/value', { value: 'string' })
    const after = typeRoot('event:example/value', { value: 'string', 'details?': { name: 'string', count: 'number' } })
    expect(classifyPersistenceChange(before, after)).toEqual([{ path: 'event:example/value.data.details', kind: 'optional-property-added', description: 'optional property added', requiresVersionBump: false }])
  })

  it('permits required-to-optional payload properties while rejecting opposite changes, type changes, and removals', () => {
    const required = typeRoot('event:example/value', { value: 'string' })
    const optional = typeRoot('event:example/value', { 'value?': 'string' })
    expect(classifyPersistenceChange(required, optional).every(change => !change.requiresVersionBump)).toBe(true)
    for (const after of [required, typeRoot('event:example/value', { 'value?': 'number' }), typeRoot('event:example/value', {})]) {
      expect(classifyPersistenceChange(optional, after).some(change => change.requiresVersionBump)).toBe(true)
    }
  })

  it('pairs multiple discriminated union arms when a shared payload gains an optional property', () => {
    function unionRoot(optional: boolean): PersistenceRoot {
      const nodes: SchemaNode[] = [
        { kind: 'object', indices: [], properties: [{ name: 'data', type: 1, optional: false }] },
        { kind: 'union', types: [2, 3] },
        { kind: 'object', indices: [], properties: [{ name: 'kind', type: 4, optional: false }, { name: 'payload', type: 6, optional: false }] },
        { kind: 'object', indices: [], properties: [{ name: 'kind', type: 5, optional: false }, { name: 'payload', type: 6, optional: false }] },
        { kind: 'literal', value: 'left' }, { kind: 'literal', value: 'right' },
        { kind: 'object', indices: [], properties: [{ name: 'value', type: 7, optional: false }, ...(optional ? [{ name: 'label', type: 7, optional: true }] : [])] },
        { kind: 'primitive', type: 'string' },
      ]
      const schema = canonicalizeSchema(nodes, 0)
      return { ...typeRoot('event:example/value', {}), schema, digest: schemaDigest(schema) }
    }
    const differences = classifyPersistenceChange(unionRoot(false), unionRoot(true))
    expect(differences.length).toBeGreaterThan(0)
    expect(differences.every(change => !change.requiresVersionBump)).toBe(true)
  })

  it('allows optional additions across undiscriminated union arms', () => {
    const first = [{ name: 'a', type: 2, optional: false }]
    const second = [{ name: 'b', type: 3, optional: false }]
    const extra = { name: 'x', type: 4, optional: true }
    const differences = classifyPersistenceChange(unionBody([first, second]), unionBody([[...first, extra], [...second, extra]]))
    expect(differences).toEqual([expect.objectContaining({ path: 'event:example/value.data.x', requiresVersionBump: false })])
  })

  it('allows required-to-optional fields across undiscriminated union arms', () => {
    const before = unionBody([[{ name: 'a', type: 2, optional: false }], [{ name: 'b', type: 3, optional: false }]])
    const after = unionBody([[{ name: 'a', type: 2, optional: true }], [{ name: 'b', type: 3, optional: true }]])
    const differences = classifyPersistenceChange(before, after)
    expect(differences.map(change => change.path).sort()).toEqual(['event:example/value.data.a', 'event:example/value.data.b'])
    expect(differences.every(change => change.kind === 'property-made-optional' && !change.requiresVersionBump)).toBe(true)
  })

  it('finds a complete matching when one union arm has multiple additive successors', () => {
    const required = [{ name: 'a', type: 2, optional: false }]
    const optional = [{ name: 'a', type: 2, optional: true }]
    const flexible = [{ name: '0', type: 4, optional: true }, ...optional]
    const constrained = [...required, { name: 'z', type: 4, optional: true }]
    const before = unionBody([required, optional])
    for (const after of [unionBody([flexible, constrained]), unionBody([constrained, flexible])]) {
      const differences = classifyPersistenceChange(before, after)
      expect(differences.length).toBeGreaterThan(0)
      expect(differences.every(change => !change.requiresVersionBump)).toBe(true)
    }
    const noCompleteMatching = unionBody([flexible, [{ name: 'different', type: 4, optional: true }]])
    expect(classifyPersistenceChange(before, noCompleteMatching).some(change => change.requiresVersionBump)).toBe(true)
  })

  it('keeps union cardinality, property removal, new required fields, and value types strict', () => {
    const first = [{ name: 'a', type: 2, optional: false }]
    const second = [{ name: 'b', type: 3, optional: false }]
    const third = [{ name: 'c', type: 4, optional: false }]
    const before = unionBody([first, second])
    const variants = [
      unionBody([first, second, third]),
      unionBody([first]),
      unionBody([first, third]),
      unionBody([[...first, { name: 'x', type: 4, optional: false }], [...second, { name: 'x', type: 4, optional: true }]]),
      unionBody([[{ name: 'a', type: 3, optional: true }], [{ name: 'b', type: 3, optional: true }]]),
    ]
    for (const after of variants) expect(classifyPersistenceChange(before, after).some(change => change.requiresVersionBump)).toBe(true)
  })

  it('checks all recursive union arms without retaining provisional successes between candidates', () => {
    const next = { name: 'next', type: 1, optional: true }
    const first = [{ name: 'a', type: 2, optional: false }, next]
    const second = [{ name: 'b', type: 3, optional: false }, next]
    const extra = { name: 'x', type: 4, optional: true }
    const before = unionBody([first, second])
    const additive = unionBody([[...first, extra], [...second, extra]])
    expect(classifyPersistenceChange(before, additive).every(change => !change.requiresVersionBump)).toBe(true)
    const invalid = unionBody([[...first, extra], [{ name: 'b', type: 2, optional: false }, next, extra]])
    expect(classifyPersistenceChange(before, invalid).some(change => change.requiresVersionBump)).toBe(true)
    expect(classifyPersistenceChange(invalid, before).some(change => change.requiresVersionBump)).toBe(true)
  })

  it('preserves body scope through arrays and tuples and rejects a simultaneous value-type change', () => {
    function wrapped(optional: boolean, primitive: 'string' | 'number' = 'string'): PersistenceRoot {
      const nodes: SchemaNode[] = [
        { kind: 'object', indices: [], properties: [{ name: 'data', type: 1, optional: false }] },
        { kind: 'tuple', elements: [{ type: 2, optional: false, rest: false }] },
        { kind: 'array', element: 3 },
        { kind: 'object', indices: [], properties: [{ name: 'value', type: 4, optional }] },
        { kind: 'primitive', type: primitive },
      ]
      const schema = canonicalizeSchema(nodes, 0)
      return { ...typeRoot('event:example/value', {}), schema, digest: schemaDigest(schema) }
    }
    expect(classifyPersistenceChange(wrapped(false), wrapped(true)).every(change => !change.requiresVersionBump)).toBe(true)
    expect(classifyPersistenceChange(wrapped(false), wrapped(true, 'number')).some(change => change.requiresVersionBump)).toBe(true)
  })

  it('keeps optional header/envelope properties and surface event additions strict', () => {
    for (const key of ['SessionHeader', 'JsonlHeaderLine', 'SessionEventEnvelope']) {
      expect(classifyPersistenceChange(typeRoot(key, {}), typeRoot(key, { 'metadata?': 'string' }))[0]?.requiresVersionBump).toBe(true)
    }
    const added = typeRoot('event:example/added', { value: 'string' })
    expect(classifyPersistenceChange(null, added)[0]?.requiresVersionBump).toBe(false)
    expect(classifyPersistenceChange(null, { ...added, surface: true })[0]?.requiresVersionBump).toBe(true)
    expect(classifyPersistenceChange(added, null)[0]?.requiresVersionBump).toBe(true)
  })
})

describe('persistence history verification', () => {
  it('accepts a baseline and a successive optional addition without comparing the historical schema to current', () => {
    const before = inventory()
    const after = inventory({ value: 'string', 'label?': 'string' })
    const history = validatePersistenceHistory([entry(BASE_ID, before, null, true), entry(NEXT_ID, onlyEvent(after), BASE_ID)])
    expect(history.tips.get('event:example/value')?.root?.digest).toBe(after.roots[2]?.digest)
    expect(history.tips.get('SessionHeader')?.id).toBe(BASE_ID)
  })

  it('rejects missing predecessors, forks, cycles, duplicates, and missing baseline', () => {
    const base = entry(BASE_ID, inventory(), null, true)
    const next = entry(NEXT_ID, onlyEvent(inventory({ value: 'string', 'label?': 'string' })), BASE_ID)
    expect(() => validatePersistenceHistory([next])).toThrow('exactly one baseline')
    expect(() => validatePersistenceHistory([base, entry(NEXT_ID, next.snapshot, '2026-09-11-missing')])).toThrow('missing predecessor')
    expect(() => validatePersistenceHistory([base, next, entry('2026-09-11-fork', next.snapshot, BASE_ID)])).toThrow('forked')
    expect(() => validatePersistenceHistory([base, base])).toThrow('exactly one baseline')
    const cycle = entry('2026-09-11-cycle', { ...next.snapshot, roots: [typeRoot('event:cycle/event', {})] }, '2026-09-11-cycle')
    expect(() => validatePersistenceHistory([base, cycle])).toThrow('cycle')
  })

  it('binds breaking decisions to the same record header version transition', () => {
    const base = entry(BASE_ID, inventory(), null, true)
    const breaking = inventory({ value: 'number' }, 4)
    expect(() => validatePersistenceHistory([base, entry(NEXT_ID, onlyEvent(breaking), BASE_ID)])).toThrow('requires a format version bump')
    expect(() => validatePersistenceHistory([base, entry(NEXT_ID, onlyEvent(breaking), BASE_ID, false, 'version-bump')])).toThrow("this record's own")
    const touched = { ...breaking, roots: breaking.roots.filter(root => root.key === 'SessionHeader' || root.kind === 'event') }
    expect(validatePersistenceHistory([base, entry(NEXT_ID, touched, BASE_ID, false, 'version-bump')]).tips.get('SessionHeader')?.id).toBe(NEXT_ID)
    const later = entry('2026-09-11-later', onlyEvent(inventory({ value: 'boolean' }, 4)), NEXT_ID, false, 'version-bump')
    expect(() => validatePersistenceHistory([base, entry(NEXT_ID, touched, BASE_ID, false, 'version-bump'), later])).toThrow("this record's own")
  })

  it('retains deletion tombstones and requires re-added roots to continue them', () => {
    const base = entry(BASE_ID, inventory(), null, true)
    const after = inventory({}, 4)
    const header = after.roots[0]!
    const record: PersistenceChangeRecord = { schemaVersion: 1, id: NEXT_ID, baseline: false, changes: [
      { root: 'SessionHeader', previous: BASE_ID, after: header.digest, decision: 'version-bump' },
      { root: 'event:example/value', previous: BASE_ID, after: null, decision: 'version-bump' },
    ] }
    const deletion = { record, snapshot: { ...after, roots: [header] } }
    expect(validatePersistenceHistory([base, deletion]).tips.get('event:example/value')?.root).toBeNull()
    const restored = entry('2026-09-11-restore', onlyEvent(inventory()), NEXT_ID)
    expect(validatePersistenceHistory([base, deletion, restored]).tips.get('event:example/value')?.id).toBe(restored.record.id)
    expect(() => validatePersistenceHistory([base, deletion, entry('2026-09-11-restore', restored.snapshot, null)])).toThrow('forked')
  })

  it('rejects malformed references, unknown schema variants, digest tampering, and extra snapshot roots', () => {
    const schema = inventory()
    const malformed: { roots: readonly { schema: { nodes: readonly unknown[] }; digest: string }[] } = structuredClone(schema)
    malformed.roots[0]!.schema.nodes = [{ kind: 'array', element: 99 }]
    expect(() => parsePersistenceSnapshot(malformed)).toThrow('unknown schema node')
    malformed.roots[0]!.schema.nodes = [{ kind: 'future' }]
    expect(() => parsePersistenceSnapshot(malformed)).toThrow('unknown schema node kind')
    const tampered = structuredClone(schema)
    Object.assign(tampered.roots[0]!, { digest: '0'.repeat(64) })
    expect(() => parsePersistenceSnapshot(tampered)).toThrow('digest mismatch')
    expect(() => parsePersistenceSnapshot({ ...schema, formatVersion: 3 })).toThrow('normalization version')
    const next = entry(NEXT_ID, onlyEvent(inventory({ value: 'string', 'label?': 'string' })), BASE_ID)
    expect(() => validatePersistenceHistory([entry(BASE_ID, schema, null, true), { ...next, snapshot: inventory() }])).toThrow('snapshot roots')
  })
})

describe('persistence changes current-tree commands', () => {
  it('requires completed record prose, rejects stale generated output, and reports unacknowledged paths', () => {
    const root = fixture()
    const before = inventory()
    runPersistenceChanges(['--baseline', BASE_ID], root, () => before)
    expect(() => loadPersistenceHistory(root)).toThrow('complete compatibility')
    finishDocuments(root, BASE_ID)
    rmSync(join(root, 'docs/persistence-schema.json'))
    expect(() => verifyPersistenceChanges(root, before)).toThrow('is missing')
    commitCurrent(root, before)
    const after = inventory({ value: 'string', 'label?': 'string' })
    expect(() => verifyPersistenceChanges(root, after)).toThrow('is stale')
    commitCurrent(root, after)
    expect(() => verifyPersistenceChanges(root, after)).toThrow('event:example/value.data.label: optional property added (same-version allowed)')
    runPersistenceChanges(['--record', NEXT_ID, '--decision', 'same-version'], root, () => after)
    finishDocuments(root, NEXT_ID)
    expect(runPersistenceChanges([], root, () => after)).toContain('4 roots match 2 history records')
    expect(() => runPersistenceChanges(['--baseline', '2026-09-11-reset'], root, () => after)).toThrow('cannot reset history')
    expect(() => runPersistenceChanges(['--record', '2026-09-11-empty', '--decision', 'same-version'], root, () => after)).toThrow('no persistence type changes')
  })

  it('rejects changed bilingual machine declarations and unreferenced snapshots', () => {
    const root = fixture()
    baseline(root)
    const chinese = join(root, 'docs/persistence-changes', `${BASE_ID}.zh.md`)
    const original = readFileSync(chinese, 'utf8')
    writeFileSync(chinese, original.replace('baseline: true', 'baseline: false'))
    expect(() => loadPersistenceHistory(root)).toThrow('bilingual machine records differ')
    writeFileSync(chinese, original)
    writeFileSync(join(root, 'docs/persistence-changes/2026-09-11-orphan.schema.json'), '{}\n')
    expect(() => loadPersistenceHistory(root)).toThrow('unreferenced')
  })

  it('excludes nested historical format documents and schemas from acknowledgements', () => {
    const root = fixture()
    baseline(root)
    const directory = join(root, 'docs/persistence-changes/historical-formats')
    mkdirSync(directory)
    writeFileSync(join(directory, 'v0.md'), '---\nkind: persistence-format\n---\n')
    writeFileSync(join(directory, 'v0.schema.json'), '{}\n')
    expect(loadPersistenceHistory(root).entries.map(entry => entry.record.id)).toEqual([BASE_ID])
  })

  it.each([
    ['optional field', inventory({ value: 'string', 'label?': 'string' })],
    ['required-to-optional field', inventory({ 'value?': 'string' })],
    ['ordinary event addition', { ...inventory(), roots: [...inventory().roots, typeRoot('event:example/added', { count: 'number' })] }],
  ] as const)('infers same-version for %s', (_name, after) => {
    const root = fixture()
    baseline(root)
    runPersistenceChanges(['--record', NEXT_ID, '--prose', proseFile(root)], root, () => after)
    const changes = loadPersistenceHistory(root).entries.find(entry => entry.record.id === NEXT_ID)?.record.changes
    expect(changes?.length).toBeGreaterThan(0)
    expect(changes?.every(change => change.decision === 'same-version')).toBe(true)
    verifyPersistenceChanges(root, after)
  })

  it('infers a version bump when the source includes its own increasing header version', () => {
    const root = fixture()
    baseline(root)
    const after = inventory({ value: 'number' }, 4)
    runPersistenceChanges(['--record', NEXT_ID, '--prose', proseFile(root)], root, () => after)
    const changes = loadPersistenceHistory(root).entries.find(entry => entry.record.id === NEXT_ID)?.record.changes
    expect(changes?.map(change => change.root).sort()).toEqual(['SessionHeader', 'event:example/value'])
    expect(changes?.every(change => change.decision === 'version-bump')).toBe(true)
    verifyPersistenceChanges(root, after)
  })

  it('rejects inferred bumps without a header transition and explicit incorrect assertions before writing', () => {
    const root = fixture()
    baseline(root)
    const prose = proseFile(root)
    const directory = join(root, 'docs/persistence-changes')
    const files = readdirSync(directory).sort()
    const inventoryPath = join(root, 'docs/persistence-schema.json')
    const before = readFileSync(inventoryPath, 'utf8')
    for (const [args, code] of [
      [[], 'version-transition-required'],
      [['--decision', 'same-version'], 'version-bump-required'],
    ] as const) {
      const result = jsonResult(runPersistenceChanges(['--record', NEXT_ID, '--prose', prose, '--json', ...args], root,
        () => inventory({ value: 'number' })))
      expect(result).toMatchObject({ ok: false, code, files: [], changes: [expect.objectContaining({ requiresVersionBump: true })] })
      expect(readFileSync(inventoryPath, 'utf8')).toBe(before)
      expect(readdirSync(directory).sort()).toEqual(files)
    }
  })

  it('authors a complete pair from explicit prose and reports source changes even when generated artifacts are stale', () => {
    const root = fixture()
    baseline(root)
    const after = inventory({ value: 'string', 'label?': 'string' })
    const pending = jsonResult(runPersistenceChanges(['--check', '--json'], root, () => after))
    expect(pending).toMatchObject({ ok: false, operation: 'check', code: 'stale-artifacts',
      roots: [{ root: 'event:example/value', kind: 'event', before: inventory().roots[2]?.digest, after: after.roots[2]?.digest }], changes: [
        { root: 'event:example/value', path: 'event:example/value.data.label', kind: 'optional-property-added', requiresVersionBump: false },
      ] })
    const written = jsonResult(runPersistenceChanges(['--record', NEXT_ID, '--decision', 'same-version', '--prose', proseFile(root), '--json'], root, () => after))
    expect(written).toMatchObject({ ok: true, operation: 'record', recordId: NEXT_ID })
    expect(written.files).toEqual([
      'docs/persistence-schema.json', `docs/persistence-changes/${NEXT_ID}.md`, `docs/persistence-changes/${NEXT_ID}.zh.md`,
      `docs/persistence-changes/${NEXT_ID}.i18n.yaml`, `docs/persistence-changes/${NEXT_ID}.schema.json`,
    ])
    expect(written).toMatchObject({ roots: [{ root: 'event:example/value', kind: 'event',
      before: inventory().roots[2]?.digest, after: after.roots[2]?.digest }] })
    expect(readFileSync(join(root, `docs/persistence-changes/${NEXT_ID}.md`), 'utf8')).toContain(AUTHORED_PROSE.en.compatibility)
    expect(jsonResult(runPersistenceChanges(['--check', '--json'], root, () => after)).ok).toBe(true)
  })

  it('refreshes only a terminal acknowledgement while preserving its authored prose and predecessor', () => {
    const root = fixture()
    baseline(root)
    const after = inventory({ value: 'string', 'label?': 'string' })
    const prose = proseFile(root)
    runPersistenceChanges(['--record', NEXT_ID, '--decision', 'same-version', '--prose', prose], root, () => after)
    const path = join(root, `docs/persistence-changes/${NEXT_ID}.md`)
    const beforeText = readFileSync(path, 'utf8')
    const refreshed = inventory({ value: 'string', 'label?': 'string', 'extra?': 'number' })
    runPersistenceChanges(['--update', NEXT_ID], root, () => refreshed)
    const stripRecord = (value: string): string => value.replace(/```yaml persistence-change[\s\S]*?```/u, '')
    expect(stripRecord(readFileSync(path, 'utf8'))).toBe(stripRecord(beforeText))
    expect(loadPersistenceHistory(root).tips.get('event:example/value')?.id).toBe(NEXT_ID)
    expect(loadPersistenceHistory(root).entries.find(entry => entry.record.id === NEXT_ID)?.record.changes[0]?.previous).toBe(BASE_ID)
    expect(jsonResult(runPersistenceChanges(['--check', '--json'], root, () => refreshed)).ok).toBe(true)
    const final = inventory({ value: 'string', 'label?': 'string', 'extra?': 'number', 'last?': 'boolean' })
    runPersistenceChanges(['--record', '2026-09-11-successor', '--decision', 'same-version', '--prose', prose], root, () => final)
    expect(() => runPersistenceChanges(['--update', NEXT_ID, '--decision', 'same-version'], root, () => final)).toThrow('with successors')
    expect(() => runPersistenceChanges(['--update', BASE_ID, '--decision', 'same-version'], root, () => final)).toThrow('cannot update the persistence baseline')
  })

  it('completes a scaffold through update and rejects invalid prose or decisions before changing files', () => {
    const root = fixture()
    baseline(root)
    const after = inventory({ value: 'string', 'label?': 'string' })
    runPersistenceChanges(['--record', NEXT_ID, '--decision', 'same-version'], root, () => after)
    const prose = proseFile(root)
    runPersistenceChanges(['--update', NEXT_ID, '--decision', 'same-version', '--prose', prose], root, () => after)
    expect(runPersistenceChanges(['--check'], root, () => after)).toContain('roots match')
    expect(readFileSync(join(root, `docs/persistence-changes/${NEXT_ID}.md`), 'utf8')).not.toContain('TODO:')
    const pairedPaths = ['.md', '.zh.md', '.i18n.yaml'].map(suffix => join(root, `docs/persistence-changes/${NEXT_ID}${suffix}`))
    const completed = pairedPaths.map(path => readFileSync(path, 'utf8'))
    runPersistenceChanges(['--update', NEXT_ID, '--decision', 'same-version', '--prose', prose], root, () => after)
    expect(pairedPaths.map(path => readFileSync(path, 'utf8'))).toEqual(completed)
    const path = join(root, `docs/persistence-changes/${NEXT_ID}.md`)
    const before = readFileSync(path, 'utf8')
    const invalid = inventory({ value: 'number' })
    const result = jsonResult(runPersistenceChanges(['--update', NEXT_ID, '--decision', 'same-version', '--json'], root, () => invalid))
    expect(result).toMatchObject({ ok: false, code: 'version-bump-required', changes: [expect.objectContaining({ kind: 'type-changed', requiresVersionBump: true })] })
    expect(readFileSync(path, 'utf8')).toBe(before)
    for (const value of [
      { ...AUTHORED_PROSE, extra: 'unsupported' },
      { ...AUTHORED_PROSE, en: { ...AUTHORED_PROSE.en, compatibility: '   ' } },
      { ...AUTHORED_PROSE, zh: { ...AUTHORED_PROSE.zh, verification: 'TODO: record validation evidence.' } },
      { ...AUTHORED_PROSE, zh: { ...AUTHORED_PROSE.zh, verification: '```text\nUnpaired code.\n```' } },
    ]) {
      writeFileSync(prose, JSON.stringify(value))
      expect(() => runPersistenceChanges(['--update', NEXT_ID, '--decision', 'same-version', '--prose', prose], root, () => after)).toThrow()
      expect(readFileSync(path, 'utf8')).toBe(before)
    }
  })

  // Six real CLI processes and TypeScript extraction share the Windows coverage test budget.
  it('executes the real CLI against a source-only temporary checkout without Git history', { timeout: 90_000 }, () => {
    const root = fixture()
    const physical = join(root, 'packages/session/session-persistence-jsonl/src')
    mkdirSync(physical, { recursive: true })
    writeFileSync(join(physical, 'format.ts'), "interface HeaderLine { type: 'session'; version: number; id: string; delegationDepth: number }; export {}\n")
    const session = join(root, 'packages/core/session/src')
    mkdirSync(session, { recursive: true })
    writeFileSync(join(session, '../package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-session' }))
    writeFileSync(join(root, 'tsconfig.host.json'), JSON.stringify({ compilerOptions: {
      target: 'ESNext', module: 'ESNext', moduleResolution: 'Bundler', types: [], skipLibCheck: true,
      paths: { '@deepseek-ai/dsh-session/types': ['./packages/core/session/src/types.ts'] },
    } }))
    const source = [
      '/** Stored header. */', 'export interface SessionHeader { version: 3; id: string }',
      '/** Stored event payloads. */', 'export interface SessionEventMap {', '/** Saved value. */',
      "'example/value': { value: string }", '}', '/** Surface event names. */', "export type SurfaceEventType = 'example/value'",
      '/** Persisted event names. */', 'export type SessionEventType = keyof SessionEventMap',
      '/** Surface placement. */', "export type SurfaceOp = 'append'", '/** Persisted event. */',
      'export type SessionEvent<K extends keyof SessionEventMap = keyof SessionEventMap> =',
      '  { [P in K]: { type: P; seq: number; data: SessionEventMap[P]; surfaceOp: SurfaceOp } }[K]', '',
    ].join('\n')
    writeFileSync(join(session, 'types.ts'), source)
    const script = resolve(import.meta.dirname, 'persistence-changes.ts')
    const cli = (...args: string[]): ReturnType<typeof spawnSync> => spawnSync(process.execPath, ['--import', import.meta.resolve('tsx/esm'), script, '--root', root, ...args], {
      cwd: root, encoding: 'utf8', timeout: 120_000,
    })
    const prose = proseFile(root)
    const initialized = cli('--baseline', BASE_ID, '--prose', prose)
    expect(initialized.error).toBeUndefined()
    expect(initialized.signal).toBeNull()
    expect(initialized.status, String(initialized.stderr)).toBe(0)
    const accepted = cli('--check')
    expect(accepted.error).toBeUndefined()
    expect(accepted.signal).toBeNull()
    expect(accepted.status, String(accepted.stderr)).toBe(0)
    const optional = source.replace('value: string', 'value: string; label?: string')
    writeFileSync(join(session, 'types.ts'), optional)
    const authored = cli('--record', NEXT_ID, '--prose', prose, '--json')
    expect(authored.error).toBeUndefined()
    expect(authored.signal).toBeNull()
    expect(authored.status, String(authored.stderr)).toBe(0)
    const authoredResult: unknown = JSON.parse(String(authored.stdout))
    expect(authoredResult).toMatchObject({ ok: true, operation: 'record' })
    const beforeUpdate = readFileSync(join(root, `docs/persistence-changes/${NEXT_ID}.md`), 'utf8')
    writeFileSync(join(session, 'types.ts'), optional.replace('label?: string', 'label?: string; extra?: number'))
    const updated = cli('--update', NEXT_ID, '--json')
    expect(updated.error).toBeUndefined()
    expect(updated.signal).toBeNull()
    expect(updated.status, String(updated.stderr)).toBe(0)
    const updatedResult: unknown = JSON.parse(String(updated.stdout))
    expect(updatedResult).toMatchObject({ ok: true, operation: 'update' })
    expect(readFileSync(join(root, `docs/persistence-changes/${NEXT_ID}.md`), 'utf8').replace(/```yaml persistence-change[\s\S]*?```/u, ''))
      .toBe(beforeUpdate.replace(/```yaml persistence-change[\s\S]*?```/u, ''))
    const generated = extractPersistenceSchema(root)
    for (const file of persistenceCatalogArtifacts(root, generated)) expect(readFileSync(join(root, file.path), 'utf8')).toBe(file.content)
    verifyPersistenceChanges(root, generated)
    writeFileSync(join(session, 'types.ts'), optional.replace('label?: string', 'label?: string; extra?: number').replace('value: string', 'value: number'))
    commitCurrent(root, extractPersistenceSchema(root))
    const rejected = cli('--check')
    expect(rejected.error).toBeUndefined()
    expect(rejected.signal).toBeNull()
    expect(rejected.status).toBe(1)
    expect(String(rejected.stderr)).toContain('version-bump required')
    const structured = cli('--check', '--json')
    expect(structured.error).toBeUndefined()
    expect(structured.signal).toBeNull()
    expect(structured.status).toBe(1)
    const structuredResult: unknown = JSON.parse(String(structured.stdout))
    expect(structuredResult).toMatchObject({
      ok: false, code: 'unacknowledged-changes', changes: [expect.objectContaining({ kind: 'type-changed', requiresVersionBump: true })],
    })
  })
})

interface SourceAlternative {
  readonly kind: string
  readonly value?: 'string' | 'number'
  readonly extra?: 'required' | 'optional'
}

function attributedRoot(
  alternatives: readonly SourceAlternative[],
  options: { policy?: SourceCompatibility | null; role?: 'user' | 'developer'; extra?: boolean } = {},
): PersistenceRoot {
  const role = options.role ?? 'user'
  const policy: SourceCompatibility | undefined = options.policy === null ? undefined : options.policy ?? {
    version: 1, policy: 'session-source-attribution', binding: `session.${role}-message.source`,
    discriminator: 'kind', unknownKinds: 'preserve', attributionKinds: [],
  }
  const nodes: SchemaNode[] = [
    { kind: 'object', indices: [], properties: [{ name: 'type', type: 2, optional: false }, { name: 'data', type: 1, optional: false }] },
    { kind: 'object', indices: [], properties: [
      { name: 'role', type: 4, optional: false }, { name: 'source', type: 3, optional: false, ...(policy === undefined ? {} : { compatibility: policy }) },
      ...(options.extra ? [{ name: 'unrelated', type: 5, optional: false }] : []),
    ] },
    { kind: 'literal', value: 'example/source' },
    { kind: 'primitive', type: 'never' },
    { kind: 'literal', value: role },
    { kind: 'primitive', type: 'string' },
    { kind: 'primitive', type: 'number' },
  ]
  const types = alternatives.map((alternative) => {
    const index = nodes.length
    nodes.push({ kind: 'object', indices: [], properties: [
      { name: 'kind', type: index + 1, optional: false },
      ...(alternative.value === undefined ? [] : [{ name: 'value', type: alternative.value === 'string' ? 5 : 6, optional: false }]),
      ...(alternative.extra === undefined ? [] : [{ name: 'extra', type: 5, optional: alternative.extra === 'optional' }]),
    ] }, { kind: 'literal', value: alternative.kind })
    return index
  })
  nodes[3] = { kind: 'union', types }
  const schema = canonicalizeSchema(nodes, 0)
  return { key: 'event:example/source', kind: 'event', event: 'example/source', surface: false, schema, digest: schemaDigest(schema) }
}

function attributionPolicy(kinds: readonly string[], role: 'user' | 'developer' = 'user'): SourceCompatibility {
  return { version: 1, policy: 'session-source-attribution', binding: `session.${role}-message.source`,
    discriminator: 'kind', unknownKinds: 'preserve', attributionKinds: kinds }
}

const EXISTING_SOURCE: SourceAlternative = { kind: 'semantic', value: 'string' }
const NEW_SOURCE: SourceAlternative = { kind: 'new-attribution', value: 'number' }

describe('recorded source compatibility policy', () => {
  it.each(['user', 'developer'] as const)('accepts a qualified new %s source and records its changed digest', (role) => {
    const before = attributedRoot([EXISTING_SOURCE], { role })
    const after = attributedRoot([EXISTING_SOURCE, NEW_SOURCE], { role, policy: attributionPolicy([NEW_SOURCE.kind], role) })
    expect(after.digest).not.toBe(before.digest)
    expect(classifyPersistenceChange(before, after)).toEqual([expect.objectContaining({ kind: 'attribution-kind-added', requiresVersionBump: false })])
    const snapshot: PersistenceSchemaInventory = { formatVersion: 2, roots: [after], types: [] }
    expect(parsePersistenceSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot)
  })

  it('allows ordinary optional fields in an existing group alongside a qualified addition', () => {
    const before = attributedRoot([EXISTING_SOURCE])
    const after = attributedRoot([{ ...EXISTING_SOURCE, extra: 'optional' }, NEW_SOURCE], { policy: attributionPolicy([NEW_SOURCE.kind]) })
    const changes = classifyPersistenceChange(before, after)
    expect(changes.map(change => change.kind).sort()).toEqual(['attribution-kind-added', 'optional-property-added'])
    expect(changes.every(change => !change.requiresVersionBump)).toBe(true)
  })

  it.each([
    ['unmarked addition', [EXISTING_SOURCE, NEW_SOURCE], { policy: attributionPolicy([]) }],
    ['required existing field', [{ ...EXISTING_SOURCE, extra: 'required' }, NEW_SOURCE], { policy: attributionPolicy([NEW_SOURCE.kind]) }],
    ['changed existing field', [{ ...EXISTING_SOURCE, value: 'number' }, NEW_SOURCE], { policy: attributionPolicy([NEW_SOURCE.kind]) }],
    ['removed existing kind', [NEW_SOURCE], { policy: attributionPolicy([NEW_SOURCE.kind]) }],
    ['renamed existing kind', [{ ...EXISTING_SOURCE, kind: 'renamed' }, NEW_SOURCE], { policy: attributionPolicy([NEW_SOURCE.kind]) }],
    ['unrelated required payload', [EXISTING_SOURCE, NEW_SOURCE], { policy: attributionPolicy([NEW_SOURCE.kind]), extra: true }],
    ['removed promise', [EXISTING_SOURCE, NEW_SOURCE], { policy: null }],
  ] as const)('keeps %s breaking despite qualified additions', (_name, sources, options) => {
    const changes = classifyPersistenceChange(attributedRoot([EXISTING_SOURCE]), attributedRoot(sources, options))
    expect(changes.some(change => change.requiresVersionBump)).toBe(true)
  })

  it('keeps variants within an existing wire-kind group strict', () => {
    const before = attributedRoot([EXISTING_SOURCE])
    const after = attributedRoot([EXISTING_SOURCE, { ...EXISTING_SOURCE, value: 'number' }, NEW_SOURCE], { policy: attributionPolicy([NEW_SOURCE.kind]) })
    expect(classifyPersistenceChange(before, after)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'union-variants-changed', requiresVersionBump: true }),
      expect.objectContaining({ kind: 'attribution-kind-added', requiresVersionBump: false }),
    ]))
  })

  it('treats qualification changes for an existing kind as policy changes', () => {
    const before = attributedRoot([EXISTING_SOURCE])
    const after = attributedRoot([EXISTING_SOURCE], { policy: attributionPolicy([EXISTING_SOURCE.kind]) })
    expect(classifyPersistenceChange(before, after)).toEqual([expect.objectContaining({ kind: 'source-policy-changed', requiresVersionBump: true })])
  })

  it('keeps legacy source transitions strict and never infers promises from the successor', () => {
    const before = attributedRoot([EXISTING_SOURCE], { policy: null })
    const after = attributedRoot([EXISTING_SOURCE, NEW_SOURCE], { policy: attributionPolicy([NEW_SOURCE.kind]) })
    expect(classifyPersistenceChange(before, after).some(change => change.requiresVersionBump)).toBe(true)
    const legacyAfter = attributedRoot([EXISTING_SOURCE, NEW_SOURCE], { policy: null })
    const snapshots = [before, legacyAfter].map(root => ({ formatVersion: 1 as const, roots: [root], types: [] }))
    expect(() => validatePersistenceHistory([
      entry(BASE_ID, snapshots[0]!, null, true), entry(NEXT_ID, snapshots[1]!, BASE_ID),
    ])).toThrow('requires a format version bump')
  })

  it('validates policy-bearing history without source names or type records', () => {
    const before: PersistenceSchemaInventory = { formatVersion: 2, types: [],
      roots: [...inventory().roots.filter(root => root.kind !== 'event'), attributedRoot([EXISTING_SOURCE])],
    }
    const after: PersistenceSchemaInventory = { formatVersion: 2, types: [],
      roots: [attributedRoot([EXISTING_SOURCE, NEW_SOURCE], { policy: attributionPolicy([NEW_SOURCE.kind]) })],
    }
    expect(validatePersistenceHistory([entry(BASE_ID, before, null, true), entry(NEXT_ID, after, BASE_ID)]).tips.get('event:example/source')?.root).toEqual(after.roots[0])
  })

  it.each(['auto-review', 'compact-basic', 'ptc-mode'])('rejects saved qualification of reserved producer kind %s', (kind) => {
    const root = attributedRoot([EXISTING_SOURCE, { kind }], { policy: attributionPolicy([kind]) })
    const snapshot: PersistenceSchemaInventory = { formatVersion: 2, roots: [root], types: [] }
    expect(() => parsePersistenceSnapshot(snapshot)).toThrow('invalid source compatibility')
  })

  it('rejects old-format policy fields, policy tampering, unsupported promises and invalid bindings', () => {
    const root = attributedRoot([EXISTING_SOURCE])
    const snapshot: PersistenceSchemaInventory = { formatVersion: 2, roots: [root], types: [] }
    expect(() => parsePersistenceSnapshot({ ...snapshot, formatVersion: 1 })).toThrow('unknown field compatibility')
    for (const patch of [{ version: 2 }, { policy: 'arbitrary' }, { discriminator: 'type' }, { unknownKinds: 'discard' }]) {
      const tampered = JSON.parse(JSON.stringify(snapshot)) as PersistenceSchemaInventory
      const property = tampered.roots[0]!.schema.nodes.flatMap(node => node.kind === 'object' ? node.properties : []).find(property => property.compatibility !== undefined)!
      Object.assign(property.compatibility!, patch)
      expect(() => parsePersistenceSnapshot(tampered)).toThrow('unsupported source compatibility')
    }
    const wrongRole = attributedRoot([EXISTING_SOURCE], { policy: attributionPolicy([], 'developer') })
    expect(() => parsePersistenceSnapshot({ ...snapshot, roots: [wrongRole] })).toThrow('invalid source compatibility')
    const changedQualification = attributedRoot([EXISTING_SOURCE], { policy: attributionPolicy([EXISTING_SOURCE.kind]) })
    expect(() => parsePersistenceSnapshot({ ...snapshot, roots: [{ ...changedQualification, digest: root.digest }] })).toThrow('digest mismatch')
    const unknownKind = attributedRoot([EXISTING_SOURCE], { policy: attributionPolicy(['absent']) })
    expect(() => parsePersistenceSnapshot({ ...snapshot, roots: [unknownKind] })).toThrow('invalid source compatibility')
  })
})
