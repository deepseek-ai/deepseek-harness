/**
 * The session permission, fork switch, and plugin-endpoint tier shared by the create form and the
 * stored-share editor.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare/src/client/SharePermissionFields
 */

import type { ReactNode } from 'react'
import { SegmentedControl, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import { ShareCapabilitiesPicker, type CapabilityTier } from './ShareCapabilitiesPicker.tsx'
import { sessionModeOptions } from './share-options.ts'
import type { ViewerCapabilityGroup } from './share-types.ts'
import type { ViewerSessionMode } from './viewer-capabilities.ts'
import css from './ShareDialog.module.css'

/** Values and callbacks one shared permission field renders. */
export interface SharePermissionFieldsProps extends PropsLocale<typeof NS> {
  /** Session permission on hand; absent when the Host cannot place the stored tier. */
  readonly sessionMode: ViewerSessionMode | undefined
  /** Whether no supported session permission exists, stated instead of an empty control. */
  readonly modeUnsupported?: boolean
  /** The share's own fork switch. */
  readonly allowsFork: boolean
  /** Plugin endpoints the mounted plugins offer. */
  readonly offered: readonly ViewerCapabilityGroup[]
  /** Endpoint tier on hand. */
  readonly tier: CapabilityTier
  /** Whether the stored endpoints match no tier, so the picker states an unmatched selection. */
  readonly stale?: boolean
  /** Whether every control is unavailable. */
  readonly disabled: boolean
  /** Base id the session permission tabs derive from. */
  readonly sessionModeControlId: string
  /** Base id the endpoint tabs derive from. */
  readonly capabilityControlId: string
  /** Record a session permission pick. */
  readonly onSessionMode: (mode: ViewerSessionMode) => void
  /** Record a fork-switch pick. */
  readonly onAllowsFork: (value: boolean) => void
  /** Record an endpoint tier pick. */
  readonly onTier: (tier: CapabilityTier) => void
}

/**
 * Render the fields both creating and editing a share present.
 * @param props - Values, callbacks, control ids, and localized copy.
 * @returns The shared permission rows.
 */
export function SharePermissionFields({
  sessionMode, modeUnsupported = false, allowsFork, offered, tier, stale = false, disabled,
  sessionModeControlId, capabilityControlId, onSessionMode, onAllowsFork, onTier, t,
}: SharePermissionFieldsProps): ReactNode {
  return (
    <>
      <div className={css.row}>
        <span className={css.rowLabel}>{t('dialog.sessionMode')}</span>
        {sessionMode === undefined ? (
          <span className={css.testWarn}>{t('dialog.permissions.modeUnsupported')}</span>
        ) : (
          <SegmentedControl
            id={sessionModeControlId}
            label={t('dialog.sessionMode')}
            value={sessionMode}
            disabled={disabled}
            options={sessionModeOptions(t)}
            onChange={onSessionMode}
          />
        )}
      </div>
      {modeUnsupported || sessionMode === undefined ? null : (
        <p className={css.hint}>{t(`dialog.sessionMode.hint.${sessionMode}` as const)}</p>
      )}
      <div className={css.row}>
        <span className={css.rowLabel}>{t('dialog.allowsFork')}</span>
        <Switch
          checked={allowsFork}
          disabled={disabled}
          label={t('dialog.allowsFork')}
          onChange={onAllowsFork}
        />
      </div>
      <p className={css.hint}>{t('dialog.allowsForkHint')}</p>
      <div className={css.row}>
        <span className={css.rowLabel}>{t('dialog.capabilities')}</span>
        <Switch
          checked={tier !== 'none'}
          disabled={disabled || offered.length === 0}
          label={t('dialog.capabilities')}
          onChange={(enabled) => {
            onTier(enabled ? (offered.some(group => group.readable.length > 0) ? 'read' : 'write') : 'none')
          }}
        />
      </div>
      {offered.length === 0
        ? <p className={css.hint}>{t('dialog.capabilities.empty')}</p>
        : (
          <ShareCapabilitiesPicker
            offered={offered}
            tier={tier}
            stale={stale}
            disabled={disabled}
            controlId={capabilityControlId}
            onPick={onTier}
            t={t}
          />
        )}
    </>
  )
}
