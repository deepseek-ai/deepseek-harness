/** Pure search-card derivation from raw grep/glob result metadata. @module */
import type { SearchBlockProps, SearchFileGroup } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallBlock } from './tool-call-model.ts'
import { parsedToolCall } from './raw-tool-call.ts'

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

/** The {@link SearchBlockProps} union minus each render site's own fields. */
type SearchBlockModelProps = DistributiveOmit<SearchBlockProps, 'labels' | 'maxLines' | 'className'>

/** Result rows retained in a Chat card before its middle collapses. */
export const CHAT_SEARCH_MAX_LINES = 8

/** Search-card props plus an optional locator for a capped full result. */
export interface SearchCardModel {
  /** Props consumed by {@link SearchBlock}. */
  card: SearchBlockModelProps
  /** Raw result text containing the full-result locator for a capped search. */
  recovery: string | undefined
}

function validSearchCall(block: ToolCallBlock): 'grep' | 'glob' | null {
  const call = parsedToolCall(block)
  if (call === null) return null
  const { pattern, path } = call.args
  if (typeof pattern !== 'string') return null
  if (call.name === 'grep' && pattern === '') return null
  if (call.name === 'glob' && pattern.trim() === '') return null
  if (call.name !== 'grep' && call.name !== 'glob') return null
  if (path !== undefined && (typeof path !== 'string' || path.trim() === '')) return null
  if (call.name === 'grep') {
    const { include } = call.args
    if (include !== undefined && include !== '' && (typeof include !== 'string' || !validInclude(include))) return null
  }
  return call.name
}

function validInclude(include: string): boolean {
  if (include.trim() === '' || include.startsWith('!')) return false
  let braceDepth = 0
  for (const character of include) {
    if (character === '{') braceDepth += 1
    else if (character === '}') braceDepth = Math.max(0, braceDepth - 1)
    else if (character === ',' && braceDepth === 0) return false
  }
  return true
}

function searchFiles(value: unknown): SearchFileGroup[] | null {
  if (!Array.isArray(value)) return null
  const files: SearchFileGroup[] = []
  for (const file of value) {
    if (typeof file !== 'object' || file === null || Array.isArray(file)) return null
    const { path, matches } = file as Record<string, unknown>
    if (typeof path !== 'string' || !Array.isArray(matches)) return null
    const narrowed: { lineNumber: number; line: string }[] = []
    for (const match of matches) {
      if (typeof match !== 'object' || match === null || Array.isArray(match)) return null
      const { lineNumber, line } = match as Record<string, unknown>
      if (typeof lineNumber !== 'number' || !Number.isInteger(lineNumber) || lineNumber < 1) return null
      if (typeof line !== 'string') return null
      narrowed.push({ lineNumber, line })
    }
    files.push({ path, matches: narrowed })
  }
  return files
}

function flattenContent(content: readonly { type: string; text?: string }[]): string | undefined {
  const text = content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
  return text === '' ? undefined : text
}

/**
 * Derive a settled root grep/glob card from persisted metadata.
 * @param block - running or settled Tool block.
 * @returns search-card props, or null for the generic path.
 */
export function searchCardModel(block: ToolCallBlock): SearchCardModel | null {
  if (block.parentCallId !== undefined || !('kind' in block) || block.isError) return null
  const tool = validSearchCall(block)
  if (tool === null) return null
  if (typeof block.meta !== 'object' || block.meta === null || Array.isArray(block.meta)) return null
  const meta = block.meta as Record<string, unknown>
  if (typeof meta.truncated !== 'boolean') return null
  if (typeof meta.total !== 'number' || !Number.isInteger(meta.total) || meta.total < 0) return null
  const common = { truncated: meta.truncated, total: meta.total }
  const recovery = meta.truncated ? flattenContent(block.content) : undefined
  if (tool === 'grep') {
    if (meta.shape !== 'matches') return null
    const files = searchFiles(meta.files)
    return files === null ? null : { recovery, card: { kind: 'matches', files, ...common } }
  }
  if (meta.shape !== 'paths' || !Array.isArray(meta.paths)) return null
  if (!meta.paths.every((path): path is string => typeof path === 'string')) return null
  return { recovery, card: { kind: 'paths', paths: [...meta.paths], ...common } }
}
