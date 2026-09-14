/**
 * Trigger candidate menu: renders the InputTriggerService menu store into the
 * conversation.input.overlay anchor. Closed state renders null (the overlay
 * slot stays mounted); groups render in roster order under localized title
 * rows. A pending group keeps showing the items it already had (the reducer
 * retains them across a query refinement) and falls back to two skeleton
 * rows only while it has none; pointer picks route back through
 * the service (combobox pattern — focus never leaves the textarea, so rows
 * are mousedown-handled and the highlight is exposed via
 * aria-activedescendant on the listbox). A row reads title, then the
 * command-name alias when the title is not the name in another letter case
 * (a localized title), then the description right-aligned. A source publishing crumbs gets a breadcrumb
 * header pinned above the scrolling list.
 */
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { IconChevronRightOutline14, ReferenceIcon, useAnchoredMaxHeight } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './MenuView.module.css'
import type { MenuViewInjected } from './slots.ts'
import type { MenuKey } from './locales.ts'

/** Full menu props: injected face + the locale seat. */
export type MenuViewProps = MenuViewInjected & PropsLocale<'slash.menu'>

/** Height cap that fits the two headings and eight built-in command rows. */
const MAX_HEIGHT = 400

/** DOM id of one option row (the aria-activedescendant target). */
function optionId(source: string, index: number): string {
  return `dsh-slash-option-${source}-${index}`
}

/**
 * Render the candidate menu overlay entry.
 * @param props - injected face (the menu store and the pick route); `t` rides the standard locale seat.
 * @returns the dropdown while open; null while closed.
 */
