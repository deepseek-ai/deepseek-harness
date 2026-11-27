/** Read-only selection, navigation and copying. */
import { useRef } from 'react'
import type { OfficeInteraction, OfficeInteractionContext } from './interaction.ts'
import { copyOfficeSelection, selectionNavigationKeys, useOfficeSelection } from './useOfficeSelection.tsx'
import css from './Selection.module.css'

/**
 * Bind selection and rich copying to the read-only textarea, canvas and viewport.
 * @param context - Current preview and ordered native requests.
 * @returns Selection controls that never submit document mutations.
 */
export function usePreviewInteraction(context: OfficeInteractionContext): OfficeInteraction {
  const { documentType, t, send, request, action, inputQueue, playing, settling, renderFailure } = context
  const input = useRef<HTMLTextAreaElement>(null)
  const focus = (): void => { input.current?.focus({ preventScroll: true }) }
  const selection = useOfficeSelection(context, focus)
  return {
    ...selection, focus, isInputTarget: target => target === input.current,
    key: (event) => {
      if (settling.current || playing || renderFailure !== undefined) return
      const modifier = event.ctrlKey || event.metaKey
      if (modifier && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        action(() => send.command({ command: 'SelectAll', arguments: {} }))
        return
      }
      if (modifier && event.key.toLowerCase() === 'c') {
        event.preventDefault()
        action(() => inputQueue.current.send(() => copyOfficeSelection(request)))
        return
      }
      const key = selectionNavigationKeys[event.key]
      if (key === undefined) return
      event.preventDefault()
      action(() => send.input({ op: 'key', type: 0, character: 0,
        key: event.key === 'Escape' ? key : key | (event.shiftKey ? 4096 : 0) | (modifier ? 8192 : 0) | (event.altKey ? 16384 : 0) }))
    },
    overlay: <>
      {selection.overlay}
      {documentType !== undefined && !playing && <textarea ref={input} className={css.input}
        aria-label={t('selection')} readOnly
        onPaste={(event) => { event.preventDefault() }} onCut={(event) => { event.preventDefault() }}
        onCopy={(event) => {
          event.preventDefault()
          if (!settling.current && renderFailure === undefined)
            action(() => inputQueue.current.send(() => copyOfficeSelection(request)))
        }} />}
    </>,
  }
}
