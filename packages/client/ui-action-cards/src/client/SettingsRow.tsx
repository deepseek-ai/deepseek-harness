/** General settings row for the switch that offers action cards. */
import { useState } from 'react'
import { Button, IconInfoOutlineRegular, Switch, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './SettingsRow.module.css'

/** The Host `action-cards` field this row edits. */
export interface CardSettings {
  enabled: boolean
}

/** Accepted settings and the writer supplied by the plugin. */
export interface SettingsRowInjected {
  hooks: { cardSettings: HostObservable<ConfigFormSnapshot<CardSettings>> }
  /**
   * Write the switch.
   * @param enabled - requested value.
   * @returns whether the Host accepted it; transport failures reject.
   */
  setEnabled(enabled: boolean): Promise<boolean>
}

/**
 * Render the accepted value; a refused or failed write keeps it and shows an error.
 * @param props - settings hook, writer and localized copy.
 * @returns the General settings row.
 */
export function SettingsRow({ useCardSettings, setEnabled, t }:
  PropsRuntime<'settings.general.item'> & PropsLocale<'actionCards'> & InjectFace<SettingsRowInjected>) {
  const settings = useCardSettings(value => value)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  return <div className={css.row}>
    <div>
      <div className={css.title}>{t('settings.title')}</div>
      <div className={css.description}>
        <span>{t('settings.description')}</span>
        <Tooltip label={t('settings.details')} side="bottom" delayMs={300} maxWidth={300} portal openOnClick>
          <Button variant="ghost" size="sm" className={css.infoButton} aria-label={t('settings.detailsLabel')}>
            <IconInfoOutlineRegular size={11} aria-hidden="true" />
          </Button>
        </Tooltip>
      </div>
      {failed && <div role="alert">{t('settings.error')}</div>}
    </div>
    <Switch checked={settings.value?.enabled === true} label={t('settings.title')}
      disabled={busy || settings.status !== 'ready' || !settings.writable}
      onChange={(enabled) => {
        setFailed(false)
        setBusy(true)
        void setEnabled(enabled).then((accepted) => { setFailed(!accepted) }, () => { setFailed(true) })
          .finally(() => { setBusy(false) })
      }} />
  </div>
}
