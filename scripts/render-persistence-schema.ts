/** Readable, linked persistence schemas rendered from the fingerprint inventory. */

import { githubSlug } from './verify-md-links.ts'
import { persistenceCatalogText, type PersistenceCatalogLocale } from './persistence-catalog-text.ts'
import { sourceKindGroups } from './persistence-source-policy.ts'
import {
  canonicalizeSchema,
  schemaChildren,
  schemaDigest,
  type CanonicalSchema,
  type PersistenceSchemaInventory,
  type PersistenceType,
  type SchemaNode,
} from './persistence-schema-model.ts'

interface TypeDisplay {
  readonly type: PersistenceType
  readonly label: string
  readonly anchor: string
  readonly aliases: readonly string[]
}

/** Current catalogs use structural links; historical references retain their original labels and anchors. */
export type PersistenceSchemaRendering = 'current' | 'historical'

function code(text: string): string {
  return '`' + text.replaceAll('`', '\\`').replaceAll('|', '\\|') + '`'
}

function sourcePath(source: string): string {
  return source.replace(/:\d+(?::\d+)?$/u, '')
}

function nodeAt(schema: CanonicalSchema, index: number): SchemaNode {
  const node = schema.nodes[index]
  if (!node) throw new Error(`persistence catalog: missing schema node ${String(index)}`)
  return node
}

function childPath(node: SchemaNode, position: number): string {
  switch (node.kind) {
    case 'object': return node.properties[position]?.name ?? `index-${String(position - node.properties.length)}`
    case 'array': return 'item'
    case 'tuple': return `item-${String(position)}`
    case 'union': return `variant-${String(position)}`
    case 'primitive':
    case 'literal':
    case 'opaque': return String(position)
    default: return assertNever(node)
  }
}

function historicalDisplays(inventory: PersistenceSchemaInventory): Map<string, TypeDisplay> {
  const paths = new Map<string, string>()
  for (const root of inventory.roots) {
    const seen = new Set<number>()
    const visit = (index: number, path: string): void => {
      if (seen.has(index)) return
      seen.add(index)
      const digest = schemaDigest(canonicalizeSchema(root.schema.nodes, index))
      if (!paths.has(digest)) paths.set(digest, path)
      const node = nodeAt(root.schema, index)
      schemaChildren(node).forEach((child, position) => { visit(child, `${path}.${childPath(node, position)}`) })
    }
    visit(0, root.key)
  }
  const labels = inventory.types.map((type) => {
    const node = nodeAt(type.schema, 0)
    const label = node.kind === 'primitive' ? node.type
      : node.kind === 'literal' ? JSON.stringify(node.value)
        : node.kind === 'opaque' ? node.reason
          : type.names[0] ?? paths.get(type.digest) ?? node.kind
    return { type, label }
  })
  const counts = new Map<string, number>()
  for (const { label } of labels) counts.set(label, (counts.get(label) ?? 0) + 1)
  const used = new Set<string>()
  return new Map(labels.map(({ type, label: original }) => {
    const label = (counts.get(original) ?? 0) > 1
      ? `${original} (${type.sources[0] ? sourcePath(type.sources[0]) : paths.get(type.digest) ?? 'anonymous'})`
      : original
    const base = `persistence-type-${githubSlug(label)}`
    let anchor = base
    for (let suffix = 2; used.has(anchor); suffix += 1) anchor = `${base}-${String(suffix)}`
    used.add(anchor)
    return [type.digest, { type, label, anchor, aliases: [] }]
  }))
}

