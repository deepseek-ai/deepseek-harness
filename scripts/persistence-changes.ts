/** Verify and acknowledge persistence type changes from current-tree schema history. */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { JSON_SCHEMA, load } from 'js-yaml'
import { canonicalizeSchema, schemaDigest } from './persistence-schema-model.ts'
import { matchingSourceCompatibility, sourceKindGroups, validSourceCompatibility } from './persistence-source-policy.ts'
import type { CanonicalSchema, PersistenceRoot, PersistenceSchemaInventory, SchemaNode, SchemaTupleElement } from './persistence-schema-model.ts'
import { extractPersistenceSchema } from './persistence-schema.ts'
import { persistenceCatalogArtifacts } from './gen-persistence-catalog.ts'
import { renderPersistencePair } from './persistence-artifacts.ts'
import { loadPersistenceFinalization } from './persistence-finalization.ts'
import type { PersistenceArtifact } from './persistence-artifacts.ts'

const HISTORY_DIRECTORY = 'docs/persistence-changes'
const CURRENT_SCHEMA = 'docs/persistence-schema.json'
const ID_PATTERN = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/u
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u
const EXPLANATION_PLACEHOLDER = 'TODO: explain this change.'
const EVIDENCE_PLACEHOLDER = 'TODO: record validation evidence.'

/** The author's acknowledgement of one mechanically classified transition. */
export type PersistenceDecision = 'same-version' | 'version-bump'

/** One root's successor; null after values preserve a deletion in its history. */
export interface PersistenceChange {
  readonly root: string
  readonly previous: string | null
  readonly after: string | null
  readonly decision: PersistenceDecision
}

/** A document's machine record, independent of its translated prose. */
export interface PersistenceChangeRecord {
  readonly schemaVersion: 1
  readonly id: string
  readonly baseline: boolean
  readonly changes: readonly PersistenceChange[]
}

/** A parsed acknowledgement and its self-contained after schemas. */
export interface PersistenceHistoryEntry {
  readonly record: PersistenceChangeRecord
  readonly snapshot: PersistenceSchemaInventory
}

/** One detected type change, with a path that reviewers can locate. */
export interface PersistenceTypeChange {
  readonly kind: PersistenceTypeChangeKind
  readonly path: string
  readonly description: string
  readonly requiresVersionBump: boolean
}

const CHANGE_DESCRIPTIONS = {
  'root-added': 'root added',
  'root-removed': 'root removed',
  'root-classification-changed': 'root classification changed',
  'type-changed': 'type changed',
  'property-removed': 'property removed',
  'property-made-optional': 'property made optional',
  'property-made-required': 'property made required',
  'optional-property-added': 'optional property added',
  'required-property-added': 'required property added',
  'index-signature-changed': 'index signature changed',
  'tuple-length-changed': 'tuple length changed',
  'tuple-element-cardinality-changed': 'tuple element cardinality changed',
  'payload-version-added': 'event payload version added',
  'union-variants-changed': 'union variants changed',
  'source-policy-changed': 'source compatibility policy changed',
  'attribution-kind-added': 'attribution-only source kind added',
} as const

/** Stable structural classification independent of diagnostic prose. */
export type PersistenceTypeChangeKind = keyof typeof CHANGE_DESCRIPTIONS

/** Author-supplied paragraphs used to complete one language of a change record. */
export interface PersistenceChangeProse {
  readonly summary: string
  readonly compatibility: string
  readonly verification: string
}

/** Explicit bilingual prose; the CLI supplies no compatibility or validation claims. */
export interface PersistenceChangeProsePair {
  readonly en: PersistenceChangeProse
  readonly zh: PersistenceChangeProse
}

interface ReportedChange extends PersistenceTypeChange {
  readonly root: string
}

interface RootTransition {
  readonly root: string
  readonly kind: PersistenceRoot['kind']
  readonly before: string | null
  readonly after: string | null
}

class PersistenceChangeFailure extends Error {
  constructor(
    message: string, readonly code: string, readonly changes: readonly ReportedChange[] = [],
    readonly roots: readonly RootTransition[] = [],
  ) {
    super(message)
  }
}

interface CommandResult {
  readonly schemaVersion: 1
  readonly ok: boolean
  readonly operation: 'check' | 'baseline' | 'record' | 'update'
  readonly message: string
  readonly changes: readonly ReportedChange[]
  readonly roots: readonly RootTransition[]
  readonly files: readonly string[]
  readonly recordId?: string
  readonly code?: string
}

interface Tip {
  readonly id: string
  readonly root: PersistenceRoot | null
}

/** Verified per-root history tips; historical schemas need not match the current tree. */
export interface PersistenceHistory {
  readonly entries: readonly PersistenceHistoryEntry[]
  readonly tips: ReadonlyMap<string, Tip>
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, expected: readonly string[], label: string, optional: readonly string[] = []): void {
  const missing = expected.find(key => !Object.hasOwn(value, key))
  const unexpected = Object.keys(value).find(key => !expected.includes(key) && !optional.includes(key))
  if (missing !== undefined || unexpected !== undefined) throw new Error(`${label}: ${missing === undefined ? `unknown field ${unexpected}` : `missing field ${missing}`}`)
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}

function textValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`)
  return value
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`)
  return value
}

function identifier(value: unknown, label: string): string {
  const id = textValue(value, label)
  if (!ID_PATTERN.test(id)) throw new Error(`${label} must be YYYY-MM-DD-slug`)
  return id
}

function digest(value: unknown, label: string): string {
  const result = textValue(value, label)
  if (!DIGEST_PATTERN.test(result)) throw new Error(`${label} must be a SHA-256 digest`)
  return result
}

function reference(value: unknown, count: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= count) throw new Error(`${label} references an unknown schema node`)
  return value as number
}

