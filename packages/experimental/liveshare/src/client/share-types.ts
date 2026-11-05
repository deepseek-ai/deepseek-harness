/** Shared owner-facing share records read from the owner share-management Remote. */

import type { ViewerSessionMode } from './viewer-capabilities.ts'

import type { ShareCapabilityGroup, ViewerPluginPolicy } from '../share-api-types.ts'

/** One installed plugin's Remote methods the Host offers a share. */
export type OfferedPlugin = ShareCapabilityGroup

export type { ViewerPluginPolicy }

/** One owner-created share listed by the global management UI. */
export interface OutgoingShare {
  readonly shareId: string
  readonly sessionId: string
  readonly sessionTitle: string
  readonly link: string
  readonly createdAt: string
  /**
   * The session permission the owner set for this share. Absent when the owner's Harness does not
   * report a mode at all, which is stated as unsupported rather than as the narrowest one.
   */
  readonly sessionMode?: ViewerSessionMode
  /**
   * Whether this share lets an admitted viewer fork it.
   *
   * Independent of the tier: absent on a Host that does not report it, which reads as off.
   */
  readonly allowsFork?: boolean
  /**
   * Per-plugin endpoint policies this share carries, as the owner's Harness reports them.
   *
   * Absent means no plugin endpoint reaches this share's viewers.
   */
  readonly viewerPlugins?: readonly ViewerPluginPolicy[]
  /** Global switch over every installed plugin's methods; absent reads as none. */
  readonly viewerPluginAccess?: 'all' | 'none' | 'custom'
  /** ISO time after which the Relay denies viewers; absent means it never expires. */
  readonly expiresAt?: string
  readonly online: boolean
  readonly access?: unknown
}

/** One durable audit entry shown in the owner share history. */
export interface ShareAuditEntry {
  readonly id: string
  readonly action: string
  readonly createdAt: string
  readonly actor?: string
}

/** Browser-safe summary of the persisted ACL scope for one share. */
export interface ConfirmedShareAccess {
  readonly mode: 'open' | 'selected'
  readonly selectedCount: number
  readonly deploymentCount: number
}

/**
 * Normalize one share access payload into a browser-safe summary.
 * @param value Raw `access` field from the owner share list.
 * @returns Confirmed mode and counts, or undefined for legacy or malformed records.
 */
export function readAccess(value: unknown): ConfirmedShareAccess | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const access = value as Record<string, unknown>
  if ((access.mode !== 'open' && access.mode !== 'selected')
    || !Array.isArray(access.selected) || !Array.isArray(access.deploymentAllowedSubjectIds)) return undefined
  return {
    mode: access.mode,
    selectedCount: access.selected.length,
    deploymentCount: access.deploymentAllowedSubjectIds.length,
  }
}

/**
 * Read one endpoint list out of a decoded entry.
 * @param value Raw endpoint list field.
 * @returns The endpoint names, or undefined when the value is not an array of strings.
 */
function readEndpointList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const endpoints: string[] = []
  for (const endpoint of value) {
    if (typeof endpoint !== 'string') return undefined
    endpoints.push(endpoint)
  }
  return endpoints
}

/**
 * Read one share's global plugin switch.
 * @param value Raw `viewerPluginAccess` field.
 * @returns The reported switch; an unknown or absent value reads as `none`.
 */
export function readPluginAccess(value: unknown): 'all' | 'none' | 'custom' {
  return value === 'all' || value === 'custom' ? value : 'none'
}

/**
 * Normalize the host-reported catalog into the plugins this page can present.
 *
 * A Host that reports nothing, or one malformed entry, leaves no offer for that entry: an unreadable
 * offer is not one the owner may tick.
 * @param value Raw `capabilities` field.
 * @returns The offered plugins, in the order the host reported them.
 */
export function readOfferedPlugins(value: unknown): readonly OfferedPlugin[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): readonly OfferedPlugin[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const group = entry as Record<string, unknown>
    if (typeof group.plugin !== 'string' || group.plugin === '') return []
    const endpoints = readEndpointList(group.endpoints)
    if (endpoints === undefined) return []
    const packageName = typeof group.package === 'string' && group.package !== '' ? group.package : undefined
    const titles = readTitles(group.titles)
    const descriptions = readDescriptions(group.descriptions)
    return [{
      plugin: group.plugin,
      ...(packageName === undefined ? {} : { package: packageName }),
      ...(titles === undefined ? {} : { titles }),
      endpoints,
      ...(descriptions === undefined ? {} : { descriptions }),
    }]
  })
}

/**
 * Read a plugin's localized title map out of one catalog entry.
 * @param value Raw `titles` field.
 * @returns The string-valued titles, or undefined when the field is not a map.
 */
function readTitles(value: unknown): Readonly<Record<string, string>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const titles: Record<string, string> = {}
  for (const [language, title] of Object.entries(value)) {
    if (typeof title === 'string' && title !== '') titles[language] = title
  }
  return titles
}

/**
 * Read a plugin's endpoint descriptions.
 * @param value Raw `descriptions` field.
 * @returns One description per known endpoint, or undefined when none is readable.
 */
function readDescriptions(value: unknown): Readonly<Record<string, string>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const descriptions: Record<string, string> = {}
  for (const [endpoint, description] of Object.entries(value)) {
    if (typeof description === 'string' && description !== '') descriptions[endpoint] = description
  }
  return Object.keys(descriptions).length === 0 ? undefined : descriptions
}

/**
 * Normalize one share's stored policies into the entries this page can edit.
 *
 * A Host that reports nothing, or one malformed entry, leaves that plugin closed.
 * @param value Raw `viewerPlugins` field.
 * @returns The policies this page can present, in host order.
 */
export function readViewerPolicies(value: unknown): readonly ViewerPluginPolicy[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): readonly ViewerPluginPolicy[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const policy = entry as Record<string, unknown>
    if (typeof policy.plugin !== 'string' || policy.plugin === '') return []
    if (policy.mode !== 'all' && policy.mode !== 'none' && policy.mode !== 'selected') return []
    const endpoints = policy.endpoints === undefined ? undefined : readEndpointList(policy.endpoints)
    if (policy.endpoints !== undefined && endpoints === undefined) return []
    return [{ plugin: policy.plugin, mode: policy.mode, ...(endpoints === undefined ? {} : { endpoints }) }]
  })
}
