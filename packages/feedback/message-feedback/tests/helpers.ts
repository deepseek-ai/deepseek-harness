import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import SessionStore, {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import SessionPersistence, {
  SessionPersistenceRevision,
  type SessionInspection,
  type SessionLocation,
  type SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import MessageFeedbackService from '../src/index.ts'

export interface MessageFixture {
  readonly session: Session
  readonly userMessageId: MessageId
  readonly assistantMessageIds: readonly [MessageId, MessageId]
  readonly emptyAssistantMessageId: MessageId
  readonly replacementAssistantMessageId: MessageId
}

/** Append one deterministic transcript used by target-validation tests. */
export function appendMessageFixture(session: Session): Omit<MessageFixture, 'session'> {
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const user = createUserMessage({
    content: [{ type: 'text', text: 'Question' }],
    source: { kind: 'user' },
  })
  session.append('user/message', user, { surfaceOp: 'append' })

  const first = createAssistantMessage({
    content: [{ type: 'text', text: 'First answer' }],
    source: { provider: 'test', model: 'test' },
  })
  const firstEvent = session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: first,
  }, { surfaceOp: 'append' })
  const second = createAssistantMessage({
    content: [{ type: 'text', text: 'Second answer' }],
    source: { provider: 'test', model: 'test' },
  })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: second,
  }, { surfaceOp: 'append' })
  const empty = createAssistantMessage({
    content: [],
    source: { provider: 'test', model: 'test' },
  })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: empty,
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  const replacement = createAssistantMessage({
    content: [{ type: 'text', text: 'Model-only replacement' }],
    source: { provider: 'test', model: 'test' },
  })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: replacement,
  }, {
    surfaceOp: { op: 'replace', start: firstEvent.seq, end: firstEvent.seq },
    sourceEventSeqs: [firstEvent.seq],
  })

  return {
    userMessageId: user.id,
    assistantMessageIds: [first.id, second.id],
    emptyAssistantMessageId: empty.id,
    replacementAssistantMessageId: replacement.id,
  }
}

/** Construct one cold persistence fixture without publishing a live Session. */
export function messageFixture(
  rawId: string,
  options: { readonly createdAt?: number; readonly cwd?: string } = {},
): MessageFixture {
  const id = SessionId(rawId)
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: options.createdAt ?? 1_700_000_000_000,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  }
  const session = Session.create(id, [], header)
  return { session, ...appendMessageFixture(session) }
}

/** Minimal controllable persistence provider for service-level tests. */
class TestPersistence extends SessionPersistence {
  override readonly supportsRawArtifacts = false

  static inject = ['sessions']

  readonly durable = new Map<SessionId, SessionInspection>()
  readonly logical = new Map<SessionId, SessionInspection>()
  inspectFailure: Error | undefined
  inspectCalls = 0
  readFromCalls = 0
  onReadFrom: (() => void | Promise<void>) | undefined
  onListSnapshots: (() => void | Promise<void>) | undefined

  locate(_meta: SessionHeader): SessionLocation | undefined { return undefined }
  create(_meta: SessionHeader): Promise<void> { return Promise.resolve() }
  append(_id: SessionId, _events: readonly SessionEvent[]): Promise<void> { return Promise.resolve() }

  load(id: SessionId): Promise<SessionInspection> {
    return this.readFrom(id, 0)
  }

  inspect(id: SessionId): Promise<SessionInspection> {
    this.inspectCalls += 1
    if (this.inspectFailure !== undefined) return Promise.reject(this.inspectFailure)
    const explicit = this.logical.get(id)
    if (explicit !== undefined) return Promise.resolve(explicit)
    const live = this.ctx.sessions.get(id)
    if (live !== undefined) return Promise.resolve({ meta: live.header, events: live.snapshotEvents() })
    const stored = this.durable.get(id)
    return stored === undefined
      ? Promise.reject(new Error(`test persistence: session '${id}' not found`))
      : Promise.resolve(stored)
  }

  borrowSession(_id: SessionId, _signal?: AbortSignal): ReturnType<SessionPersistence['borrowSession']> {
    return Promise.reject(new Error('not used'))
  }

  async readFrom(
    id: SessionId,
    fromSeq: number,
  ): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    this.readFromCalls += 1
    await this.onReadFrom?.()
    const stored = this.durable.get(id)
    return stored === undefined
      ? Promise.reject(new Error(`test persistence: session '${id}' not found`))
      : { meta: stored.meta, events: stored.events.filter(event => event.seq >= fromSeq) }
  }

  list(): Promise<SessionHeader[]> {
    return Promise.resolve([...this.durable.values()].map(value => value.meta))
  }

  async listSnapshots(): Promise<SessionPersistenceSnapshot[]> {
    await this.onListSnapshots?.()
    return [...this.durable.values()].map((value, index) => ({
      header: value.meta,
      revision: SessionPersistenceRevision(`test:${index}:${value.events.length}`),
    }))
  }

  persist(session: Session): void {
    this.durable.set(session.id, { meta: session.header, events: session.snapshotEvents() })
  }

  setDurable(inspection: SessionInspection): void {
    this.durable.set(inspection.meta.id, inspection)
  }
}

export interface TestHarness {
  readonly ctx: Context
  readonly persistence: TestPersistence
  readonly root: string
  disposeFeedback(): Promise<void>
  dispose(): Promise<void>
}

/** Compose the service over the real storage hub/domain/JSON backend. */
export async function setupHarness(maxNoteBytes = 64): Promise<TestHarness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-message-feedback-test-'))
  const ctx = new Context()
  let disposeFeedback: (() => Promise<void>) | undefined
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(TestPersistence)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    const feedbackFiber = await ctx.plugin(MessageFeedbackService, { maxNoteBytes })
    disposeFeedback = feedbackFiber.dispose
  } catch (error) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    throw error
  }
  if (disposeFeedback === undefined) throw new Error('message feedback test plugin did not load')
  return {
    ctx,
    persistence: ctx.sessionPersistence as unknown as TestPersistence,
    root,
    disposeFeedback,
    async dispose() {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}
