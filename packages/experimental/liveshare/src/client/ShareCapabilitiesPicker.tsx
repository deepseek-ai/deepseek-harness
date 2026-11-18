/**
 * The share dialog's installed-plugin method control and the helpers that read one share's policies.
 *
 * One global switch opens every installed plugin's offered methods, closes them all, or follows the
 * per-plugin list. Each plugin is then closed, open for every offered method, or a subset. A full
 * selection is stored as `all`; a subset stores its explicit endpoints.
 * @module @deepseek-ai/dsh-experimental-liveshare/src/client/ShareCapabilitiesPicker
 */

import type { ReactNode } from 'react'
import { Checkbox, SegmentedControl, type SegmentedControlOption } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import type { OfferedPlugin, ViewerPluginPolicy } from './share-types.ts'
import css from './ShareDialog.module.css'

/** How one plugin's offered methods appear for one share. */
export type PluginExposure = 'none' | 'all' | 'partial'

/** The share's global switch over installed plugin methods. */
export type PluginAccess = 'all' | 'none' | 'custom'

/**
 * The interface language this page renders in.
 * @returns A lowercase language tag, or `en` outside a document.
 */
function activeLanguage(): string {
  /* v8 ignore next -- split returns at least one element, so the tag itself always answers. */
  return (document.documentElement.lang || 'en').split('-')[0]?.toLowerCase() ?? 'en'
}

/**
 * Turn a package or namespace identifier into a readable fallback label.
 * @param value - Package name or namespace.
 * @returns Words with normal spacing and an initial capital.
 */
