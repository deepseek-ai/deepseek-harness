/** Live terminal names in docked and floating tab chrome. */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { TerminalIcon } from './TerminalIcon.tsx'
import type { TerminalInjected } from './face.ts'
import type {} from './locales.ts'
import css from './TerminalBody.module.css'

/**
 * Render the terminal name, editable in place on double-click.
 * @param props - sidebar occurrence, terminal model and localized copy.
 * @returns the terminal icon and current name or its editor.
 */
export function TerminalTitle({ useTabInfo, useTerminal, view, t }: PropsRuntime<'sidebar.right.pane.tab.title'> & PropsLocale<'sidebarTerminal'> & InjectFace<TerminalInjected>): ReactNode {
  const { tab } = useTabInfo()
  const title = useTerminal(tab.id, state => state?.info?.title ?? state?.title) ?? tab.title
  const [editing, setEditing] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const label = useRef<HTMLSpanElement>(null)
  const cancelled = useRef(false)
  useLayoutEffect(() => {
    if (editing) return
    // Dockkit captures the pointer on its drag handle, which receives the double-click.
    const chip = label.current?.closest('[data-dockkit-tab], [data-dockkit-float-grip]')
    const rename = (event: Event): void => {
      event.stopPropagation()
      cancelled.current = false
      setEditing(true)
    }
    chip?.addEventListener('dblclick', rename)
    return () => { chip?.removeEventListener('dblclick', rename) }
  }, [editing])
  useLayoutEffect(() => {
    if (!editing) return
    input.current?.focus()
    input.current?.select()
  }, [editing])
  return <>
    <TerminalIcon />
    {editing ? <input ref={input} className={css.name} defaultValue={title} maxLength={120} aria-label={t('rename')}
      onPointerDown={(event) => { event.stopPropagation() }}
      onClick={(event) => { event.stopPropagation() }}
      onDoubleClick={(event) => { event.stopPropagation() }}
      onBlur={(event) => {
        setEditing(false)
        const next = event.currentTarget.value.trim()
        if (!cancelled.current && next !== '' && next !== title) void view(tab.id).rename(next)
      }}
      onKeyDown={(event) => {
        event.stopPropagation()
        // oxlint-disable-next-line typescript/no-deprecated -- Some IMEs report composition only through keyCode 229.
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
        if (event.key === 'Escape') {
          cancelled.current = true
          event.currentTarget.blur()
        } else if (event.key === 'Enter') event.currentTarget.blur()
      }} />
      : <span ref={label} className={css.title}>{title}</span>}
  </>
}