function parseSchema(value: unknown, label: string, formatVersion: 1 | 2): CanonicalSchema {
  const input = record(value, label)
  keys(input, ['root', 'nodes'], label)
  if (input.root !== 0) throw new Error(`${label}.root must be zero`)
  const nodes = array(input.nodes, `${label}.nodes`)
  if (nodes.length === 0) throw new Error(`${label}.nodes must not be empty`)
  const ref = (value: unknown): number => reference(value, nodes.length, label)
  for (const [index, raw] of nodes.entries()) {
    const node = record(raw, `${label}.nodes[${index}]`)
    switch (node.kind) {
      case 'primitive':
        keys(node, ['kind', 'type'], label)
        if (!['null', 'boolean', 'number', 'string', 'never'].includes(String(node.type))) throw new Error(`${label}: invalid primitive`)
        break
      case 'literal':
        keys(node, ['kind', 'value'], label)
        if (!['string', 'boolean', 'number'].includes(typeof node.value)
          || typeof node.value === 'number' && !Number.isFinite(node.value)) throw new Error(`${label}: invalid literal`)
        break
      case 'opaque':
        keys(node, ['kind', 'reason'], label)
        if (!['any', 'unknown'].includes(String(node.reason))) throw new Error(`${label}: invalid opaque reason`)
        break
      case 'array':
        keys(node, ['kind', 'element'], label)
        ref(node.element)
        break
      case 'tuple':
        keys(node, ['kind', 'elements'], label)
        for (const rawElement of array(node.elements, label)) {
          const element = record(rawElement, label)
          keys(element, ['type', 'optional', 'rest'], label)
          ref(element.type)
          bool(element.optional, label)
          bool(element.rest, label)
        }
        break
      case 'object': {
        keys(node, ['kind', 'properties', 'indices'], label)
        const names = new Set<string>()
        for (const rawProperty of array(node.properties, label)) {
          const property = record(rawProperty, label)
          keys(property, ['name', 'type', 'optional'], label, formatVersion === 2 ? ['compatibility'] : [])
          if (property.compatibility !== undefined) {
            const policy = record(property.compatibility, `${label} source compatibility`)
            keys(policy, ['version', 'policy', 'binding', 'discriminator', 'unknownKinds', 'attributionKinds'], label)
            if (policy.version !== 1 || policy.policy !== 'session-source-attribution'
              || !['session.user-message.source', 'session.developer-message.source'].includes(String(policy.binding))
              || policy.discriminator !== 'kind' || policy.unknownKinds !== 'preserve') {
              throw new Error(`${label}: unsupported source compatibility policy`)
            }
            for (const kind of array(policy.attributionKinds, label)) textValue(kind, label)
          }
          if (typeof property.name !== 'string') throw new Error(`${label}: property name must be a string`)
          const name = property.name
          if (names.has(name)) throw new Error(`${label}: duplicate property ${name}`)
          names.add(name)
          ref(property.type)
          bool(property.optional, label)
        }
        for (const rawIndex of array(node.indices, label)) {
          const entry = record(rawIndex, label)
          keys(entry, ['key', 'value'], label)
          ref(entry.key)
          ref(entry.value)
        }
        break
      }
      case 'union':
        keys(node, ['kind', 'types'], label)
        if (array(node.types, label).length === 0) throw new Error(`${label}: empty union`)
        for (const item of node.types as unknown[]) ref(item)
        break
      default:
        throw new Error(`${label}: unknown schema node kind ${String(node.kind)}`)
    }
  }
  const schema = input as unknown as CanonicalSchema
  for (const node of schema.nodes) {
    if (node.kind !== 'object') continue
    for (const property of node.properties) {
      if (property.compatibility !== undefined && !validSourceCompatibility(schema.nodes, node, property)) {
        throw new Error(`${label}: invalid source compatibility binding or attribution kinds`)
      }
    }
  }
  const canonical = canonicalizeSchema(schema.nodes, schema.root)
  if (JSON.stringify(canonical) !== JSON.stringify(schema)) throw new Error(`${label}: schema is not canonical`)
  return schema
}

/** Parse a persisted schema inventory, rejecting malformed graphs and digest drift.
 * @param value - JSON read from the current inventory or an enforced acknowledgement snapshot.
 * @returns the validated inventory.
 */
export function parsePersistenceSnapshot(value: unknown): PersistenceSchemaInventory {
  return parseSnapshot(value, false)
}

/** Parse a historical inventory with path-only source references and optional surface operations.
 * @param value - JSON captured from a historical source tree.
 * @returns the validated inventory; current acknowledgements use the strict parser.
 */
export function parseHistoricalPersistenceSnapshot(value: unknown): PersistenceSchemaInventory {
  return parseSnapshot(value, true)
}

function parseSnapshot(value: unknown, historical: boolean): PersistenceSchemaInventory {
  const input = record(value, 'schema inventory')
  keys(input, ['formatVersion', 'roots', 'types'], 'schema inventory')
  if (input.formatVersion !== 1 && input.formatVersion !== 2) throw new Error('unsupported persistence schema normalization version')
  const names = new Set<string>()
  for (const rawRoot of array(input.roots, 'schema roots')) {
    const root = record(rawRoot, 'schema root')
    keys(root, ['key', 'kind', 'digest', 'schema'], 'schema root', ['event', 'surface'])
    const key = textValue(root.key, 'root key')
    if (names.has(key)) throw new Error(`duplicate schema root ${key}`)
    names.add(key)
    if (root.kind === 'event') {
      if (key !== `event:${textValue(root.event, 'event name')}`) throw new Error(`invalid event root key ${key}`)
      bool(root.surface, 'event surface membership')
    } else if ((root.kind !== 'header' || !['SessionHeader', 'JsonlHeaderLine'].includes(key))
      && (root.kind !== 'envelope' || key !== 'SessionEventEnvelope')) throw new Error(`invalid schema root ${key}`)
    if (root.kind !== 'event' && (root.event !== undefined || root.surface !== undefined)) throw new Error(`${key}: non-event metadata`)
    const schema = parseSchema(root.schema, key, input.formatVersion)
    if (root.kind === 'event') validateEventMetadata(schema, String(root.event), root.surface === true, historical)
    if (digest(root.digest, `${key} digest`) !== schemaDigest(schema)) throw new Error(`${key}: schema digest mismatch`)
  }
  for (const rawType of array(input.types, 'schema types')) {
    const type = record(rawType, 'schema type')
    keys(type, ['digest', 'schema', 'names', 'sources'], 'schema type')
    const schema = parseSchema(type.schema, 'shared schema', input.formatVersion)
    if (digest(type.digest, 'shared digest') !== schemaDigest(schema)) throw new Error('shared schema digest mismatch')
    for (const name of array(type.names, 'type names')) textValue(name, 'type name')
    for (const source of array(type.sources, 'type sources')) {
      const location = textValue(source, 'type source')
      if (historical && /:\d+(?::\d+)?$|#L\d+(?:-L\d+)?$/u.test(location)) {
        throw new Error('historical schema sources must omit line numbers')
      }
    }
  }
  return input as unknown as PersistenceSchemaInventory
}

