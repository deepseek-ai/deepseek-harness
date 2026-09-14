/**
 * One pane: its tab strip (drag source, drop target, split control) and the
 * active tab's body with the dock preview overlay. Presentational; every gesture
 * leaves through `PaneCallbacks`, and the body itself comes from `renderTab`.
 *
 * A chip is a capsule carrying one control, its close, shown over its right
 * end while the chip is active, hovered, or focused; the context menu
 * (secondary press) carries the same close plus whatever the embedder appends.
 * Both close routes draw only while the embedder's `canCloseTab` allows, and
 * a pane's lone chip whose close is withheld draws quiet — no capsule, no
 * hover fill — since there is nothing to select against and nothing to do to
 * it.
 * Between neighbouring chips sits a slot: a fixed-width box drawing a
 * hairline, blank beside the active chip, and the drop caret when a drag
 * targets that index, so a caret never widens the row; the two end slots
 * exist only while targeted. The chips sit in their own box, the strip's one
 * shrinking part: in a narrow pane their titles fade at the clipped edge down
 * to the chip's floor and then the chips scroll there, keeping the active one
 * in view, so the add control after them (drawn while the embedder's
 * `canAddTab` allows), the pane's split control, and the embedder's chrome keep
 * their width and their place at the strip's end.
 */
import { Fragment, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import clsx from 'clsx'
import { IconCloseFill14, IconPlusOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DockZone, LayoutState, PaneNode, TabId } from '../contract/types.ts'
import { getTab } from '../engine/tree.ts'
import type { PaneCallbacks, SplitBlock } from './render.ts'
import { TabMenu } from './TabMenu.tsx'
import { TabTitle } from './TabTitle.tsx'
import css from './dockkit.module.css'

/**
 * The ic_ds_panel_left_outline_16 frame alone: its outer and inner rounded
 * rectangles as one even-odd ring, without the divider. The glyphs below draw
 * inside it so they read as siblings of the panel controls beside them.
 */
const PANEL_FRAME = 'M9.67272 0.522841C10.8339 0.522841 11.76 0.522714 12.4963 0.602493C13.2453 0.683657 13.8789 0.854248 14.4264 1.25197C14.7504 1.48739 15.0355 1.77247 15.2709 2.0965C15.6686 2.64394 15.8392 3.27758 15.9204 4.02655C16.0002 4.7629 16 5.68895 16 6.85014V9.14986C16 10.3111 16.0002 11.2371 15.9204 11.9735C15.8392 12.7224 15.6686 13.3561 15.2709 13.9035C15.0355 14.2275 14.7504 14.5126 14.4264 14.748C13.8789 15.1458 13.2453 15.3163 12.4963 15.3975C11.76 15.4773 10.8339 15.4772 9.67272 15.4772H6.3273C5.16611 15.4772 4.24006 15.4773 3.50371 15.3975C2.75474 15.3163 2.1211 15.1458 1.57366 14.748C1.24963 14.5126 0.964549 14.2275 0.729131 13.9035C0.331407 13.3561 0.160817 12.7224 0.0796529 11.9735C-0.000126137 11.2371 1.25338e-09 10.3111 1.25338e-09 9.14986V6.85014C1.25329e-09 5.68895 -0.000126137 4.7629 0.0796529 4.02655C0.160817 3.27758 0.331407 2.64394 0.729131 2.0965C0.964549 1.77247 1.24963 1.48739 1.57366 1.25197C2.1211 0.854248 2.75474 0.683657 3.50371 0.602493C4.24006 0.522714 5.16611 0.522841 6.3273 0.522841H9.67272ZM4.1828 14.0873L5.54303 14.1118C5.78636 14.1128 6.04709 14.1169 6.3273 14.1169H9.67272C10.8639 14.1169 11.7032 14.1164 12.3493 14.0465C12.9824 13.9779 13.3497 13.8494 13.6268 13.6482C13.8354 13.4966 14.0195 13.3125 14.1711 13.1039C14.3723 12.8268 14.5007 12.4595 14.5693 11.8264C14.6393 11.1803 14.6398 10.341 14.6398 9.14986V6.85014C14.6398 5.65896 14.6393 4.81967 14.5693 4.1736C14.5007 3.54048 14.3723 3.17318 14.1711 2.89609C14.0195 2.68747 13.8354 2.50337 13.6268 2.35179C13.3497 2.1506 12.9824 2.02212 12.3493 1.95353C11.7032 1.88358 10.8639 1.88307 9.67272 1.88307H6.3273C6.04709 1.88307 5.78636 1.8862 5.54303 1.88715L4.1828 1.91166C3.99125 1.9216 3.8148 1.93577 3.65076 1.95353C3.01764 2.02212 2.65034 2.1506 2.37325 2.35179C2.16463 2.50337 1.98052 2.68747 1.82895 2.89609C1.62776 3.17318 1.49928 3.54048 1.43069 4.1736C1.36074 4.81967 1.36023 5.65896 1.36023 6.85014V9.14986C1.36023 10.341 1.36074 11.1803 1.43069 11.8264C1.49928 12.4595 1.62776 12.8268 1.82895 13.1039C1.98052 13.3125 2.16463 13.4966 2.37325 13.6482C2.65034 13.8494 3.01764 13.9779 3.65076 14.0465C3.81478 14.0642 3.99127 14.0774 4.1828 14.0873Z'

/** The split control's glyph: the panel frame with its divider moved to the centre. */
function SplitGlyph(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d={`${PANEL_FRAME}M7.31989 1.88307H8.68012V14.1169H7.31989V1.88307Z`} fill="currentColor" />
    </svg>
  )
}

