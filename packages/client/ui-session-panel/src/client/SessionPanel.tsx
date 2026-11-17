/** Floating Session panel in the Chat View's aside: section titles drawn from the section roster, bodies from the section slot. */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type DragEvent, type FocusEvent, type ReactNode } from 'react'
import {
  IconDragHandleOutlineRegular, IconPinFillRegular, IconPinOutlineRegular, isBehindModal, observeComposition, Tooltip, useRowDragPreview,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { panelElementId, toggleElementId } from './element-ids.ts'
import { ENVIRONMENT_SECTION_ID } from './sections.ts'
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

/** Where a dragged section would land: beside this section, on this side of it. */
interface DropTarget {
  readonly id: string
  readonly placement: 'before' | 'after'
}

/** The half of a section the pointer is over, which is the side a dropped section lands on. */
function sectionHalf(event: DragEvent<HTMLElement>): DropTarget['placement'] {
  const rect = event.currentTarget.getBoundingClientRect()
  return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

/**
 * Let the reader reorder the sections by dragging a section's title row onto
 * another section. The drag is the browser's own, with an offscreen copy of
 * the title row as its image, and a drop moves the section through
 * `moveSection`: to the side of the target the pointer's half names, and
 * always after Environment, whose own title row is no drag source.
 * @param moveSection - moves a section beside another.
 * @returns the section being dragged, where it would land, and the handlers for a section and its title row.
 */
function useSectionReorder(moveSection: (id: string, target: string, placement: DropTarget['placement']) => void) {
  const preview = useRowDragPreview(css.dragPreview as string)
  const [dragged, setDragged] = useState<string>()
  const [target, setTarget] = useState<DropTarget>()
  const end = (): void => {
    setDragged(undefined)
    setTarget(undefined)
  }
  const placementOver = (id: string, event: DragEvent<HTMLElement>): DropTarget['placement'] =>
    id === ENVIRONMENT_SECTION_ID ? 'after' : sectionHalf(event)
  return {
    dragged,
    target,
    section: (id: string) => ({
      onDragOver: (event: DragEvent<HTMLElement>): void => {
        if (dragged === undefined) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        const placement = placementOver(id, event)
        setTarget(current => dragged === id
          ? undefined
          : current?.id === id && current.placement === placement ? current : { id, placement })
      },
      onDragLeave: (event: DragEvent<HTMLElement>): void => {
        // Leaving a child for another part of the section also reports a leave, and browsers name no next
        // target for it; the pointer's position says whether the drag left the section.
        const rect = event.currentTarget.getBoundingClientRect()
        const inside = event.clientX >= rect.left && event.clientX < rect.right && event.clientY >= rect.top && event.clientY < rect.bottom
        if (!inside) setTarget(current => current?.id === id ? undefined : current)
      },
      onDrop: (event: DragEvent<HTMLElement>): void => {
        if (dragged === undefined) return
        event.preventDefault()
        moveSection(dragged, id, placementOver(id, event))
        end()
      },
    }),
    head: (id: string) => id === ENVIRONMENT_SECTION_ID
      ? {}
      : {
        draggable: true,
        onDragStart: (event: DragEvent<HTMLElement>): void => {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('application/x-dsh-session-panel-section', id)
          setDragged(id)
          preview.start(event)
        },
        onDragEnd: (): void => {
          if (preview.clear()) end()
        },
      },
  }
}

/**
 * Render the panel while it docks or shows as an overlay, and always its two
 * probes. Each section keeps its title row and body; CSS hides a section
 * whose body rendered nothing. The overlay closes on Escape and on an
 * outside pointerdown. CSS sizes the docked panel from the Chat View's end
 * gutter and makes each probe 1px wide while its condition holds: the gutter
 * holds the panel, or the transcript can make that room. The plugin observes
 * the probes, so the panel renders again only when a decision flips. While
 * the pin and the docking preference are both on, the gutter probe carries
 * the mark that has the Conversation body keep the panel's room free. The
 * pin button shows where pressing it has an effect: on a docked panel, on an
 * overlay whose transcript can make room, and wherever the pin is on. The
 * title row of every section but Environment is draggable, which reorders
 * the sections, and holds a drag handle that its stylesheet shows on hover.
 * @param props - Session values, shared visibility, sections and their move action, the probes' room and their ref factory, the pin
 * action, and copy.
 * @returns the probes and, unless hidden, the panel.
 */
export function SessionPanel({
  sessionId, useVisibility, useSections, useProbes, createProbeRef, setPinned, closeOverlay, moveSection, renderSlot, t,
}: SessionPanelProps): ReactNode {
  const probe = useId()
  // One ref lifecycle per probe of this mounted panel: the entry remounts with its Session, so the Session is fixed.
  const [gutterRef] = useState(() => createProbeRef(sessionId, probe, 'gutter'))
  const [reserveRef] = useState(() => createProbeRef(sessionId, probe, 'reserve'))
  const room = useProbes(probes => probes.get(probe))
  const presentation = useVisibility(visibility => presentationOf(room, visibility, sessionId))
  const pinned = useVisibility(visibility => visibility.pinned)
  const reserves = useVisibility(visibility => visibility.pinned && visibility.docks)
  const sections = useSections(entries => entries)
  const panel = useRef<HTMLElement>(null)
  const dismissOverlay = useCallback(() => { closeOverlay(sessionId) }, [closeOverlay, sessionId])
  const owner = useMemo((): SessionPanelSectionOwnerProps | undefined => presentation === 'hidden'
    ? undefined
    : { presentation, dismissOverlay },
  [presentation, dismissOverlay])
  useOverlayDismissal(panel, presentation === 'overlay', toggleElementId(sessionId), dismissOverlay)
  const focus = useFocusReturn(owner === undefined, toggleElementId(sessionId))
  const reorder = useSectionReorder(moveSection)
  return (
    <>
      <span
        ref={gutterRef}
        className={css.dockProbe}
        data-session-panel-probe="gutter"
        data-session-panel-reserve={reserves ? '' : undefined}
      />
      <span ref={reserveRef} className={css.reserveProbe} data-session-panel-probe="reserve" />
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
          {(pinned || owner.presentation === 'docked' || room?.reserve === true) && (
            <Tooltip label={t(pinned ? 'pin.unpin' : 'pin.pin')} side="bottom" align="end" delayMs={500} portal>
              <button
                type="button"
                className={css.pin}
                aria-label={t('pin.name')}
                aria-pressed={pinned}
                data-session-panel-pin=""
                onClick={() => { setPinned(sessionId, !pinned) }}
              >
                {pinned ? <IconPinFillRegular size={14} /> : <IconPinOutlineRegular size={14} />}
              </button>
            </Tooltip>
          )}
          {sections.map((section) => {
            const titleId = `${panelElementId(sessionId)}-${section.id}`
            return (
              <section
                key={section.id}
                className={css.section}
                aria-labelledby={titleId}
                data-session-panel-section={section.id}
                data-dragging={reorder.dragged === section.id ? '' : undefined}
                data-drop-target={reorder.target?.id === section.id ? reorder.target.placement : undefined}
                {...reorder.section(section.id)}
              >
                <div className={css.head} {...reorder.head(section.id)}>
                  <h2 id={titleId} className={css.title}>{section.label}</h2>
                  <div className={css.actions}>
                    {renderSlot('conversation.session.panel.section.actions', {}, { entryKey: section.id })}
                  </div>
                  {section.id !== ENVIRONMENT_SECTION_ID && (
                    <span className={css.grip} aria-hidden="true" data-session-panel-grip="">
                      <IconDragHandleOutlineRegular size={14} />
                    </span>
                  )}
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