function validateEventMetadata(schema: CanonicalSchema, event: string, surface: boolean, historical: boolean): void {
  const pending = [0]
  const visited = new Set<number>()
  while (pending.length > 0) {
    const index = pending.pop() as number
    if (visited.has(index)) continue
    visited.add(index)
    const node = schema.nodes[index] as SchemaNode
    if (node.kind === 'union') { pending.push(...node.types); continue }
    if (node.kind !== 'object') throw new Error(`${event}: event schema must be an object`)
    const tag = node.properties.find(property => property.name === 'type')
    const value = tag === undefined ? undefined : schema.nodes[tag.type]
    if (tag?.optional !== false || value?.kind !== 'literal' || value.value !== event) throw new Error(`${event}: event schema type does not match its root`)
    const operation = node.properties.find(property => property.name === 'surfaceOp')
    if (surface ? operation === undefined || !historical && operation.optional : operation !== undefined) throw new Error(`${event}: surface metadata does not match its schema`)
  }
}

function subDigest(schema: CanonicalSchema, node: number): string {
  return schemaDigest(canonicalizeSchema(schema.nodes, node))
}

function matchUnionVariants(candidates: readonly (readonly number[])[]): number[] | undefined {
  const owners = new Map<number, number>()
  function assign(previous: number, visited: Set<number>): boolean {
    for (const next of candidates[previous] ?? []) {
      if (visited.has(next)) continue
      visited.add(next)
      const owner = owners.get(next)
      if (owner === undefined || assign(owner, visited)) {
        owners.set(next, previous)
        return true
      }
    }
    return false
  }
  for (let previous = 0; previous < candidates.length; previous += 1) {
    if (!assign(previous, new Set())) return undefined
  }
  const matches: number[] = []
  for (const [next, previous] of owners) matches[previous] = next
  return matches
}

/** Classify structural differences using the reader promises saved with each schema.
 * @param before - predecessor root, or absence for an addition.
 * @param after - successor root, or absence for deletion.
 * @returns concrete changes and their format-bump requirement.
 */
