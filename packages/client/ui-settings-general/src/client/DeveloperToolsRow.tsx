/** General Settings control for shared developer-tool visibility and previews. */
import { useState } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './DeveloperToolsRow.module.css'

/** Accepted setting and ordered mutation supplied by the settings owner. */
export interface DeveloperToolsRowInjected {
  hooks: { developerTools: ObservableSnapshot<boolean> }
  setEnabled(enabled: boolean): Promise<void>
}

/**
 * Render the developer-tool toggle.
 * @param props - accepted preference, writer and localized copy.
 * @returns the General Settings row.
 */
export function DeveloperToolsRow({ useDeveloperTools, setEnabled, t }:
  PropsRuntime<'settings.general.item'> & PropsLocale<'settings'> & InjectFace<DeveloperToolsRowInjected>) {
  const enabled = useDeveloperTools(value => value)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  return <div className={css.row}>
    <div>
      <div className={css.title}>{t('developerTools.title')}</div>
      <div className={css.description}>{t('developerTools.description')}</div>
      {failed && <div role="alert">{t('developerTools.error')}</div>}
    </div>
    <Switch checked={enabled} disabled={busy} label={t('developerTools.title')}
      onChange={(next) => {
        setFailed(false)
        setBusy(true)
        void setEnabled(next).catch(() => { setFailed(true) }).finally(() => { setBusy(false) })
      }} />
  </div>
}