/**
 * The drop hint's fill per zone: the half or the whole a release would fill
 * drawn solid, so the hint names its zone before its caption is read. A half
 * is drawn out to the frame's outer edge, under the ring, so its visible edge
 * is exactly the ring's inner edge with no seam at the corners; the whole sits
 * one stroke inside the frame so the ring stays visible around it.
 */
const ZONE_FILL: Record<DockZone, string> = {
  center: 'M4.56 3.48H11.44A1.6 1.6 0 0 1 13.04 5.08V10.92A1.6 1.6 0 0 1 11.44 12.52H4.56A1.6 1.6 0 0 1 2.96 10.92V5.08A1.6 1.6 0 0 1 4.56 3.48Z',
  left: 'M4 0.523H8V15.477H4A4 4 0 0 1 0 11.477V4.523A4 4 0 0 1 4 0.523Z',
  right: 'M8 0.523H12A4 4 0 0 1 16 4.523V11.477A4 4 0 0 1 12 15.477H8Z',
  top: 'M0 8V4.523A4 4 0 0 1 4 0.523H12A4 4 0 0 1 16 4.523V8Z',
  bottom: 'M0 8H16V11.477A4 4 0 0 1 12 15.477H4A4 4 0 0 1 0 11.477Z',
}

/** The drop hint's glyph: the panel frame with the zone's fill drawn solid. */
function ZoneGlyph({ zone }: { readonly zone: DockZone }): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d={PANEL_FRAME} fill="currentColor" />
      <path d={ZONE_FILL[zone]} fill="currentColor" />
    </svg>
  )
}

/**
 * One landing card, inset inside the region a release would fill: a dashed
 * frame, the zone's glyph, and its caption. `active` is the region under the
 * pointer; a sibling shown for orientation only draws quieter.
 */
function DockHint({ zone, active, labels }: {
  readonly zone: DockZone
  readonly active: boolean
  readonly labels: PaneCallbacks['labels']
}): ReactNode {
  return (
    <div className={css.dockHint} data-dockkit-dock-zone={zone} data-dockkit-drop-active={active || undefined}>
      <div className={css.dockHintCard}>
        <ZoneGlyph zone={zone} />
        <span className={css.dockHintLabel}>{labels.dropZone[zone]}</span>
      </div>
    </div>
  )
}

/** A pane and the live layout it reads its tabs from. */
export interface TabPanelProps {
  readonly state: LayoutState
  readonly pane: PaneNode
  readonly callbacks: PaneCallbacks
}

/**
 * The chip a navigation key moves focus to, in the WAI-ARIA tabs pattern with
 * manual activation: Left and Right step through the strip and wrap, Home and
 * End jump to its ends. Selecting is a separate key.
 * @returns the chip to focus, or `undefined` when the key is not a navigation key.
 */
