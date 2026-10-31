/** Pure patch call previews and known applied diff metadata for Host and Web replay. */
import { parsePatch, PatchParseError } from '@deepseek-ai/dsh-fs-patch'
import type { DiffCallView, DiffResultView, FileDiff, ToolResult } from '@deepseek-ai/dsh-tools'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { diffsFromMeta, stoppedFromMeta } from './diff.ts'

/**
 * Preview the requested operations without resolving paths or reading the filesystem.
 * A deletion has no diff text to preview and appears only among the locations.
 * @param patch - raw patch argument.
 * @returns a diff call view, or undefined when syntax is invalid.
 */
export function presentPatchCall(patch: string): DiffCallView | undefined {
  let operations
  try { operations = parsePatch(patch) } catch (error) {
    if (!(error instanceof PatchParseError)) throw error
    return undefined
  }
  const diffs = operations.flatMap((operation): FileDiff[] => {
    const path = operation.path
    switch (operation.kind) {
      case 'add': return [{ path, oldText: null, newText: operation.content }]
      case 'delete': return []
      case 'update': return [{ path, oldText: operation.hunks.flatMap(hunk => hunk.oldLines).join('\n') || null,
        newText: operation.hunks.flatMap(hunk => hunk.newLines).join('\n') }]
      /* v8 ignore next -- Exhaustive closed parser union. */
      default: return assertNever(operation)
    }
  })
  const paths = new Set(operations.flatMap(operation =>
    operation.kind === 'update' && operation.moveTo !== undefined ? [operation.path, operation.moveTo] : [operation.path]))
  return { card: 'diff', title: `Apply patch (${paths.size} ${paths.size === 1 ? 'file' : 'files'})`, diffs,
    locations: [...paths].map(path => ({ path })),
  }
}

/**
 * Present applied metadata; failed or missing metadata uses generic result rendering.
 * @param result - live or replayed tool result.
 * @returns known applied hunks with a stopped title where appropriate.
 */
export function presentPatchResult(result: ToolResult): DiffResultView | undefined {
  if (result.isError) return undefined
  const diffs = diffsFromMeta(result.meta)
  if (diffs === undefined) return undefined
  return { card: 'diff', title: stoppedFromMeta(result.meta) ? 'Apply patch (stopped)' : 'Apply patch', diffs }
}
