/** Follow-tail ownership, saved-position restoration, and sampled reader movement. */
import { useLayoutEffect, useState } from 'react'
import type { ChatScrollPosition, ChatViewSlotProps } from '../contract/slots.ts'
import type { ChatViewport, ViewportLanding, ViewportScroll } from './use-chat-viewport.ts'
import { useScrollFollow, type ScrollFollow } from './use-scroll-follow.ts'

const FOLLOW_THRESHOLD = 24
const SCROLL_SAMPLE_INTERVAL_MS = 500

/** Reading facts that affect Chat chrome and initial rail placement. */
export interface ChatReadingState {
  readonly initialized: boolean
  readonly followingTail: boolean
  readonly activeTurn: number | null
}

/** Settled reader position delivered to history-navigation policy. */
export interface ReadingSample {
  readonly position: ChatScrollPosition | null
  readonly movedByReader: boolean
  readonly followingTail: boolean
}

type PositionStore = ChatViewSlotProps['chatScroll']

/** Owns reading policy and its cancellable sampling work, without DOM access. */
export class ChatReading {
  private sampleTimer: number | null = null
  private probeFrame: number | null = null
  private sampled: ((sample: ReadingSample) => void) | null = null

  constructor(
    private readonly viewport: ChatViewport,
    private store: PositionStore,
    private state: ChatReadingState,
    private readonly onChange: (state: ChatReadingState) => void,
    private readonly follow: ScrollFollow,
  ) {}

  /**
   * Expose pending reader ownership to navigation and resize handlers.
   * @returns whether reader input still awaits interval or scrollend sampling.
   */
  get pending(): boolean { return this.sampleTimer !== null }
  /**
   * Expose the active follow policy.
   * @returns whether content growth retains bottom-follow ownership.
   */
  get followingTail(): boolean { return this.state.followingTail }

  /**
   * Adopt the committed Session's scroll memory.
   * @param store - scroll memory for the current Session.
   */
  setStore(store: PositionStore): void { this.store = store }

  /**
   * Connect history policy to settled reading observations.
   * @param sampled - receives settled reader positions.
   * @returns a disposer that disconnects only this listener.
   */
  connect(sampled: (sample: ReadingSample) => void): () => void {
    this.sampled = sampled
    return () => { if (this.sampled === sampled) this.sampled = null }
  }

  /** Cancel timers and animation frames and detach the sample listener. */
  dispose(): void {
    this.cancelPending()
    this.sampled = null
  }

  /** Release bottom follow and pending sampling for an explicit navigation. */
  pauseFollowing(): void {
    this.cancelPending()
    this.publish({ ...this.state, followingTail: false })
  }

  /** Land at the current floor and clear saved reader position. */
  followTail(): void {
    const landing = this.viewport.scrollToBottom(this.follow)
    if (landing === null) return
    this.cancelPending()
    this.commit(landing, true, this.viewport.latestTurn)
  }

  /** Restore the Session's semantic position, or follow the tail when none is saved. */
  restore(): void {
    const saved = this.store.read()
    if (saved === null) { this.followTail(); return }
    const landing = this.viewport.restore(saved)
    if (landing === null) return
    this.cancelPending()
    const following = this.follow.nearBottom(landing.metrics)
    this.commit(landing, following, following ? this.viewport.latestTurn : this.state.activeTurn, following)
    if (!this.state.followingTail && landing.position === null) {
      const position = this.viewport.capturePosition()
      if (position !== null) this.store.save(position)
    }
    this.refreshActiveTurn()
  }

  /**
   * Adopt a known landing without rediscovering its anchor.
   * @param landing - measured navigation result that replaces pending reader input.
   */
  acceptNavigation(landing: ViewportLanding): void {
    this.cancelPending()
    const following = this.follow.nearBottom(landing.metrics)
    this.commit(landing, following, landing.turn ?? (following ? this.viewport.latestTurn : this.state.activeTurn))
  }

  /**
   * Retain reading policy while history changes the anchor's geometry.
   * @param landing - compensated position that retains the current reading policy.
   */
  preservePosition(landing: ViewportLanding): void {
    this.cancelPending()
    this.commit(landing, this.state.followingTail, this.state.activeTurn)
  }