function structuralLabel(schema: CanonicalSchema, includeFields = false): string {
  const node = nodeAt(schema, 0)
  switch (node.kind) {
    case 'primitive': return node.type
    case 'literal': return JSON.stringify(node.value)
    case 'opaque': return node.reason
    case 'object': {
      const tags = ['type', 'kind', 'role', 'form'].flatMap((name) => {
        const property = node.properties.find(candidate => candidate.name === name && !candidate.optional)
        const value = property === undefined ? undefined : nodeAt(schema, property.type)
        return value?.kind === 'literal' ? [`${name}: ${JSON.stringify(value.value)}`] : []
      })
      const fields = tags.length > 0 && !includeFields ? tags : node.properties.map((property) => {
        const tag = tags.find(tag => tag.startsWith(property.name + ':'))
        return tag ?? `${property.name}${property.optional ? '?' : ''}`
      })
      if (fields.length === 0) return '{}'
      return `{ ${fields.slice(0, 4).join(', ')}${fields.length > 4 ? ', …' : ''} }`
    }
    case 'array': return 'array'
    case 'tuple': return `tuple (${String(node.elements.length)} positions)`
    case 'union': return `union (${String(node.types.length)} variants)`
    default: return assertNever(node)
  }
}

function currentDisplays(inventory: PersistenceSchemaInventory): Map<string, TypeDisplay> {
  const roots = new Map<string, string[]>()
  for (const root of inventory.roots) roots.set(root.digest, [...roots.get(root.digest) ?? [], root.key])
  const aliases = new Map<string, Set<string>>()
  const namesByDigest = new Map(inventory.types.map((type) => {
    const names = type.names.filter(name => !inventory.roots.some(root => name.startsWith(root.key + '.') || name.startsWith(root.key + '[')))
    const logicalNames = [...new Set([...names, ...roots.get(type.digest) ?? []])].sort()
    for (const name of logicalNames) {
      for (const value of new Set([name, name.slice(name.lastIndexOf('#') + 1)])) {
        const alias = `persistence-type-${githubSlug(value)}`
        const owners = aliases.get(alias) ?? new Set<string>()
        owners.add(type.digest)
        aliases.set(alias, owners)
      }
    }
    return [type.digest, names.filter(name => !roots.get(type.digest)?.includes(name)).sort()]
  }))
  const types = new Map(inventory.types.map(type => [type.digest, type]))
  const labelFor = (schema: CanonicalSchema, seen: ReadonlySet<string>, includeFields = false): string => {
    const digest = schemaDigest(schema)
    const node = nodeAt(schema, 0)
    if (node.kind === 'primitive' || node.kind === 'literal' || node.kind === 'opaque') return structuralLabel(schema)
    const named = namesByDigest.get(digest)?.find(name => aliases.get(`persistence-type-${githubSlug(name.slice(name.lastIndexOf('#') + 1))}`)?.size === 1)
    if (named !== undefined) return named.slice(named.lastIndexOf('#') + 1)
    if (seen.has(digest) || seen.size >= 4) return structuralLabel(schema, includeFields)
    if (node.kind === 'array') {
      const element = canonicalizeSchema(schema.nodes, node.element)
      const label = labelFor(types.get(schemaDigest(element))?.schema ?? element, new Set(seen).add(digest), includeFields)
      return `${label}[]`
    }
    return structuralLabel(schema, includeFields)
  }
  const labels = inventory.types.map(type => ({ type, label: labelFor(type.schema, new Set()), anchor: `persistence-type-sha256-${type.digest}` }))
  const counts = new Map<string, number>()
  for (const entry of labels) counts.set(entry.label, (counts.get(entry.label) ?? 0) + 1)
  for (const entry of labels) {
    if ((counts.get(entry.label) ?? 0) > 1) entry.label = labelFor(entry.type.schema, new Set(), true)
  }
  const structuralAnchors = new Set(labels.map(entry => entry.anchor))
  return new Map(labels.map(entry => [entry.type.digest, {
    ...entry,
    // A logical name shared by different structures has no unambiguous target.
    aliases: [...aliases].filter(([alias, owners]) => owners.size === 1 && owners.has(entry.type.digest) && !structuralAnchors.has(alias))
      .map(([alias]) => alias).sort(),
  }]))
}

function displays(inventory: PersistenceSchemaInventory, rendering: PersistenceSchemaRendering): Map<string, TypeDisplay> {
  return rendering === 'current' ? currentDisplays(inventory) : historicalDisplays(inventory)
}

