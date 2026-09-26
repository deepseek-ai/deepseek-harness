/** Accepted declared Session baselines and immutable acknowledgements, independent of publication evidence. */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { JSON_SCHEMA, load } from 'js-yaml'
import type { PersistenceHistory, PersistenceHistoryEntry } from './persistence-changes.ts'
import type { PersistenceRoot, PersistenceSchemaInventory } from './persistence-schema-model.ts'

const DIRECTORY = 'docs/persistence-changes/finalized'
const DIGEST = /^[a-f0-9]{64}$/u
const RECORD_ID = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/u

type RootIdentity = Pick<PersistenceRoot, 'kind' | 'digest' | 'event' | 'surface'>

/** Complete accepted baseline and semantic identities of its acknowledged history. */
export interface PersistenceFinalizationCheckpoint {
  readonly schemaVersion: 1
  readonly sessionFormatVersion: number
  readonly roots: Readonly<Record<string, RootIdentity>>
  readonly acceptedRecords: Readonly<Record<string, string>>
}

/** Latest accepted baseline schemas and the record ids locked by retained checkpoints. */
export interface PersistenceFinalization {
  readonly version: number
  readonly roots: ReadonlyMap<string, PersistenceRoot>
  readonly acceptedRecords: ReadonlySet<string>
}

function identity(root: PersistenceRoot): RootIdentity {
  return { kind: root.kind, digest: root.digest,
    ...(root.event === undefined ? {} : { event: root.event }),
    ...(root.surface === undefined ? {} : { surface: root.surface }) }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function rootMap(roots: readonly PersistenceRoot[]): Record<string, RootIdentity> {
  return Object.fromEntries([...roots].sort((a, b) => compare(a.key, b.key)).map(root => [root.key, identity(root)]))
}

function recordDigest(entry: PersistenceHistoryEntry): string {
  const record = entry.record
  const semantic = { record: { schemaVersion: record.schemaVersion, id: record.id, baseline: record.baseline,
    changes: [...record.changes].sort((a, b) => compare(a.root, b.root)).map(change => ({
      root: change.root, previous: change.previous, after: change.after, decision: change.decision,
    })) }, snapshot: { formatVersion: entry.snapshot.formatVersion,
    roots: [...entry.snapshot.roots].sort((a, b) => compare(a.key, b.key)).map(root => ({
      key: root.key, ...identity(root), schema: root.schema,
    })) } }
  return createHash('sha256').update('dsh-persistence-finalization-record-v1\n').update(JSON.stringify(semantic)).digest('hex')
}

function writerVersion(roots: readonly PersistenceRoot[]): number {
  const schema = roots.find(root => root.key === 'SessionHeader')?.schema
  const node = schema?.nodes[0]
  const property = node?.kind === 'object' ? node.properties.find(property => property.name === 'version') : undefined
  const version = property === undefined ? undefined : schema?.nodes[property.type]
  if (version?.kind !== 'literal' || typeof version.value !== 'number' || !Number.isSafeInteger(version.value) || version.value < 0) {
    throw new Error('persistence finalization requires a literal non-negative SessionHeader.version')
  }
  return version.value
}

/**
 * Capture a verified history without copying its self-contained schemas or recording a publication claim.
 * @param history - validated acknowledgement history matching the current inventory.
 * @param current - validated current-source inventory.
 * @returns checkpoint data for a new version-named file; existing checkpoints must be retained.
 */
export function createPersistenceFinalizationCheckpoint(
  history: PersistenceHistory, current: PersistenceSchemaInventory,
): PersistenceFinalizationCheckpoint {
  const recorded = [...history.tips.values()].flatMap(tip => tip.root === null ? [] : [tip.root])
  if (JSON.stringify(rootMap(recorded)) !== JSON.stringify(rootMap(current.roots))) {
    throw new Error('persistence finalization requires current schemas to match acknowledged history')
  }
  return { schemaVersion: 1, sessionFormatVersion: writerVersion(current.roots), roots: rootMap(current.roots),
    acceptedRecords: Object.fromEntries([...history.entries].sort((a, b) => compare(a.record.id, b.record.id))
      .map(entry => [entry.record.id, recordDigest(entry)])) }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: expected an object`)
  return value as Record<string, unknown>
}

function status(root: string, path: string): number | undefined {
  if (!existsSync(join(root, path))) return undefined
  const source = readFileSync(join(root, path), 'utf8').replaceAll('\r\n', '\n')
  const openings = [...source.matchAll(/^```yaml session-format-finalization[ \t]*$/gmu)]
  if (openings.length === 0) return undefined
  const blocks = [...source.matchAll(/^```yaml session-format-finalization[ \t]*\n([\s\S]*?)^```[ \t]*$/gmu)]
  if (openings.length !== 1 || blocks.length !== 1) throw new Error(`${path}: expected one closed session-format-finalization record`)
  const value = object(load((blocks[0] as RegExpMatchArray)[1] as string, { schema: JSON_SCHEMA }), path)
  const version = value.latestFinalizedVersion
  if (Object.keys(value).join(',') !== 'latestFinalizedVersion'
    || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    throw new Error(`${path}: expected only a non-negative latestFinalizedVersion`)
  }
  return version
}

