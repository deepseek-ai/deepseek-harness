/** A React hook that reads one Host stream, reopening it when its key or attempt changes. */

import { useCallback, useEffect, useState } from 'react'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { HostStream } from '../source.ts'

/** The state of one stream: its latest frame, and why it stopped when it did. */
export interface StreamRead<F> {
  /** Latest frame of the current key, or undefined before the first. */
  readonly frame: F | undefined
  /** Why the stream stopped: a Remote error code and message, `ended` when the Host closed it, or null while it runs. */
  readonly stopped: { readonly code: string; readonly message: string } | null
  /** Open the stream again. */
  readonly retry: () => void
}

/**
 * Read a Host stream while `key` is not null, keeping its latest frame. A new key or a retry closes the open stream and
 * opens another; unmounting closes it.
 * @param open - opens the stream for a key.
 * @param key - identity of the stream to read, or null to read none.
 * @param subscribeReset - subscribes to transport resets, after which the stream opens again.
 * @returns the latest frame, the stop reason, and the retry action.
 */
export function useHostStream<F>(
  open: (key: string, signal: AbortSignal) => HostStream<F>, key: string | null, subscribeReset: (listener: () => void) => () => void,
): StreamRead<F> {
  const [attempt, setAttempt] = useState(0)
  const [read, setRead] = useState<{ readonly key: string; readonly frame: F | undefined; readonly stopped: StreamRead<F>['stopped'] } | null>(null)
  const retry = useCallback(() => { setAttempt(value => value + 1) }, [])
  useEffect(() => subscribeReset(retry), [subscribeReset, retry])
  useEffect(() => {
    if (key === null) return
    const controller = new AbortController()
    const stream = open(key, controller.signal)
    const show = (stopped: StreamRead<F>['stopped']): void => {
      setRead(previous => ({ key, frame: previous?.key === key ? previous.frame : undefined, stopped }))
    }
    show(null)
    void (async () => {
      try {
        for await (const frame of stream) {
          if (controller.signal.aborted) return
          setRead({ key, frame, stopped: null })
        }
        if (controller.signal.aborted) return
        show(ENDED)
      } catch (error) {
        if (controller.signal.aborted) return
        const failure = remoteErrorOf(error)
        show({ code: failure?.code ?? 'ended', message: failure?.message ?? (error instanceof Error ? error.message : String(error)) })
      }
    })()
    return () => {
      controller.abort()
      stream.dispose()
    }
  }, [open, key, attempt])
  const current = read !== null && read.key === key ? read : null
  return { frame: current?.frame, stopped: current?.stopped ?? null, retry }
}

const ENDED = { code: 'ended', message: '' } as const
