// Standalone browser fixture for UI development without a server.

import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm/message'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type {
  AssistantMessage,
  ContentBlock,
  MessageSource,
  StreamChunk,
  TokenUsage,
  ToolResultMessage,
  UserMessage,
} from '@deepseek-ai/dsh-llm'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm/brand'
import {
  AssistantStreamAccumulator,
  expandAssistantStream,
  type AssistantStreamRecord,
} from '@deepseek-ai/dsh-llm/assistant-stream'
import type { AttachmentIdType, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {
  SessionEvent,
  SessionId,
  SessionSeqCursor,
} from '@deepseek-ai/dsh-session/types'
import { SESSION_FORMAT_VERSION, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'
// Type-only: the brand constructor is host-side; the fixture casts at its
// wire-fabrication boundary (the schema layer's one-cast-point posture).
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandDescriptor, CommandExecution, CommandResult } from '@deepseek-ai/dsh-commands/types'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
import type { DirectoryListing as FixtureDirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types'
import type { SettingsDescribeValue, SettingsNamespaceView } from '@deepseek-ai/dsh-settings/types'
import { deriveEventMessage, foldSurface } from '@deepseek-ai/dsh-session/surface'
import type { RpcResult } from './api.ts'
import { randomUuid } from './random-uuid.ts'
import type {
  ClientConnectionRpc, ConnectionRpcFailure, ConnectionRpcResult,
} from '../rpc.ts'

const FIXTURE_SESSION_SEARCH_RESULT_LIMIT = 20

interface ModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

interface ModelProviderGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly {
    readonly id: string
    readonly name: string
    readonly description?: string
    readonly reasoning?: {
      readonly efforts: readonly { readonly id: string; readonly name: string; readonly description?: string }[]
      readonly defaultEffort?: string
    }
  }[]
}

/* jscpd:ignore-start -- The standalone fixture mirrors host timing without importing a target implementation. */
function isFixtureTokenDelta(chunk: StreamChunk): boolean {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text !== ''
    case 'tool-call-delta':
      return chunk.argumentsDelta !== '' || chunk.name !== undefined
    default:
      return false
  }
}
/* jscpd:ignore-end */

interface FixtureSessionSummary {
  readonly sessionId: SessionId
  updatedAt: number
  running: boolean
  blank: boolean
  readonly parentSessionId?: SessionId
  readonly origin?: 'subagent'
  readonly cwd?: string
  readonly agentPreset?: string
  readonly projections?: FixtureProjectionsBlock
}

interface FixtureProjectionsBlock {
  readonly asOfSeq: number
  readonly values: Readonly<Record<string, unknown>>
}

interface FixtureHistoryEntry {
  readonly type: 'event'
  readonly event: SessionEvent
}

type FixtureHistoryRecord = FixtureHistoryEntry

type FixtureSessionAddress =
  | { readonly kind: 'session'; readonly sessionId: SessionId }
  | {
    readonly kind: 'subagent'
    readonly parentSessionId: SessionId
    readonly childSessionId: SessionId
    readonly mode: 'one-shot' | 'continuable'
  }

interface FixtureFollowRequest {
  readonly address: FixtureSessionAddress
  readonly maxMessages?: number
  readonly assistantStream?: true
}

interface FixturePageRequest {
  readonly address: FixtureSessionAddress
  readonly throughSeq: number
  readonly beforeSeq?: number
  readonly maxMessages?: number
}

interface FixtureSessionWireHeader {
  readonly version: number
  readonly id: SessionId
  readonly createdAt: number
  readonly cwd?: string
  readonly parentSession?: SessionId
  readonly isSeeded: boolean
  readonly origin?: 'subagent'
  readonly delegationDepth?: number
  readonly agentPreset?: string
}

type FixtureFollowFrame =
  | {
    readonly type: 'snapshot'
    readonly header: FixtureSessionWireHeader
    readonly cursor: number
    readonly records: readonly FixtureHistoryRecord[]
    readonly hasMore: boolean
    readonly projections: FixtureProjectionsBlock
    readonly assistantStream?: FixtureAssistantStreamBaseline
  }
  | FixtureHistoryEntry
  | { readonly type: 'assistant-stream'; readonly frame: FixtureAssistantStreamFrame }

type FixtureFollowEventFrame = Exclude<FixtureFollowFrame, { type: 'snapshot' }>

interface FixtureAssistantStreamBaseline {
  readonly revision: number
  readonly activeAttempt?: {
    readonly attemptId: ReturnType<typeof LlmAttemptId>
    readonly startedAfterSeq: number
    readonly turn: number
    readonly step: number
    readonly nextIndex: number
    readonly stream: readonly AssistantStreamRecord[]
  }
}

/** Assistant frame emitted by the standalone fixture; tests pin it to the controller wire type. */
export type FixtureAssistantStreamFrame =
  | {
    readonly type: 'start'
    readonly attemptId: ReturnType<typeof LlmAttemptId>
    readonly revision: number
    readonly startedAfterSeq: SessionSeqCursor
    readonly turn: number
    readonly step: number
  }
  | {
    readonly type: 'chunk'
    readonly attemptId: ReturnType<typeof LlmAttemptId>
    readonly revision: number
    readonly index: number
    readonly time: number
    readonly chunk: JsonValue
  }
  | {
    readonly type: 'end'
    readonly attemptId: ReturnType<typeof LlmAttemptId>
    readonly revision: number
    readonly index: number
    readonly outcome:
      | {
        readonly kind: 'committed'
        readonly eventType: 'assistant/message' | 'assistant/attempt'
        readonly seq: number
      }
      | { readonly kind: 'abandoned' }
  }

interface FixtureRemoteEventNotificationFrame {
  readonly type: 'emit'
  readonly event: string
  readonly args: readonly unknown[]
}

interface FixtureRemoteEventInvocationFrame {
  readonly type: 'waterfall'
  readonly event: string
  readonly eventId: string
  readonly agentId: SessionId
  readonly request: Readonly<Record<string, unknown>>
}

interface FixtureRemoteEventCancellationFrame {
  readonly type: 'cancel'
  readonly eventId: string
}

type FixtureRemoteEventFrame =
  | FixtureRemoteEventNotificationFrame
  | FixtureRemoteEventInvocationFrame
  | FixtureRemoteEventCancellationFrame

interface FixtureRemoteEventResult {
  readonly clientId: string
  readonly eventId: string
  readonly outcome:
    | { readonly kind: 'next' }
    | { readonly kind: 'result'; readonly value?: unknown }
    | {
      readonly kind: 'rejected'
      readonly error: {
        readonly name: string
        readonly message: string
        readonly code?: string
        readonly details?: unknown
      }
    }
}

interface FixtureRemoteEventReadyFrame {
  readonly type: 'ready'
  readonly clientId: string
  readonly host: { readonly home: string }
}

interface FixtureProjectionFrame {
  readonly type: 'projection'
  readonly sessionId: SessionId
  readonly key: string
  readonly value: unknown
  readonly seq: number
}

interface FixtureQuestionItem {
  readonly id: string
  readonly header?: string
  readonly question: string
  readonly detail?: string
  readonly multiSelect?: boolean
  readonly options?: readonly { readonly label: string; readonly description?: string }[]
}

type FixtureControlFrame =
  | {
    readonly type: 'baseline'
    readonly value: {
      readonly queues: Readonly<Record<string, readonly never[]>>
      readonly jobs: Readonly<Record<string, readonly never[]>>
      readonly approvals: readonly never[]
      readonly questions: readonly never[]
      readonly projections: Readonly<Record<string, FixtureProjectionsBlock>>
    }
  }
  | FixtureProjectionFrame

type FixturePromptPart =
  | { readonly type: 'text'; readonly text: string }
  | {
    readonly type: 'image'
    readonly mediaType: ImageAttachmentRef['mediaType']
    readonly data: string
    readonly name?: string
  }

interface FixtureSessionApi {
  list(request: { readonly cursor?: string }): Promise<ConnectionRpcResult<unknown>>
  search(
    request: { readonly query: string },
    signal: AbortSignal,
  ): Promise<ConnectionRpcResult<unknown>>
  create(request: {
    readonly workspaceId?: WorkspaceId
    readonly cwd?: string
    readonly sessionId?: SessionId
    readonly agentPreset?: string
  }): Promise<ConnectionRpcResult<unknown>>
  rename(request: { readonly sessionId: SessionId; readonly title: string }): Promise<ConnectionRpcResult<unknown>>
  fork(request: { readonly sessionId: SessionId; readonly atSeq?: number }): Promise<ConnectionRpcResult<unknown>>
  history(request: {
    readonly sessionId: SessionId
    readonly throughSeq?: number
    readonly beforeSeq?: number
    readonly maxMessages?: number
  }): Promise<ConnectionRpcResult<unknown>>
  selectModel(request: {
    readonly sessionId: SessionId
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  }): Promise<ConnectionRpcResult<unknown>>
  prompt(request: {
    readonly requestId: string
    readonly sessionId: SessionId
    readonly mode: 'queue' | 'steer'
    readonly content: readonly FixturePromptPart[]
    readonly clientTimeZone?: string
  }): Promise<ConnectionRpcResult<unknown>>
  attachment(request: {
    readonly sessionId: SessionId
    readonly attachmentId: AttachmentIdType
  }): Promise<ConnectionRpcResult<unknown>>
  updateQueue(request: {
    readonly sessionId: SessionId
    readonly itemId: MessageId
    readonly action: unknown
  }): Promise<ConnectionRpcResult<unknown>>
  cancel(request: { readonly sessionId: SessionId }): Promise<ConnectionRpcResult<unknown>>
}

type WorkspaceId = string & { readonly __fixtureWorkspaceId: 'WorkspaceId' }

interface WorkspaceView {
  readonly workspaceId: WorkspaceId
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly SessionId[]
  readonly createdAt: string
  readonly updatedAt: string
}

interface WorkspaceCreateRequest { readonly path: string }
interface WorkspaceCreateValue { readonly workspace: WorkspaceView; readonly created: boolean }
interface WorkspaceRenameRequest { readonly workspaceId: WorkspaceId; readonly title: string }
interface WorkspaceValue { readonly workspace: WorkspaceView }
interface WorkspaceDeleteRequest { readonly workspaceId: WorkspaceId }
interface WorkspaceDeleteValue { readonly deleted: true }
interface WorkspaceInsertBeforeRequest {
  readonly workspaceId: WorkspaceId
  readonly beforeWorkspaceId?: WorkspaceId
}
interface WorkspaceOrderValue { readonly workspaceIds: readonly WorkspaceId[] }
interface WorkspaceInsertSessionBeforeRequest {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly beforeSessionId?: SessionId
}
interface WorkspaceArchiveSessionRequest { readonly sessionId: SessionId }
interface WorkspaceArchiveValue { readonly archivedSessionIds: readonly SessionId[] }

type WorkspaceFollowFrame =
  | {
    readonly type: 'baseline'
    readonly value: {
      readonly items: readonly WorkspaceView[]
      readonly archivedSessionIds: readonly SessionId[]
    }
  }
  | { readonly type: 'upsert'; readonly workspace: WorkspaceView }
  | { readonly type: 'remove'; readonly workspaceId: WorkspaceId }
  | { readonly type: 'order'; readonly workspaceIds: readonly WorkspaceId[] }
  | { readonly type: 'archived'; readonly archivedSessionIds: readonly SessionId[] }

interface FixtureWorkspaceApi {
  create(request: WorkspaceCreateRequest): Promise<ConnectionRpcResult<WorkspaceCreateValue>>
  rename(request: WorkspaceRenameRequest): Promise<ConnectionRpcResult<WorkspaceValue>>
  delete(request: WorkspaceDeleteRequest): Promise<ConnectionRpcResult<WorkspaceDeleteValue>>
  insertBefore(request: WorkspaceInsertBeforeRequest): Promise<ConnectionRpcResult<WorkspaceOrderValue>>
  insertSessionBefore(request: WorkspaceInsertSessionBeforeRequest): Promise<ConnectionRpcResult<WorkspaceValue>>
  archiveSession(request: WorkspaceArchiveSessionRequest): Promise<ConnectionRpcResult<WorkspaceArchiveValue>>
}

interface FixtureWorkspace {
  workspaceId: WorkspaceId
  path: string
  title: string
  sessionIds: SessionId[]
  createdAt: string
  updatedAt: string
}

function text(t: string): ContentBlock[] {
  return [{ type: 'text', text: t }]
}

function userMessage(content: ContentBlock[], source: MessageSource = { kind: 'user' }): UserMessage {
  return createUserMessage({ content, source })
}

function assistantMessage(content: ContentBlock[], model = 'fx-1'): AssistantMessage {
  return createAssistantMessage({
    content,
    source: { provider: 'fixture', model },
  })
}

function toolResultMessage(callId: string, content: ContentBlock[], isError: boolean): ToolResultMessage {
  return createToolResultMessage({ callId: brandString<ToolCallId>(callId), content, isError })
}

const MARKDOWN_FIXTURE = [
  '# Markdown fixture',
  '',
  'Assistant output renders **strong text**, *emphasis*, and `inline code`.',
  '',
  '- first item',
  '  - nested item',
  '',
  '| Area | State |',
  '| --- | --- |',
  '| history | rendered |',
  '| streaming | stable |',
  '',
  '[DeepSeek](https://www.deepseek.com)',
  '',
  '```ts',
  'const markdown = true',
  '```',
].join('\n')

const USER_MARKDOWN_LITERAL = '用户字面量：# 不渲染 `code` [link](https://example.com)'

/**
 * SGR wrapper for the terminal output sample below: authoring the escapes as
 * `\u001b` keeps literal control bytes out of this source file.
 * @param code - the SGR parameter (an ANSI color or attribute number).
 * @param body - the text the attribute applies to.
 * @returns the body wrapped in the attribute and a reset.
 */
function sgr(code: number, body: string): string {
  return `\u001b[${code}m${body}\u001b[0m`
}

/**
 * Terminal output sample for fixture turn 66, authored to carry every feature
 * the terminal card draws that turn 60's two prompt rows cannot reach:
 * basic-16 SGR foreground runs (green, red, bright-black) that must resolve to
 * `--dsw-*` tokens, a bold run, column-aligned table rows that must scroll
 * rather than fold, more than DEFAULT_TERMINAL_MAX_LINES (16) lines so the
 * height cap collapses the middle. This constant is the visible body; the call
 * site appends the shell result's `[exit code: N]` marker so Client derivation
 * can consume it into the terminal status pill.
 */
const TERMINAL_OUTPUT_FIXTURE = [
  sgr(1, 'Running 4 checks'),
  `${sgr(32, '\u2713')} typecheck                                          1.82s`,
  `${sgr(32, '\u2713')} lint                                               0.94s`,
  `${sgr(32, '\u2713')} duplication                                        2.10s`,
  `${sgr(31, '\u2717')} unit                                               8.41s`,
  '',
  sgr(90, 'packages/client/ui-primitives/tests/terminal-block.client.spec.tsx'),
  `  ${sgr(31, 'FAIL')} caps output at the configured line budget`,
  '    expected 16 lines, received 24',
  '',
  'NAME                        LINES    BRANCHES    FUNCTIONS    UNCOVERED',
  'TerminalBlock.tsx           100%     100%        100%         -',
  'ansi.ts                     100%     100%        100%         -',
  'clipboard.ts                100%     100%        100%         -',
  'CodeBlock.tsx               98.4%    96.2%       100%         41-43',
  'highlight.ts                100%     100%        100%         -',
  'Pill.tsx                    100%     100%        100%         -',
  'StateDot.tsx                100%     100%        100%         -',
  'markdown/Markdown.tsx       100%     100%        100%         -',
  '',
  sgr(31, '1 of 4 checks failed'),
].join('\n')

/**
 * Structured grep metadata for the search sample (turn 67). `truncated` with a
 * larger `total` than the retained match count exercises the search card's
 * capped indicator; the file with more than CHAT_SEARCH_MAX_LINES rows
 * exercises its head/tail height cap.
 */
const SEARCH_MATCHES_FIXTURE: { path: string; matches: { lineNumber: number; line: string }[] }[] = [
  {
    path: 'packages/client/ui-primitives/src/SearchBlock.tsx',
    matches: [
      { lineNumber: 16, line: 'export const DEFAULT_SEARCH_MAX_LINES = 16' },
      { lineNumber: 138, line: 'export function SearchBlock(props: SearchBlockProps) {' },
      { lineNumber: 141, line: '  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set())' },
    ],
  },
  {
    path: 'packages/client/ui-tool/src/client/tool/models/search-card-model.ts',
    matches: [
      { lineNumber: 45, line: 'export const CHAT_SEARCH_MAX_LINES = 8' },
      { lineNumber: 130, line: 'export function searchCardModel(block: ToolCallBlock): SearchCardModel | null {' },
    ],
  },
  {
    path: 'packages/client/ui-tool/src/client/tool/toolviews/search-row.tsx',
    matches: [
      { lineNumber: 34, line: 'export function SearchRow({ toolName, block, inspect, t }: SearchRowProps) {' },
      { lineNumber: 36, line: '  const search = searchCardModel(block)' },
      { lineNumber: 56, line: '      search={search}' },
      { lineNumber: 78, line: "      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'grep', locale: NS }, SearchRow)" },
    ],
  },
]

const SEARCH_MATCHES_TEXT = [
  'Found 9 of 42 matches',
  '',
  ...SEARCH_MATCHES_FIXTURE.map(file =>
    [file.path, ...file.matches.map(m => `Line ${m.lineNumber}: ${m.line}`)].join('\n')),
  '',
  '(Full grep result stored at: fixture://spill/grep-66. Read it to see every match.)',
].join('\n')

const SEARCH_PATHS_FIXTURE = [
  'packages/client/ui-primitives/src/SearchBlock.tsx',
  'packages/client/ui-primitives/src/SearchBlock.module.css',
  'packages/client/ui-tool/src/client/tool/models/search-card-model.ts',
  'packages/client/ui-tool/src/client/tool/toolviews/search-row.tsx',
  'packages/client/ui-tool/tests/search-card.client.spec.tsx',
]

const SEARCH_PATHS_TEXT = [
  ...SEARCH_PATHS_FIXTURE,
  '',
  '(Showing 5 of 23 paths. Full sorted result stored at: fixture://spill/glob-67. Read it to see every path.)',
].join('\n')

