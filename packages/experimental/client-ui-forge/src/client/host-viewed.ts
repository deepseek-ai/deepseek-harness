/**
 * Viewed marks a code host keeps for a whole change request. The changes view reads them with the diff and shows each
 * mark the reader sets at once, while the host saves it; a mark the host refuses returns to what the host keeps, and a
 * mark the host may have saved stays.
 */

import { useMemo, useRef, useState } from 'react'
import type { ForgeViewedFiles, ForgeViewedRequest, ForgeViewedState } from '@deepseek-ai/dsh-experimental-forge/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ForgeDiffFile } from '../types.ts'
import type { ViewedMarks } from './viewed-files.ts'

/** The host's marks on the files of one diff, or why the view could not read them. */
export type HostViewed =
  | { readonly kind: 'read'; readonly files: Readonly<Record<string, ForgeViewedState>> }
  | { readonly kind: 'failed'; readonly message: string }

/** A loaded change request diff whose marks the host keeps. */
export interface HostViewedOwner {
  /** Binding URL of the change request. */
  readonly url: string
  /** Head commit the diff and its marks were read at. */
  readonly headSha: string
  /** Files of the diff with the digest of each change. */
  readonly files: readonly ForgeDiffFile[]
  /** The host's marks. */
  readonly viewed: HostViewed
}

/**
 * Why a mark the host did not save returned to its previous state, or why the view cannot tell whether the host saved
 * a mark it keeps showing.
 */
export type HostViewedFailure =
  | { readonly kind: 'stale' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'unknown'; readonly message: string }

/** The host's marks of the shown diff with the reader's writes. */
export interface HostViewedMarks {
  /** Marks as digests, so a mark of the current change matches the file's digest and a dismissed mark matches none. */
  readonly marks: ViewedMarks
  /** Whether the host's marks could not be read, so no file can be marked. */
  readonly unavailable: boolean
  /** Whether a write of the file's mark is in flight. */
  readonly saving: (path: string) => boolean
  /**
   * Show a mark at once and save it on the host.
   * @param path - the file's path.
   * @param viewed - whether the file is viewed.
   * @returns false, changing nothing, while the marks are unavailable or the file's previous write is in flight.
   */
  readonly mark: (path: string, viewed: boolean) => boolean
}

/**
 * The reader's mark of one file over the host's. It applies to every read of its change request and head while its
 * write is in flight, and once settled only to `read`, the read shown when it settled, which may not hold it yet.
 */
interface Choice {
  readonly viewed: boolean
  readonly read: HostViewedOwner
  readonly saving: boolean
}

/** The reader's marks of one change request at one head, by path. */
interface Choices {
  readonly key: string | null
  readonly files: ReadonlyMap<string, Choice>
}

const NO_CHOICES: ReadonlyMap<string, boolean> = new Map()
const NO_MARKS: ViewedMarks = new Map()

/** Digest a dismissed mark records: no file change digests to it, so the file reads as changed since it was viewed. */
const DISMISSED = ''

/** Identity of the marks a read holds: one change request at one head commit. */
function keyOf(owner: HostViewedOwner): string {
  return `${owner.url}\n${owner.headSha}`
}

/**
 * Convert the host's marks of a diff to digests, with the reader's choices taking the place of the host's.
 * @param files - files of the diff with the digest of each change.
 * @param host - the host's state of each file the host listed.
 * @param chosen - the reader's marks that apply to the diff, by path.
 * @returns the digest of each file marked viewed or dismissed.
 */
export function hostMarksOf(
  files: readonly ForgeDiffFile[],
  host: Readonly<Record<string, ForgeViewedState>>,
  chosen: ReadonlyMap<string, boolean>,
): ViewedMarks {
  const marks = new Map<string, string>()
  for (const file of files) {
    const choice = chosen.get(file.path)
    // Only the host's own entries count, so a path such as `constructor` never reads an inherited property.
    const state = choice === undefined ? Object.hasOwn(host, file.path) ? host[file.path] : undefined
      : choice ? 'viewed' : 'unviewed'
    if (state === 'viewed') marks.set(file.path, file.digest)
    else if (state === 'dismissed') marks.set(file.path, DISMISSED)
  }
  return marks
}