function reference(digest: string, entries: ReadonlyMap<string, TypeDisplay>): string {
  const entry = entries.get(digest)
  if (!entry) throw new Error(`persistence catalog: reachable type ${digest} is absent from the inventory`)
  return `[${code(entry.label)}](#${entry.anchor})`
}

function typeExpression(
  schema: CanonicalSchema,
  index: number,
  entries: ReadonlyMap<string, TypeDisplay>,
  locale: PersistenceCatalogLocale,
): string {
  const node = nodeAt(schema, index)
  if (node.kind === 'primitive') return code(node.type)
  if (node.kind === 'literal') return code(JSON.stringify(node.value))
  if (node.kind === 'opaque') return `${code(node.reason)}${persistenceCatalogText[locale].opaque}`
  return reference(schemaDigest(canonicalizeSchema(schema.nodes, index)), entries)
}

function definition(
  entry: TypeDisplay,
  entries: ReadonlyMap<string, TypeDisplay>,
  locale: PersistenceCatalogLocale,
  sourceLink: (source: string) => string | undefined,
  headingLevel: number,
  rendering: PersistenceSchemaRendering,
): string[] {
  const text = persistenceCatalogText[locale]
  const schema = entry.type.schema
  const node = nodeAt(schema, 0)
  const lines = [...[entry.anchor, ...entry.aliases].flatMap(anchor => [`<a id="${anchor}"></a>`, '']), `${'#'.repeat(headingLevel)} ${code(entry.label)}`, '', `SHA-256: ${code(entry.type.digest)}`, '']
  if (entry.type.sources.length > 0) {
    lines.push(`${text.sources}${entry.type.sources.map((source) => {
      const href = sourceLink(sourcePath(source))
      return href === undefined ? code(source) : `[${code(source)}](${href})`
    }).join(' · ')}`, '')
  }
  const expression = (index: number): string => typeExpression(schema, index, entries, locale)
  switch (node.kind) {
    case 'object':
      if (node.properties.length === 0 && node.indices.length === 0) lines.push(text.emptyObject, '')
      else {
        lines.push(text.propertyColumns, '|---|---|---|')
        for (const property of node.properties) {
          lines.push(`| ${code(property.name)} | ${property.optional ? text.optional : text.required} | ${expression(property.type)} |`)
        }
        for (const index of node.indices) lines.push(`| [${expression(index.key)}] | ${text.index} | ${expression(index.value)} |`)
        lines.push('')
        if (rendering === 'current') {
          for (const property of node.properties) {
            const policy = property.compatibility
            if (policy === undefined) continue
            lines.push(`${text.sourceCompatibility}${code(property.name)} — ${code(policy.policy)} v${String(policy.version)}; ${code(policy.binding)}; ${code(policy.discriminator)}; ${code(policy.unknownKinds)}.`, '',
              `${text.attributionAdditions}${policy.attributionKinds.map(code).join(', ') || code('[]')}.`, '')
          }
        }
      }
      break
    case 'array': lines.push(`${text.arrayPrefix}${expression(node.element)}${text.arraySuffix}`, ''); break
    case 'tuple':
      lines.push(text.positionColumns, '|---|---|---|')
      node.elements.forEach((element, index) => {
        const presence = element.rest ? text.rest : element.optional ? text.optional : text.required
        lines.push(`| ${String(index)} | ${presence} | ${expression(element.type)} |`)
      })
      lines.push('')
      break
    case 'union': {
      const groups = rendering === 'current' ? sourceKindGroups(schema.nodes, 0) : undefined
      if (groups !== undefined) {
        lines.push(text.sourceColumns, '|---|---|---|---|')
        for (const [kind, alternatives] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
          const rows = alternatives.map((index) => {
            const variant = nodeAt(schema, index)
            if (variant.kind !== 'object') throw new Error('persistence catalog: source group must contain objects')
            const form = variant.properties.find(property => property.name === 'form')
            const formLabel = form === undefined ? text.notDeclared
              : `${expression(form.type)}${form.optional ? ` (${text.optional})` : ''}`
            const fields = variant.properties.filter(property => property.name !== 'kind' && property.name !== 'form' && !property.optional)
              .map(property => `${code(property.name)}: ${expression(property.type)}`)
            if (variant.indices.length > 0) fields.push(text.index)
            return { index, formLabel, fields, digest: schemaDigest(canonicalizeSchema(schema.nodes, index)) }
          }).sort((a, b) => a.formLabel.localeCompare(b.formLabel) || a.digest.localeCompare(b.digest))
          for (const row of rows) lines.push(`| ${code(kind)} | ${row.formLabel} | ${row.fields.join('; ') || text.none} | ${expression(row.index)} |`)
        }
        lines.push('')
      } else lines.push(text.oneOf, '', ...node.types.map(index => `- ${expression(index)}`), '')
      break
    }
    case 'primitive': lines.push(code(node.type), ''); break
    case 'literal': lines.push(code(JSON.stringify(node.value)), ''); break
    case 'opaque': lines.push(`${code(node.reason)}${text.opaqueExplanation}`, ''); break
    default: assertNever(node)
  }
  return lines
}

