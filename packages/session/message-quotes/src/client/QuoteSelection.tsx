/** Quote action rendered through the Chat text-interaction Slot. */
import { useEffect } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './QuoteSelection.module.css'

/**
 * Render the action for a selection admitted by the Quote plugin.
 * @param props - area-local text interaction and standard Session/composer seats.
 * @returns the quote button after a valid selection in a writable conversation.
 */
export function QuoteSelectionAction({ dismiss, readText, clearSelection, inputActions, useSession, t }:
PropsRuntime<'conversation.chat.text-interaction'> & PropsLocale<'messageQuotes'>) {
  const enabled = useSession(s => !s.removed && (s.subagent === null
    || (s.subagent.address.mode === 'continuable' && s.subagent.parentAvailable === true)))
  useEffect(() => {
    if (!enabled) dismiss()
  }, [enabled, dismiss])
  if (!enabled) return null
  return <button type="button" className={css.action} aria-label={t('quote.add')}
    onPointerDown={(event) => { event.preventDefault() }}
    onClick={() => {
      const text = readText()
      if (text === null) { dismiss(); return }
      if (!inputActions.insertQuote(text)) return
      clearSelection()
      dismiss()
    }}>{t('quote.add')}</button>
}
