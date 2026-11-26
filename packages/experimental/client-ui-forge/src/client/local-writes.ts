/** The writes the changes view makes to local changes: their requests, their one confirmation, and their notices. */

import { useRef, useState } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ForgeDiffFile, ForgeLocalWrite, ForgeLocalWriteResult } from '../types.ts'
import type { ForgePanelKey } from './locales.ts'
import type { NoticeOptions } from './source.ts'

/** A write a reader asks for on files of the shown scope. */
export type LocalWriteKind = 'stage' | 'unstage' | 'restore'

/** What the writes need from the view. */
export interface LocalWritesDeps {
  /** Send one write to the Host; never retried. */
  readonly localWrite: (write: ForgeLocalWrite) => Promise<RemoteResult<ForgeLocalWriteResult>>
  /** Show a notice. */
  readonly report: (key: ForgePanelKey, options?: NoticeOptions) => void
  /** Read the shown scope again. */
  readonly reread: () => void
  /** Whether the shown scope is being read again; until it ends, the shown files can be ones a write already changed. */
  readonly rereading: boolean
}

/** The writes of one changes view. */
export interface LocalWrites {
  /** Whether a write is in flight or the scope is read again; no write of the shown files starts until both end. */
  readonly writing: boolean
  /** The file whose restoration waits for the reader's answer, with the two answers; null while none waits. */
  readonly restoring: { readonly file: ForgeDiffFile; readonly confirm: () => void; readonly cancel: () => void } | null
  /** Stage or unstage the files at once; ask before restoring the first of them. Without files, or while `writing`, nothing happens. */
  readonly write: (kind: LocalWriteKind, files: readonly ForgeDiffFile[]) => void
}

/** Notices of refusals the Host reports by code; any other failure shows its message. */
const REFUSED: Readonly<Record<string, ForgePanelKey>> = {
  'forgePanel/local-stale': 'toast.writeStale',
  'forgePanel/local-path-replaced': 'toast.writeReplaced',
}

/** Every path a file's change names: a rename also names the path it left. */
function pathsOf(files: readonly ForgeDiffFile[]): string[] {
  return files.flatMap(file => file.previousPath === null ? [file.path] : [file.previousPath, file.path])
}

/**
 * Build the request for one kind of write.
 * @param kind - the write.
 * @param files - files of the shown scope: `unstaged` for staging and restoring, `staged` for unstaging.
 * @returns the request, which names each staged or restored file with the digest of the change shown.
 */
export function writeRequest(kind: LocalWriteKind, files: readonly ForgeDiffFile[]): ForgeLocalWrite {
  if (kind === 'unstage') return { kind, paths: pathsOf(files) }
  return { kind, files: files.map(file => ({ path: file.path, digest: file.digest })) }
}

/** The last segment of a path, which notices name a file by. */
function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/**
 * Hold the writes of one changes view. Every settled write reads the scope again, since even a failed one can have
 * changed some of its paths. A staged or unstaged set reports with an undo that returns the index entries of those
 * paths to their state before the write; a restoration cannot be undone, so it waits for a confirmation.
 * @param deps - the Remote write, the notice reporter, and the reread of the shown scope.
 * @returns the state and actions of the writes.
 */
export function useLocalWrites(deps: LocalWritesDeps): LocalWrites {
  const [writing, setWriting] = useState(false)
  const [asked, setAsked] = useState<ForgeDiffFile | null>(null)
  // The state above lags a second press within the same frame.
  const busy = useRef(false)
  const latest = useRef(deps)
  latest.current = deps

  const send = (request: ForgeLocalWrite, settled: (result: RemoteResult<ForgeLocalWriteResult>) => void): void => {
    busy.current = true
    setWriting(true)
    void latest.current.localWrite(request).then((result) => {
      busy.current = false
      setWriting(false)
      latest.current.reread()
      settled(result)
    })
  }
  const undo = (tree: string, paths: readonly string[]): void => {
    if (busy.current) {
      latest.current.report('toast.undoFailed')
      return
    }
    send({ kind: 'reindex', tree, paths }, (result) => { if (!result.ok) latest.current.report('toast.undoFailed') })
  }
  const start = (kind: LocalWriteKind, files: readonly ForgeDiffFile[], first: ForgeDiffFile): void => {
    send(writeRequest(kind, files), (result) => {
      const { report } = latest.current
      if (!result.ok) {
        report(REFUSED[result.error.code] ?? 'toast.writeFailed', { params: { message: result.error.message } })
        return
      }
      const name = nameOf(first.path)
      if (kind === 'restore') {
        report(first.untracked ? 'toast.fileDeleted' : 'toast.fileRestored', { tone: 'success', params: { name } })
        return
      }
      const one = files.length === 1
      const key = kind === 'stage' ? one ? 'toast.staged' : 'toast.stagedMany' : one ? 'toast.unstaged' : 'toast.unstagedMany'
      const tree = result.value.undo
      const paths = pathsOf(files)
      report(key, { tone: 'success', params: { name, count: files.length }, ...tree === null ? {} : { undo: () => { undo(tree, paths) } } })
    })
  }
  return {
    writing: writing || deps.rereading,
    restoring: asked === null ? null : {
      file: asked,
      confirm: () => {
        setAsked(null)
        start('restore', [asked], asked)
      },
      cancel: () => { setAsked(null) },
    },
    write: (kind, files) => {
      const [first] = files
      if (busy.current || latest.current.rereading || first === undefined) return
      if (kind === 'restore') setAsked(first)
      else start(kind, files, first)
    },
  }
}