export function classifyPersistenceChange(before: PersistenceRoot | null, after: PersistenceRoot | null): PersistenceTypeChange[] {
  if (before === null) {
    return after === null ? [] : [{ path: after.key, kind: 'root-added', description: 'root added',
      requiresVersionBump: after.kind !== 'event' || after.surface !== false }]
  }
  if (after === null) return [{ path: before.key, kind: 'root-removed', description: 'root removed', requiresVersionBump: true }]
  const key = after.key
  const oldRoot = before
  const newRoot = after
  const describe = (path: string, kind: PersistenceTypeChangeKind, requiresVersionBump = true): PersistenceTypeChange =>
    ({ path, kind, description: CHANGE_DESCRIPTIONS[kind], requiresVersionBump })
  const changes: PersistenceTypeChange[] = []
  if (before.kind !== after.kind || before.surface !== after.surface) changes.push(describe(key, 'root-classification-changed'))
  if (before.digest === after.digest) return changes
  const fingerprints = [new Map<number, string>(), new Map<number, string>()] as const
  const fingerprint = (schema: CanonicalSchema, index: number, side: 0 | 1): string => {
    let result = fingerprints[side].get(index)
    if (result === undefined) { result = subDigest(schema, index); fingerprints[side].set(index, result) }
    return result
  }
  type Scope = 'event' | 'body' | 'strict'
  function compare(
    oldIndex: number, newIndex: number, path: string, scope: Scope, ancestors: ReadonlySet<string>,
  ): PersistenceTypeChange[] {
    if (fingerprint(oldRoot.schema, oldIndex, 0) === fingerprint(newRoot.schema, newIndex, 1)) return []
    const pair = `${oldIndex}:${newIndex}:${scope}`
    if (ancestors.has(pair)) return []
    // Recursive pairs are assumptions for this candidate only. A failed sibling
    // or unmatched union arm cannot leave a cached success for another candidate.
    const active = new Set(ancestors).add(pair)
    const differences: PersistenceTypeChange[] = []
    const add = (path: string, kind: PersistenceTypeChangeKind, requiresVersionBump = true): void => {
      differences.push(describe(path, kind, requiresVersionBump))
    }
    const descend = (oldType: number, newType: number, child: string, childScope: Scope): void => {
      differences.push(...compare(oldType, newType, child, childScope, active))
    }
    const oldNode = oldRoot.schema.nodes[oldIndex] as SchemaNode
    const newNode = newRoot.schema.nodes[newIndex] as SchemaNode
    if (oldRoot.kind === 'event' && oldRoot.surface === false && scope === 'body' && path === `${key}.data`) {
      const oldTypes = oldNode.kind === 'union' ? oldNode.types : [oldIndex]
      const newTypes = newNode.kind === 'union' ? newNode.types : [newIndex]
      const payloadVersion = (schema: CanonicalSchema, index: number): number | undefined => {
        const node = schema.nodes[index]
        if (node?.kind !== 'object') return undefined
        const property = node.properties.find(property => property.name === 'version' && !property.optional)
        const version = schema.nodes[property?.type ?? -1]
        return version?.kind === 'literal' && typeof version.value === 'number'
          && Number.isSafeInteger(version.value) && version.value >= 0 ? version.value : undefined
      }
      const versions = oldTypes.map(index => payloadVersion(oldRoot.schema, index))
      const oldHashes = new Set(oldTypes.map(index => fingerprint(oldRoot.schema, index, 0)))
      const newHashes = new Set(newTypes.map(index => fingerprint(newRoot.schema, index, 1)))
      const added = newTypes.filter(index => !oldHashes.has(fingerprint(newRoot.schema, index, 1)))
      if (versions.every(version => version !== undefined) && added.length > 0
        && [...oldHashes].every(hash => newHashes.has(hash))
        && added.every(index => (payloadVersion(newRoot.schema, index) ?? -1) > Math.max(...versions))) {
        return [describe(path, 'payload-version-added', false)]
      }
    }
    if (oldNode.kind !== newNode.kind) return [describe(path, 'type-changed')]
    if (oldNode.kind === 'object' && newNode.kind === 'object') {
      const oldProps = new Map(oldNode.properties.map(property => [property.name, property]))
      const newProps = new Map(newNode.properties.map(property => [property.name, property]))
      for (const [name, property] of oldProps) {
        const next = newProps.get(name)
        const child = `${path}.${name}`
        if (next === undefined) { add(child, 'property-removed'); continue }
        if (property.optional !== next.optional) add(child, next.optional ? 'property-made-optional' : 'property-made-required', scope !== 'body' || !next.optional)
        const childScope = scope === 'body' || scope === 'event' && name === 'data' ? 'body' : 'strict'
        if (property.compatibility !== undefined || next.compatibility !== undefined) {
          const oldGroups = sourceKindGroups(oldRoot.schema.nodes, property.type)
          const newGroups = sourceKindGroups(newRoot.schema.nodes, next.type)
          if (childScope === 'body' && property.compatibility !== undefined && next.compatibility !== undefined
            && oldGroups !== undefined && newGroups !== undefined
            && validSourceCompatibility(oldRoot.schema.nodes, oldNode, property)
            && validSourceCompatibility(newRoot.schema.nodes, newNode, next)
            && matchingSourceCompatibility(property.compatibility, next.compatibility, oldGroups.keys())) {
            for (const [kind, oldTypes] of oldGroups) {
              const newTypes = newGroups.get(kind)
              if (newTypes === undefined) add(`${child}[kind=${JSON.stringify(kind)}]`, 'union-variants-changed')
              else differences.push(...compareAlternatives(oldTypes, newTypes, `${child}[kind=${JSON.stringify(kind)}]`, childScope, active))
            }
            for (const kind of newGroups.keys()) {
              if (!oldGroups.has(kind)) add(`${child}[kind=${JSON.stringify(kind)}]`,
                next.compatibility.attributionKinds.includes(kind) ? 'attribution-kind-added' : 'union-variants-changed',
                !next.compatibility.attributionKinds.includes(kind))
            }
            continue
          }
          if (JSON.stringify(property.compatibility) !== JSON.stringify(next.compatibility)) add(child, 'source-policy-changed')
        }
        descend(property.type, next.type, child, childScope)
      }
      for (const [name, property] of newProps) {
        if (!oldProps.has(name)) add(`${path}.${name}`, property.optional ? 'optional-property-added' : 'required-property-added', scope !== 'body' || !property.optional)
      }
      const oldIndices = new Map(oldNode.indices.map(entry => [fingerprint(oldRoot.schema, entry.key, 0), entry]))
      const newIndices = new Map(newNode.indices.map(entry => [fingerprint(newRoot.schema, entry.key, 1), entry]))
      if (oldIndices.size !== newIndices.size || [...oldIndices.keys()].some(index => !newIndices.has(index))) add(path, 'index-signature-changed')
      for (const [index, entry] of oldIndices) {
        const next = newIndices.get(index)
        if (next !== undefined) descend(entry.value, next.value, `${path}[*]`, scope === 'body' ? 'body' : 'strict')
      }
      return differences
    }
    if (oldNode.kind === 'array' && newNode.kind === 'array') {
      return compare(oldNode.element, newNode.element, `${path}[]`, scope === 'body' ? 'body' : 'strict', active)
    }
    if (oldNode.kind === 'tuple' && newNode.kind === 'tuple') {
      if (oldNode.elements.length !== newNode.elements.length) return [describe(path, 'tuple-length-changed')]
      for (const [index, element] of oldNode.elements.entries()) {
        const next = newNode.elements[index] as SchemaTupleElement
        if (element.optional !== next.optional || element.rest !== next.rest) add(`${path}[${index}]`, 'tuple-element-cardinality-changed')
        descend(element.type, next.type, `${path}[${index}]`, scope === 'body' ? 'body' : 'strict')
      }
      return differences
    }
    if (oldNode.kind === 'union' && newNode.kind === 'union') {
      return compareAlternatives(oldNode.types, newNode.types, path, scope, active)
    }
    return [describe(path, 'type-changed')]
  }
  function compareAlternatives(
    oldTypes: readonly number[], newTypes: readonly number[], path: string, scope: Scope, active: ReadonlySet<string>,
  ): PersistenceTypeChange[] {
    if (oldTypes.length !== newTypes.length) return [describe(path, 'union-variants-changed')]
    const candidates = oldTypes.map(oldType => newTypes.map(newType => compare(oldType, newType, path, scope, active)))
    const matching = matchUnionVariants(candidates.map(row => row.flatMap((candidate, index) =>
      candidate.every(change => !change.requiresVersionBump) ? [index] : [])))
    if (matching !== undefined) return matching.flatMap((next, previous) => candidates[previous]?.[next] ?? [])
    const oldByHash = new Map(oldTypes.map(index => [fingerprint(oldRoot.schema, index, 0), index]))
    const newByHash = new Map(newTypes.map(index => [fingerprint(newRoot.schema, index, 1), index]))
    const removed = [...oldByHash].filter(([hash]) => !newByHash.has(hash)).map(([, index]) => index)
    const added = [...newByHash].filter(([hash]) => !oldByHash.has(hash)).map(([, index]) => index)
    if (removed.length === 1 && added.length === 1) return compare(removed[0] as number, added[0] as number, path, scope, active)
    return [describe(path, 'union-variants-changed')]
  }
  changes.push(...compare(0, 0, key, before.kind === 'event' ? 'event' : 'strict', new Set()))
  if (changes.length === 0) changes.push(describe(key, 'type-changed'))
  return [...new Map(changes.map(change => [JSON.stringify([change.path, change.kind, change.requiresVersionBump]), change])).values()]
}

