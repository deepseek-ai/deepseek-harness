/** Floating Session panel: section titles drawn from the section roster, bodies from the section slot. */
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { isBehindModal } from '@deepseek-ai/dsh-client-ui-primitives'
import { panelElementId, toggleElementId } from './element-ids.ts'
import type { SessionPanelProps, SessionPanelSectionOwnerProps } from './slots.ts'
import { fitsLayout, presentationOf } from './visibility.ts'
import css from './SessionPanel.module.css'

/**
 * Close the overlay on Escape and on a pointerdown outside the panel. The
 * toggle and open menus, such as a row's context menu, count as inside, and a
 * modal above the page keeps Escape. Escape returns focus to the toggle when
 * focus was inside the panel.
 * @param panel - the overlay element.
 * @param open - whether the overlay shows; false detaches the listeners.
 * @param toggleId - id of the Session's toggle.
 * @param close - closes the overlay.
 */
function useOverlayDismissal(panel: { readonly current: HTMLElement | null }, open: boolean, toggleId: string, close: () => void): void {
  useEffect(() => {
    if (!open) return
    const inside = (target: EventTarget | null): boolean => target instanceof Element && (
      panel.current?.contains(target) === true
      || document.getElementById(toggleId)?.contains(target) === true
      || target.closest('[role="menu"]') !== null
    )
    const onPointerDown = (event: PointerEvent): void => {
      if (!inside(event.target)) close()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || isBehindModal(panel.current)) return
      event.preventDefault()
      const focused = panel.current?.contains(document.activeElement) === true
      close()
      if (focused) document.getElementById(toggleId)?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [panel, open, toggleId, close])
}

/**
 * Render the panel while it docks or shows as an overlay. Each section keeps
 * its title row and body; CSS hides a section whose body rendered nothing.
 * The overlay closes on Escape and on an outside pointerdown.
 * @param props - Session values, the main body layout, shared visibility, sections, and copy.
 * @returns the panel, or null while it is hidden.
 */
export function SessionPanel({
  sessionId, useLayout, useVisibility, useSections, closeOverlay, renderSlot, t,
}: SessionPanelProps): ReactNode {
  const fits = useLayout(fitsLayout)
  const presentation = useVisibility(visibility => presentationOf(fits, visibility, sessionId))
  const sections = useSections(entries => entries)
  const panel = useRef<HTMLElement>(null)
  const dismissOverlay = useCallback(() => { closeOverlay(sessionId) }, [closeOverlay, sessionId])
  const owner = useMemo((): SessionPanelSectionOwnerProps | undefined => presentation === 'hidden'
    ? undefined
    : { presentation, dismissOverlay },
  [presentation, dismissOverlay])
  useOverlayDismissal(panel, presentation === 'overlay', toggleElementId(sessionId), dismissOverlay)
  if (owner === undefined) return null
  return (
    <aside
      id={panelElementId(sessionId)}
      className={css.panel}
      aria-label={t('panel.name')}
      ref={panel}
      data-session-panel={owner.presentation}
    >
      {sections.map((section) => {
        const titleId = `${panelElementId(sessionId)}-${section.id}`
        return (
          <section key={section.id} className={css.section} aria-labelledby={titleId} data-session-panel-section={section.id}>
            <div className={css.head}>
              <h2 id={titleId} className={css.title}>{section.label}</h2>
              <div className={css.actions}>
                {renderSlot('conversation.session.panel.section.actions', {}, { entryKey: section.id })}
              </div>
            </div>
            <div className={css.body}>
              {renderSlot('conversation.session.panel.section', owner, { only: section.id })}
            </div>
          </section>
        )
      })}
    </aside>
  )
}
