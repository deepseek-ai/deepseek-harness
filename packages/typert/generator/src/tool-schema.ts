/** Lossless projection into the harness tool-schema subset. */

import type { MemberModel, TypeNodeId } from './model.ts'
import { TypeGraphRenderer } from './renderer.ts'

/** A resolved codec whose type the tool-schema subset cannot represent without weakening constraints. */
export class ToolSchemaError extends Error {
  override name = 'ToolSchemaError'
}

interface Schema extends Record<string, unknown> {
  type?: string
  const?: string | number | boolean | null
  enum?: (string | number | boolean | null)[]
  oneOf?: Schema[]
  properties?: Record<string, Schema>
  required?: string[]
  additionalProperties?: boolean
  items?: Schema
  description?: string
}

/**
 * Project one resolved type into the tool-schema subset that `@deepseek-ai/dsh-tools`
 * enforces on tool parameters, tool output, and the generated PTC SDK. A type the
 * subset cannot express without weakening constraints raises {@link ToolSchemaError},
 * which callers report as an absent projection rather than a narrower schema.
 * @param renderer - complete analyzed type graph.
 * @param type - resolved wire type.
 * @param closedObjects - close declared request objects with `additionalProperties: false`.
 * @param optional - omit a top-level undefined alternative supplied by an optional argument.
 * @returns an acyclic schema in the tool-schema subset.
 */
export function projectToolSchema(
  renderer: TypeGraphRenderer, type: TypeNodeId, closedObjects = false, optional = false,
): Record<string, unknown> {
  const active = new Set<TypeNodeId>()
  const fail = (subject: string): never => { throw new ToolSchemaError(`typert tool schema: ${subject}`) }
  const project = (id: TypeNodeId, optional = false): Schema => {
    const node = renderer.node(id)
    if (node.json) return {}
    if (active.has(id)) return fail('recursive selected type requires a supported JSON value declaration')
    active.add(id)
    try {
      switch (node.kind) {
        case 'keyword': {
          if (['string', 'number', 'boolean'].includes(node.name)) return { type: node.name }
          return fail(`unsupported ${node.name} value`)
        }
        case 'literal': {
          if (typeof node.value === 'bigint') return fail('bigint is not JSON')
          return { type: node.value === null ? 'null' : typeof node.value, const: node.value }
        }
        case 'parenthesized': return project(node.type, optional)
        case 'array': return { type: 'array', items: project(node.element) }
        case 'object': return object(node.members)
        case 'reference': {
          if (node.target.kind !== 'declaration' || node.arguments.length !== 0) {
            return fail(`unsupported selected reference ${node.name}`)
          }
          const declaration = renderer.declaration(node.target.symbol)
          const schema = declaration.kind === 'alias' && declaration.type !== undefined
            ? project(declaration.type, optional)
            : object(declaration.members)
          if (declaration.extends.length > 0) return fail('unresolved inherited selected type')
          return declaration.description === undefined ? schema : { ...schema, description: declaration.description }
        }
        case 'union': {
          const branches = node.types.filter((item) => {
            const branch = renderer.node(item)
            return !(optional && branch.kind === 'keyword' && branch.name === 'undefined')
          }).map(item => project(item))
          return union(branches)
        }
        default: return fail(`unsupported selected ${node.kind} type`)
      }
    } finally {
      active.delete(id)
    }
  }
  const object = (members: readonly MemberModel[]): Schema => {
    const properties: Record<string, Schema> = {}
    const required: string[] = []
    let indexed = false
    for (const member of members) {
      if (member.static || member.visibility !== 'public' || member.computed === 'symbol') continue
      if (member.kind === 'index') {
        const key = member.signature.parameters[0]
        if (key === undefined || project(key.type).type !== 'string'
          || Object.keys(project(member.signature.returns)).length !== 0) {
          return fail('selected dictionaries require string keys and unconstrained JSON values')
        }
        indexed = true
        continue
      }
      if (member.kind !== 'property' || member.computed === 'dynamic') return fail(`unsupported member ${member.name}`)
      const name = member.jsonName ?? member.name
      const schema = project(member.type, member.optional)
      properties[name] = member.description === undefined ? schema : { ...schema, description: member.description }
      if (!member.optional) required.push(name)
    }
    return { type: 'object', properties, required, additionalProperties: indexed || !closedObjects }
  }
  const union = (input: Schema[]): Schema => {
    if (input.some(branch => Object.keys(branch).length === 0)) return {}
    const branches: Schema[] = []
    for (const branch of input) {
      const scalar = branch.type !== undefined && !['object', 'array'].includes(branch.type)
      const previous = scalar ? branches.find(candidate => candidate.type === branch.type) : undefined
      if (previous === undefined) { branches.push(branch); continue }
      const values = literals(previous)
      const next = literals(branch)
      if (values === undefined || next === undefined) {
        delete previous.const
        delete previous.enum
      } else {
        delete previous.const
        previous.enum = [...new Set([...values, ...next])]
      }
    }
    if (branches.length === 1) return branches[0] as Schema
    if (branches.length === 0) return fail('empty selected union')
    for (const [index, left] of branches.entries()) {
      for (const right of branches.slice(index + 1)) {
        if (!disjoint(left, right)) return fail('selected union branches overlap or have no required discriminator')
      }
    }
    return { oneOf: branches }
  }
  return project(type, optional)
}

function literals(schema: Schema): (string | number | boolean | null)[] | undefined {
  if (schema.const !== undefined) return [schema.const]
  return schema.enum
}

function disjoint(left: Schema, right: Schema): boolean {
  if (left.oneOf !== undefined) return left.oneOf.every(branch => disjoint(branch, right))
  if (right.oneOf !== undefined) return right.oneOf.every(branch => disjoint(left, branch))
  if (left.type !== right.type) return left.type !== undefined && right.type !== undefined
  if (left.type !== 'object' || right.type !== 'object') return false
  return (left.required ?? []).some((name) => {
    if (!right.required?.includes(name)) return false
    const a = left.properties?.[name]
    const b = right.properties?.[name]
    if (a === undefined || b === undefined) return false
    const first = literals(a)
    const second = literals(b)
    return first !== undefined && second !== undefined && first.every(value => !second.includes(value))
  })
}
