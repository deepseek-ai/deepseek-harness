/** Derive editable forms and plain values from plugin Config schemas. */
import { redactSecrets } from './redact.ts'
import z from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'

/** Remove runtime references from a configuration snapshot.
 * @param value Parsed Config output.
 * @returns Detached ordinary values suitable for redaction and forms.
 */
export function plainConfig(value: unknown): unknown {
  if (isVolatile(value)) return plainConfig(value.get())
  if (Array.isArray(value)) return value.map(plainConfig)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainConfig(child)]))
  }
  return value
}

function plainSchema(schema: z): z {
  const result = new z(schema.toJSON())
  const walk = (node: z): void => {
    delete node.meta.volatile
    if (node.meta.role === 'secret') { delete node.meta.default; delete node.meta.required }
    else if (node.meta.default !== undefined) node.meta.default = redactSecrets(node as z<never>, node.meta.default).value
    for (const child of Object.values(node.dict ?? {})) walk(child)
    if (node.inner) walk(node.inner)
    for (const child of node.list ?? []) walk(child)
  }
  walk(result)
  return result
}

/** Select fields whose nearest volatile ancestor makes them editable without remounting.
 * @param schema The plugin's Config schema.
 * @returns A plain form schema, or undefined when no field is live.
 */
export function volatileForm(schema: z): z | undefined {
  if (schema.meta.volatile) return plainSchema(schema)
  if (schema.type === 'object') {
    const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
      const field = volatileForm(child)
      return field === undefined ? [] : [[key, field]]
    }))
    return Object.keys(dict).length === 0 ? undefined : z.object(dict)
  }
  return undefined
}

/** Whether a raw config node is an unevaluated `!!js` expression, kept whole rather than projected field by field. */
function isExpression(value: object): boolean {
  return Object.keys(value).length === 1 && typeof Reflect.get(value, '__jsExpr') === 'string'
}

/** Project only schema-declared fields, excluding ordinary configuration.
 * @param schema The filtered form schema.
 * @param value Plain raw or resolved config.
 * @returns The fields visible to this form.
 */
export function projectForm(schema: z, value: unknown): unknown {
  if (schema.type === 'object' && value !== null && typeof value === 'object' && !isExpression(value)) {
    return Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
      const field: unknown = Reflect.get(value, key)
      return field === undefined ? [] : [[key, projectForm(child, field)]]
    }))
  }
  return value
}

/** Check that a field path lies beneath a declared volatile node.
 * @param schema Complete plugin Config schema.
 * @param path Field path addressed by a form edit.
 * @returns Whether the path can be edited live.
 */
export function isVolatilePath(schema: z, path: readonly string[]): boolean {
  if (schema.meta.volatile) return true
  const [key, ...rest] = path
  const child = key === undefined ? undefined : schema.dict?.[key]
  return child !== undefined && isVolatilePath(child, rest)
}
