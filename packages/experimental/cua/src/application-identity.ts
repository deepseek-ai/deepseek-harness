/** Permission-only application matching; native discovery identifiers remain opaque. */
import { z } from 'zod'
import type { CuaApplicationId } from './application-types.ts'

/** Nonempty values are compared only within the same provider-qualified attribute. */
export const ApplicationAttributes = z.record(z.string().min(1), z.array(z.string().min(1)))
/** Observed attributes; providers without additional metadata use their existing identity alone. */
export interface ApplicationIdentity {
  id: CuaApplicationId
  attributes?: z.infer<typeof ApplicationAttributes> | undefined
}

/**
 * Collect observations without changing their attribute namespaces.
 * @param identities Native observations or stored permission records.
 * @returns Deduplicated attribute sets, including every observed native identity.
 */
export function applicationAttributes(...identities: readonly ApplicationIdentity[]): z.infer<typeof ApplicationAttributes> {
  const sets = new Map<string, Set<string>>()
  for (const identity of identities) {
    for (const [key, values] of Object.entries(identity.attributes ?? {})) {
      const set = sets.get(key) ?? new Set<string>()
      for (const value of values) set.add(value)
      sets.set(key, set)
    }
    const ids = sets.get('cua.id') ?? new Set<string>()
    ids.add(identity.id)
    sets.set('cua.id', ids)
  }
  return Object.fromEntries([...sets].map(([key, values]) => [key, [...values]]))
}

/**
 * Find the connected permission group, including observations that bridge existing records.
 * @param applications Stored records keyed by their original authorization ID.
 * @param identity Newly observed application or an existing record's ID.
 * @returns Matching records in storage order; no permission or metadata is changed.
 */
export function matchingApplications<T extends { attributes?: z.infer<typeof ApplicationAttributes> | undefined }>(
  applications: Readonly<Record<string, T>>, identity: ApplicationIdentity,
): Array<[CuaApplicationId, T]> {
  const matched = new Map<CuaApplicationId, T>()
  let attributes = applicationAttributes(identity)
  let added: boolean
  do {
    added = false
    for (const [key, app] of Object.entries(applications)) {
      const id = key as CuaApplicationId
      if (matched.has(id)) continue
      const candidate = applicationAttributes({ id, attributes: app.attributes })
      if (!Object.entries(candidate).some(([name, values]) => values.some(value => attributes[name]?.includes(value)))) continue
      matched.set(id, app)
      attributes = applicationAttributes({ id: identity.id, attributes }, { id, attributes: app.attributes })
      added = true
    }
  } while (added)
  return [...matched]
}
