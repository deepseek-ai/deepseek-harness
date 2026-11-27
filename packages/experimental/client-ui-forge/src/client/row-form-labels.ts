/** Copy of the Plugins form that the row pages of the Forge bundle share. */
import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { ForgePanelKey, NS } from './locales.ts'

/**
 * Build the form copy of one row page.
 * @param t - forge panel copy.
 * @param unavailable - key of the text shown while the Host does not serve the row's form.
 * @returns the labels of the shared settings form.
 */
export function rowFormLabels(t: PropsLocale<typeof NS>['t'], unavailable: ForgePanelKey): SettingsFormLabels {
  return {
    unavailable: t(unavailable), readOnly: t('settings.readOnly'), saveFailed: t('settings.saveFailed'),
    save: t('settings.save'), saving: t('settings.saving'),
  }
}
