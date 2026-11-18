/**
 * Pure backend converter for one complete committed Session log. The Session
 * Markdown copy Host route uses it, and the package entry exports it for
 * callers that already hold the logical events. The raw log is authoritative:
 * compaction surface replacements never remove earlier messages, and
 * fork-inherited history appears once. Reasoning, system and developer
 * messages, injected non-human context, request headers, and runtime records
 * are omitted.
 * @module
 */

import type {
  AssistantMessage,
  SessionEvent,
  ToolResultMessage,
  UserMessage,
} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** Heading used when the log carries no title and the Session has no name. */
const UNTITLED_SESSION_MARKDOWN_TITLE = 'Untitled Session'

interface AssistantEntry {
  readonly kind: 'assistant'
  readonly text: string
  readonly toolCalls: boolean
}

interface ToolEntry {
  readonly kind: 'tool'
  readonly name: string
  readonly arguments: string
  result: ToolResult | undefined
}

interface ToolResult {
  readonly text: string
  readonly isError: boolean
  readonly reason: string | undefined
}

interface UserSegment {
  readonly kind: 'user'
  readonly text: string
}

type TurnEntry = AssistantEntry | ToolEntry
type TurnSegment = UserSegment | TurnEntry

interface Turn {
  readonly segments: TurnSegment[]
  readonly calls: Map<string, ToolEntry>
}

/**
 * Render one complete committed Session log as Markdown. This is a pure backend
 * utility: it needs no mounted plugin, reads no storage, and does not mutate the
 * supplied events. The latest `session/title` event supplies the heading; the
 * rest of the transcript is derived only from the supplied logical events.
 * @param events - complete committed logical event snapshot in seq order, including any inherited prefix.
 * @param sourcePath - optional backend-resolved path to the selected Session artifact; emitted verbatim in a fenced text block.
 * @returns Markdown ending in exactly one newline; an empty log returns the heading and optional source metadata only.
 */
export function formatSessionMarkdown(events: readonly SessionEvent[], sourcePath?: string): string {
  const title = events.findLast(event => event.type === 'session/title')?.data.title
  const sections = [`# ${normalizedTitle(title)}`]
  if (sourcePath !== undefined && sourcePath !== '') {
    sections.push(`Session file:

${fenced(sourcePath, 'text', false)}`)
  }
  for (const turn of collectTurns(events)) {
    const finalIndex = finalReplyIndex(turn.segments)
    const end = finalIndex < 0 ? turn.segments.length : finalIndex
    let pending: TurnEntry[] = []
    for (const segment of turn.segments.slice(0, end)) {
      if (segment.kind === 'user') {
        if (pending.length > 0) {
          sections.push(collapsibleSection(pending))
          pending = []
        }
        sections.push(quote(segment.text))
      } else {
        pending.push(segment)
      }
    }
    if (pending.length > 0) sections.push(collapsibleSection(pending))
    const final = turn.segments[finalIndex]
    const finalText = final?.kind === 'assistant'
      ? closeUnfinishedFence(trimBlankEdgeLines(final.text))
      : ''
    if (finalText !== '') sections.push(finalText)
  }
  return `${sections.join('\n\n').trimEnd()}\n`
}

function normalizedTitle(title: string | undefined): string {
  const line = title?.replace(/\r\n?|\n/gu, ' ').trim() ?? ''
  return line === '' ? UNTITLED_SESSION_MARKDOWN_TITLE : line
}

