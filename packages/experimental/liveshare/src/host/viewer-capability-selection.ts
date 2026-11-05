/**
 * Reading one share's owner-submitted plugin policy against the platform catalog.
 *
 * A submission is accepted only where the plugin and every named endpoint are still offered. The
 * result is what the share record carries: absent when nothing is exposed, so an old record without
 * the field keeps meaning "none".
 * @module @deepseek-ai/dsh-experimental-liveshare/src/host/viewer-capability-selection
 */

import type { RemoteAccessEndpoint } from '@deepseek-ai/dsh-api-remote-access/types'
import type { ShareablePluginCatalog, ViewerPluginPolicy } from './viewer-capability-types.ts'
import { isRecord } from './wire-json.ts'

/** Why one submission was refused. */
export type ViewerPluginPolicyRefusal =
  | { readonly code: 'invalid-capabilities' }
  | { readonly code: 'unknown-plugin'; readonly plugin: string }
  | { readonly code: 'endpoint-not-offered'; readonly plugin: string; readonly endpoint: string }

/** The accepted policies, or the refusal that replaces them. */
export type ViewerPluginPolicySelection =
  | {
    readonly ok: true
    /** Policies that expose at least one endpoint, or undefined when the share exposes none. */
    readonly selection: readonly ViewerPluginPolicy[] | undefined
  }
  | { readonly ok: false; readonly refusal: ViewerPluginPolicyRefusal }

/**
 * Read one submitted endpoint list.
 * @param value - Submitted value.
 * @returns The names, or undefined when the value is not an array of non-empty strings.
 */
function endpointNames(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const names: string[] = []
  for (const name of value) {
    if (typeof name !== 'string' || name === '') return undefined
    names.push(name)
  }
  return names
}

/**
 * Accept one submission against the endpoints the platform catalog offers.
 * @param offered - Catalog grouped by plugin.
 * @param input - Submitted `viewerPlugins` value, of any type.
 * @returns The policies to store, or the refusal that replaces them.
 */
export function readViewerPluginPolicies(
  offered: readonly ShareablePluginCatalog[],
  input: unknown,
): ViewerPluginPolicySelection {
  if (!Array.isArray(input)) return { ok: false, refusal: { code: 'invalid-capabilities' } }
  const offeredByPlugin = new Map(offered.map(group => [group.plugin, group.endpoints]))
  const accepted = new Map<string, ViewerPluginPolicy>()
  for (const entry of input) {
    if (!isRecord(entry)) return { ok: false, refusal: { code: 'invalid-capabilities' } }
    const plugin = entry.plugin
    if (typeof plugin !== 'string' || plugin === '') {
      return { ok: false, refusal: { code: 'invalid-capabilities' } }
    }
    const endpoints = offeredByPlugin.get(plugin)
    if (endpoints === undefined) return { ok: false, refusal: { code: 'unknown-plugin', plugin } }
    const mode = entry.mode
    if (mode !== 'all' && mode !== 'none' && mode !== 'selected') {
      return { ok: false, refusal: { code: 'invalid-capabilities' } }
    }
    if (mode === 'all') {
      accepted.set(plugin, { plugin, mode: 'all' })
      continue
    }
    if (mode === 'none') continue
    const named = endpointNames(entry.endpoints)
    if (named === undefined) return { ok: false, refusal: { code: 'invalid-capabilities' } }
    const selected = new Set<RemoteAccessEndpoint>()
    for (const endpoint of named) {
      const match = endpoints.find(candidate => candidate === endpoint) as RemoteAccessEndpoint | undefined
      if (match === undefined) {
        return { ok: false, refusal: { code: 'endpoint-not-offered', plugin, endpoint } }
      }
      selected.add(match)
    }
    if (selected.size > 0) {
      accepted.set(plugin, { plugin, mode: 'selected', endpoints: [...selected].sort() })
    }
  }
  const selection = offered.flatMap((group) => {
    const policy = accepted.get(group.plugin)
    return policy === undefined ? [] : [policy]
  })
  return { ok: true, selection: selection.length === 0 ? undefined : selection }
}