function parseDocument(source: string, filename: string, allowIncomplete = false): PersistenceChangeRecord {
  const frontmatter = /^---\n([\s\S]*?)\n---\n/u.exec(source)
  if (frontmatter === null || record(load(frontmatter[1] as string, { schema: JSON_SCHEMA }), filename).kind !== 'persistence-change') throw new Error(`${filename}: kind must be persistence-change`)
  const openings = [...source.matchAll(/^```yaml persistence-change\s*$/gmu)]
  const block = /^```yaml persistence-change[^\S\n]*\n([\s\S]*?)^```[^\S\n]*$/mu.exec(source)
  if (openings.length !== 1 || block === null) throw new Error(`${filename}: expected exactly one persistence-change block`)
  const input = record(load(block[1] as string, { schema: JSON_SCHEMA }), filename)
  keys(input, ['schemaVersion', 'id', 'baseline', 'changes'], filename)
  if (input.schemaVersion !== 1) throw new Error(`${filename}: unsupported acknowledgement schema version`)
  const id = identifier(input.id, filename)
  if (basename(filename) !== `${id}.md`) throw new Error(`${filename}: record id does not match filename`)
  bool(input.baseline, filename)
  const roots = new Set<string>()
  for (const value of array(input.changes, `${filename} changes`)) {
    const change = record(value, filename)
    keys(change, ['root', 'previous', 'after', 'decision'], filename)
    const root = textValue(change.root, 'changed root')
    if (roots.has(root)) throw new Error(`${filename}: duplicate change for ${root}`)
    roots.add(root)
    if (change.previous !== null) identifier(change.previous, 'previous record')
    if (change.after !== null) digest(change.after, 'after digest')
    if (change.decision !== 'same-version' && change.decision !== 'version-bump') throw new Error(`${filename}: invalid compatibility decision`)
  }
  if (roots.size === 0) throw new Error(`${filename}: changes must not be empty`)
  if (!allowIncomplete && (source.includes(EXPLANATION_PLACEHOLDER) || source.includes(EVIDENCE_PLACEHOLDER))) throw new Error(`${filename}: complete compatibility and verification prose`)
  return input as unknown as PersistenceChangeRecord
}

function headerVersion(root: PersistenceRoot | null): number | undefined {
  if (root === null) return undefined
  const node = root.schema.nodes[0]
  if (node?.kind !== 'object') return undefined
  const property = node.properties.find(item => item.name === 'version')
  if (property === undefined) return undefined
  const version = root.schema.nodes[property.type]
  return version?.kind === 'literal' && typeof version.value === 'number' && Number.isSafeInteger(version.value) ? version.value : undefined
}

/** Check every historical transition and return each root's unique current tip.
 * @param entries - parsed documents and their self-contained schema snapshots.
 * @returns validated history and tips, without consulting Git or current source.
 */
export function validatePersistenceHistory(entries: readonly PersistenceHistoryEntry[]): PersistenceHistory {
  if (entries.filter(entry => entry.record.baseline).length !== 1) throw new Error('persistence history requires exactly one baseline')
  const records = new Map<string, PersistenceHistoryEntry>()
  for (const entry of entries) {
    if (records.has(entry.record.id)) throw new Error(`duplicate persistence record ${entry.record.id}`)
    records.set(entry.record.id, entry)
    const expected = entry.record.changes.filter(change => change.after !== null).map(change => change.root).sort()
    if (JSON.stringify(expected) !== JSON.stringify(entry.snapshot.roots.map(root => root.key).sort())) throw new Error(`${entry.record.id}: snapshot roots do not match acknowledged after schemas`)
    for (const change of entry.record.changes) {
      const root = entry.snapshot.roots.find(root => root.key === change.root)
      if ((root?.digest ?? null) !== change.after) throw new Error(`${entry.record.id}: after digest mismatch for ${change.root}`)
      if (entry.record.baseline && (change.previous !== null || change.after === null || change.decision !== 'same-version')) throw new Error(`${entry.record.id}: invalid baseline transition`)
    }
  }
  const states = new Map<string, 'visiting' | 'visited'>()
  const successors = new Map<string, string>()
  const nodes = new Map<string, { entry: PersistenceHistoryEntry; change: PersistenceChange }>()
  const tips = new Map<string, Tip>()
  const nodeKey = (id: string | null, root: string): string => JSON.stringify([id, root])
  for (const entry of entries) for (const change of entry.record.changes) {
    const parentKey = nodeKey(change.previous, change.root)
    if (successors.has(parentKey)) throw new Error(`forked persistence history for ${change.root}: ${successors.get(parentKey)} and ${entry.record.id}`)
    successors.set(parentKey, entry.record.id)
    nodes.set(nodeKey(entry.record.id, change.root), { entry, change })
  }
  function visit(id: string, root: string): PersistenceRoot | null {
    const key = nodeKey(id, root)
    const found = nodes.get(key)
    if (found === undefined) throw new Error(`missing predecessor ${id} for ${root}`)
    if (states.get(key) === 'visiting') throw new Error(`cycle in persistence history for ${root}`)
    const after = found.entry.snapshot.roots.find(item => item.key === root) ?? null
    if (states.get(key) === 'visited') return after
    states.set(key, 'visiting')
    const before = found.change.previous === null ? null : visit(found.change.previous, root)
    if (!found.entry.record.baseline) {
      const differences = classifyPersistenceChange(before, after)
      if (differences.length === 0) throw new Error(`${id}: unchanged acknowledgement for ${root}`)
      if (differences.some(change => change.requiresVersionBump) && found.change.decision !== 'version-bump') {
        throw new PersistenceChangeFailure(
          `${id}: ${root} requires a format version bump (${differences.filter(change => change.requiresVersionBump).map(change => change.path + ': ' + change.description).join('; ')})`,
          'version-bump-required', differences.map(change => ({ root, ...change })), [rootTransition(before, after)],
        )
      }
      if (found.change.decision === 'version-bump') {
        const header = found.entry.record.changes.find(change => change.root === 'SessionHeader')
        const oldHeader = header?.previous === null || header === undefined ? null : visit(header.previous, 'SessionHeader')
        const from = headerVersion(oldHeader)
        const to = headerVersion(found.entry.snapshot.roots.find(item => item.key === 'SessionHeader') ?? null)
        if (from === undefined || to === undefined || to <= from) {
          throw new PersistenceChangeFailure(`${id}: version-bump requires this record's own increasing SessionHeader.version transition`,
            'version-transition-required', differences.map(change => ({ root, ...change })), [rootTransition(before, after)])
        }
      }
    }
    states.set(key, 'visited')
    if (!successors.has(key)) tips.set(root, { id, root: after })
    return after
  }
  for (const entry of entries) for (const change of entry.record.changes) visit(entry.record.id, change.root)
  const baseline = entries.find(entry => entry.record.baseline) as PersistenceHistoryEntry
  if (!baseline.snapshot.roots.some(root => root.key === 'SessionHeader')
    || !baseline.snapshot.roots.some(root => root.key === 'SessionEventEnvelope')
    || !baseline.snapshot.roots.some(root => root.key === 'JsonlHeaderLine')) {
    throw new Error('baseline requires SessionHeader, JsonlHeaderLine, and SessionEventEnvelope roots')
  }
  return { entries, tips }
}

/** Read and validate all current-tree persistence acknowledgement files.
 * @param root - checkout or isolated fixture root.
 * @returns checked history without comparing its tips to current source.
 */
