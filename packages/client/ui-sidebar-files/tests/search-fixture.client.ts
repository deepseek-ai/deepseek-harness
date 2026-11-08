/** Scripted search answers and in-memory preferences for the search specs. */
import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSearchPreferenceBook } from '../src/client/search-preferences.ts'
import type { WorkspaceSearchPreferenceBook } from '../src/client/search-preferences.ts'
import type { SearchMatch } from '../src/client/search-tree.ts'
import type { SearchWorkspace, WorkspaceSearchAnswer, WorkspaceSearchRequest } from '../src/client/search-workspace.ts'

/**
 * Matches as a search answers them.
 * @param paths - matched paths, files unless they end with `/`.
 * @returns the matches.
 */
export function found(paths: readonly string[]): SearchMatch[] {
  return paths.map(path => path.endsWith('/') ? { path: path.slice(0, -1), type: 'directory' as const } : { path, type: 'file' as const })
}

/** Whether an answer is cut at the Host's match limit, or missed some directories. */
export interface AnswerFlags {
  readonly truncated?: boolean
  readonly incomplete?: boolean
}

/**
 * A settled answer.
 * @param paths - the matches, as {@link found} takes them.
 * @param flags - whether the answer is truncated or incomplete; neither when omitted.
 * @returns the answer.
 */
export function answer(paths: readonly string[], flags: AnswerFlags = {}): RemoteResult<WorkspaceSearchAnswer> {
  return { ok: true, value: { matches: found(paths), truncated: flags.truncated ?? false, incomplete: flags.incomplete ?? false } }
}

/** One search the face started. */
export interface StartedSearch {
  /** What the face asked for. */
  readonly request: WorkspaceSearchRequest
  /** The signal the face passed. */
  readonly signal: AbortSignal
  /** Answer it, unless it is already answered. @param result - the answer. */
  readonly settle: (result: RemoteResult<WorkspaceSearchAnswer>) => void
  /** Reject it, as an assembly fault does. @param error - the rejection. */
  readonly reject: (error: unknown) => void
}

/** A search the face calls: it answers at once with a fixed answer, or leaves each call open for the spec to settle. */
export interface ScriptedSearch {
  /** The mock the face receives. */
  readonly search: Mock<SearchWorkspace>
  /** Every search started, oldest first. */
  readonly started: readonly StartedSearch[]
  /**
   * Answer every later search at once, or leave later searches open.
   * @param result - the answer, or `undefined` to leave them open.
   */
  readonly answerWith: (result: RemoteResult<WorkspaceSearchAnswer> | undefined) => void
}

/**
 * A search that answers every request with the same matches until the spec
 * changes them.
 * @param paths - the matches, as {@link found} takes them.
 * @returns the scripted search.
 */
export function scriptedSearch(paths: readonly string[] = []): ScriptedSearch {
  const started: StartedSearch[] = []
  let fixed: RemoteResult<WorkspaceSearchAnswer> | undefined = answer(paths)
  const search = vi.fn<SearchWorkspace>((_sessionId, request, signal) => new Promise((resolve, reject) => {
    started.push({ request, signal, settle: resolve, reject })
    if (fixed !== undefined) resolve(fixed)
  }))
  return { search, started, answerWith: (result) => { fixed = result } }
}

/**
 * Let settled searches reach the face: a search's answer takes two microtasks to be written.
 * @returns once they have.
 */
export async function searchesSettled(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) await Promise.resolve()
}

/**
 * A preference book over an in-memory store, as the plugin keeps one over browser storage.
 * @returns the book.
 */
export function memoryBook(): WorkspaceSearchPreferenceBook {
  return createSearchPreferenceBook(createSnapshotStore<unknown>({}))
}
