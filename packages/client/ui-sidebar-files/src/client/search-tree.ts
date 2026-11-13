/**
 * The search results drawn as a tree, and the highlights in its names.
 *
 * A search answers with the workspace-relative paths of its matches, and not
 * necessarily with their ancestors. The tree the navigator draws
 * needs every level from the root down, so this module synthesizes the levels
 * the results pass through, keyed by absolute path as the listed tree keys them.
 */
import { childPath } from './store.ts'
import type { DirLevel, FilesTreeState } from './store.ts'

/** One entry a search matched. */
export interface SearchMatch {
  /** `/`-separated path relative to the workspace root, without leading or trailing `/`. */
  readonly path: string
  /** Whether the entry is a file, a directory, or something else. */
  readonly type: DirLevel['entries'][number]['type']
}

/**
 * Draw search results as a fully expanded tree.
 *
 * Every directory the results pass through gets a ready level: the root, each
 * result's ancestors, and each result that is itself a directory. A level lists
 * the children the results put there, once each, in first-seen order; a name
 * that is an ancestor anywhere is a directory. A directory that matched but
 * holds no matching descendant has a level with no entries, which the
 * navigator draws differently from an empty listed directory. Every level is
 * expanded, no level is truncated, and the tree does not refresh itself.
 * @param root - absolute path of the workspace root, as `FilesTreeState.root` holds it.
 * @param entries - the search's entries.
 * @returns the tree to draw.
 */
export function buildSearchTree(root: string, entries: readonly SearchMatch[]): FilesTreeState {
  type Names = Map<string, SearchMatch['type']>
  const children = new Map<string, Names>([[root, new Map()]])
  const directory = (path: string): Names => {
    const names = children.get(path) ?? new Map<string, SearchMatch['type']>()
    children.set(path, names)
    return names
  }
  for (const entry of entries) {
    const parts = entry.path.split('/')
    let parent = root
    for (const [index, name] of parts.entries()) {
      const type = index === parts.length - 1 ? entry.type : 'directory'
      const names = directory(parent)
      if (type === 'directory' || !names.has(name)) names.set(name, type)
      parent = childPath(parent, name)
      if (type === 'directory') directory(parent)
    }
  }
  const levels: FilesTreeState['levels'] = {}
  for (const [path, names] of children) {
    const level: DirLevel = { entries: [...names].map(([name, type]) => ({ name, type })), truncated: false }
    levels[path] = { kind: 'ready', level }
  }
  return { autoRefresh: false, root, levels, expanded: [...children.keys()] }
}

/**
 * Where the query occurs in one name, for highlighting.
 *
 * Matching ignores case by Unicode simple case folding; the ranges index the
 * name as given. An empty query has no occurrence.
 * @param name - the drawn name.
 * @param query - the search text.
 * @returns non-overlapping `[start, end)` UTF-16 ranges, left to right.
 */
export function matchRanges(name: string, query: string): readonly (readonly [number, number])[] {
  if (query === '') return []
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
  return [...name.matchAll(pattern)].map(match => [match.index, match.index + match[0].length] as const)
}