export function loadPersistenceHistory(root: string): PersistenceHistory {
  return validatePersistenceHistory(readPersistenceEntries(root))
}

function readPersistenceEntries(root: string, allowIncompleteId?: string): PersistenceHistoryEntry[] {
  const directory = join(root, HISTORY_DIRECTORY)
  if (!existsSync(directory)) throw new Error('persistence history is missing; use pnpm run persistence-changes --baseline ID for explicit initialization')
  const files = readdirSync(directory).sort()
  const documents = files.filter(file => file.endsWith('.md') && !file.endsWith('.zh.md') && file !== 'README.md' && file !== 'AGENTS.md')
  const snapshots = new Set(files.filter(file => file.endsWith('.schema.json')))
  const entries = documents.map((filename) => {
    const source = readFileSync(join(directory, filename), 'utf8').replaceAll('\r\n', '\n')
    const allowIncomplete = filename === `${allowIncompleteId}.md`
    const change = parseDocument(source, filename, allowIncomplete)
    const snapshotName = `${change.id}.schema.json`
    if (!snapshots.delete(snapshotName)) throw new Error(`${filename}: missing schema snapshot ${snapshotName}`)
    const snapshot = parsePersistenceSnapshot(JSON.parse(readFileSync(join(directory, snapshotName), 'utf8')))
    const translatedName = `${change.id}.zh.md`
    if (!files.includes(translatedName)) throw new Error(`${filename}: missing Chinese counterpart`)
    const translated = readFileSync(join(directory, translatedName), 'utf8').replaceAll('\r\n', '\n')
    const englishBlock = source.match(/^```yaml persistence-change[^\S\n]*\n([\s\S]*?)^```[^\S\n]*$/mu)?.[1]
    const chineseBlocks = [...translated.matchAll(/^```yaml persistence-change[^\S\n]*\n([\s\S]*?)^```[^\S\n]*$/gmu)]
    if (chineseBlocks.length !== 1 || chineseBlocks[0]?.[1] !== englishBlock) throw new Error(`${filename}: bilingual machine records differ`)
    if (!allowIncomplete && (translated.includes(EXPLANATION_PLACEHOLDER) || translated.includes(EVIDENCE_PLACEHOLDER))) throw new Error(`${translatedName}: complete compatibility and verification prose`)
    return { record: change, snapshot }
  })
  if (snapshots.size !== 0) throw new Error(`unreferenced persistence schema snapshot: ${[...snapshots].join(', ')}`)
  return entries
}

function currentDifferences(history: PersistenceHistory, current: PersistenceSchemaInventory): string[] {
  const roots = new Map(current.roots.map(root => [root.key, root]))
  const differences: string[] = []
  for (const key of new Set([...history.tips.keys(), ...roots.keys()])) {
    if (classifyPersistenceChange(history.tips.get(key)?.root ?? null, roots.get(key) ?? null).length !== 0) differences.push(key)
  }
  return differences.sort()
}

function verifyFinalization(
  root: string, entries: readonly PersistenceHistoryEntry[], current: PersistenceSchemaInventory, updateId?: string,
): void {
  const finalized = loadPersistenceFinalization(root, { entries })
  if (finalized === undefined) return
  if (updateId !== undefined && finalized.acceptedRecords.has(updateId)) {
    throw new PersistenceChangeFailure(`cannot update finalized acknowledgement ${updateId}; create a successor record`, 'finalized-record-update')
  }
  const writer = headerVersion(current.roots.find(root => root.key === 'SessionHeader') ?? null)
  if (writer === undefined || writer < finalized.version) {
    throw new PersistenceChangeFailure(`Session writer must not precede finalized format ${finalized.version}`, 'finalized-version-order')
  }
  if (writer > finalized.version) return
  const afterRoots = new Map(current.roots.map(root => [root.key, root]))
  const changes: ReportedChange[] = []
  const transitions: RootTransition[] = []
  for (const key of [...new Set([...finalized.roots.keys(), ...afterRoots.keys()])].sort()) {
    const before = finalized.roots.get(key) ?? null
    const after = afterRoots.get(key) ?? null
    const differences = classifyPersistenceChange(before, after)
    if (differences.length === 0) continue
    changes.push(...differences.map(change => ({ root: key, ...change })))
    transitions.push(rootTransition(before, after))
  }
  if (changes.some(change => change.requiresVersionBump)) {
    throw new PersistenceChangeFailure(
      `Breaking changes relative to the accepted Session format ${writer} baseline require format ${writer + 1} or later`,
      'finalized-format-changed', changes, transitions,
    )
  }
}

/** Verify current generated output and acknowledgement tips together.
 * @param root - checkout or isolated fixture root.
 * @param current - freshly extracted current-source inventory.
 * @returns verified history.
 */
export function verifyPersistenceChanges(root: string, current: PersistenceSchemaInventory): PersistenceHistory {
  const history = loadPersistenceHistory(root)
  verifyFinalization(root, history.entries, current)
  const differences = reportedDifferences(history, current)
  const transitions = rootTransitions(history, current)
  const committedPath = join(root, CURRENT_SCHEMA)
  if (!existsSync(committedPath)) {
    throw new PersistenceChangeFailure(`${CURRENT_SCHEMA} is missing; regenerate the persistence catalog`, 'generated-artifact-missing', differences, transitions)
  }
  const committed = parsePersistenceSnapshot(JSON.parse(readFileSync(committedPath, 'utf8')))
  if (JSON.stringify(committed) !== JSON.stringify(current)) {
    throw new PersistenceChangeFailure(`${CURRENT_SCHEMA} is stale; regenerate the persistence catalog`, 'stale-artifacts', differences, transitions)
  }
  if (differences.length !== 0) {
    const details = differences.map(change => `  ${change.path}: ${change.description} (${change.requiresVersionBump ? 'version-bump required' : 'same-version allowed'})`)
    throw new PersistenceChangeFailure(`unacknowledged persistence type changes:\n${details.join('\n')}`, 'unacknowledged-changes', differences, transitions)
  }
  return history
}

function rootTransition(before: PersistenceRoot | null, after: PersistenceRoot | null): RootTransition {
  const root = (after ?? before) as PersistenceRoot
  return { root: root.key, kind: root.kind, before: before?.digest ?? null, after: after?.digest ?? null }
}

function rootTransitions(history: PersistenceHistory | undefined, current: PersistenceSchemaInventory): RootTransition[] {
  const changed = history === undefined ? current.roots.map(root => root.key) : currentDifferences(history, current)
  return changed.map(root => rootTransition(history?.tips.get(root)?.root ?? null, current.roots.find(item => item.key === root) ?? null))
}

