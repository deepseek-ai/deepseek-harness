/**
 * Host stream sources (per-Session panel states and the change request states
 * of the Session list), the store behind action notices, and the tab visibility store.
 */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ForgeChangeRequestListState, ForgeChangeRequestStatesFrame, ForgePanelState } from '../types.ts'
import type { ForgePanelKey } from './locales.ts'

/** What a stream source publishes: the value its frames built, and whether the stream ended while read. */
export interface StreamSnapshot<S> {
  /** Value built from the frames so far. */
  readonly state: S
  /** Whether the stream ended while surfaces still read it. */
  readonly disconnected: boolean
}

/** What the panel surfaces of one Session read; `state` is null before the first one arrives. */
export type PanelSnapshot = StreamSnapshot<ForgePanelState | null>

/** One open Host stream. */
export interface HostStream<F> extends AsyncIterable<F> {
  /** Close the stream. */
  dispose: () => void
}

/** One open stream of panel states. */
export type PanelStream = HostStream<ForgePanelState>

/** Stream opener and connection-reset subscription of a source. */
export interface StreamSourceDeps<F> {
  /**
   * Open the Host stream.
   * @param signal - aborts the stream.
   * @returns the stream.
   */
  readonly open: (signal: AbortSignal) => HostStream<F>
  /**
   * Subscribe to transport resets, after which an open stream no longer delivers.
   * @param listener - called on each reset.
   * @returns the unsubscribe function.
   */
  readonly subscribeReset: (listener: () => void) => () => void
}

/** Stream opener and connection-reset subscription of one Session's panel source. */
export type PanelSourceDeps = StreamSourceDeps<ForgePanelState>

/** A value built from a Host stream that runs only while a surface subscribes. */
export interface StreamSource<S> {
  /** Snapshot observable; the renderer binds it as a selector hook. */
  readonly observable: HostObservable<StreamSnapshot<S>>
  /** Open the stream again after it ended; a no-op while it runs or nobody subscribes. */
  readonly reconnect: () => void
  /** Close the stream and the reset subscription and drop every subscriber. */
  readonly close: () => void
}

/** Panel state of one Session, streamed only while a surface subscribes. */
export interface PanelSource {
  /** Snapshot observable; the renderer binds it as `usePanel`. */
  readonly hooks: { readonly panel: HostObservable<PanelSnapshot> }
  /** Open the stream again after it ended; a no-op while it runs or nobody subscribes. */
  readonly reconnect: () => void
  /** Close the stream and the reset subscription and drop every subscriber. */
  readonly close: () => void
}

/**
 * Create a source that folds a Host stream into one value. The first
 * subscriber opens the stream and the last one closes it; the value stays
 * readable for the next subscriber. A stream that ends or fails while
 * subscribed marks the snapshot disconnected until `reconnect` or a transport
 * reset reopens it.
 * @param deps - stream opener and reset subscription.
 * @param initial - value before the first frame.
 * @param fold - the value after one frame.
 * @returns the source.
 */
export function createStreamSource<F, S>(deps: StreamSourceDeps<F>, initial: S, fold: (state: S, frame: F) => S): StreamSource<S> {
  let snapshot: StreamSnapshot<S> = { state: initial, disconnected: false }
  const listeners = new Set<() => void>()
  let running: { readonly controller: AbortController; readonly stream: HostStream<F> } | undefined
  let stopReset: (() => void) | undefined
  const publish = (next: StreamSnapshot<S>): void => {
    snapshot = next
    for (const listener of [...listeners]) listener()
  }
  const stop = (): void => {
    const stopped = running
    running = undefined
    stopped?.controller.abort()
    stopped?.stream.dispose()
  }
  const start = (): void => {
    const controller = new AbortController()
    const opened = { controller, stream: deps.open(controller.signal) }
    running = opened
    if (snapshot.disconnected) publish({ ...snapshot, disconnected: false })
    void (async () => {
      try {
        for await (const frame of opened.stream) {
          if (running !== opened) return
          publish({ state: fold(snapshot.state, frame), disconnected: false })
        }
      } catch (error) {
        void error // A failed stream is reported as the disconnection below.
      }
      if (running !== opened) return
      running = undefined
      publish({ ...snapshot, disconnected: true })
    })()
  }
  const reconnect = (): void => {
    if (listeners.size === 0 || running !== undefined) return
    start()
  }
  const close = (): void => {
    listeners.clear()
    stopReset?.()
    stopReset = undefined
    stop()
  }
  return {
    observable: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener)
        if (listeners.size === 1) {
          stopReset = deps.subscribeReset(() => {
            stop()
            reconnect()
          })
          start()
        }
        return () => {
          listeners.delete(listener)
          if (listeners.size === 0) close()
        }
      },
    },
    reconnect,
    close,
  }
}

