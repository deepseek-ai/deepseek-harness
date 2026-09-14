/** Readable, linked persistence schemas rendered from the fingerprint inventory. */

import { githubSlug } from './verify-md-links.ts'
import { persistenceCatalogText, type PersistenceCatalogLocale } from './persistence-catalog-text.ts'
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
}

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

function displays(inventory: PersistenceSchemaInventory): Map<string, TypeDisplay> {
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
    return [type.digest, { type, label, anchor }]
  }))
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
): string[] {
  const text = persistenceCatalogText[locale]
  const schema = entry.type.schema
  const node = nodeAt(schema, 0)
  const lines = [`<a id="${entry.anchor}"></a>`, '', `${'#'.repeat(headingLevel)} ${code(entry.label)}`, '', `SHA-256: ${code(entry.type.digest)}`, '']
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
    case 'union':
      lines.push(text.oneOf, '', ...node.types.map(index => `- ${expression(index)}`), '')
      break
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
 * @returns Markdown index including the history and contributor workflow links.
 */
export function renderPersistenceSchemaIndex(
  inventory: PersistenceSchemaInventory,
  locale: PersistenceCatalogLocale = 'en',
  introduction: readonly string[] = [persistenceCatalogText[locale].fingerprintsIntro, persistenceCatalogText[locale].historyIntro],
  headingLevel: 2 | 3 = 2,
): string {
  const entries = displays(inventory)
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
 * @returns Markdown definitions whose anchors use names or owning paths instead of hashes.
 */
export function renderPersistenceSchemaDefinitions(
  inventory: PersistenceSchemaInventory,
  locale: PersistenceCatalogLocale = 'en',
  sourceLink: (source: string) => string | undefined = source => `../${source}`,
  headingLevel: 2 | 3 = 2,
): string {
  const entries = displays(inventory)
  const text = persistenceCatalogText[locale]
  const sorted = [...entries.values()].sort((left, right) => left.anchor < right.anchor ? -1 : left.anchor > right.anchor ? 1 : 0)
  return [
    `${'#'.repeat(headingLevel)} ${text.definitions}`, '', text.definitionsIntro, '',
    ...sorted.flatMap(entry => definition(entry, entries, locale, sourceLink, headingLevel + 1)),
  ].join('\n')
}

function assertNever(value: never): never {
  throw new Error(`persistence catalog: unsupported type ${JSON.stringify(value)}`)
}
