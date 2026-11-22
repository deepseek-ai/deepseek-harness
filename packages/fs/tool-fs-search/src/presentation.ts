/**
 * Result-time search-card presentation for `grep` and `glob`. Both tools land on
 * one `card: 'search'` render intent ({@link SearchResultView}) with two
 * `shape`-discriminated variants: `grep` projects its matches grouped by file
 * ({@link SearchMatchesResultView}), `glob` projects a flat path list
 * ({@link SearchPathsResultView}). This module owns the value→`presentationMeta`
 * projection each tool declares and the defensive `meta`→view narrowing each
 * tool's `presentResult` reads back on replay.
 *
 * The canonical value never crosses the wire — only the model-facing render text
 * and this JSON `meta` do — so the structured shape a UI renders MUST ride in
 * `meta`. Each projection consumes the SAME retained matches/paths the
 * model-facing render consumes ({@link module:@deepseek-ai/dsh-tool-fs-search/search-core}
 * `retainGrepMatches`/`retainGlobPaths`), so text and card agree about which
 * results survived the inline cap, and reports `total` (every result found) and
 * `truncated`, so a UI never presents a capped result as complete.
 *
 * A second, independent cap bounds the JSON `meta` itself: the retained matches
 * of a broad search (hundreds of long lines) can still serialize to hundreds of
 * kilobytes, and `meta` is persisted with the session log and re-sent on every
 * request. {@link capMetaBytes} drops trailing groups/paths until the serialized
 * `meta` fits `maxMetaBytes` and marks the result `truncated`; a deployment's
 * final output budget (`dsh-spill-policy`) only shrinks `content`, never `meta`,
 * so this projection owns keeping `meta` bounded.
 *
 * @module @deepseek-ai/dsh-tool-fs-search/presentation
 */

import type {
  SearchFileMatches,
  SearchLineMatch,
  SearchResultView,
} from '@deepseek-ai/dsh-tools'
import type { RetainedItems } from '@deepseek-ai/dsh-output-retention'
import type { GrepMatch } from './search-core.ts'

/**
 * The retention fields a meta projection reads: the retained page, whether the
 * complete result was capped, and the pre-cap total. Both a full
 * {@link RetainedItems} (from `retainGrepMatches`) and `glob`'s sampled page
 * satisfy this structural subset, so a projection consumes either without a fake
 * `kept`/`omitted`.
 */
type RetainedPage<T> = Pick<RetainedItems<T>, 'items' | 'truncated' | 'seen'>

/**
 * The `grep`/`glob` tools' private `tool/result` `meta` payload: the capped,
 * structured search result. Attached opaquely (as `JsonValue`) on the tool result
 * and persisted with the session log, so `presentResult` reproduces the search
 * card on replay. The `matches` shape carries the by-file groups; the `paths`
 * shape carries the flat list. Both carry the pre-cap `total` and the `truncated`
 * flag. The producing tool owns and narrows this opaque shape.
 *
 * The member shapes use object-literal `type` aliases rather than the
 * {@link SearchFileMatches}/{@link SearchLineMatch} interfaces because only a type
 * alias is assignable to the `JsonValue` index signature `presentationMeta`
 * returns; the two are structurally identical, so the projected value still reads
 * back as a {@link SearchResultView}.
 */
export type SearchMeta =
  | { shape: 'matches'; files: MetaFileMatches[]; truncated: boolean; total: number }
  | { shape: 'paths'; paths: string[]; truncated: boolean; total: number }

/** One matched line in {@link SearchMeta} (the JSON-assignable form of {@link SearchLineMatch}). */
type MetaLineMatch = { lineNumber: number; line: string }

/** One file's grouped matches in {@link SearchMeta} (the JSON-assignable form of {@link SearchFileMatches}). */
type MetaFileMatches = { path: string; matches: MetaLineMatch[] }

/**
 * Group flat matches by file (first-seen order) into the structured by-file shape
 * a UI renders as expandable per-file groups. The grouping matches the
 * model-facing text grouping
 * ({@link module:@deepseek-ai/dsh-tool-fs-search/grep} `formatGrepMatches`), so
 * card and text agree about file order and membership.
 *
 * @param matches - the retained matches to group, in output order.
 * @returns one entry per file, in first-seen order.
 */
export function groupMatchesByFile(matches: GrepMatch[]): MetaFileMatches[] {
  const byFile = new Map<string, MetaLineMatch[]>()
  for (const match of matches) {
    const entry: MetaLineMatch = { lineNumber: match.lineNumber, line: match.line }
    const group = byFile.get(match.path)
    if (group !== undefined) group.push(entry)
    else byFile.set(match.path, [entry])
  }
  return Array.from(byFile, ([path, fileMatches]) => ({ path, matches: fileMatches }))
}

/** The serialized UTF-8 byte size of one meta payload (the size persisted and re-sent). */
function metaBytes(meta: SearchMeta): number {
  return Buffer.byteLength(JSON.stringify(meta), 'utf8')
}