function chipToFocus(key: string, tabs: readonly TabId[], tabId: TabId): TabId | undefined {
  const count = tabs.length
  const index = tabs.indexOf(tabId)
  switch (key) {
    case 'ArrowLeft': return tabs[(index - 1 + count) % count]
    case 'ArrowRight': return tabs[(index + 1) % count]
    case 'Home': return tabs[0]
    case 'End': return tabs.at(-1)
    default: return undefined
  }
}

/** Whether a key selects the focused chip. */
function selects(key: string): boolean {
  return key === 'Enter' || key === ' '
}

/**
 * Which sides of the chip box hold chips scrolled out of view, as the
 * `data-dockkit-strip-scroll` value the stylesheet fades: `undefined` while
 * every chip is in view.
 */
function hiddenSides(box: HTMLElement): 'start' | 'end' | 'start end' | undefined {
  // Sub-pixel scroll positions: a side counts as hidden past one whole pixel.
  const start = box.scrollLeft > 1
  const end = box.scrollLeft + box.clientWidth < box.scrollWidth - 1
  if (start && end) return 'start end'
  if (start) return 'start'
  if (end) return 'end'
  return undefined
}

/**
 * Keep the chip box's `data-dockkit-strip-scroll` current: read after each
 * commit that can change the chips, on scroll, and on resize. Written to the
 * DOM directly rather than through state because a reading never changes
 * what renders, only how the stylesheet fades it.
 *
 * Known gap: a content-width change that alters neither `tabs` nor the box's
 * outer size — a live `renderTabTitle` growing a chip, or a drop-caret slot
 * mounting mid-drag — keeps the fade at its last reading until the next
 * scroll or resize. The fade is orientation chrome, so a stale edge fades a
 * few frames late rather than hiding anything.
 */
