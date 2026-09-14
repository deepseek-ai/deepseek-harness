/** Pure read-card derivation from raw result content and metadata. @module */
import type { ReadBlockLine, ReadBlockProps } from '@deepseek-ai/dsh-client-ui-primitives'
import { abbreviateHomePath, relativizeToCwd } from '@deepseek-ai/dsh-util-workspace-path'
import type { ToolCallBlock } from './tool-call-model.ts'
import { parsedToolCall, singleResultText } from './raw-tool-call.ts'

/**
 * Content lines the chat row's resident read body shows before collapsing the
 * middle — half the primitive's own default, which the details panel keeps. A
 * chat row is a summary surface inside the message flow: the flow must stay
 * scannable across many calls, while the details panel is the single-call
 * reading surface. A design constant of this UI's row geometry, not a
 * deployment choice, so it is fixed here rather than a plugin Config field. The
 * same split [`CHAT_TERMINAL_MAX_LINES`](./terminal-card-model.ts) draws for
 * terminal output.
 */
export const CHAT_READ_MAX_LINES = 8

/**
 * The {@link ReadBlock} props this derivation owns. Picked off the primitive's
 * props so the two stay in step; `maxLines`/`className` belong to each render
 * site.
 */
export type ReadCardModel = Pick<ReadBlockProps, 'label' | 'lines' | 'totalLines' | 'lang'>

interface ReadMeta {
  path: string
  offset: number
  lines: ReadBlockLine[]
  totalLines: number
  lang?: string
}

/** Whether a model-supplied argument is a 1-based line position or count: an integer of at least 1. */
function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

function validReadCall(block: ToolCallBlock): boolean {
  const call = parsedToolCall(block)
  if (call?.name !== 'read') return false
  const { file_path: path, offset, limit } = call.args
  if (typeof path !== 'string' || path.trim() === '') return false
  if (offset !== undefined && !positiveInteger(offset)) return false
  if (limit !== undefined && !positiveInteger(limit)) return false
  return true
}

function readMeta(meta: unknown): ReadMeta | null {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null
  const { path, offset, lines, totalLines, lang } = meta as Record<string, unknown>
  if (typeof path !== 'string' || typeof offset !== 'number' || !Number.isInteger(offset) || offset < 1) return null
  if (typeof totalLines !== 'number' || !Number.isInteger(totalLines) || totalLines < 0 || !Array.isArray(lines)) return null
  if (lang !== undefined && typeof lang !== 'string') return null
  const narrowed: ReadBlockLine[] = []
  let previous = offset - 1
  for (const line of lines) {
    if (typeof line !== 'object' || line === null || Array.isArray(line)) return null
    const { number, text } = line as Record<string, unknown>
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || number <= previous) return null
    if (number > totalLines || typeof text !== 'string') return null
    previous = number
    narrowed.push({ number, text })
  }
  return {
    path,
    offset,
    lines: narrowed,
    totalLines,
    ...lang === undefined ? {} : { lang },
  }
}

/**
 * The line one `read` call was about, from its arguments.
 *
 * `offset` is the read tool's own 1-based start line, so opening the path can
 * land where the model looked. Available while the call is still running,
 * unlike the persisted metadata, because the arguments carry it. The arguments
 * are model-produced JSON: only an integer of at least 1 is a line, and a call
 * whose `offset` is anything else names none.
 * @param block - running or settled Tool block.
 * @returns the 1-based line, or undefined when the call named none.
 */
export function readCallLine(block: ToolCallBlock): number | undefined {
  if (!validReadCall(block)) return undefined
  const { offset } = parsedToolCall(block)?.args ?? {}
  return positiveInteger(offset) ? offset : undefined
}

/**
 * Derive a settled root read card after validating its persisted metadata and
 * model-facing read envelope.
 * @param block - running or settled Tool block.
 * @param sessionCwd - the session workspace root; a workspace-rooted absolute
 *   path label displays relative to it. Absent leaves the path as authored.
 * @param home - host account home; a leftover POSIX home path displays as `~`.
 * @returns the read-card props, or null for the generic path.
 */
export function readCardModel(
  block: ToolCallBlock,
  sessionCwd?: string,
  home?: string,
): ReadCardModel | null {
  if (block.parentCallId !== undefined || !('kind' in block) || block.isError) return null
  if (!validReadCall(block)) return null
  const meta = readMeta(block.meta)
  if (meta === null) return null
  const text = singleResultText(block)
  if (text === undefined) return null
  const body = /^<path>[^\n]*<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/u.exec(text)?.[1]
  if (body === undefined) return null
  return {
    label: abbreviateHomePath(relativizeToCwd(meta.path, sessionCwd), home),
    lines: meta.lines,
    totalLines: meta.totalLines,
    lang: meta.lang,
  }
}