const READ_SAMPLE_FIRST_LINE = 41
const READ_SAMPLE_SOURCE = [
  'export interface ReadBlockProps {',
  '  label?: string | undefined',
  '  lines: readonly ReadBlockLine[]',
  '  totalLines: number',
  '  lang?: string | undefined',
  '  maxLines?: number | undefined',
  '  className?: string | undefined',
  '}',
  '',
  '// A windowed read keeps the file line numbers in the gutter.',
  'const marker = "fixture read sample"',
]
const READ_SAMPLE_LINES = READ_SAMPLE_SOURCE.map((text, index) => ({ number: READ_SAMPLE_FIRST_LINE + index, text }))
const READ_SAMPLE_PATH = 'packages/client/ui-primitives/src/ReadBlock.tsx'
const READ_SAMPLE_TOTAL = 180
const READ_SAMPLE_LAST_LINE = READ_SAMPLE_FIRST_LINE + READ_SAMPLE_SOURCE.length - 1
const READ_SAMPLE_TEXT = [
  `<path>${READ_SAMPLE_PATH}</path>`,
  '<type>file</type>',
  '<content>',
  ...READ_SAMPLE_SOURCE.map((text, index) => `${READ_SAMPLE_FIRST_LINE + index}: ${text}`),
  '',
  `(Showing lines ${READ_SAMPLE_FIRST_LINE}-${READ_SAMPLE_LAST_LINE} of ${READ_SAMPLE_TOTAL}. Use offset=${READ_SAMPLE_LAST_LINE + 1} to continue.)`,
  '</content>',
].join('\n')

/**
 * The `web_search` result metadata for the web-search turn. The sources cover a
 * titled source with a snippet and date, a hostname-label fallback, and a
 * titled source without a snippet; `truncated` exercises the capped indicator.
 */
const WEB_SEARCH_META = {
  answer: 'DeepSeek Harness is a plugin-based agent harness on vendored Cordis where **every capability is a plugin**.',
  sources: [
    {
      url: 'https://github.com/deepseek-ai/deepseek-harness',
      title: 'DeepSeek Harness — plugin-based agent harness',
      snippet: 'Everything is a plugin: session, tools, agent-loop, and LLM adapters all mount on the same Cordis context.',
      publishedAt: '2026-07-01',
    },
    {
      url: 'https://www.deepseek.com/blog/harness-architecture',
      snippet: 'The capability-seam pattern splits each capability into interface, implementation, and consumer packages.',
    },
    {
      url: 'https://docs.deepseek.com/harness/plugins',
      title: 'Writing a harness plugin',
      publishedAt: '2026-06-15',
    },
  ],
  truncated: true,
} satisfies JsonValue

/** The `web_fetch` result metadata for the web-fetch turn. */
const WEB_FETCH_META = {
  url: 'https://www.deepseek.com/blog/harness-architecture',
  statusCode: 200,
  truncated: false,
} satisfies JsonValue

const DEEPSEEK_REASONING = {
  efforts: [
    { id: 'off', name: 'Off' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max' },
  ],
  defaultEffort: 'high',
}

const OPENAI_REASONING = {
  efforts: [
    { id: 'off', name: 'Off' },
    { id: 'medium', name: 'Medium' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max' },
  ],
  defaultEffort: 'medium',
}

/** Catalog served by `session/modelCatalog` (fresh copies per call). */
function fixtureModelGroups(): ModelProviderGroup[] {
  return [
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        {
          id: 'deepseek-v4-flash',
          name: 'DeepSeek-V4-Flash',
          description: '快速响应',
          reasoning: DEEPSEEK_REASONING,
        },
        {
          id: 'deepseek-v4-pro',
          name: 'DeepSeek-V4-Pro',
          description: '复杂任务',
          reasoning: DEEPSEEK_REASONING,
        },
      ],
    },
    {
      id: 'openai',
      name: 'OpenAI',
      models: [{ id: 'gpt-5', name: 'GPT-5', reasoning: OPENAI_REASONING }],
    },
  ]
}

function sid(id: string): SessionId {
  return id as SessionId
}

const FIXTURE_IMAGE_DATA = 'iVBORw0KGgoAAAANSUhEUgAAAKAAAABaCAYAAAA/xl1SAAAAvklEQVR42u3SMQ0AAAjAMIyhELM4AAe8PD1qYFlk9cCXEAEDYkAwIAYEA2JAMCAGBANiQDAgBgQDYkAwIAYEA2JAMCAGBANiQDAgBgQDYkAwIAYEA2JAMCAGxIBCYEAMCAbEgGBADAgGxIBgQAwIBsSAYEAMCAbEgGBADAgGxIBgQAwIBsSAYEAMCAbEgGBADAgGxIAYEAyIAcGAGBAMiAHBgBgQDIgBwYAYEAyIAcGAGBAMiAHBgBgQDIgB4bYWLb6pnOb1xAAAAABJRU5ErkJggg=='
const FIXTURE_IMAGE_REF: ImageAttachmentRef = {
  attachmentId: 'fixture:image' as AttachmentIdType,
  mediaType: 'image/png',
  bytes: 247,
  width: 160,
  height: 90,
  name: 'fixture-image.png',
}

/** Deterministic provider billing attached to fixture assistant messages. */
function fixtureUsage(turn: number, step: number): TokenUsage {
  return {
    inputTokens: 20 + turn % 5,
    outputTokens: 8 + step,
    cacheReadTokens: turn === 0 ? 0 : 80,
    cacheWriteTokens: turn % 10 === 0 ? 4 : 0,
  }
}

/** Build a lossless settled stream for static fixture messages. */
function fixtureSettledStream(
  message: AssistantMessage,
  usage: TokenUsage,
  time: number,
): AssistantStreamRecord[] {
  const stream: AssistantStreamRecord[] = []
  for (const [index, block] of message.content.entries()) {
    stream.push(
      { type: 'chunk', time, chunk: { type: 'block-start', index, blockType: block.type } },
      { type: 'chunk', time, chunk: { type: 'block-end', index, block } },
    )
  }
  stream.push(
    { type: 'chunk', time, chunk: { type: 'usage', usage } },
    { type: 'chunk', time, chunk: { type: 'finish', reason: { kind: 'stop' } } },
  )
  return stream
}

/** fx-alpha history script: 75 turns (~150+ messages -> 4 pages at PAGE_MESSAGES=50),
 *  mixing reasoning blocks / tool call+result / context. */