function reportedDifferences(history: PersistenceHistory, current: PersistenceSchemaInventory): ReportedChange[] {
  return currentDifferences(history, current).flatMap(root => classifyPersistenceChange(
    history.tips.get(root)?.root ?? null, current.roots.find(item => item.key === root) ?? null,
  ).map(change => ({ root, ...change })))
}

function machineBlock(change: PersistenceChangeRecord): string {
  return ['```yaml persistence-change', 'schemaVersion: 1', `id: ${change.id}`, `baseline: ${String(change.baseline)}`, 'changes:',
    ...change.changes.flatMap(item => [`  - root: ${JSON.stringify(item.root)}`, `    previous: ${item.previous === null ? 'null' : JSON.stringify(item.previous)}`, `    after: ${item.after === null ? 'null' : JSON.stringify(item.after)}`, `    decision: ${item.decision}`]), '```'].join('\n')
}

function scaffold(change: PersistenceChangeRecord, chinese: boolean, prose?: PersistenceChangeProse): string {
  const summary = chinese ? '概述' : 'Summary'
  const compatibility = chinese ? '兼容性' : 'Compatibility'
  const verification = chinese ? '验证' : 'Verification'
  return ['---', `description: ${JSON.stringify(chinese ? '记录持久化类型更改及其兼容性确认。' : 'Records a persistence type transition and its compatibility acknowledgement.')}`, 'kind: persistence-change', '---', '',
    `# ${change.id}`, '', chinese ? `[English](${change.id}.md) | 中文` : `English | [中文](${change.id}.zh.md)`, '',
    `## ${summary}`, '', prose?.summary ?? EXPLANATION_PLACEHOLDER, '', '## ' + (chinese ? '目录' : 'Table of Contents'), '',
    `- [${chinese ? '声明' : 'Declaration'}](#declaration)`, `- [${compatibility}](#compatibility)`, `- [${verification}](#verification)`, `- [${chinese ? '开发备注' : 'Dev Note'}](#dev-note)`, '',
    '<a id="declaration"></a>', `## ${chinese ? '声明' : 'Declaration'}`, '', machineBlock(change), '',
    '<a id="compatibility"></a>', `## ${compatibility}`, '', prose?.compatibility ?? EXPLANATION_PLACEHOLDER, '',
    '<a id="verification"></a>', `## ${verification}`, '', prose?.verification ?? EVIDENCE_PLACEHOLDER, '', '<a id="dev-note"></a>', `## ${chinese ? '开发备注' : 'Dev Note'}`, '', chinese ? '无。' : 'None.', ''].join('\n')
}

/** Parse explicit authored prose without supplying compatibility or validation claims.
 * @param value - decoded JSON supplied through --prose.
 * @returns complete English and Chinese section text.
 */
export function parsePersistenceProse(value: unknown): PersistenceChangeProsePair {
  const pair = record(value, 'persistence prose')
  keys(pair, ['en', 'zh'], 'persistence prose')
  for (const locale of ['en', 'zh']) {
    const sections = record(pair[locale], `persistence prose ${locale}`)
    keys(sections, ['summary', 'compatibility', 'verification'], `persistence prose ${locale}`)
    for (const [name, value] of Object.entries(sections)) {
      const text = textValue(value, `${locale}.${name}`)
      if (text.trim().length === 0 || text.includes(EXPLANATION_PLACEHOLDER) || text.includes(EVIDENCE_PLACEHOLDER)) {
        throw new Error(`${locale}.${name} requires authored prose without scaffold placeholders`)
      }
    }
  }
  return pair as unknown as PersistenceChangeProsePair
}