function collectTurns(events: readonly SessionEvent[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn | undefined
  const begin = (): Turn => {
    current = { segments: [], calls: new Map() }
    turns.push(current)
    return current
  }
  const active = (): Turn => current ?? begin()
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        begin()
        break
      case 'turn/end':
        current = undefined
        break
      case 'user/message': {
        if (event.surfaceOp !== 'append' || event.data.source.kind !== 'user') break
        const text = visibleContent(event.data.content)
        if (text !== '') active().segments.push({ kind: 'user', text })
        break
      }
      case 'assistant/message': {
        if (event.surfaceOp !== 'append') break
        const message = event.data.message
        const text = assistantText(message)
        const toolCalls = message.content.some(block => block.type === 'tool-call')
        if (trimBlankEdgeLines(text) !== '') active().segments.push({ kind: 'assistant', text, toolCalls })
        break
      }
      case 'tool/call': {
        const turn = active()
        const entry: ToolEntry = {
          kind: 'tool',
          name: event.data.name,
          arguments: event.data.arguments,
          result: undefined,
        }
        turn.segments.push(entry)
        turn.calls.set(String(event.data.callId), entry)
        break
      }
      case 'tool/result': {
        if (event.surfaceOp !== 'append') break
        const turn = active()
        const callId = String(event.data.message.toolCallId)
        let entry = turn.calls.get(callId)
        if (entry === undefined) {
          entry = { kind: 'tool', name: 'unknown', arguments: '', result: undefined }
          turn.segments.push(entry)
          turn.calls.set(callId, entry)
        }
        entry.result = toolResult(event.data)
        break
      }
      default:
        break
    }
  }
  return turns.filter(turn => turn.segments.length > 0)
}

function finalReplyIndex(segments: readonly TurnSegment[]): number {
  const index = segments.length - 1
  const entry = segments[index]
  return entry?.kind === 'assistant' && !entry.toolCalls ? index : -1
}

function collapsibleSection(entries: readonly TurnEntry[]): string {
  const summary = entries.length === 1 ? '1 previous message' : `${String(entries.length)} previous messages`
  const body = entries.map(renderEntry).join('\n\n')
  return `<details><summary>${summary}</summary>\n\n${body}\n\n</details>`
}

function renderEntry(entry: TurnEntry): string {
  if (entry.kind === 'assistant') {
    const text = escapeWrapperTagsOutsideFences(
      closeUnfinishedFence(trimBlankEdgeLines(entry.text)),
    )
    return `**Assistant**\n\n${text}`
  }
  const heading = `**Tool: \`${escapeWrapperTags(entry.name)}\`**`
  const argumentsText = entry.arguments === ''
    ? '(no arguments)'
    : fenced(jsonArguments(entry.arguments), 'json')
  const result = entry.result
  const resultHeading = result?.isError === true ? '**Result (error)**' : '**Result**'
  let resultBody = ''
  if (result === undefined) {
    resultBody = '(no result recorded)'
  } else if (result.reason !== undefined && result.reason !== '') {
    resultBody = `Error: ${escapeWrapperTags(result.reason)}`
    if (result.text !== '') resultBody += `\n\n${fenced(result.text)}`
  } else if (result.text === '') {
    resultBody = '(no output)'
  } else {
    resultBody = fenced(result.text)
  }
  return `${heading}\n\n${argumentsText}\n\n${resultHeading}\n\n${resultBody}`
}

function visibleContent(content: UserMessage['content']): string {
  const parts: string[] = []
  for (const block of content) {
    switch (block.type) {
      case 'text':
        if (block.text !== '') parts.push(block.text)
        break
      case 'image':
        parts.push(imageLabel(block.attachment))
        break
      case 'file':
        parts.push(fileLabel(block.attachment))
        break
      default:
        break
    }
  }
  return parts.join('\n\n')
}

function assistantText(message: AssistantMessage): string {
  return visibleContent(message.content)
}

function toolResult(data: {
  readonly message: ToolResultMessage
  readonly error?: { readonly name: string; readonly code: string; readonly reason?: string }
}): ToolResult {
  return {
    text: visibleContent(data.message.content),
    isError: data.message.isError === true,
    reason: data.error?.reason,
  }
}

function quote(text: string): string {
  const normalized = text.replace(/\r\n?/gu, '\n').replace(/\n+$/u, '')
  return normalized.split('\n').map(line => line === '' ? '>' : `> ${line}`).join('\n')
}

