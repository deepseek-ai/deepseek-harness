/** Turn-aware DOM scrolling and geometry, without history-loading or follow policy. */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { ChatScrollPosition } from '../contract/slots.ts'
import type { ChatSnapshot } from '../contract/snapshot.ts'
import { createFlowMotion, type InputFoldBox, type InputFoldDriver } from './flow-motion.ts'
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
  scrollEnd: (outer: boolean) => void
  resize: () => void
  interact: () => void
  /** Any reading gesture, before paging ownership is consulted. */
  intent?: () => void
}

interface ViewportElements {
  readonly list: HTMLElement
  readonly column: HTMLElement
  readonly scroller: HTMLElement
  readonly composer: HTMLElement | null
  /** Room below closing rows, retained until scrolling or content growth makes it unnecessary. */
  readonly spacer: HTMLElement | null
}

/** Reading policy that fold batches consult and report tail landings to. */
export interface FoldReader {
  /** Follow intent at batch start selects the tail landing; tail landings commit it. */
  readonly follow: ScrollFollow
  /** @param landing - the actual geometry after a batch landed at the tail. */
  readonly landedAtTail: (landing: ViewportLanding) => void
  /** @returns whether reader movement awaits sampling; until then follow intent is undecided. */
  readonly pending: () => boolean
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
  private reader: FoldReader | null = null
  /** The pending or running fold batch lands at the tail. */
  private tailRequested = false
  /** Switches the running batch to a tail landing; null while no batch runs. */
  private retarget: (() => void) | null = null
  /** Transition state and row callbacks owned by this viewport's attachment. */
  readonly motion = createFlowMotion(
    () => this.foldDriver(),
    (active) => {
      if (this.elements !== null) this.elements.scroller.style.overflowAnchor = active ? 'none' : ''
    },
  )