function buildAlphaLog(): SessionEvent[] {
  const events: Record<string, unknown>[] = []
  let time = Date.now() - 3_600_000
  const push = (e: Record<string, unknown>): number => {
    const seq = events.length
    const data = e['data'] as Record<string, unknown> | undefined
    const nextTime = time + 800
    const authored = e['type'] === 'assistant/message' && data !== undefined
      ? {
        ...e,
        data: {
          ...data,
          usage: fixtureUsage(data['turn'] as number, data['step'] as number),
          stream: fixtureSettledStream(
            data['message'] as AssistantMessage,
            fixtureUsage(data['turn'] as number, data['step'] as number),
            nextTime,
          ),
        },
      }
      : e
    events.push({ seq, time: (time = nextTime), ...authored })
    return seq
  }
  // Completed fixture requests retain the route capacity recorded with them.
  push({
    type: 'request/context',
    data: { provider: 'deepseek-official', model: 'deepseek-v4-flash', contextWindow: 128_000 },
  })
  for (let turn = 0; turn < 60; turn++) {
    push({ type: 'turn/start', data: { turn } })
    const userSeq = push({
      type: 'user/message', surfaceOp: 'append',
      data: userMessage(text(turn === 59 ? USER_MARKDOWN_LITERAL : `问题 ${turn}：fixture 历史消息，用于翻页与渲染验收。`)),
    })
    if (turn === 0) {
      push({
        type: 'session/title',
        data: { title: 'Fixture 历史会话', messageSeqs: [userSeq], source: { kind: 'fallback' } },
      })
    }
    if (turn % 9 === 4) {
      push({ type: 'user/message', surfaceOp: 'append', data: userMessage(text(`[fixture] 上下文注入（turn ${turn}）`), { kind: 'plugin', plugin: 'fixture' }) })
    }
    push({ type: 'step/start', data: { turn, step: 0 } })
    const withTool = turn % 5 === 2
    const withReasoning = turn % 3 === 1
    const blocks: ContentBlock[] = []
    if (withReasoning) blocks.push({ type: 'reasoning', text: `思考过程 ${turn}：这是一段可折叠的 reasoning 内容。` })
    blocks.push({ type: 'text', text: turn === 59 ? MARKDOWN_FIXTURE : `回答 ${turn}：这是 fixture 生成的历史回复正文。` })
    if (withTool) {
      const callId = `fx-call-${turn}`
      blocks.push({ type: 'tool-call', id: callId, name: 'echo', arguments: `{"text":"turn ${turn}"}` } as ContentBlock)
      push({ type: 'assistant/message', surfaceOp: 'append', data: { turn, step: 0, message: assistantMessage(blocks) } })
      push({ type: 'tool/call', data: { turn, step: 0, callId, name: 'echo', arguments: `{"text":"turn ${turn}"}` } })
      push({ type: 'tool/result', surfaceOp: 'append', data: { turn, step: 0, message: toolResultMessage(callId, text(`ECHO: TURN ${turn}`), turn % 25 === 12) } })
      push({ type: 'step/end', data: { turn, step: 0 } })
      push({ type: 'step/start', data: { turn, step: 1 } })
      push({ type: 'assistant/message', surfaceOp: 'append', data: { turn, step: 1, message: assistantMessage(text(`工具结果已消化（turn ${turn}）。`)) } })
      push({ type: 'step/end', data: { turn, step: 1 } })
    } else {
      push({ type: 'assistant/message', surfaceOp: 'append', data: { turn, step: 0, message: assistantMessage(blocks) } })
      push({ type: 'step/end', data: { turn, step: 0 } })
    }
    push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  // The structured samples use real first-party names and result metadata so
  // the fixture follows the same event-to-card path as a persisted Session.
  // `echo` above remains the unknown-tool fallback.
  const toolTurn = (
    turn: number,
    name: string,
    args: string,
    resultText: string,
    resultMeta?: JsonValue,
  ): void => {
    const callId = `fx-call-${turn}`
    push({ type: 'turn/start', data: { turn } })
    push({ type: 'user/message', surfaceOp: 'append', data: userMessage(text(`问题 ${turn}：${name} 样本。`)) })
    push({ type: 'step/start', data: { turn, step: 0 } })
    push({
      type: 'assistant/message', surfaceOp: 'append',
      data: { turn, step: 0, message: assistantMessage([{ type: 'tool-call', id: callId, name, arguments: args } as ContentBlock]) },
    })
    push({ type: 'tool/call', data: { turn, step: 0, callId, name, arguments: args } })
    push({
      type: 'tool/result',
      surfaceOp: 'append',
      data: {
        turn,
        step: 0,
        message: toolResultMessage(callId, text(resultText), false),
        ...resultMeta === undefined ? {} : { meta: resultMeta },
      },
    })
    push({ type: 'step/end', data: { turn, step: 0 } })
    push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  // A two-line command, so the fixture covers the terminal card's one-row-per-
  // command-line prompt (and that the card still marks the call exactly once).
  toolTurn(
    60,
    'bash',
    '{"command":"ls -la\\necho done","description":"fixture 终端样本","workdir":"/tmp/fixture"}',
    'total 2\ndrwxr-xr-x fixture\n-rw-r--r-- demo.txt',
  )
  toolTurn(
    61,
    'write',
    '{"file_path":"notes/demo.txt","content":"hello fixture\\n"}',
    'wrote notes/demo.txt',
    { diffs: [{ path: 'notes/demo.txt', oldText: null, newText: 'hello fixture\n' }] },
  )
  toolTurn(
    62,
    'edit',
    '{"file_path":"notes/demo.txt","old_string":"hello","new_string":"hello fixture"}',
    '已编辑',
    { diffs: [{ path: 'notes/demo.txt', oldText: 'hello', newText: 'hello fixture' }] },
  )
  toolTurn(
    63,
    'write',
    '{"file_path":"notes/new-demo.txt","content":"hello fixture\\n"}',
    '已写入',
    { diffs: [{ path: 'notes/new-demo.txt', oldText: null, newText: 'hello fixture\n' }] },
  )
  // Turn 64: a multi-hunk edit — two scattered replacements in one file. Named
  // `edit` so it lands on the keyed FileMutationRow (the resident diff card the
  // single-hunk turn 62 also uses). Its result metadata carries two scattered
  // hunks under one path header, so the card draws the first hunk, a `⋯` gap,
  // then the second (the same-file
  // second-hunk arm turns 62/63 cannot reach).
  toolTurn(
    64,
    'edit',
    '{"file_path":"src/config.ts","old_string":"const timeout = 30","new_string":"const timeout = 60"}',
    '已编辑',
    {
      diffs: [
        { path: 'src/config.ts', oldText: 'const timeout = 30', newText: 'const timeout = 60' },
        { path: 'src/config.ts', oldText: 'retries: 1', newText: 'retries: 3' },
      ],
    },
  )
  // Turn 65: one run_code turn with three logged sub-dispatches — the Code
  // Mode acceptance surface (parent code row + nested native-identical rows,
  // including an isError sub-call and a bash sub-call that must hit the same
  // keyed registration a top-level bash row uses).
  {
    const turn = 65
    const callId = `fx-call-${turn}`
    const program = 'const listing = await tools.bash({ command: "ls notes", description: "List notes" })\n'
      + 'const demo = await tools.read({ file_path: "notes/demo.txt" })\n'
      + 'await tools.read({ file_path: "notes/missing.txt" }).catch(() => "tolerated")\n'
      + 'return { listing, demo }'
    const args = JSON.stringify({ code: program, description: 'Read the notes files and summarize' })
    push({ type: 'turn/start', data: { turn } })
    push({ type: 'user/message', surfaceOp: 'append', data: userMessage(text(`问题 ${turn}：run_code 样本。`)) })
    push({ type: 'step/start', data: { turn, step: 0 } })
    push({
      type: 'assistant/message', surfaceOp: 'append',
      data: { turn, step: 0, message: assistantMessage([{ type: 'tool-call', id: callId, name: 'run_code', arguments: args } as ContentBlock]) },
    })
    push({ type: 'tool/call', data: { turn, step: 0, callId, name: 'run_code', arguments: args } })
    const dispatchPair = (n: number, name: string, dispatchArgs: Record<string, unknown>, resultText: string, isError = false): void => {
      push({
        type: 'tool/code-dispatch-start',
        data: { rootCallId: callId, parentCallId: callId, subCallId: `${callId}:code:${n}`, name, arguments: dispatchArgs },
      })
      push({
        type: 'tool/code-dispatch',
        data: {
          rootCallId: callId, parentCallId: callId, subCallId: `${callId}:code:${n}`, name,
          arguments: dispatchArgs, isError, content: [{ type: 'text', text: resultText }],
        },
      })
    }
    dispatchPair(1, 'bash', { command: 'ls notes', description: 'List notes' }, 'demo.txt\nnew-demo.txt')
    dispatchPair(2, 'read', { file_path: 'notes/demo.txt' }, 'hello fixture\n')
    dispatchPair(3, 'read', { file_path: 'notes/missing.txt' }, 'Error: ENOENT: notes/missing.txt not found', true)
    push({
      type: 'tool/result', surfaceOp: 'append',
      data: { turn, step: 0, message: toolResultMessage(callId, text('{"listing":"demo.txt\\nnew-demo.txt","demo":"hello fixture\\n"}'), false) },
    })
    push({ type: 'step/end', data: { turn, step: 0 } })
    push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  // Turn 74: todo_write sample — the TodoRow toolview in the flow plus the
  // todo/write snapshot event feeding the TodoPanel plan strip. Two items are
  // in_progress: this fixture chooses the parallel policy, so both surfaces
  // must render a parallel plan rather than the first active item alone.
  const fixtureTodos = [
    { content: '梳理需求', status: 'completed' },
    { content: '实现 fixture 样本', status: 'in_progress' },
    { content: '跑后台构建', status: 'in_progress' },
    { content: '浏览器验收', status: 'pending' },
  ]
  // Turn 66: the terminal sample turn 60's two clean prompt rows cannot cover —
  // ANSI SGR coloring, output past the terminal card's height cap, a nested cwd
  // whose prompt label is its last segment, and a non-zero exit. The raw result
  // includes an `[exit code: N]` marker below; Client
  // derivation consumes it into the status pill before rendering the body.
  //
  // Ordered BEFORE the todo turn deliberately: the standing plan retires at the
  // next `turn/start`, so a turn appended after it would leave the dock's plan
  // strip empty and take the todo surfaces' own coverage with it.
  toolTurn(
    66,
    'bash',
    '{"command":"pnpm run check","description":"fixture 终端样本","workdir":"/tmp/fixture/deep/nested"}',
    `${TERMINAL_OUTPUT_FIXTURE}\n[exit code: 1]`,
  )

  // Turns 67-68 carry the search card's two metadata variants: grouped matches
  // and a flat path list, both truncated with a larger pre-cap total. Both use
  // the keyed SearchRow registration. They stay before the todo turn for the
  // same standing-plan reason as the bash turn.
  toolTurn(
    67,
    'grep',
    '{"pattern":"SEARCH_MAX_LINES","path":"packages/client"}',
    SEARCH_MATCHES_TEXT,
    { shape: 'matches', files: SEARCH_MATCHES_FIXTURE, truncated: true, total: 42 },
  )
  toolTurn(
    68,
    'glob',
    '{"pattern":"**/SearchBlock*","path":"packages/client"}',
    SEARCH_PATHS_TEXT,
    { shape: 'paths', paths: SEARCH_PATHS_FIXTURE, truncated: true, total: 23 },
  )

  // Turn 69: the read sample — a WINDOW past an offset so the card draws file
  // line numbers starting above 1 and a "showing N of M" note (the window is
  // shorter than READ_SAMPLE_TOTAL), with a `ts` language hint the shiki path
  // highlights. Named `read`, so it exercises the keyed ReadRow registration.
  // The run_code sub-dispatches above cover nested read calls without result
  // metadata; this top-level result carries the structured window.
  toolTurn(
    69,
    'read',
    `{"file_path":${JSON.stringify(READ_SAMPLE_PATH)},"offset":${READ_SAMPLE_FIRST_LINE}}`,
    READ_SAMPLE_TEXT,
    {
      path: READ_SAMPLE_PATH,
      offset: READ_SAMPLE_FIRST_LINE,
      lines: READ_SAMPLE_LINES,
      totalLines: READ_SAMPLE_TOTAL,
      lang: 'ts',
    },
  )

  // Turns 70-71 carry the web tools' result metadata. They stay before the todo
  // turn because a later turn/start retires the standing plan projection.
  toolTurn(
    70,
    'web_search',
    '{"queries":["deepseek harness architecture"]}',
    'Search results for deepseek harness architecture.',
    WEB_SEARCH_META,
  )
  toolTurn(
    71,
    'web_fetch',
    '{"url":"https://www.deepseek.com/blog/harness-architecture"}',
    '# Harness architecture\n\nEverything is a plugin.',
    WEB_FETCH_META,
  )

  // Turn 72: max-tokens sample — the provider ends the turn at its output cap
  // mid-sentence, so the chat flow must render the turn-max-tokens notice
  // instead of ending silently. Ordered before the todo turn for the same
  // standing-plan reason the bash turn is.
  push({ type: 'turn/start', data: { turn: 72 } })
  push({ type: 'user/message', surfaceOp: 'append', data: userMessage(text('问题 72：请完整列出全部一百条条目。')) })
  push({ type: 'step/start', data: { turn: 72, step: 0 } })
  push({
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { turn: 72, step: 0, message: assistantMessage(text('条目 1：第一条。条目 2：第二条。条目 3：这一条写到一半被')) },
  })
  push({ type: 'step/end', data: { turn: 72, step: 0 } })
  push({ type: 'turn/end', data: { turn: 72, reason: { kind: 'max-tokens' } } })

  // Turn 73: user and assistant images share one durable fixture object.
  // The todo turn remains last so its standing projection stays visible.
  push({ type: 'turn/start', data: { turn: 73 } })
  push({
    type: 'user/message',
    surfaceOp: 'append',
    data: userMessage([{ type: 'image', attachment: FIXTURE_IMAGE_REF }, ...text('历史用户图片')]),
  })
  push({ type: 'step/start', data: { turn: 73, step: 0 } })
  push({
    type: 'assistant/message',
    surfaceOp: 'append',
    data: {
      turn: 73,
      step: 0,
      message: assistantMessage(
        [...text('结构化模型图片：'), { type: 'image', attachment: FIXTURE_IMAGE_REF }],
        'fx-vision',
      ),
    },
  })
  push({ type: 'step/end', data: { turn: 73, step: 0 } })
  push({ type: 'turn/end', data: { turn: 73, reason: { kind: 'completed' } } })

  const todoArgs = JSON.stringify({ todos: fixtureTodos })
  toolTurn(74, 'todo_write', todoArgs, 'Updated todo list: 1 pending, 2 in progress, 1 completed.')
  // The real tool appends the snapshot mid-execution — between tool/call and
  // tool/result — so the fixture reproduces that exact ordering (the last
  // toolTurn events run ... tool/call, tool/result, step/end, turn/end).
  const callIndex = events.length - 4
  const callTime = events[callIndex]?.time as number
  events.splice(callIndex + 1, 0, { type: 'todo/write', time: callTime + 400, data: { todos: fixtureTodos } })
  events.forEach((e, i) => { e.seq = i })
  return events as unknown as SessionEvent[]
}

/**
 * Fixture parallel of the plan unit's lifecycle fold. The paired
 * `command/done` retains successful plan selections and drops failures;
 * `plan/mode` commits one. `wanted` is exposed for the prompt boundary (the
 * fixture's step/start parallel).
 */
function foldPlan(log: readonly SessionEvent[]): { active: boolean; pending: boolean; wanted: boolean | null } {
  let active = false
  let wanted: boolean | null = null
  let running: { commandId: unknown; wanted: boolean } | null = null
  for (const event of log) {
    const item = event as unknown as { type: string; data?: Record<string, unknown> }
    if (item.type === 'command/run' && item.data?.['name'] === 'plan') {
      const args = item.data['args']
      if (typeof args !== 'string') continue
      running = { commandId: item.data['commandId'], wanted: args.trim() !== 'off' }
    } else if (item.type === 'command/done'
      && item.data !== undefined
      && running !== null
      && item.data['commandId'] === running.commandId) {
      wanted = item.data['kind'] === 'success' && running.wanted !== active ? running.wanted : null
      running = null
    } else if (item.type === 'plan/mode') {
      active = item.data?.['active'] === true
      wanted = null
    }
  }
  const selected = running?.wanted ?? wanted
  return { active, pending: selected !== null && selected !== active, wanted: selected }
}

/** The plan projection's wire view over the full log. */
function planViewOf(log: readonly SessionEvent[]): { active: boolean; pending: boolean } {
  const plan = foldPlan(log)
  return { active: plan.active, pending: plan.pending }
}

/** Fixture parallel of the host's projection units: whole current values per key over the full log. */
/** Fixture preset table (the host PermissionPresetService defaults). */
const PERMISSION_PRESETS: Record<string, { sandbox: string; approval: string; description: string }> = {
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask', description: 'Write inside the workspace and permitted temporary directories; wider retries require approval.' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never', description: 'Full file access without approval prompts.' },
}

/** Host permissions-unit parallel: fold the three knob events, derive the select over the fixture defaults. */
function permissionSelectOf(
  log: readonly SessionEvent[],
): { options: { value: string; name: string; description?: string }[]; currentValue: string } {
  let preset: string | null = null
  let sandbox = 'workspace-write'
  let approval = 'ask'
  for (const event of log) {
    const item = event as { type: string; data: Record<string, unknown> }
    if (item.type === 'permission/preset') preset = item.data['preset'] as string
    else if (item.type === 'sandbox/mode') sandbox = item.data['mode'] as string
    else if (item.type === 'approval/policy') approval = item.data['policy'] as string
  }
  const matches = (spec: { sandbox: string; approval: string }): boolean => spec.sandbox === sandbox && spec.approval === approval
  let currentValue = 'custom'
  const folded = preset === null ? undefined : PERMISSION_PRESETS[preset]
  if (preset !== null && folded !== undefined && matches(folded)) {
    currentValue = preset
  } else {
    for (const [name, spec] of Object.entries(PERMISSION_PRESETS)) {
      if (matches(spec)) { currentValue = name; break }
    }
  }
  return {
    options: [
      ...Object.entries(PERMISSION_PRESETS).map(([value, spec]) => ({ value, name: value, description: spec.description })),
      ...currentValue === 'custom' ? [{ value: 'custom', name: 'Custom', description: 'Current sandbox and approval settings do not match a preset.' }] : [],
    ],
    currentValue,
  }
}

interface FixtureTokenUsageProjection {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

interface FixtureUsageSample {
  turn: number
  step: number
  usage: TokenUsage
}

/** Read one provider usage sample from either durable carrier. */
function usageSampleOf(event: SessionEvent): FixtureUsageSample | undefined {
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  let usage = event.type === 'assistant/message' ? event.data.usage : undefined
  for (const member of expandAssistantStream(event.data.stream)) {
    if (member.chunk.type === 'usage') usage = member.chunk.usage
  }
  return usage === undefined
    ? undefined
    : { turn: event.data.turn, step: event.data.step, usage }
}

/** Fixture parallel of token-meter's last-sample-replacing usage projection. */
function tokenUsageOf(log: readonly SessionEvent[]): FixtureTokenUsageProjection {
  const totals: FixtureTokenUsageProjection = {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
  let last: {
    turn: number
    step: number
    buckets: FixtureTokenUsageProjection
  } | null = null
  for (const event of log) {
    const sample = usageSampleOf(event)
    if (sample === undefined) continue
    const buckets: FixtureTokenUsageProjection = {
      uncachedInputTokens: sample.usage.inputTokens,
      outputTokens: sample.usage.outputTokens,
      cacheReadTokens: sample.usage.cacheReadTokens ?? 0,
      cacheWriteTokens: sample.usage.cacheWriteTokens ?? 0,
    }
    const previous = last?.turn === sample.turn && last.step === sample.step
      ? last.buckets
      : undefined
    totals.uncachedInputTokens += buckets.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0)
    totals.outputTokens += buckets.outputTokens - (previous?.outputTokens ?? 0)
    totals.cacheReadTokens += buckets.cacheReadTokens - (previous?.cacheReadTokens ?? 0)
    totals.cacheWriteTokens += buckets.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0)
    last = { turn: sample.turn, step: sample.step, buckets }
  }
  return totals
}

/** Fixture parallel of session-stats' whole-log counting and wall-time fold. */
function sessionStatsOf(log: readonly SessionEvent[]): {
  turns: number
  steps: number
  llmMs: number
  toolMs: number
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  decodeTokens: number
} {
  const value = { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 }
  let lastTurn: number | null = null
  let openStep: { turn: number; step: number; startTime: number; firstTokenTime: number | null } | null = null
  const pendingCalls = new Map<string, number>()
  for (const event of log) {
    switch (event.type) {
      case 'step/start':
        openStep = { turn: event.data.turn, step: event.data.step, startTime: event.time, firstTokenTime: null }
        break
      case 'assistant/attempt': {
        if (openStep === null || openStep.turn !== event.data.turn || openStep.step !== event.data.step) break
        const first = expandAssistantStream(event.data.stream)
          .find(member => isFixtureTokenDelta(member.chunk))?.time
        if (openStep.firstTokenTime === null && first !== undefined) openStep.firstTokenTime = first
        break
      }
      case 'assistant/message': {
        if (openStep === null || openStep.turn !== event.data.turn || openStep.step !== event.data.step) break
        const first = expandAssistantStream(event.data.stream)
          .find(member => isFixtureTokenDelta(member.chunk))?.time
        if (openStep.firstTokenTime === null && first !== undefined) openStep.firstTokenTime = first
        value.llmMs += Math.max(0, event.time - openStep.startTime)
        if (openStep.firstTokenTime !== null) {
          value.ttftMs += Math.max(0, openStep.firstTokenTime - openStep.startTime)
          value.ttftSteps += 1
          const outputTokens = event.data.usage?.outputTokens
          if (typeof outputTokens === 'number' && Number.isFinite(outputTokens) && outputTokens >= 0) {
            value.decodeMs += Math.max(0, event.time - openStep.firstTokenTime)
            value.decodeTokens += outputTokens
          }
        }
        openStep = null
        break
      }
      case 'tool/call':
        pendingCalls.set(event.data.callId, event.time)
        break
      case 'tool/result': {
        const callId = event.data.message.source.callId
        const dispatched = pendingCalls.get(callId)
        if (dispatched === undefined) break
        pendingCalls.delete(callId)
        value.toolMs += Math.max(0, event.time - dispatched)
        break
      }
      case 'step/end':
        if (event.data.turn !== lastTurn) {
          value.turns += 1
          lastTurn = event.data.turn
        }
        value.steps += 1
        openStep = null
        break
      case 'turn/end':
        pendingCalls.clear()
        break
      default:
        break
    }
  }
  return value
}

interface FixtureRequestContext {
  provider: string
  model: string
  contextWindow?: number
}

interface FixtureContextBreakdownProjection {
  systemTokens: number
  toolsTokens: number
  messageTokens: number
}

/** Fixed token-meter heuristic constants mirrored by this client-only fixture. */
const CHARS_PER_TOKEN = 4
const BLOCK_OVERHEAD = 4
const ROLE_OVERHEAD = 4

/** Price fixture content with token-meter's fixed-density heuristic. */
function estimateFixtureContent(blocks: readonly ContentBlock[]): number {
  const densityPrice = (value: string): number => Math.ceil(value.length / CHARS_PER_TOKEN)
  return blocks.reduce((tokens, block) => {
    if (block.type === 'text' || block.type === 'reasoning') {
      return tokens + densityPrice(block.text) + BLOCK_OVERHEAD
    }
    if (block.type === 'tool-call') {
      return tokens + densityPrice(block.name) + densityPrice(block.arguments) + BLOCK_OVERHEAD
    }
    // ContentBlockMap is merge-extensible: this client graph sees only the
    // base four members, but fixture turns do carry extended blocks at
    // runtime, so the structural JSON fallback below is live code.
    if (block.type === 'tool-result') {
      return tokens + estimateFixtureContent(block.content) + BLOCK_OVERHEAD
    }
    return tokens + densityPrice(JSON.stringify(block)) + BLOCK_OVERHEAD
  }, 0)
}

/** Fixture parallel of token-meter's heuristic context-composition projection. */
function contextBreakdownOf(log: readonly SessionEvent[]): FixtureContextBreakdownProjection {
  const headerEvent = log.findLast(event => event.type === 'request/header')
  const header = headerEvent === undefined
    ? undefined
    : headerEvent.data.header
  let messageTokens = 0
  for (const seq of foldSurface(log).nodes) {
    const event = log[seq]
    if (event === undefined) continue
    const message = deriveEventMessage(event)
    if (message !== null) messageTokens += estimateFixtureContent(message.content) + ROLE_OVERHEAD
  }
  return {
    systemTokens: header?.system === undefined
      ? 0
      : Math.ceil(header.system.length / CHARS_PER_TOKEN) + ROLE_OVERHEAD,
    toolsTokens: header?.tools === undefined || header.tools.length === 0
      ? 0
      : Math.ceil(JSON.stringify(header.tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD,
    messageTokens,
  }
}

/** Latest log-only route context, or undefined before any request ran. */
function lastRequestContext(
  log: readonly SessionEvent[],
): FixtureRequestContext | undefined {
  const event = log.findLast(item => (item as { type: string }).type === 'request/context')
  return event === undefined
    ? undefined
    : (event as unknown as { data: FixtureRequestContext }).data
}

/**
 * Fixture parallel of token-meter's request-pressure projection: the last
 * provider-reported prompt size paired with the last recorded capacity. The
 * two need not come from one request — see the token-meter README. The host's
 * `projectedTokens` is deliberately absent: reproducing it would mean
 * reimplementing the estimator client-side, and every consumer falls back to
 * the bare sample, so a fixture-driven view simply lags a compaction the way
 * the projection did before that field existed.
 */
function contextPressureOf(
  log: readonly SessionEvent[],
): { pressureTokens?: number; contextWindow?: number } {
  let pressureTokens: number | undefined
  for (const event of log) {
    const sample = usageSampleOf(event)
    if (sample === undefined) continue
    pressureTokens = sample.usage.inputTokens
      + (sample.usage.cacheReadTokens ?? 0)
      + (sample.usage.cacheWriteTokens ?? 0)
  }
  const contextWindow = lastRequestContext(log)?.contextWindow
  return {
    ...pressureTokens === undefined ? {} : { pressureTokens },
    ...contextWindow === undefined ? {} : { contextWindow },
  }
}

function projectionValuesOf(log: readonly SessionEvent[]): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  values['modelSelection'] = modelSelectionProjectionOf(log)
  const titleEvent = log.findLast(item => (item as { type: string }).type === 'session/title')
  if (titleEvent !== undefined) {
    values['title'] = (titleEvent as unknown as { data: { title: string } }).data.title
  }
  // Always present (tool-todo unit composed): null when no plan stands.
  values['todos'] = backscanTodos(log) ?? null
  // Always present (permission service composed): the whole select.
  values['permissions'] = permissionSelectOf(log)
  // Always present (plan-mode unit composed): the {active, pending} view.
  values['plan'] = planViewOf(log)
  // Always present (GoalService unit composed): null before create / after clear.
  values['goal'] = backscanGoal(log)
  // Always present (token-meter composed): full-log provider billing.
  values['tokenUsage'] = tokenUsageOf(log)
  // Always present (token-meter composed): last request pressure and capacity.
  values['contextPressure'] = contextPressureOf(log)
  // Always present (token-meter composed): heuristic request composition.
  values['contextBreakdown'] = contextBreakdownOf(log)
  // Always present (session-stats unit composed): whole-log turn/step counts.
  values['sessionStats'] = sessionStatsOf(log)
  // Always present (attachment service composed): the deployment image
  // limits, constant per boot (mirrors the attachment-local defaults).
  // Deliberate host divergence: the real gateway never pushes an imageLimits
  // change frame (constant unit), but the fixture's uniform baseline replay
  // frames every key here, incidentally exercising higher-seq-wins.
  values['imageLimits'] = {
    maxImageBytes: 5 * 1024 * 1024,
    maxImagesPerMessage: 20,
    maxMessageImageBytes: 100 * 1024 * 1024,
    maxImagePixels: 40_000_000,
    maxImageDimension: 2000,
    mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  }
  return values
}

function modelSelectionProjectionOf(log: readonly SessionEvent[]): {
  lastUsed: ModelSelection | null
  next: ModelSelection | null
} {
  let lastUsed: ModelSelection | null = null
  let pending: ModelSelection | null = null
  for (const event of log) {
    if ((event as { type: string }).type === 'model/selection') {
      pending = (event as unknown as { data: ModelSelection }).data
      continue
    }
    if (event.type !== 'request/header') continue
    lastUsed = {
      provider: event.data.header.config.provider,
      model: event.data.header.config.model,
      ...(event.data.header.config.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: event.data.header.config.reasoningEffort }),
    }
    if (sameModelSelection(pending, lastUsed)) pending = null
  }
  return { lastUsed, next: pending ?? lastUsed }
}

function sameModelSelection(left: ModelSelection | null, right: ModelSelection | null): boolean {
  return left === right || (left !== null && right !== null
    && left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort)
}

/** Host parallel: emit one Session control projection frame per key advanced by the event. */
function projectionFramesOf(
  id: SessionId,
  log: readonly SessionEvent[],
  event: SessionEvent,
): FixtureProjectionFrame[] {
  const type = (event as { type: string }).type
  const frames: FixtureProjectionFrame[] = []
  if (type === 'model/selection' || type === 'request/header') {
    frames.push({
      type: 'projection',
      sessionId: id,
      key: 'modelSelection',
      value: modelSelectionProjectionOf(log),
      seq: event.seq,
    })
  }
  // One usage sample advances both token-meter units.
  if (usageSampleOf(event) !== undefined) {
    frames.push(
      { type: 'projection', sessionId: id, key: 'tokenUsage', value: tokenUsageOf(log), seq: event.seq },
      { type: 'projection', sessionId: id, key: 'contextPressure', value: contextPressureOf(log), seq: event.seq },
    )
  }
  if (type === 'request/context') {
    frames.push({
      type: 'projection',
      sessionId: id,
      key: 'contextPressure',
      value: contextPressureOf(log),
      seq: event.seq,
    })
  }
  if (type === 'request/header'
    || type === 'user/message'
    || type === 'assistant/message'
    || type === 'tool/result') {
    frames.push({
      type: 'projection',
      sessionId: id,
      key: 'contextBreakdown',
      value: contextBreakdownOf(log),
      seq: event.seq,
    })
  }
  // The stats fold's view advances on message assembly and tool settlement
  // (wall times) and on step close (counts).
  if (type === 'assistant/message' || type === 'tool/result' || type === 'step/end') {
    frames.push({
      type: 'projection',
      sessionId: id,
      key: 'sessionStats',
      value: sessionStatsOf(log),
      seq: event.seq,
    })
  }
  if (frames.length > 0) return frames
  if (type === 'session/title') {
    const values = projectionValuesOf(log)
    /* v8 ignore next -- the advancing title event is in the log, so the key is present. */
    if (!Object.hasOwn(values, 'title')) return []
    return [{ type: 'projection', sessionId: id, key: 'title', value: values['title'], seq: event.seq }]
  }
  // The goal domain's own durable change advances its projection.
  if (type === 'goal/change') {
    return [{ type: 'projection', sessionId: id, key: 'goal', value: backscanGoal(log), seq: event.seq }]
  }
  // Standing-plan fold: writes replace the list; turn/start clears it (null).
  if (type === 'todo/write' || type === 'turn/start') {
    return [{
      type: 'projection',
      sessionId: id,
      key: 'todos',
      value: backscanTodos(log) ?? null,
      seq: event.seq,
    }]
  }
  // Knob fold: any of the three whole-value knob events advances the select.
  if (type === 'permission/preset' || type === 'sandbox/mode' || type === 'approval/policy') {
    return [{
      type: 'projection',
      sessionId: id,
      key: 'permissions',
      value: permissionSelectOf(log),
      seq: event.seq,
    }]
  }
  // The plan unit advances on its two folded event kinds when the command
  // lifecycle contains the input that represents a plan selection.
  const commandData = event as unknown as { data: { name?: string; args?: unknown } }
  if (type === 'plan/mode' || (type === 'command/run'
    && commandData.data.name === 'plan' && typeof commandData.data.args === 'string')) {
    return [{
      type: 'projection',
      sessionId: id,
      key: 'plan',
      value: planViewOf(log),
      seq: event.seq,
    }]
  }
  return []
}

/**
 * Message-boundary paging mirrors the Host contract: count `maxMessages`
 * backwards from the end and cut at a turn/start boundary.
 */
function pageOf(
  log: readonly SessionEvent[],
  beforeSeq: number | undefined,
  maxMessages: number,
): { records: FixtureHistoryRecord[]; hasMore: boolean } {
  const end = beforeSeq === undefined ? log.length : Math.max(0, Math.min(beforeSeq, log.length))
  let start = 0
  let messages = 0
  for (let i = end - 1; i >= 0; i--) {
    const event = log[i]
    /* v8 ignore next -- dense-array guard: log seqs are array indexes, i stays within [0, end). */
    if (event === undefined) break
    if (event.type === 'user/message' || event.type === 'assistant/message') messages++
    if (event.type === 'turn/start' && messages >= maxMessages) {
      start = i
      break
    }
  }
  const records = log.slice(start, end).map((event): FixtureHistoryRecord => ({ type: 'event', event }))
  return { records, hasMore: start > 0 }
}

/** Fixture mirror of host session-scoped attachment authorization. */
function logReferencesAttachment(log: readonly SessionEvent[], attachmentId: string): boolean {
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(visit)
    if (typeof value !== 'object' || value === null) return false
    const record = value as Record<string, unknown>
    if (record.attachmentId === attachmentId) return true
    return Object.values(record).some(visit)
  }
  return log.some(event => visit(event.data))
}

/** Fixture mirror of first-party message extraction used by session-query. */
function searchBlockText(block: ContentBlock): string[] {
  switch (block.type) {
    case 'text':
      return [block.text]
    case 'reasoning':
      return []
    case 'tool-call':
      return [block.name, block.arguments]
    case 'tool-result':
      return block.content.flatMap(searchBlockText)
    default:
      return []
  }
}

/** One current-surface user/assistant document, if searchable. */
function searchEventText(event: SessionEvent): string {
  const content = event.type === 'user/message'
    ? event.data.content
    : event.type === 'assistant/message'
      ? event.data.message.content
      : undefined
  if (content === undefined) return ''
  return content.flatMap(searchBlockText).map(part => part.trim()).filter(Boolean).join('\n')
}

interface FixtureSearchToken {
  value: string
  /** Inclusive code-point offset in the whitespace-normalized display text. */
  start: number
  /** Exclusive code-point offset in the whitespace-normalized display text. */
  end: number
}

/**
 * Browser-safe approximation of SQLite FTS5 unicode61 token boundaries.
 * Keeping phrase matching token-based prevents the development fixture from
 * promising arbitrary within-token substring behavior that production lacks.
 */
function searchTokenSpans(value: string): { text: string; tokens: FixtureSearchToken[] } {
  const text = value.replace(/\s+/gu, ' ').trim()
  const characters = Array.from(text)
  const tokens: FixtureSearchToken[] = []
  let start: number | undefined
  let raw = ''
  const flush = (end: number): void => {
    if (start !== undefined) {
      const folded = raw.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase()
      if (folded !== '') tokens.push({ value: folded, start, end })
    }
    start = undefined
    raw = ''
  }
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index] as string
    const tokenBase = character.normalize('NFD').replace(/\p{M}+/gu, '')
    if (tokenBase === '') {
      if (start !== undefined) raw += character
      continue
    }
    if (/^[\p{L}\p{N}\p{Co}]+$/u.test(tokenBase)) {
      start ??= index
      raw += character
    } else {
      flush(index)
    }
  }
  flush(characters.length)
  return { text, tokens }
}