function humanize(value: string): string {
  /* v8 ignore next -- split returns at least one element, so pop() always yields a segment. */
  const segment = value.split('/').pop() ?? value
  const words = segment
    .replace(/^dsh-/, '')
    .replace(/^experimental-/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim()
  const sentence = words.toLowerCase()
  return sentence === '' ? value : sentence.charAt(0).toUpperCase() + sentence.slice(1)
}

/**
 * The product name to show for one plugin group.
 *
 * A localized title from the package's locale files wins; English is the fallback. A missing or
 * package-shaped English title falls back to the package's last segment, then to the namespace.
 * @param group - Offered plugin.
 * @param language - Active interface language.
 * @returns The display name.
 */
export function pluginDisplayName(group: OfferedPlugin, language: string): string {
  const titles = group.titles
  const localized = titles?.[language]
  if (localized !== undefined && localized !== '') return localized
  const english = titles?.en
  const packageSegment = group.package?.split('/').pop()
  const packageWords = packageSegment?.replace(/^(dsh|experimental)-/, '')
  if (english !== undefined && english !== '' && english !== packageSegment && english !== packageWords) {
    return english
  }
  return humanize(packageSegment ?? group.plugin)
}

/**
 * The exposure one plugin has in a share's policies.
 * @param selection - Policies the share record names.
 * @param plugin - Plugin namespace to read.
 * @returns The exposure for that plugin.
 */
export function pluginExposure(
  selection: readonly ViewerPluginPolicy[],
  plugin: string,
): PluginExposure {
  const policy = selection.find(entry => entry.plugin === plugin)
  if (policy === undefined || policy.mode === 'none') return 'none'
  return policy.mode === 'all' ? 'all' : 'partial'
}

/**
 * The endpoints one policy effectively exposes for one offered plugin.
 * @param offered - Catalog the host currently offers.
 * @param policy - Policy to expand.
 * @returns The endpoints the policy names, or an empty list when the plugin is not offered.
 */
export function policyEndpoints(
  offered: readonly OfferedPlugin[],
  policy: ViewerPluginPolicy,
): readonly string[] {
  const endpoints = offered.find(group => group.plugin === policy.plugin)?.endpoints ?? []
  if (policy.mode === 'all') return endpoints
  if (policy.mode === 'none') return []
  return (policy.endpoints ?? []).filter(endpoint => endpoints.includes(endpoint))
}

/**
 * Whether one endpoint is exposed by a share's policies.
 * @param offered - Catalog the host currently offers.
 * @param selection - Policies the share record names.
 * @param plugin - Plugin namespace to read.
 * @param endpoint - Endpoint to test.
 * @returns True when the endpoint is exposed.
 */
export function endpointSelected(
  offered: readonly OfferedPlugin[],
  selection: readonly ViewerPluginPolicy[],
  plugin: string,
  endpoint: string,
): boolean {
  const policy = selection.find(entry => entry.plugin === plugin)
  return policy === undefined ? false : policyEndpoints(offered, policy).includes(endpoint)
}

/**
 * Replace one plugin's policy, keeping the other plugins in their current order.
 * @param selection - Current policies.
 * @param policy - Replacement policy.
 * @returns The new policies.
 */
function replacePolicy(
  selection: readonly ViewerPluginPolicy[],
  policy: ViewerPluginPolicy,
): readonly ViewerPluginPolicy[] {
  return [...selection.filter(entry => entry.plugin !== policy.plugin), policy]
}

/**
 * Set one plugin's exposure.
 * @param offered - Catalog the host currently offers.
 * @param selection - Current policies.
 * @param plugin - Plugin namespace to change.
 * @param exposure - Exposure to set.
 * @returns The new policies.
 */
export function setPluginExposure(
  offered: readonly OfferedPlugin[],
  selection: readonly ViewerPluginPolicy[],
  plugin: string,
  exposure: PluginExposure,
): readonly ViewerPluginPolicy[] {
  if (exposure === 'none') return selection.filter(policy => policy.plugin !== plugin)
  if (exposure === 'all') return replacePolicy(selection, { plugin, mode: 'all' })
  const existing = selection.find(policy => policy.plugin === plugin)
  const endpoints = existing === undefined ? [] : policyEndpoints(offered, existing)
  return replacePolicy(selection, { plugin, mode: 'selected', endpoints: [...endpoints].sort() })
}

/**
 * Select or clear one endpoint for a plugin.
 * @param offered - Catalog the host currently offers.
 * @param selection - Current policies.
 * @param plugin - Plugin namespace to change.
 * @param endpoint - Endpoint to change.
 * @param selected - Whether it should be exposed.
 * @returns The new policies.
 */
export function setEndpointSelected(
  offered: readonly OfferedPlugin[],
  selection: readonly ViewerPluginPolicy[],
  plugin: string,
  endpoint: string,
  selected: boolean,
): readonly ViewerPluginPolicy[] {
  const offeredGroup = offered.find(group => group.plugin === plugin)
  if (offeredGroup === undefined || !offeredGroup.endpoints.includes(endpoint)) return selection
  const existing = selection.find(policy => policy.plugin === plugin)
  const endpoints = new Set(existing === undefined ? [] : policyEndpoints(offered, existing))
  if (selected) endpoints.add(endpoint)
  else endpoints.delete(endpoint)
  return replacePolicy(selection, { plugin, mode: 'selected', endpoints: [...endpoints].sort() })
}

/**
 * Narrow one policy list to what the host currently offers, dropping closed plugins.
 * @param offered - Catalog the host currently offers.
 * @param selection - Policies to write back.
 * @returns The policies the owner API accepts for this catalog.
 */
export function selectionForOffered(
  offered: readonly OfferedPlugin[],
  selection: readonly ViewerPluginPolicy[],
): readonly ViewerPluginPolicy[] {
  return offered.flatMap((group): readonly ViewerPluginPolicy[] => {
    const policy = selection.find(entry => entry.plugin === group.plugin)
    if (policy === undefined || policy.mode === 'none') return []
    if (policy.mode === 'all') return [{ plugin: group.plugin, mode: 'all' }]
    const endpoints = (policy.endpoints ?? []).filter(endpoint => group.endpoints.includes(endpoint)).sort()
    return endpoints.length === 0 ? [] : [{ plugin: group.plugin, mode: 'selected', endpoints }]
  })
}

/**
 * The endpoints one policy list exposes, as comparable keys.
 * @param offered - Catalog the host currently offers.
 * @param selection - Policies read from a share record.
 * @returns One key per exposed endpoint, sorted.
 */
export function selectionKeys(
  offered: readonly OfferedPlugin[],
  selection: readonly ViewerPluginPolicy[],
): readonly string[] {
  const keys: string[] = []
  for (const policy of selection) {
    for (const endpoint of policyEndpoints(offered, policy)) {
      keys.push(`${policy.plugin}\u0000${endpoint}`)
    }
  }
  return keys.sort()
}

/**
 * Whether two key lists name exactly the same endpoints.
 * @param left - One sorted key list.
 * @param right - The other sorted key list.
 * @returns True when both name the same endpoints once each.
 */
export function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index])
}

