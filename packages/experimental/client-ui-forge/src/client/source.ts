/** Per-Session panel stream sources, the store behind action notices, and the tab visibility store. */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ForgePanelState } from '../types.ts'
import type { ForgePanelKey } from './locales.ts'

/** What the panel surfaces of one Session read. */
export interface PanelSnapshot {
  /** Latest state from the Host, or null before the first one arrives. */
  readonly state: ForgePanelState | null
  /** Whether the stream ended while surfaces still read it. */
  readonly disconnected: boolean
}

/** One open stream of panel states. */
export interface PanelStream extends AsyncIterable<ForgePanelState> {
  /** Close the stream. */
  dispose: () => void
}

/** Stream opener and connection-reset subscription of one Session's source. */
export interface PanelSourceDeps {
  /**
   * Open the Host stream of the Session.
   * @param signal - aborts the stream.
   * @returns the stream.
   */
  readonly open: (signal: AbortSignal) => PanelStream
  /**
   * Subscribe to transport resets, after which an open stream no longer delivers.
   * @param listener - called on each reset.
   * @returns the unsubscribe function.
   */
  readonly subscribeReset: (listener: () => void) => () => void
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

const EMPTY: PanelSnapshot = { state: null, disconnected: false }

/**
 * Create the panel source of one Session. The first subscriber opens the
 * stream and the last one closes it; the last state stays readable for the
 * next subscriber. A stream that ends or fails while subscribed marks the
 * snapshot disconnected until `reconnect` or a transport reset reopens it.
 * @param deps - stream opener and reset subscription.
 * @returns the source.
 */
export function createPanelSource(deps: PanelSourceDeps): PanelSource {
  let snapshot = EMPTY
  const listeners = new Set<() => void>()
  let running: { readonly controller: AbortController; readonly stream: PanelStream } | undefined
  let stopReset: (() => void) | undefined
  const publish = (next: PanelSnapshot): void => {
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
        for await (const state of opened.stream) {
          if (running !== opened) return
          publish({ state, disconnected: false })
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
    hooks: {
      panel: {
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
    },
    reconnect,
    close,
  }
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
