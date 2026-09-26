/** Turn-aware DOM scrolling and geometry, without history-loading or follow policy. */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { ChatScrollPosition } from '../contract/slots.ts'
import type { ChatSnapshot } from '../contract/snapshot.ts'
import { scrollMetrics, ScrollFollow, type ViewportMetrics } from './use-scroll-follow.ts'
export type { ViewportMetrics } from './use-scroll-follow.ts'

/** Scroll geometry attributed against the last acknowledged position. */
export interface ViewportScroll {
  readonly metrics: ViewportMetrics
  readonly movedByReader: boolean
}

/** Actual clamped scroll result, including any known semantic anchor and turn. */
export interface ViewportLanding {
  readonly metrics: ViewportMetrics
  readonly position: ChatScrollPosition | null
  readonly turn: number | null
}

interface ViewportEvents {
  scroll: (event: ViewportScroll) => void
  scrollEnd: () => void
  resize: () => void
  interact: () => void
}

interface ViewportElements {
  readonly list: HTMLElement
  readonly column: HTMLElement
  readonly scroller: HTMLElement
  readonly composer: HTMLElement | null
}

interface PagingPosition {
  readonly row: HTMLElement
  readonly position: ChatScrollPosition
  readonly group: { readonly body: HTMLElement; readonly content: HTMLElement; readonly top: number } | null
}

const READING_INTENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown', 'beforematch'] as const
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])

/** Owns one Chat scrollport's DOM operations, event listeners, and size observer. */
export class ChatViewport {
  private elements: ViewportElements | null = null
  private observer: ResizeObserver | null = null
  private events: ViewportEvents | null = null
  private turns: ReturnType<ChatSnapshot['navigation']['items']> = []
  private observation: { top: number; landing: ViewportLanding | null } = { top: 0, landing: null }
  private paging: PagingPosition | null = null

