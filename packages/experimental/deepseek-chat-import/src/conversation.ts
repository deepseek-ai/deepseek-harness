/**
 * Conversion of one exported DeepSeek conversation tree into the seed log of
 * one DSH Session.
 *
 * The message named by `current_message_id` selects the imported branch, with
 * the greatest message id as the fallback. Each USER message opens a turn; a
 * finished ASSISTANT reply becomes one or more steps whose web searches and
 * opened pages replay as `web_search` and `web_fetch` calls. A question whose
 * reply was withdrawn by content filtering is left out with its reply. Other
 * unfinished, templated, empty, or missing replies end their turn with an
 * error and never enter model history.
 */

import { createHash } from 'node:crypto'
import type { AttachmentId, FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, ContentBlock, LlmFailure, SystemMessage, ToolCallBlock, ToolResultMessage, UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { normalizeSessionTitle } from '@deepseek-ai/dsh-session-title'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { formatFetchOutput, formatSearchOutput, fetchMetaFromValue, searchMetaFromValue } from '@deepseek-ai/dsh-tool-web'
import type { WebFetchResult, WebSearchResult } from '@deepseek-ai/dsh-web'
import { parseExportTime, parseKnownFragment } from './format.ts'
import type { ExportFileEntry, ExportMessage, ExportSessionFile, KnownFragment } from './format.ts'

/** Provider and model recorded on every imported assistant message. */
export const IMPORTED_MODEL_SOURCE = { provider: 'deepseek-chat-export', model: 'deepseek-chat-export' } as const

/** Character cap passed to the `web_fetch` formatter; imported page bodies are short notices. */
const FETCH_OUTPUT_CHARS = 4_000

/** Prefix hashed with the export file id into the attachment id of a synthetic file reference. */
const SYNTHETIC_FILE_ID_PREFIX = 'deepseek-chat-export:'

/** Error codes of the export statuses that end a reply unfinished; any other status uses `DEEPSEEK_EXPORT_UNFINISHED_REPLY`. */
const UNFINISHED_STATUS_CODES: ReadonlyMap<string, string> = new Map([
  ['FAILED', 'DEEPSEEK_EXPORT_FAILED'],
  ['TIMEOUT', 'DEEPSEEK_EXPORT_TIMEOUT'],
  ['CONTEXT_LENGTH_EXCEEDED', 'DEEPSEEK_EXPORT_CONTEXT_LENGTH_EXCEEDED'],
  ['INCOMPLETE', 'DEEPSEEK_EXPORT_INCOMPLETE'],
  ['WIP', 'DEEPSEEK_EXPORT_WIP'],
])

/** A conversation file that cannot be imported; the message names the defect. */
export class ExportConversationError extends Error {
  override readonly name = 'ExportConversationError'
}

/** Inputs that make conversion deterministic and pure. */
export interface ConvertConversationOptions {
  /** Mint one unique id for each message and tool call. */
  readonly createId: () => string
  /** Largest UTF-8 size of the imported title; longer titles are truncated after whitespace is collapsed. */
  readonly maxTitleBytes: number
  /** Saved images keyed by export file id; image files without an entry become synthetic file cards. */
  readonly images?: ReadonlyMap<string, ImageAttachmentRef>
}

/** One converted conversation. */
export interface ConvertedConversation {
  /** Normalized original title, or null when it is absent or normalizes to empty. */
  readonly title: string | null
  /** Epoch milliseconds of the first event, used as the Session creation time. */
  readonly createdAt: number
  /** Seed events contiguous from seq 0, without a `session/end-seed` marker. */
  readonly events: readonly SessionEvent[]
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type EventInput = DistributiveOmit<SessionEvent, 'seq' | 'time'>

interface ReplyStep {
  readonly content: ContentBlock[]
  readonly calls: PendingCall[]
  elapsedMs: number
  /** `stage_id` of the tool fragments in this step; null while it holds none. */
  stage: number | null
}

interface PendingCall {
  readonly block: ToolCallBlock
  readonly result: readonly ContentBlock[]
  readonly isError: boolean
  readonly meta?: JsonValue
}

/**
 * Select the imported branch of one conversation tree: the path from the root
 * to the message named by `current_message_id`, or to the message with the
 * greatest id when that field is absent, null, or names no message. A child
 * always has a greater id than its parent, so the fallback is a leaf.
 * @param file - one validated conversation file.
 * @returns messages from root to the selected message.
 * @throws {ExportConversationError} for an empty tree, duplicate ids, a missing parent, or a cycle.
 */
export function selectBranch(file: ExportSessionFile): readonly ExportMessage[] {
  const byId = new Map<number, ExportMessage>()
  let newest: ExportMessage | undefined
  for (const message of file.messages) {
    if (byId.has(message.id)) throw new ExportConversationError(`duplicate message id ${message.id}`)
    byId.set(message.id, message)
    if (newest === undefined || message.id > newest.id) newest = message
  }
  if (newest === undefined) throw new ExportConversationError('conversation has no messages')
  const current = file.current_message_id
  const selected = current === null || current === undefined ? undefined : byId.get(current)
  const chain: ExportMessage[] = []
  for (let message = selected ?? newest; ;) {
    if (chain.length === byId.size) throw new ExportConversationError(`message ${message.id} is part of a parent cycle`)
    chain.push(message)
    if (message.parent_id === null) return chain.reverse()
    const parent = byId.get(message.parent_id)
    if (parent === undefined) throw new ExportConversationError(`message parent ${message.parent_id} does not exist`)
    message = parent
  }
}

/**
 * Read the time of a message as epoch milliseconds.
 * @param message - one export message.
 * @returns the parsed `inserted_at`.
 * @throws {ExportConversationError} when the timestamp is invalid.
 */
export function messageTime(message: ExportMessage): number {
  const time = parseExportTime(message.inserted_at)
  if (time === undefined) throw new ExportConversationError(`message ${message.id} has an invalid inserted_at`)
  return time
}

/**
 * Convert one conversation into the seed log of a DSH Session.
 * @param file - one validated conversation file.
 * @param options - id source and saved images.
 * @returns the title, creation time, and seed events.
 * @throws {ExportConversationError} when the tree, a timestamp, or a mapped fragment is invalid, or no turn remains.
 */
export function convertConversation(file: ExportSessionFile, options: ConvertConversationOptions): ConvertedConversation {
  const chain = selectBranch(file)
  const log = new LogBuilder(options)
  const normalized = file.title === null ? '' : normalizeSessionTitle(file.title, options.maxTitleBytes)
  const title = normalized.length === 0 ? null : normalized
  let turn = 0
  let withdrawn = 0
  for (let index = 0; index < chain.length; index++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- index < chain.length
    const user = chain[index]!
    // An ASSISTANT message without a preceding USER message has no turn to join.
    if (user.role !== 'USER') continue
    const next = chain[index + 1]
    const reply = next?.role === 'ASSISTANT' ? next : undefined
    if (reply !== undefined) index++
    if (reply?.status === 'CONTENT_FILTER') {
      withdrawn++
      continue
    }
    turn++
    log.turn(turn, user, reply)
    if (turn === 1 && title !== null) {
      log.add({ type: 'session/title', data: { title, messageSeqs: [], source: { kind: 'user' } } })
    }
  }
  if (turn === 0) {
    throw new ExportConversationError(withdrawn === 0
      ? 'conversation has no user message'
      : 'every question of the conversation was withdrawn by content filtering')
  }
  // oxlint-disable-next-line typescript/no-non-null-assertion -- every turn appends turn/start
  return { title, createdAt: log.events[0]!.time, events: log.events }
}

/** Accumulates seed events with contiguous seqs and non-decreasing times. */
class LogBuilder {
  readonly events: SessionEvent[] = []
  private time = 0

  constructor(private readonly options: ConvertConversationOptions) {}

  add(event: EventInput): SessionSeq {
    const seq = SessionSeq(this.events.length)
    this.events.push({ ...event, seq, time: this.time })
    return seq
  }

  turn(turn: number, user: ExportMessage, reply: ExportMessage | undefined): void {
    this.at(messageTime(user))
    this.add({ type: 'turn/start', data: { turn } })
    let step = 1
    this.add({ type: 'step/start', data: { turn, step } })
    if (turn === 1) {
      // An empty system head holds surface node 0, so a resumed Agent replaces it with the real prompt
      // instead of appending a system message after the imported history, which the stored format rejects.
      const head: SystemMessage = { id: MessageId(this.id()), role: 'system', content: [], source: { kind: 'system-prompt' } }
      this.add({ type: 'system/message', data: { turn, step, message: head }, surfaceOp: 'append' })
    }
    this.add({ type: 'user/message', data: this.userMessage(user), surfaceOp: 'append' })
    if (reply === undefined) {
      this.closeTurn(turn, step, failure('DEEPSEEK_EXPORT_NO_REPLY', 'The export contains no reply to this message.'))
      return
    }
    this.at(messageTime(reply))
    const { steps, template } = this.replySteps(reply)
    const excluded = excludedReply(reply, template, steps.length)
    if (excluded !== undefined) {
      this.closeTurn(turn, step, { kind: 'error', error: excluded })
      return
    }
    for (const [position, { content, calls, elapsedMs }] of steps.entries()) {
      if (position > 0) {
        step++
        this.add({ type: 'step/start', data: { turn, step } })
      }
      this.time += elapsedMs
      this.add({ type: 'assistant/message', data: { turn, step, message: assistantMessage(this.id(), [...content, ...calls.map(call => call.block)]), stream: [] }, surfaceOp: 'append' })
      const callSeqs = calls.map(({ block }) => this.add({
        type: 'tool/call', data: { turn, step, callId: block.id, name: block.name, arguments: block.arguments },
      }))
      for (const [callIndex, call] of calls.entries()) {
        this.add({
          type: 'tool/result',
          data: { turn, step, message: toolResult(this.id(), call), ...call.meta === undefined ? {} : { meta: call.meta } },
          surfaceOp: 'append',
          // oxlint-disable-next-line typescript/no-non-null-assertion -- one call seq per call
          sourceEventSeqs: [callSeqs[callIndex]!],
        })
      }
      if (position < steps.length - 1) this.add({ type: 'step/end', data: { turn, step } })
    }
    this.closeTurn(turn, step, { kind: 'completed' })
  }

  private closeTurn(turn: number, step: number, reason: { kind: 'completed' } | { kind: 'error'; error: LlmFailure }): void {
    this.add({ type: 'step/end', data: { turn, step } })
    this.add({ type: 'turn/end', data: { turn, reason } })
  }

  private at(time: number): void {
    this.time = Math.max(this.time, time)
  }

  private id(): string {
    return this.options.createId()
  }

  private userMessage(message: ExportMessage): UserMessage {
    const attachments: ContentBlock[] = []
    const lines: string[] = []
    for (const fragment of fragmentsOf(message)) {
      if (fragment.type === 'REQUEST') {
        lines.push(fragment.content)
      } else if (fragment.type === 'FILE') {
        for (const file of fragment.files) {
          const image = file.is_image ? this.options.images?.get(file.id) : undefined
          attachments.push(image === undefined ? { type: 'file', attachment: syntheticFileRef(file) } : { type: 'image', attachment: image })
        }
      }
    }
    const text = lines.join('\n')
    // A user message without any content keeps one empty text block: the row
    // renders, and the request assembly drops it like any empty user message.
    const content: ContentBlock[] = text.trim().length > 0
      ? [...attachments, { type: 'text', text }]
      : attachments.length > 0 ? attachments : [{ type: 'text', text: '' }]
    return { id: MessageId(this.id()), role: 'user', content, source: { kind: 'user' } }
  }

  /**
   * Split one reply into steps. A tool fragment that carries a `stage_id`
   * starts a new step when it differs from the stage of the open step;
   * a step opened by text adopts the first stage it sees. Text after a tool
   * call starts a new step. Also reports the first server template.
   */
  private replySteps(reply: ExportMessage): { steps: ReplyStep[]; template: string | undefined } {
    const steps: ReplyStep[] = []
    let template: string | undefined
    let current = emptyStep()
    const pushStep = (): void => {
      if (current.content.length === 0 && current.calls.length === 0) return
      steps.push(current)
      current = emptyStep()
    }
    const appendContent = (block: ContentBlock): void => {
      if (current.calls.length > 0) pushStep()
      current.content.push(block)
    }
    // Only calls carry a stage, so a step with a stage always holds a call and
    // a stage change never strands text in a call-less step that is not last.
    const appendCall = (call: PendingCall, stage: number | null): void => {
      if (stage !== null) {
        if (current.stage !== null && stage !== current.stage) pushStep()
        current.stage = stage
      }
      current.calls.push(call)
    }
    for (const fragment of fragmentsOf(reply)) {
      switch (fragment.type) {
        case 'THINK':
          if (fragment.content.length > 0) appendContent({ type: 'reasoning', text: fragment.content })
          current.elapsedMs += Math.round((fragment.elapsed_secs ?? 0) * 1000)
          break
        case 'RESPONSE':
          if (fragment.content.length > 0) appendContent({ type: 'text', text: fragment.content })
          break
        case 'TOOL_SEARCH': {
          // An unfinished search is incomplete and replays as nothing.
          if (fragment.status === 'WIP') break
          const call = searchCall(this.id(), fragment)
          if (call !== undefined) appendCall(call, fragment.stage_id ?? null)
          break
        }
        case 'TOOL_OPEN': {
          // A record without an address is a stage marker the export writes
          // beside the real page opens; it names no page and replays as nothing.
          const url = nonEmpty(fragment.url)
          if (fragment.status === 'WIP' || url === undefined) break
          appendCall(openCall(this.id(), fragment, url), fragment.stage_id ?? null)
          break
        }
        case 'READ_LINK': {
          // The linked pages are the only part of the record the website shows;
          // the body stays a signature that cannot be decrypted without the key.
          const text = linkLines(fragment.results)
          if (text !== undefined) appendContent({ type: 'text', text })
          break
        }
        case 'TEMPLATE_RESPONSE':
          template ??= fragment.content
          break
        // The website shows none of these as reply text: a page find, an image
        // search, a partial-read notice, and a tip leave no trace in the
        // imported reply, and the reasoning already carries what the model
        // took from them.
        case 'TOOL_FIND':
        case 'TOOL_IMAGE_SEARCH':
        case 'PARTIAL_FILE_READ':
        case 'TIP':
        case 'REQUEST':
        case 'FILE':
          break
      }
    }
    pushStep()
    return { steps, template }
  }
}

function fragmentsOf(message: ExportMessage): KnownFragment[] {
  const fragments: KnownFragment[] = []
  for (const [index, envelope] of message.fragments.entries()) {
    let fragment: KnownFragment | undefined
    try {
      fragment = parseKnownFragment(envelope)
    } catch (error) {
      throw new ExportConversationError(`message ${message.id} fragment ${index} (${envelope.type}) is malformed`, { cause: error })
    }
    if (fragment !== undefined) fragments.push(fragment)
  }
  return fragments
}

/**
 * The failure that replaces a reply excluded from model history, or undefined
 * for an importable reply. A server template outranks the status, which
 * outranks an empty reply. Error codes are fixed; only the message names an
 * unrecognized status.
 */
function excludedReply(reply: ExportMessage, template: string | undefined, stepCount: number): LlmFailure | undefined {
  if (template !== undefined) return { code: 'DEEPSEEK_EXPORT_TEMPLATE_RESPONSE', message: template }
  if (reply.status !== 'FINISHED') {
    return {
      code: UNFINISHED_STATUS_CODES.get(reply.status) ?? 'DEEPSEEK_EXPORT_UNFINISHED_REPLY',
      message: `The original reply ended with status ${JSON.stringify(reply.status)} and is excluded from the model context.`,
    }
  }
  return stepCount === 0 ? { code: 'DEEPSEEK_EXPORT_EMPTY_REPLY', message: 'The original reply has no importable content.' } : undefined
}

function failure(code: string, message: string): { kind: 'error'; error: LlmFailure } {
  return { kind: 'error', error: { code, message } }
}

/**
 * The synthetic reference of one exported file whose bytes are not stored: a
 * non-image file, whose body the export never carries, or an image that was
 * not stored. The id is deterministic in the export file id, so re-importing
 * the same export yields the same reference; no attachment object exists for
 * it, so the model's handle names a path that holds no bytes; a name the store
 * would rewrite makes the reference invalid instead, and that handle carries no
 * path at all.
 */
function syntheticFileRef(file: ExportFileEntry): FileAttachmentRef {
  const digest = createHash('sha256').update(`${SYNTHETIC_FILE_ID_PREFIX}${file.id}`).digest('hex')
  return { attachmentId: brandString<AttachmentId>(`sha256:${digest}`), name: fileDisplayName(file.file_name), bytes: file.file_size }
}

/** The leaf of an exported file name without control characters; `file` when nothing remains. */
function fileDisplayName(name: string): string {
  const leaf = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1)
  const clean = leaf.replace(/[\u0000-\u001f\u007f]/gu, '').trim()
  return clean.length === 0 ? 'file' : clean
}

function emptyStep(): ReplyStep {
  return { content: [], calls: [], elapsedMs: 0, stage: null }
}

/**
 * The Markdown link lines of one `READ_LINK` record: `[title](url)` per
 * result, the URL as its own text when the title is missing, the title alone
 * without a URL; a result with neither is skipped.
 * @param results - the record's results.
 * @returns the joined lines, or undefined when no result names anything.
 */
function linkLines(results: Extract<KnownFragment, { type: 'READ_LINK' }>['results']): string | undefined {
  const lines: string[] = []
  for (const result of results) {
    const url = nonEmpty(result.url)
    const title = nonEmpty(result.title)
    if (url !== undefined) lines.push(`[${title ?? url}](${url})`)
    else if (title !== undefined) lines.push(title)
  }
  return lines.length === 0 ? undefined : lines.join('\n')
}

function assistantMessage(id: string, content: ContentBlock[]): AssistantMessage {
  return { id: MessageId(id), role: 'assistant', content, source: { kind: 'model', ...IMPORTED_MODEL_SOURCE } }
}

function toolResult(id: string, call: PendingCall): ToolResultMessage {
  return {
    id: MessageId(id), role: 'tool', content: call.result, isError: call.isError,
    source: { kind: 'tool', callId: call.block.id }, toolCallId: call.block.id,
  }
}

function searchCall(id: string, fragment: Extract<KnownFragment, { type: 'TOOL_SEARCH' }>): PendingCall | undefined {
  const queries = fragment.queries.filter(query => query.trim().length > 0)
  const block: ToolCallBlock = { type: 'tool-call', id: ToolCallId(id), name: 'web_search', arguments: JSON.stringify({ queries }) }
  // The export separates a failed search from a search that found nothing.
  if (fragment.status === 'FAILED') {
    return { block, result: [{ type: 'text', text: 'Error: the export records this search as failed.' }], isError: true }
  }
  if (queries.length === 0) return undefined
  const result: WebSearchResult = {
    sources: fragment.results.map((source): WebSearchResult['sources'][number] => {
      const title = nonEmpty(source.title)
      const snippet = nonEmpty(source.snippet)
      const publishedAt = nonEmpty(source.published_at)
      return {
        url: source.url,
        ...title === undefined ? {} : { title },
        ...snippet === undefined ? {} : { snippet },
        ...publishedAt === undefined ? {} : { publishedAt },
      }
    }),
    truncated: false,
  }
  return {
    block,
    result: [{ type: 'text', text: formatSearchOutput(result) }],
    isError: false,
    meta: searchMetaFromValue(result),
  }
}

function openCall(id: string, fragment: Extract<KnownFragment, { type: 'TOOL_OPEN' }>, url: string): PendingCall {
  const block: ToolCallBlock = { type: 'tool-call', id: ToolCallId(id), name: 'web_fetch', arguments: JSON.stringify({ url }) }
  if (fragment.status !== 'FINISHED') {
    return { block, result: [{ type: 'text', text: 'Error: the page could not be opened.' }], isError: true }
  }
  const title = nonEmpty(fragment.title)
  const notice = 'The page content is not included in the DeepSeek chat export.'
  const value: WebFetchResult = {
    url, statusCode: 200, truncated: false,
    body: { kind: 'text', content: title === undefined ? notice : `${title}\n\n${notice}` },
  }
  return {
    block,
    result: [{ type: 'text', text: formatFetchOutput(value, FETCH_OUTPUT_CHARS) }],
    isError: false,
    meta: fetchMetaFromValue(value, FETCH_OUTPUT_CHARS),
  }
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return value === null || value === undefined || value.trim().length === 0 ? undefined : value
}
