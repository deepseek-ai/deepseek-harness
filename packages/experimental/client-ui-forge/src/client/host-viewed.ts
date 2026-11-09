/**
 * Viewed marks a code host keeps for a whole change request. The changes view reads them with the diff and shows each
 * mark the reader sets at once, while the host saves it; a mark the host refuses returns to what the host keeps.
 */

import { useMemo, useState } from 'react'
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

/** Why a mark the host did not save returned to its previous state. */
export type HostViewedFailure = { readonly kind: 'stale' } | { readonly kind: 'failed'; readonly message: string }

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

const NO_CHOICES: Readonly<Record<string, boolean>> = {}
const NO_MARKS: ViewedMarks = new Map()
const NO_PATHS: ReadonlySet<string> = new Set()

/** Digest a dismissed mark records: no file change digests to it, so the file reads as changed since it was viewed. */
const DISMISSED = ''

/**
 * Convert the host's marks of a diff to digests, with the reader's choices taking the place of the host's.
 * @param files - files of the diff with the digest of each change.
 * @param host - the host's state of each file the host listed.
 * @param chosen - the reader's marks since the diff loaded, by path.
 * @returns the digest of each file marked viewed or dismissed.
 */
export function hostMarksOf(
  files: readonly ForgeDiffFile[],
  host: Readonly<Record<string, ForgeViewedState>>,
  chosen: Readonly<Record<string, boolean>>,
): ViewedMarks {
  const marks = new Map<string, string>()
  for (const file of files) {
    const choice = chosen[file.path]
    const state = choice === undefined ? host[file.path] : choice ? 'viewed' : 'unviewed'
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
 * Keep the reader's marks of one diff over the host's until the next diff loads, saving each on the host.
 * @param owner - the shown diff when the host keeps its marks, else null.
 * @param save - saves one mark on the host.
 * @param failed - reports a mark the host did not save after it returned to its previous state.
 * @returns the marks and the write action, or null when the browser keeps the marks.
 */
export function useHostViewed(
  owner: HostViewedOwner | null,
  save: (url: string, request: ForgeViewedRequest) => Promise<RemoteResult<void>>,
  failed: (failure: HostViewedFailure) => void,
): HostViewedMarks | null {
  const [chosen, setChosen] = useState<{ readonly owner: HostViewedOwner | null; readonly marks: Readonly<Record<string, boolean>> }>(
    { owner: null, marks: {} })
  const [saving, setSaving] = useState<{ readonly owner: HostViewedOwner | null; readonly paths: ReadonlySet<string> }>(
    { owner: null, paths: new Set() })
  const marks = chosen.owner === owner ? chosen.marks : NO_CHOICES
  const shown = useMemo(() => owner?.viewed.kind === 'read' ? hostMarksOf(owner.files, owner.viewed.files, marks) : NO_MARKS, [owner, marks])
  if (owner === null) return null
  const inFlight = saving.owner === owner ? saving.paths : NO_PATHS
  const { viewed } = owner
  // A choice made for an earlier diff never applies to a later one, whose read already holds what the host saved, and a
  // write of an earlier diff that settles late leaves the later diff's choices alone.
  const choose = (path: string, value: boolean): void => {
    setChosen(current => ({ owner, marks: { ...current.owner === owner ? current.marks : {}, [path]: value } }))
  }
  const restore = (path: string, previous: boolean | undefined): void => {
    setChosen((current) => {
      if (current.owner !== owner) return current
      const { [path]: _mark, ...rest } = current.marks
      return { owner, marks: previous === undefined ? rest : { ...rest, [path]: previous } }
    })
  }
  const settle = (path: string): void => {
    setSaving(value => value.owner === owner ? { owner, paths: new Set([...value.paths].filter(item => item !== path)) } : value)
  }
  return {
    marks: shown,
    unavailable: viewed.kind === 'failed',
    saving: path => inFlight.has(path),
    mark: (path, value) => {
      if (viewed.kind === 'failed' || inFlight.has(path)) return false
      const previous = marks[path]
      choose(path, value)
      setSaving(current => ({ owner, paths: new Set([...current.owner === owner ? current.paths : [], path]) }))
      void save(owner.url, { path, viewed: value, headSha: owner.headSha }).then((result) => {
        settle(path)
        if (result.ok) return
        restore(path, previous)
        failed(result.error.code === 'forgePanel/stale-head' ? { kind: 'stale' } : { kind: 'failed', message: result.error.message })
      })
      return true
    },
  }
}