/**
 * Render every tracked root with its exact digest and resolved type reference.
 * @param inventory - complete current-source schemas and declaration metadata.
 * @param locale - generated document language.
 * @param introduction - paragraphs before the root table; defaults to current-source links.
 * @param headingLevel - section depth within the containing reference.
 * @param rendering - explicit current mode selects structural links; omission preserves historical output.
 * @returns Markdown index including the history and contributor workflow links.
 */
export function renderPersistenceSchemaIndex(
  inventory: PersistenceSchemaInventory,
  locale: PersistenceCatalogLocale = 'en',
  introduction: readonly string[] = [persistenceCatalogText[locale].fingerprintsIntro, persistenceCatalogText[locale].historyIntro],
  headingLevel: 2 | 3 = 2,
  rendering: PersistenceSchemaRendering = 'historical',
): string {
  const entries = displays(inventory, rendering)
  const text = persistenceCatalogText[locale]
  return [
    `${'#'.repeat(headingLevel)} ${text.fingerprints}`, '', ...introduction.flatMap(paragraph => [paragraph, '']),
    text.rootColumns, '|---|---|---|---|',
    ...inventory.roots.map(root => `| ${code(root.key)} | ${root.kind} | ${code(root.digest)} | ${reference(root.digest, entries)} |`), '',
  ].join('\n')
}

/**
 * Render every reachable type once, with links for shared and recursive definitions.
 * @param inventory - complete current-source schemas and declaration metadata.
 * @param locale - generated document language.
 * @param sourceLink - source path to URL; undefined keeps historical locations as text.
 * @param headingLevel - section depth; individual definitions use the next heading level.
 * @param rendering - explicit current mode selects structural links and unambiguous logical aliases.
 * @returns linked Markdown definitions; historical mode preserves the original named and owning-path anchors.
 */
export function renderPersistenceSchemaDefinitions(
  inventory: PersistenceSchemaInventory,
  locale: PersistenceCatalogLocale = 'en',
  sourceLink: (source: string) => string | undefined = source => `../${source}`,
  headingLevel: 2 | 3 = 2,
  rendering: PersistenceSchemaRendering = 'historical',
): string {
  const entries = displays(inventory, rendering)
  const text = persistenceCatalogText[locale]
  const sorted = [...entries.values()].sort((left, right) => {
    if (rendering === 'current' && left.label !== right.label) return left.label < right.label ? -1 : 1
    return left.anchor < right.anchor ? -1 : left.anchor > right.anchor ? 1 : 0
  })
  return [
    `${'#'.repeat(headingLevel)} ${text.definitions}`, '', text.definitionsIntro, '',
    ...sorted.flatMap(entry => definition(entry, entries, locale, sourceLink, headingLevel + 1, rendering)),
  ].join('\n')
}

function assertNever(value: never): never {
  throw new Error(`persistence catalog: unsupported type ${JSON.stringify(value)}`)
}
