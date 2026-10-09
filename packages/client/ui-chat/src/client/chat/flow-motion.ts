/**
 * Fade-then-close transitions owned by one Chat viewport. Rows fade before their boxes close;
 * the owner reserves removed height and holds scrolling until that viewport's folds finish.
 * Motion is opt-in under `[data-chat-motion]`, respects reduced motion, and clears temporary styles.
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
}

/** Animation lifetime and fold coordination for one viewport. */
export interface FlowMotion extends FlowMotionRows {
  /** @returns whether a row owned by this viewport is closing. */
  foldActive(): boolean
  /** @param listener - callback after the last fold. @returns cancellation for a pending callback. */
  onFoldIdle(listener: () => void): () => void
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
 * Create animation coordination without cross-viewport broadcasts.
 * @param reserve - reserve the deduplicated removed height in this viewport.
 * @param foldingChanged - disable or restore this viewport's native scroll anchoring.
 * @returns stable callbacks and cleanup for this viewport's animations.
 */
export function createFlowMotion(reserve: (px: number) => void, foldingChanged: (active: boolean) => void): FlowMotion {
  const running = new Map<HTMLElement, () => void>()
  let folding = 0
  const foldIdleListeners = new Set<() => void>()
  const pendingReserve = new Set<HTMLElement>()
  let pendingGrowth = 0
  let reserveScheduled = false

  function foldActive(): boolean { return folding > 0 }

  function onFoldIdle(listener: () => void): () => void {
    if (folding === 0) listener()
    else foldIdleListeners.add(listener)
    return () => { foldIdleListeners.delete(listener) }
  }

  function flushReserve(): void {
    reserveScheduled = false
    let total = -pendingGrowth
    pendingGrowth = 0
    for (const element of pendingReserve) {
      // A member inside a closing group is already part of the group's own box.
      if (element.parentElement?.closest('[data-chat-motion="collapse"]') !== null) continue
      total += element.offsetHeight + (Number.parseFloat(getComputedStyle(element).marginTop) || 0)
    }
    pendingReserve.clear()
    if (total > 0) reserve(total)
  }

  function scheduleReserve(): void {
    if (reserveScheduled) return
    reserveScheduled = true
    // After the whole commit's collapses and reveals have started, before any box changes size.
    queueMicrotask(flushReserve)
  }

  function foldStarted(): void {
    folding += 1
    if (folding === 1) foldingChanged(true)
  }

  function foldEnded(): void {
    folding = Math.max(0, folding - 1)
    if (folding > 0) return
    foldingChanged(false)
    const listeners = [...foldIdleListeners]
    foldIdleListeners.clear()
    for (const listener of listeners) listener()
  }

  function clearMotion(element: HTMLElement, onEnd: (event: TransitionEvent) => void, timer: ReturnType<typeof setTimeout>): void {
    element.removeEventListener('transitionend', onEnd)
    clearTimeout(timer)
    running.delete(element)
    const { style } = element
    style.height = ''
    style.marginTop = ''
    style.opacity = ''
    style.overflow = ''
    style.transition = ''
    delete element.dataset.chatMotion
  }

  function cancelMotion(element: HTMLElement): void {
    pendingReserve.delete(element)
    running.get(element)?.()
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
    element.dataset.chatMotion = 'collapse'
    foldStarted()
    pendingReserve.add(element)
    scheduleReserve()
    style.transition = 'none'
    style.overflow = 'hidden'
    style.height = `${height}px`
    style.marginTop = `${marginTop}px`
    void element.offsetHeight
    style.transition = `opacity ${FADE_OUT_MS}ms ${EASING}, `
      + `height ${CLOSE_MS}ms ${EASING} ${CLOSE_DELAY_MS}ms, margin-top ${CLOSE_MS}ms ${EASING} ${CLOSE_DELAY_MS}ms`
    style.opacity = '0'
    style.height = '0px'
    style.marginTop = '0px'

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
    const timer = setTimeout(finish, CLOSE_DELAY_MS + CLOSE_MS + SETTLE_SLACK_MS)
    const cancel = (): void => {
      clearMotion(element, onEnd, timer)
      foldEnded()
    }
    element.addEventListener('transitionend', onEnd)
    running.set(element, cancel)
  }

  function reveal(element: HTMLElement): void {
    cancelMotion(element)
    const height = element.offsetHeight
    if (height === 0) return
    const marginTop = Number.parseFloat(getComputedStyle(element).marginTop) || 0
    pendingGrowth += height + marginTop
    scheduleReserve()
    const { style } = element
    element.dataset.chatMotion = 'reveal'
    style.transition = 'none'
    style.overflow = 'hidden'
    style.opacity = '0'
    style.height = '0px'
    style.marginTop = '0px'
    void element.offsetHeight
    style.transition = `height ${CLOSE_MS}ms ${EASING} ${CLOSE_DELAY_MS}ms, margin-top ${CLOSE_MS}ms ${EASING} ${CLOSE_DELAY_MS}ms, `
      + `opacity ${CLOSE_MS}ms ${EASING} ${CLOSE_DELAY_MS}ms`
    style.height = `${height}px`
    style.marginTop = `${marginTop}px`
    style.opacity = '1'
    const finish = (): void => {
      if (running.get(element) !== finish) return
      clearMotion(element, onEnd, timer)
    }
    const onEnd = (event: TransitionEvent): void => {
      if (event.target === element && event.propertyName === 'height') finish()
    }
    const timer = setTimeout(finish, CLOSE_DELAY_MS + CLOSE_MS + SETTLE_SLACK_MS)
    element.addEventListener('transitionend', onEnd)
    running.set(element, finish)
  }

  function clear(): void {
    foldIdleListeners.clear()
    pendingReserve.clear()
    pendingGrowth = 0
    for (const cancel of [...running.values()]) cancel()
  }

  return { collapse, reveal, cancelMotion, foldActive, onFoldIdle, clear }
}

function useFlowTransition(motion: FlowMotionRows | undefined, grow: boolean): HiddenTransition | undefined {
  const current = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => () => {
    if (current.current !== null) motion?.cancelMotion(current.current)
    current.current = null
  }, [motion])
  const transition = useCallback<HiddenTransition>((element, hidden, commit) => {
    const animate = current.current === element && motionEnabled(element)
    current.current = element
    if (hidden) {
      if (hiddenOrCollapsing(element)) return
      if (animate && motion !== undefined) motion.collapse(element, commit)
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
