/** Clipboard feedback that survives closing the settings panel. */
import { IconWarningOutlineMedium, Toast } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { LoginLinkFace } from './login-link-controller.ts'

/**
 * Present successful and failed clipboard writes outside the settings panel.
 * @param props - renderer-bound feedback, dismissal action, and localized copy.
 * @returns the latest clipboard toast, or nothing.
 */
export function LoginLinkToast({ useLoginLink, dismissCopyNotice, t }: PropsRuntime<'shell.overlay'> & InjectFace<LoginLinkFace> & PropsLocale<'remoteConnection'>) {
  const { notice, sequence } = useLoginLink(state => state)
  if (notice === null) return null
  return <Toast key={sequence} text={t(notice)} onDone={() => { dismissCopyNotice(sequence) }}
    {...notice === 'linkCopied' ? { tone: 'success' as const } : { icon: <IconWarningOutlineMedium /> }} />
}