  /**
   * Bind to the containing scrollport and observe content and viewport sizes.
   * @param list - Chat root inside an optional shared conversation scrollport.
   * @param column - ordered outer Node/Group boxes; its size changes invalidate cached landings.
   */
  attach(list: HTMLElement, column: HTMLElement): void {
    this.detach()
    const scroller = list.closest<HTMLElement>('[data-conversation-scroll]') ?? list
    const composer = scroller.querySelector<HTMLElement>('[data-composer-seat]')
    const spacer = list.querySelector<HTMLElement>('[data-chat-turn-spacer]')
    const elements = { list, column, scroller, composer, spacer }
    this.elements = elements
    if (spacer !== null) spacer.style.height = ''
    scroller.addEventListener('scroll', this.onScroll, { passive: true })
    scroller.addEventListener('scrollend', this.onScrollEnd, { passive: true, capture: true })
    for (const type of READING_INTENTS) scroller.addEventListener(type, this.onIntent, { passive: true, capture: true })
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => {
        if (this.elements !== elements) return
        this.reclaimBelow()
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
    this.motion.clear()
    if (this.elements !== null) this.elements.scroller.style.overflowAnchor = ''
    this.elements?.scroller.removeEventListener('scroll', this.onScroll)
    this.elements?.scroller.removeEventListener('scrollend', this.onScrollEnd, true)
    for (const type of READING_INTENTS) this.elements?.scroller.removeEventListener(type, this.onIntent, true)
    this.observer?.disconnect()
    this.observer = null
    this.elements = null
    this.events = null
    this.tailRequested = false
    this.retarget = null
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

  private spacerHeight(): number {
    const spacer = this.elements?.spacer
    return spacer == null ? 0 : Number.parseFloat(spacer.style.height) || 0
  }

  private setSpacer(height: number): void {
    const spacer = this.elements?.spacer
    if (spacer == null) return
    const next = height <= 0 ? '' : `${Math.ceil(height)}px`
    if (spacer.style.height !== next) spacer.style.height = next
  }

  /**
   * Connect the reading policy that fold batches consult.
   * @param reader - follow intent and the tail-landing commit.
   * @returns a disposer that disconnects only this reader.
   */
  bindReader(reader: FoldReader): () => void {
    this.reader = reader
    return () => { if (this.reader === reader) this.reader = null }
  }

  /**
   * Land the pending or running fold batch at the tail instead of starting a separate scroll.
   * @param follow - follow controller whose native animation yields to the batch.
   * @returns whether a fold owns the tail movement.
   */
  followInputFold(follow: ScrollFollow): boolean {
    // Rows still closing on CSS transitions after a batch have no batch to consume the request.
    if (this.elements === null || this.reader === null || !this.motion.inputActive()) return false
    this.interruptFollow(follow)
    this.tailRequested = true
    this.retarget?.()
    return true
  }

  /**
   * Drive one fold batch on its frame clock. A tail landing ends at the floor, never above the reader's
   * compensated position; a reader landing keeps the visible content still. Both install only the room
   * the landing lacks.
   * @returns the batch driver, or null while detached or without a reading policy.
   */
  private foldDriver(): InputFoldDriver | null {
    const elements = this.elements
    const reader = this.reader
    if (elements === null || reader === null) return null
    const { follow } = reader
    let tail = false
    let start = 0
    let base = 0
    let target = 0
    let removed = 0
    let growth = 0
    let initialHeight = 0
    let finalRoom = 0
    let previousColumnHeight = 0
    let previousProgress = 0
    let segmentProgress = 0
    let segmentTop = 0
    let written = 0
    const closing: InputFoldBox[] = []
    const travelling = new Set<HTMLElement>()
    // A visible row outside the batch measures spacing that snaps when the batch starts and ends.
    let reference: HTMLElement | null = null
    let referenceTop = 0
    let viewportTop = 0
    const screenTop = (element: HTMLElement): number => element.getBoundingClientRect().top - viewportTop
    const aim = (): void => {
      const finalHeight = initialHeight - removed + growth
      const height = elements.scroller.clientHeight
      target = tail ? Math.max(base, finalHeight - height, 0) : base
      finalRoom = target === 0 ? 0 : Math.max(0, target + height - finalHeight)
    }
    const restart = (): void => {
      segmentTop = elements.scroller.scrollTop
      segmentProgress = previousProgress
    }
    const automatic = (cancelled: boolean): boolean => !(cancelled && tail)
    const position = (progress: number, cancelled: boolean): number => {
      if (!automatic(cancelled)) return elements.scroller.scrollTop
      const remaining = segmentProgress === 1 ? 1 : (progress - segmentProgress) / (1 - segmentProgress)
      return segmentTop + (target - segmentTop) * remaining
    }
    const room = (top: number, progress: number, cancelled: boolean): number => Math.max(
      automatic(cancelled) ? finalRoom : 0,
      top + elements.scroller.clientHeight - (initialHeight + (growth - removed) * progress),
    )
    return {
      begin: (boxes) => {
        // Own input lands at the tail; otherwise an unsampled reading movement outranks follow intent.
        tail = this.tailRequested || (follow.active && !reader.pending())
        this.tailRequested = false
        viewportTop = elements.scroller.getBoundingClientRect().top
        start = elements.scroller.scrollTop
        const originalRoom = this.spacerHeight()
        initialHeight = Math.max(elements.column.offsetHeight, elements.scroller.scrollHeight - originalRoom)
        let above = 0
        const below: HTMLElement[] = []
        for (const box of boxes) {
          const amount = box.height + box.marginTop
          const top = box.element.getBoundingClientRect().top - box.marginTop
          if (box.closing) {
            removed += amount
            above += Math.max(0, Math.min(amount, viewportTop - top))
            if (top >= viewportTop) below.push(box.element)
            closing.push(box)
          } else {
            growth += amount
            if (top < viewportTop) above -= amount
          }
        }
        if (!tail) reference = this.readingReference()
        const referenceBefore = reference === null ? 0 : screenTop(reference)
        elements.column.dataset.inputFold = ''
        if (reference !== null) {
          referenceTop = screenTop(reference)
          above -= referenceTop - referenceBefore
        }
        base = Math.max(0, start - above)
        segmentTop = start
        written = start
        previousColumnHeight = elements.column.offsetHeight
        aim()
        // This reserve only prevents an intermediate clamp; the final frame installs the exact deficit.
        this.setSpacer(Math.max(originalRoom, finalRoom, removed))
        if (tail) follow.setFollowing(true)
        // A newer tail request also takes over a batch whose target a reading gesture cancelled.
        this.retarget = () => {
          tail = true
          follow.setFollowing(true)
          this.motion.resumeInput()
          aim()
          restart()
          if (target <= segmentTop) return
          for (const box of closing) {
            // A box fading in place carries a visual translate; its layout position excludes it.
            const shift = Number.parseFloat(box.element.style.translate.split(' ')[1] ?? '') || 0
            if (box.element.getBoundingClientRect().top - shift - box.marginTop >= viewportTop) travelling.add(box.element)
          }
        }
        // Scrolling forward past closing rows shows them shrinking; faded rows would leave their space empty.
        if (tail && target > start) for (const element of below) travelling.add(element)
        return travelling
      },
      prepare: (progress, cancelled) => {
        if (this.elements !== elements) return
        if (!tail) {
          // Reader scrolling between frames moves the reading position the batch keeps still.
          const drift = elements.scroller.scrollTop - written
          if (Math.abs(drift) > 0.5) {
            base = Math.max(0, base + drift)
            segmentTop += drift
            // The reference moves on screen with the reader's scroll; only layout changes are corrected.
            referenceTop -= drift
            aim()
          }
        }
        const added = elements.column.offsetHeight - previousColumnHeight
        if (added !== 0) {
          initialHeight += added
          aim()
          restart()
        }
        const top = position(progress, cancelled)
        // Growing the room before shrinking boxes avoids a native clamp between writes.
        this.setSpacer(Math.max(this.spacerHeight(), room(top, progress, cancelled)))
      },
      frame: (progress, cancelled) => {
        if (this.elements !== elements) return 0
        const top = position(progress, cancelled)
        elements.scroller.scrollTop = top
        this.setSpacer(room(top, progress, cancelled))
        written = elements.scroller.scrollTop
        // Earlier frames keep the reference still; only its final position is compared at finish.
        if (reference !== null && progress === 1) referenceTop = screenTop(reference)
        if (automatic(cancelled)) this.observation = { top: written, landing: null }
        previousColumnHeight = elements.column.offsetHeight
        previousProgress = progress
        return written - start
      },
      finish: (cancelled) => {
        this.retarget = null
        this.tailRequested = false
        if (this.elements !== elements) return
        // Commit the final sibling margins while their fold transition override still applies.
        void elements.column.offsetHeight
        delete elements.column.dataset.inputFold
        if (!tail || cancelled) {
          if (!tail && reference?.isConnected === true && reference.closest('[hidden]') === null) {
            // Committing the hidden rows settles their neighbours' spacing; keep the reference still.
            const shift = screenTop(reference) - referenceTop
            if (Math.abs(shift) > 0.5) {
              const top = elements.scroller.scrollTop + shift
              const content = elements.scroller.scrollHeight - this.spacerHeight()
              this.setSpacer(Math.max(this.spacerHeight(), top + elements.scroller.clientHeight - content))
              elements.scroller.scrollTop = top
            }
          }
          const metrics = scrollMetrics(elements.scroller)
          const height = elements.scroller.scrollHeight - this.spacerHeight()
          this.setSpacer(metrics.top === 0 ? 0 : Math.max(0, metrics.top + metrics.height - height))
          if (tail) this.invalidate()
          else this.observation = { top: elements.scroller.scrollTop, landing: null }
          return
        }
        // The estimate can differ from the committed layout, for example settled sibling spacing.
        // Land on the actual content: never above the target, and at the real floor when content reaches past it.
        const content = elements.scroller.scrollHeight - this.spacerHeight()
        const clientHeight = elements.scroller.clientHeight
        const top = Math.max(target, content - clientHeight, 0)
        this.setSpacer(top === 0 ? 0 : Math.max(0, top + clientHeight - content))
        elements.scroller.scrollTop = top
        const metrics = scrollMetrics(elements.scroller)
        const landing = { metrics, position: null, turn: this.latestTurn }
        this.observation = { top: metrics.top, landing }
        reader.landedAtTail(landing)
      },
    }
  }

  /**
   * Find the first visible top-level row at or below the scrollport top that holds no batch box.
   * Binary search over the ordered top-level rows reads O(log n) boxes.
   * @returns the reference row, or null when every visible row folds.
   */
  private readingReference(): HTMLElement | null {
    const elements = this.elements
    if (elements === null) return null
    const viewport = elements.scroller.getBoundingClientRect()
    // Slot anchors use display:contents: their children are the top-level rows.
    const rows = (elements.column.querySelector(':scope > [data-slot="conversation.chat.flow"]') ?? elements.column).children
    let low = 0
    let high = rows.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if ((rows[middle] as Element).getBoundingClientRect().bottom > viewport.top) high = middle
      else low = middle + 1
    }
    for (let index = low; index < rows.length; index++) {
      const row = rows[index] as HTMLElement
      if (row.hasAttribute('hidden')) continue
      const rect = row.getBoundingClientRect()
      if (rect.top >= viewport.bottom) return null
      if (rect.height === 0 || rect.bottom <= viewport.top) continue
      if (row.hasAttribute('data-chat-motion') || row.querySelector('[data-chat-motion]') !== null) continue
      return row
    }
    return null
  }

  /** Clear fold reservations after a display-mode change, allowing the scroll range to shrink. */
  resetBelow(): void {
    this.setSpacer(0)
    this.invalidate()
  }

  /**
   * Give reserved room back after acknowledged scrolling or content growth without clamping the reader.
   * Holds still during folds and unsampled movement; following includes the room that remains.
   */
  reclaimBelow(): void {
    const elements = this.elements
    if (elements === null || elements.spacer === null) return
    const current = this.spacerHeight()
    if (current === 0 || this.motion.foldActive()) return
    const scroll = this.readScroll()
    // Trimming the range before sampling could misclassify a reader's move as a layout clamp.
    if (scroll === null || scroll.movedByReader) return
    const floorWithoutSpacer = scroll.metrics.floor - current
    this.setSpacer(Math.min(current, Math.max(0, scroll.metrics.top - floorWithoutSpacer)))
  }

  /**
   * Stop an outstanding native follow animation at its current position before a reading gesture.
   * @param follow - follow controller bound to this scrollport.
   */
  interruptFollow(follow: ScrollFollow): void {
    if (!follow.animating) return
    const metrics = this.metrics()
    if (metrics === null || this.elements === null) return
    follow.interrupt(this.elements.scroller, metrics)
    this.observation = { top: metrics.top, landing: null }
  }

  /**
   * Accept a sampled reader position without retaining a known landing.
   * @param metrics - settled reader position used as the next attribution baseline.
   */
  acknowledge(metrics: ViewportMetrics): void {
    this.observation = { top: metrics.top, landing: null }
    this.reclaimBelow()
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
    // Slot anchors use display:contents: measure their rows, not the anchor's empty box.
    const rows = (elements.column.querySelector(':scope > [data-slot="conversation.chat.flow"]') ?? elements.column).children
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
   * Align with the physical floor, including fold room that newer content has not yet filled.
   * @param follow - independent follow intent and scrolling controller.
   * @param behavior - immediate positioning, or one native animation for a reader-caused tail change.
   * @returns the actual floor landing, or null while detached. A smooth landing reports the starting
   * position; native scroll delivery moves it.
   */
  scrollToBottom(follow: ScrollFollow, behavior: 'instant' | 'smooth' = 'instant'): ViewportLanding | null {
    const metrics = this.metrics()
    if (metrics === null || this.elements === null) return null
    this.observation = { top: metrics.top, landing: null }
    this.reclaimBelow()
    const landing: ViewportLanding = {
      metrics: follow.toBottom(this.elements.scroller, scrollMetrics(this.elements.scroller), behavior),
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
    if (event.target === this.elements?.scroller) {
      this.events?.scrollEnd(true)
      this.reclaimBelow()
    } else if (event.target instanceof HTMLElement && event.target.hasAttribute('data-step-process-body')) this.events?.scrollEnd(false)
  }

  private readonly onIntent = (event: Event): void => {
    if (event.type === 'keydown' || event.type === 'pointerdown') {
      if (event.target instanceof Element && event.target.closest('[data-composer-seat]') !== null) return
      if (event.type === 'keydown' && (!(event instanceof KeyboardEvent) || !SCROLL_KEYS.has(event.key))) return
    }
    this.events?.intent?.()
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
