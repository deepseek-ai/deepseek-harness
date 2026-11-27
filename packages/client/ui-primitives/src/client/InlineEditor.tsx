/** Multi-line inline editor for short saved-on-Enter drafts such as queued messages and goals. */

import { useLayoutEffect, useRef, type KeyboardEvent } from 'react'
import clsx from 'clsx'
import css from './InlineEditor.module.css'

/**
 * Render an autofocused textarea that grows with its text up to six lines, then scrolls.
 * A textarea rather than an input: HTML strips newlines from single-line input values.
 * Enter saves, Shift+Enter breaks the line, Enter during IME composition does nothing,
 * and Escape cancels.
 * @param props.value - current draft text.
 * @param props.label - localized accessible name.
 * @param props.onChange - receives the edited text.
 * @param props.onSave - called for a plain Enter.
 * @param props.onCancel - called for Escape.
 * @param props.className - extra class for the editor's placement.
 * @returns the textarea.
 */
export function InlineEditor({ value, label, onChange, onSave, onCancel, className }: {
  value: string
  label: string
  onChange: (value: string) => void
  onSave: () => void
  onCancel: () => void
  className?: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    // The textarea mounts before layout effects run.
    const node = ref.current as HTMLTextAreaElement
    const fit = (): void => {
      node.style.height = 'auto'
      // scrollHeight excludes the border that the border-box height includes.
      node.style.height = `${node.scrollHeight + node.offsetHeight - node.clientHeight}px`
    }
    fit()
    // A width change rewraps the text; the refit height leaves the width unchanged.
    const observer = new ResizeObserver(fit)
    observer.observe(node)
    return () => { observer.disconnect() }
  }, [value])

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      onCancel()
      return
    }
    // keyCode 229 is the legacy IME-composition signal engines emit without isComposing.
    const composing = event.nativeEvent.isComposing || Reflect.get(event.nativeEvent, 'keyCode') === 229
    if (event.key !== 'Enter' || event.shiftKey || composing) return
    event.preventDefault()
    onSave()
  }

  return (
    <textarea
      ref={ref}
      autoFocus
      rows={1}
      className={clsx(css.editor, className)}
      aria-label={label}
      value={value}
      onChange={(event) => { onChange(event.currentTarget.value) }}
      onKeyDown={onKeyDown}
    />
  )
}
