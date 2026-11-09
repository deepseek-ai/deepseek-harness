/** Reads the review threads of the change request a changes view shows and places them in its files. */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ForgeReviewData, ForgeReviewThread } from '@deepseek-ai/dsh-experimental-forge/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { LineThread } from './ReviewThreads.tsx'
import { placeThread, type ThreadPlace, type ThreadView } from './review-threads.ts'

/** What the changes view knows about its change request when it reads threads. */
export interface ThreadReadInput {
  /** Whether the view is visible; a hidden view reads nothing. */
  readonly visible: boolean
  /** Binding URL of the change request, or null for local changes. */
  readonly url: string | null
  /** Head commit of the latest status, or null before one. */
  readonly head: string | null
  /** Update time of the latest status, or null before one. */
  readonly updatedAt: string | null
  /** Epoch milliseconds of the latest status, so every status asks the Host again; the Host answers from memory until the threads age. */
  readonly statusAt: number | null
  /** Changes on each refresh. */
  readonly attempt: number
  /** Read the threads at a head commit; `fresh` skips the threads the host keeps. */
  readonly read: (url: string, headSha: string, fresh: boolean, signal: AbortSignal) => Promise<RemoteResult<ForgeReviewData>>
}

/** The last threads read and why the latest read failed. */
export interface ThreadReadState {
  /** Threads of the last successful read for the URL, at any head, or null. */
  readonly review: ForgeReviewData | null
  /** Message of the latest failed read, or null, also when the provider cannot read reviews. */
  readonly failure: string | null
}

/**
 * Read the threads at the head of each status while the view is visible. A read refused because the head moved
 * keeps the previous threads; the next status names the new head and reads again. The first read after a refresh
 * asks the host to skip the threads it keeps, which a resolved thread leaves unchanged.
 * @param input - the change request and the reader.
 * @returns the last threads and the latest failure.
 */
export function useThreadRead(input: ThreadReadInput): ThreadReadState {
  const { visible, url, head, updatedAt, statusAt, attempt, read } = input
  const [state, setState] = useState<ThreadReadState & { readonly url: string | null }>({ url: null, review: null, failure: null })
  const readAttempt = useRef(attempt)
  useEffect(() => {
    if (!visible || url === null || head === null) return
    const fresh = readAttempt.current !== attempt
    readAttempt.current = attempt
    const controller = new AbortController()
    void read(url, head, fresh, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      if (result.ok) {
        setState({ url, review: result.value, failure: null })
        return
      }
      const { code, message } = result.error
      if (code === 'forgePanel/stale-head') return
      setState(previous => ({ url, review: previous.url === url ? previous.review : null,
        failure: code === 'forgePanel/review-unsupported' ? null : message }))
    })
    return () => { controller.abort() }
  }, [visible, url, head, updatedAt, statusAt, attempt, read])
  return state.url === url ? state : { review: null, failure: null }
}

/** Threads of one file grouped by where they show, and how many of them are unresolved. */
export interface PlacedFileThreads {
  readonly lines: readonly LineThread[]
  readonly file: readonly ForgeReviewThread[]
  readonly outdated: readonly ForgeReviewThread[]
  readonly unresolved: number
}

/** One thread and where the shown changes place it. */
export interface PlacedThread {
  readonly thread: ForgeReviewThread
  readonly place: ThreadPlace
}

/** Every thread with its place and the threads of each file. */
export interface PlacedThreads {
  /** Every thread in host order with its place. */
  readonly entries: readonly PlacedThread[]
  /** Threads of each path. */
  readonly files: ReadonlyMap<string, PlacedFileThreads>
  /** Unresolved threads by path, for the file tree. */
  readonly unresolved: ReadonlyMap<string, number>
}

const NONE: PlacedThreads = { entries: [], files: new Map(), unresolved: new Map() }

/**
 * Place the threads of a review in the shown changes.
 * @param review - threads read at the head of the latest status, or null.
 * @param view - the shown changes, or null before they load.
 * @returns places, per-file groups, and unresolved counts.
 */
export function usePlacedThreads(review: ForgeReviewData | null, view: ThreadView | null): PlacedThreads {
  const commits = view?.commits ?? null
  const end = view?.end ?? null
  return useMemo(() => {
    if (review === null || end === null) return NONE
    const entries: PlacedThread[] = []
    const files = new Map<string, { lines: LineThread[]; file: ForgeReviewThread[]; outdated: ForgeReviewThread[]; unresolved: number }>()
    const unresolved = new Map<string, number>()
    for (const thread of review.threads) {
      const place = placeThread(thread, { head: review.headSha, end, commits })
      entries.push({ thread, place })
      let group = files.get(thread.path)
      if (group === undefined) {
        group = { lines: [], file: [], outdated: [], unresolved: 0 }
        files.set(thread.path, group)
      }
      if (place.kind === 'line') group.lines.push({ thread, place })
      else if (place.kind === 'file') group.file.push(thread)
      else if (place.kind === 'outdated') group.outdated.push(thread)
      if (!thread.resolved) {
        group.unresolved += 1
        unresolved.set(thread.path, group.unresolved)
      }
    }
    return { entries, files, unresolved }
  }, [review, end, commits])
}