export function MenuView({ menu, headers, onPick, onCrumb, onHover, onDismiss, t }: MenuViewProps) {
  const state = useSyncExternalStore(
    fn => menu.subscribe(fn),
    () => menu.getSnapshot(),
  )
  const crumbs = useSyncExternalStore(
    fn => headers.subscribe(fn),
    () => headers.getSnapshot(),
  )
  const listRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const [hasOverflowBelow, setHasOverflowBelow] = useState(false)
  // The list is bottom-anchored above the composer; clamp the design cap to
  // the space above it, re-measured on every store update (the anchor moves
  // when the composer grows).
  const maxHeight = useAnchoredMaxHeight(listRef, MAX_HEIGHT, state)
  const updateOverflowHint = useCallback(() => {
    const viewport = viewportRef.current
    setHasOverflowBelow(viewport !== null
      && viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 1)
  }, [])
  useLayoutEffect(() => {
    updateOverflowHint()
  }, [state, maxHeight, updateOverflowHint])
  const highlight = state.open ? state.highlight : null
  // Focus stays in the textarea (combobox pattern), so the browser never
  // scrolls the active option into view on keyboard moves — do it here.
  useEffect(() => {
    if (highlight === null) return
    document.getElementById(optionId(highlight.source, highlight.index))
      ?.scrollIntoView({ block: 'nearest' })
  }, [highlight])
  // Dismiss on pointer outside the menu AND outside the composer card
  // (clicking the textarea or bottom bar must not close the menu).
  useEffect(() => {
    if (!state.open) return
    const onPointerDown = (ev: PointerEvent): void => {
      if (!(ev.target instanceof Node)) return
      if (listRef.current?.contains(ev.target)) return
      const composerCard = listRef.current?.closest('[data-composer-card]')
      if (composerCard?.contains(ev.target)) return
      onDismiss()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => { document.removeEventListener('pointerdown', onPointerDown, true) }
  }, [state.open, onDismiss])
  if (!state.open) return null
  return (
    // The listbox role sits on the scrolling viewport, not this shell: a
    // breadcrumb header is not an option, and a listbox may not carry one.
    <div
      ref={listRef}
      className={css.menu}
      style={{ maxHeight }}
      data-trigger-menu=""
      data-overflow-below={hasOverflowBelow || undefined}
    >
      {state.groups.map((group) => {
        const trail = crumbs.get(group.source)
        return trail === undefined ? null : (
          <nav key={group.source} className={css.crumbs} aria-label={t('crumbs.aria')}>
            {trail.map((crumb, index) => (
              <Fragment key={`${String(index)}-${crumb.value}`}>
                {index > 0 && <span className={css.crumbSeparator} aria-hidden><IconChevronRightOutline14 /></span>}
                <button
                  type="button"
                  className={clsx(css.crumb, crumb.current === true && css.crumbCurrent)}
                  aria-current={crumb.current === true ? 'location' : undefined}
                  disabled={crumb.current === true}
                  // mousedown, not click: the composer keeps focus, same as a row.
                  onMouseDown={(ev) => {
                    ev.preventDefault()
                    onCrumb(group.source, index)
                  }}
                >
                  {crumb.label}
                </button>
              </Fragment>
            ))}
          </nav>
        )
      })}
      <div
        ref={viewportRef}
        className={css.viewport}
        role="listbox"
        aria-label={t('suggestions.aria')}
        aria-activedescendant={highlight !== null ? optionId(highlight.source, highlight.index) : undefined}
        onScroll={updateOverflowHint}
      >
        {state.groups.map(group => (group.status === 'ready' && group.items.length === 0)
          ? null
          : (
            <Fragment key={group.source}>
              {/* Source names key the dictionary open-endedly: the lookup chain
                  returns an unknown key verbatim, so an unregistered source
                  shows its raw name — hence the cast past the typed key union. */}
              {group.showGroupTitle === false || group.items.some(item => item.section !== undefined)
                ? null
                : <div className={css.groupTitle} role="presentation" data-source={group.source}>{t(group.source as MenuKey)}</div>}
              {group.status === 'pending' && group.items.length === 0
                ? (
                  <div role="status" aria-label={t('loading')} data-source={group.source}>
                    <div className={css.skeletonRow}><span className={css.skeletonBar} style={{ width: '32%' }} /></div>
                    <div className={css.skeletonRow}><span className={css.skeletonBar} style={{ width: '48%' }} /></div>
                  </div>
                )
                : group.items.map((item, index) => {
                  const active = highlight !== null && highlight.source === group.source && highlight.index === index
                  return (
                    <Fragment key={optionId(group.source, index)}>
                      {item.section !== undefined && item.section !== group.items[index - 1]?.section
                        ? <div className={css.sectionTitle} role="presentation">{item.section}</div>
                        : null}
                      <button
                        id={optionId(group.source, index)}
                        type="button"
                        role="option"
                        aria-selected={active}
                        className={clsx(css.item, active && css.active)}
                        // mousedown, not click: the textarea keeps focus (combobox
                        // pattern) — preventing default stops the focus steal, and the
                        // pick runs before any blur-driven teardown.
                        onMouseDown={(ev) => {
                          ev.preventDefault()
                          onPick(group.source, index)
                        }}
                        // mousemove, not mouseenter: real pointer motion moves the
                        // shared highlight; keyboard scrolling rows under a resting
                        // pointer must not steal it back.
                        onMouseMove={active ? undefined : () => { onHover(group.source, index) }}
                      >
                        {item.icon !== undefined && (
                          <span className={css.itemIcon} aria-hidden>
                            {typeof item.icon === 'string'
                              ? <ReferenceIcon kind={item.icon} size={16} />
                              : <item.icon size={16} />}
                          </span>
                        )}
                        <span className={css.itemName}>{item.label ?? item.name}</span>
                        {item.label !== undefined && item.label.toLowerCase() !== item.name.toLowerCase() && (
                          <span className={css.itemAlias}>{item.name}</span>
                        )}
                        {item.description !== undefined && <span className={css.itemDescription}>{item.description}</span>}
                        {item.drill === true && (
                          <span className={css.trailing}>
                            {/* Visual hint only: Tab drills the highlighted row (the
                                keyboard twin of the chevron, which owns the aria label). */}
                            <span className={css.drillHintText} aria-hidden>{t('drill.hint')}</span>
                            <kbd className={css.drillHint} aria-hidden>{t('drill.key')}</kbd>
                            <span
                              role="button"
                              aria-label={t('drill.aria')}
                              className={css.drill}
                              // mousedown so the composer keeps focus, same as the row;
                              // stopPropagation keeps the row's settling pick out of it.
                              onMouseDown={(ev) => {
                                ev.preventDefault()
                                ev.stopPropagation()
                                onPick(group.source, index, 'drill')
                              }}
                            >
                              <IconChevronRightOutline14 />
                            </span>
                          </span>
                        )}
                      </button>
                    </Fragment>
                  )
                })}
            </Fragment>
          ))}
      </div>
    </div>
  )
}