function useStripScrollFades(box: RefObject<HTMLDivElement | null>, tabs: readonly TabId[]): void {
  useLayoutEffect(() => {
    const element = box.current
    /* v8 ignore next -- the box is rendered unconditionally with the strip. */
    if (element === null) return undefined
    const apply = (): void => {
      const sides = hiddenSides(element)
      if (sides === undefined) delete element.dataset.dockkitStripScroll
      else element.dataset.dockkitStripScroll = sides
    }
    apply()
    element.addEventListener('scroll', apply, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(apply)
    observer?.observe(element)
    return () => {
      element.removeEventListener('scroll', apply)
      observer?.disconnect()
    }
  }, [box, tabs])
}

/**
 * Bring the active chip into the chip box's view whenever the active tab or
 * the row of chips changes: a tab opened or selected past the box's edge, or
 * moved there by a close or a reorder, scrolls the box to it, with the fade
 * band (24px) cleared so the chip is not under it. A chip already in view
 * moves nothing. Direct DOM, like the fades above: the box's scroll position
 * renders nothing.
 */
function useActiveChipInView(
  box: RefObject<HTMLDivElement | null>,
  chips: ReadonlyMap<TabId, HTMLElement>,
  tabs: readonly TabId[],
  activeTabId: TabId | undefined,
): void {
  useLayoutEffect(() => {
    const element = box.current
    const chip = activeTabId === undefined ? undefined : chips.get(activeTabId)
    /* v8 ignore next -- the box and the active tab's chip are rendered with the strip. */
    if (element === null || chip === undefined) return
    const bounds = element.getBoundingClientRect()
    const rect = chip.getBoundingClientRect()
    if (rect.left < bounds.left) element.scrollLeft += rect.left - bounds.left - STRIP_FADE
    else if (rect.right > bounds.right) element.scrollLeft += rect.right - bounds.right + STRIP_FADE
  }, [box, chips, tabs, activeTabId])
}

/** Width of the chip box's fade at a hidden side; mirrors the stylesheet's 24px. */
const STRIP_FADE = 24

/** Why the split control cannot act right now. */
function splitBlockedTitle(labels: PaneCallbacks['labels'], block: SplitBlock): string {
  switch (block) {
    case 'budget': return labels.splitPaneDisabled
    case 'width': return labels.splitPaneNarrow
  }
}

/** The pane's tab strip, split control, and body. */
export function TabPanel({ state, pane, callbacks }: TabPanelProps): ReactNode {
  // The open context menu and the chip that opened it; the menu positions
  // itself against that chip from its portal.
  const [menu, setMenu] = useState<{ readonly tabId: TabId; readonly anchor: HTMLElement } | undefined>(undefined)
  // The mounted chips by tab, for the keys that move focus between them.
  const [chips] = useState(() => new Map<TabId, HTMLElement>())
  const stripTabs = useRef<HTMLDivElement | null>(null)
  useStripScrollFades(stripTabs, pane.tabs)
  useActiveChipInView(stripTabs, chips, pane.tabs, pane.activeTabId)
  const active = pane.activeTabId === undefined ? undefined : getTab(state, pane.activeTabId)
  const block = callbacks.splitBlock(pane.id)
  const target = callbacks.dropTarget
  const stripIndex = target !== undefined && target.kind === 'strip' && target.paneId === pane.id
    ? target.index
    : undefined
  const zone = target !== undefined && target.kind === 'zone' && target.paneId === pane.id
    ? target.zone
    : undefined

  /** Select a tab from a click or a key, unless it is the active pane's selected tab already: that changes nothing. */
  const activate = (tabId: TabId): void => {
    if (state.activePaneId === pane.id && pane.activeTabId === tabId) return
    callbacks.onFocusTab(tabId)
  }

  const focusChip = (tabId: TabId): void => {
    const chip = chips.get(tabId)
    /* v8 ignore next -- every tab in the strip has a mounted chip, registered by its ref. */
    if (chip === undefined) return
    chip.focus()
  }

  return (
    <section
      className={css.pane}
      data-dockkit-pane={pane.id}
      data-dockkit-pane-active={state.activePaneId === pane.id || undefined}
      // A click on the pane's body or strip focuses the pane, unless it is the
      // active one already: that click changes nothing and records nothing. The
      // chips and the strip's controls stop their own clicks: each reports one
      // intent, and that intent already decides which pane is active.
      onClick={() => {
        if (state.activePaneId === pane.id) return
        callbacks.onFocusPane(pane.id)
      }}
    >
      <div className={css.tabStrip} role="tablist" data-dockkit-strip={pane.id}>
        <div ref={stripTabs} className={css.stripTabs} role="presentation" data-dockkit-strip-tabs={pane.id}>
          {pane.tabs.map((tabId, index) => {
            const tab = getTab(state, tabId)
            const selected = tabId === pane.activeTabId
            const closable = callbacks.canCloseTab(tabId)
            // A pane's lone unclosable chip is a label, not a choice: there is
            // no other tab to select against and nothing to do to it.
            const quiet = !closable && pane.tabs.length === 1
            return (
              <Fragment key={tabId}>
                {(index > 0 || stripIndex === index) && (
                  <div
                    className={clsx(css.slot, stripIndex === index && css.slotCaret)}
                    data-dockkit-caret={stripIndex === index ? index : undefined}
                  />
                )}
                <div
                  role="tab"
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  className={clsx(
                    css.tab,
                    selected && css.tabActive,
                    quiet && css.tabQuiet,
                    callbacks.draggingTabId === tabId && css.tabDragging,
                  )}
                  data-dockkit-tab={tabId}
                  data-dockkit-tab-quiet={quiet || undefined}
                  ref={(element) => {
                    if (element === null) chips.delete(tabId)
                    else chips.set(tabId, element)
                  }}
                  // Focus lands on click, not on press: a state change between
                  // pointerdown and the first pointermove rebuilds this subtree,
                  // and Chromium cancels the pointer when the pressed element is
                  // replaced — which would abandon every drag. A drag that ends
                  // elsewhere fires no click, and its own operation carries focus.
                  onPointerDown={(event) => {
                    // A secondary press is the menu, never a drag.
                    if (event.button === 2) return
                    callbacks.onTabPressed(tabId, event)
                  }}
                  onClick={(event) => {
                    event.stopPropagation()
                    activate(tabId)
                  }}
                  onKeyDown={(event) => {
                    // Keys on the chip's nested close control are that control's.
                    if (event.target !== event.currentTarget) return
                    const next = chipToFocus(event.key, pane.tabs, tabId)
                    if (next !== undefined) {
                      event.preventDefault()
                      focusChip(next)
                      return
                    }
                    if (selects(event.key)) {
                      event.preventDefault()
                      activate(tabId)
                    }
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    const anchor = event.currentTarget
                    setMenu(current => current?.tabId === tabId ? undefined : { tabId, anchor })
                  }}
                >
                  <TabTitle>{callbacks.renderTabTitle?.(tab) ?? tab.title}</TabTitle>
                  {closable && (
                    <button
                      type="button"
                      className={css.tabClose}
                      aria-label={callbacks.labels.closeTab}
                      data-dockkit-tab-close={tabId}
                      // A nested control stops its own press: otherwise the press
                      // starts a drag, captures the pointer, and this click never lands.
                      onPointerDown={(event) => { event.stopPropagation() }}
                      onClick={(event) => {
                        event.stopPropagation()
                        callbacks.onCloseTab(tabId)
                      }}
                    >
                      <IconCloseFill14 size={14} />
                    </button>
                  )}
                  {menu?.tabId === tabId && (
                    <TabMenu
                      labels={callbacks.labels}
                      anchor={menu.anchor}
                      onClose={closable ? () => { setMenu(undefined); callbacks.onCloseTab(tabId) } : undefined}
                      onDismiss={() => { setMenu(undefined) }}
                      extras={callbacks.renderTabMenuItems?.(tab, () => { setMenu(undefined) })}
                    />
                  )}
                </div>
              </Fragment>
            )
          })}
          {stripIndex === pane.tabs.length && <div className={clsx(css.slot, css.slotCaret)} data-dockkit-caret={stripIndex} />}
        </div>
        {callbacks.canAddTab(pane.id) && (
          <Tooltip label={callbacks.labels.addTab} side="bottom" delayMs={500}>
            <button
              type="button"
              className={css.addTab}
              aria-label={callbacks.labels.addTab}
              data-dockkit-add-tab={pane.id}
              onClick={(event) => {
                event.stopPropagation()
                callbacks.onAddTab(pane.id)
              }}
            >
              <IconPlusOutline16 size={14} />
            </button>
          </Tooltip>
        )}
        <div className={css.stripFill} data-dockkit-strip-fill />
        {!(callbacks.hideSplitWhenBlocked && block !== undefined) && (
          <Tooltip label={callbacks.labels.splitPane} side="bottom" delayMs={500} disabled={block !== undefined}>
            <button
              type="button"
              className={css.iconButton}
              aria-label={callbacks.labels.splitPane}
              // Disabled buttons fire no hover events, so the blocked reason
              // stays a native title.
              title={block === undefined ? undefined : splitBlockedTitle(callbacks.labels, block)}
              disabled={block !== undefined}
              data-dockkit-split-button={pane.id}
              data-dockkit-split-blocked={block}
              onClick={(event) => {
                event.stopPropagation()
                callbacks.onSplitPane(pane.id)
              }}
            >
              <SplitGlyph />
            </button>
          </Tooltip>
        )}
        {/* The embedder's surface-wide controls, in the top-right pane only: the
            strip is the surface's top edge, and this pane's end is its corner. */}
        {pane.id === callbacks.chromePaneId && callbacks.chrome !== undefined && (
          // The embedder's controls report their own intents; the pane's
          // click-to-focus must not add a focus entry to each of them.
          <div
            className={css.stripChrome}
            data-dockkit-strip-chrome
            onClick={(event) => { event.stopPropagation() }}
          >
            {callbacks.chrome}
          </div>
        )}
      </div>
      <div className={css.paneBody}>
        {active === undefined
          ? <p className={css.empty}>{callbacks.labels.emptyPane}</p>
          : callbacks.renderTab(active)}
        {zone !== undefined && (
          <>
            <div className={css.dockScrim} data-dockkit-dock-scrim />
            {callbacks.horizontalDrops && zone !== 'center'
              ? <>
                <DockHint zone="left" active={zone === 'left'} labels={callbacks.labels} />
                <DockHint zone="right" active={zone === 'right'} labels={callbacks.labels} />
              </>
              : <DockHint zone={zone} active labels={callbacks.labels} />}
          </>
        )}
      </div>
    </section>
  )
}