function updateDocument(source: string, change: PersistenceChangeRecord, chinese: boolean, prose?: PersistenceChangeProse): string {
  source = source.replace(/^```yaml persistence-change[^\S\n]*\n[\s\S]*?^```[^\S\n]*$/mu, machineBlock(change))
  if (prose === undefined) return source
  const headings = chinese ? ['概述', '兼容性', '验证'] : ['Summary', 'Compatibility', 'Verification']
  for (const [index, text] of [prose.summary, prose.compatibility, prose.verification].entries()) {
    const lines = source.split('\n')
    const heading = `## ${headings[index]}`
    const start = lines.indexOf(heading)
    if (start < 0 || lines.lastIndexOf(heading) !== start) throw new Error(`--prose requires one ${heading} section in the existing record`)
    let end = lines.findIndex((line, lineIndex) => lineIndex > start && /^##? /u.test(line))
    if (end < 0) end = lines.length
    let anchor = end
    while (anchor > start + 1 && lines[anchor - 1] === '') anchor -= 1
    if (/^<a id="[^"]+"><\/a>$/u.test(lines[anchor - 1] ?? '')) end = anchor - 1
    lines.splice(start + 1, end - start - 1, '', text.trim(), '')
    source = lines.join('\n')
  }
  return source
}

function commandOperation(args: readonly string[]): CommandResult['operation'] {
  if (args.some(arg => arg === '--baseline' || arg.startsWith('--baseline='))) return 'baseline'
  if (args.some(arg => arg === '--record' || arg.startsWith('--record='))) return 'record'
  if (args.some(arg => arg === '--update' || arg.startsWith('--update='))) return 'update'
  return 'check'
}

function executeCommand(
  args: readonly string[], root: string, extract: (root: string) => PersistenceSchemaInventory,
  artifacts: (root: string, current: PersistenceSchemaInventory) => readonly PersistenceArtifact[],
): CommandResult {
  const { values } = parseArgs({ args: [...args], strict: true, allowPositionals: false, options: {
    check: { type: 'boolean' }, baseline: { type: 'string' }, record: { type: 'string' }, update: { type: 'string' },
    decision: { type: 'string' }, root: { type: 'string' }, prose: { type: 'string' }, json: { type: 'boolean' },
  } })
  if (values.root !== undefined) root = resolve(values.root)
  const selected = [values.check === true, values.baseline !== undefined, values.record !== undefined, values.update !== undefined]
  if (selected.filter(Boolean).length > 1) throw new Error('choose exactly one of --check, --baseline ID, --record ID, or --update ID')
  if (values.record === undefined && values.update === undefined && values.decision !== undefined) throw new Error('--decision requires --record or --update')
  const operation = commandOperation(args)
  if (operation === 'check' && values.prose !== undefined) throw new Error('--prose requires --baseline, --record, or --update')
  const prose = values.prose === undefined ? undefined : parsePersistenceProse(JSON.parse(readFileSync(resolve(root, values.prose), 'utf8')))
  const current = parsePersistenceSnapshot(extract(root))
  if (operation === 'check') {
    const history = verifyPersistenceChanges(root, current)
    return { schemaVersion: 1, ok: true, operation,
      message: `persistence changes: ${current.roots.length} roots match ${history.entries.length} history records.`, changes: [], roots: [], files: [] }
  }
  const baseline = operation === 'baseline'
  const update = operation === 'update'
  const id = identifier(values.baseline ?? values.record ?? values.update, 'record id')
  const directory = join(root, HISTORY_DIRECTORY)
  if (baseline && existsSync(directory) && readdirSync(directory).some(file => file.endsWith('.schema.json') || ID_PATTERN.test(file.replace(/\.md$/u, '')))) throw new Error('persistence baseline already exists; baseline creation cannot reset history')
  if (values.decision !== undefined && values.decision !== 'same-version' && values.decision !== 'version-bump') {
    throw new Error('--decision must be same-version or version-bump')
  }
  const entries = baseline ? [] : readPersistenceEntries(root, update ? id : undefined)
  verifyFinalization(root, entries, current, update ? id : undefined)
  const existing = update ? entries.find(entry => entry.record.id === id) : undefined
  if (update && existing === undefined) throw new Error(`${id}: cannot update a missing acknowledgement`)
  if (existing?.record.baseline === true) throw new Error('cannot update the persistence baseline')
  if (existing !== undefined && entries.some(entry => entry.record.changes.some(change => change.previous === id))) {
    throw new Error(`${id}: cannot update an acknowledgement with successors`)
  }
  const prior = entries.filter(entry => entry !== existing)
  const history = baseline ? undefined : validatePersistenceHistory(prior)
  const changed = baseline ? current.roots.map(root => root.key) : currentDifferences(history as PersistenceHistory, current)
  if (changed.length === 0) throw new Error('no persistence type changes to acknowledge')
  const differences = history === undefined ? [] : reportedDifferences(history, current)
  const decision = values.decision ?? (differences.some(change => change.requiresVersionBump) ? 'version-bump' : 'same-version')
  const roots = current.roots.filter(root => changed.includes(root.key))
  const change: PersistenceChangeRecord = { schemaVersion: 1, id, baseline, changes: changed.sort().map(key => ({
    root: key, previous: history?.tips.get(key)?.id ?? null,
    after: roots.find(root => root.key === key)?.digest ?? null, decision,
  })) }
  const snapshot: PersistenceSchemaInventory = { formatVersion: current.formatVersion, roots, types: [] }
  validatePersistenceHistory([...prior, { record: change, snapshot }])
  const document = (chinese: boolean): string => {
    const supplied = chinese ? prose?.zh : prose?.en
    return existing === undefined ? scaffold(change, chinese, supplied)
      : updateDocument(readFileSync(join(directory, `${id}${chinese ? '.zh' : ''}.md`), 'utf8'), change, chinese, supplied)
  }
  const english = document(false)
  const chinese = document(true)
  parseDocument(english, `${id}.md`, prose === undefined && existing === undefined)
  parseDocument(chinese, `${id}.md`, prose === undefined && existing === undefined)
  const recordFiles = [
    ...renderPersistencePair(root, `${HISTORY_DIRECTORY}/${id}.md`, english, chinese),
    { path: `${HISTORY_DIRECTORY}/${id}.schema.json`, content: JSON.stringify(snapshot, null, 2) + '\n' },
  ]
  if (!update && recordFiles.some(file => existsSync(join(root, file.path)))) throw new Error(`${id}: acknowledgement file already exists`)
  const outputs = [...artifacts(root, current), ...recordFiles]
  for (const file of outputs) mkdirSync(resolve(root, file.path, '..'), { recursive: true })
  for (const file of outputs) writeFileSync(resolve(root, file.path), file.content, { flag: recordFiles.includes(file) && !update ? 'wx' : 'w' })
  const completion = baseline
    ? 'Complete both record documents and refresh their translation pairing.'
    : `Complete the compatibility and verification prose with --update ${id} --prose FILE.`
  const message = existing === undefined && prose === undefined
    ? `Created ${HISTORY_DIRECTORY}/${id}.md and paired schema files. ${completion}`
    : `${update ? 'Updated' : 'Created'} ${HISTORY_DIRECTORY}/${id}.md; schema artifacts and bilingual pairing are current.`
  return { schemaVersion: 1, ok: true, operation, recordId: id, message,
    changes: differences,
    roots: rootTransitions(history, current), files: outputs.map(file => file.path) }
}

/** Execute tree-only verification or author an explicit persistence acknowledgement.
 * @param args - check, baseline, record, or update arguments; --json selects structured output.
 * @param root - checkout root; defaults to this script's repository.
 * @param extract - current-source extraction function; fixtures supply their own source reader.
 * @param artifacts - renderer for current generated artifacts; fixtures may isolate the inventory artifact.
 * @returns text or one JSON result; JSON failures retain ok:false for the process entry point.
 */
export function runPersistenceChanges(
  args: readonly string[],
  root: string = resolve(import.meta.dirname, '..'),
  extract: (root: string) => PersistenceSchemaInventory = extractPersistenceSchema,
  artifacts: (root: string, current: PersistenceSchemaInventory) => readonly PersistenceArtifact[] = persistenceCatalogArtifacts,
): string {
  try {
    const result = executeCommand(args, root, extract, artifacts)
    return args.includes('--json') ? JSON.stringify(result) : result.message
  } catch (error: unknown) {
    if (!args.includes('--json')) throw error
    const result: CommandResult = { schemaVersion: 1, ok: false, operation: commandOperation(args),
      message: error instanceof Error ? error.message : String(error),
      code: error instanceof PersistenceChangeFailure ? error.code : 'verification-failed',
      changes: error instanceof PersistenceChangeFailure ? error.changes : [],
      roots: error instanceof PersistenceChangeFailure ? error.roots : [], files: [] }
    return JSON.stringify(result)
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  try {
    const output = runPersistenceChanges(process.argv.slice(2))
    console.log(output)
    if (process.argv.includes('--json') && !(JSON.parse(output) as { ok: boolean }).ok) process.exitCode = 1
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
