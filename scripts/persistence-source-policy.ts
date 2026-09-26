/** Literal source groups and the supported reader promise saved in schema history. */

import type { SchemaNode, SchemaProperty, SourceCompatibility } from './persistence-schema-model.ts'

// Reserve role and shared-consumer identities, frozen rename targets, and request-only producer identities against reuse.
// Existing kinds outside this set also reject retroactive qualification during comparison.
const RESERVED_SOURCE_KINDS = new Set([
  'user', 'model', 'tool', 'system-prompt', 'compact-checkpoint', 'dsh-session-title-llm', 'tool-registry', 'runtime-context', 'plugin',
  'auto-review', 'compact-basic', 'ptc-mode',
])

/**
 * Group source alternatives by their required literal wire discriminator.
 * @param nodes - self-contained type graph.
 * @param index - source property value.
 * @returns kind groups, or undefined when any alternative is not a closed source record.
 */
export function sourceKindGroups(nodes: readonly SchemaNode[], index: number): Map<string, number[]> | undefined {
  const source = nodes[index]
  const alternatives = source?.kind === 'union' ? source.types : [index]
  const groups = new Map<string, number[]>()
  for (const alternative of alternatives) {
    const node = nodes[alternative]
    if (node?.kind !== 'object') return undefined
    const property = node.properties.find(property => property.name === 'kind')
    const kind = property === undefined ? undefined : nodes[property.type]
    if (property?.optional !== false || kind?.kind !== 'literal' || typeof kind.value !== 'string' || kind.value.length === 0) return undefined
    const group = groups.get(kind.value) ?? []
    group.push(alternative)
    groups.set(kind.value, group)
  }
  return groups
}

/**
 * Validate the supported policy and its containing message/source declaration.
 * @param nodes - self-contained graph.
 * @param owner - object carrying the explicitly bound source property.
 * @param property - bound source property.
 * @returns whether the metadata authorizes source-group comparison.
 */
export function validSourceCompatibility(
  nodes: readonly SchemaNode[], owner: SchemaNode, property: SchemaProperty,
): boolean {
  const policy = property.compatibility
  if (policy === undefined || property.name !== 'source' || property.optional || owner.kind !== 'object') return false
  const roleProperty = owner.properties.find(property => property.name === 'role')
  const role = roleProperty === undefined ? undefined : nodes[roleProperty.type]
  if (roleProperty?.optional !== false || role?.kind !== 'literal'
    || !(role.value === 'user' && policy.binding === 'session.user-message.source'
      || role.value === 'developer' && policy.binding === 'session.developer-message.source')) return false
  const groups = sourceKindGroups(nodes, property.type)
  return groups !== undefined && policy.attributionKinds.every(kind => groups.has(kind) && !RESERVED_SOURCE_KINDS.has(kind))
}

/**
 * Check that both recorded promises agree and no existing kind changes qualification.
 * Both inputs are validated v1 policies with fixed policy, discriminator, and preservation fields.
 * @param before - predecessor promise.
 * @param after - successor promise.
 * @param existingKinds - predecessor wire kinds, including semantic groups.
 * @returns whether the additive rule applies to this transition.
 */
export function matchingSourceCompatibility(
  before: SourceCompatibility, after: SourceCompatibility, existingKinds: Iterable<string>,
): boolean {
  return before.binding === after.binding
    && [...existingKinds].every(kind => before.attributionKinds.includes(kind) === after.attributionKinds.includes(kind))
}
