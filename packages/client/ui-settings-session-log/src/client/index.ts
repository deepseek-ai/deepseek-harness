/** General settings companion for the Host Session-log upload configuration. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { UploadPreference, type UploadSettings } from './upload-preference.ts'
import { UploadRow, UploadToast, type UploadInjected } from './UploadRow.tsx'
import { en, zh } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** API Session-log preference copy. */
    'settings.sessionLog': keyof typeof en
  }
}

/** Services used by the browser companion. */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Register the preference while its Host configuration is available.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: Context): void {
  const locale = 'settings.sessionLog'
  const namespace = 'session-log-deepseek'
  ctx.effect(() => ctx.locale.register(locale, { en, zh }))
  const form = ctx.configForms.get<UploadSettings>(namespace)
  const preference = new UploadPreference(form)
  const face = (): UploadInjected => ({
    hooks: { upload: form, mutation: preference.state },
    setEnabled: enabled => preference.setEnabled(enabled),
    dismiss: () => { preference.dismiss() },
  })
  ctx.effect(() => ctx.configForms.whileServed([namespace], () => ctx.slots.inject('settings.general.item', () =>
    ctx.slots.register({ name: 'settings.general.item', id: namespace, order: 90, locale, inject: face }, UploadRow))))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'session-log-upload-toast', locale, inject: face,
  }, UploadToast))
}
