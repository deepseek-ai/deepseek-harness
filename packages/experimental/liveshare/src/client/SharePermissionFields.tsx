/**
 * The session permission, fork switch, and per-plugin endpoint selection shared by the create form
 * and the stored-share editor.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare/src/client/SharePermissionFields
 */

import type { ReactNode } from 'react'
import { SegmentedControl, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import { ShareCapabilitiesPicker, type PluginAccess } from './ShareCapabilitiesPicker.tsx'
import { sessionModeOptions } from './share-options.ts'
import type { OfferedPlugin, ViewerPluginPolicy } from './share-types.ts'
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
  readonly offered: readonly OfferedPlugin[]
  /** Global switch over every installed plugin's methods. */
  readonly pluginAccess: PluginAccess
  /** Endpoints this share currently selects. */
  readonly capabilities: readonly ViewerPluginPolicy[]
  /** Whether every control is unavailable. */
  readonly disabled: boolean
  /** Base id the session permission tabs derive from. */
  readonly sessionModeControlId: string
  /** Base id the per-plugin endpoint controls derive from. */
  readonly capabilityControlId: string
  /** Record a session permission pick. */
  readonly onSessionMode: (mode: ViewerSessionMode) => void
  /** Record a fork-switch pick. */
  readonly onAllowsFork: (value: boolean) => void
  /** Record the global plugin switch. */
  readonly onPluginAccess: (access: PluginAccess) => void
  /** Record an endpoint selection. */
  readonly onCapabilities: (capabilities: readonly ViewerPluginPolicy[]) => void
}

/**
 * Render the fields both creating and editing a share present.
 * @param props - Values, callbacks, control ids, and localized copy.
 * @returns The shared permission rows.
 */
export function SharePermissionFields({
  sessionMode, modeUnsupported = false, allowsFork, offered, pluginAccess, capabilities, disabled,
  sessionModeControlId, capabilityControlId, onSessionMode, onAllowsFork, onPluginAccess, onCapabilities, t,
}: SharePermissionFieldsProps): ReactNode {
  return (
    <div className={css.permissionSections}>
      <div className={css.permissionBlock}>
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
        {/* The share sandbox bounds a viewer's tools, not the PTC program a viewer starts. */}
        <p className={css.warning} role="note">{t('dialog.ptcSandboxWarning')}</p>
      </div>
      <div className={css.permissionBlock}>
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
      </div>
      <div className={css.permissionBlock}>
        {offered.length === 0
          ? <p className={css.hint}>{t('dialog.capabilities.empty')}</p>
          : (
            <ShareCapabilitiesPicker
              offered={offered}
              access={pluginAccess}
              selection={capabilities}
              disabled={disabled}
              controlId={capabilityControlId}
              onAccessChange={onPluginAccess}
              onChange={onCapabilities}
              t={t}
            />
          )}
      </div>
    </div>
  )
}
