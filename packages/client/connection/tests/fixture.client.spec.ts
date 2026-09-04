import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import type {
  RpcRequest,
  RpcResponse,
  RpcResult,
  SessionEvent,
  SessionId,
  StreamChunk,
} from '../src/client/api.ts'
import { RpcId } from '../src/client/api.ts'
import {
  createFixtureConnectionRpc,
  createFixtureFaces,
  type FixtureAssistantStreamFrame,
  type FixtureOptions,
} from '../src/client/fixture.ts'
import type {
  ClientConnectionRpc, ConnectionRpcResult,
} from '../src/rpc.ts'
import type { DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types'
import type {
  ModelCatalog, ModelSelection, SessionAssistantStreamFrame,
} from '@deepseek-ai/dsh-api-session-controller/types'

const sid = (id: string): SessionId => id as SessionId
type WorkspaceId = string & { readonly __fixtureWorkspaceId: 'WorkspaceId' }
const req = <P>(payload: P): RpcRequest<P> => ({ rpcId: RpcId(`t-${Math.abs(Math.sin(reqCount++)).toString(36).slice(2, 10)}`), payload })
let reqCount = 0

interface FixtureSessionSummary {
  sessionId: SessionId
  updatedAt: number
  running: boolean
  blank: boolean
  parentSessionId?: SessionId
  origin?: 'subagent'
  cwd?: string
  agentPreset?: string
}

interface FixtureHistoryEntry {
  readonly type: 'event'
  readonly event: SessionEvent
}

type FixtureHistoryRecord = FixtureHistoryEntry

interface FixturePage {
  readonly records: readonly FixtureHistoryRecord[]
  readonly hasMore: boolean
}

function historyEvents(records: readonly FixtureHistoryRecord[]): SessionEvent[] {
  return records.map(record => record.event)
}

function isReasoningDeltaChunk(
  value: unknown,
): value is Extract<StreamChunk, { readonly type: 'reasoning-delta' }> {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { readonly type?: unknown; readonly text?: unknown }
  return record.type === 'reasoning-delta' && typeof record.text === 'string'
}

type FixtureFollowFrame =
  | {
    readonly type: 'snapshot'
    readonly cursor: number
    readonly records: readonly FixtureHistoryRecord[]
    readonly hasMore: boolean
    readonly projections: {
      readonly asOfSeq: number
      readonly values: Readonly<Record<string, unknown>>
    }
    readonly assistantStream?: {
      readonly revision: number
      readonly activeAttempt?: {
        readonly attemptId: string
        readonly startedAfterSeq: number
        readonly turn: number
        readonly step: number
        readonly nextIndex: number
        readonly stream: readonly unknown[]
      }
    }
  }
  | FixtureHistoryEntry
  | { readonly type: 'assistant-stream'; readonly frame: FixtureAssistantStreamFrame }

type FixtureControlFrame =
  | {
    readonly type: 'baseline'
    readonly value: {
      readonly queues: Readonly<Record<string, readonly unknown[]>>
      readonly jobs: Readonly<Record<string, readonly unknown[]>>
      readonly approvals: readonly unknown[]
      readonly questions: readonly unknown[]
      readonly projections: Readonly<Record<string, {
        readonly asOfSeq: number
        readonly values: Readonly<Record<string, unknown>>
      }>>
    }
  }
  | {
    readonly type: 'projection'
    readonly sessionId: SessionId
    readonly key: string
    readonly value: unknown
    readonly seq: number
  }

interface FixtureSessionRequests {
  list: { readonly cursor?: string }
  search: { readonly query: string }
  create: {
    readonly workspaceId?: WorkspaceId
    readonly cwd?: string
    readonly sessionId?: SessionId
    readonly agentPreset?: string
  }
  history: {
    readonly sessionId: SessionId
    readonly beforeSeq?: number
    readonly maxMessages?: number
  }
  selectModel: {
    readonly sessionId: SessionId
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  }
  prompt: {
    readonly sessionId: SessionId
    readonly mode: 'queue' | 'steer'
    readonly content: readonly ({ readonly type: 'text'; readonly text: string } | {
      readonly type: 'image'
      readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
      readonly data: string
      readonly name?: string
    })[]
  }
  cancel: { readonly sessionId: SessionId }
  rename: { readonly sessionId: SessionId; readonly title: string }
}

interface FixtureSessionValues {
  list: { readonly items: FixtureSessionSummary[] }
  search: { readonly items: readonly { readonly sessionId: SessionId; readonly snippet: string }[]; readonly hasMore: boolean }
  create: { readonly sessionId: SessionId }
  history: FixturePage
  selectModel: { readonly selected: ModelSelection }
  prompt: { readonly accepted: true }
  cancel: Record<never, never>
  rename: { readonly title: string; readonly seq: number }
}

type FixtureSessionApi = {
  [K in keyof FixtureSessionRequests]: (
    request: RpcRequest<FixtureSessionRequests[K]>,
    signal?: AbortSignal,
  ) => Promise<RpcResponse<FixtureSessionValues[K]>>
}

type FixtureSessionClient = {
  [K in keyof FixtureSessionRequests]: (
    request: FixtureSessionRequests[K],
    signal?: AbortSignal,
  ) => Promise<RpcResponse<FixtureSessionValues[K]>>
}

interface FixtureSessionRemote {
  modelCatalog(): Promise<ConnectionRpcResult<ModelCatalog>>
  follow(sessionId: SessionId, signal: AbortSignal): AsyncIterable<FixtureFollowFrame>
  control(signal: AbortSignal): AsyncIterable<FixtureControlFrame>
}

interface FixtureWorkspaceView {
  readonly workspaceId: WorkspaceId
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly SessionId[]
  readonly createdAt: string
  readonly updatedAt: string
}

interface FixtureWorkspaceRequests {
  create: { readonly path: string }
  rename: { readonly workspaceId: WorkspaceId; readonly title: string }
  delete: { readonly workspaceId: WorkspaceId }
  insertBefore: { readonly workspaceId: WorkspaceId; readonly beforeWorkspaceId?: WorkspaceId }
  insertSessionBefore: {
    readonly workspaceId: WorkspaceId
    readonly sessionId: SessionId
    readonly beforeSessionId?: SessionId
  }
  archiveSession: { readonly sessionId: SessionId }
}

interface FixtureWorkspaceValues {
  create: { readonly workspace: FixtureWorkspaceView; readonly created: boolean }
  rename: { readonly workspace: FixtureWorkspaceView }
  delete: { readonly deleted: true }
  insertBefore: { readonly workspaceIds: readonly WorkspaceId[] }
  insertSessionBefore: { readonly workspace: FixtureWorkspaceView }
  archiveSession: { readonly archivedSessionIds: readonly SessionId[] }
}

type FixtureWorkspaceApi = {
  [K in keyof FixtureWorkspaceRequests]: (
    request: RpcRequest<FixtureWorkspaceRequests[K]>,
    signal?: AbortSignal,
  ) => Promise<RpcResponse<FixtureWorkspaceValues[K]>>
}

type FixtureWorkspaceClient = {
  [K in keyof FixtureWorkspaceRequests]: (
    request: FixtureWorkspaceRequests[K],
    signal?: AbortSignal,
  ) => Promise<RpcResponse<FixtureWorkspaceValues[K]>>
}

type FixtureWorkspaceFrame =
  | {
    readonly type: 'baseline'
    readonly value: {
      readonly items: readonly FixtureWorkspaceView[]
      readonly archivedSessionIds: readonly SessionId[]
    }
  }
  | { readonly type: 'upsert'; readonly workspace: FixtureWorkspaceView }
  | { readonly type: 'remove'; readonly workspaceId: WorkspaceId }
  | { readonly type: 'order'; readonly workspaceIds: readonly WorkspaceId[] }
  | { readonly type: 'archived'; readonly archivedSessionIds: readonly SessionId[] }

interface FixtureWorkspaceRemote {
  follow(signal: AbortSignal): AsyncIterable<FixtureWorkspaceFrame>
}

interface FixtureRemoteEventNotificationFrame {
  readonly type: 'emit'
  readonly event: string
  readonly args: readonly unknown[]
}

interface FixtureRemoteEventRequestFrame {
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
  | FixtureRemoteEventRequestFrame
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

interface FixtureRemoteEventStream extends AsyncIterable<FixtureRemoteEventFrame> {
  readonly clientId: Promise<string>
}

type FixtureTestApi = {
  /** The directory-picking Remote namespace as the fixture serves it. */
  readonly directoryPickerRemote: {
    pick: () => Promise<ConnectionRpcResult<string | null>>
    list: (path?: string) => Promise<ConnectionRpcResult<DirectoryListing>>
    createDirectory: (path: string, name: string) => Promise<ConnectionRpcResult<string>>
  }
  readonly sessions: FixtureSessionApi
  readonly sessionRemote: FixtureSessionRemote
  readonly workspace: FixtureWorkspaceApi
  readonly workspaceRemote: FixtureWorkspaceRemote
  readonly credentialRemote: FixtureCredentialRemote
  readonly settingsRemote: FixtureSettingsRemote
  readonly remoteEvents: (signal: AbortSignal) => FixtureRemoteEventStream
  readonly answerRemoteEvent: (result: FixtureRemoteEventResult) => Promise<unknown>
}

/** Keep existing fixture assertions compact while driving only the new Session Remote endpoints. */
function createFixtureApi(options: FixtureOptions = {}): FixtureTestApi {
  const { rpc } = createFixtureFaces(options)
  return {
    directoryPickerRemote: {
      pick: () => rpc.call('/api', 'directoryPicker/pick', { args: {} }) as
        Promise<ConnectionRpcResult<string | null>>,
      list: (path?: string) => rpc.call('/api', 'directoryPicker/list', { args: { path } }) as
        Promise<ConnectionRpcResult<DirectoryListing>>,
      createDirectory: (path: string, name: string) =>
        rpc.call('/api', 'directoryPicker/createDirectory', { args: { path, name } }) as
          Promise<ConnectionRpcResult<string>>,
    },
    sessions: createSessionApi(rpc),
    sessionRemote: createSessionRemote(rpc),
    workspace: createWorkspaceApi(rpc),
    workspaceRemote: createWorkspaceRemote(rpc),
    credentialRemote: createCredentialRemote(rpc),
    settingsRemote: createSettingsRemote(rpc),
    remoteEvents: (signal: AbortSignal) => openFixtureRemoteEvents(rpc, signal),
    answerRemoteEvent: (result: FixtureRemoteEventResult) =>
      rpc.call('/api', '$events/result', { args: result }),
  }
}

/** The fixture's Credentials Remote endpoints over the shared RPC carrier. */
interface FixtureCredentialRemote {
  describe(refs: readonly string[]): Promise<ConnectionRpcResult<unknown>>
  set(ref: string, value: string): Promise<ConnectionRpcResult<unknown>>
  unset(ref: string): Promise<ConnectionRpcResult<unknown>>
}

/** The settings Remote reads the fixture serves, addressed like the credential half. */
interface FixtureSettingsRemote {
  describe(): Promise<ConnectionRpcResult<unknown>>
  update(ns: string, patch: unknown, expectedRevision?: number): Promise<ConnectionRpcResult<unknown>>
  replace(ns: string, section: unknown, expectedRevision?: number): Promise<ConnectionRpcResult<unknown>>
}

function createSettingsRemote(rpc: ClientConnectionRpc): FixtureSettingsRemote {
  return {
    describe: () => rpc.call('/api', 'settings/describe', { args: {} }),
    update: (ns, patch, expectedRevision) => rpc.call('/api', 'settings/update', {
      args: { ns, patch, expectedRevision },
    }),
    replace: (ns, section, expectedRevision) => rpc.call('/api', 'settings/replace', {
      args: { ns, section, expectedRevision },
    }),
  }
}

function createCredentialRemote(rpc: ClientConnectionRpc): FixtureCredentialRemote {
  return {
    describe: refs => rpc.call('/api', 'credentials/describe', { args: { refs } }),
    set: (ref, value) => rpc.call('/api', 'credentials/set', { args: { ref, value } }),
    unset: ref => rpc.call('/api', 'credentials/unset', { args: { ref } }),
  }
}

function openFixtureRemoteEvents(
  rpc: ClientConnectionRpc,
  signal: AbortSignal,
): FixtureRemoteEventStream {
  const ready = Promise.withResolvers<string>()
  const source = (async function* (): AsyncGenerator<FixtureRemoteEventFrame> {
    const stream = rpc.open?.('/api', '$events', { args: {} }, signal)
    if (stream === undefined) throw new Error('fixture forwarded-event stream is unavailable')
    let opened = false
    for await (const value of stream) {
      if (!opened) {
        expect(value).toMatchObject({ type: 'ready' })
        const clientId: unknown = Reflect.get(value as object, 'clientId')
        if (typeof clientId !== 'string') throw new Error('fixture forwarded-event stream omitted its Client id')
        ready.resolve(clientId)
        opened = true
        continue
      }
      yield value as FixtureRemoteEventFrame
    }
  })()
  return Object.assign(source, { clientId: ready.promise })
}

function createSessionApi(rpc: ClientConnectionRpc): FixtureSessionApi {
  const call = async <K extends keyof FixtureSessionRequests>(
    endpoint: K,
    request: RpcRequest<FixtureSessionRequests[K]>,
    signal?: AbortSignal,
  ): Promise<RpcResponse<FixtureSessionValues[K]>> => {
    const page = endpoint === 'history'
      ? request.payload as FixtureSessionRequests['history']
      : undefined
    const args = endpoint === 'list'
      ? { _request: request.payload }
      : endpoint === 'history'
        ? {
          request: {
            address: { kind: 'session', sessionId: page?.sessionId },
            ...page?.beforeSeq === undefined ? {} : { beforeSeq: page.beforeSeq },
            ...page?.maxMessages === undefined ? {} : { maxMessages: page.maxMessages },
          },
        }
        : { request: request.payload }
    const remoteEndpoint = endpoint === 'history' ? 'page' : endpoint
    const result = await rpc.call('/api', `session/${remoteEndpoint}`, { args }, signal)
    return {
      rpcId: request.rpcId,
      result: result as unknown as RpcResult<FixtureSessionValues[K]>,
    }
  }
  return {
    list: (request, signal) => call('list', request, signal),
    search: (request, signal) => call('search', request, signal),
    create: (request, signal) => call('create', request, signal),
    history: (request, signal) => call('history', request, signal),
    selectModel: (request, signal) => call('selectModel', request, signal),
    prompt: (request, signal) => call('prompt', request, signal),
    cancel: (request, signal) => call('cancel', request, signal),
    rename: (request, signal) => call('rename', request, signal),
  }
}

function createSessionClient(rpc: ClientConnectionRpc): FixtureSessionClient {
  const api = createSessionApi(rpc)
  return {
    list: (request, signal) => api.list(req(request), signal),
    search: (request, signal) => api.search(req(request), signal),
    create: (request, signal) => api.create(req(request), signal),
    history: (request, signal) => api.history(req(request), signal),
    selectModel: (request, signal) => api.selectModel(req(request), signal),
    prompt: (request, signal) => api.prompt(req(request), signal),
    cancel: (request, signal) => api.cancel(req(request), signal),
    rename: (request, signal) => api.rename(req(request), signal),
  }
}

function createSessionRemote(rpc: ClientConnectionRpc): FixtureSessionRemote {
  const open = <F>(endpoint: string, args: object, signal: AbortSignal): AsyncIterable<F> => {
    const stream = rpc.open?.('/api', endpoint, { args }, signal)
    if (stream === undefined) throw new Error(`fixture ${endpoint} stream is unavailable`)
    return stream as AsyncIterable<F>
  }
  return {
    modelCatalog: () => rpc.call('/api', 'session/modelCatalog', { args: {} }) as
      Promise<ConnectionRpcResult<ModelCatalog>>,
    follow: (sessionId, signal) => open<FixtureFollowFrame>('session/follow', {
      request: { address: { kind: 'session', sessionId }, assistantStream: true },
    }, signal),
    control: signal => open<FixtureControlFrame>('session/control', {}, signal),
  }
}

function createWorkspaceApi(rpc: ClientConnectionRpc): FixtureWorkspaceApi {
  const call = async <K extends keyof FixtureWorkspaceRequests>(
    endpoint: K,
    request: RpcRequest<FixtureWorkspaceRequests[K]>,
    signal?: AbortSignal,
  ): Promise<RpcResponse<FixtureWorkspaceValues[K]>> => {
    const result = await rpc.call('/api', `workspace/${endpoint}`, {
      args: { request: request.payload },
    }, signal)
    return {
      rpcId: request.rpcId,
      result: result as unknown as RpcResult<FixtureWorkspaceValues[K]>,
    }
  }
  return {
    create: (request, signal) => call('create', request, signal),
    rename: (request, signal) => call('rename', request, signal),
    delete: (request, signal) => call('delete', request, signal),
    insertBefore: (request, signal) => call('insertBefore', request, signal),
    insertSessionBefore: (request, signal) => call('insertSessionBefore', request, signal),
    archiveSession: (request, signal) => call('archiveSession', request, signal),
  }
}

function createWorkspaceClient(rpc: ClientConnectionRpc): FixtureWorkspaceClient {
  const api = createWorkspaceApi(rpc)
  return {
    create: (request, signal) => api.create(req(request), signal),
    rename: (request, signal) => api.rename(req(request), signal),
    delete: (request, signal) => api.delete(req(request), signal),
    insertBefore: (request, signal) => api.insertBefore(req(request), signal),
    insertSessionBefore: (request, signal) => api.insertSessionBefore(req(request), signal),
    archiveSession: (request, signal) => api.archiveSession(req(request), signal),
  }
}

function createWorkspaceRemote(rpc: ClientConnectionRpc): FixtureWorkspaceRemote {
  return {
    follow(signal) {
      const stream = rpc.open?.('/api', 'workspace/follow', { args: {} }, signal)
      if (stream === undefined) throw new Error('fixture workspace/follow stream is unavailable')
      return stream as AsyncIterable<FixtureWorkspaceFrame>
    },
  }
}

interface TimingHooks {
  setHistoryDelay(ms: number): void
  failNextHistory(): void
  appendUser(id: string, msg: string): void
  appendTitle(id: string, title: string): void
  startReasoningChunkStorm(id: string, chunkCount: number, chunksPerInterval: number, intervalMs: number): string
  reasoningChunkStormState(): {
    sessionId: string
    chunkCount: number
    chunksPerInterval: number
    intervalMs: number
    emitted: number
    marker: string
    emitting: boolean
  } | null
  beginModelRetry(id: string): void
  scheduleModelRetry(id: string, retry?: number, delayMs?: number): void
  cancelModelRetryDuringBackoff(id: string, delayMs?: number): void
  completeModelRetry(id: string): void
  appendSilent(id: string, msg: string): void
  breakStreams(): void
}
const timing = (): TimingHooks => (globalThis as Record<string, unknown>).__fxTiming as TimingHooks

/** Collect value-stream frames until the predicate or a soft cap; abort ends the stream. */
async function collectValues<F>(stream: AsyncIterable<F>, abort: AbortController, done: (frames: F[]) => boolean): Promise<F[]> {
  const frames: F[] = []
  for await (const frame of stream) {
    frames.push(frame)
    if (done(frames) || frames.length > 500) {
      abort.abort()
      break
    }
  }
  return frames
}

async function readControlBaseline(remote: FixtureSessionRemote): Promise<Extract<FixtureControlFrame, { type: 'baseline' }>> {
  const abort = new AbortController()
  for await (const frame of remote.control(abort.signal)) {
    if (frame.type !== 'baseline') continue
    abort.abort()
    return frame
  }
  throw new Error('fixture control baseline missing')
}

function isRemoteEventRequest(frame: FixtureRemoteEventFrame): frame is FixtureRemoteEventRequestFrame {
  return frame.type === 'waterfall'
}

function isRemoteEventCancellation(frame: FixtureRemoteEventFrame): frame is FixtureRemoteEventCancellationFrame {
  return frame.type === 'cancel'
}

async function readResidentRemoteEvents(
  api: FixtureTestApi,
  count: number,
): Promise<FixtureRemoteEventRequestFrame[]> {
  const abort = new AbortController()
  const frames = await collectValues(
    api.remoteEvents(abort.signal),
    abort,
    seen => seen.filter(isRemoteEventRequest).length >= count,
  )
  return frames.filter(isRemoteEventRequest)
}

async function nextRemoteEvent(
  iterator: AsyncIterator<FixtureRemoteEventFrame>,
  predicate: (frame: FixtureRemoteEventFrame) => boolean,
): Promise<FixtureRemoteEventFrame> {
  for (;;) {
    const item = await iterator.next()
    if (item.done) throw new Error('fixture Remote Event stream ended before the expected frame')
    if (predicate(item.value)) return item.value
  }
}

async function readOpeningCursor(remote: FixtureSessionRemote, sessionId: SessionId): Promise<number> {
  const abort = new AbortController()
  for await (const frame of remote.follow(sessionId, abort.signal)) {
    if (frame.type !== 'snapshot') continue
    abort.abort()
    return frame.cursor
  }
  throw new Error('fixture follow opening cursor missing')
}

async function readWorkspaceBaseline(
  remote: FixtureWorkspaceRemote,
): Promise<Extract<FixtureWorkspaceFrame, { type: 'baseline' }>['value']> {
  const abort = new AbortController()
  for await (const frame of remote.follow(abort.signal)) {
    if (frame.type !== 'baseline') continue
    abort.abort()
    return frame.value
  }
  throw new Error('fixture Workspace baseline missing')
}

describe('createFixtureApi', () => {
  it('keeps its Assistant frame vocabulary identical to the controller wire', () => {
    expectTypeOf<FixtureAssistantStreamFrame>().toEqualTypeOf<SessionAssistantStreamFrame>()
  })

  it('serves the session list sorted by updatedAt desc and echoes rpcIds on every unary', async () => {
    const api = createFixtureApi()
    const request = req({})
    const response = await api.sessions.list(request)
    expect(response.rpcId).toBe(request.rpcId)
    if (!response.result.ok) throw new Error('list failed')
    expect(response.result.value.items.map(s => s.sessionId)).toEqual(['fx-alpha', 'fx-beta', 'fx-gamma'])
    expect(response.result.value.items[1]?.parentSessionId).toBe('fx-alpha') // lineage material
  })

  it('returns an empty Assistant baseline when Session follow opts in', async () => {
    const api = createFixtureApi()
    const abort = new AbortController()
    const iterator = api.sessionRemote.follow(sid('fx-alpha'), abort.signal)[Symbol.asyncIterator]()
    try {
      const opening = await iterator.next()
      if (opening.done || opening.value.type !== 'snapshot') throw new Error('follow opening snapshot missing')
      expect(opening.value.assistantStream).toEqual({ revision: 0 })
    } finally {
      abort.abort()
      await iterator.return?.()
    }
  })

  it('searches current message text with literal unicode61-style token phrases', async () => {
    const api = createFixtureApi()
    const signal = new AbortController().signal
    const phrase = await api.sessions.search(req({ query: 'FIXTURE 历史消息' }), signal)
    expect(phrase.result).toMatchObject({
      ok: true,
      value: {
        items: [{ sessionId: 'fx-alpha' }],
        hasMore: false,
      },
    })
    if (!phrase.result.ok) throw new Error('search failed')
    expect(phrase.result.value.items[0]?.snippet).toContain('fixture 历史消息')

    timing().appendUser(
      'fx-alpha',
      `${'leading context '.repeat(20)}late café token${' trailing context'.repeat(20)}`,
    )
    const late = await api.sessions.search(req({ query: 'LATE CAFE TOKEN' }), signal)
    if (!late.result.ok) throw new Error('late search failed')
    const lateSnippet = late.result.value.items[0]?.snippet ?? ''
    expect(lateSnippet).toContain('late café token')
    expect(lateSnippet.startsWith('…')).toBe(true)
    expect(lateSnippet.endsWith('…')).toBe(true)
    expect(Array.from(lateSnippet).length).toBeLessThanOrEqual(120)

    timing().appendUser('fx-alpha', 'Greek final sigma: ος')
    const finalSigma = await api.sessions.search(req({ query: 'ΟΣ' }), signal)
    if (!finalSigma.result.ok) throw new Error('final sigma search failed')
    expect(finalSigma.result.value.items[0]?.snippet).toContain('ος')

    const substring = await api.sessions.search(req({ query: 'ixtur' }), signal)
    expect(substring.result).toEqual({
      ok: true,
      value: { items: [], hasMore: false },
    })
    const punctuationOnly = await api.sessions.search(req({ query: '*' }), signal)
    expect(punctuationOnly.result).toEqual({
      ok: true,
      value: { items: [], hasMore: false },
    })
    const reasoningOnly = await api.sessions.search(req({ query: '思考过程' }), signal)
    expect(reasoningOnly.result).toEqual({
      ok: true,
      value: { items: [], hasMore: false },
    })

    const aborted = new AbortController()
    aborted.abort()
    await expect(api.sessions.search(req({ query: 'fixture' }), aborted.signal))
      .resolves.toMatchObject({ result: { ok: false, error: { code: 'gateway/cancelled' } } })
  })

  it('pages history backwards on message-boundary cuts with seq-contiguous stitching', async () => {
    const api = createFixtureApi()
    const tail = await api.sessions.history(req({ sessionId: sid('fx-alpha'), maxMessages: 10 }))
    if (!tail.result.ok) throw new Error('history failed')
    const tailPage = tail.result.value
    expect(tailPage.hasMore).toBe(true)
    const tailEvents = historyEvents(tailPage.records)
    expect(tailEvents[0]?.type).toBe('turn/start') // cut lands on a turn boundary
    const boundary = tailEvents[0]?.seq ?? 0
    expect(boundary).toBeGreaterThan(0)
    const older = await api.sessions.history(req({ sessionId: sid('fx-alpha'), beforeSeq: boundary, maxMessages: 10 }))
    if (!older.result.ok) throw new Error('older failed')
    const olderTail = historyEvents(older.result.value.records).at(-1)
    expect((olderTail?.seq ?? -1) + 1).toBe(boundary) // pages stitch with no hole/overlap
    // Out-of-range beforeSeq clamps instead of exploding.
    const clamped = await api.sessions.history(req({ sessionId: sid('fx-alpha'), beforeSeq: -5, maxMessages: 10 }))
    if (!clamped.result.ok) throw new Error('clamped failed')
    expect(clamped.result.value.records).toEqual([])
    // Unknown session: empty page, not an error (history of a bare id).
    const empty = await api.sessions.history(req({ sessionId: sid('no-such'), maxMessages: 10 }))
    if (!empty.result.ok) throw new Error('empty failed')
    expect(empty.result.value).toEqual({ records: [], hasMore: false })
  })

  it('serves raw history entries with replayable tool-result metadata', async () => {
    const api = createFixtureApi()
    const response = await api.sessions.history(req({ sessionId: sid('fx-alpha'), maxMessages: 200 }))
    if (!response.result.ok) throw new Error('history failed')

    const records = response.result.value.records
    const results = historyEvents(records)
      .filter(event => event.type === 'tool/result')

    expect(results.find(event => event.data.turn === 64)).toMatchObject({
      data: {
        meta: {
          diffs: [
            { path: 'src/config.ts', oldText: 'const timeout = 30', newText: 'const timeout = 60' },
            { path: 'src/config.ts', oldText: 'retries: 1', newText: 'retries: 3' },
          ],
        },
      },
    })
    expect(results.find(event => event.data.turn === 67)).toMatchObject({
      data: { meta: { shape: 'matches', truncated: true, total: 42 } },
    })
    expect(results.find(event => event.data.turn === 69)).toMatchObject({
      data: { meta: { path: 'packages/client/ui-primitives/src/ReadBlock.tsx', offset: 41, totalLines: 180 } },
    })
    const webSearch = results.find(event => event.data.turn === 70)
    expect(webSearch).toHaveProperty('data.meta.truncated', true)
    expect(webSearch).toHaveProperty('data.meta.sources', expect.arrayContaining([
      expect.objectContaining({ url: 'https://github.com/deepseek-ai/deepseek-harness' }),
    ]))
    expect(results.find(event => event.data.turn === 71)).toMatchObject({
      data: { meta: { url: 'https://www.deepseek.com/blog/harness-architecture', statusCode: 200 } },
    })
    const terminal = results.find(event => event.data.turn === 66)
    expect(terminal).toHaveProperty('data.message.content.0.content.0.type', 'text')
    expect(terminal).toHaveProperty(
      'data.message.content.0.content.0.text',
      expect.stringContaining('\n[exit code: 1]'),
    )
  })

  it('serves grouped models and keeps a selection for later history and fixture requests', async () => {
    const api = createFixtureApi()
    const sessionId = sid('fx-alpha')
    const catalog = await api.sessionRemote.modelCatalog()
    if (!catalog.ok) throw new Error('models failed')
    expect(catalog.value.groups.map(group => group.name)).toEqual(['DeepSeek', 'OpenAI'])
    expect(catalog.value.groups[0]?.models.map(model => model.id))
      .toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])

    const selected = await api.sessions.selectModel(req({
      sessionId,
      provider: 'openai',
      model: 'gpt-5',
    }))
    if (!selected.result.ok) throw new Error('selection failed')
    expect(selected.result.value.selected).toEqual({ provider: 'openai', model: 'gpt-5' })
    const history = await api.sessions.history(req({ sessionId }))
    if (!history.result.ok) throw new Error('history failed')

    const prompt = await api.sessions.prompt(req({
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'report model' }],
    }))
    expect(prompt.result.ok).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 600))
    const after = await api.sessions.history(req({ sessionId }))
    if (!after.result.ok) throw new Error('history failed')
    expect(JSON.stringify(after.result.value.records)).toContain('openai/gpt-5')
  })

  it('serves configured DeepSeek readiness and keeps credential values write-only', async () => {
    const api = createFixtureApi()
    const settings = await api.settingsRemote.describe()
    if (!settings.ok) throw new Error('settings describe failed')
    expect((settings.value as { namespaces: unknown[] }).namespaces).toMatchObject([{
      ns: 'llm-deepseek',
      value: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
      secrets: [{ path: ['apiKey'], set: false }],
    }])
    for (const result of [
      await api.settingsRemote.update('llm-deepseek', {}, undefined),
      await api.settingsRemote.replace('llm-deepseek', {}, undefined),
    ]) {
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'settings/rejected', message: 'fixture: the minimal readiness settings descriptor is read-only' },
      })
    }

    const describe = async (refs: readonly string[]): Promise<Record<string, unknown>> => {
      const result = await api.credentialRemote.describe(refs)
      if (!result.ok) throw new Error('credential describe failed')
      return result.value as Record<string, unknown>
    }
    expect(await describe(['DEEPSEEK_API_KEY', 'TEST_API_KEY'])).toEqual({
      DEEPSEEK_API_KEY: { configured: true, source: 'file', writable: true },
      TEST_API_KEY: { configured: false, writable: true },
    })
    await api.credentialRemote.set('TEST_API_KEY', 'write-only-fixture-secret')
    expect((await describe(['TEST_API_KEY'])).TEST_API_KEY).toEqual({
      configured: true,
      source: 'file',
      writable: true,
    })
    await api.credentialRemote.unset('TEST_API_KEY')
    expect((await describe(['TEST_API_KEY'])).TEST_API_KEY).toEqual({ configured: false, writable: true })
  })

  it('emits the todo/write snapshot at the real tool boundary: between tool/call and tool/result, timestamps monotonic', async () => {
    const api = createFixtureApi()
    const tail = await api.sessions.history(req({ sessionId: sid('fx-alpha'), maxMessages: 10 }))
    if (!tail.result.ok) throw new Error('history failed')
    const events = historyEvents(tail.result.value.records)
    const todoAt = events.findIndex(e => e.type === 'todo/write')
    expect(todoAt).toBeGreaterThan(0)
    // Production ordering (the tool appends mid-execution): call → snapshot → result.
    expect(events[todoAt - 1]?.type).toBe('tool/call')
    expect(events[todoAt + 1]?.type).toBe('tool/result')
    const times = events.slice(todoAt - 1, todoAt + 2).map(e => e.time)
    expect(times[0]).toBeLessThanOrEqual(times[1] ?? 0)
    expect(times[1]).toBeLessThanOrEqual(times[2] ?? 0)
    // The sample is a parallel plan: this fixture chooses the parallel policy,
    // so the surfaces fed from here face more than one active item.
    const snapshot = events[todoAt] as { data: { todos: { status: string }[] } }
    expect(snapshot.data.todos.filter(t => t.status === 'in_progress')).toHaveLength(2)
  })

  it('create adds a session and announces it through the Host Remote event stream', async () => {
    const api = createFixtureApi()
    const abort = new AbortController()
    const seen: FixtureRemoteEventNotificationFrame[] = []
    const consuming = (async () => {
      for await (const frame of api.remoteEvents(abort.signal)) {
        if (frame.type !== 'emit' || frame.event !== 'api-session/added') continue
        seen.push(frame)
        abort.abort()
        break
      }
    })()
    await new Promise(resolve => setTimeout(resolve, 10)) // let the stream register
    const created = await api.sessions.create(req({}))
    if (!created.result.ok) throw new Error('create failed')
    await consuming
    if (!created.result.ok) throw new Error('create failed')
    const createdId = created.result.value.sessionId
    expect(seen).toHaveLength(1)
    const added = seen[0]
    expect(added).toMatchObject({
      event: 'api-session/added',
      args: [{ sessionId: createdId, blank: true, cwd: '/tmp/fixture' }],
    })
    const list = await api.sessions.list(req({}))
    if (!list.result.ok) throw new Error('list failed')
    expect(list.result.value.items.some(s => s.sessionId === createdId)).toBe(true)
  })

  it('prompt replays a full streamed turn and cancel mid-replay freezes with (已中断)', async () => {
    const api = createFixtureApi()
    const created = await api.sessions.create(req({}))
    if (!created.result.ok) throw new Error('create failed')
    const id = created.result.value.sessionId
    const followAbort = new AbortController()
    const controlAbort = new AbortController()
    const controlFrames: FixtureControlFrame[] = []
    const followPromise = collectValues(
      api.sessionRemote.follow(id, followAbort.signal),
      followAbort,
      frames => frames.some(frame => frame.type === 'event' && frame.event.type === 'turn/end'),
    )
    const controlPromise = (async () => {
      for await (const frame of api.sessionRemote.control(controlAbort.signal)) controlFrames.push(frame)
    })()
    await new Promise(resolve => setTimeout(resolve, 10))
    // Unknown session → session/not-found with the id echoed in details.
    const missing = await api.sessions.prompt(req({ sessionId: sid('ghost'), mode: 'queue' as const, content: [{ type: 'text' as const, text: 'x' }] }))
    expect(missing.result).toMatchObject({ ok: false, error: { code: 'session/not-found', details: { sessionId: 'ghost' } } })
    // Real prompt: replay starts (running flips true), cancel freezes it.
    const accepted = await api.sessions.prompt(req({ sessionId: id, mode: 'queue' as const, content: [{ type: 'text' as const, text: 'render markdown' }] }))
    expect(accepted.result).toMatchObject({ ok: true, value: { accepted: true } })
    await new Promise(resolve => setTimeout(resolve, 120)) // a couple of typewriter ticks
    await api.sessions.cancel(req({ sessionId: id }))
    const frames = await followPromise
    const types = frames.flatMap(frame => frame.type === 'event' ? [frame.event.type] : [])
    const assistantFrames = frames.flatMap(frame => frame.type === 'assistant-stream' ? [frame.frame] : [])
    expect(types).toContain('turn/start')
    expect(types).toContain('user/message')
    expect(types).toContain('assistant/message')
    expect(assistantFrames.some(frame => frame.type === 'chunk')).toBe(true)
    const committed = assistantFrames.find(frame => frame.type === 'end'
      && frame.outcome.kind === 'committed'
      && frame.outcome.eventType === 'assistant/message')
    expect(committed).toMatchObject({
      type: 'end',
      index: assistantFrames.filter(frame => frame.type === 'chunk'
        && frame.attemptId === committed?.attemptId).length,
    })
    expect(types.at(-1)).toBe('turn/end')
    // Capacity is durable log state, not a transient frame: the prompt path
    // records request/context and the projection carries it to the client.
    expect(types).toContain('request/context')
    await vi.waitFor(() => {
      expect(controlFrames.some(frame =>
        frame.type === 'projection'
        && frame.key === 'contextBreakdown'
        && (frame.value as { messageTokens?: number }).messageTokens! > 0)).toBe(true)
    })
    expect(controlFrames.some(frame =>
      frame.type === 'projection'
      && frame.key === 'tokenUsage'
      && (frame.value as { outputTokens?: number }).outputTokens === 8)).toBe(true)
    expect(controlFrames.some(frame =>
      frame.type === 'projection'
      && frame.key === 'contextPressure'
      && (frame.value as { contextWindow?: number }).contextWindow === 128_000)).toBe(true)
    const finalize = frames.find(frame => frame.type === 'event' && frame.event.type === 'assistant/message')
    if (finalize?.type !== 'event') throw new Error('assistant final event missing')
    if (finalize.event.type !== 'assistant/message') throw new Error('assistant final event has wrong type')
    expect(finalize.event.data.interrupted).toBe(true)
    expect(finalize.event.data.stream.length).toBeGreaterThan(0)
    controlAbort.abort()
    await controlPromise
    // Idle cancel: no replay in flight, must not explode; running flips false.
    const idleCancel = await api.sessions.cancel(req({ sessionId: id }))
    expect(idleCancel.result).toMatchObject({ ok: true })
  })

  it('steer during a replay lands a user/message inside the current turn and the replay continues', async () => {
    const api = createFixtureApi()
    const created = await api.sessions.create(req({}))
    if (!created.result.ok) throw new Error('create failed')
    const id = created.result.value.sessionId
    const abort = new AbortController()
    const framesPromise = collectValues(api.sessionRemote.follow(id, abort.signal), abort,
      frames => frames.some(frame => frame.type === 'event' && frame.event.type === 'turn/end'))
    await new Promise(resolve => setTimeout(resolve, 10))
    await api.sessions.prompt(req({ sessionId: id, mode: 'queue' as const, content: [{ type: 'text' as const, text: '短' }] }))
    await api.sessions.prompt(req({ sessionId: id, mode: 'steer' as const, content: [{ type: 'text' as const, text: '插话' }] }))
    const frames = await framesPromise
    const types = frames.flatMap(frame => frame.type === 'event' ? [frame.event.type] : [])
    expect(JSON.stringify(frames)).toContain('插话')
    expect(types.at(-1)).toBe('turn/end') // steer did not restart the turn
  })

  it('control replays projections while resident Remote Events retain ids across reconnects', async () => {
    const api = createFixtureApi()
    const first = await readControlBaseline(api.sessionRemote)
    const second = await readControlBaseline(api.sessionRemote)
    expect(first.value.approvals).toEqual([])
    expect(first.value.questions).toEqual([])
    const alpha = first.value.projections['fx-alpha']
    expect(alpha?.asOfSeq).toBeGreaterThan(0)
    expect(alpha?.values).toMatchObject({
      title: 'Fixture 历史会话',
      plan: { active: false, pending: false },
      goal: null,
      imageLimits: { maxImagesPerMessage: 20, maxImageBytes: 5 * 1024 * 1024 },
    })
    expect((alpha?.values['contextBreakdown'] as { messageTokens: number }).messageTokens).toBeGreaterThan(0)
    expect((alpha?.values['sessionStats'] as { steps: number }).steps).toBeGreaterThan(0)
    expect(second.value.projections['fx-alpha']).toEqual(alpha)

    const firstEvents = await readResidentRemoteEvents(api, 2)
    const secondEvents = await readResidentRemoteEvents(api, 2)
    const firstApproval = firstEvents.find(frame => frame.event === 'approval/request')
    const firstQuestion = firstEvents.find(frame => frame.event === 'user-questions/request')
    const secondApproval = secondEvents.find(frame => frame.event === 'approval/request')
    const secondQuestion = secondEvents.find(frame => frame.event === 'user-questions/request')
    expect(firstApproval).toMatchObject({
      type: 'waterfall',
      request: { toolName: 'dangerous_tool' },
      agentId: 'fx-alpha',
    })
    expect(firstQuestion).toMatchObject({
      type: 'waterfall',
      agentId: 'fx-alpha',
    })
    expect(Array.isArray(firstQuestion?.request.questions)).toBe(true)
    expect(secondApproval?.eventId).toBe(firstApproval?.eventId)
    expect(secondQuestion?.eventId).toBe(firstQuestion?.eventId)
    expect(await readOpeningCursor(api.sessionRemote, sid('fx-alpha'))).toBeGreaterThan(0)
  })

  it('steer with no replay in flight falls through to a fresh queued turn; non-text blocks stringify empty', async () => {
    const api = createFixtureApi()
    const created = await api.sessions.create(req({}))
    if (!created.result.ok) throw new Error('create failed')
    const abort = new AbortController()
    const framesPromise = collectValues(
      api.sessionRemote.follow(created.result.value.sessionId, abort.signal),
      abort,
      frames => frames.some(frame => frame.type === 'event' && frame.event.type === 'turn/end'),
    )
    await new Promise(resolve => setTimeout(resolve, 10))
    // steer while idle + a non-text content block (covers the '' arm of the text join).
    await api.sessions.prompt(req({
      sessionId: created.result.value.sessionId, mode: 'steer' as const,
      content: [{ type: 'text' as const, text: '短' }, { type: 'image', data: 'x' } as never],
    }))
    const frames = await framesPromise
    const types = frames.flatMap(frame => frame.type === 'event' ? [frame.event.type] : [])
    expect(types[0]).toBe('turn/start') // idle steer degraded to a queued turn, not an in-turn insert
  })

  it('gamma interval flip emits a Remote status event and its empty follow source opens at -1', async () => {
    vi.useFakeTimers()
    try {
      const api = createFixtureApi()
      const abort = new AbortController()
      const hostSeen: FixtureRemoteEventFrame[] = []
      const consuming = (async () => {
        for await (const frame of api.remoteEvents(abort.signal)) hostSeen.push(frame)
      })()
      await vi.advanceTimersByTimeAsync(5001) // interval fires: fx-gamma flips running=true (no log exists)
      expect(hostSeen).toContainEqual({
        type: 'emit',
        event: 'api-session/status',
        args: [sid('fx-gamma'), true],
      })
      expect(await readOpeningCursor(api.sessionRemote, sid('fx-gamma'))).toBe(-1)
      abort.abort()
      await vi.advanceTimersByTimeAsync(10)
      await consuming
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers a resident question through its Remote Event id and stops replaying it', async () => {
    const api = createFixtureApi()
    const abort = new AbortController()
    const stream = api.remoteEvents(abort.signal)
    const iterator = stream[Symbol.asyncIterator]()
    const question = await nextRemoteEvent(
      iterator,
      frame => isRemoteEventRequest(frame) && frame.event === 'user-questions/request',
    )
    if (!isRemoteEventRequest(question)) throw new Error('fixture question Remote Event missing')
    const clientId = await stream.clientId
    await expect(api.answerRemoteEvent({
      clientId,
      eventId: 'unrelated',
      outcome: { kind: 'result', value: {} },
    })).resolves.toEqual({ ok: true, value: undefined })
    await expect(api.answerRemoteEvent({
      clientId,
      eventId: question.eventId,
      outcome: { kind: 'result', value: { answers: {} } },
    })).resolves.toEqual({ ok: true, value: undefined })
    const cancelled = await nextRemoteEvent(
      iterator,
      frame => isRemoteEventCancellation(frame) && frame.eventId === question.eventId,
    )
    expect(cancelled).toEqual({ type: 'cancel', eventId: question.eventId })
    abort.abort()
    await iterator.return?.()

    await expect(api.answerRemoteEvent({
      clientId,
      eventId: question.eventId,
      outcome: { kind: 'result', value: { answers: {} } },
    })).resolves.toMatchObject({ ok: false, error: { code: 'gateway/invocation-unavailable' } })
    const remaining = await readResidentRemoteEvents(api, 1)
    expect(remaining.map(frame => frame.event)).toEqual(['approval/request'])

    const cancelledApi = createFixtureApi()
    const cancelAbort = new AbortController()
    const cancelStream = cancelledApi.remoteEvents(cancelAbort.signal)
    const cancelIterator = cancelStream[Symbol.asyncIterator]()
    const cancelQuestion = await nextRemoteEvent(
      cancelIterator,
      frame => isRemoteEventRequest(frame) && frame.event === 'user-questions/request',
    )
    if (!isRemoteEventRequest(cancelQuestion)) throw new Error('fixture cancellation question missing')
    await expect(cancelledApi.answerRemoteEvent({
      clientId: await cancelStream.clientId,
      eventId: cancelQuestion.eventId,
      outcome: {
        kind: 'rejected',
        error: { name: 'UserQuestionError', message: 'skip', code: 'ASK_CANCELLED' },
      },
    })).resolves.toEqual({ ok: true, value: undefined })
    cancelAbort.abort()
    await cancelIterator.return?.()
    const afterCancellation = await readResidentRemoteEvents(cancelledApi, 1)
    expect(afterCancellation.map(frame => frame.event)).toEqual(['approval/request'])
  })

  it('answers a resident approval and broadcasts cancellation to its active delivery', async () => {
    const api = createFixtureApi()
    const abort = new AbortController()
    const stream = api.remoteEvents(abort.signal)
    const iterator = stream[Symbol.asyncIterator]()
    const approval = await nextRemoteEvent(
      iterator,
      frame => isRemoteEventRequest(frame) && frame.event === 'approval/request',
    )
    if (!isRemoteEventRequest(approval)) throw new Error('fixture approval Remote Event missing')

    await expect(api.answerRemoteEvent({
      clientId: await stream.clientId,
      eventId: approval.eventId,
      outcome: { kind: 'result', value: 'allowed-once' },
    })).resolves.toEqual({ ok: true, value: undefined })
    const cancelled = await nextRemoteEvent(
      iterator,
      frame => isRemoteEventCancellation(frame) && frame.eventId === approval.eventId,
    )
    expect(cancelled).toEqual({ type: 'cancel', eventId: approval.eventId })
    abort.abort()
    await iterator.return?.()

    await expect(api.answerRemoteEvent({
      clientId: await stream.clientId,
      eventId: approval.eventId,
      outcome: { kind: 'next' },
    })).resolves.toMatchObject({ ok: false, error: { code: 'gateway/invocation-unavailable' } })
    const remaining = await readResidentRemoteEvents(api, 1)
    expect(remaining.map(frame => frame.event)).toEqual(['user-questions/request'])
  })

  it('createDirectory under the root mints /name whose listing and crumbs share the identity', async () => {
    const api = createFixtureApi()
    const created = await api.directoryPickerRemote.createDirectory('/', 'srv')
    if (!created.ok) throw new Error('create failed')
    expect(created.value).toBe('/srv')
    const listed = await api.directoryPickerRemote.list('/srv')
    if (!listed.ok) throw new Error('list failed')
    expect(listed.value.crumbs).toEqual([
      { name: '/', path: '/', hidden: false },
      { name: 'srv', path: '/srv', hidden: false },
    ])
    const root = await api.directoryPickerRemote.list('/')
    if (!root.ok) throw new Error('root list failed')
    expect(root.value.entries).toContainEqual({ name: 'srv', path: '/srv', hidden: false })
  })

  it('workspace/follow serves the resident baseline and create reuses on path collision', async () => {
    const api = createFixtureApi()
    const baseline = await readWorkspaceBaseline(api.workspaceRemote)
    expect(baseline.items).toEqual([
      expect.objectContaining({
        workspaceId: 'fx-ws-fixture', path: '/tmp/fixture', title: 'fixture',
        sessionIds: ['fx-alpha', 'fx-beta', 'fx-gamma'],
      }),
      expect.objectContaining({
        workspaceId: 'fx-ws-home', path: '/home/fixture/Documents/project', title: 'project',
        sessionIds: [],
      }),
    ])
    // path collision → the existing entity comes back, created:false, no frame.
    const reused = await api.workspace.create(req({ path: '/tmp/fixture' }))
    if (!reused.result.ok) throw new Error('reuse failed')
    expect(reused.result.value).toMatchObject({ created: false, workspace: { workspaceId: 'fx-ws-fixture' } })
  })

  it('workspace.create on a fresh path mints a new entity and pushes an upsert', async () => {
    const api = createFixtureApi()
    const abort = new AbortController()
    const consuming = collectValues(
      api.workspaceRemote.follow(abort.signal),
      abort,
      frames => frames.some(frame => frame.type === 'upsert'
        && frame.workspace.path === '/tmp/fixture-workspaces/nova'),
    )
    await new Promise(resolve => setTimeout(resolve, 10))
    const created = await api.workspace.create(req({ path: '/tmp/fixture-workspaces/nova' }))
    if (!created.result.ok) throw new Error('create failed')
    expect(created.result.value.created).toBe(true)
    expect(created.result.value.workspace).toMatchObject({
      path: '/tmp/fixture-workspaces/nova', title: 'nova', sessionIds: [],
    })
    const frames = await consuming
    expect(frames.at(-1)).toEqual({ type: 'upsert', workspace: created.result.value.workspace })
    // A basename-less path serves as its own title.
    const rootPath = await api.workspace.create(req({ path: '/' }))
    if (!rootPath.result.ok) throw new Error('rootPath failed')
    expect(rootPath.result.value.workspace.title).toBe('/')
  })

  it('workspace.rename covers not-found, conflict, no-op, and the changed frame', async () => {
    const api = createFixtureApi()
    const abort = new AbortController()
    const consuming = collectValues(
      api.workspaceRemote.follow(abort.signal),
      abort,
      frames => frames.filter(frame => frame.type === 'upsert').length >= 2,
    )
    await new Promise(resolve => setTimeout(resolve, 10))
    const wsid = 'fx-ws-fixture' as WorkspaceId
    const missing = await api.workspace.rename(req({ workspaceId: 'fx-ws-void' as WorkspaceId, title: 'x' }))
    expect(missing.result).toMatchObject({ ok: false, error: { code: 'workspace/not-found', details: { workspaceId: 'fx-ws-void' } } })

    await api.workspace.create(req({ path: '/tmp/fixture-workspaces/occupied' }))
    const conflict = await api.workspace.rename(req({ workspaceId: wsid, title: ' occupied ' }))
    expect(conflict.result).toMatchObject({ ok: false, error: { code: 'workspace/name-conflict', details: { name: 'occupied' } } })

    const noop = await api.workspace.rename(req({ workspaceId: wsid, title: ' fixture ' }))
    if (!noop.result.ok) throw new Error('no-op rename failed')
    expect(noop.result.value.workspace.title).toBe('fixture')

    const renamed = await api.workspace.rename(req({ workspaceId: wsid, title: 'renamed' }))
    if (!renamed.result.ok) throw new Error('rename failed')
    expect(renamed.result.value.workspace.title).toBe('renamed')
    const frames = await consuming
    // Only the create and the effective rename emit frames; the no-op stays silent.
    const upserts = frames.filter(frame => frame.type === 'upsert')
    expect(upserts).toHaveLength(2)
    expect(upserts[1]).toMatchObject({ workspace: { workspaceId: wsid, title: 'renamed' } })
  })

  it('session.rename covers not-found, blank title, and the accepted append + title frame', async () => {
    const api = createFixtureApi()
    const followAbort = new AbortController()
    const controlAbort = new AbortController()
    const followPromise = collectValues(
      api.sessionRemote.follow(sid('fx-alpha'), followAbort.signal),
      followAbort,
      frames => frames.some(frame => frame.type === 'event'
        && (frame.event as { type: string }).type === 'session/title'),
    )
    const controlPromise = collectValues(
      api.sessionRemote.control(controlAbort.signal),
      controlAbort,
      frames => frames.some(frame => frame.type === 'projection' && frame.key === 'title' && frame.value === '重命名'),
    )
    await new Promise(resolve => setTimeout(resolve, 10))

    const missing = await api.sessions.rename(req({ sessionId: sid('fx-void'), title: 'x' }))
    expect(missing.result).toMatchObject({ ok: false, error: { code: 'session/not-found', details: { sessionId: 'fx-void' } } })

    const blank = await api.sessions.rename(req({ sessionId: sid('fx-alpha'), title: '   ' }))
    expect(blank.result).toMatchObject({ ok: false, error: { code: 'session/title-invalid', details: { sessionId: 'fx-alpha' } } })

    const renamed = await api.sessions.rename(req({ sessionId: sid('fx-alpha'), title: '  重命名  ' }))
    if (!renamed.result.ok) throw new Error('rename failed')
    expect(renamed.result.value.title).toBe('重命名')
    const acceptedSeq = renamed.result.value.seq
    // The response seq addresses the appended title event (the client plane
    // has no session/title in its event union — titles ride the projection —
    // so the event is located by seq and its payload checked structurally).
    const history = await api.sessions.history(req({ sessionId: sid('fx-alpha'), maxMessages: 100 }))
    if (!history.result.ok) throw new Error('history failed')
    const appended = historyEvents(history.result.value.records).find(event => event.seq === acceptedSeq)
    expect(appended).toMatchObject({
      type: 'session/title',
      data: { title: '重命名', messageSeqs: [], source: { kind: 'user' } },
    })
    const followed = await followPromise
    expect(followed.some(frame => frame.type === 'event'
      && frame.event.seq === acceptedSeq
      && (frame.event as { readonly type: string }).type === 'session/title')).toBe(true)
    const frames = await controlPromise
    const titleFrames = frames.filter(frame =>
      frame.type === 'projection'
      && frame.key === 'title'
      && frame.sessionId === sid('fx-alpha')
      && frame.value === '重命名')
    expect(titleFrames).toHaveLength(1)
    expect(titleFrames[0]).toMatchObject({ seq: acceptedSeq })
  })

  it('workspace.insertSessionBefore moves, appends, no-ops, and rejects invalid ids', async () => {
    const api = createFixtureApi()
    const wsid = 'fx-ws-fixture' as WorkspaceId
    const missing = await api.workspace.insertSessionBefore(req({ workspaceId: 'fx-ws-void' as WorkspaceId, sessionId: sid('fx-alpha') }))
    expect(missing.result).toMatchObject({ ok: false, error: { code: 'workspace/not-found' } })
    const ghost = await api.workspace.insertSessionBefore(req({ workspaceId: wsid, sessionId: sid('fx-ghost') }))
    expect(ghost.result).toMatchObject({ ok: false, error: { code: 'workspace/move-invalid', details: { sessionId: 'fx-ghost' } } })
    const badAnchor = await api.workspace.insertSessionBefore(req({ workspaceId: wsid, sessionId: sid('fx-alpha'), beforeSessionId: sid('fx-ghost') }))
    expect(badAnchor.result).toMatchObject({ ok: false, error: { code: 'workspace/move-invalid', details: { beforeSessionId: 'fx-ghost' } } })

    const moved = await api.workspace.insertSessionBefore(req({ workspaceId: wsid, sessionId: sid('fx-gamma'), beforeSessionId: sid('fx-beta') }))
    if (!moved.result.ok) throw new Error('move failed')
    expect(moved.result.value.workspace.sessionIds).toEqual(['fx-alpha', 'fx-gamma', 'fx-beta'])
    const appended = await api.workspace.insertSessionBefore(req({ workspaceId: wsid, sessionId: sid('fx-alpha') }))
    if (!appended.result.ok) throw new Error('append failed')
    expect(appended.result.value.workspace.sessionIds).toEqual(['fx-gamma', 'fx-beta', 'fx-alpha'])
    const before = appended.result.value.workspace.updatedAt
    const noop = await api.workspace.insertSessionBefore(req({ workspaceId: wsid, sessionId: sid('fx-alpha') }))
    if (!noop.result.ok) throw new Error('no-op move failed')
    expect(noop.result.value.workspace.sessionIds).toEqual(['fx-gamma', 'fx-beta', 'fx-alpha'])
    expect(noop.result.value.workspace.updatedAt).toBe(before)
  })

  it('workspace.delete removes only the Workspace row and emits the removal frame', async () => {
    const api = createFixtureApi()
    const abort = new AbortController()
    const consuming = collectValues(
      api.workspaceRemote.follow(abort.signal),
      abort,
      frames => frames.some(frame => frame.type === 'remove'),
    )
    await new Promise(resolve => setTimeout(resolve, 10))
    const missing = await api.workspace.delete(req({ workspaceId: 'fx-ws-void' as WorkspaceId }))
    expect(missing.result).toMatchObject({ ok: false, error: { code: 'workspace/not-found' } })
    const deleted = await api.workspace.delete(req({ workspaceId: 'fx-ws-fixture' as WorkspaceId }))
    expect(deleted.result).toEqual({ ok: true, value: { deleted: true } })
    const frames = await consuming
    expect(frames.at(-1)).toEqual({ type: 'remove', workspaceId: 'fx-ws-fixture' })
    const baseline = await readWorkspaceBaseline(api.workspaceRemote)
    expect(baseline.items.some(workspace => workspace.workspaceId === 'fx-ws-fixture')).toBe(false)
    const sessions = await api.sessions.list(req({}))
    if (!sessions.result.ok) throw new Error('session list failed')
    expect(sessions.result.value.items.map(session => session.sessionId)).toContain('fx-alpha')
  })

  it('session.create({workspaceId}) lands on the account and unknown ids error', async () => {
    const api = createFixtureApi()
    const hostAbort = new AbortController()
    const workspaceAbort = new AbortController()
    const seen: FixtureRemoteEventNotificationFrame[] = []
    const consuming = (async () => {
      for await (const frame of api.remoteEvents(hostAbort.signal)) {
        if (frame.type !== 'emit' || frame.event !== 'api-session/added') continue
        seen.push(frame)
        hostAbort.abort()
        break
      }
    })()
    const workspaceFrames = collectValues(
      api.workspaceRemote.follow(workspaceAbort.signal),
      workspaceAbort,
      frames => frames.some(frame => frame.type === 'upsert'
        && frame.workspace.sessionIds.length === 4),
    )
    await new Promise(resolve => setTimeout(resolve, 10))
    const missing = await api.sessions.create(req({ workspaceId: 'fx-ws-void' as WorkspaceId }))
    expect(missing.result).toMatchObject({ ok: false, error: { code: 'workspace/not-found', details: { workspaceId: 'fx-ws-void' } } })
    const created = await api.sessions.create(req({ workspaceId: 'fx-ws-fixture' as WorkspaceId }))
    if (!created.result.ok) throw new Error('create failed')
    const id = created.result.value.sessionId
    await consuming
    const added = seen[0]
    expect(added).toMatchObject({
      event: 'api-session/added',
      args: [{ sessionId: id, blank: true, cwd: '/tmp/fixture' }],
    })
    expect((await workspaceFrames).at(-1)).toMatchObject({
      type: 'upsert',
      workspace: {
        workspaceId: 'fx-ws-fixture',
        sessionIds: [id, 'fx-alpha', 'fx-beta', 'fx-gamma'],
      },
    })
  })

  it('supports an empty baseline, preallocated ids, independent streams, and idempotent retry', async () => {
    const api = createFixtureApi({ empty: true, createFrameOrder: 'workspace-first' })
    const initialSessions = await api.sessions.list(req({}))
    expect(initialSessions.result).toMatchObject({ ok: true, value: { items: [] } })
    expect(await readWorkspaceBaseline(api.workspaceRemote)).toEqual({
      items: [],
      archivedSessionIds: [],
    })

    const made = await api.workspace.create(req({ path: '/tmp/fixture-workspaces/nova' }))
    if (!made.result.ok) throw new Error('workspace create failed')
    const hostAbort = new AbortController()
    const workspaceAbort = new AbortController()
    const hostFrames = collectValues(
      api.remoteEvents(hostAbort.signal),
      hostAbort,
      frames => frames.length === 1,
    )
    const workspaceFrames = collectValues(
      api.workspaceRemote.follow(workspaceAbort.signal),
      workspaceAbort,
      frames => frames.some(frame => frame.type === 'upsert'
        && frame.workspace.sessionIds.includes(sid('fx-preallocated'))),
    )
    await new Promise(resolve => setTimeout(resolve, 10))
    const preallocated = sid('fx-preallocated')
    const created = await api.sessions.create(req({
      workspaceId: made.result.value.workspace.workspaceId,
      sessionId: preallocated,
    }))
    expect(created.result).toEqual({ ok: true, value: { sessionId: preallocated } })
    expect((await workspaceFrames).at(-1)).toMatchObject({
      type: 'upsert', workspace: { sessionIds: [preallocated] },
    })
    const added = (await hostFrames)[0]
    expect(added).toMatchObject({
      event: 'api-session/added',
      args: [{
        sessionId: preallocated,
        blank: true,
        cwd: made.result.value.workspace.path,
      }],
    })

    const retried = await api.sessions.create(req({
      workspaceId: made.result.value.workspace.workspaceId,
      sessionId: preallocated,
    }))
    expect(retried.result).toEqual({ ok: true, value: { sessionId: preallocated } })
    const listed = await api.sessions.list(req({}))
    if (!listed.result.ok) throw new Error('session list failed')
    expect(listed.result.value.items.filter(item => item.sessionId === preallocated)).toHaveLength(1)

    const conflict = await api.sessions.create(req({ sessionId: preallocated, cwd: '/elsewhere' }))
    expect(conflict.result).toMatchObject({
      ok: false,
      error: { code: 'session/conflict', details: { sessionId: preallocated, requestedCwd: '/elsewhere' } },
    })
  })

  it('attaches an existing ungrouped Session to a matching Workspace', async () => {
    const api = createFixtureApi()
    const sessionId = sid('fx-existing-ungrouped')
    await expect(api.sessions.create(req({ sessionId, cwd: '/tmp/fixture' }))).resolves.toMatchObject({
      result: { ok: true, value: { sessionId } },
    })

    await expect(api.sessions.create(req({
      sessionId,
      workspaceId: 'fx-ws-fixture' as WorkspaceId,
    }))).resolves.toMatchObject({ result: { ok: true, value: { sessionId } } })

    const workspaces = await readWorkspaceBaseline(api.workspaceRemote)
    expect(workspaces.items[0]?.sessionIds).toContain(sessionId)
  })

  it('reports a conflict without an existing cwd detail for an unrecorded cwd', async () => {
    const api = createFixtureApi()
    const listed = await api.sessions.list(req({}))
    if (!listed.result.ok) throw new Error('session list failed')
    const existing = listed.result.value.items.find(item => item.sessionId === sid('fx-alpha'))
    if (existing === undefined) throw new Error('fixture Session missing')
    delete existing.cwd

    const conflict = await api.sessions.create(req({ sessionId: existing.sessionId }))
    expect(conflict.result).toEqual({
      ok: false,
      error: {
        code: 'session/conflict',
        message: `session ${existing.sessionId} already uses no cwd`,
        details: { sessionId: existing.sessionId, requestedCwd: '/tmp/fixture' },
      },
    })
  })

  it('publishes an ungrouped Session when Workspace attachment fails', async () => {
    const api = createFixtureApi({ failWorkspaceAttach: true })
    const sessionId = sid('fx-partial')
    const created = await api.sessions.create(req({
      workspaceId: 'fx-ws-fixture' as WorkspaceId,
      sessionId,
    }))
    expect(created.result).toMatchObject({
      ok: false,
      error: { code: 'session/workspace-attach-failed', details: { sessionId, workspaceId: 'fx-ws-fixture' } },
    })
    const listed = await api.sessions.list(req({}))
    const workspaces = await readWorkspaceBaseline(api.workspaceRemote)
    if (!listed.result.ok) throw new Error('list failed')
    expect(listed.result.value.items.filter(item => item.sessionId === sessionId)).toHaveLength(1)
    expect(workspaces.items[0]?.sessionIds).not.toContain(sessionId)

    const retried = await api.sessions.create(req({
      workspaceId: 'fx-ws-fixture' as WorkspaceId,
      sessionId,
    }))
    expect(retried.result).toMatchObject({ ok: false, error: { code: 'session/workspace-attach-failed' } })
    const afterRetry = await api.sessions.list(req({}))
    if (!afterRetry.result.ok) throw new Error('list failed')
    expect(afterRetry.result.value.items.filter(item => item.sessionId === sessionId)).toHaveLength(1)
  })

  it('reconciles a dropped create response and can reject a prompt before acceptance', async () => {
    const sessionId = sid('fx-lost-response')
    const dropped = createFixtureApi({ dropSessionCreateResponse: true })
    await expect(Promise.resolve().then(() => dropped.sessions.create(req({
      workspaceId: 'fx-ws-fixture' as WorkspaceId,
      sessionId,
    })))).rejects.toThrow(/dropped session\.create response/)
    const listed = await dropped.sessions.list(req({}))
    const workspaces = await readWorkspaceBaseline(dropped.workspaceRemote)
    if (!listed.result.ok) throw new Error('list failed')
    expect(listed.result.value.items.some(item => item.sessionId === sessionId)).toBe(true)
    expect(workspaces.items[0]?.sessionIds).toContain(sessionId)
    await expect(dropped.sessions.create(req({
      workspaceId: 'fx-ws-fixture' as WorkspaceId,
      sessionId,
    }))).resolves.toMatchObject({ result: { ok: true, value: { sessionId } } })

    const rejecting = createFixtureApi({ empty: true, rejectPrompt: true })
    const real = await rejecting.sessions.create(req({ sessionId: sid('fx-rejected') }))
    if (!real.result.ok) throw new Error('session create failed')
    const prompt = await rejecting.sessions.prompt(req({
      sessionId: real.result.value.sessionId,
      mode: 'queue' as const,
      content: [{ type: 'text' as const, text: 'keep me' }],
    }))
    expect(prompt.result).toMatchObject({ ok: false, error: { code: 'session/agent-busy' } })
    const imagePrompt = await rejecting.sessions.prompt(req({
      sessionId: real.result.value.sessionId,
      mode: 'queue' as const,
      content: [{ type: 'image' as const, mediaType: 'image/png' as const, data: 'iVBORw0KGgo=' }],
    }))
    expect(imagePrompt.result).toMatchObject({
      ok: false,
      error: { code: 'session/attachment-invalid', details: { reason: 'IMAGE_DIMENSION_TOO_LARGE' } },
    })
  })

  it('timing hooks: history delay + one-shot failure, silent append, and breakStreams end open generators', async () => {
    const api = createFixtureApi()
    const hooks = timing()
    // One-shot transport failure after transit delay.
    hooks.setHistoryDelay(5)
    hooks.failNextHistory()
    await expect(api.sessions.history(req({ sessionId: sid('fx-alpha'), maxMessages: 5 }))).rejects.toThrow(/simulated history transport failure/)
    hooks.setHistoryDelay(0)
    // The failure was one-shot: the next call succeeds.
    const ok = await api.sessions.history(req({ sessionId: sid('fx-alpha'), maxMessages: 5 }))
    expect(ok.result.ok).toBe(true)
    // A durable append without a live frame creates a detectable seq gap.
    const gapAbort = new AbortController()
    const gapIterator = api.sessionRemote.follow(sid('fx-alpha'), gapAbort.signal)[Symbol.asyncIterator]()
    const opening = await gapIterator.next()
    if (opening.done || opening.value.type !== 'snapshot') throw new Error('follow opening snapshot missing')
    hooks.appendSilent('fx-alpha', '静默丢帧')
    hooks.appendUser('fx-alpha', '正常直播')
    await expect(gapIterator.next()).rejects.toThrow(/stream skipped seq/)

    // Reopening replaces the window with a complete snapshot containing both durable events.
    const followAbort = new AbortController()
    const controlAbort = new AbortController()
    const followed: FixtureFollowFrame[] = []
    const controlled: FixtureControlFrame[] = []
    const following = (async () => {
      for await (const frame of api.sessionRemote.follow(sid('fx-alpha'), followAbort.signal)) {
        followed.push(frame)
      }
    })()
    const controlling = (async () => {
      for await (const frame of api.sessionRemote.control(controlAbort.signal)) controlled.push(frame)
    })()
    await new Promise(resolve => setTimeout(resolve, 10))
    await vi.waitFor(() => {
      const snapshot = followed.find(frame => frame.type === 'snapshot')
      const events = snapshot === undefined ? [] : historyEvents(snapshot.records)
      expect(events.some(event => JSON.stringify(event.data).includes('静默丢帧'))).toBe(true)
      expect(events.some(event => JSON.stringify(event.data).includes('正常直播'))).toBe(true)
    })
    hooks.appendTitle('fx-alpha', 'Fixture 修订标题')
    hooks.beginModelRetry('fx-alpha')
    hooks.scheduleModelRetry('fx-alpha')
    hooks.completeModelRetry('fx-alpha')
    hooks.beginModelRetry('fx-alpha')
    hooks.cancelModelRetryDuringBackoff('fx-alpha')
    await vi.waitFor(() => {
      expect(followed.some(frame => frame.type === 'event' && (frame.event as { type: string }).type === 'llm/retry')).toBe(true)
      expect(followed.some(frame => frame.type === 'event' && JSON.stringify(frame.event.data).includes('重试后的完整回复'))).toBe(true)
      expect(followed.some(frame => frame.type === 'event'
        && frame.event.type === 'turn/end'
        && frame.event.data.reason.kind === 'aborted')).toBe(true)
      expect(controlled.some(frame => frame.type === 'projection'
        && frame.key === 'title'
        && frame.value === 'Fixture 修订标题')).toBe(true)
    })
    expect(followed.some(frame => frame.type === 'event' && (frame.event as { type: string }).type === 'session/title')).toBe(true)
    // Paging and resumed follow agree on the recovered durable event.
    const repull = await api.sessions.history(req({ sessionId: sid('fx-alpha'), maxMessages: 5 }))
    if (!repull.result.ok) throw new Error('repull failed')
    expect(JSON.stringify(repull.result.value.records)).toContain('静默丢帧')
    // breakStreams force-ends follow and control without client aborts.
    await new Promise(resolve => setTimeout(resolve, 10))
    hooks.breakStreams()
    await following
    await controlling
    expect(followAbort.signal.aborted).toBe(false)
    expect(controlAbort.signal.aborted).toBe(false)
  })

  it('paces the opt-in reasoning stress hook from an external interval', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const api = createFixtureApi()
    const hooks = timing()
    expect(hooks.reasoningChunkStormState()).toBeNull()
    expect(() => hooks.startReasoningChunkStorm('fx-alpha', 0, 1, 16)).toThrow(/chunk count/)
    expect(() => hooks.startReasoningChunkStorm('fx-alpha', 1, 0, 16)).toThrow(/chunks per interval/)
    expect(() => hooks.startReasoningChunkStorm('fx-alpha', 1, 1, 0)).toThrow(/reasoning interval/)
    const abort = new AbortController()
    try {
      const streamed = collectValues(api.sessionRemote.follow(sid('fx-alpha'), abort.signal), abort, frames => frames.some(frame => (
        frame.type === 'assistant-stream'
        && frame.frame.type === 'chunk'
        && isReasoningDeltaChunk(frame.frame.chunk)
        && frame.frame.chunk.text.includes('REASONING_STRESS_COMPLETE')
      )))
      const marker = hooks.startReasoningChunkStorm('fx-alpha', 3, 2, 16)
      expect(() => hooks.startReasoningChunkStorm('fx-alpha', 1, 1, 16)).toThrow(/already running/)
      expect(hooks.reasoningChunkStormState()).toMatchObject({ emitted: 0, emitting: true, marker })

      await vi.advanceTimersByTimeAsync(0)
      expect(hooks.reasoningChunkStormState()).toMatchObject({ emitted: 2, emitting: true })
      await vi.advanceTimersByTimeAsync(16)
      expect(hooks.reasoningChunkStormState()).toEqual({
        sessionId: 'fx-alpha', chunkCount: 3, chunksPerInterval: 2, intervalMs: 16,
        emitted: 3, marker, emitting: false,
      })

      const frames = await streamed
      const deltas = frames.flatMap(frame => (
        frame.type === 'assistant-stream'
        && frame.frame.type === 'chunk'
        && isReasoningDeltaChunk(frame.frame.chunk)
          ? [frame.frame.chunk.text]
          : []
      ))
      expect(deltas).toEqual(['推理', '推理', `\n${marker}`])
    } finally {
      abort.abort()
      vi.useRealTimers()
    }
  })
})

