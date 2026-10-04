/** Anchored type-filter editor with asynchronous suggestions and explicit confirmation. */

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MenuSurface, useAnchoredPosition } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './inspector.module.css'

/** Current confirmed query and an asynchronous candidate source. */
export type InspectorTypeFilterProps = PropsLocale<'session-inspector'> & {
  readonly value: string
  readonly suggest: (query: string) => Promise<readonly string[]>
  readonly apply: (query: string) => void
}

/**
 * Edit a type fragment without filtering until Enter, Apply, or a candidate is selected.
 * @param props - Confirmed query, candidate resolver, commit callback, and localized copy.
 * @returns A header button and its portaled editor; stale responses cannot replace newer suggestions.
 */
export function TypeFilter({ value, suggest, apply, t }: InspectorTypeFilterProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value)
  const [active, setActive] = useState(-1)
  const [result, setResult] = useState<{ query: string; items: readonly string[]; error?: string }>()
  const anchor = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const id = useId()
  const listId = `${id}-types`
  const position = useAnchoredPosition({ open, anchorRef: anchor, panelRef: panel, gap: 4, margin: 12 })
  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus) anchor.current?.focus({ preventScroll: true })
  }, [])
  const commit = (query: string): void => { apply(query); close(true) }
  useEffect(() => {
    if (!open) return
    input.current?.focus({ preventScroll: true })
    input.current?.select()
    const outside = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Node && !panel.current?.contains(target) && !anchor.current?.contains(target)) close(false)
    }
    const blur = (): void => { close(false) }
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('blur', blur)
    }
  }, [open, close])
  useEffect(() => {
    if (!open) return
    let current = true
    setResult(undefined)
    setActive(-1)
    void Promise.resolve().then(() => suggest(draft)).then((items) => {
      if (current) setResult({ query: draft, items })
    }, (error: unknown) => {
      if (current) setResult({ query: draft, items: [], error: error instanceof Error ? error.message : String(error) })
    })
    return () => { current = false }
  }, [open, draft, suggest])
  const current = result?.query === draft ? result : undefined
  const items = current?.items ?? []
  const selected = active >= 0 && active < items.length ? active : -1
  useEffect(() => {
    if (selected >= 0) panel.current?.querySelectorAll<HTMLElement>('[role="option"]')[selected]?.scrollIntoView({ block: 'nearest' })
  }, [selected])
  return <>
    <button ref={anchor} type="button" className={css.typeFilterButton} aria-label={t('filter.title')}
      title={value === '' ? t('filter.title') : `${t('filter.title')}: *${value}*`}
      aria-haspopup="dialog" aria-expanded={open} aria-pressed={value !== ''}
      onClick={() => {
        if (open) { close(true); return }
        setDraft(value); setResult(undefined); setActive(-1); setOpen(true)
      }}>
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
        <path d="M2 3h12L9.5 8v5l-3-1.5V8L2 3Z" />
      </svg>
    </button>
    {open && createPortal(<MenuSurface compact ref={panel} className={css.typeFilterPanel} role="dialog" aria-label={t('filter.title')}
      style={position ?? { left: 0, top: 0, visibility: 'hidden' }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true) }
      }}
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)
          && !anchor.current?.contains(event.relatedTarget)) close(false)
      }}>
      <div>
        <input ref={input} className={css.typeFilterInput} value={draft} role="combobox" aria-label={t('filter.input')}
          aria-autocomplete="list" aria-expanded aria-controls={listId}
          aria-activedescendant={selected < 0 ? undefined : `${id}-option-${selected}`}
          placeholder={t('filter.placeholder')} onChange={(event) => { setDraft(event.currentTarget.value); setActive(-1) }}
          onKeyDown={(event) => {
            // oxlint-disable-next-line typescript/no-deprecated -- Safari reports IME confirmation with 229 after isComposing clears.
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              setActive(items.length === 0 ? -1 : selected < 0 ? event.key === 'ArrowDown' ? 0 : items.length - 1
                : (selected + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length)
            } else if (event.key === 'Enter') {
              event.preventDefault()
              commit(items[selected] ?? draft)
            }
          }} />
        <div className={css.typeFilterHelp}>{t('filter.help')}</div>
        <div id={listId} role="listbox" aria-label={t('filter.candidates')} aria-busy={current === undefined} className={css.typeFilterOptions}>
          {items.map((type, index) => <button key={type} id={`${id}-option-${index}`} type="button" role="option"
            aria-selected={selected === index} tabIndex={-1} title={type}
            onPointerDown={(event) => { event.preventDefault() }} onClick={() => { commit(type) }}>{type}</button>)}
        </div>
        {current === undefined && <div role="status">{t('filter.loading')}</div>}
        {current?.error !== undefined ? <div role="alert">{t('filter.failed')} {current.error}</div>
          : current !== undefined && items.length === 0 && <div role="status">{t('filter.noCandidates')}</div>}
        <div className={css.typeFilterActions}>
          <button type="button" onClick={() => { setDraft(''); setActive(-1); input.current?.focus() }}>{t('filter.clear')}</button>
          <button type="button" onClick={() => { close(true) }}>{t('filter.cancel')}</button>
          <button type="button" onClick={() => { commit(draft) }}>{t('filter.apply')}</button>
        </div>
      </div>
    </MenuSurface>, document.body)}
  </>
}
