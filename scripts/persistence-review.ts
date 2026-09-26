/** Read-only structural explanations alongside the authoritative persistence classification. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { classifyPersistenceChange, parsePersistenceSnapshot, type PersistenceTypeChange } from './persistence-changes.ts'
import { canonicalizeSchema, schemaDigest, type CanonicalSchema, type PersistenceSchemaInventory, type SchemaNode } from './persistence-schema-model.ts'
import { sourceKindGroups } from './persistence-source-policy.ts'

/** One structural observation, shared across its containing roots. */
export interface PersistenceReviewEvidence {
  readonly kind: string
  readonly field?: string
  readonly before: string | null
  readonly after: string | null
  readonly locations: readonly { readonly root: string; readonly path: string }[]
}

/** Human explanations cannot override the unchanged classifier results carried per root. */
export interface PersistenceReview {
  readonly schemaVersion: 1
  readonly roots: readonly {
    readonly root: string
    readonly before: string | null
    readonly after: string | null
    readonly changes: readonly PersistenceTypeChange[]
  }[]
  readonly evidence: readonly PersistenceReviewEvidence[]
  readonly unchangedTypes: number
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function selector(schema: CanonicalSchema, index: number): string | undefined {
  const node = schema.nodes[index]
  if (node?.kind !== 'object') return undefined
  const parts = ['kind', 'type', 'role', 'form'].flatMap((name) => {
    const property = node.properties.find(property => property.name === name && !property.optional)
    const value = property === undefined ? undefined : schema.nodes[property.type]
    return value?.kind === 'literal' && typeof value.value === 'string' ? [`[${name}=${JSON.stringify(value.value)}]`] : []
  })
  return parts.length === 0 ? undefined : parts.join('')
}

function propertyPath(path: string, name: string): string {
  return /^[A-Za-z_$][\w$]*$/u.test(name) ? `${path}.${name}` : `${path}[${JSON.stringify(name)}]`
}

/**
 * Compare explicit inventories without editing records or changing compatibility decisions.
 * @param before - parsed inventory from the chosen base.
 * @param after - parsed inventory from the chosen head.
 * @returns deduplicated structural evidence and exact classifier output for every changed root.
 */
export function reviewPersistenceSchemas(before: PersistenceSchemaInventory, after: PersistenceSchemaInventory): PersistenceReview {
  const oldRoots = new Map(before.roots.map(root => [root.key, root]))
  const newRoots = new Map(after.roots.map(root => [root.key, root]))
  const evidence = new Map<string, Omit<PersistenceReviewEvidence, 'locations'> & { locations: Map<string, { root: string; path: string }> }>()
  const roots = [...new Set([...oldRoots.keys(), ...newRoots.keys()])].sort().flatMap((root) => {
    const oldRoot = oldRoots.get(root) ?? null
    const newRoot = newRoots.get(root) ?? null
    const changes = classifyPersistenceChange(oldRoot, newRoot)
    if (changes.length === 0) return []
    if (oldRoot !== null && newRoot !== null) explain(oldRoot.schema, newRoot.schema, root)
    return [{ root, before: oldRoot?.digest ?? null, after: newRoot?.digest ?? null, changes }]
  })

  function explain(oldSchema: CanonicalSchema, newSchema: CanonicalSchema, root: string): void {
    const oldHashes = new Map<number, string>()
    const newHashes = new Map<number, string>()
    const digest = (side: 'before' | 'after', index: number): string => {
      const cache = side === 'before' ? oldHashes : newHashes
      let hash = cache.get(index)
      if (hash === undefined) {
        hash = schemaDigest(canonicalizeSchema((side === 'before' ? oldSchema : newSchema).nodes, index))
        cache.set(index, hash)
      }
      return hash
    }
    const emit = (kind: string, left: number | null, right: number | null, path: string, field?: string): void => {
      const change = { kind, ...(field === undefined ? {} : { field }), before: left === null ? null : digest('before', left), after: right === null ? null : digest('after', right) }
      const key = JSON.stringify(change)
      const item = evidence.get(key) ?? { ...change, locations: new Map() }
      item.locations.set(JSON.stringify([root, path]), { root, path })
      evidence.set(key, item)
    }
    const walk = (left: number, right: number, path: string, ancestors: ReadonlySet<string>): void => {
      if (digest('before', left) === digest('after', right)) return
      const pair = `${left}:${right}`
      if (ancestors.has(pair)) return
      const active = new Set(ancestors).add(pair)
      const oldNode = oldSchema.nodes[left] as SchemaNode
      const newNode = newSchema.nodes[right] as SchemaNode
      if (oldNode.kind === 'object' && newNode.kind === 'object') {
        const oldProperties = new Map(oldNode.properties.map(property => [property.name, property]))
        const newProperties = new Map(newNode.properties.map(property => [property.name, property]))
        for (const name of [...new Set([...oldProperties.keys(), ...newProperties.keys()])].sort()) {
          const previous = oldProperties.get(name)
          const next = newProperties.get(name)
          const child = propertyPath(path, name)
          if (previous === undefined || next === undefined) {
            emit(previous === undefined ? 'property-added' : 'property-removed', left, right, child, name)
            continue
          }
          if (previous.optional !== next.optional) emit(next.optional ? 'property-made-optional' : 'property-made-required', left, right, child, name)
          if (JSON.stringify(previous.compatibility) !== JSON.stringify(next.compatibility)) emit('source-policy-changed', left, right, child, name)
          walk(previous.type, next.type, child, active)
        }
        const oldIndices = new Map(oldNode.indices.map(index => [digest('before', index.key), index]))
        const newIndices = new Map(newNode.indices.map(index => [digest('after', index.key), index]))
        if (oldIndices.size !== newIndices.size || [...oldIndices.keys()].some(key => !newIndices.has(key))) emit('index-signature-changed', left, right, path)
        for (const [key, index] of oldIndices) {
          const next = newIndices.get(key)
          if (next !== undefined) walk(index.value, next.value, `${path}[*]`, active)
        }
      } else if (oldNode.kind === 'array' && newNode.kind === 'array') {
        walk(oldNode.element, newNode.element, `${path}[]`, active)
      } else if (oldNode.kind === 'tuple' && newNode.kind === 'tuple') {
        if (oldNode.elements.length !== newNode.elements.length) emit('tuple-length-changed', left, right, path)
        for (const [position, previous] of oldNode.elements.entries()) {
          const next = newNode.elements[position]
          if (next === undefined) continue
          const child = `${path}[${String(position)}]`
          if (previous.optional !== next.optional || previous.rest !== next.rest) emit('tuple-element-cardinality-changed', left, right, child)
          walk(previous.type, next.type, child, active)
        }
      } else if (oldNode.kind === 'union' && newNode.kind === 'union') {
        const oldByHash = new Map(oldNode.types.map(index => [digest('before', index), index]))
        const newByHash = new Map(newNode.types.map(index => [digest('after', index), index]))
        const removed = [...oldByHash].filter(([hash]) => !newByHash.has(hash)).map(([, index]) => index)
        const added = [...newByHash].filter(([hash]) => !oldByHash.has(hash)).map(([, index]) => index)
        // Uniqueness includes unchanged arms: a shared discriminator cannot identify a changed sibling.
        const unique = (schema: CanonicalSchema, indices: readonly number[]): Map<string, number> => {
          const candidates = new Map<string, number[]>()
          for (const index of indices) {
            const key = selector(schema, index)
            if (key !== undefined) candidates.set(key, [...candidates.get(key) ?? [], index])
          }
          return new Map([...candidates].flatMap(([key, values]) => values.length === 1 ? [[key, values[0] as number]] : []))
        }
        const oldSelectors = unique(oldSchema, oldNode.types)
        const newSelectors = unique(newSchema, newNode.types)
        const matchedOld = new Set<number>()
        const matchedNew = new Set<number>()
        for (const [key, previous] of oldSelectors) {
          const next = newSelectors.get(key)
          if (next === undefined || !removed.includes(previous) || !added.includes(next)) continue
          walk(previous, next, path + key, active)
          matchedOld.add(previous)
          matchedNew.add(next)
        }
        const oldKinds = sourceKindGroups(oldSchema.nodes, left)
        const newKinds = sourceKindGroups(newSchema.nodes, right)
        for (const [side, indices, matched, schema] of [
          ['before', removed, matchedOld, oldSchema], ['after', added, matchedNew, newSchema],
        ] as const) {
          for (const index of indices) {
            if (matched.has(index)) continue
            const ownKinds = side === 'before' ? oldKinds : newKinds
            const otherKinds = side === 'before' ? newKinds : oldKinds
            const kind = [...ownKinds ?? []].find(([, members]) => members.includes(index))?.[0]
            const wholeKind = kind !== undefined && otherKinds !== undefined && !otherKinds.has(kind)
            const suffix = selector(schema, index) ?? ''
            emit(`${wholeKind ? 'kind' : 'variant'}-${side === 'before' ? 'removed' : 'added'}`,
              side === 'before' ? index : null, side === 'after' ? index : null, path + suffix)
          }
        }
      } else emit('type-changed', left, right, path)
    }
    walk(0, 0, root, new Set())
  }

  const oldTypes = new Set(before.types.map(type => type.digest))
  return { schemaVersion: 1, roots, unchangedTypes: after.types.filter(type => oldTypes.has(type.digest)).length,
    evidence: [...evidence].sort(([a], [b]) => compareText(a, b)).map(([, item]) => ({ ...item,
      locations: [...item.locations.values()].sort((a, b) => compareText(a.root, b.root) || compareText(a.path, b.path)),
    })) }
}

function code(value: string): string {
  return '`' + value.replaceAll('`', '\\`').replaceAll('|', '\\|') + '`'
}

/**
 * Render concise evidence separately from every authoritative root diagnostic.
 * @param report - result of the explicit inventory comparison.
 * @returns Markdown with full fingerprints in expandable evidence.
 */
export function renderPersistenceReview(report: PersistenceReview): string {
  const lines = ['# Persistence schema review', '', `${String(report.roots.length)} changed roots; ${String(report.unchangedTypes)} unchanged type fingerprints.`, '',
    '## Structural evidence', '', 'Display paths use literal discriminators. Ambiguous alternatives remain separate additions and removals; this explanation does not decide compatibility.', '']
  for (const root of report.roots) {
    if (root.before === null || root.after === null) lines.push(`- Root ${root.before === null ? 'added' : 'removed'}: ${code(root.root)}.`)
  }
  for (const item of report.evidence) {
    lines.push('', `<details><summary>${item.kind}${item.field === undefined ? '' : `: ${item.field.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}`}</summary>`, '',
      `Before: ${item.before === null ? 'absent' : code(item.before)}; after: ${item.after === null ? 'absent' : code(item.after)}.`, '',
      ...item.locations.map(location => `- ${code(location.path)}`), '', '</details>')
  }
  lines.push('', '## Authoritative compatibility results', '')
  for (const root of report.roots) {
    lines.push(`### ${code(root.root)}`, '', `Decision: **${root.changes.some(change => change.requiresVersionBump) ? 'version-bump' : 'same-version'}**.`, '',
      ...root.changes.map(change => `- ${code(change.path)}: ${change.description} (${code(change.kind)}; requiresVersionBump: ${String(change.requiresVersionBump)}).`), '')
  }
  return lines.join('\n').trimEnd() + '\n'
}

/**
 * Read two explicit inventory files and return Markdown or JSON without mutating either.
 * @param args - --before and --after paths, and optional --json.
 * @returns structural evidence and exact compatibility results.
 */
export function runPersistenceReview(args: readonly string[]): string {
  const { values } = parseArgs({ args: [...args], options: { before: { type: 'string' }, after: { type: 'string' }, json: { type: 'boolean' } }, strict: true, allowPositionals: false })
  if (values.before === undefined || values.after === undefined) throw new Error('persistence review: --before and --after inventory paths are required')
  const read = (path: string): PersistenceSchemaInventory => parsePersistenceSnapshot(JSON.parse(readFileSync(path, 'utf8')))
  const report = reviewPersistenceSchemas(read(values.before), read(values.after))
  return values.json ? JSON.stringify(report, null, 2) + '\n' : renderPersistenceReview(report)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  try {
    process.stdout.write(runPersistenceReview(process.argv.slice(2)))
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
