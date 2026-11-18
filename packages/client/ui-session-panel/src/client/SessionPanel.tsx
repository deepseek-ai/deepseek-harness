/** Floating Session panel in the Chat View's aside: section titles drawn from the section roster, bodies from the section slot. */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FocusEvent, type ReactNode } from 'react'
import { isBehindModal, observeComposition } from '@deepseek-ai/dsh-client-ui-primitives'
import { panelElementId, toggleElementId } from './element-ids.ts'
import type { SessionPanelProps, SessionPanelSectionOwnerProps } from './slots.ts'
import { presentationOf } from './visibility.ts'
import css from './SessionPanel.module.css'

/**
 * Close the overlay on Escape and on a pointerdown outside the panel. The
 * toggle and open menus, such as a row's context menu, count as inside; a
 * modal above the page and an input method composing text keep Escape, as
 * does a handler that already took it. Escape returns focus to the toggle
 * when focus was inside the panel.
 * @param panel - the overlay element.
 * @param open - whether the overlay shows; false detaches the listeners.
 * @param toggleId - id of the Session's toggle.
 * @param close - closes the overlay.
 */
function useOverlayDismissal(panel: { readonly current: HTMLElement | null }, open: boolean, toggleId: string, close: () => void): void {
  useEffect(() => {
    if (!open) return
    const composition = observeComposition(document)
    const inside = (target: EventTarget | null): boolean => target instanceof Element && (
      panel.current?.contains(target) === true
      || document.getElementById(toggleId)?.contains(target) === true
      || target.closest('[role="menu"]') !== null
    )
    const onPointerDown = (event: PointerEvent): void => {
      if (!inside(event.target)) close()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || composition.guards(event) || event.defaultPrevented || isBehindModal(panel.current)) return
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
      composition.dispose()
    }
  }, [panel, open, toggleId, close])
}

/**
 * Hand focus to the toggle when the panel hides with the keyboard inside it,
 * as when a narrower gutter hides the docked panel: the focused control is
 * gone and the toggle is the control that brings it back.
 * @param hidden - whether the panel renders nothing.
 * @param toggleId - id of the Session's toggle.
 * @returns focus handlers for the panel element.
 */
function useFocusReturn(hidden: boolean, toggleId: string): {
  readonly onFocus: () => void
  readonly onBlur: (event: FocusEvent<HTMLElement>) => void
} {
  const inside = useRef(false)
  useEffect(() => {
    if (!hidden || !inside.current) return
    inside.current = false
    document.getElementById(toggleId)?.focus({ preventScroll: true })
  }, [hidden, toggleId])
  return useMemo(() => ({
    onFocus: () => { inside.current = true },
    onBlur: (event) => {
      // Removal can report no next target; only a move to another element leaves the panel.
      if (event.relatedTarget instanceof Element && !event.currentTarget.contains(event.relatedTarget)) inside.current = false
    },
  }), [])
}

/**
 * Render the panel while it docks or shows as an overlay, and always its
 * dock probe. Each section keeps its title row and body; CSS hides a section
 * whose body rendered nothing. The overlay closes on Escape and on an
 * outside pointerdown. CSS sizes the docked panel from the Chat View's end
 * gutter and makes the probe 1px wide while that gutter holds the panel; the
 * plugin observes the probe, so the panel renders again only when the
 * docking decision flips.
 * @param props - Session values, shared visibility, sections, the dock probes and their ref factory, and copy.
 * @returns the dock probe and, unless hidden, the panel.
 */
export function SessionPanel({
  sessionId, useVisibility, useSections, useProbes, createProbeRef, closeOverlay, renderSlot, t,
}: SessionPanelProps): ReactNode {
  const probe = useId()
  // One ref lifecycle for this mounted panel: the entry remounts with its Session, so the Session is fixed.
  const [probeRef] = useState(() => createProbeRef(sessionId, probe))
  const fits = useProbes(probes => probes.get(probe) === true)
  const presentation = useVisibility(visibility => presentationOf(fits, visibility, sessionId))
  const sections = useSections(entries => entries)
  const panel = useRef<HTMLElement>(null)
  const dismissOverlay = useCallback(() => { closeOverlay(sessionId) }, [closeOverlay, sessionId])
  const owner = useMemo((): SessionPanelSectionOwnerProps | undefined => presentation === 'hidden'
    ? undefined
    : { presentation, dismissOverlay },
  [presentation, dismissOverlay])
  useOverlayDismissal(panel, presentation === 'overlay', toggleElementId(sessionId), dismissOverlay)
  const focus = useFocusReturn(owner === undefined, toggleElementId(sessionId))
  return (
    <>
      <span ref={probeRef} className={css.dockProbe} data-session-panel-probe="" />
      {owner !== undefined && (
        <aside
          id={panelElementId(sessionId)}
          className={css.panel}
          aria-label={t('panel.name')}
          ref={panel}
          onFocus={focus.onFocus}
          onBlur={focus.onBlur}
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
      )}
    </>
  )
}