interface FixturePhraseMatch {
  count: number
  start: number
  end: number
}

/** Count exact contiguous token-phrase occurrences and retain the first display span. */
function phraseMatch(document: readonly FixtureSearchToken[], phrase: readonly string[]): FixturePhraseMatch {
  if (phrase.length === 0 || phrase.length > document.length) return { count: 0, start: 0, end: 0 }
  let count = 0
  let firstStart = 0
  let firstEnd = 0
  for (let start = 0; start <= document.length - phrase.length; start++) {
    if (!phrase.every((token, offset) => document[start + offset]?.value === token)) continue
    count++
    if (count === 1) {
      firstStart = document[start]?.start ?? 0
      firstEnd = document[start + phrase.length - 1]?.end ?? firstStart
    }
  }
  return { count, start: firstStart, end: firstEnd }
}

/** Match-centered fixture excerpt, bounded by Unicode code points for the sidebar. */
function searchSnippet(value: string, matchStart: number, matchEnd: number): string {
  const characters = Array.from(value)
  if (characters.length <= 120) return value
  const boundedStart = Math.min(Math.max(0, matchStart), characters.length - 1)
  const boundedEnd = Math.min(
    characters.length,
    Math.max(boundedStart + 1, matchEnd),
  )
  const center = Math.floor((boundedStart + boundedEnd) / 2)
  let start = Math.min(
    characters.length - 118,
    Math.max(0, center - Math.floor(118 / 2)),
  )
  let end = start + 118
  if (start === 0) {
    end = 119
  } else if (end === characters.length) {
    start = characters.length - 119
  }
  return `${start > 0 ? '…' : ''}${characters.slice(start, end).join('')}${end < characters.length ? '…' : ''}`
}

interface FixtureSearchCandidate {
  sessionId: SessionId
  seq: number
  time: number
  text: string
  matchCount: number
  matchStart: number
  matchEnd: number
  documentLength: number
}

/** Mirrors `packages/session-query/session-query-sqlite/src/index.ts`; update both together. */
function compareSearchCandidates(a: FixtureSearchCandidate, b: FixtureSearchCandidate): number {
  if (a.matchCount !== b.matchCount) return b.matchCount - a.matchCount
  if (a.documentLength !== b.documentLength) return a.documentLength - b.documentLength
  if (a.time !== b.time) return b.time - a.time
  if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1
  return b.seq - a.seq
}

/**
 * Current plan projection over the full log (host parallel: latest todo/write
 * with no later turn/start; a new turn retires the previous plan).
 */
function backscanTodos(log: readonly SessionEvent[]): TodoItem[] | undefined {
  for (let i = log.length - 1; i >= 0; i--) {
    const event = log[i]
    if (event === undefined) continue
    if (event.type === 'turn/start') return undefined
    if (event.type === 'todo/write') return event.data.todos
  }
  return undefined
}

/** Fixture-local mirror of the goal projection value (dsh-goal's GoalProjection shape). */
interface FxGoalProjection {
  goal: {
    id: string
    revision: number
    objective: string
    phase: 'active' | 'paused' | 'blocked' | 'complete'
    maxGoalRounds: number
  }
  roundsStarted: number
  createdAt: number
  updatedAt: number
}

/** One durable goal change. */
type FxGoalChange =
  | { kind: 'goal/change'; version: 1; operation: 'clear'; cleared: { id: string; revision: number }; clearedAt: number }
  | {
    kind: 'goal/change'
    version: 1
    operation: 'create' | 'edit' | 'pause' | 'resume' | 'complete'
    goal: FxGoalProjection['goal']
    roundsStarted: number
    createdAt: number
    updatedAt: number
  }

/**
 * Current goal projection over the full log (host parallel: the GoalService
 * unit's last-wins fold of goal/change whole values; clear returns null).
 */
function backscanGoal(log: readonly SessionEvent[]): FxGoalProjection | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const event = log[i] as unknown as {
      type: string
      data?: FxGoalChange
    } | undefined
    if (event === undefined || event.type !== 'goal/change' || event.data === undefined) continue
    const change = event.data
    if (change.operation === 'clear') return null
    return { goal: change.goal, roundsStarted: change.roundsStarted, createdAt: change.createdAt, updatedAt: change.updatedAt }
  }
  return null
}

interface StreamConn<Value> {
  push(value: Value): void
}

interface ReasoningChunkStormState {
  sessionId: string
  chunkCount: number
  chunksPerInterval: number
  intervalMs: number
  emitted: number
  marker: string
  emitting: boolean
}

/** Deterministic fixture branches used by keyless Web assembly tests. */
export interface FixtureOptions {
  /** Start with no real Workspace or Session. */
  empty?: boolean
  /** Reject every prompt before appending its user event. */
  rejectPrompt?: boolean
  /** Publish the Session but fail its Workspace account write. */
  failWorkspaceAttach?: boolean
  /** Publish and frame the Session, then throw instead of returning create. */
  dropSessionCreateResponse?: boolean
  /** Order of the two successful create frames. */
  createFrameOrder?: 'session-first' | 'workspace-first'
}

/** Inbox pump shared by both stream generators (FrameQueue pattern: ONE abort listener hung
 *  outside the loop — a per-iteration {once:true} listener never fires for non-final rounds and
 *  piles up for the stream's lifetime). breakNow force-ends the stream without the
 *  client's signal (timing hook: simulated connection loss). */
class FxInbox<Value> implements StreamConn<Value> {
  private readonly inbox: Value[] = []
  private wake: (() => void) | null = null
  private broken = false

  push(value: Value): void {
    this.inbox.push(value)
    this.wake?.()
  }

  breakNow(): void {
    this.broken = true
    this.wake?.()
  }

  /** Read through a method: breakNow()/abort flip state across yields, so narrowing from the loop condition must not stick. */
  private isLive(signal: AbortSignal): boolean {
    return !signal.aborted && !this.broken
  }

