import type { ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SessionMarkdownCopyState } from './copy-controller.ts'
import { NS } from './locales.ts'

/** Copy state and dismissal bound into the root overlay entry. */
export interface SessionMarkdownCopyToastInjected {
  hooks: { sessionMarkdownCopy: ObservableSnapshot<SessionMarkdownCopyState> }
  dismiss: () => void
}

/** Props of the root overlay copy notice. */
export type SessionMarkdownCopyToastProps = PropsRuntime<'shell.overlay'>
  & PropsLocale<typeof NS>
  & InjectFace<SessionMarkdownCopyToastInjected>

/**
 * Show the settled copy outcome outside the Session Header and menu lifetime.
 * @param props - copy notice hook, dismissal action, and localized copy.
 * @returns the success or failure toast, or null while no notice shows.
 */
export function SessionMarkdownCopyToast({
  useSessionMarkdownCopy, dismiss, t,
}: SessionMarkdownCopyToastProps): ReactNode {
  const notice = useSessionMarkdownCopy(state => state.notice)
  if (notice === null) return null
  return notice.kind === 'success'
    ? <Toast key={notice.seq} text={t('toast.copied')} tone="success" onDone={dismiss} />
    : (
      <Toast
        key={notice.seq}
        text={t(notice.kind === 'preparationFailed' ? 'toast.preparationFailed' : 'toast.clipboardFailed')}
        icon={<IconWarningOutlineRegular />}
        onDone={dismiss}
      />
    )
}
