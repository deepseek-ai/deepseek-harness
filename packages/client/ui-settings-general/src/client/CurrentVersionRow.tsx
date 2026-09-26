/** Installed release version in General Settings for Web and Desktop. */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './CurrentVersionRow.module.css'

/**
 * Render the version embedded by the client build; partial builds without metadata omit the row.
 * @param props - runtime share and localized copy.
 * @returns the current release label, or nothing when build metadata is absent.
 */
export function CurrentVersionRow({ t }: PropsRuntime<'settings.general.item'> & PropsLocale<'settings'>) {
  const version = process.env.DSH_CLIENT_VERSION
  if (version === undefined) return null
  return <div className={css.row}>{t('general.currentVersion', { version })}</div>
}
