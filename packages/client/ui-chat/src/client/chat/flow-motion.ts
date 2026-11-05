/**
 * Fold transitions owned by one Chat viewport. Every batch containing a closing row moves its boxes and
 * the scrollport on one frame clock; a batch that only reveals rows, or a viewport without a reading
 * policy, uses CSS transitions. Motion is opt-in under `[data-chat-motion]`, respects reduced motion,
 * and clears temporary styles.
 */
import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'
import { useSearchableHidden, type HiddenTransition } from './searchable-hidden.ts'

const FADE_OUT_MS = 70
/** The box starts closing while the fade finishes; by then the row is nearly transparent. */
const CLOSE_DELAY_MS = 50
const CLOSE_MS = 110
const SETTLE_SLACK_MS = 80
const MOTION_SCOPE = '[data-chat-motion]'
const EASING = 'cubic-bezier(0.4, 0, 0.2, 1)'

/** Row-local operations supplied by the containing viewport. */
export interface FlowMotionRows {
  /** @param element - visible row. @param done - commits hidden state before idle callbacks run. */
  collapse(element: HTMLElement, done: () => void): void
  /** @param element - newly visible row to grow to its natural size. */
  reveal(element: HTMLElement): void
  /** @param element - row whose active transition should be cancelled without hiding it. */
  cancelMotion(element: HTMLElement): void
  /**
   * Hide a row at once, outside a motion scope; the owning viewport measures the layout first.
   * @param element - visible row.
   * @param commit - applies the hidden state.
   */
  hideNow?(element: HTMLElement, commit: () => void): void
}

/** Geometry captured before one fold batch changes its boxes. */
export interface InputFoldBox {
  readonly element: HTMLElement
  readonly height: number
  readonly marginTop: number
  readonly closing: boolean
}

/** The viewport moves on the same progress that changes the folded boxes. */
export interface InputFoldDriver {
  /**
   * Capture geometry and choose the landing before the frame clock changes the boxes.
   * @param boxes - non-nested boxes whose layout changes on this clock.
   * @returns closing boxes that scroll with the content and stay opaque; the rest fade in place. The driver
   * may add boxes while the batch runs, when a newer tail request takes it over.
   */
  begin(boxes: readonly InputFoldBox[]): ReadonlySet<HTMLElement>
  /**
   * Reserve scroll range before box writes.
   * @param progress - shared eased progress from zero to one.
   * @param cancelled - a reading gesture stopped a tail landing's automatic target; a landing that keeps
   * the reader's content still continues and includes the reader's own movement.
   */
  prepare(progress: number, cancelled: boolean): void
  /**
   * Apply viewport geometry after box writes.
   * @param progress - shared eased progress from zero to one.
   * @param cancelled - a reading gesture stopped a tail landing's automatic target.
   * @returns actual scrollTop displacement from the batch start, for closing-content visual compensation.
   */
  frame(progress: number, cancelled: boolean): number
  /**
   * Install the final geometry after the last frame or cancellation.
   * @param cancelled - a reading gesture stopped the automatic target, every closing row reopened, or the
   * viewport detached; the driver commits no obsolete landing.
   */
  finish(cancelled: boolean): void
}

/** Animation lifetime and fold coordination for one viewport. */
export interface FlowMotion extends FlowMotionRows {
  /** @returns whether a row owned by this viewport is closing. */
  foldActive(): boolean
  /** @param listener - callback after the last fold. @returns cancellation for a pending callback. */
  onFoldIdle(listener: () => void): () => void
  /** Stop the running batch's automatic target while letting its boxes finish. */
  cancelInput(): void
  /** Restore the running batch's automatic target after a newer request takes it over. */
  resumeInput(): void
  /** @returns whether a fold batch runs, or one is scheduled for this commit's closing rows. */
  inputActive(): boolean
  /** Cancel owned animations and pending work when the viewport detaches. */
  clear(): void
}

/**
 * Decide whether a row may animate: inside a live scope and not under reduced motion.
 * @param element - row about to be hidden.
 * @returns whether the fade-then-close transition applies.
 */
