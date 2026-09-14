/** A Session header lifetime restores retained Host terminals without saving sidebar layout. */
import { useEffect, useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from './locales.ts'

/** The plugin coordinates once-per-page recovery; the component only owns an error notice. */
export interface TerminalRecoveryInjected {
  /** @returns after retained terminals have been opened as sidebar tabs. */
  readonly restore: () => Promise<void>
}

/**
 * Restore terminals when a Session is displayed, with a retry action on lookup failure.
 * @param props - Session header lifetime, restoration callback and localized copy.
 * @returns nothing on success, or an unobtrusive retry control.
 */
export function TerminalRecovery({ restore, t }: PropsRuntime<'conversation.session.header.actions'> & PropsLocale<'sidebarTerminal'> & TerminalRecoveryInjected): ReactNode {
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    void restore().then(() => { if (active) setError(undefined) }, (reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { active = false }
  }, [restore, attempt])
  return error === undefined ? null : <button type="button" title={t('recoveryFailed', { message: error })} onClick={() => { setError(undefined); setAttempt(value => value + 1) }}>{t('retryRecovery')}</button>
}