function imageLabel(ref: ImageAttachmentRef): string {
  return `[Image: ${labelName(ref.name)} (${String(ref.width)}×${String(ref.height)}, ${String(ref.bytes)} bytes)]`
}

function fileLabel(ref: FileAttachmentRef): string {
  return `[File: ${labelName(ref.name)} (${String(ref.bytes)} bytes)]`
}

function labelName(name: string | undefined): string {
  const normalized = name?.replace(/\s+/gu, ' ').replace(/\]/gu, '\\]').trim() ?? ''
  return normalized === '' ? 'attachment' : normalized
}

function jsonArguments(argumentsText: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsText)
  } catch {
    return argumentsText
  }
  return JSON.stringify(parsed, null, 2)
}

function fenced(text: string, language = '', trimTrailing = true): string {
  const content = trimTrailing ? text.replace(/\n+$/u, '') : text
  let longest = 0
  for (const match of content.matchAll(/`+/gu)) longest = Math.max(longest, match[0].length)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${language}\n${content}\n${fence}`
}

interface Fence {
  readonly character: string
  readonly length: number
}

interface ScannedLine {
  readonly text: string
  readonly code: boolean
}

interface MarkdownScan {
  readonly lines: readonly ScannedLine[]
  readonly openFence: Fence | undefined
}

// Remove only blank edge lines, preserving the first and last content line's
// indentation and interior blank lines.
function trimBlankEdgeLines(text: string): string {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n')
  let start = 0
  let end = lines.length
  while (start < end && lines[start]?.trim() === '') start += 1
  while (end > start && lines[end - 1]?.trim() === '') end -= 1
  return lines.slice(start, end).join('\n')
}

// Scan fenced and indented code once so wrapper escaping and unfinished-fence
// closure agree on what is code. This is a narrow Markdown block heuristic, not
// a parser.
function scanMarkdown(markdown: string): MarkdownScan {
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n')
  const scanned: ScannedLine[] = []
  let fence: Fence | undefined
  let indented = false
  for (const line of lines) {
    if (fence !== undefined) {
      scanned.push({ text: line, code: true })
      if (closesFence(line, fence)) fence = undefined
      continue
    }
    const opening = openingFence(line)
    if (opening !== undefined) {
      fence = opening
      indented = false
      scanned.push({ text: line, code: true })
      continue
    }
    if (/^(?: {4}|\t)/u.test(line)) {
      indented = true
      scanned.push({ text: line, code: true })
      continue
    }
    scanned.push({ text: line, code: indented && line.trim() === '' })
    if (line.trim() !== '') indented = false
  }
  return { lines: scanned, openFence: fence }
}

function openingFence(line: string): Fence | undefined {
  const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line)
  if (opening === null) return undefined
  const marker = String(opening[1])
  const info = String(opening[2])
  if (marker.startsWith('`') && info.includes('`')) return undefined
  return { character: marker.slice(0, 1), length: marker.length }
}

function closesFence(line: string, fence: Fence): boolean {
  const closing = new RegExp(`^ {0,3}${fence.character}{${String(fence.length)},}\\s*$`, 'u')
  return closing.test(line)
}

// Close an assistant message that ended inside a code fence so the next
// message or generated details closer cannot be swallowed by that block.
function closeUnfinishedFence(markdown: string): string {
  const scan = scanMarkdown(markdown)
  if (scan.openFence === undefined) return markdown
  const content = markdown.replace(/\n+$/u, '')
  return `${content}\n${scan.openFence.character.repeat(scan.openFence.length)}`
}

// Arbitrary commentary inside a generated details section must not close the
// wrapper. Fenced and indented code keep their exact text.
function escapeWrapperTagsOutsideFences(markdown: string): string {
  return scanMarkdown(markdown).lines
    .map(line => line.code ? line.text : escapeWrapperTags(line.text))
    .join('\n')
}

function escapeWrapperTags(text: string): string {
  return text.replace(/<(?=\/?(?:details|summary)(?=[\s/>]))/giu, '&lt;')
}