/**
 * Convert a read of the host's marks to the state the view keeps for a diff read at `headSha`.
 * @param result - the read, or null when the diff shows chosen commits, which the host keeps no marks for.
 * @param headSha - head commit the diff was read at.
 * @returns the marks, why they could not be read, or null when the browser keeps the marks instead.
 */
export function hostViewedOf(result: RemoteResult<ForgeViewedFiles | null> | null, headSha: string): HostViewed | null {
  if (result === null) return null
  if (!result.ok) return { kind: 'failed', message: result.error.message }
  if (result.value === null) return null
  return result.value.headSha === headSha ? { kind: 'read', files: result.value.files }
    // The diff and the marks were read at two heads, so neither matches the other.
    : { kind: 'failed', message: `viewed marks were read at ${result.value.headSha}, the diff at ${headSha}` }
}

/**
 * Keep the reader's marks of a change request at one head over the host's, saving each on the host. A read at the same
 * head keeps the marks whose writes are in flight and their locks; a mark whose write settled stays until the next read,
 * which then holds what the host saved. A read at another head or of another change request starts without choices.
 * @param owner - the shown diff when the host keeps its marks, else null.
 * @param save - saves one mark on the host.
 * @param failed - reports a mark the host did not save after it returned to its previous state, or a mark the host may
 * not have saved.
 * @returns the marks and the write action, or null when the browser keeps the marks.
 */
export function useHostViewed(
  owner: HostViewedOwner | null,
  save: (url: string, request: ForgeViewedRequest) => Promise<RemoteResult<void>>,
  failed: (failure: HostViewedFailure) => void,
): HostViewedMarks | null {
  const [choices, setChoices] = useState<Choices>({ key: null, files: new Map() })
  // The read a write that settles later finds shown; assigned in render so a settlement after this render sees it.
  const shown = useRef(owner)
  shown.current = owner
  const key = owner === null ? null : keyOf(owner)
  const applying = useMemo(() => {
    if (owner === null || choices.key !== key) return new Map<string, Choice>()
    return new Map([...choices.files].filter(([, choice]) => choice.saving || choice.read === owner))
  }, [owner, key, choices])
  const marks = useMemo(() => {
    if (owner?.viewed.kind !== 'read') return NO_MARKS
    const chosen = applying.size === 0 ? NO_CHOICES : new Map([...applying].map(([path, choice]) => [path, choice.viewed]))
    return hostMarksOf(owner.files, owner.viewed.files, chosen)
  }, [owner, applying])
  if (owner === null || key === null) return null
  const { viewed } = owner
  const saving = (path: string): boolean => applying.get(path)?.saving === true
  /** Settle the write of `path` at this key: keep `next` for the read shown now, or drop the choice. */
  const settle = (path: string, next: boolean | undefined): void => {
    setChoices((current) => {
      if (current.key !== key) return current
      const files = new Map(current.files)
      // A read at another key never takes these choices, so only a view without the host's marks keeps the original read.
      const read = shown.current ?? owner
      if (next === undefined) files.delete(path)
      else files.set(path, { viewed: next, read, saving: false })
      return { key, files }
    })
  }
  return {
    marks,
    unavailable: viewed.kind === 'failed',
    saving,
    mark: (path, value) => {
      if (viewed.kind === 'failed' || saving(path)) return false
      const previous = applying.get(path)?.viewed
      setChoices((current) => {
        const files = new Map(current.key === key ? current.files : [])
        return { key, files: files.set(path, { viewed: value, read: owner, saving: true }) }
      })
      void save(owner.url, { path, viewed: value, headSha: owner.headSha }).then((result) => {
        if (result.ok) {
          settle(path, value)
          return
        }
        const { code, message } = result.error
        // The host may have saved a mark it did not confirm, so the mark stays and the reader is told to check.
        if (code === 'forgePanel/action-unknown') {
          settle(path, value)
          failed({ kind: 'unknown', message })
          return
        }
        settle(path, previous)
        failed(code === 'forgePanel/stale-head' ? { kind: 'stale' } : { kind: 'failed', message })
      })
      return true
    },
  }
}
