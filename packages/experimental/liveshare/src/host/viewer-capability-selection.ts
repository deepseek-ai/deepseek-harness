/**
 * Reading one share's owner-submitted plugin endpoint selection against the live offers.
 *
 * The owner panel submits what the owner ticked; the plugins' own declarations decide what may be
 * ticked at all. A submission is therefore accepted only where the plugin still offers every named
 * endpoint under the kind it was named with, and a name nothing offers is refused by name instead of
 * being stored as a selection no decision can ever expose.
 *
 * The result is the value the share record carries: absent when the owner exposed nothing, so a share
 * written before the selection existed keeps meaning "none", and an explicit empty submission clears
 * the field rather than storing an empty list.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare/src/host/viewer-capability-selection
 */

import type { RemoteAccessEndpoint } from '@deepseek-ai/dsh-api-remote-access/types'
import type { ViewerCapabilityGroup } from './viewer-declarations.ts'
import { isRecord } from './wire-json.ts'

/** One endpoint kind a submission may name. */
type CapabilityKind = 'readable' | 'writable'

/** The endpoints one plugin's accepted submission names, by kind. */
interface ChosenEndpoints {
  readonly readable: Set<RemoteAccessEndpoint>
  readonly writable: Set<RemoteAccessEndpoint>
}

/**
 * Why one submission was refused, as the owner panel and the tests read it.
 *
 * The codes are stable and narrow: a malformed body, a plugin the live offers do not name, or an
 * endpoint that plugin does not offer under the kind it was submitted with. The last two carry what
 * they refused, so a refusal names the offending plugin or endpoint instead of only that one is.
 */
export type ViewerCapabilityRefusal =
  | { readonly code: 'invalid-capabilities' }
  | { readonly code: 'unknown-plugin'; readonly plugin: string }
  | {
    readonly code: 'endpoint-not-offered'
    readonly plugin: string
    readonly kind: CapabilityKind
    readonly endpoint: string
  }

/** The accepted selection, or the refusal that replaces it. */
export type ViewerCapabilitySelection =
  | {
    readonly ok: true
    /**
     * The endpoints this share exposes, grouped by plugin in offer order, or undefined when the
     * submission exposed none. Undefined is what the share record omits: no field means no exposure.
     */
    readonly selection: readonly ViewerCapabilityGroup[] | undefined
  }
  | { readonly ok: false; readonly refusal: ViewerCapabilityRefusal }

/**
 * Whether one submitted value is a JSON object.
 * @param value - Candidate value.
 * @returns True for a JSON object.
 */
/**
 * Read one submitted endpoint list, keeping the shape rule in one place.
 * @param value - Submitted value for `readable` or `writable`.
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
 * Accept one submission against the endpoints plugins currently offer.
 *
 * A plugin group that names no endpoint is dropped, because it exposes nothing; a submission that
 * names nothing at all resolves to an absent selection, which is the field the share record omits.
 * @param offered - Endpoints plugins currently offer, grouped by declaring plugin.
 * @param input - Submitted `capabilities` value, of any type.
 * @returns The selection to store, or the refusal that replaces it.
 */
export function readViewerCapabilitySelection(
  offered: readonly ViewerCapabilityGroup[],
  input: unknown,
): ViewerCapabilitySelection {
  if (!Array.isArray(input)) return { ok: false, refusal: { code: 'invalid-capabilities' } }
  const offeredByPlugin = new Map(offered.map(group => [group.plugin, group]))
  const chosen = new Map<string, ChosenEndpoints>()
  for (const entry of input) {
    if (!isRecord(entry)) return { ok: false, refusal: { code: 'invalid-capabilities' } }
    const plugin = entry.plugin
    if (typeof plugin !== 'string' || plugin === '') {
      return { ok: false, refusal: { code: 'invalid-capabilities' } }
    }
    const readable = endpointNames(entry.readable)
    const writable = endpointNames(entry.writable)
    if (readable === undefined || writable === undefined) {
      return { ok: false, refusal: { code: 'invalid-capabilities' } }
    }
    const group = offeredByPlugin.get(plugin)
    if (group === undefined) return { ok: false, refusal: { code: 'unknown-plugin', plugin } }
    const selected = chosen.get(plugin)
      ?? { readable: new Set<RemoteAccessEndpoint>(), writable: new Set<RemoteAccessEndpoint>() }
    for (const [kind, endpoints] of [['readable', readable], ['writable', writable]] as const) {
      for (const endpoint of endpoints) {
        const accepted = group[kind].find(candidate => candidate === endpoint)
        if (accepted === undefined) {
          return { ok: false, refusal: { code: 'endpoint-not-offered', plugin, kind, endpoint } }
        }
        selected[kind].add(accepted)
      }
    }
    chosen.set(plugin, selected)
  }
  const selection = offered.flatMap((group): readonly ViewerCapabilityGroup[] => {
    const selected = chosen.get(group.plugin)
    if (selected === undefined) return []
    const readable = [...selected.readable].sort()
    const writable = [...selected.writable].sort()
    return readable.length === 0 && writable.length === 0 ? [] : [{ plugin: group.plugin, readable, writable }]
  })
  return { ok: true, selection: selection.length === 0 ? undefined : selection }
}