/**
 * Validate retained checkpoints against accepted history and reconstruct the latest accepted baseline.
 * @param root - checkout or isolated fixture root.
 * @param history - parsed acknowledgement entries, including later successors.
 * @returns finalization state, or undefined for a checkout with neither status nor checkpoints.
 */
export function loadPersistenceFinalization(root: string, history: Pick<PersistenceHistory, 'entries'>): PersistenceFinalization | undefined {
  const directory = join(root, DIRECTORY)
  const files = existsSync(directory) ? readdirSync(directory).filter(file => file.endsWith('.json')).sort() : []
  const version = status(root, 'docs/session-format-status.md')
  const translated = status(root, 'docs/session-format-status.zh.md')
  if (version === undefined && translated === undefined && files.length === 0) return undefined
  if (version === undefined || translated !== version) throw new Error('persistence finalization status is missing or differs between languages')
  if (!files.includes(`v${version}.json`)) throw new Error(`missing persistence finalization checkpoint v${version}.json`)
  const entries = new Map(history.entries.map(entry => [entry.record.id, entry]))
  const acceptedRecords = new Set<string>()
  let latestRoots: Map<string, PersistenceRoot> | undefined
  for (const file of files) {
    const match = /^v(0|[1-9]\d*)\.json$/u.exec(file)
    const capturedVersion = match === null ? NaN : Number(match[1])
    if (!Number.isSafeInteger(capturedVersion) || capturedVersion > version) throw new Error(`unexpected persistence finalization checkpoint ${file}`)
    const checkpoint = object(JSON.parse(readFileSync(join(directory, file), 'utf8')), file)
    if (Object.keys(checkpoint).sort().join(',') !== 'acceptedRecords,roots,schemaVersion,sessionFormatVersion'
      || checkpoint.schemaVersion !== 1 || checkpoint.sessionFormatVersion !== capturedVersion) {
      throw new Error(`${file}: invalid persistence finalization checkpoint metadata`)
    }
    const locked = object(checkpoint.acceptedRecords, `${file} acceptedRecords`)
    const selected: PersistenceHistoryEntry[] = []
    for (const [id, expected] of Object.entries(locked)) {
      if (!RECORD_ID.test(id) || typeof expected !== 'string' || !DIGEST.test(expected)) throw new Error(`${file}: invalid accepted record ${id}`)
      const entry = entries.get(id)
      if (entry === undefined || recordDigest(entry) !== expected) throw new Error(`${file}: finalized acknowledgement ${id} was removed or changed`)
      selected.push(entry)
      acceptedRecords.add(id)
    }
    if (selected.length === 0 || !selected.some(entry => entry.record.baseline)) throw new Error(`${file}: accepted records must include the persistence baseline`)
    const predecessors = new Set<string>()
    for (const entry of selected) for (const change of entry.record.changes) {
      if (change.previous !== null) {
        if (!Object.hasOwn(locked, change.previous)) throw new Error(`${file}: accepted history omits predecessor ${change.previous}`)
        predecessors.add(JSON.stringify([change.previous, change.root]))
      }
    }
    const tips = new Map<string, PersistenceRoot>()
    for (const entry of selected) for (const change of entry.record.changes) {
      if (!predecessors.has(JSON.stringify([entry.record.id, change.root])) && change.after !== null) {
        const schema = entry.snapshot.roots.find(root => root.key === change.root)
        if (schema === undefined) throw new Error(`${file}: accepted history omits schema ${change.root}`)
        tips.set(change.root, schema)
      }
    }
    const expectedRoots = rootMap([...tips.values()])
    const declaredRoots = object(checkpoint.roots, `${file} roots`)
    if (Object.keys(declaredRoots).length !== tips.size || Object.entries(expectedRoots).some(([key, expected]) => {
      const actual = declaredRoots[key]
      if (actual === undefined) return true
      const value = object(actual, `${file} ${key}`)
      return Object.keys(value).sort().join(',') !== Object.keys(expected).sort().join(',')
        || Object.entries(expected).some(([field, expectedValue]) => value[field] !== expectedValue)
    })) throw new Error(`${file}: finalized roots do not match complete accepted history`)
    if (writerVersion([...tips.values()]) !== capturedVersion) throw new Error(`${file}: accepted SessionHeader.version does not match finalized version`)
    if (capturedVersion === version) latestRoots = tips
  }
  if (latestRoots === undefined) throw new Error(`missing finalized schemas for Session format ${version}`)
  return { version, roots: latestRoots, acceptedRecords }
}