  /**
   * Bind to the containing scrollport and observe content and viewport sizes.
   * @param list - Chat root inside an optional shared conversation scrollport.
   * @param column - ordered outer Node/Group boxes; its size changes invalidate cached landings.
   */
  attach(list: HTMLElement, column: HTMLElement): void {
    this.detach()
    const scroller = list.closest<HTMLElement>('[data-conversation-scroll]') ?? list
    const composer = scroller.querySelector<HTMLElement>('[data-composer-seat]')
    const elements = { list, column, scroller, composer }
    this.elements = elements
    scroller.addEventListener('scroll', this.onScroll, { passive: true })
    scroller.addEventListener('scrollend', this.onScrollEnd, { passive: true, capture: true })
    for (const type of READING_INTENTS) scroller.addEventListener(type, this.onIntent, { passive: true, capture: true })
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => {
        if (this.elements !== elements) return
        this.invalidate()
        this.events?.resize()
      })
      this.observer.observe(column)
      this.observer.observe(scroller)
      if (composer !== null) this.observer.observe(composer)
    }
  }

  /** Disconnect DOM resources and clear observations for the detached view. */
  detach(): void {
    this.stopPreserving()
    this.elements?.scroller.removeEventListener('scroll', this.onScroll)
    this.elements?.scroller.removeEventListener('scrollend', this.onScrollEnd, true)
    for (const type of READING_INTENTS) this.elements?.scroller.removeEventListener(type, this.onIntent, true)
    this.observer?.disconnect()
    this.observer = null
    this.elements = null
    this.events = null
    this.turns = []
    this.observation = { top: 0, landing: null }
  }

  /**
   * Connect business policy without changing DOM listener ownership.
   * @param events - business handlers for scroll and layout changes.
   * @returns a disposer that disconnects only these handlers.
   */
  connect(events: ViewportEvents): () => void {
    this.events = events
    return () => { if (this.events === events) this.events = null }
  }

  /**
   * Adopt the loaded turn anchors without querying the DOM.
   * @param turns - ordered loaded turns from the committed Chat snapshot.
   */
  updateTurns(turns: ReturnType<ChatSnapshot['navigation']['items']>): void {
    this.turns = turns
  }

  /**
   * Resolve the tail from the committed turn index.
   * @returns the latest loaded turn, or null for an empty window.
   */
  get latestTurn(): number | null {
    return this.turns.at(-1)?.turn ?? null
  }

  /** Discard geometry-dependent landing knowledge while retaining scroll attribution. */
  invalidate(): void {
    this.observation.landing = null
  }

  /**
   * Accept a sampled reader position without retaining a known landing.
   * @param metrics - settled reader position used as the next attribution baseline.
   */
  acknowledge(metrics: ViewportMetrics): void {
    this.observation = { top: metrics.top, landing: null }
  }

  /**
   * Compare the current scroll geometry with the last acknowledged position.
   * @returns current metrics and movement attribution, or null while detached.
   */
  readScroll(): ViewportScroll | null {
    const metrics = this.metrics()
    if (metrics === null) return null
    return {
      metrics,
      movedByReader: Math.abs(metrics.top - Math.min(this.observation.top, metrics.floor)) > 0.5,
    }
  }

  private metrics(): ViewportMetrics | null {
    const scroller = this.elements?.scroller
    if (scroller === undefined) return null
    return scrollMetrics(scroller)
  }

  private anchor(key: string, identity: 'position' | 'node' = 'position'): HTMLElement | null {
    if (this.elements === null) return null
    // Reading anchors name exact parts; Turn navigation names the original Node.
    let nodePart: HTMLElement | null = null
    for (const row of this.elements.list.querySelectorAll<HTMLElement>('[data-chat-anchor-key]:not([hidden]):not([hidden] *)')) {
      if (row.dataset.chatAnchorKey === key || (identity === 'node' && row.dataset.chatNodeKey === key)) return row
      if (nodePart === null && row.dataset.chatNodeKey === key) nodePart = row
    }
    return nodePart
  }

  /**
   * Capture visible transcript content, excluding Turn controls that relocate when history expands.
   * @returns a visible semantic anchor, or null when no anchor can be resolved.
   */
  capturePosition(): ChatScrollPosition | null {
    const elements = this.elements
    if (elements === null) return null
    const { list, scroller, composer } = elements
    const viewport = scroller.getBoundingClientRect()
    const bottom = composer?.getBoundingClientRect().top ?? viewport.bottom
    let anchor: HTMLElement | null = null
    if (typeof document.elementsFromPoint === 'function' && bottom > viewport.top) {
      const content = list.getBoundingClientRect()
      const left = Math.max(viewport.left, content.left)
      const right = Math.min(viewport.right, content.right)
      for (const element of document.elementsFromPoint(left + Math.max(0, right - left) / 2, viewport.top + 1)) {
        const row = element instanceof HTMLElement ? element.closest<HTMLElement>('[data-chat-anchor-key]') : null
        if (row !== null && row.dataset.chatFlowKind !== 'turn-process' && list.contains(row)) {
          // An open group's header stays put while older members enter above its body content.
          anchor = row.dataset.chatGroupKey === undefined ? row
            : row.querySelector<HTMLElement>('[data-step-process-content] > [data-chat-anchor-key]:not(:empty):not([hidden]):not([hidden] *)') ?? row
          break
        }
      }
    }
    if (anchor === null) {
      const rows = list.querySelectorAll<HTMLElement>(
        '[data-chat-flow-key]:not([data-chat-group-key]):not([data-chat-flow-kind="turn-process"])'
        + ':not(:empty):not([hidden]):not([hidden] *)',
      )
      let low = 0
      let high = rows.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (rows.item(middle).getBoundingClientRect().bottom > viewport.top) high = middle
        else low = middle + 1
      }
      const row = rows[low]
      anchor = row !== undefined && row.getBoundingClientRect().top < bottom ? row : rows[0] ?? null
    }
    const key = anchor?.dataset.chatAnchorKey
    return anchor === null || key === undefined ? null : {
      anchorKey: key,
      anchorTop: anchor.getBoundingClientRect().top - viewport.top,
      scrollTop: scroller.scrollTop,
    }
  }

  /**
   * Approximate the active Turn by binary-searching outer Node/Group boxes.
   * Gaps retain the last visited Turn candidate, not necessarily the immediate predecessor.
   * A known landing bypasses measurement while its position is unchanged.
   * @param metrics - reusable scroll metrics; omitted callers request a fresh read.
   * @returns the Turn near the reading line, or null while detached or empty.
   */
  readVisibleTurn(metrics = this.metrics()): number | null {
    const knownTurn = this.observation.landing?.turn
    if (knownTurn != null && metrics?.top === this.observation.top) return knownTurn
    const elements = this.elements
    const first = this.turns[0]
    if (elements === null || metrics === null || first === undefined) return null
    const line = elements.scroller.getBoundingClientRect().top + Math.min(96, metrics.height * 0.2)
    const rows = elements.column.children
    let low = 0
    let high = rows.length
    let reading = first.turn
    while (low < high) {
      const middle = (low + high) >>> 1
      const row = rows[middle] as Element
      if (row.getBoundingClientRect().top > line) high = middle
      else {
        const value = row.getAttribute('data-chat-turn')
        const turn = value === null ? NaN : Number(value)
        if (Number.isSafeInteger(turn)) reading = turn
        low = middle + 1
      }
    }
    return reading
  }

  /**
   * Align a known loaded turn and return its actual clamped position.
   * A split Node anchor selects its first visible part.
   * @param turn - loaded turn to align below the scrollport's top edge.
   * @returns the actual landing, or null when its anchor is unavailable.
   */
  scrollToTurn(turn: number): ViewportLanding | null {
    const item = this.turns.find(candidate => candidate.turn === turn)
    if (item === undefined) return null
    const row = this.anchor(item.anchorKey, 'node')
    return row === null ? null : this.align(row, 24, turn)
  }

  /**
   * Align the nearest available fallback for an unavailable turn anchor.
   * @param turn - minimum turn number for a mounted fallback row.
   * @returns the fallback landing, or null when no eligible row exists.
   */
  scrollToTurnAtOrAfter(turn: number): ViewportLanding | null {
    if (this.elements === null) return null
    for (const row of this.elements.list.querySelectorAll<HTMLElement>('[data-chat-turn]:not([hidden]):not([hidden] *)')) {
      const candidate = Number(row.dataset.chatTurn)
      if (Number.isSafeInteger(candidate) && candidate >= turn) return this.align(row, 24, candidate)
    }
    return null
  }

  /**
   * Restore a semantic anchor with a raw-position fallback.
   * @param position - semantic scroll memory; raw top is used only if its row is absent.
   * @returns the actual landing, or null while detached.
   */
  restore(position: ChatScrollPosition): ViewportLanding | null {
    const row = this.anchor(position.anchorKey)
    if (row !== null) return this.align(row, position.anchorTop, null)
    const metrics = this.metrics()
    return metrics === null ? null : this.write(position.scrollTop, metrics, null)
  }

  /** Retain the first eligible transcript seat in DOM order; selection reads no geometry. */
  beginPaging(): void {
    this.stopPreserving()
    const row = this.elements?.list.querySelector<HTMLElement>(
      '[data-chat-paging-anchor]:not(:empty):not([hidden]):not([hidden] *)',
    )
    if (row != null) this.retain(row)
  }

  /**
   * Retain one old row and its inner/outer offsets for paging and later content growth.
   * @param position - an explicit landing to retain; omitted callers capture the current reading position.
   */
  beginPreserving(position: ChatScrollPosition | null = this.capturePosition()): void {
    this.stopPreserving()
    if (position === null) return
    const row = this.anchor(position.anchorKey)
    if (row === null) return
    this.retain(row, position)
  }

  private retain(row: HTMLElement, position?: ChatScrollPosition, groupTop?: number): PagingPosition | null {
    const elements = this.elements
    const key = row.dataset.chatAnchorKey
    if (elements === null || key === undefined) return null
    const previous = this.paging?.group
    if (previous != null) this.observer?.unobserve(previous.content)
    const top = row.getBoundingClientRect().top
    const body = row.closest<HTMLElement>('[data-step-process-body]')
    const content = body?.querySelector<HTMLElement>('[data-step-process-content]')
    const group = body === null || content == null ? null
      : { body, content, top: groupTop ?? top - body.getBoundingClientRect().top }
    this.paging = {
      row, group,
      position: position ?? {
        anchorKey: key,
        anchorTop: top - elements.scroller.getBoundingClientRect().top,
        scrollTop: elements.scroller.scrollTop,
      },
    }
    if (group !== null) this.observer?.observe(group.content)
    return this.paging
  }

  /** Release paging ownership and its content-size observation. */
  stopPreserving(): void {
    const group = this.paging?.group
    if (group != null) this.observer?.unobserve(group.content)
    this.paging = null
  }

  /**
   * Expose retained paging ownership to navigation and resize policy.
   * @returns whether a paging row is retained for subsequent layout changes.
   */
  get preserving(): boolean { return this.paging !== null }

  /**
   * Compensate inner scrolling first, then the outer scrollport, within their actual scroll ranges.
   * An inner write pauses its bound follow controller so the reading anchor takes priority.
   * @returns the actual landing, or null when no visible retained row remains.
   */
  preserve(): ViewportLanding | null {
    let paging = this.paging
    const elements = this.elements
    if (paging === null || elements === null) return null
    if (!elements.list.contains(paging.row)) {
      // Segmentation can remount the same semantic row under another group.
      const replacement = this.anchor(paging.position.anchorKey)
      if (replacement === null) {
        this.stopPreserving()
        return null
      }
      paging = this.retain(replacement, paging.position, paging.group?.top)
      if (paging === null) return null
    }
    const { row, group, position } = paging
    if (row.closest('[hidden]') !== null || row.matches(':empty')) {
      this.stopPreserving()
      return null
    }
    if (group !== null && group.body.contains(row)) {
      const top = row.getBoundingClientRect().top - group.body.getBoundingClientRect().top
      const metrics = scrollMetrics(group.body)
      const target = Math.max(0, Math.min(metrics.floor, metrics.top + top - group.top))
      if (metrics.top !== target) {
        const follow = ScrollFollow.forElement(group.body)
        if (follow === undefined) group.body.scrollTop = target
        else {
          follow.jump(group.body, metrics, target)
          follow.setFollowing(false)
        }
      }
    }
    const metrics = this.metrics()
    if (metrics === null) return null
    const top = row.getBoundingClientRect().top - elements.scroller.getBoundingClientRect().top
    const target = metrics.top + top - position.anchorTop
    return this.write(target, metrics, null, { key: position.anchorKey, top })
  }

  /**
   * Align the scrollport with its current floor.
   * @param follow - independent follow intent and scrolling controller.
   * @returns the actual floor landing, or null while detached.
   */
  scrollToBottom(follow: ScrollFollow): ViewportLanding | null {
    const metrics = this.metrics()
    if (metrics === null || this.elements === null) return null
    const landing: ViewportLanding = {
      metrics: follow.toBottom(this.elements.scroller, metrics, 'instant'),
      position: null,
      turn: this.latestTurn,
    }
    this.observation = { top: landing.metrics.top, landing }
    return landing
  }

  private align(row: HTMLElement, offset: number, turn: number | null): ViewportLanding | null {
    const metrics = this.metrics()
    if (metrics === null || this.elements === null) return null
    const top = row.getBoundingClientRect().top - this.elements.scroller.getBoundingClientRect().top
    return this.write(metrics.top + top - offset, metrics, turn, { key: row.dataset.chatAnchorKey, top })
  }

  private write(
    target: number, metrics: ViewportMetrics, turn: number | null,
    anchor?: { key: string | undefined; top: number },
  ): ViewportLanding | null {
    if (this.elements === null) return null
    const top = Math.max(0, Math.min(metrics.floor, target))
    if (top !== metrics.top) this.elements.scroller.scrollTop = top
    const actual = this.elements.scroller.scrollTop
    const landing: ViewportLanding = {
      metrics: { ...metrics, top: actual },
      turn,
      position: anchor?.key === undefined ? null : {
        anchorKey: anchor.key,
        anchorTop: anchor.top - (actual - metrics.top),
        scrollTop: actual,
      },
    }
    this.observation = { top: actual, landing }
    return landing
  }

  private readonly onScroll = (event: Event): void => {
    if (this.elements === null || event.target !== this.elements.scroller) return
    if (this.observation.landing !== null && this.elements.scroller.scrollTop === this.observation.top) return
    this.invalidate()
    if (this.paging !== null) {
      this.events?.resize()
      return
    }
    const scroll = this.readScroll()
    if (scroll !== null) this.events?.scroll(scroll)
  }

  private readonly onScrollEnd = (event: Event): void => {
    if (event.target === this.elements?.scroller
      || (event.target instanceof HTMLElement && event.target.hasAttribute('data-step-process-body'))) this.events?.scrollEnd()
  }

  private readonly onIntent = (event: Event): void => {
    if (event.type === 'keydown' || event.type === 'pointerdown') {
      if (event.target instanceof Element && event.target.closest('[data-composer-seat]') !== null) return
      if (event.type === 'keydown' && (!(event instanceof KeyboardEvent) || !SCROLL_KEYS.has(event.key))) return
    }
    if (this.paging === null) return
    this.stopPreserving()
    this.events?.interact()
  }
}

/**
 * Bind viewport resource ownership to the component's layout lifetime.
 * @returns one viewport owner and the element refs attached for this mount.
 */
export function useChatViewport(): {
  viewport: ChatViewport
  listRef: RefObject<HTMLDivElement>
  columnRef: RefObject<HTMLDivElement>
} {
  const listRef = useRef<HTMLDivElement | null>(null)
  const columnRef = useRef<HTMLDivElement | null>(null)
  const [viewport] = useState(() => new ChatViewport())
  useLayoutEffect(() => {
    if (listRef.current === null || columnRef.current === null) return
    viewport.attach(listRef.current, columnRef.current)
    return () => { viewport.detach() }
  }, [viewport])
  return { viewport, listRef, columnRef }
}
