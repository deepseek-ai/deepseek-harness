/** Shared model configuration and context assertions for real Office workflows. */
import { expect } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'
import { Session, type SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'

/** @returns Model provider patches for the configured development or official API. */
export function officeModelPatches() {
  const model = process.env.MODEL_NAME ?? 'deepseek-flash'
  const completions = process.env.DSH_OFFICE_TEST_API === 'openai-completions'
  return [
    ...completions ? [
      { id: 'llm-deepseek', disabled: true },
      { id: 'llm-pi-ai', config: { providers: { 'office-test': {
        api: 'openai-completions', apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: process.env.DEEPSEEK_BASE_URL,
        compat: { thinkingFormat: 'deepseek' },
        models: [{ id: model, contextWindow: 128000, maxTokens: 8192, input: ['text', 'image'] }],
      } } } },
    ] : [{ id: 'llm-deepseek', config: { thinking: 'enabled', reasoningEffort: 'high', maxTokens: 8192,
      models: [{ id: model, contextWindow: 128000, maxTokens: 8192, inputModalities: ['text', 'image'] }],
    } }],
    { id: 'agent-default-model', config: { provider: completions ? 'office-test' : 'deepseek-official', model } },
  ]
}

/** @returns Patches mounting the Office kit and tools, which the headless profile does not compose. */
export function officeToolPatches() {
  return [{ insert: [
    { id: 'office-kit', name: '@deepseek-ai/dsh-office-kit' },
    { id: 'tool-office', name: '@deepseek-ai/dsh-tool-office' },
  ] }]
}

/** One Office call from a native tool call or a PTC dispatch. */
export interface OfficeCall {
  readonly callId: string
  readonly name: 'office_render' | 'office_convert' | 'office_recalculate'
  readonly args: { readonly input?: string; readonly format?: string; readonly pages?: number[] }
}

/**
 * Collect the Office calls of a recorded task by tool name.
 * @param events - Recorded task events.
 * @returns Native and PTC Office calls in log order.
 */
export function officeCalls(events: readonly SessionEvent[]): OfficeCall[] {
  return events.flatMap((event): OfficeCall[] => {
    if (event.type !== 'tool/call' && event.type !== 'tool/ptc-dispatch') return []
    const { name } = event.data
    if (name !== 'office_render' && name !== 'office_convert' && name !== 'office_recalculate') return []
    return event.type === 'tool/call'
      ? [{ callId: event.data.callId, name, args: JSON.parse(event.data.arguments) as OfficeCall['args'] }]
      : [{ callId: event.data.subCallId, name, args: event.data.arguments as OfficeCall['args'] }]
  })
}

/**
 * Collect images displayed during an Office task.
 * @param events - Recorded task events.
 * @returns Images in successful tool results and PTC additional context, excluding private dispatch output.
 */
export function officeImages(events: readonly SessionEvent[]): ImageBlock[] {
  return events.flatMap((event) => {
    const content = event.type === 'tool/result' && !event.data.message.isError ? event.data.message.content
      : event.type === 'user/message' && event.data.source.kind === 'ptc-mode' ? event.data.content : []
    return content.filter(block => block.type === 'image')
  })
}

/** One PDF conversion the Office tool reported inside a recorded task. */
export interface ConvertedPdfFile {
  /** Absolute path of the temporary file the conversion reported. */
  readonly file: string
  /** Byte count the conversion reported for {@link ConvertedPdfFile.file}. */
  readonly bytes: number
}

/** One `Converted <input> to pdf (<bytes> bytes[, <pages> pages]): <temporary file>` result line. */
const CONVERTED_PDF = /^Converted .+ to pdf \((\d+) bytes(?:, \d+ pages?)?\): (.+)$/mu

/**
 * Collect the PDF conversions reported by successful native Office tool results.
 * @param events - Recorded task events.
 * @returns Reported temporary files in log order; failed results and other formats are excluded.
 */
export function convertedPdfFiles(events: readonly SessionEvent[]): ConvertedPdfFile[] {
  return events.flatMap((event): ConvertedPdfFile[] => {
    if (event.type !== 'tool/result' || event.data.message.isError) return []
    return event.data.message.content.flatMap((block): ConvertedPdfFile[] => {
      if (block.type !== 'text') return []
      const match = CONVERTED_PDF.exec(block.text)
      return match === null ? [] : [{ bytes: Number(match[1]), file: match[2]! }]
    })
  })
}

/**
 * Reject recorded Office render calls and the "Render the saved deliverable" instruction.
 * @param events - Recorded task events, including nested skill and shell results.
 */
export function expectNoRenderContext(events: readonly SessionEvent[]): void {
  const calls = officeCalls(events)
  expect(calls.filter(call => call.name === 'office_render'), JSON.stringify(calls)).toEqual([])
  const messages = Session.create(brandString<SessionId>('office-context'), events).deriveMessages()
  expect(JSON.stringify(messages)).not.toMatch(/Render the saved deliverable/)
}

const OFFICE_BASE = /<skill_content name="office">\n<skill_resources>\nBase directory for this skill: ([^\n]+)\n/gu
const OFFICE_FORMAT_FILE = /(?:^|\/)office\/(docx|pptx|xlsx)\.md$/u
const MUTATING_TOOLS: ReadonlySet<string> = new Set(['write', 'edit', 'apply_patch', 'str_replace_editor'])
const PYTHON_COMMAND = /\bpython[\d.]*\b|\.py\b/u

function textOf(content: readonly { readonly type: string; readonly text?: string }[]): string {
  return content.flatMap(block => block.type === 'text' && block.text !== undefined ? [block.text] : []).join('\n')
}

function formatOf(path: unknown, bases: ReadonlySet<string>): string | undefined {
  if (typeof path !== 'string') return undefined
  const normalized = path.replaceAll('\\', '/')
  for (const format of ['docx', 'pptx', 'xlsx']) if ([...bases].some(base => normalized === `${base}/${format}.md`)) return format
  return OFFICE_FORMAT_FILE.exec(normalized)?.[1]
}

function mutates(name: string, args: unknown): boolean {
  if (MUTATING_TOOLS.has(name)) return true
  if (name !== 'bash' && name !== 'pwsh') return false
  const command = typeof args === 'object' && args !== null && 'command' in args ? args.command : undefined
  return typeof command === 'string' && PYTHON_COMMAND.test(command)
}

/**
 * Name the format files beside the `office` skill that a recorded task read before it first created or edited a file.
 * A read counts only for a native `read` call with a successful result or a successful PTC `read` dispatch whose
 * `file_path` is the loaded `office` resource directory joined with the file name or ends with `office/<format>.md`.
 * A write, edit, or patch call, or a shell command that runs Python, ends the reading window.
 * @param events - Recorded task events, including PTC dispatches.
 * @returns Format names, such as `xlsx`, in log order.
 */
export function formatFileReads(events: readonly SessionEvent[]): string[] {
  const bases = new Set<string>()
  const pending = new Map<string, string>()
  const formats: string[] = []
  for (const event of events) {
    const text = event.type === 'user/message' ? textOf(event.data.content)
      : event.type === 'tool/result' ? textOf(event.data.message.content)
        : event.type === 'tool/ptc-dispatch' ? textOf(event.data.content) : ''
    for (const match of text.matchAll(OFFICE_BASE)) bases.add(match[1]!.replaceAll('\\', '/'))
    if (event.type === 'tool/call') {
      const args: unknown = JSON.parse(event.data.arguments)
      if (mutates(event.data.name, args)) return formats
      const format = event.data.name === 'read' && typeof args === 'object' && args !== null && 'file_path' in args
        ? formatOf(args.file_path, bases) : undefined
      if (format !== undefined) pending.set(event.data.callId, format)
    } else if (event.type === 'tool/ptc-dispatch-start') {
      if (mutates(event.data.name, event.data.arguments)) return formats
    } else if (event.type === 'tool/result') {
      const format = pending.get(event.data.message.toolCallId)
      if (format !== undefined && event.data.message.isError !== true) formats.push(format)
    } else if (event.type === 'tool/ptc-dispatch' && event.data.name === 'read' && !event.data.isError) {
      const args = event.data.arguments
      const format = typeof args === 'object' && args !== null && 'file_path' in args ? formatOf(args.file_path, bases) : undefined
      if (format !== undefined) formats.push(format)
    }
  }
  return formats
}