describe('fixture Connection RPC', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('covers the migrated Remote dispatch table', async () => {
    const rpc = createFixtureConnectionRpc()
    const sessions = createSessionClient(rpc)
    const workspaces = createWorkspaceClient(rpc)
    expect((await sessions.search(
      { query: 'fixture' },
      new AbortController().signal,
    )).result.ok).toBe(true)
    const created = await sessions.create({})
    if (!created.result.ok) throw new Error('create failed')
    const id = created.result.value.sessionId
    expect((await sessions.history({ sessionId: id })).result.ok).toBe(true)
    expect((await sessions.prompt({ sessionId: id, mode: 'queue', content: [{ type: 'text', text: '嗨' }] })).result.ok).toBe(true)
    expect((await sessions.cancel({ sessionId: id })).result.ok).toBe(true)
    expect((await readWorkspaceBaseline(createWorkspaceRemote(rpc))).items).not.toHaveLength(0)
    const workspace = await workspaces.create({ path: '/tmp/fixture-workspaces/via-client' })
    if (!workspace.result.ok) throw new Error('workspace create failed')
    expect(workspace.result.value.workspace.title).toBe('via-client')
    const wsid = workspace.result.value.workspace.workspaceId
    const renamed = await workspaces.rename({ workspaceId: wsid, title: 'via-client-2' })
    if (!renamed.result.ok) throw new Error('workspace rename failed')
    expect(renamed.result.value.workspace.title).toBe('via-client-2')
    const attached = await sessions.create({ workspaceId: wsid })
    if (!attached.result.ok) throw new Error('attached create failed')
    const moved = await workspaces.insertSessionBefore({ workspaceId: wsid, sessionId: attached.result.value.sessionId })
    if (!moved.result.ok) throw new Error('workspace move failed')
    expect(moved.result.value.workspace.sessionIds).toEqual([attached.result.value.sessionId])
  })

  it('folds the goal lifecycle over the Goal Remotes', async () => {
    const rpc = createFixtureConnectionRpc()
    const sessions = createSessionClient(rpc)
    const created = await sessions.create({})
    if (!created.result.ok) throw new Error('create failed')
    const id = created.result.value.sessionId
    const goal = (endpoint: string, args: Record<string, unknown>) =>
      rpc.call('/api', endpoint, { args: { agentId: id, ...args } })

    // create → edit → pause → resume → complete → clear; each mutation advances the CAS
    // revision by one (state rides the projection frames).
    const goalCreated = await goal('goals/create', { request: { objective: 'ship it' } })
    if (!goalCreated.ok) throw new Error('goal create failed')
    const { id: goalId, revision } = (goalCreated.value as { ref: { id: string; revision: number } }).ref
    expect(revision).toBe(1)
    const ref = (at: number) => ({ id: goalId, revision: at })
    expect((await goal('goals/edit', { ref: ref(1), request: { objective: 'ship it v2' } })).ok).toBe(true)
    expect((await goal('goals/pause', { ref: ref(2) })).ok).toBe(true)
    expect((await goal('goals/resume', { ref: ref(3) })).ok).toBe(true)
    // A stale ref loses the CAS check.
    expect((await goal('goals/pause', { ref: ref(1) })).ok).toBe(false)
    expect((await goal('goals/complete', { ref: ref(4) })).ok).toBe(true)
    // complete → complete is an invalid transition.
    expect((await goal('goals/complete', { ref: ref(5) })).ok).toBe(false)
    expect(await goal('goals/clear', { ref: ref(5) })).toEqual({ ok: true, value: ref(6) })

    const goalHistory = await sessions.history({ sessionId: id })
    if (!goalHistory.result.ok) throw new Error('goal history failed')
    const goalEvents = historyEvents(goalHistory.result.value.records).map(event => event as unknown as {
      type: string
      data: {
        operation?: string
        source?: { kind?: string; round?: number }
      }
    })
    const goalChanges = goalEvents.filter(event => event.type === 'goal/change')
    expect(goalChanges.map(event => event.data.operation))
      .toEqual(['create', 'edit', 'pause', 'resume', 'complete', 'clear'])
    expect(goalEvents.some(event => event.type === 'user/message'
      && event.data.source?.kind === 'goal' && event.data.source.round === 0)).toBe(false)
  })

  it('maps empty, prompt-reject, and workspace-first query scenarios', async () => {
    vi.stubGlobal('location', {
      search: '?fixture=empty&fixturePrompt=reject&fixtureFrames=workspace-first',
    })
    const rpc = createFixtureConnectionRpc()
    const sessions = createSessionClient(rpc)
    const workspaces = createWorkspaceClient(rpc)
    const workspaceRemote = createWorkspaceRemote(rpc)
    await expect(sessions.list({})).resolves.toMatchObject({ result: { ok: true, value: { items: [] } } })
    const made = await workspaces.create({ path: '/tmp/fixture-workspaces/query-workspace' })
    if (!made.result.ok) throw new Error('workspace create failed')
    const hostAbort = new AbortController()
    const workspaceAbort = new AbortController()
    const hostFrames = collectValues(
      openFixtureRemoteEvents(rpc, hostAbort.signal),
      hostAbort,
      frames => frames.length === 1,
    )
    const workspaceFrames = collectValues(
      workspaceRemote.follow(workspaceAbort.signal),
      workspaceAbort,
      frames => frames.some(frame => frame.type === 'upsert'
        && frame.workspace.sessionIds.includes(sid('fx-query-session'))),
    )
    await new Promise(resolve => setTimeout(resolve, 10))
    const sessionId = sid('fx-query-session')
    const created = await sessions.create({
      workspaceId: made.result.value.workspace.workspaceId,
      sessionId,
    })
    expect(created.result).toMatchObject({ ok: true, value: { sessionId } })
    expect((await workspaceFrames).at(-1)).toMatchObject({
      type: 'upsert',
      workspace: { sessionIds: [sessionId] },
    })
    expect((await hostFrames)[0]).toMatchObject({
      event: 'api-session/added',
    })
    const rejected = await sessions.prompt({
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'retain' }],
    })
    expect(rejected.result).toMatchObject({ ok: false, error: { code: 'session/agent-busy' } })
  })

  it('maps attach-failure and dropped-response query scenarios', async () => {
    vi.stubGlobal('location', { search: '?fixture&fixtureAttach=fail' })
    const partial = createFixtureConnectionRpc()
    const partialResult = await createSessionClient(partial).create({
      workspaceId: 'fx-ws-fixture' as WorkspaceId,
      sessionId: sid('fx-query-partial'),
    })
    expect(partialResult.result).toMatchObject({
      ok: false,
      error: { code: 'session/workspace-attach-failed', details: { sessionId: 'fx-query-partial' } },
    })

    vi.stubGlobal('location', { search: '?fixture&fixtureSessionCreate=drop-response' })
    const dropped = createFixtureConnectionRpc()
    await expect(createSessionClient(dropped).create({
      workspaceId: 'fx-ws-fixture' as WorkspaceId,
      sessionId: sid('fx-query-dropped'),
    })).rejects.toThrow(/dropped session\.create response/)
  })

})