export function motionEnabled(element: HTMLElement): boolean {
  if (element.closest(MOTION_SCOPE) === null) return false
  return typeof matchMedia !== 'function' || !matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Whether a row is already hidden or on its way there.
 * @param element - row under Turn-level visibility control.
 * @returns hidden attribute present or a collapse transition outstanding.
 */
export function hiddenOrCollapsing(element: HTMLElement): boolean {
  return element.hasAttribute('hidden') || element.dataset.chatMotion === 'collapse'
}

/**
 * Opacity of a revealing box at batch progress, continuing from the share its own transition reached.
 * @param box - revealing box.
 * @param progress - shared eased progress from zero to one.
 * @returns opacity from zero to one.
 */
function revealedShare(box: OwnedBox, progress: number): number {
  const start = box.height === 0 ? 0 : box.fromHeight / box.height
  return start + (1 - start) * progress
}

/** A box this viewport owns until it finishes or is cancelled. */
interface OwnedBox {
  readonly element: HTMLElement
  /**
   * Full size: a closing box shrinks from it, a revealing box grows to it. A batch re-measures a closing
   * box's current size when it takes the box over.
   */
  height: number
  marginTop: number
  /** Size a revealing box had already reached on its own transition when a batch took it over. */
  fromHeight: number
  fromMarginTop: number
  readonly closing: boolean
  /** The box changed while a batch ran; it waits without a CSS transition until the next batch. */
  held: boolean
  /** Start a held revealing box's own transition when no batch will drive it. */
  release(): void
  /** Stop the box's own transition and fallback timer before a batch drives it. */
  take(): void
  finish(): void
}

/**
 * Create animation coordination without cross-viewport broadcasts.
 * @param driver - the viewport's driver for the next batch; null while detached.
 * @param foldingChanged - disable or restore this viewport's native scroll anchoring.
 * @param beforeInstantHide - measures the layout before a row hides at once outside a motion scope.
 * @returns stable callbacks and cleanup for this viewport's animations.
 */
export function createFlowMotion(
  driver: () => InputFoldDriver | null, foldingChanged: (active: boolean) => void,
  beforeInstantHide?: (element: HTMLElement) => void,
): FlowMotion {
  const running = new Map<HTMLElement, () => void>()
  let folding = 0
  const foldIdleListeners = new Set<() => void>()
  let batchScheduled = false
  const boxes = new Map<HTMLElement, OwnedBox>()
  let frameRequest: number | null = null
  let batch = false
  let cancelled = false
  let clearEpoch = 0
  let batchCleanup: (() => void) | null = null
  let cancelEmptyBatch: (() => void) | null = null
  /** The batch is committing hidden rows and its final geometry; idle listeners wait until both land. */
  let settling = false
  let anchoringDisabled = false

  function cancelInput(): void {
    if (batch) cancelled = true
  }

  function resumeInput(): void {
    if (batch) cancelled = false
  }

  /** Rows inside a closing ancestor change with it and never join a batch on their own. */
  function batchMember(box: InputFoldBox): boolean {
    return box.element.parentElement?.closest('[data-chat-motion="collapse"]') === null
  }

  /** @returns whether a batch started; without a closing member the caller settles held rows itself. */
  function runBatch(current: InputFoldDriver): boolean {
    // Every member continues from the size it has now, so the driver's measured layout and its change
    // amounts describe the same boxes: a closing box may have moved on its own transition, and a revealing
    // box may have grown part of the way on its own transition.
    for (const box of [...boxes.values()]) {
      if (!batchMember(box)) continue
      // A row that finished closing is `hidden="until-found"`, which skips its contents without removing
      // their boxes: a box under it still reports its own size but contributes nothing to the flow.
      if (box.element.parentElement?.closest('[hidden]') != null) {
        box.finish()
        continue
      }
      const height = box.element.offsetHeight
      const marginTop = Number.parseFloat(getComputedStyle(box.element).marginTop) || 0
      if (!box.closing) {
        box.fromHeight = Math.min(height, box.height)
        box.fromMarginTop = Math.min(marginTop, box.marginTop)
        continue
      }
      box.height = height
      box.marginTop = marginTop
      if (height === 0 && marginTop === 0) box.finish()
    }
    const owned = [...boxes.values()]
    const members = owned.filter(batchMember)
      .sort((left, right) => left.element.compareDocumentPosition(right.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
    if (!members.some(box => box.closing)) return false
    batch = true
    cancelled = false
    const travelling = current.begin(members.map(box => box.closing ? box : {
      element: box.element,
      height: box.height - box.fromHeight,
      marginTop: box.marginTop - box.fromMarginTop,
      closing: false,
    }))
    batchCleanup = () => { current.finish(true) }
    for (const box of owned) box.take()
    for (const box of members) {
      box.element.style.transition = 'none'
      box.element.style.height = `${box.closing ? box.height : box.fromHeight}px`
      box.element.style.marginTop = `${box.closing ? box.marginTop : box.fromMarginTop}px`
      box.element.style.opacity = box.closing ? '1' : String(revealedShare(box, 0))
    }
    const memberSet = new Set(members)
    const settledTravel = new Set<HTMLElement>()
    // A travelling box clips its content as it shrinks, so nested closing rows keep their size until it ends.
    const freezeTravelling = (): void => {
      for (const element of travelling) {
        if (settledTravel.has(element)) continue
        settledTravel.add(element)
        element.style.translate = ''
        for (const box of owned) {
          if (memberSet.has(box) || !element.contains(box.element)) continue
          box.element.style.transition = 'none'
          box.element.style.height = `${box.height}px`
          box.element.style.marginTop = `${box.marginTop}px`
          box.element.style.opacity = '1'
        }
      }
    }
    freezeTravelling()
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    let started: number | undefined
    let displacement = 0
    const settle = (finishCancelled: boolean): void => {
      batch = false
      batchCleanup = null
      cancelEmptyBatch = null
      settling = true
      try {
        for (const box of owned) if (boxes.get(box.element) === box) box.finish()
        current.finish(finishCancelled)
      } finally {
        settling = false
      }
      if (folding === 0) notifyIdle()
      // Rows that changed while this batch ran wait in place; the next flush drives or releases them.
      if ([...boxes.values()].some(box => box.held)) flushBatch()
    }
    cancelEmptyBatch = () => {
      if (members.some(box => box.closing && boxes.get(box.element) === box)) return
      if (frameRequest !== null) cancelAnimationFrame(frameRequest)
      frameRequest = null
      settle(true)
    }
    const tick = (now: number): void => {
      frameRequest = null
      started ??= now
      const elapsed = reduced ? CLOSE_DELAY_MS + CLOSE_MS : now - started
      const linear = Math.min(1, Math.max(0, (elapsed - CLOSE_DELAY_MS) / CLOSE_MS))
      const progress = linear * linear * (3 - 2 * linear)
      current.prepare(progress, cancelled)
      freezeTravelling()
      for (const box of members) {
        if (boxes.get(box.element) !== box) continue
        if (box.closing) {
          box.element.style.height = `${box.height * (1 - progress)}px`
          box.element.style.marginTop = `${box.marginTop * (1 - progress)}px`
          box.element.style.opacity = travelling.has(box.element) ? '1' : String(Math.max(0, 1 - elapsed / FADE_OUT_MS))
        } else {
          box.element.style.height = `${box.fromHeight + (box.height - box.fromHeight) * progress}px`
          box.element.style.marginTop = `${box.fromMarginTop + (box.marginTop - box.fromMarginTop) * progress}px`
          box.element.style.opacity = String(revealedShare(box, progress))
        }
      }
      displacement = current.frame(progress, cancelled)
      let removedBefore = 0
      for (const box of members) {
        if (boxes.get(box.element) !== box) continue
        if (box.closing) {
          // Transforming the closing box changes its pixels, not its flow contribution.
          if (!travelling.has(box.element)) box.element.style.translate = `0 ${displacement + removedBefore}px`
          removedBefore += (box.height + box.marginTop) * progress
        } else removedBefore -= (box.height - box.fromHeight + box.marginTop - box.fromMarginTop) * progress
      }
      if (linear < 1) {
        frameRequest = requestAnimationFrame(tick)
        return
      }
      settle(cancelled)
    }
    if (reduced) tick(0)
    else frameRequest = requestAnimationFrame(tick)
    return true
  }

  function foldActive(): boolean { return folding > 0 }

  function onFoldIdle(listener: () => void): () => void {
    if (folding === 0) listener()
    else foldIdleListeners.add(listener)
    return () => { foldIdleListeners.delete(listener) }
  }

  function flushBatch(): void {
    batchScheduled = false
    // Rows that change during a batch are held until it settles, which flushes again.
    if (batch) return
    const current = [...boxes.values()].some(box => box.closing) ? driver() : null
    if (current !== null && runBatch(current)) return
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    // Without a batch, a held closing row finishes at once and a held revealing row starts its own transition.
    for (const box of [...boxes.values()]) {
      if (reduced || (box.held && box.closing)) box.finish()
      else if (box.held) box.release()
    }
  }

  function scheduleBatch(): void {
    if (batchScheduled) return
    batchScheduled = true
    // After the whole commit's collapses and reveals have started, before any box changes size.
    const epoch = clearEpoch
    queueMicrotask(() => { if (epoch === clearEpoch) flushBatch() })
  }

  function foldStarted(): void {
    folding += 1
    if (folding !== 1 || anchoringDisabled) return
    anchoringDisabled = true
    foldingChanged(true)
  }

  function foldEnded(): void {
    folding = Math.max(0, folding - 1)
    if (folding === 0 && !settling) notifyIdle()
  }

  function notifyIdle(): void {
    if (anchoringDisabled) {
      anchoringDisabled = false
      foldingChanged(false)
    }
    const listeners = [...foldIdleListeners]
    foldIdleListeners.clear()
    for (const listener of listeners) listener()
  }

  function clearMotion(
    element: HTMLElement,
    onEnd: (event: TransitionEvent) => void,
    timer: ReturnType<typeof setTimeout> | undefined,
  ): void {
    element.removeEventListener('transitionend', onEnd)
    clearTimeout(timer)
    running.delete(element)
    boxes.delete(element)
    const { style } = element
    style.height = ''
    style.marginTop = ''
    style.opacity = ''
    style.overflow = ''
    style.transition = ''
    style.translate = ''
    delete element.dataset.chatMotion
  }

  function cancelMotion(element: HTMLElement): void {
    running.get(element)?.()
    cancelEmptyBatch?.()
  }

  function collapse(element: HTMLElement, done: () => void): void {
    cancelMotion(element)
    const height = element.offsetHeight
    const marginTop = Number.parseFloat(getComputedStyle(element).marginTop) || 0
    if (height === 0 && marginTop === 0) {
      done()
      return
    }
    const { style } = element
    // A running batch owns the scrollport; a row closing now keeps its size until the next batch drives it.
    const held = batch
    element.dataset.chatMotion = 'collapse'
    foldStarted()
    scheduleBatch()
    style.transition = 'none'
    style.overflow = 'hidden'
    style.height = `${height}px`
    style.marginTop = `${marginTop}px`
    if (!held) {
      void element.offsetHeight
      style.transition = `opacity ${FADE_OUT_MS}ms ${EASING}, `
        + `height ${CLOSE_MS}ms ${EASING} ${CLOSE_DELAY_MS}ms, margin-top ${CLOSE_MS}ms ${EASING} ${CLOSE_DELAY_MS}ms`
      style.opacity = '0'
      style.height = '0px'
      style.marginTop = '0px'
    }

    // The hidden state must land before fold-idle listeners measure the flow.
    const finish = (): void => {
      if (running.get(element) !== cancel) return
      clearMotion(element, onEnd, timer)
      done()
      foldEnded()
    }
    const onEnd = (event: TransitionEvent): void => {
      if (event.target === element && event.propertyName === 'height') finish()
    }
    const timer = held ? undefined : setTimeout(finish, CLOSE_DELAY_MS + CLOSE_MS + SETTLE_SLACK_MS)
    const cancel = (): void => {
      clearMotion(element, onEnd, timer)
      foldEnded()
    }
    if (!held) element.addEventListener('transitionend', onEnd)
    running.set(element, cancel)
    boxes.set(element, { element, height, marginTop, fromHeight: height, fromMarginTop: marginTop, closing: true, held, finish,
      release: () => {},
      take: () => { element.removeEventListener('transitionend', onEnd); clearTimeout(timer) } })
  }

  function reveal(element: HTMLElement): void {
    cancelMotion(element)
    const height = element.offsetHeight
    if (height === 0) return
    const marginTop = Number.parseFloat(getComputedStyle(element).marginTop) || 0
    scheduleBatch()
    const { style } = element
    element.dataset.chatMotion = 'reveal'
    style.transition = 'none'
    style.overflow = 'hidden'
    style.opacity = '0'
    style.height = '0px'
    style.marginTop = '0px'
    const finish = (): void => {
      if (running.get(element) !== finish) return
      clearMotion(element, onEnd, timer)
    }
    const onEnd = (event: TransitionEvent): void => {
      if (event.target === element && event.propertyName === 'height') finish()
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const startTransition = (): void => {
      void element.offsetHeight
      style.transition = `height ${CLOSE_MS}ms ${EASING} ${CLOSE_DELAY_MS}ms, margin-top ${CLOSE_MS}ms ${EASING} ${CLOSE_DELAY_MS}ms, `
        + `opacity ${CLOSE_MS}ms ${EASING} ${CLOSE_DELAY_MS}ms`
      style.height = `${height}px`
      style.marginTop = `${marginTop}px`
      style.opacity = '1'
      timer = setTimeout(finish, CLOSE_DELAY_MS + CLOSE_MS + SETTLE_SLACK_MS)
      element.addEventListener('transitionend', onEnd)
    }
    // A running batch owns the scrollport; a row revealed now waits at zero size until the next flush.
    const held = batch
    if (!held) startTransition()
    running.set(element, finish)
    const box: OwnedBox = { element, height, marginTop, fromHeight: 0, fromMarginTop: 0, closing: false, held, finish,
      release: () => {
        box.held = false
        startTransition()
      },
      take: () => { element.removeEventListener('transitionend', onEnd); clearTimeout(timer) } }
    boxes.set(element, box)
  }

  function clear(): void {
    clearEpoch++
    batchScheduled = false
    batch = false
    cancelled = false
    if (frameRequest !== null) cancelAnimationFrame(frameRequest)
    frameRequest = null
    batchCleanup?.()
    batchCleanup = null
    cancelEmptyBatch = null
    foldIdleListeners.clear()
    for (const cancel of [...running.values()]) cancel()
  }

  function hideNow(element: HTMLElement, commit: () => void): void {
    beforeInstantHide?.(element)
    commit()
  }

  return {
    collapse, reveal, cancelMotion, foldActive, onFoldIdle, cancelInput, resumeInput, clear, hideNow,
    inputActive: () => batch || (batchScheduled && [...boxes.values()].some(box => box.closing && batchMember(box))),
  }
}

function useFlowTransition(motion: FlowMotionRows | undefined, grow: boolean): HiddenTransition | undefined {
  const current = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => () => {
    if (current.current !== null) motion?.cancelMotion(current.current)
    current.current = null
  }, [motion])
  const transition = useCallback<HiddenTransition>((element, hidden, commit) => {
    const mounted = current.current === element
    const animate = mounted && motionEnabled(element)
    current.current = element
    if (hidden) {
      if (hiddenOrCollapsing(element)) return
      if (mounted && element.closest(MOTION_SCOPE) !== null && motion !== undefined) motion.collapse(element, commit)
      else if (mounted && motion?.hideNow !== undefined) motion.hideNow(element, commit)
      else commit()
      return
    }
    motion?.cancelMotion(element)
    const wasHidden = element.hasAttribute('hidden')
    commit()
    if (wasHidden && animate && grow) motion?.reveal(element)
  }, [motion, grow])
  return motion === undefined ? undefined : transition
}

/**
 * Apply searchable hiding with the containing Chat viewport's optional fold animation.
 * @param hidden - desired visibility.
 * @param reveal - browser-find and focus-protection callback.
 * @param motion - owning viewport's row callbacks; undefined applies visibility synchronously.
 * @returns the stable subtree ref.
 */
export function useFlowHidden(hidden: boolean, reveal: () => void, motion: FlowMotionRows | undefined): RefObject<HTMLDivElement> {
  return useSearchableHidden(hidden, reveal, useFlowTransition(motion, false))
}

/**
 * Toggle a plain hidden attribute on the fold clock, growing newly revealed headers.
 * @param ref - element whose visibility follows hidden.
 * @param hidden - desired hidden state.
 * @param motion - containing viewport's row callbacks.
 */
export function useMotionHidden(ref: RefObject<HTMLElement | null>, hidden: boolean, motion: FlowMotionRows): void {
  const transition = useFlowTransition(motion, true)
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    transition?.(element, hidden, () => {
      if (hidden) element.setAttribute('hidden', '')
      else element.removeAttribute('hidden')
    })
  }, [ref, hidden, transition])
}