/** Props for the plugin-method control. */
export interface ShareCapabilitiesPickerProps extends PropsLocale<typeof NS> {
  /** Installed plugins the Host currently offers; an empty list renders only the global switch. */
  readonly offered: readonly OfferedPlugin[]
  /** Global switch this share carries. */
  readonly access: PluginAccess
  /** Policies this share carries. */
  readonly selection: readonly ViewerPluginPolicy[]
  /** Whether the control is unavailable. */
  readonly disabled: boolean
  /** Base id the per-plugin controls derive from. */
  readonly controlId: string
  /** Record the owner's global switch. */
  readonly onAccessChange: (access: PluginAccess) => void
  /** Record the owner's per-plugin selection. */
  readonly onChange: (selection: readonly ViewerPluginPolicy[]) => void
}

/**
 * Render the global switch, a search field, and one row per installed plugin with its method
 * checkboxes for a partial selection. Only the custom switch shows the per-plugin list.
 * @param props - The live catalog, the current policies, and localized copy.
 * @returns The control, or nothing when no plugin offers a method.
 */
export function ShareCapabilitiesPicker({
  offered, access, selection, disabled, controlId, onAccessChange, onChange, t,
}: ShareCapabilitiesPickerProps): ReactNode {
  const groups = offered.filter(group => group.endpoints.length > 0)
  if (groups.length === 0) return null
  const language = activeLanguage()
  const globalOptions: readonly SegmentedControlOption<PluginAccess>[] = [
    { value: 'none', label: t('dialog.capabilities.global.none') },
    { value: 'custom', label: t('dialog.capabilities.global.custom') },
    { value: 'all', label: t('dialog.capabilities.global.all') },
  ]
  const options: readonly SegmentedControlOption<PluginExposure>[] = [
    { value: 'none', label: t('dialog.capabilities.tier.none') },
    { value: 'all', label: t('dialog.capabilities.tier.all') },
    { value: 'partial', label: t('dialog.capabilities.partial') },
  ]
  const pickAccess = (next: PluginAccess): void => {
    if (next !== 'custom') onChange([])
    onAccessChange(next)
  }
  const pickPlugin = (plugin: string, next: PluginExposure): void => {
    const policies = setPluginExposure(offered, selection, plugin, next)
    onAccessChange(policies.length === 0 ? 'none' : 'custom')
    onChange(policies)
  }
  return (
    <>
      <div className={css.row}>
        <span className={css.rowLabel}>{t('dialog.capabilities.global')}</span>
        <SegmentedControl
          id={controlId + '-global'}
          label={t('dialog.capabilities.global')}
          value={access}
          disabled={disabled}
          options={globalOptions}
          onChange={pickAccess}
        />
      </div>
      {access === 'custom' ? (
        <>
          <div className={css.capabilityList}>
            {groups.map((group, index) => {
              const exposure = pluginExposure(selection, group.plugin)
              const name = pluginDisplayName(group, language)
              return (
                <div key={group.plugin} className={css.capabilityPlugin}>
                  <div className={css.row}>
                    <span className={css.rowLabel} title={group.plugin}>{name}</span>
                    <SegmentedControl
                      id={`${controlId}-plugin-${String(index)}`}
                      label={name}
                      value={exposure}
                      disabled={disabled}
                      options={options}
                      onChange={(next) => { pickPlugin(group.plugin, next) }}
                    />
                  </div>
                  {exposure === 'partial' ? (
                    <div className={css.methodList}>
                      {group.endpoints.map((endpoint) => {
                        const description = group.descriptions?.[endpoint]
                        return (
                          <div key={endpoint} className={css.methodItem}>
                            <Checkbox
                              label={endpoint.slice(endpoint.lastIndexOf('/') + 1)}
                              checked={endpointSelected(offered, selection, group.plugin, endpoint)}
                              disabled={disabled}
                              onChange={(checked) => {
                                onChange(setEndpointSelected(offered, selection, group.plugin, endpoint, checked))
                              }}
                            />
                            <p className={css.methodDescription} title={description}>{description}</p>
                          </div>
                        )
                      })}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        </>
      ) : null}
    </>
  )
}