/**
 * Drop trailing top-level items (file groups or paths) until the serialized meta
 * fits `maxMetaBytes`, marking the result `truncated` when anything was dropped.
 * `total` is preserved (it counts what the search found, not what meta retains).
 * A single item too large to fit on its own is kept: the invariant is a bounded
 * payload wherever droppable, never an empty card that hides a real result.
 *
 * @param meta - the projected meta, already capped to the inline item count.
 * @param maxMetaBytes - the serialized-meta byte budget.
 * @returns the same meta when it fits, else a byte-bounded copy marked `truncated`.
 */
function capMetaBytes(meta: SearchMeta, maxMetaBytes: number): SearchMeta {
  if (metaBytes(meta) <= maxMetaBytes) return meta
  if (meta.shape === 'matches') {
    const files = [...meta.files]
    while (files.length > 1 && metaBytes({ ...meta, files, truncated: true }) > maxMetaBytes) files.pop()
    return { ...meta, files, truncated: true }
  }
  const paths = [...meta.paths]
  while (paths.length > 1 && metaBytes({ ...meta, paths, truncated: true }) > maxMetaBytes) paths.pop()
  return { ...meta, paths, truncated: true }
}

/**
 * Project the retained `grep` matches into {@link SearchMeta} for the search
 * card. Consumes the same {@link RetainedItems} the model-facing render consumes
 * (preview budget and inline match cap already applied), groups the retained
 * matches by file, reports `total` (every parsed match) and `truncated`, then
 * bounds the serialized meta to `maxMetaBytes`.
 *
 * @param retained - the retention outcome over every parsed match (previewed, capped).
 * @param maxMetaBytes - the serialized-meta byte budget.
 * @returns the `matches`-shaped search metadata.
 */
export function grepSearchMeta(retained: RetainedPage<GrepMatch>, maxMetaBytes: number): SearchMeta {
  const meta: SearchMeta = {
    shape: 'matches',
    files: groupMatchesByFile(retained.items),
    truncated: retained.truncated,
    total: retained.seen,
  }
  return capMetaBytes(meta, maxMetaBytes)
}

// Glob paths are V8 substrings of ripgrep's whole stdout, and the Session keeps `meta` for its
// lifetime. A UTF-16LE round trip copies each path so the stdout string can be garbage-collected.
function detachText(text: string): string {
  return Buffer.from(text, 'utf16le').toString('utf16le')
}

/**
 * Project the retained `glob` paths into {@link SearchMeta} for the search card.
 * Consumes the same {@link RetainedItems} the model-facing render consumes (inline
 * path cap already applied), reports `total` (every discovered path) and
 * `truncated`, then bounds the serialized meta to `maxMetaBytes`. Returned paths hold no reference
 * to the strings in `retained`.
 *
 * @param retained - the retention outcome over every discovered path (capped).
 * @param maxMetaBytes - the serialized-meta byte budget.
 * @returns the `paths`-shaped search metadata.
 */
export function globSearchMeta(retained: RetainedPage<string>, maxMetaBytes: number): SearchMeta {
  const meta: SearchMeta = {
    shape: 'paths',
    paths: retained.items.map(detachText),
    truncated: retained.truncated,
    total: retained.seen,
  }
  return capMetaBytes(meta, maxMetaBytes)
}

/** Whether `value` is a valid {@link SearchLineMatch} (defensive narrowing from opaque `meta`). */
function isSearchLineMatch(value: unknown): value is SearchLineMatch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { lineNumber, line } = value as Record<string, unknown>
  return typeof lineNumber === 'number' && typeof line === 'string'
}

/** Whether `value` is a valid {@link SearchFileMatches} (defensive narrowing from opaque `meta`). */
function isSearchFileMatches(value: unknown): value is SearchFileMatches {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { path, matches } = value as Record<string, unknown>
  return typeof path === 'string' && Array.isArray(matches) && matches.every(isSearchLineMatch)
}

/**
 * Narrow opaque live or replayed result metadata to a {@link SearchResultView}.
 * Malformed metadata returns `undefined` so `presentResult` can fall back to the
 * generic card instead of throwing during replay of an older or hand-edited log.
 * The view carries no result text: a UI without a search card falls back to the
 * raw `tool/result` content.
 *
 * A zero-result meta (`files: []` / `paths: []`) narrows to a valid empty card —
 * unlike the mirrored `diffsFromMeta`, which rejects empty diffs, because a
 * zero-match grep is a legitimate result a UI shows as "no matches", not an
 * absent projection.
 *
 * @param meta - result metadata (the {@link SearchMeta} the tool projected).
 * @returns the search view, or `undefined` for absent or malformed metadata.
 */
export function searchViewFromMeta(meta: unknown): SearchResultView | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const record = meta as Record<string, unknown>
  const { truncated, total } = record
  if (typeof truncated !== 'boolean' || typeof total !== 'number') return undefined
  if (record.shape === 'matches') {
    const { files } = record
    if (!Array.isArray(files) || !files.every(isSearchFileMatches)) return undefined
    return { card: 'search', shape: 'matches', files: files, truncated, total }
  }
  if (record.shape === 'paths') {
    const { paths } = record
    if (!Array.isArray(paths) || !paths.every((path): path is string => typeof path === 'string')) return undefined
    return { card: 'search', shape: 'paths', paths, truncated, total }
  }
  return undefined
}
