/** General settings row and persistent shell notice for API log uploads. */
import { Switch, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { UploadMutation, UploadSettings } from './upload-preference.ts'
import css from './UploadRow.module.css'

/** Accepted settings and mutation callbacks supplied by the plugin. */
export interface UploadInjected {
  hooks: {
    upload: ObservableSnapshot<ConfigFormSnapshot<UploadSettings>>
    mutation: ObservableSnapshot<UploadMutation>
  }
  setEnabled(enabled: boolean): Promise<void>
  dismiss(): void
}

type Face = InjectFace<UploadInjected> & PropsLocale<'settings.sessionLog'>

/**
 * Render the accepted API upload state.
 * @param props - settings hooks, writer and localized copy.
 * @returns the bottom preference row.
 */
export function UploadRow({ useUpload, useMutation, setEnabled, t }: PropsRuntime<'settings.general.item'> & Face) {
  const upload = useUpload(value => value)
  const busy = useMutation(value => value.busy)
  return <div className={css.row}>
    <div>
      <div className={css.title}>{t('title')}</div>
      <div className={css.description}>{t('description')}</div>
    </div>
    <Switch checked={upload.value?.enabled === true} label={t('title')}
      disabled={busy || upload.status !== 'ready' || !upload.writable}
      onChange={(enabled) => { void setEnabled(enabled) }} />
  </div>
}

/**
 * Keep the save outcome visible after settings closes.
 * @param props - mutation hook, dismissal and localized copy.
 * @returns the current toast, or nothing.
 */
export function UploadToast({ useMutation, dismiss, t }: PropsRuntime<'shell.overlay'> & Face) {
  const state = useMutation(value => value)
  if (state.notice === null) return null
  return <Toast key={state.sequence} text={t(state.notice)} onDone={dismiss}
    {...state.notice === 'saved' ? { tone: 'success' as const } : {}} />
}
