/**
 * The workspace search, bound to the Host's `workspaceFiles.search` call.
 *
 * The Host walks the whole workspace of the Session and applies the query,
 * the exclusion rules, the hidden-entry choice, and `.gitignore`; the Client
 * only draws the matches it returns.
 */
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SearchMatch } from './search-tree.ts'

/** What one search asks the Host for. */
export interface WorkspaceSearchRequest {
  /** The query without surrounding whitespace; never empty. */
  readonly query: string
  /** The paths of the enabled exclusion rules, in list order, as `search-rules.ts` defines them. */
  readonly excludedPaths: readonly string[]
  /** Whether hidden entries may match: names starting with `.`, and on a Windows Host also entries with the hidden file attribute. */
  readonly includeHidden: boolean
  /** Whether entries the workspace's `.gitignore` files ignore are left out. */
  readonly respectGitignore: boolean
}

/** One settled search's matches. */
export interface WorkspaceSearchAnswer {
  /** The matches, in the Host's order. */
  readonly matches: readonly SearchMatch[]
  /** The Host returned only its first matches because more matched than it returns. */
  readonly truncated: boolean
  /**
   * Part of the workspace was not searched: the Host's search passed its file
   * limit, or a directory could not be read.
   */
  readonly incomplete: boolean
}

/**
 * One workspace search. The session travels with the call because the Host
 * resolves the workspace root from it. A failure settles the result's error
 * branch; aborting `signal` lets the caller drop the answer.
 * @param sessionId - Session whose workspace is searched.
 * @param request - the query and the preferences it follows.
 * @param signal - the search's lifetime; the face aborts it when a newer search or the end of the search replaces it.
 * @returns the matches, or why the Host could not search.
 */
export type SearchWorkspace = (
  sessionId: SessionId,
  request: WorkspaceSearchRequest,
  signal: AbortSignal,
) => Promise<RemoteResult<WorkspaceSearchAnswer>>

/**
 * The slice of the Client Remote face the search calls: the `workspaceFiles`
 * namespace's `search`, exactly as the Host's generated client declares it.
 */
export type WorkspaceFilesSearchRemote = {
  readonly workspaceFiles: Pick<ClientRemote['workspaceFiles'], 'search'>
}

/**
 * Bind the workspace search to one Remote face.
 * @param remote - the Client Remote face carrying the `workspaceFiles` namespace.
 * @returns the search the tree's face performs.
 */
export function createSearch(remote: WorkspaceFilesSearchRemote): SearchWorkspace {
  return (sessionId, request, signal) => remote.workspaceFiles.search(sessionId, request, signal)
}