/**
 * Create the panel source of one Session: the latest state the Host streamed.
 * @param deps - stream opener and reset subscription.
 * @returns the source.
 */
export function createPanelSource(deps: PanelSourceDeps): PanelSource {
  const source = createStreamSource<ForgePanelState, ForgePanelState | null>(deps, null, (_previous, state) => state)
  return { hooks: { panel: source.observable }, reconnect: source.reconnect, close: source.close }
}

/**
 * The known change request states after one `changeRequestStates` frame: a
 * baseline replaces them, and a change replaces the states it carries.
 * @param states - states by URL before the frame.
 * @param frame - the frame.
 * @returns states by URL after the frame.
 */
export function foldStates(
  states: ReadonlyMap<string, ForgeChangeRequestListState>,
  frame: ForgeChangeRequestStatesFrame,
): ReadonlyMap<string, ForgeChangeRequestListState> {
  const next = frame.type === 'baseline' ? new Map<string, ForgeChangeRequestListState>() : new Map(states)
  for (const state of frame.states) next.set(state.url, state)
  return next
}

/** One action notice; `seq` keys the toast so a repeated notice restarts it. */
export interface ActionNotice {
  /** Dictionary key of the notice text. */
  readonly key: ForgePanelKey
  /** Values interpolated into the text. */
  readonly params: Readonly<Record<string, string | number>>
  /** `success` reports a completed action; `failure` a refused or failed one. */
  readonly tone: 'success' | 'failure'
  /** Reverts the reported action, or undefined when it cannot be undone. */
  readonly undo: (() => void) | undefined
  /** Increasing report number. */
  readonly seq: number
}

/** Optional parts of a reported notice. */
export interface NoticeOptions {
  /** Values interpolated into the text. */
  readonly params?: Readonly<Record<string, string | number>>
  /** Defaults to `failure`. */
  readonly tone?: ActionNotice['tone']
  /** Reverts the reported action. */
  readonly undo?: () => void
}

/** Store that action wiring reports into and one `shell.overlay` entry reads. */
export interface NoticeSource {
  /** Current notice, or null while none shows; the renderer binds it as `useNotice`. */
  readonly hooks: { readonly notice: HostObservable<ActionNotice | null> }
  /**
   * Show one notice, replacing the shown one.
   * @param key - dictionary key of the text.
   * @param options - interpolated values, tone, and undo action.
   */
  readonly report: (key: ForgePanelKey, options?: NoticeOptions) => void
  /** Clear the shown notice. */
  readonly dismiss: () => void
}

/**
 * Create the action notice store.
 * @returns the store.
 */
export function createNoticeSource(): NoticeSource {
  let notice: ActionNotice | null = null
  let seq = 0
  const listeners = new Set<() => void>()
  const publish = (next: ActionNotice | null): void => {
    notice = next
    for (const listener of [...listeners]) listener()
  }
  return {
    hooks: {
      notice: {
        getSnapshot: () => notice,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
    },
    report: (key, options = {}) => {
      publish({ key, params: options.params ?? {}, tone: options.tone ?? 'failure', undo: options.undo, seq: ++seq })
    },
    dismiss: () => { publish(null) },
  }
}

/** Whether one Session's forge tab is visible; the header entry reads it for its pressed state. */
export interface VisibilitySource {
  /** Current visibility; the renderer binds it as `useVisible`. */
  readonly hooks: { readonly visible: HostObservable<boolean> }
  /**
   * Record the tab's visibility.
   * @param visible - whether the tab is visible.
   */
  readonly set: (visible: boolean) => void
}

/**
 * Create the visibility store of one Session's forge tab, initially hidden.
 * @returns the store.
 */
export function createVisibilitySource(): VisibilitySource {
  let visible = false
  const listeners = new Set<() => void>()
  return {
    hooks: {
      visible: {
        getSnapshot: () => visible,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
    },
    set: (next) => {
      if (next === visible) return
      visible = next
      for (const listener of [...listeners]) listener()
    },
  }
}
