/** Build-time native admission metadata derived from the shared operation definitions. */
import { z } from 'zod'
import type { JSONSchema } from 'zod/v4/core'
import { NativeOnlyOperations, NativeResourceParameters, Request } from './protocol.ts'

type Schema = JSONSchema.JSONSchema

function object(schema: Schema | boolean | undefined): Schema {
  if (schema === undefined || typeof schema === 'boolean') throw new Error('CUA protocol requires an object schema at this position')
  return schema
}
function variants(schema: Schema): Schema[] { return schema.anyOf ?? schema.oneOf ?? [schema] }

/**
 * Derive native request schemas and admission fields from the shared operation definitions.
 * @param permissionFields Platform-specific parameters for user-facing permission controls.
 * @returns Native field and enum tables and the complete wire schema.
 */
export function nativeProtocol(permissionFields: Partial<Record<'requestPermission' | 'openPermissionSettings', z.ZodObject>> = {}): {
  fields: Map<string, Set<string>>
  enums: Map<string, Map<string, Set<string>>>
  json: string
} {
  const resources = new Map(Object.entries({ ...NativeResourceParameters, ...permissionFields }))
  const schemas = [...Request.options, ...NativeOnlyOperations]
    .map(schema => z.toJSONSchema(schema))
  const fields = new Map<string, Set<string>>()
  const enums = new Map<string, Map<string, Set<string>>>()
  for (const schema of schemas) {
    const method = object(schema.properties?.method).const
    if (typeof method !== 'string') throw new Error('CUA method must be one string literal')
    const nativeVariants = variants(object(schema.properties?.params)).filter((variant) => {
      const relative = variant.properties?.relative
      return relative === undefined || typeof relative === 'boolean' || relative.const !== true
    })
    const params = nativeVariants.length === 1 ? object(nativeVariants[0]) : { anyOf: nativeVariants }
    schema.properties = { ...schema.properties, params }
    const extension = resources.get(method)
    for (const variant of variants(params)) {
      // The Host resolves image pixels and relative coordinates before native dispatch.
      if (variant.properties) delete variant.properties.relative
      if (variant.required) variant.required = variant.required.filter(name => name !== 'relative')
      if (extension !== undefined) {
        const extra = z.toJSONSchema(extension)
        if (variant.type !== 'object') throw new Error(`Host fields require object parameters: ${method}`)
        variant.properties = { ...variant.properties, ...extra.properties }
        variant.required = [...new Set([...(variant.required ?? []), ...(extra.required ?? [])])]
      }
    }
    schema.properties = { id: { type: 'string' }, ...schema.properties }
    schema.required = ['id', 'method', 'params']
    // Each embedded resource resolves its recursive JSON value references against its own definitions.
    if (schema.$defs) schema.$id = `urn:deepseek-harness:cua:request:${method}`
    delete schema.$schema
    const names = new Set<string>()
    const values = new Map<string, Set<string>>()
    for (const variant of variants(params)) {
      for (const [name, raw] of Object.entries(variant.properties ?? {})) {
        names.add(name)
        const property = object(raw)
        const item = property.type === 'array' && !Array.isArray(property.items) ? object(property.items) : property
        const allowed = item.enum?.filter((value): value is string => typeof value === 'string')
        if (allowed?.length) {
          const union = values.get(name) ?? new Set<string>()
          for (const value of allowed) union.add(value)
          values.set(name, union)
        }
      }
    }
    fields.set(method, names)
    if (values.size) enums.set(method, values)
  }
  return { fields, enums, json: JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $comment: 'Generated from the shared CUA operation schema. Do not edit.',
    title: 'dsh-cua native request',
    description: 'Host resource fields and private continuations are not model tool parameters. App handles and snapshots belong to one helper; coordinates use window-local native units.',
    oneOf: schemas,
  }, null, 2) + '\n' }
}
