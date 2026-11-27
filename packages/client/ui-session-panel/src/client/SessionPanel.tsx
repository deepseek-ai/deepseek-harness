/** Floating Session panel in the Chat View's aside: section titles drawn from the section roster, bodies from the section slot. */
import {
  useCallback, useEffect, useId, useMemo, useRef, useState, type AnimationEvent, type DragEvent, type FocusEvent, type ReactNode,
} from 'react'
import { IconDragHandleOutlineRegular, isBehindModal, observeComposition, useRowDragPreview } from '@deepseek-ai/dsh-client-ui-primitives/client'
// Type-only: the `useMediaQuery` standard prop merge.
import type {} from '@deepseek-ai/dsh-client-ui-responsive/client'
import { panelElementId, toggleElementId } from './element-ids.ts'
import { ENVIRONMENT_SECTION_ID } from './sections.ts'
import type { SessionPanelPresentation, SessionPanelProps, SessionPanelSectionOwnerProps } from './slots.ts'
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
    const inside = (target: Node): boolean => panel.current?.contains(target) === true
      || document.getElementById(toggleId)?.contains(target) === true
      || (target as Partial<Element>).closest?.('[role="menu"]') != null
    const onPointerDown = (event: PointerEvent): void => {
      if (!inside(event.target as Node)) close()
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
      if (event.relatedTarget !== null && !event.currentTarget.contains(event.relatedTarget)) inside.current = false
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
 * Whether the reader can move a section: at least two of the sections that
 * show have a drag handle. With one, every place it could land is the place
 * it has, since a section always lands after Environment. CSS hides a
 * section whose body rendered nothing, so the answer is read from the page.
 * @param head - a section's title row.
 * @returns whether a drag can change the order.
 */
function canReorder(head: Element): boolean {
  const panel = head.closest('[data-session-panel]')
  /* v8 ignore next -- a title row renders only inside the panel. */
  if (panel === null) return false
  let movable = 0
  for (const section of panel.querySelectorAll('[data-session-panel-section]')) {
    if (section.querySelector('[data-session-panel-grip]') !== null && getComputedStyle(section).display !== 'none') movable += 1
  }
  return movable >= 2
}

/** What the panel showed at its last render, and the entrance or exit it is playing. */
interface PanelMotion {
  /** How the panel showed. */
  readonly presentation: SessionPanelPresentation | 'hidden'
  /** Whether the panel had room to dock. */
  readonly fits: boolean
  /** The animation in progress; absent once it ends. */
  readonly phase?: 'enter' | 'exit'
  /** The presentation a leaving panel keeps until its exit ends. */
  readonly leaving?: SessionPanelPresentation
}

/**
 * Decide the motion for a change in what the panel shows. The panel plays
 * its entrance or exit only when the reader's press shows or hides it: the
 * toggle, or a press that closes the overlay. A change in the room to dock
 * shows or hides the panel at once, as when a panel mounts and learns its
 * room, on a switch to another Session, or when the window resizes. Nothing
 * plays for a reader who asked for reduced motion.
 * @param motion - what the panel showed at its last render.
 * @param presentation - how the panel shows now.
 * @param fits - whether the panel has room to dock now.
 * @param reducedMotion - whether the reader asks for reduced motion now.
 * @returns the state for this render.
 */
function motionAfter(
  motion: PanelMotion, presentation: SessionPanelPresentation | 'hidden', fits: boolean, reducedMotion: boolean,
): PanelMotion {
  const before = motion.presentation
  if ((before === 'hidden') === (presentation === 'hidden')) return { ...motion, presentation, fits }
  if (motion.fits !== fits || reducedMotion) return { presentation, fits }
  return before === 'hidden' ? { presentation, fits, phase: 'enter' } : { presentation, fits, phase: 'exit', leaving: before }
}

/**
 * Let the reader reorder the sections by dragging a section's title row onto
 * another section. The drag is the browser's own, with an offscreen copy of
 * the title row as its image, and a drop moves the section through
 * `moveSection`: to the side of the target the pointer's half names, and
 * always after Environment, whose own title row is no drag source. A drag
 * does not start while fewer than two shown sections can move.
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
          if (!canReorder(event.currentTarget)) {
            event.preventDefault()
            return
          }
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
 * Render the panel while it docks or shows as an overlay, and always its
 * dock probe. Each section keeps its title row and body; CSS hides a section
 * whose body rendered nothing. The overlay closes on Escape and on an
 * outside pointerdown. CSS sizes the docked panel from the Chat View's end
 * gutter and makes the probe 1px wide while the panel has room to dock: that
 * gutter holds it, or the transcript can move aside to leave it. The plugin
 * observes the probe, so the panel renders again only when the docking
 * decision flips. While the docking preference is on, the probe carries the
 * mark that has the Conversation body keep the panel's room free. A press
 * that shows or hides the panel plays its entrance or exit, and the probe
 * then carries the mark that has the Conversation body move the transcript
 * over the same time; a leaving panel stays until its exit ends. A panel that
 * shows or hides for its room, as on a switch to another Session or a resized
 * window, does so at once. The title row of every section but
 * Environment is draggable, which reorders the sections, and holds a drag
 * handle that its stylesheet shows on hover.
 * @param props - Session values, shared visibility, sections and their move action, the dock probes and their ref factory, and copy.
 * @returns the dock probe and, unless hidden, the panel.
 */
export function SessionPanel({
  sessionId, useVisibility, useSections, useProbes, createProbeRef, closeOverlay, moveSection, renderSlot, useMediaQuery, t,
}: SessionPanelProps): ReactNode {
  const probe = useId()
  // One ref lifecycle for this mounted panel: the entry remounts with its Session, so the Session is fixed.
  const [probeRef] = useState(() => createProbeRef(sessionId, probe))
  const fits = useProbes(probes => probes.get(probe) === true)
  const presentation = useVisibility(visibility => presentationOf(fits, visibility, sessionId))
  const docks = useVisibility(visibility => visibility.pinned)
  const sections = useSections(entries => entries)
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const panel = useRef<HTMLElement>(null)
  const dismissOverlay = useCallback(() => { closeOverlay(sessionId) }, [closeOverlay, sessionId])
  const [motion, setMotion] = useState<PanelMotion>({ presentation, fits })
  if (motion.presentation !== presentation || motion.fits !== fits) setMotion(motionAfter(motion, presentation, fits, reducedMotion))
  const rendered = presentation === 'hidden' && motion.leaving !== undefined ? motion.leaving : presentation
  const owner = useMemo((): SessionPanelSectionOwnerProps | undefined => rendered === 'hidden'
    ? undefined
    : { presentation: rendered, dismissOverlay },
  [rendered, dismissOverlay])
  useOverlayDismissal(panel, presentation === 'overlay', toggleElementId(sessionId), dismissOverlay)
  const focus = useFocusReturn(presentation === 'hidden', toggleElementId(sessionId))
  const reorder = useSectionReorder(moveSection)
  const endMotion = useCallback((event: AnimationEvent<HTMLElement>): void => {
    // Rows animate too, and their events bubble; only the panel's own animation ends its entrance or exit.
    if (event.target === event.currentTarget) setMotion(current => ({ presentation: current.presentation, fits: current.fits }))
  }, [])
  return (
    <>
      <span
        ref={probeRef}
        className={css.dockProbe}
        data-session-panel-probe=""
        data-session-panel-reserve={docks ? '' : undefined}
        data-session-panel-moving={motion.phase === undefined ? undefined : ''}
      />
      {owner !== undefined && (
        <aside
          id={panelElementId(sessionId)}
          className={css.panel}
          aria-label={t('panel.name')}
          ref={panel}
          onFocus={focus.onFocus}
          onBlur={focus.onBlur}
          onAnimationEnd={endMotion}
          data-session-panel={owner.presentation}
          data-session-panel-motion={motion.phase}
        >
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
