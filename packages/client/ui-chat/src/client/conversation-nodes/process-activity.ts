/** Tool-category and live-detail interpretation owned by Chat grouping. */
import type { ToolArgs } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ProcessActivity, ProcessActivitySummary } from '../contract/process-groups.ts'
import type { ChatNode } from '../contract/chat-nodes.ts'
import { isRunningTool } from '../contract/chat-nodes.ts'
import type { ToolCallBlock } from '../contract/snapshot.ts'

function activity(name: string): ProcessActivity {
  if (name === 'read') return 'read'
  if (name === 'read_image') return 'readImage'
  if (name === 'grep' || name === 'glob' || name.endsWith('_inspect')) return 'search'
  if (name === 'write') return 'write'
  if (name === 'edit' || name === 'apply_patch') return 'edit'
  if (['bash', 'pwsh', 'exec_command', 'write_stdin'].includes(name) || name.startsWith('terminal_')) return 'commands'
  if (name === 'run_code') return 'code'
  if (name === 'web_search') return 'webSearch'
  if (name === 'web_fetch') return 'webFetch'
  if (name === 'subagent' || name.startsWith('subagent_')) return 'subagents'
  if (['todo_write', 'create_goal', 'update_goal', 'get_goal'].includes(name)) return 'plan'
  if (name === 'ask_user_question' || name === 'request_user_input') return 'questions'
  return 'tools'
}

const LIVE_TOOL_DETAIL_MAX_CHARS = 160
const LIVE_TOOL_DETAIL_PREFIX_CHARS = 512
const LIVE_TOOL_DETAIL_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const LIVE_TOOL_DETAIL_KEYS = [
  'title', 'description', 'objective', 'task', 'task_name', 'name', 'question', 'questions', 'prompt', 'message',
  'command', 'cmd', 'queries', 'query', 'pattern', 'url', 'uri', 'file_path', 'path', 'target', 'action', 'status',
] as const

interface NormalizedDetail {
  readonly text: string
  readonly truncated: boolean
}

function normalizeLiveToolText(text: string): NormalizedDetail {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= LIVE_TOOL_DETAIL_MAX_CHARS) return { text: normalized, truncated: false }
  const chars: string[] = []
  for (const { segment } of LIVE_TOOL_DETAIL_SEGMENTER.segment(normalized)) {
    if (chars.length === LIVE_TOOL_DETAIL_MAX_CHARS) {
      return {
        text: `${chars.slice(0, LIVE_TOOL_DETAIL_MAX_CHARS - 1).join('').trimEnd()}…`,
        truncated: true,
      }
    }
    chars.push(segment)
  }
  return { text: normalized, truncated: false }
}

function normalizeLiveToolDetail(value: unknown): string {
  const text = typeof value === 'string'
    ? value
    : Array.isArray(value) && value.every(item => typeof item === 'string')
      ? value.join(', ')
      : ''
  return normalizeLiveToolText(text).text
}

function argumentTextDetail(args: ToolArgs, key: string): string | undefined {
  let limit = LIVE_TOOL_DETAIL_PREFIX_CHARS
  while (true) {
    let prefix = args.textPrefix(key, limit)
    if (prefix === undefined) return undefined
    const last = prefix.charCodeAt(prefix.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) {
      // The extra prefix read also observes a low surrogate arriving in a later delta.
      const extended = args.textPrefix(key, limit + 1) as string
      const next = extended.charCodeAt(prefix.length)
      if (next >= 0xdc00 && next <= 0xdfff) {
        prefix = extended
        limit++
      } else if (extended.length === prefix.length && !args.isSealed && !args.complete(key)) {
        prefix = prefix.slice(0, -1)
      }
    }
    const detail = normalizeLiveToolText(prefix)
    if (detail.truncated || !args.stringExceeds(key, limit)) return detail.text
    limit *= 2
  }
}

function questionDetail(value: unknown): string {
  if (!Array.isArray(value)) return ''
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const detail = normalizeLiveToolDetail(Reflect.get(item, 'question'))
    if (detail !== '') return detail
  }
  return ''
}

function liveReasoningDetail(nodes: readonly ChatNode[]): string {
  for (let nodeIndex = nodes.length - 1; nodeIndex >= 0; nodeIndex--) {
    const node = nodes[nodeIndex]
    if (node?.kind !== 'assistant-step' || node.data.status !== 'running') continue
    for (let blockIndex = node.data.blocks.length - 1; blockIndex >= 0; blockIndex--) {
      const block = node.data.blocks[blockIndex]
      if (block?.kind !== 'reasoning') continue
      const paragraphs = block.text.split(/\r?\n[\t ]*\r?\n/)
      for (let paragraphIndex = paragraphs.length - 1; paragraphIndex >= 0; paragraphIndex--) {
        const detail = normalizeLiveToolDetail(paragraphs[paragraphIndex]?.replaceAll('**', ''))
        if (detail !== '') return detail
      }
    }
  }
  return ''
}

/**
 * One-line task detail from the argument view, read the same way while the
 * arguments stream and after dispatch: the first detail key present with text
 * so far or a closed value. Without one, the tool name stands in once no further
 * field can arrive; a field still to come is not named early.
 */
function liveToolDetail(name: string, args: ToolArgs): string {
  for (const key of LIVE_TOOL_DETAIL_KEYS) {
    if (!args.has(key)) continue
    const detail = key === 'questions'
      ? questionDetail(args.value(key))
      : argumentTextDetail(args, key) ?? normalizeLiveToolDetail(args.value(key))
    if (detail !== '') return detail
  }
  return args.closed() ? normalizeLiveToolDetail(name) : ''
}

/**
 * Rank categories by distinct call count, breaking ties by first appearance.
 * @param nodes - process members, including recursive tools.
 * @returns all ranked categories and the latest running tool category and bounded task detail.
 */
export function processActivity(nodes: readonly ChatNode[]): ProcessActivitySummary {
  const counts = new Map<ProcessActivity, number>()
  const seen = new Set<string>()
  let running: ProcessActivity | undefined
  let runningDetail = ''
  let runningTime = -Infinity
  let preparing: boolean | undefined
  const visit = (tool: ToolCallBlock): void => {
    if (seen.has(tool.callId)) return
    seen.add(tool.callId)
    const call = isRunningTool(tool) ? tool : tool.call
    if (call !== null) {
      const kind = activity(call.name)
      if (isRunningTool(tool) && tool.time >= runningTime) {
        running = kind
        preparing = tool.phase === 'preparing'
        runningDetail = liveToolDetail(tool.name, tool.args)
        runningTime = tool.time
      }
      counts.set(kind, (counts.get(kind) ?? 0) + 1)
    }
    for (const child of tool.subCalls) visit(child)
  }
  for (const node of nodes) {
    if (node.kind === 'tool-call') visit(node.data.root)
  }
  if (running === undefined) runningDetail = liveReasoningDetail(nodes)
  return {
    counts: [...counts].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
    running,
    runningDetail,
    ...preparing ? { preparing: true } : {},
  }
}
