/**
 * The share dialog's plugin-endpoint tier control and the helpers that read a stored selection back
 * as one tier.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare/src/client/ShareCapabilitiesPicker
 */

import type { ReactNode } from 'react'
import { SegmentedControl, type SegmentedControlOption } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import type { ViewerCapabilityGroup } from './share-types.ts'
import css from './ShareDialog.module.css'

/** One share-wide exposure tier the owner picks for every plugin that declares endpoints. */
export type CapabilityTier = 'none' | 'read' | 'write'

/**
 * The endpoints one tier exposes, expanded from what the plugins declare now.
 *
 * `read` carries every readable endpoint and no writable one; `write` carries both kinds, because it
 * is the wider tier rather than writable endpoints alone. A plugin with nothing to expose under the
 * tier is left out, exactly as a group that names no endpoint. Expansion at save time is what keeps a
 * record an explicit endpoint list: an endpoint a plugin declares later is not in this expansion, so
 * it stays closed until the owner saves again.
 * @param offered - Endpoints the host currently offers.
 * @param tier - Tier to expand.
 * @returns The `capabilities` array the owner API validates against the same offers.
 */
export function tierSelection(
  offered: readonly ViewerCapabilityGroup[],
  tier: CapabilityTier,
): readonly ViewerCapabilityGroup[] {
  return offered.flatMap((group): readonly ViewerCapabilityGroup[] => {
    const readable = tier === 'none' ? [] : [...group.readable]
    const writable = tier === 'write' ? [...group.writable] : []
    return readable.length === 0 && writable.length === 0
      ? []
      : [{ plugin: group.plugin, readable, writable }]
  })
}

/**
 * The endpoints one group list names, as comparable keys.
 *
 * The plugin and the kind are part of each key because the same name may be offered as readable by one
 * plugin and writable by another.
 * @param groups - Groups read from a share record.
 * @returns One key per named endpoint, sorted.
 */
export function selectionKeys(groups: readonly ViewerCapabilityGroup[]): readonly string[] {
  const keys: string[] = []
  for (const group of groups) {
    for (const endpoint of group.readable) keys.push(`${group.plugin}\u0000readable\u0000${endpoint}`)
    for (const endpoint of group.writable) keys.push(`${group.plugin}\u0000writable\u0000${endpoint}`)
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

/**
 * The tier one share's stored selection is, and whether it is a whole tier at all.
 *
 * A record that matches no tier is not shown as one: the control holds the default and the panel
 * states that saving replaces the record, because the record names a subset no tier represents — a
 * selection made before every endpoint was offered again, or one this page cannot attribute.
 * @param offered - Endpoints the host currently offers.
 * @param stored - Selection the host reported for this share.
 * @returns The matching tier, or the default with `stale` when the record matches none.
 */
export function readStoredTier(
  offered: readonly ViewerCapabilityGroup[],
  stored: readonly ViewerCapabilityGroup[],
): { readonly tier: CapabilityTier; readonly stale: boolean } {
  const keys = selectionKeys(stored)
  // An empty record is exactly the default tier, and it is the only reading when the record names
  // nothing: comparing it to an empty expansion would otherwise match the read tier too.
  if (keys.length === 0) return { tier: 'none', stale: false }
  // The write tier is compared only where a plugin declares a writable endpoint: without one the two
  // tiers expand to the same endpoints, and such a record is the read tier rather than the wider one.
  if (offered.some(group => group.writable.length > 0)
    && sameKeys(keys, selectionKeys(tierSelection(offered, 'write')))) {
    return { tier: 'write', stale: false }
  }
  if (sameKeys(keys, selectionKeys(tierSelection(offered, 'read')))) return { tier: 'read', stale: false }
  return { tier: 'none', stale: true }
}

/** Props for the endpoint tier control. */
export interface ShareCapabilitiesPickerProps extends PropsLocale<typeof NS> {
  /** Endpoints the mounted plugins currently offer; an empty list renders nothing. */
  readonly offered: readonly ViewerCapabilityGroup[]
  /** Tier the control acts on. */
  readonly tier: CapabilityTier
  /** Whether the stored record matches no tier, so saving replaces it. */
  readonly stale: boolean
  /** Whether the share's save is in flight. */
  readonly disabled: boolean
  /** Base id the control's own tab and panel ids derive from. */
  readonly controlId: string
  /** Record the owner's tier pick. */
  readonly onPick: (tier: CapabilityTier) => void
}

/**
 * Render the endpoint tier control, its caveats, and what the current tier exposes.
 * @param props - The live offers, the tier in force, and localized copy.
 * @returns The control, or nothing when no plugin offers an endpoint.
 */
export function ShareCapabilitiesPicker({
  offered, tier, stale, disabled, controlId, onPick, t,
}: ShareCapabilitiesPickerProps): ReactNode {
  if (offered.length === 0) return null
  /** Whether any offered plugin declares a readable endpoint, which is what the read tier exposes. */
  const readableOffered = offered.some(group => group.readable.length > 0)
  /** Whether any offered plugin declares a writable endpoint, which is what the write tier adds. */
  const writableOffered = offered.some(group => group.writable.length > 0)
  /** Every readable endpoint the offer carries, which is what the read tier writes into the record. */
  const readableOfferedCount = offered.reduce((count, group) => count + group.readable.length, 0)
  /** Every writable endpoint the offer carries, which is what the write tier adds to the record. */
  const writableOfferedCount = offered.reduce((count, group) => count + group.writable.length, 0)
  /** The three tiers, with the ones the live offer cannot fill stated as unavailable. */
  const tierOptions: readonly SegmentedControlOption<CapabilityTier>[] = [
    { value: 'none', label: t('dialog.capabilities.tier.none') },
    {
      value: 'read',
      label: t('dialog.capabilities.tier.read'),
      ...(readableOffered ? {} : { disabled: true, title: t('dialog.capabilities.noReadable') }),
    },
    {
      value: 'write',
      label: t('dialog.capabilities.tier.write'),
      ...(writableOffered ? {} : { disabled: true, title: t('dialog.capabilities.noWritable') }),
    },
  ]

  /**
   * The one line stating what this share exposes right now.
   * @returns The localized summary of the current exposure.
   */
  const capabilitySummary = (): string => {
    if (stale) return t('dialog.capabilities.stale')
    if (tier === 'read') return t('dialog.capabilities.summary.read', { count: readableOfferedCount })
    if (tier === 'write') {
      return t('dialog.capabilities.summary.write', {
        readable: readableOfferedCount,
        writable: writableOfferedCount,
      })
    }
    return t('dialog.capabilities.none')
  }

  return (
    <>
      <p className={css.hint}>{t('dialog.capabilities.description')}</p>
      <SegmentedControl
        id={controlId}
        label={t('dialog.capabilities')}
        value={tier}
        disabled={disabled}
        options={tierOptions}
        onChange={(next) => { onPick(next) }}
      />
      {/* A writable endpoint is destructive and the share mode is the owner's consent for
        writes, so the caveat sits beside the tier that opens those endpoints. */}
      {writableOffered ? <span className={css.testWarn}>{t('dialog.capabilities.writeHint')}</span> : null}
      {/* A tier the live offer cannot fill is stated instead of being silently the narrower one. */}
      {readableOffered ? null : <span className={css.hint}>{t('dialog.capabilities.noReadable')}</span>}
      {writableOffered ? null : <span className={css.hint}>{t('dialog.capabilities.noWritable')}</span>}
      <span className={stale ? css.testWarn : tier === 'none' ? css.hint : css.testOk}>
        {capabilitySummary()}
      </span>
    </>
  )
}