  async *drain(signal: AbortSignal): AsyncGenerator<Value> {
    const onAbort = (): void => this.wake?.()
    signal.addEventListener('abort', onAbort)
    try {
      while (this.isLive(signal)) {
        while (this.inbox.length > 0) yield this.inbox.shift() as Value
        if (!this.isLive(signal)) break
        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
        this.wake = null
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
}

/** Fixture RPC face over one in-memory state graph. */
export interface FixtureWorld {
  /** Generic Remote caller for the endpoints business services own. */
  readonly rpc: ClientConnectionRpc
}

/**
 * Build the fixture RPC face over one in-memory state graph.
 * @param options - fixture branches for empty state and failure timing.
 * @returns the Remote RPC face.
 */
export function createFixtureFaces(options: FixtureOptions = {}): FixtureWorld {
  return createFixtureWorld(options)
}

/** Build the fixture's Remote RPC face over one state graph. */
function createFixtureWorld(options: FixtureOptions): FixtureWorld {
  // The resident fixture sessions all carry history, so none of them is blank.
  const sessions: FixtureSessionSummary[] = options.empty ? [] : [
    { sessionId: sid('fx-alpha'), updatedAt: Date.now(), running: true, blank: false, cwd: '/tmp/fixture' },
    { sessionId: sid('fx-beta'), updatedAt: Date.now() - 60_000, running: false, blank: false, parentSessionId: sid('fx-alpha'), cwd: '/tmp/fixture' },
    { sessionId: sid('fx-gamma'), updatedAt: Date.now() - 120_000, running: false, blank: false, cwd: '/tmp/fixture' },
  ]
  const logs = new Map<SessionId, SessionEvent[]>([[sid('fx-alpha'), buildAlphaLog()]])
  const modelSelections = new Map<SessionId, ModelSelection>(sessions.map(session => [
    session.sessionId,
    { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  ]))
  const attachments = new Map<string, { attachment: ImageAttachmentRef; data: string }>([[
    String(FIXTURE_IMAGE_REF.attachmentId),
    { attachment: FIXTURE_IMAGE_REF, data: FIXTURE_IMAGE_DATA },
  ]])
  /** Credential store double: set/unset flip the describe badge, values never read back. */
  const fixtureCredentials = new Map<string, true>([
    // The assembled fixture represents an already-configured shipped
    // DeepSeek route so unrelated GUI journeys do not enter first-run setup.
    ['DEEPSEEK_API_KEY', true],
  ])

  /** Canonical fixture implementation of the generated Settings Remote contract. */
  const settingsRemotes = {
    // Only the resolved DeepSeek address needed by first-run readiness is
    // represented here. Fixture-backed journeys do not open its Models editor;
    // real schema-driven forms ride the HTTP transport.
    describe(): RpcResult<SettingsDescribeValue> {
      return {
        ok: true,
        value: {
          writable: true,
          hasDocument: true,
          namespaces: [{
            ns: 'llm-deepseek',
            schema: {},
            value: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
            applies: 'live',
            secrets: [{ path: ['apiKey'], set: false }],
            revision: 0,
          }],
        },
      }
    },
    update(ns: string): ConnectionRpcResult<SettingsNamespaceView> {
      return {
        ok: false,
        error: {
          code: 'settings/rejected',
          message: 'fixture: the minimal readiness settings descriptor is read-only',
          details: { ns },
        },
      }
    },
    replace(ns: string): ConnectionRpcResult<SettingsNamespaceView> {
      return {
        ok: false,
        error: {
          code: 'settings/rejected',
          message: 'fixture: the minimal readiness settings descriptor is read-only',
          details: { ns },
        },
      }
    },
    mutate(ns: string): ConnectionRpcResult<SettingsNamespaceView> {
      // A Remote failure code is free-form, unlike the unary error vocabulary.
      return {
        ok: false,
        error: {
          code: 'settings/rejected',
          message: 'fixture: no settings namespaces are registered',
          details: { ns },
        },
      }
    },
    openSettingsDocument(): RpcResult<{ opened: true }> {
      return { ok: true, value: { opened: true } }
    },
    openAgentPresetDirectory(agentPreset: string): RpcResult<
      { opened: true } | { opened: false; path: string }
    > {
      const existing = fixturePresets.get(agentPreset)
      if (existing === undefined || existing.trust === 'system') {
        return {
          ok: false,
          error: {
            code: 'agent-preset/read-only',
            message: `agent preset "${agentPreset}" ships with the deployment`,
            details: { agentPreset, reason: 'it ships with the deployment' },
          },
        }
      }
      return { ok: true, value: { opened: true } }
    },
  }

  const credentialRemotes = {
    describe(refs: readonly string[]): RpcResult<Record<string, CredentialInfo>> {
      return {
        ok: true,
        value: Object.fromEntries(refs.map(ref => [ref, {
          configured: fixtureCredentials.has(ref),
          ...fixtureCredentials.has(ref) ? { source: 'file' } : {},
          writable: true,
        }])),
      }
    },
    set(ref: string): RpcResult<void> {
      fixtureCredentials.set(ref, true)
      return { ok: true, value: undefined }
    },
    unset(ref: string): RpcResult<void> {
      fixtureCredentials.delete(ref)
      return { ok: true, value: undefined }
    },
  }

  /**
   * Preset compositions the fixture serves. Held as state rather than
   * constants so the settings editor's save and delete are exercisable: the
   * roster a GUI journey sees after writing is the text it wrote.
   */
  const fixturePresets = new Map<string, { trust: 'system' | 'user'; content: string }>([
    ['standard', { trust: 'system', content: "- id: tool-bash\n  name: '@deepseek-ai/dsh-tool-bash'\n" }],
    ['minimal', { trust: 'system', content: "- id: tool-web-search\n  name: '@deepseek-ai/dsh-tool-web-search'\n" }],
    ['my-agent', { trust: 'user', content: "- id: tool-read\n  name: '@deepseek-ai/dsh-tool-read'\n" }],
  ])
  let fixtureDefaultPreset = 'standard'
  const nextTurn = new Map<SessionId, number>([[sid('fx-alpha'), 75]])
  let nextSession = 1
  // Workspace entities mirroring the host registry: the fixture sessions all
  // live under one workspace, whose account carries them in attach order.
  const wid = (raw: string): WorkspaceId => raw as WorkspaceId
  const fixtureEpoch = new Date(Date.now() - 300_000).toISOString()
  const FIXTURE_HOME = '/home/fixture'
  const workspaces: FixtureWorkspace[] = options.empty ? [] : [{
    workspaceId: wid('fx-ws-fixture'),
    path: '/tmp/fixture',
    title: 'fixture',
    sessionIds: [sid('fx-alpha'), sid('fx-beta'), sid('fx-gamma')],
    createdAt: fixtureEpoch,
    updatedAt: fixtureEpoch,
  }, {
    workspaceId: wid('fx-ws-home'),
    path: `${FIXTURE_HOME}/Documents/project`,
    title: 'project',
    sessionIds: [],
    createdAt: fixtureEpoch,
    updatedAt: fixtureEpoch,
  }]
  let nextWorkspace = 1
  // Registry-global archive set mirroring the host: archived sessions keep
  // their workspace accounting slot and only grouping surfaces hide them.
  const archivedSessionIds: SessionId[] = []
  const workspaceSnapshot = (workspace: FixtureWorkspace): WorkspaceView => ({
    ...workspace,
    sessionIds: [...workspace.sessionIds],
  })
  const workspaceBaseline = (): Extract<WorkspaceFollowFrame, { type: 'baseline' }> => ({
    type: 'baseline',
    value: {
      items: workspaces.map(workspaceSnapshot),
      archivedSessionIds: [...archivedSessionIds],
    },
  })

  // In-memory browse tree behind the fixture's `browse` picker capability —
  // deterministic content mirroring the design mock so assembled Web tests
  // and snapshots can walk it. Leaves are materialized lazily: a child listed
  // by its parent lists as empty until something is created inside it.
  const directoryTree = new Map<string, string[]>([
    ['/', ['home']],
    ['/home', ['fixture']],
    [FIXTURE_HOME, ['Documents', 'Downloads', '.config']],
    [`${FIXTURE_HOME}/Documents`, [
      'project', 'deepseek-iOS', 'deepseek-android', 'deepseek-platform',
      'deepseek-web', 'deepseek-harness', 'deepseek-app', 'deepseek-landing-blog',
    ]],
  ])
  const childrenOf = (path: string): string[] | undefined => {
    const known = directoryTree.get(path)
    if (known !== undefined) return known
    const parent = path.slice(0, path.lastIndexOf('/')) || '/'
    const name = path.slice(path.lastIndexOf('/') + 1)
    return directoryTree.get(parent)?.includes(name) === true ? [] : undefined
  }
  const crumbsOf = (path: string): { name: string; path: string; hidden: boolean }[] => {
    const crumbs = [{ name: '/', path: '/', hidden: false }]
    let acc = ''
    for (const segment of path.split('/').filter(Boolean)) {
      acc += `/${segment}`
      crumbs.push({ name: segment, path: acc, hidden: false })
    }
    return crumbs
  }
  /** Resident waterfalls retain their event ids across Remote Event generations. */
  const pendingApprovalEventId = 'fx-interaction-approval'
  let approvalPending = !options.empty
  const pendingQuestionEventId = 'fx-interaction-question'
  let questionPending = !options.empty
  const fixtureQuestions: readonly FixtureQuestionItem[] = [
    {
      id: 'harness-profile',
      header: '偏好',
      question: '你现在更想招哪类 Agent/Harness 候选人？',
      options: [
        { label: '工程落地型 (Recommended)', description: '更看重能直接做 runtime、tool executor、sandbox、trace 和线上问题排查。' },
        { label: '研究潜力型', description: '更看重 Agent 理解、训练评测思路和长期成长空间。' },
        { label: '均衡型', description: '同时要求工程能力和 Agent 认知，但可能筛选门槛更高。' },
      ],
    },
    {
      id: 'work-mode',
      header: '方式',
      question: '你希望候选人优先展示哪种工作方式？',
      options: [
        { label: '先做小型原型 (Recommended)', description: '用可运行结果尽快验证关键假设。' },
        { label: '先写完整设计', description: '先收敛边界、协议和风险，再开始实现。' },
      ],
    },
    {
      id: 'signals',
      header: '信号',
      question: '哪些面试信号最重要？',
      detail: '按当前招聘目标选择；跳过则视为不设偏好。',
      multiSelect: true,
      options: [
        { label: '系统设计' },
        { label: '代码质量' },
        { label: 'Agent 产品判断' },
      ],
    },
  ]

  const controlConns = new Set<StreamConn<FixtureControlFrame>>()
  const followConns = new Map<SessionId, Set<StreamConn<FixtureFollowEventFrame>>>()
  interface FixtureAttemptState {
    readonly attemptId: ReturnType<typeof LlmAttemptId>
    readonly startedAfterSeq: number
    readonly turn: number
    readonly step: number
    readonly stream: AssistantStreamAccumulator
    index: number
  }
  const activeAttempts = new Map<SessionId, FixtureAttemptState>()
  const assistantRevisions = new Map<SessionId, number>()
  const workspaceConns = new Set<StreamConn<WorkspaceFollowFrame>>()
  const remoteEventConns = new Map<string, StreamConn<FixtureRemoteEventFrame>>()
  const emitControl = (frame: FixtureControlFrame): void => {
    for (const conn of controlConns) conn.push(frame)
  }
  const emitWorkspace = (frame: Exclude<WorkspaceFollowFrame, { type: 'baseline' }>): void => {
    for (const conn of workspaceConns) conn.push(frame)
  }
  const emitRemote = (event: string, args: readonly unknown[]): void => {
    for (const conn of remoteEventConns.values()) conn.push({ type: 'emit', event, args })
  }
  const emitRemoteFrame = (frame: FixtureRemoteEventFrame): void => {
    for (const conn of remoteEventConns.values()) conn.push(frame)
  }
  const emitFollow = (sessionId: SessionId, entry: FixtureHistoryEntry): void => {
    for (const conn of followConns.get(sessionId) ?? []) conn.push(entry)
  }
  const emitAssistant = (sessionId: SessionId, frame: FixtureAssistantStreamFrame): void => {
    for (const conn of followConns.get(sessionId) ?? []) conn.push({ type: 'assistant-stream', frame })
  }
  const nextAssistantRevision = (sessionId: SessionId): number => {
    const revision = (assistantRevisions.get(sessionId) ?? 0) + 1
    assistantRevisions.set(sessionId, revision)
    return revision
  }
  const beginAssistant = (sessionId: SessionId, turn: number, step: number): FixtureAttemptState => {
    const attemptId = LlmAttemptId(`${sessionId}:fixture:${String(nextAssistantRevision(sessionId))}`)
    const lastSeq = logOf(sessionId).length - 1
    const startedAfterSeq = lastSeq < 0 ? -1 : SessionSeq(lastSeq)
    const attempt = {
      attemptId, startedAfterSeq, turn, step,
      stream: new AssistantStreamAccumulator(), index: 0,
    }
    activeAttempts.set(sessionId, attempt)
    emitAssistant(sessionId, {
      type: 'start', attemptId, revision: assistantRevisions.get(sessionId) as number,
      startedAfterSeq, turn, step,
    })
    return attempt
  }
  const pushAssistant = (sessionId: SessionId, chunk: StreamChunk): void => {
    const attempt = activeAttempts.get(sessionId)
    if (attempt === undefined) throw new Error(`fixture: no active Assistant attempt for ${sessionId}`)
    const timed = attempt.stream.push({ time: Date.now(), chunk })
    emitAssistant(sessionId, {
      type: 'chunk', attemptId: attempt.attemptId, revision: nextAssistantRevision(sessionId),
      index: attempt.index++, time: timed.time, chunk: timed.chunk as unknown as JsonValue,
    })
  }
  const commitAssistant = (sessionId: SessionId, event: SessionEvent): void => {
    const attempt = activeAttempts.get(sessionId)
    if (attempt === undefined) throw new Error(`fixture: no active Assistant attempt for ${sessionId}`)
    activeAttempts.delete(sessionId)
    emitAssistant(sessionId, {
      type: 'end', attemptId: attempt.attemptId, revision: nextAssistantRevision(sessionId),
      index: attempt.index,
      outcome: {
        kind: 'committed',
        eventType: event.type === 'assistant/message' ? 'assistant/message' : 'assistant/attempt',
        seq: event.seq,
      },
    })
  }

  function sessionOk<T>(value: T): Promise<ConnectionRpcResult<T>> {
    return Promise.resolve({ ok: true, value })
  }

  function sessionErr<T>(error: ConnectionRpcFailure): Promise<ConnectionRpcResult<T>> {
    return Promise.resolve({ ok: false, error })
  }

  const summaryOf = (id: SessionId): FixtureSessionSummary | undefined => sessions.find(s => s.sessionId === id)
  const requireRemoteSession = (
    request: { readonly sessionId: SessionId },
  ): Promise<ConnectionRpcResult<never>> | undefined => {
    if (summaryOf(request.sessionId) !== undefined) return undefined
    return sessionErr({
      code: 'session/not-found',
      message: `no session ${request.sessionId}`,
      details: { sessionId: request.sessionId },
    })
  }
  const setRunning = (id: SessionId, running: boolean): void => {
    const summary = summaryOf(id)
    if (summary === undefined || summary.running === running) return
    summary.running = running
    emitRemote('api-session/status', [id, running])
  }
  const logOf = (id: SessionId): SessionEvent[] => {
    let log = logs.get(id)
    if (log === undefined) {
      log = []
      logs.set(id, log)
    }
    return log
  }
  const append = (id: SessionId, e: Record<string, unknown>): SessionEvent => {
    const log = logOf(id)
    const event = { seq: SessionSeq(log.length), time: Date.now(), ...e } as unknown as SessionEvent
    log.push(event)
    emitFollow(id, { type: 'event', event })
    // Host eager-drive parallel: a unit-advancing event pushes its finished value.
    for (const frame of projectionFramesOf(id, log, event)) emitControl(frame)
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      const summary = summaryOf(id)
      if (summary !== undefined) summary.updatedAt = event.time
      emitRemote('api-session/activity', [id, event.time])
    }
    return event
  }

  /** Append one durable goal/change (host GoalService parallel). */
  const appendGoalChange = (id: SessionId, change: FxGoalChange): FxGoalProjection => {
    const log = logOf(id)
    append(id, {
      type: 'goal/change',
      data: change,
    })
    return backscanGoal(log) as FxGoalProjection
  }

  type FxGoalRef = { id: string; revision: number }
  type FxGoalView = FxGoalProjection['goal'] & {
    roundsStarted: number
    createdAt: number
    updatedAt: number
    activation: 'armed' | 'disarmed'
  }

  const goalFailure = <T>(message: string): RpcResult<T> => ({
    ok: false,
    error: { code: 'gateway/internal', message, details: {} },
  })

  const requireGoalSession = (id: SessionId): RpcResult<never> | undefined => (
    summaryOf(id) === undefined
      ? { ok: false, error: { code: 'session/not-found', message: `no session ${id}`, details: { sessionId: id } } }
      : undefined
  )

  /** Canonical fixture implementation of the generated Commands Remote contract. */
  const commandRemotes = {
    list(id: SessionId): RpcResult<readonly CommandDescriptor[]> {
      const missing = requireGoalSession(id)
      if (missing !== undefined) return missing
      return {
        ok: true,
        value: [
          { name: 'compact', description: 'fixture：压缩当前会话上下文' },
          { name: 'echo', description: 'fixture：回显参数', input: { hint: 'text to echo' } },
          { name: 'goal', description: 'set or view the goal for a long-running task', input: { hint: '<objective>', images: true } },
          { name: 'permission', description: 'Switch the permission preset (sandbox mode + approval policy)', input: { hint: '<preset>' } },
          { name: 'plan', description: 'Enter or leave plan mode', input: { hint: '[off|message]', images: true } },
        ],
      }
    },
    execute(id: SessionId, line: string, images: readonly unknown[] = []): RpcResult<CommandExecution | undefined> {
      const missing = requireGoalSession(id)
      if (missing !== undefined) return missing
      // Structured split mirroring the Host parser: name + verbatim rawInput
      // (separator whitespace included) — the run payload carries no line.
      const match = /^\/(\S+)((?:\s.*)?)$/.exec(line.trim())
      const name = match?.[1]
      const args = match?.[2] ?? ''
      // Mirror the Host image policy AFTER command resolution, matching the
      // executor's order (an unknown name answers undefined and logs no
      // lifecycle): the declaration rejection covers every known command
      // without `input.images`, and the two producer grammar rejections cover
      // the declaring commands' control-only lines. The fixture stores no
      // bytes, so an accepted batch is acknowledged and dropped.
      const known = ['permission', 'goal', 'compact', 'echo', 'plan']
      if (images.length > 0 && name !== undefined && known.includes(name)) {
        const rejection = name !== 'goal' && name !== 'plan'
          ? `/${name} does not accept image attachments`
          : name === 'goal' && args.trim() === ''
            ? 'Image attachments only accompany a goal objective: /goal <objective> or /goal edit <objective>.'
            : name === 'plan' && args.trim() === 'off'
              ? 'Image attachments cannot accompany /plan off.'
              : undefined
        if (rejection !== undefined) {
          const commandId = `fx-cmd-${logOf(id).length}` as CommandId
          append(id, { type: 'command/run', data: { commandId, name, args, source: { kind: 'user' } } })
          const result: CommandResult = { kind: 'error', text: rejection }
          append(id, { type: 'command/done', data: { commandId, ...result } })
          return { ok: true, value: { commandId, result } }
        }
      }
      if (name === 'permission') {
        const preset = args.trim()
        const commandId = `fx-cmd-${logOf(id).length}` as CommandId
        append(id, { type: 'command/run', data: { commandId, name, args, source: { kind: 'user' } } })
        const spec = PERMISSION_PRESETS[preset]
        let result: CommandResult
        if (preset === '') {
          const current = permissionSelectOf(logOf(id)).currentValue
          result = { kind: 'success', text: `current preset ${current} (available: ${Object.keys(PERMISSION_PRESETS).join(', ')})` }
        } else if (spec === undefined) {
          result = { kind: 'error', text: `unknown preset "${preset}" (available: ${Object.keys(PERMISSION_PRESETS).join(', ')})` }
        } else {
          if (permissionSelectOf(logOf(id)).currentValue !== preset) append(id, { type: 'permission/preset', data: { preset } })
          append(id, { type: 'sandbox/mode', data: { mode: spec.sandbox } })
          append(id, { type: 'approval/policy', data: { policy: spec.approval } })
          result = { kind: 'success', text: `preset ${preset}` }
        }
        append(id, { type: 'command/done', data: { commandId, ...result } })
        return { ok: true, value: { commandId, result } }
      }
      if (name === 'goal') {
        const commandId = `fx-cmd-${logOf(id).length}` as CommandId
        append(id, { type: 'command/run', data: { commandId, name, args, source: { kind: 'user' } } })
        const objective = args.trim()
        const current = backscanGoal(logOf(id))
        let text: string
        if (objective === '') {
          text = current === null ? 'No goal is set. Usage: /goal <objective>' : `Current goal: ${current.goal.objective}`
        } else if (current !== null && current.goal.phase !== 'complete') {
          text = `A goal already exists (${current.goal.objective}). Clear it first.`
        } else {
          const created = appendGoalChange(id, {
            kind: 'goal/change', version: 1, operation: 'create',
            goal: { id: `fx-goal-${logOf(id).length}`, revision: 1, objective, phase: 'active', maxGoalRounds: 256 },
            roundsStarted: 0, createdAt: Date.now(), updatedAt: Date.now(),
          })
          text = `Goal created: ${created.goal.objective}`
        }
        const result: CommandResult = { kind: 'success', text }
        append(id, { type: 'command/done', data: { commandId, ...result } })
        return { ok: true, value: { commandId, result } }
      }
      const running = summaryOf(id)?.running === true
      const outcomes: Record<string, string> = {
        compact: 'fixture：已压缩（假动作）',
        echo: args.trim(),
        plan: args.trim() === 'off'
          ? (running ? 'Leaving plan mode (applies from the next step).' : 'Plan mode off.')
          : (running
            ? 'Entering plan mode (applies from the next step). Use /plan off to leave.'
            : 'Plan mode on. Use /plan off to leave.'),
      }
      const text = name === undefined ? undefined : outcomes[name]
      if (name === undefined || text === undefined) return { ok: true, value: undefined }
      const commandId = `fx-cmd-${logOf(id).length}` as CommandId
      append(id, { type: 'command/run', data: { commandId, name, args, source: { kind: 'user' } } })
      if (name === 'plan' && !running) {
        const plan = foldPlan(logOf(id))
        if (plan.wanted !== null && plan.wanted !== plan.active) {
          append(id, { type: 'plan/mode', data: { active: plan.wanted } })
        }
      }
      const result: CommandResult = { kind: 'success', ...text === '' ? {} : { text } }
      append(id, { type: 'command/done', data: { commandId, ...result } })
      return { ok: true, value: { commandId, result } }
    },
  }

  const goalView = (projection: FxGoalProjection): FxGoalView => ({
    ...projection.goal,
    roundsStarted: projection.roundsStarted,
    createdAt: projection.createdAt,
    updatedAt: projection.updatedAt,
    activation: projection.goal.phase === 'active' ? 'armed' : 'disarmed',
  })

  /** Canonical fixture implementation of the generated Goal Remote contract. */
  /** Canonical fixture implementation of the generated reference-discovery Remote contracts. */
  const referenceRemotes = {
    files(id: SessionId, query: string): RpcResult<{ path: string; kind: 'file' | 'directory' }[]> {
      const missing = requireGoalSession(id)
      if (missing !== undefined) return missing
      const needle = query.toLocaleLowerCase()
      const items = [
        { path: 'notes', kind: 'directory' as const },
        { path: 'README.md', kind: 'file' as const },
        { path: 'notes/demo.txt', kind: 'file' as const },
      ].filter(item => item.path.toLocaleLowerCase().includes(needle))
      return { ok: true, value: items }
    },
    sessions(id: SessionId, query: string): RpcResult<{
      sessionId: SessionId
      label: string
      cwd?: string
      createdAt: number
      mention: string
    }[]> {
      const missing = requireGoalSession(id)
      if (missing !== undefined) return missing
      const needle = query.toLocaleLowerCase()
      const value = sessions
        .filter(item => item.sessionId !== id)
        .filter(item => String(item.sessionId).toLocaleLowerCase().includes(needle)
          || item.cwd?.toLocaleLowerCase().includes(needle) === true)
        .map((item) => {
          const label = item.sessionId === sid('fx-beta') ? 'Fixture child session' : String(item.sessionId)
          const encoded = btoa(JSON.stringify(item.sessionId))
            .replaceAll('+', '-')
            .replaceAll('/', '_')
            .replace(/=+$/u, '')
          return {
            sessionId: item.sessionId,
            label,
            ...item.cwd === undefined ? {} : { cwd: item.cwd },
            createdAt: item.updatedAt,
            mention: `@[${label}](dsh-session:${encoded})`,
          }
        })
      return { ok: true, value }
    },
  }

  /**
   * Canonical fixture implementation of the generated Directory Picker Remote
   * contract. The pick is deterministic — the keyless lanes drive the full
   * pick-then-adopt path without an OS chooser — over the same design-mock
   * tree the browse primitives serve.
   */
  const directoryPickerRemotes = {
    pick(): ConnectionRpcResult<string | null> {
      return { ok: true, value: `${FIXTURE_HOME}/Documents/project` }
    },
    list(path?: string): ConnectionRpcResult<FixtureDirectoryListing> {
      const target = path ?? FIXTURE_HOME
      const children = childrenOf(target)
      if (children === undefined) {
        return {
          ok: false,
          error: { code: 'directory-picker/unreadable', message: `cannot list ${target}: not in the fixture tree`, details: { path: target } },
        }
      }
      return {
        ok: true,
        value: {
          path: target,
          home: FIXTURE_HOME,
          crumbs: crumbsOf(target),
          entries: [...children].sort((a, b) => a.localeCompare(b))
            .map(name => ({ name, path: target === '/' ? `/${name}` : `${target}/${name}`, hidden: name.startsWith('.') })),
          // The fixture tree is tiny; no level ever reaches a backend bound.
          truncated: false,
        },
      }
    },
    createDirectory(parent: string, name: string): ConnectionRpcResult<string> {
      const children = childrenOf(parent)
      if (children === undefined) {
        return { ok: false, error: { code: 'directory-picker/create-failed', message: `missing parent ${parent}`, details: { path: parent } } }
      }
      // Same root special case as list's entry paths: a plain join under '/'
      // would mint '//name' and fork the tree's identity.
      const target = parent === '/' ? `/${name}` : `${parent}/${name}`
      if (children.includes(name)) {
        return { ok: false, error: { code: 'directory-picker/exists', message: `${target} already exists`, details: { path: target } } }
      }
      directoryTree.set(parent, [...children, name])
      directoryTree.set(target, [])
      return { ok: true, value: target }
    },
  }

  const goalRemotes = {
    create(id: SessionId, request: { objective: string; maxGoalRounds?: number }): RpcResult<{ ref: FxGoalRef }> {
      const missing = requireGoalSession(id)
      if (missing !== undefined) return missing
      const current = backscanGoal(logOf(id))
      if (current !== null && current.goal.phase !== 'complete') {
        return goalFailure(`goal "${current.goal.id}" already exists`)
      }
      const now = Date.now()
      const projection = appendGoalChange(id, {
        kind: 'goal/change', version: 1, operation: 'create',
        goal: {
          id: `fx-goal-${logOf(id).length}`,
          revision: 1,
          objective: request.objective,
          phase: 'active',
          maxGoalRounds: request.maxGoalRounds ?? 256,
        },
        roundsStarted: 0, createdAt: now, updatedAt: now,
      })
      return { ok: true, value: { ref: { id: projection.goal.id, revision: projection.goal.revision } } }
    },
    edit(id: SessionId, ref: FxGoalRef, request: { objective?: string; maxGoalRounds?: number }): RpcResult<FxGoalView> {
      return mutateGoal(id, ref, current => ({
        ...current.goal,
        revision: current.goal.revision + 1,
        ...request.objective === undefined ? {} : { objective: request.objective },
        ...request.maxGoalRounds === undefined ? {} : { maxGoalRounds: request.maxGoalRounds },
      }))
    },
    pause(id: SessionId, ref: FxGoalRef): RpcResult<FxGoalView> {
      return mutateGoal(id, ref, current => (
        current.goal.phase === 'active'
          ? { ...current.goal, revision: current.goal.revision + 1, phase: 'paused' }
          : undefined
      ))
    },
    resume(id: SessionId, ref: FxGoalRef): RpcResult<FxGoalView> {
      return mutateGoal(id, ref, current => (
        current.goal.phase === 'paused' || current.goal.phase === 'blocked' || current.goal.phase === 'active'
          ? { ...current.goal, revision: current.goal.revision + 1, phase: 'active' }
          : undefined
      ))
    },
    complete(id: SessionId, ref: FxGoalRef): RpcResult<FxGoalView> {
      return mutateGoal(id, ref, current => (
        current.goal.phase === 'complete'
          ? undefined
          : { ...current.goal, revision: current.goal.revision + 1, phase: 'complete' }
      ))
    },
    clear(id: SessionId, ref: FxGoalRef): RpcResult<FxGoalRef> {
      const resolved = resolveGoal(id, ref)
      if (!resolved.ok) return resolved
      const current = resolved.value
      const tombstone = { id: current.goal.id, revision: current.goal.revision + 1 }
      appendGoalChange(id, {
        kind: 'goal/change', version: 1, operation: 'clear', cleared: tombstone, clearedAt: Date.now(),
      })
      return { ok: true, value: tombstone }
    },
  }

  /** Resolve one current goal revision for a canonical Remote mutation. */
  function resolveGoal(id: SessionId, ref: FxGoalRef): RpcResult<FxGoalProjection> {
    const missing = requireGoalSession(id)
    if (missing !== undefined) return missing
    const current = backscanGoal(logOf(id))
    if (current === null || current.goal.id !== ref.id || current.goal.revision !== ref.revision) {
      return goalFailure('stale or missing goal revision')
    }
    return { ok: true, value: current }
  }

  /** Shared CAS mutation path behind the canonical Remote verbs. */
  function mutateGoal(
    id: SessionId,
    ref: FxGoalRef,
    next: (current: FxGoalProjection) => FxGoalProjection['goal'] | undefined,
  ): RpcResult<FxGoalView> {
    const resolved = resolveGoal(id, ref)
    if (!resolved.ok) return resolved
    const current = resolved.value
    const goal = next(current)
    if (goal === undefined) {
      return goalFailure(`invalid goal transition from "${current.goal.phase}"`)
    }
    const projection = appendGoalChange(id, {
      kind: 'goal/change', version: 1,
      operation: goal.phase === current.goal.phase ? 'edit' : goal.phase === 'paused' ? 'pause' : goal.phase === 'active' ? 'resume' : 'complete',
      goal, roundsStarted: current.roundsStarted, createdAt: current.createdAt, updatedAt: Date.now(),
    })
    return { ok: true, value: goalView(projection) }
  }

  /** Canonical fixture implementation of the generated AgentPresets Remote contract. */
  const presetRemotes = {
    // Both trusts appear, because a surface must present a locally authored
    // preset differently from one the deployment vetted.
    list(): RpcResult<{ presets: { id: string; trust: 'system' | 'user'; isDefault: boolean }[]; authorable: boolean }> {
      return {
        ok: true,
        value: {
          presets: [...fixturePresets].map(([id, preset]) => ({
            id,
            trust: preset.trust,
            isDefault: id === fixtureDefaultPreset,
          })),
          authorable: true,
        },
      }
    },
    select(_id: SessionId, agentPreset: string): RpcResult<string> {
      fixtureDefaultPreset = agentPreset
      return { ok: true, value: agentPreset }
    },
    read(agentPreset: string): RpcResult<{ agentPreset: string; trust: 'system' | 'user'; content: string }> {
      const preset = fixturePresets.get(agentPreset)
      if (preset === undefined) {
        return {
          ok: false,
          error: {
            code: 'agent-preset/not-found',
            message: `unknown agent preset "${agentPreset}"`,
            details: { agentPreset, available: [...fixturePresets.keys()] },
          },
        }
      }
      return { ok: true, value: { agentPreset, trust: preset.trust, content: preset.content } }
    },
    copy(from: string, id: string): RpcResult<void> {
      const source = fixturePresets.get(from)
      if (source === undefined) {
        return {
          ok: false,
          error: {
            code: 'agent-preset/not-found',
            message: `unknown agent preset "${from}"`,
            details: { agentPreset: from, available: [...fixturePresets.keys()] },
          },
        }
      }
      if (fixturePresets.has(id)) {
        return {
          ok: false,
          error: {
            code: 'agent-preset/invalid',
            message: `agent preset "${id}" already exists`,
            details: { agentPreset: id, reason: 'already exists' },
          },
        }
      }
      fixturePresets.set(id, { trust: 'user', content: source.content })
      return { ok: true, value: undefined }
    },
    deletePreset(id: string): RpcResult<void> {
      if (fixturePresets.get(id)?.trust === 'system') {
        return {
          ok: false,
          error: {
            code: 'agent-preset/read-only',
            message: `agent preset "${id}" ships with the deployment`,
            details: { agentPreset: id, reason: 'it ships with the deployment' },
          },
        }
      }
      fixturePresets.delete(id)
      return { ok: true, value: undefined }
    },
  }

  /** At most one in-flight replay per session; cancel clears it. */
  const replays = new Map<SessionId, { timer: ReturnType<typeof setTimeout>; finish(aborted: boolean): void }>()

  /** History transit delay; the page snapshot is taken at request time. */
  let historyDelayMs = 0
  /** One-shot history failure (timing hook: a pre-disconnect history request already doomed when reconnect lands). */
  let failNextHistory = false
  /** Force-enders for currently open stream generators (timing hook: simulated connection loss). */
  const streamBreakers = new Set<() => void>()
  /** Retry scenarios opened by timing hooks and completed in a later browser assertion phase. */
  const retryScenarios = new Map<SessionId, { turn: number; stepStarted: boolean }>()
  /** The single opt-in browser stress producer; normal fixture journeys never start it. */
  let activeReasoningChunkStorm: ReasoningChunkStormState | null = null

  // Browser-only timing hooks for slow history, lost frames, and reconnects.
  const timingHooks = {
    setHistoryDelay(ms: number): void {
      historyDelayMs = ms
    },
    /** Fail the NEXT history call (after its transit delay) with a transport-level throw. */
    failNextHistory(): void {
      failNextHistory = true
    },
    /** Log append plus follow-stream delivery (the normal live path). */
    appendUser(id: string, msg: string): void {
      append(sid(id), { type: 'user/message', surfaceOp: 'append', data: userMessage(text(msg)) })
    },
    /** Append a later durable title revision through the normal raw-event + control-frame path. */
    appendTitle(id: string, title: string): void {
      const log = logOf(sid(id))
      const messageSeqs = log.filter(event => event.type === 'user/message').map(event => event.seq)
      append(sid(id), { type: 'session/title', data: { title, messageSeqs, source: { kind: 'provider', provider: 'fixture' } } })
    },
    /** Start an externally paced reasoning stream for the opt-in browser stress lane. */
    startReasoningChunkStorm(
      id: string,
      chunkCount: number,
      chunksPerInterval: number,
      intervalMs: number,
    ): string {
      if (!Number.isSafeInteger(chunkCount) || chunkCount < 1) {
        throw new Error('fixture: reasoning chunk count must be a positive safe integer')
      }
      if (!Number.isSafeInteger(chunksPerInterval) || chunksPerInterval < 1) {
        throw new Error('fixture: reasoning chunks per interval must be a positive safe integer')
      }
      if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
        throw new Error('fixture: reasoning interval must be a positive safe integer')
      }
      if (activeReasoningChunkStorm?.emitting === true) {
        throw new Error('fixture: reasoning chunk storm already running')
      }

      const sessionId = sid(id)
      const log = logOf(sessionId)
      let turn = nextTurn.get(sessionId) ?? 0
      for (const event of log) {
        const candidate = (event as unknown as { data?: { turn?: unknown } }).data?.turn
        if (typeof candidate === 'number') turn = Math.max(turn, candidate + 1)
      }
      nextTurn.set(sessionId, turn + 1)
      const marker = `REASONING_STRESS_COMPLETE:${String(turn)}:${String(chunkCount)}`
      const state: ReasoningChunkStormState = {
        sessionId: id,
        chunkCount,
        chunksPerInterval,
        intervalMs,
        emitted: 0,
        marker,
        emitting: true,
      }
      activeReasoningChunkStorm = state

      setRunning(sessionId, true)
      append(sessionId, { type: 'turn/start', data: { turn, trigger: { kind: 'message', source: { kind: 'user' } } } })
      append(sessionId, {
        type: 'user/message', surfaceOp: 'append',
        data: userMessage(text(`Reasoning chunk stress: ${String(chunkCount)} chunks.`)),
      })
      append(sessionId, { type: 'step/start', data: { turn, step: 0 } })
      beginAssistant(sessionId, turn, 0)
      pushAssistant(sessionId, { type: 'block-start', index: 0, blockType: 'reasoning' })

      const startedAt = Date.now()
      const pump = (): void => {
        const elapsedIntervals = Math.floor((Date.now() - startedAt) / intervalMs) + 1
        const due = Math.max(state.emitted + chunksPerInterval, elapsedIntervals * chunksPerInterval)
        const end = Math.min(due, chunkCount)
        for (let index = state.emitted; index < end; index++) {
          const chunkText = index === chunkCount - 1
            ? `\n${marker}`
            : index % 64 === 63 ? '推理\n' : '推理'
          pushAssistant(sessionId, { type: 'reasoning-delta', index: 0, text: chunkText })
        }
        state.emitted = end
        if (end < chunkCount) {
          setTimeout(pump, intervalMs)
        } else {
          state.emitting = false
        }
      }
      setTimeout(pump, 0)
      return marker
    },
    /** Return a copy so browser probes cannot mutate the active producer. */
    reasoningChunkStormState(): ReasoningChunkStormState | null {
      return activeReasoningChunkStorm === null ? null : { ...activeReasoningChunkStorm }
    },
    /** Open one failed model step whose partial remains visible until llm/retry arrives. */
    beginModelRetry(id: string): void {
      const sessionId = sid(id)
      const turn = nextTurn.get(sessionId) ?? 0
      nextTurn.set(sessionId, turn + 1)
      retryScenarios.set(sessionId, { turn, stepStarted: true })
      setRunning(sessionId, true)
      append(sessionId, { type: 'turn/start', data: { turn } })
      append(sessionId, { type: 'user/message', surfaceOp: 'append', data: { content: text('请重试这个请求'), source: { kind: 'user' } } })
      append(sessionId, { type: 'step/start', data: { turn, step: 1 } })
      beginAssistant(sessionId, turn, 1)
      pushAssistant(sessionId, { type: 'block-start', index: 0, blockType: 'text' })
      pushAssistant(sessionId, { type: 'text-delta', index: 0, text: '应撤回的半截回复' })
    },
    /** Record one retry decision; the next attempt remains in the same step. */
    scheduleModelRetry(id: string, retry = 1, delayMs = 450): void {
      const sessionId = sid(id)
      const scenario = retryScenarios.get(sessionId)
      if (scenario === undefined) throw new Error(`fixture: no model retry scenario for ${id}`)
      if (!scenario.stepStarted) {
        beginAssistant(sessionId, scenario.turn, 1)
        pushAssistant(sessionId, { type: 'block-start', index: 0, blockType: 'text' })
        pushAssistant(sessionId, { type: 'text-delta', index: 0, text: `第 ${String(retry)} 次应撤回的回复` })
        scenario.stepStarted = true
      }
      const failure = { code: 'TRANSPORT', message: '连接被重置' }
      pushAssistant(sessionId, { type: 'finish', reason: { kind: 'error', failure } })
      const attempt = activeAttempts.get(sessionId) as FixtureAttemptState
      const attemptEvent = append(sessionId, {
        type: 'assistant/attempt', data: { turn: scenario.turn, step: 1, stream: attempt.stream.snapshot() },
      })
      commitAssistant(sessionId, attemptEvent)
      append(sessionId, {
        type: 'llm/retry',
        data: {
          turn: scenario.turn, step: 1,
          provider: 'fixture', mode: 'normal', policyKey: 'fixture-normal',
          retry, maxRetries: 2, delayMs, failure,
        },
      })
      scenario.stepStarted = false
    },
    /** Record one retry decision, then cancel its source turn before the retry starts. */
    cancelModelRetryDuringBackoff(id: string, delayMs = 450): void {
      const sessionId = sid(id)
      const scenario = retryScenarios.get(sessionId)
      if (scenario === undefined) throw new Error(`fixture: no model retry scenario for ${id}`)
      const failure = { code: 'TRANSPORT', message: '连接被重置' }
      const active = activeAttempts.get(sessionId)
      if (active !== undefined) {
        pushAssistant(sessionId, { type: 'finish', reason: { kind: 'error', failure } })
        const attemptEvent = append(sessionId, {
          type: 'assistant/attempt', data: { turn: scenario.turn, step: 1, stream: active.stream.snapshot() },
        })
        commitAssistant(sessionId, attemptEvent)
      }
      append(sessionId, {
        type: 'llm/retry',
        data: {
          turn: scenario.turn, step: 1,
          provider: 'fixture', mode: 'normal', policyKey: 'fixture-normal',
          retry: 1, maxRetries: 2, delayMs, failure,
        },
      })
      append(sessionId, { type: 'step/end', data: { turn: scenario.turn, step: 1 } })
      append(sessionId, { type: 'turn/end', data: { turn: scenario.turn, reason: { kind: 'aborted', reason: { kind: 'user' } },
      } })
      retryScenarios.delete(sessionId)
      setRunning(sessionId, false)
    },
    /** Finish the timing-hook retry with a finalized response in the open step. */
    completeModelRetry(id: string): void {
      const sessionId = sid(id)
      const scenario = retryScenarios.get(sessionId)
      if (scenario === undefined) throw new Error(`fixture: no model retry scenario for ${id}`)
      retryScenarios.delete(sessionId)
      const completed = '重试后的完整回复'
      beginAssistant(sessionId, scenario.turn, 1)
      pushAssistant(sessionId, { type: 'block-start', index: 0, blockType: 'text' })
      pushAssistant(sessionId, { type: 'text-delta', index: 0, text: completed })
      pushAssistant(sessionId, { type: 'block-end', index: 0, block: { type: 'text', text: completed } })
      pushAssistant(sessionId, { type: 'finish', reason: { kind: 'stop' } })
      const attempt = activeAttempts.get(sessionId) as FixtureAttemptState
      const message = append(sessionId, {
        type: 'assistant/message',
        surfaceOp: 'append',
        data: {
          turn: scenario.turn,
          step: 1,
          message: assistantMessage(text(completed)),
          stream: attempt.stream.snapshot(),
        },
      })
      commitAssistant(sessionId, message)
      append(sessionId, { type: 'step/end', data: { turn: scenario.turn, step: 1 } })
      append(sessionId, { type: 'turn/end', data: { turn: scenario.turn, reason: { kind: 'completed' } } })
      setRunning(sessionId, false)
    },
    /** Log append without follow delivery: a frame lost in transit that page repair must recover. */
    appendSilent(id: string, msg: string): void {
      const log = logOf(sid(id))
      log.push({ type: 'user/message', surfaceOp: 'append', seq: SessionSeq(log.length), time: Date.now(), data: userMessage(text(msg)) } as unknown as SessionEvent)
    },
    /** End every open stream generator (client sees both streams close -> reconnect + resync path). */
    breakStreams(): void {
      for (const breakNow of [...streamBreakers]) breakNow()
    },
  }
  ;(globalThis as Record<string, unknown>).__fxTiming = timingHooks

  /** Prompt replay: chunk typewriter (80ms/frame) -> assistant/message finalize -> turn/end + running flip. */
  const startReply = (id: SessionId, turn: number, replyText: string): void => {
    const step = 0
    append(id, { type: 'step/start', data: { turn, step } })
    beginAssistant(id, turn, step)
    pushAssistant(id, { type: 'block-start', index: 0, blockType: 'text' })
    /* v8 ignore next -- the ?? arm needs a null match, but every fixture reply is non-empty. */
    const pieces = replyText.match(/[\s\S]{1,6}/gu) ?? [replyText]
    let i = 0
    const finish = (aborted: boolean): void => {
      replays.delete(id)
      const done = pieces.slice(0, i).join('')
      pushAssistant(id, { type: 'block-end', index: 0, block: { type: 'text', text: done } })
      pushAssistant(id, { type: 'usage', usage: fixtureUsage(turn, step) })
      if (!aborted) pushAssistant(id, { type: 'finish', reason: { kind: 'stop' } })
      const attempt = activeAttempts.get(id) as FixtureAttemptState
      const message = append(id, {
        type: 'assistant/message',
        surfaceOp: 'append',
        data: {
          turn,
          step,
          message: assistantMessage(text(done)),
          stream: attempt.stream.snapshot(),
          usage: fixtureUsage(turn, step),
          ...(aborted ? { interrupted: true } : {}),
        },
      })
      commitAssistant(id, message)
      append(id, { type: 'step/end', data: { turn, step } })
      append(id, { type: 'turn/end', data: {
        turn,
        reason: aborted ? { kind: 'aborted', reason: { kind: 'user' } } : { kind: 'completed' },
      } })
      setRunning(id, false)
    }
    const tick = (): void => {
      const piece = pieces[i]
      if (piece === undefined) {
        finish(false)
        return
      }
      i++
      pushAssistant(id, { type: 'text-delta', index: 0, text: piece })
      replays.set(id, { timer: setTimeout(tick, 80), finish })
    }
    replays.set(id, { timer: setTimeout(tick, 80), finish })
  }

  const sessionApi: FixtureSessionApi = {
    list: _request => sessionOk({ items: [...sessions].sort((a, b) => b.updatedAt - a.updatedAt) }),
    search: (request, signal) => {
      if (signal.aborted) {
        return sessionErr({
          code: 'gateway/cancelled',
          message: 'fixture session search was aborted',
          details: {},
        })
      }
      const query = searchTokenSpans(request.query).tokens.map(token => token.value)
      const matches = sessions.flatMap((summary) => {
        const log = logs.get(summary.sessionId) ?? []
        const current = new Set(foldSurface(log).nodes)
        const best = log.flatMap((event): FixtureSearchCandidate[] => {
          if (!current.has(event.seq)) return []
          const eventText = searchEventText(event)
          const document = searchTokenSpans(eventText)
          const match = phraseMatch(document.tokens, query)
          if (match.count === 0) return []
          return [{
            sessionId: summary.sessionId,
            seq: event.seq,
            time: event.time,
            text: document.text,
            matchCount: match.count,
            matchStart: match.start,
            matchEnd: match.end,
            documentLength: Array.from(eventText).length,
          }]
        }).sort(compareSearchCandidates)[0]
        return best === undefined ? [] : [best]
      }).sort(compareSearchCandidates)
      return sessionOk({
        items: matches.slice(0, FIXTURE_SESSION_SEARCH_RESULT_LIMIT).map(match => ({
          sessionId: match.sessionId,
          snippet: searchSnippet(match.text, match.matchStart, match.matchEnd),
        })),
        hasMore: matches.length > FIXTURE_SESSION_SEARCH_RESULT_LIMIT,
      })
    },
    create: async (request) => {
      const workspace = request.workspaceId === undefined
        ? undefined
        : workspaces.find(w => w.workspaceId === request.workspaceId)
      if (request.workspaceId !== undefined && workspace === undefined) {
        return sessionErr({
          code: 'workspace/not-found',
          message: `no workspace ${request.workspaceId}`,
          details: { workspaceId: request.workspaceId },
        })
      }
      const cwd = workspace?.path ?? request.cwd ?? '/tmp/fixture'
      const requestedId = request.sessionId
      const attachWorkspace = (sessionId: SessionId): void => {
        /* v8 ignore next -- callers enter only when a target Workspace exists. */
        if (workspace === undefined || workspace.sessionIds.includes(sessionId)) return
        workspace.sessionIds = [sessionId, ...workspace.sessionIds]
        workspace.updatedAt = new Date().toISOString()
        emitWorkspace({ type: 'upsert', workspace: workspaceSnapshot(workspace) })
      }
      const attachFailure = (
        sessionId: SessionId,
        workspaceId: WorkspaceId,
      ): Promise<ConnectionRpcResult<{ sessionId: SessionId }>> => sessionErr({
        code: 'session/workspace-attach-failed' as const,
        message: `fixture rejected Workspace attachment for ${sessionId}`,
        details: { sessionId, workspaceId },
      })
      if (requestedId !== undefined) {
        const existing = summaryOf(requestedId)
        if (existing !== undefined) {
          if (existing.cwd !== cwd) {
            return sessionErr({
              code: 'session/conflict',
              message: `session ${requestedId} already uses ${existing.cwd ?? 'no cwd'}`,
              details: { sessionId: requestedId, requestedCwd: cwd, ...existing.cwd === undefined ? {} : { existingCwd: existing.cwd } },
            })
          }
          if (workspace !== undefined && !workspace.sessionIds.includes(requestedId)) {
            if (options.failWorkspaceAttach) return attachFailure(requestedId, workspace.workspaceId)
            attachWorkspace(requestedId)
          }
          return sessionOk({ sessionId: requestedId })
        }
      }
      const created: FixtureSessionSummary = {
        sessionId: requestedId ?? sid(`fx-${nextSession++}`), updatedAt: Date.now(), running: false, blank: true, cwd,
      }
      sessions.push(created)
      modelSelections.set(created.sessionId, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
      const emitSession = (): void => {
        emitRemote('api-session/added', [created])
      }
      if (workspace !== undefined && options.failWorkspaceAttach) {
        emitSession()
        return attachFailure(created.sessionId, workspace.workspaceId)
      }
      if (workspace !== undefined && options.createFrameOrder === 'workspace-first') {
        attachWorkspace(created.sessionId)
        emitSession()
      } else {
        emitSession()
        if (workspace !== undefined) attachWorkspace(created.sessionId)
      }
      if (options.dropSessionCreateResponse) throw new Error('fixture: dropped session.create response after publication')
      return sessionOk({ sessionId: created.sessionId })
    },
    rename: (request) => {
      const missing = requireRemoteSession(request)
      if (missing !== undefined) return missing
      const { sessionId, title } = request
      const normalized = title.trim().replace(/\s+/g, ' ')
      if (normalized.length === 0) {
        return sessionErr({
          code: 'session/title-invalid',
          message: 'session title must contain visible characters',
          details: { sessionId },
        })
      }
      // The append emits the durable event and its control projection frame;
      // the unary response settles the caller first.
      append(sessionId, {
        type: 'session/title',
        data: { title: normalized, messageSeqs: [], source: { kind: 'user' } },
      })
      const appended = logOf(sessionId).at(-1) as SessionEvent
      return sessionOk({ title: normalized, seq: appended.seq })
    },
    fork: (request) => {
      const { sessionId, atSeq } = request
      const source = summaryOf(sessionId)
      if (source === undefined) {
        return sessionErr({
          code: 'session/not-found',
          message: `no session ${sessionId}`,
          details: { sessionId },
        })
      }
      const log = logs.get(sessionId) ?? []
      const lastSeq = log.at(-1)?.seq ?? -1
      const anchoredBoundary = atSeq === undefined
        ? undefined
        : log.find(e => e.type === 'turn/end' && e.seq >= atSeq)
      const boundary = anchoredBoundary
          ?? (atSeq === undefined || atSeq > lastSeq
            ? log.findLast(e => e.type === 'turn/end')
            : undefined)
      if (boundary === undefined) {
        return sessionErr({
          code: 'session/fork-unavailable',
          message: atSeq !== undefined && atSeq <= lastSeq
            ? `session ${sessionId} has not completed the turn containing event ${String(atSeq)}`
            : `session ${sessionId} has no completed turn`,
          details: { sessionId },
        })
      }
      let cut = boundary.seq + 1
      while (cut < log.length && log[cut]?.type !== 'turn/start') cut++
      const child: FixtureSessionSummary = {
        sessionId: sid(`fx-${nextSession++}`), updatedAt: Date.now(), running: false, blank: false,
        parentSessionId: sessionId,
        ...source.cwd === undefined ? {} : { cwd: source.cwd },
      }
      logs.set(child.sessionId, log.slice(0, cut))
      sessions.push(child)
      emitRemote('api-session/added', [child])
      const workspace = workspaces.find(w => w.sessionIds.includes(sessionId))
      if (workspace !== undefined) {
        workspace.sessionIds = [child.sessionId, ...workspace.sessionIds]
        workspace.updatedAt = new Date().toISOString()
        emitWorkspace({ type: 'upsert', workspace: workspaceSnapshot(workspace) })
      }
      return sessionOk({ sessionId: child.sessionId })
    },
    history: async (request) => {
      const log = logs.get(request.sessionId) ?? []
      const throughSeq = request.throughSeq ?? log.length - 1
      const boundedLog = log.slice(0, throughSeq + 1)
      // Snapshot at request time, then deliver after the transit delay.
      const page = pageOf(boundedLog, request.beforeSeq, request.maxMessages ?? 50)
      const doomed = failNextHistory
      failNextHistory = false
      const delay = historyDelayMs
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
      if (doomed) throw new Error('fixture: simulated history transport failure')
      return sessionOk(page)
    },
    selectModel: (request) => {
      const selected: ModelSelection = {
        provider: request.provider,
        model: request.model,
        ...request.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: request.reasoningEffort },
      }
      append(request.sessionId, { type: 'model/selection', data: selected })
      modelSelections.set(request.sessionId, selected)
      return sessionOk({ selected })
    },
    prompt: (request) => {
      const { sessionId: id, mode, content } = request
      const summary = summaryOf(id)
      if (summary === undefined) {
        return sessionErr({ code: 'session/not-found', message: `no session ${id}`, details: { sessionId: id } })
      }
      if (options.rejectPrompt) {
        if (content.some(block => block.type === 'image')) {
          return sessionErr({
            code: 'session/attachment-invalid',
            message: 'fixture: image side exceeds the deployment limit',
            details: { reason: 'IMAGE_DIMENSION_TOO_LARGE' },
          })
        }
        return sessionErr({
          code: 'session/agent-busy',
          message: 'fixture: prompt rejected before acceptance',
          details: { reason: 'fixture-prompt-rejection' },
        })
      }
      summary.updatedAt = Date.now()
      // First accepted prompt appends events: the summary stops being blank.
      summary.blank = false
      const userText = content.map(b => (b.type === 'text' ? b.text : '')).join('')
      const durable: ContentBlock[] = content.map((block) => {
        if (block.type === 'text') return block
        const attachment: ImageAttachmentRef = {
          attachmentId: `fixture:${randomUuid()}` as AttachmentIdType,
          mediaType: block.mediaType,
          bytes: Math.max(
            1,
            Math.floor(block.data.length * 3 / 4)
              - (block.data.endsWith('==') ? 2 : block.data.endsWith('=') ? 1 : 0),
          ),
          width: 160,
          height: 90,
          ...block.name === undefined ? {} : { name: block.name },
        }
        attachments.set(String(attachment.attachmentId), { attachment, data: block.data })
        return { type: 'image', attachment }
      })
      // The host echoes the prompt's requestId as the user source's rpcId;
      // the Session object retires its local submission echo on it. The
      // user-rpc source member is declared by dsh-api-session-controller,
      // which this standalone fixture does not import — hence the assertion.
      const promptSource = { kind: 'user', rpcId: request.requestId } as MessageSource
      if (mode === 'steer' && replays.has(id)) {
        // Steering: the durable user/message lands inside the current turn; the replay continues.
        append(id, { type: 'user/message', surfaceOp: 'append', data: userMessage(durable, promptSource) })
        return sessionOk({ accepted: true as const })
      }
      const turn = nextTurn.get(id) ?? 0
      nextTurn.set(id, turn + 1)
      setRunning(id, true)
      append(id, { type: 'turn/start', data: { turn } })
      // Boundary flush parallel (the host's step/start observer): an outstanding
      // /plan selection commits as plan/mode inside the opened turn.
      const plan = foldPlan(logOf(id))
      if (plan.wanted !== null && plan.wanted !== plan.active) {
        append(id, { type: 'plan/mode', data: { active: plan.wanted } })
      }
      append(id, { type: 'user/message', surfaceOp: 'append', data: userMessage(durable, promptSource) })
      // Capacity parallel of the host token-meter's request/context record:
      // log-only, appended inside the open turn, and deduplicated against the
      // route already recorded (the fixture never varies contextWindow).
      const selection = modelSelections.get(id) ?? { provider: 'deepseek', model: 'deepseek-v4-flash' }
      const previousHeader = logOf(id).findLast(event => event.type === 'request/header')
      const previousSelection = previousHeader?.type === 'request/header'
        ? {
          provider: previousHeader.data.header.config.provider,
          model: previousHeader.data.header.config.model,
          ...(previousHeader.data.header.config.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: previousHeader.data.header.config.reasoningEffort }),
        }
        : null
      if (!sameModelSelection(previousSelection, selection)) {
        append(id, {
          type: 'request/header',
          data: {
            header: { config: selection },
            reason: previousHeader === undefined ? 'initial' : 'change',
          },
        })
      }
      if (lastRequestContext(logOf(id))?.model !== selection.model) {
        append(id, {
          type: 'request/context',
          data: { provider: selection.provider, model: selection.model, contextWindow: 128_000 },
        })
      }
      startReply(
        id,
        turn,
        userText === 'render markdown'
          ? MARKDOWN_FIXTURE
          : userText === 'report model'
            ? (() => {
              const selection = modelSelections.get(id)
              return `当前模型：${selection?.provider ?? 'unknown'}/${selection?.model ?? 'unknown'}`
                  + (selection?.reasoningEffort === undefined ? '' : ` · 推理等级：${selection.reasoningEffort}`)
            })()
            : `回声：${userText}。这是 fixture 的流式回复，用于验证打字机增长与定稿切换。`,
      )
      return sessionOk({ accepted: true as const })
    },
    attachment: (request) => {
      const stored = attachments.get(String(request.attachmentId))
      if (stored === undefined) {
        return sessionErr({
          code: 'session/attachment-invalid',
          message: 'fixture attachment missing',
          details: { reason: 'ATTACHMENT_NOT_FOUND' },
        })
      }
      if (!logReferencesAttachment(
        logs.get(request.sessionId) ?? [],
        String(request.attachmentId),
      )) {
        return sessionErr({
          code: 'session/attachment-invalid',
          message: 'fixture attachment is not referenced by this session',
          details: { reason: 'ATTACHMENT_NOT_REFERENCED' },
        })
      }
      return sessionOk(stored)
    },
    updateQueue: request => sessionErr({
      code: 'session/queue-item-not-found',
      message: 'fixture has no pending queue item',
      details: { itemId: request.itemId },
    }),
    cancel: (request) => {
      const replay = replays.get(request.sessionId)
      if (replay !== undefined) {
        clearTimeout(replay.timer)
        replay.finish(true)
      } else {
        setRunning(request.sessionId, false)
      }
      return sessionOk({ accepted: true as const })
    },
  }

  const controlBaseline = (): Extract<FixtureControlFrame, { type: 'baseline' }> => {
    const queues: Record<string, readonly never[]> = {}
    const jobs: Record<string, readonly never[]> = {}
    const projections: Record<string, FixtureProjectionsBlock> = {}
    for (const summary of sessions) {
      queues[summary.sessionId] = []
      jobs[summary.sessionId] = []
      const log = logs.get(summary.sessionId) ?? []
      projections[summary.sessionId] = {
        asOfSeq: log.length - 1,
        values: projectionValuesOf(log),
      }
    }
    return {
      type: 'baseline',
      value: {
        queues,
        jobs,
        approvals: [],
        questions: [],
        projections,
      },
    }
  }

  const approvalInvocation = (): FixtureRemoteEventInvocationFrame => ({
    type: 'waterfall',
    event: 'approval/request',
    eventId: pendingApprovalEventId,
    agentId: sid('fx-alpha'),
    request: {
      toolName: 'dangerous_tool',
      reason: 'fixture 常驻审批（可答：批准/拒绝后消失）',
    },
  })

  const questionInvocation = (): FixtureRemoteEventInvocationFrame => ({
    type: 'waterfall',
    event: 'user-questions/request',
    eventId: pendingQuestionEventId,
    agentId: sid('fx-alpha'),
    request: {
      questions: fixtureQuestions,
    },
  })

  async function* openControl(signal: AbortSignal): AsyncGenerator<FixtureControlFrame> {
    signal.throwIfAborted()
    const conn = new FxInbox<FixtureControlFrame>()
    controlConns.add(conn)
    const breakNow = (): void => { conn.breakNow() }
    streamBreakers.add(breakNow)
    try {
      yield controlBaseline()
      yield* conn.drain(signal)
    } finally {
      streamBreakers.delete(breakNow)
      controlConns.delete(conn)
    }
  }

  async function* openWorkspace(signal: AbortSignal): AsyncGenerator<WorkspaceFollowFrame> {
    signal.throwIfAborted()
    const conn = new FxInbox<WorkspaceFollowFrame>()
    workspaceConns.add(conn)
    const breakNow = (): void => { conn.breakNow() }
    streamBreakers.add(breakNow)
    try {
      yield workspaceBaseline()
      yield* conn.drain(signal)
    } finally {
      streamBreakers.delete(breakNow)
      workspaceConns.delete(conn)
    }
  }

  async function* openRemoteEvents(
    signal: AbortSignal,
  ): AsyncGenerator<FixtureRemoteEventReadyFrame | FixtureRemoteEventFrame> {
    signal.throwIfAborted()
    const clientId = randomUuid()
    const conn = new FxInbox<FixtureRemoteEventFrame>()
    remoteEventConns.set(clientId, conn)
    // Periodic material for the RPC-panel acceptance: flip fx-gamma every 5s.
    // fx-gamma only; the conversation replay owns fx-alpha's running state.
    const timer = setInterval(() => {
      const gamma = summaryOf(sid('fx-gamma'))
      /* v8 ignore next -- the fixture never removes fx-gamma. */
      if (gamma !== undefined) setRunning(gamma.sessionId, !gamma.running)
    }, 5000)
    try {
      yield { type: 'ready', clientId, host: { home: FIXTURE_HOME } }
      if (approvalPending) yield approvalInvocation()
      if (questionPending) yield questionInvocation()
      yield* conn.drain(signal)
    } finally {
      clearInterval(timer)
      remoteEventConns.delete(clientId)
    }
  }

  async function* openFollow(
    request: FixtureFollowRequest,
    signal: AbortSignal,
  ): AsyncGenerator<FixtureFollowFrame> {
    signal.throwIfAborted()
    const sessionId = request.address.kind === 'session'
      ? request.address.sessionId
      : request.address.childSessionId
    if (summaryOf(sessionId) === undefined) throw new Error(`fixture: no session ${sessionId}`)
    const conn = new FxInbox<FixtureFollowEventFrame>()
    let conns = followConns.get(sessionId)
    if (conns === undefined) {
      conns = new Set()
      followConns.set(sessionId, conns)
    }
    conns.add(conn)
    const breakNow = (): void => { conn.breakNow() }
    streamBreakers.add(breakNow)
    const snapshot = [...logOf(sessionId)]
    const cursor = snapshot.at(-1)?.seq ?? -1
    const summary = summaryOf(sessionId)
    /* v8 ignore next -- existence was checked before the stream registered. */
    if (summary === undefined) throw new Error(`fixture: no session ${sessionId}`)
    const initial = pageOf(snapshot, undefined, request.maxMessages ?? 50)
    let nextSeq = cursor + 1
    try {
      yield {
        type: 'snapshot',
        header: {
          version: SESSION_FORMAT_VERSION,
          id: sessionId,
          createdAt: summary.updatedAt,
          ...(summary.cwd === undefined ? {} : { cwd: summary.cwd }),
          ...(summary.parentSessionId === undefined ? {} : { parentSession: summary.parentSessionId }),
          isSeeded: summary.parentSessionId !== undefined,
          ...(summary.origin === undefined ? {} : { origin: summary.origin }),
          ...(summary.agentPreset === undefined ? {} : { agentPreset: summary.agentPreset }),
        },
        cursor,
        records: initial.records,
        hasMore: initial.hasMore,
        projections: { asOfSeq: cursor, values: projectionValuesOf(snapshot) },
        ...(request.assistantStream === true ? {
          assistantStream: {
            revision: assistantRevisions.get(sessionId) ?? 0,
            ...(activeAttempts.get(sessionId) === undefined
              ? {}
              : { activeAttempt: {
                attemptId: (activeAttempts.get(sessionId) as FixtureAttemptState).attemptId,
                startedAfterSeq: (activeAttempts.get(sessionId) as FixtureAttemptState).startedAfterSeq,
                turn: (activeAttempts.get(sessionId) as FixtureAttemptState).turn,
                step: (activeAttempts.get(sessionId) as FixtureAttemptState).step,
                nextIndex: (activeAttempts.get(sessionId) as FixtureAttemptState).index,
                stream: (activeAttempts.get(sessionId) as FixtureAttemptState).stream.snapshot(),
              } }),
          },
        } : {}),
      }
      for await (const frame of conn.drain(signal)) {
        if (frame.type === 'assistant-stream') {
          yield frame
          continue
        }
        if (frame.event.seq < nextSeq) continue
        if (frame.event.seq !== nextSeq) {
          throw new Error(`fixture: session event stream skipped seq ${String(nextSeq)}`)
        }
        nextSeq++
        yield frame
      }
    } finally {
      streamBreakers.delete(breakNow)
      conns.delete(conn)
      if (conns.size === 0) followConns.delete(sessionId)
    }
  }

  const answerRemoteEvent = (result: FixtureRemoteEventResult): ConnectionRpcResult<unknown> => {
    if (!remoteEventConns.has(result.clientId)) {
      return {
        ok: false,
        error: {
          code: 'gateway/invocation-unavailable',
          message: 'fixture Remote event result identifies no active event stream',
          details: {},
        },
      }
    }
    if (result.eventId === pendingApprovalEventId) {
      if (!approvalPending) return { ok: true, value: undefined }
      approvalPending = false
    } else if (result.eventId === pendingQuestionEventId) {
      if (!questionPending) return { ok: true, value: undefined }
      questionPending = false
    } else {
      return { ok: true, value: undefined }
    }
    emitRemoteFrame({ type: 'cancel', eventId: result.eventId })
    return { ok: true, value: undefined }
  }

  const workspaceApi: FixtureWorkspaceApi = {
    create: (request) => {
      const existing = workspaces.find(workspace => workspace.path === request.path)
      if (existing !== undefined) {
        return sessionOk({ workspace: workspaceSnapshot(existing), created: false })
      }
      const now = new Date().toISOString()
      const created: FixtureWorkspace = {
        workspaceId: wid(`fx-ws-${nextWorkspace++}`),
        path: request.path,
        title: request.path.split('/').filter(Boolean).at(-1) ?? request.path,
        sessionIds: [],
        createdAt: now,
        updatedAt: now,
      }
      workspaces.unshift(created)
      const workspace = workspaceSnapshot(created)
      emitWorkspace({ type: 'upsert', workspace })
      return sessionOk({ workspace, created: true })
    },
    rename: (request) => {
      const workspace = workspaces.find(candidate => candidate.workspaceId === request.workspaceId)
      if (workspace === undefined) {
        return sessionErr({
          code: 'workspace/not-found',
          message: `no workspace ${request.workspaceId}`,
          details: { workspaceId: request.workspaceId },
        })
      }
      const title = request.title.trim()
      if (title === '') {
        return sessionErr({
          code: 'gateway/bad-request',
          message: 'Workspace rename requires a non-blank title',
          details: {},
        })
      }
      if (title !== workspace.title) {
        if (workspaces.some(candidate => candidate.workspaceId !== request.workspaceId && candidate.title === title)) {
          return sessionErr({
            code: 'workspace/name-conflict',
            message: `workspace name '${title}' is already in use`,
            details: { name: title },
          })
        }
        workspace.title = title
        workspace.updatedAt = new Date().toISOString()
        emitWorkspace({ type: 'upsert', workspace: workspaceSnapshot(workspace) })
      }
      return sessionOk({ workspace: workspaceSnapshot(workspace) })
    },
    delete: (request) => {
      const index = workspaces.findIndex(workspace => workspace.workspaceId === request.workspaceId)
      if (index === -1) {
        return sessionErr({
          code: 'workspace/not-found',
          message: `no workspace ${request.workspaceId}`,
          details: { workspaceId: request.workspaceId },
        })
      }
      workspaces.splice(index, 1)
      emitWorkspace({ type: 'remove', workspaceId: request.workspaceId })
      return sessionOk({ deleted: true })
    },
    insertBefore: (request) => {
      const source = workspaces.findIndex(workspace => workspace.workspaceId === request.workspaceId)
      const anchor = request.beforeWorkspaceId === undefined
        ? workspaces.length
        : workspaces.findIndex(workspace => workspace.workspaceId === request.beforeWorkspaceId)
      const missing = source === -1
        ? request.workspaceId
        : anchor === -1
          ? request.beforeWorkspaceId
          : undefined
      if (missing !== undefined) {
        return sessionErr({
          code: 'workspace/not-found',
          message: `no workspace ${missing}`,
          details: { workspaceId: missing },
        })
      }
      if (request.beforeWorkspaceId !== request.workspaceId) {
        const previousOrder = workspaces.map(workspace => workspace.workspaceId)
        const [workspace] = workspaces.splice(source, 1)
        /* v8 ignore next -- source was resolved from the same array immediately above. */
        if (workspace === undefined) throw new Error(`fixture lost workspace ${request.workspaceId}`)
        const at = request.beforeWorkspaceId === undefined
          ? workspaces.length
          : workspaces.findIndex(candidate => candidate.workspaceId === request.beforeWorkspaceId)
        workspaces.splice(at, 0, workspace)
        if (workspaces.some((candidate, index) => candidate.workspaceId !== previousOrder[index])) {
          emitWorkspace({
            type: 'order',
            workspaceIds: workspaces.map(candidate => candidate.workspaceId),
          })
        }
      }
      return sessionOk({ workspaceIds: workspaces.map(candidate => candidate.workspaceId) })
    },
    insertSessionBefore: (request) => {
      const workspace = workspaces.find(candidate => candidate.workspaceId === request.workspaceId)
      if (workspace === undefined) {
        return sessionErr({
          code: 'workspace/not-found',
          message: `no workspace ${request.workspaceId}`,
          details: { workspaceId: request.workspaceId },
        })
      }
      if (!workspace.sessionIds.includes(request.sessionId)
        || (request.beforeSessionId !== undefined && !workspace.sessionIds.includes(request.beforeSessionId))) {
        return sessionErr({
          code: 'workspace/move-invalid',
          message: `session or anchor is not accounted by workspace ${request.workspaceId}`,
          details: {
            workspaceId: request.workspaceId,
            sessionId: request.sessionId,
            ...request.beforeSessionId === undefined ? {} : { beforeSessionId: request.beforeSessionId },
          },
        })
      }
      const without = workspace.sessionIds.filter(id => id !== request.sessionId)
      const at = request.beforeSessionId === undefined ? without.length : without.indexOf(request.beforeSessionId)
      const sessionIds = [...without.slice(0, at), request.sessionId, ...without.slice(at)]
      if (!sessionIds.every((id, index) => id === workspace.sessionIds[index])) {
        workspace.sessionIds = sessionIds
        workspace.updatedAt = new Date().toISOString()
        emitWorkspace({ type: 'upsert', workspace: workspaceSnapshot(workspace) })
      }
      return sessionOk({ workspace: workspaceSnapshot(workspace) })
    },
    archiveSession: (request) => {
      if (summaryOf(request.sessionId) === undefined) {
        return sessionErr({
          code: 'session/not-found',
          message: `no session ${request.sessionId}`,
          details: { sessionId: request.sessionId },
        })
      }
      if (!archivedSessionIds.includes(request.sessionId)) {
        archivedSessionIds.push(request.sessionId)
        emitWorkspace({ type: 'archived', archivedSessionIds: [...archivedSessionIds] })
      }
      return sessionOk({ archivedSessionIds: [...archivedSessionIds] })
    },
  }

  const rpc: ClientConnectionRpc = {
    call(channel, endpoint, payload, signal) {
      if (channel !== '/api') {
        return Promise.reject(new Error(`fixture connection RPC channel ${JSON.stringify(channel)} is unavailable`))
      }
      const args = (payload as {
        args: Readonly<{
          agentId: SessionId
          line?: string
          query?: string
          path?: string
          name?: string
          images?: readonly unknown[]
          // A goal ref and a credential reference name share this wire field name.
          ref?: string | { id: string; revision: number }
          refs?: readonly string[]
          value?: string
          ns?: string
          settingsNs?: string
          agentPreset?: string
          from?: string
          id?: string
          request?: unknown
          _request?: unknown
        }>
      }).args
      const sessionId = args.agentId
      const callSignal = signal ?? new AbortController().signal
      const request = args.request
      switch (endpoint) {
        case 'commands/list': return Promise.resolve(commandRemotes.list(sessionId))
        case 'commands/execute': return Promise.resolve(commandRemotes.execute(sessionId, args.line as string, args.images ?? []))
        case 'fileReferences/list': return Promise.resolve(referenceRemotes.files(sessionId, args.query ?? ''))
        case 'sessionReferenceResolver/candidates': return Promise.resolve(referenceRemotes.sessions(sessionId, args.query ?? ''))
        case 'directoryPicker/pick': return Promise.resolve(directoryPickerRemotes.pick())
        case 'directoryPicker/list': return Promise.resolve(directoryPickerRemotes.list(args.path))
        case 'directoryPicker/createDirectory':
          return Promise.resolve(directoryPickerRemotes.createDirectory(args.path ?? '', args.name ?? ''))
        case 'goals/create': return Promise.resolve(goalRemotes.create(sessionId, {
          objective: (request as { objective?: string } | undefined)?.objective as string,
          ...(request as { maxGoalRounds?: number } | undefined)?.maxGoalRounds === undefined
            ? {}
            : { maxGoalRounds: (request as { maxGoalRounds: number }).maxGoalRounds },
        }))
        case 'goals/edit': return Promise.resolve(goalRemotes.edit(
          sessionId,
          args.ref as FxGoalRef,
          request as { objective?: string; maxGoalRounds?: number },
        ))
        case 'goals/pause': return Promise.resolve(goalRemotes.pause(sessionId, args.ref as FxGoalRef))
        case 'goals/resume': return Promise.resolve(goalRemotes.resume(sessionId, args.ref as FxGoalRef))
        case 'goals/complete': return Promise.resolve(goalRemotes.complete(sessionId, args.ref as FxGoalRef))
        case 'goals/clear': return Promise.resolve(goalRemotes.clear(sessionId, args.ref as FxGoalRef))
        case 'agentPresets/list': return Promise.resolve(presetRemotes.list())
        case 'agentPresets/select': return Promise.resolve(presetRemotes.select(sessionId, args.agentPreset as string))
        case 'agentPresets/read': return Promise.resolve(presetRemotes.read(args.agentPreset as string))
        case 'agentPresets/copy': return Promise.resolve(presetRemotes.copy(args.from as string, args.id as string))
        case 'agentPresets/deletePreset': return Promise.resolve(presetRemotes.deletePreset(args.id as string))
        case 'subagents/list': return Promise.resolve({
          ok: true,
          value: { entries: [], parentAvailable: true },
        })
        case 'subagents/prompt': return Promise.resolve({
          ok: true,
          value: {
            messageId: `fixture-message-${(request as { childSessionId: SessionId }).childSessionId}`,
          },
        })
        case 'subagents/interruptByParent': return Promise.resolve({ ok: true, value: { accepted: true } })
        case 'credentials/describe': return Promise.resolve(credentialRemotes.describe(args.refs ?? []))
        case 'credentials/set': return Promise.resolve(credentialRemotes.set(args.ref as string))
        case 'credentials/unset': return Promise.resolve(credentialRemotes.unset(args.ref as string))
        case 'settings/describe': return Promise.resolve(settingsRemotes.describe())
        case 'settings/canOpenAgentPresetDirectory': return Promise.resolve({ ok: true, value: true })
        case 'settings/openSettingsDocument': return Promise.resolve(settingsRemotes.openSettingsDocument())
        case 'settings/openAgentPresetDirectory': return Promise.resolve(
          settingsRemotes.openAgentPresetDirectory(args.agentPreset as string),
        )
        case 'skills/list': {
          const skillRequest = request as { readonly sessionId: SessionId }
          const missing = requireRemoteSession(skillRequest)
          if (missing !== undefined) return missing
          return sessionOk({
            skills: [
              { name: 'fixture-demo', description: 'fixture 技能样本', whenToUse: '仅供 UI 目录渲染验收', modelInvocable: true },
              { name: 'fixture-user-only', description: 'fixture 仅用户技能样本', modelInvocable: false },
            ],
          })
        }
        case 'session/openWorkspacePath': {
          return sessionOk({ opened: true as const })
        }
        case 'session/canOpenWorkspacePath': return Promise.resolve({ ok: true, value: true })
        case 'session/modelCatalog': return Promise.resolve({
          ok: true,
          value: {
            default: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
            routableProviders: ['deepseek-official', 'openai', 'acme-gateway'],
            groups: fixtureModelGroups(),
            failures: [],
          },
        })
        case 'llm/listProviders': return Promise.resolve({
          ok: true,
          value: [
            { id: 'deepseek-official', name: 'DeepSeek' },
            { id: 'openai', name: 'openai' },
            { id: 'acme-gateway', name: 'Acme Gateway' },
          ],
        })
        case 'llm/listConfigurableProviders': return Promise.resolve({
          ok: true,
          value: [
            { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
            { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], declared: false },
            { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], declared: false },
            { provider: 'acme-gateway', displayName: 'Acme Gateway', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'acme-gateway'], declared: true },
          ],
        })
        // The fixture endpoint is imaginary, so interrogation answers the
        // catalog it already serves without a network request.
        case 'llm/discoverModels': return Promise.resolve({
          ok: true,
          value: fixtureModelGroups().flatMap(group => group.models.map(model => ({ id: model.id, name: model.name }))),
        })
        case 'settings/update': return Promise.resolve(settingsRemotes.update(args.ns as string))
        case 'settings/replace': return Promise.resolve(settingsRemotes.replace(args.ns as string))
        case 'settings/mutate': return Promise.resolve(settingsRemotes.mutate(args.ns as string))
        case 'session/list': return sessionApi.list(
          args._request as Parameters<FixtureSessionApi['list']>[0],
        )
        case 'session/search': return sessionApi.search(
          request as Parameters<FixtureSessionApi['search']>[0],
          callSignal,
        )
        case 'session/create': return sessionApi.create(
          request as Parameters<FixtureSessionApi['create']>[0],
        )
        case 'session/selectModel': return sessionApi.selectModel(
          request as Parameters<FixtureSessionApi['selectModel']>[0],
        )
        case 'session/rename': return sessionApi.rename(
          request as Parameters<FixtureSessionApi['rename']>[0],
        )
        case 'session/fork': return sessionApi.fork(
          request as Parameters<FixtureSessionApi['fork']>[0],
        )
        case 'session/prompt': return sessionApi.prompt(
          request as Parameters<FixtureSessionApi['prompt']>[0],
        )
        case 'session/attachment': return sessionApi.attachment(
          request as Parameters<FixtureSessionApi['attachment']>[0],
        )
        case 'session/updateQueue': return sessionApi.updateQueue(
          request as Parameters<FixtureSessionApi['updateQueue']>[0],
        )
        case 'session/cancel': return sessionApi.cancel(
          request as Parameters<FixtureSessionApi['cancel']>[0],
        )
        case 'session/page': {
          const page = request as FixturePageRequest
          const pageSessionId = page.address.kind === 'session'
            ? page.address.sessionId
            : page.address.childSessionId
          return sessionApi.history({
            sessionId: pageSessionId,
            throughSeq: page.throughSeq,
            ...page.beforeSeq === undefined ? {} : { beforeSeq: page.beforeSeq },
            ...page.maxMessages === undefined ? {} : { maxMessages: page.maxMessages },
          })
        }
        case '$events/result': return Promise.resolve(answerRemoteEvent(args as unknown as FixtureRemoteEventResult))
        case 'workspace/create': return workspaceApi.create(request as WorkspaceCreateRequest)
        case 'workspace/rename': return workspaceApi.rename(request as WorkspaceRenameRequest)
        case 'workspace/delete': return workspaceApi.delete(request as WorkspaceDeleteRequest)
        case 'workspace/insertBefore': return workspaceApi.insertBefore(request as WorkspaceInsertBeforeRequest)
        case 'workspace/insertSessionBefore': return workspaceApi.insertSessionBefore(
          request as WorkspaceInsertSessionBeforeRequest,
        )
        case 'workspace/archiveSession': return workspaceApi.archiveSession(request as WorkspaceArchiveSessionRequest)
        default:
          return Promise.reject(new Error(`fixture connection RPC endpoint ${JSON.stringify(endpoint)} is unavailable`))
      }
    },
    open(channel, endpoint, payload, signal) {
      if (channel !== '/api') {
        throw new Error(`fixture connection RPC channel ${JSON.stringify(channel)} is unavailable`)
      }
      const args = (payload as { args: Readonly<{ request?: unknown }> }).args
      switch (endpoint) {
        case '$events': return openRemoteEvents(signal)
        case 'session/control': return openControl(signal)
        case 'session/follow': return openFollow(args.request as FixtureFollowRequest, signal)
        case 'workspace/follow': return openWorkspace(signal)
        default:
          throw new Error(`fixture connection stream endpoint ${JSON.stringify(endpoint)} is unavailable`)
      }
    },
  }
  return { rpc }
}

/**
 * Build the browser fixture transport from the current page's query switches.
 * @returns an in-memory Connection RPC transport.
 */
export function createFixtureConnectionRpc(): ClientConnectionRpc {
  return createFixtureWorld(fixtureOptionsFromLocation()).rpc
}

/** Browser query mapping; direct unit callers pass FixtureOptions explicitly. */
function fixtureOptionsFromLocation(): FixtureOptions {
  if (typeof location === 'undefined') return {}
  const query = new URLSearchParams(location.search)
  return {
    empty: query.get('fixture') === 'empty',
    rejectPrompt: query.get('fixturePrompt') === 'reject',
    failWorkspaceAttach: query.get('fixtureAttach') === 'fail',
    dropSessionCreateResponse: query.get('fixtureSessionCreate') === 'drop-response',
    createFrameOrder: query.get('fixtureFrames') === 'workspace-first' ? 'workspace-first' : 'session-first',
  }
}