  /**
   * Handle pinned layout movement and reader arrivals at the floor immediately.
   * @param scroll - attributed scroll delivery; other reader movement remains pending until sampled.
   */
  readonly onScroll = (scroll: ViewportScroll): void => {
    if ((!scroll.movedByReader && this.state.followingTail)
      || (scroll.movedByReader && scroll.metrics.top >= scroll.metrics.floor)) {
      this.followTail()
      this.sampled?.({ position: null, movedByReader: scroll.movedByReader, followingTail: true })
      return
    }
    this.sampleTimer ??= window.setTimeout(this.flushSample, SCROLL_SAMPLE_INTERVAL_MS)
  }

  /** Settle pending reader movement at the browser's scrollend. */
  readonly onScrollEnd = (): void => { this.flushSample() }

  /** Reconcile a layout change without overriding unsampled reader input. */
  onResize(): void {
    if (this.pending) return
    if (this.state.followingTail) this.followTail()
    else this.refreshActiveTurn()
  }

  /** Resolve the active turn from tail ownership or a coalesced reading-line probe. */
  refreshActiveTurn(): void {
    if (this.pending) return
    if (this.state.followingTail) {
      this.publish({ ...this.state, initialized: true, activeTurn: this.viewport.latestTurn })
      return
    }
    if (this.probeFrame !== null) return
    if (typeof requestAnimationFrame !== 'function') this.probe()
    else this.probeFrame = requestAnimationFrame(this.probe)
  }

  private commit(
    landing: ViewportLanding, followingTail: boolean, activeTurn: number | null, initialized = true,
  ): void {
    if (followingTail) this.store.save(null)
    else if (landing.position !== null) this.store.save(landing.position)
    this.publish({ initialized, followingTail, activeTurn })
  }

  private publish(state: ChatReadingState): void {
    this.follow.setFollowing(state.followingTail)
    if (state.initialized === this.state.initialized && state.followingTail === this.state.followingTail
      && state.activeTurn === this.state.activeTurn) return
    this.state = state
    this.onChange(state)
  }

  private cancelPending(): void {
    if (this.sampleTimer !== null) window.clearTimeout(this.sampleTimer)
    if (this.probeFrame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.probeFrame)
    this.sampleTimer = null
    this.probeFrame = null
  }

  private readonly probe = (): void => {
    this.probeFrame = null
    if (this.pending) return
    const scroll = this.viewport.readScroll()
    if (scroll === null) return
    const activeTurn = this.follow.nearBottom(scroll.metrics) ? this.viewport.latestTurn : this.viewport.readVisibleTurn(scroll.metrics)
    this.publish({ ...this.state, initialized: true, activeTurn })
  }

  private readonly flushSample = (): void => {
    if (!this.pending) return
    this.cancelPending()
    const scroll = this.viewport.readScroll()
    if (scroll === null) return
    const followingTail = this.follow.sample(scroll.metrics, scroll.movedByReader)
    let position: ChatScrollPosition | null = null
    if (!scroll.movedByReader && followingTail) this.followTail()
    else {
      position = followingTail ? null : this.viewport.capturePosition()
      this.viewport.acknowledge(scroll.metrics)
      if (followingTail || position !== null) this.store.save(position)
      const activeTurn = this.follow.nearBottom(scroll.metrics) ? this.viewport.latestTurn : this.viewport.readVisibleTurn(scroll.metrics)
      this.publish({ initialized: true, followingTail, activeTurn })
    }
    this.sampled?.({ position, movedByReader: scroll.movedByReader, followingTail })
  }
}

/**
 * Retain reading policy and expose only changes in visible reading state.
 * @param viewport - turn-aware DOM operations.
 * @param store - Session-owned semantic scroll memory.
 * @param initialTurn - latest loaded turn before the first landing.
 * @returns the reading owner and its React-visible state.
 */
export function useChatReading(
  viewport: ChatViewport, store: PositionStore, initialTurn: number | null,
): { reading: ChatReading; state: ChatReadingState } {
  const [state, setState] = useState<ChatReadingState>(() => ({
    initialized: false,
    followingTail: store.read() === null,
    activeTurn: initialTurn,
  }))
  const follow = useScrollFollow(state.followingTail, FOLLOW_THRESHOLD + 1)
  const [reading] = useState(() => new ChatReading(viewport, store, state, setState, follow))
  useLayoutEffect(() => { reading.setStore(store) }, [reading, store])
  useLayoutEffect(() => () => { reading.dispose() }, [reading])
  return { reading, state }
}
