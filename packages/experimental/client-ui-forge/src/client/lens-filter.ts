/** A changes view's filter lens: the request to the Host, its progress and result, and which hunks it folds. */

import { useEffect, useState } from 'react'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { ForgeDiffHunk, ForgeLensFrame, ForgeLensKeep, ForgeLensRequest, ForgeLineRange, ForgeRegisteredLens } from '../types.ts'
import type { HostStream } from './source.ts'

/** Where a lens request stands for the shown files. */
export type LensRun =
  /** No lens is chosen, or the files have not loaded. */
  | { readonly kind: 'idle' }
  /** The lens runs; `done` and `total` are null before it reports progress. */
  | { readonly kind: 'running'; readonly done: number | null; readonly total: number | null }
  /** The files the lens keeps, by path. */
  | { readonly kind: 'ready'; readonly files: Readonly<Record<string, ForgeLensKeep>> }
  /**
   * The request failed with a Remote error code and message, or with `forgePanel/lens-interrupted` and no message when the
   * stream ended without a result, as after a lost connection.
   */
  | { readonly kind: 'failed'; readonly code: string; readonly message: string }

/** What a view knows when it asks for a lens. */
export interface LensRunInput {
  /** Whether the view is visible; a hidden view starts no request. */
  readonly visible: boolean
  /** The chosen registered lens, or null for none. */
  readonly lens: ForgeRegisteredLens | null
  /** The source of the shown files, or null before they load. */
  readonly source: ForgeLensRequest['source'] | null
  /** `lensVersion` of the shown files, or null before they load. */
  readonly version: string | null
  /** Changes on each retry. */
  readonly attempt: number
  /** Open the Host's lens stream. */
  readonly open: (request: ForgeLensRequest, signal: AbortSignal) => HostStream<ForgeLensFrame>
}

/** The run of the chosen lens and the results already known for the shown files. */
export interface LensRunState {
  readonly run: LensRun
  /**
   * Read what a registered lens keeps of the shown files.
   * @returns the kept files once that lens, at that version, answered for the shown source and files.
   */
  readonly resultOf: (lens: ForgeRegisteredLens) => Readonly<Record<string, ForgeLensKeep>> | undefined
}

const IDLE: LensRun = { kind: 'idle' }

/** The files each lens keeps, by lens identity and version. */
type LensResults = ReadonlyMap<string, Readonly<Record<string, ForgeLensKeep>>>

const NO_RESULTS: LensResults = new Map()

/** Names one lens at one registered version, so a lens registered again at another version is asked again. */
function lensKeyOf(lens: ForgeRegisteredLens): string {
  return `${lens.id}\u0000${lens.version}`
}

/**
 * Ask the Host for the chosen lens whenever the shown source or files, the lens or its version, or the attempt change,
 * keeping the results of every lens asked for the same source and files. A view that becomes hidden stops its request;
 * a result already known is not asked for again.
 * @param input - the view's lens, files, and stream opener.
 * @returns the run and the known results.
 */
export function useLensRun(input: LensRunInput): LensRunState {
  const { visible, lens, source, version, attempt, open } = input
  // Results hold for one source at one version of its files: equal files of another scope have other old sides.
  const scope = source === null || version === null ? null : `${JSON.stringify(source)}\u0000${version}`
  const [kept, setKept] = useState<{ readonly scope: string | null; readonly files: LensResults }>({ scope: null, files: new Map() })
  const results = kept.scope === scope ? kept.files : NO_RESULTS
  const [run, setRun] = useState<{ readonly key: string; readonly run: LensRun } | null>(null)
  const lensId = lens?.id ?? null
  const lensKey = lens === null ? null : lensKeyOf(lens)
  const key = lensKey === null || scope === null ? null : `${scope}\u0000${lensKey}\u0000${attempt}`
  const known = lensKey === null ? undefined : results.get(lensKey)
  useEffect(() => {
    if (!visible || key === null || lensId === null || lensKey === null || source === null || version === null) return
    if (known !== undefined) return
    const controller = new AbortController()
    const stream = open({ source, version, lens: lensId }, controller.signal)
    setRun({ key, run: { kind: 'running', done: null, total: null } })
    void (async () => {
      try {
        for await (const frame of stream) {
          if (controller.signal.aborted) return
          if (frame.kind === 'progress') {
            setRun({ key, run: { kind: 'running', done: frame.done, total: frame.total } })
            continue
          }
          setKept(previous => ({
            scope, files: new Map(previous.scope === scope ? previous.files : []).set(lensKey, frame.files),
          }))
          return
        }
        if (!controller.signal.aborted) setRun({ key, run: { kind: 'failed', code: 'forgePanel/lens-interrupted', message: '' } })
      } catch (error) {
        if (controller.signal.aborted) return
        const failure = remoteErrorOf(error)
        setRun({ key, run: {
          kind: 'failed', code: failure?.code ?? 'forgePanel/lens-failed',
          message: failure?.message ?? (error instanceof Error ? error.message : String(error)),
        } })
      }
    })()
    return () => {
      controller.abort()
      stream.dispose()
    }
  }, [visible, key, lensId, lensKey, scope, source, version, known, open])
  const shown: LensRun = key === null ? IDLE : known !== undefined ? { kind: 'ready', files: known } : run?.key === key ? run.run : IDLE
  return { run: shown, resultOf: entry => results.get(lensKeyOf(entry)) }
}

/** Whether a hunk's lines on one side meet any of the ranges. */
function meets(start: number, count: number, ranges: readonly ForgeLineRange[]): boolean {
  const end = start + count - 1
  return count > 0 && ranges.some(range => range.start <= end && range.end >= start)
}

/**
 * The hunks of a kept file that touch none of the lens's lines on either side.
 * @param hunks - the file's hunks.
 * @param keep - what the lens keeps of the file.
 * @returns the indexes of the hunks to fold, empty when the lens names no lines.
 */
export function foldedHunks(hunks: readonly ForgeDiffHunk[], keep: ForgeLensKeep): ReadonlySet<number> {
  const ranges = keep.ranges
  if (ranges === undefined) return new Set()
  const folded = new Set<number>()
  for (const [index, hunk] of hunks.entries()) {
    if (!meets(hunk.oldStart, hunk.oldLines, ranges.old) && !meets(hunk.newStart, hunk.newLines, ranges.new)) folded.add(index)
  }
  return folded
}
