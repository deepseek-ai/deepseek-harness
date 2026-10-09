/** Durable provider-independent translations through an existing Session writer. */
import type { Context } from '@deepseek-ai/cordis'
import { appendPluginRecord, pluginRecordOf, SessionSeq, type SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError, type SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { deepEqualJson, deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { TranslationIdentity, TranslationRequestRecord } from './types.ts'
import { TranslationError } from './error.ts'

/** One live Session's translation writes; failures preserve safe diagnostics or the caller's abort reason. */
export interface TranslationLog {
  /**
   * Retain one immutable request before dispatch.
   * @param data - common input and optional exact provider-owned request details.
   * @returns the request sequence used by its eventual result, after durability is verified.
   */
  request(data: TranslationRequestRecord): Promise<SessionSeq>
  /**
   * Retain a successful result before returning it to the caller.
   * @param requestSeq - this operation's durable request sequence.
   * @param text - complete validated translated text.
   */
  result(requestSeq: SessionSeq, text: string): Promise<void>
}

function required(): TranslationError {
  return new TranslationError('TRANSLATION_SESSION_REQUIRED', 'Translation requires an existing durable Session')
}

function invalid(): TranslationError {
  return new TranslationError('TRANSLATION_STORAGE_ERROR', 'Stored translation records are invalid or unavailable')
}

function failure(error: unknown, signal: AbortSignal): never {
  signal.throwIfAborted()
  if (error instanceof SessionPersistenceNotFoundError) throw required()
  if (error instanceof TranslationError) throw error
  throw invalid()
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requestData(value: unknown): TranslationRequestRecord {
  if (!object(value) || !['provider', 'text', 'sourceLanguage', 'targetLanguage', 'recipe'].every(key => typeof value[key] === 'string')
    || (value.metadata !== undefined && !object(value.metadata))) throw invalid()
  return { provider: String(value.provider), text: String(value.text), sourceLanguage: String(value.sourceLanguage),
    targetLanguage: String(value.targetLanguage), recipe: String(value.recipe),
    ...value.metadata === undefined ? {} : { metadata: value.metadata } }
}

function identityKey(identity: TranslationIdentity): string {
  return JSON.stringify([identity.provider, identity.text, identity.sourceLanguage, identity.targetLanguage, identity.recipe])
}

/** Saved results need no live Session; uncached translations use its existing writer. */
export class TranslationStorage {
  private readonly translations = new Map<string, Promise<void>>()

  /** @param ctx - translator context with optional live Sessions and durable persistence. */
  constructor(private readonly ctx: Context) {
    ctx.effect(() => async () => { await Promise.all(this.translations.values()) })
  }

  /**
   * Reuse a saved result, or retain a new translation through the live Session writer.
   * @param id - existing Session; a cache miss without a live Session rejects with
   * `TRANSLATION_SESSION_INACTIVE` before invoking `operation`.
   * @param identity - provider, exact source, languages, and recipe; identical concurrent attempts share cache admission.
   * @param signal - operation cancellation, also observed after every storage await.
   * @param operation - uncached translation using the pinned live Session.
   * @returns saved or newly translated text, durably retained. Operation rejection returns without
   * waiting for accepted writes; identical retries and storage disposal wait for those writes to settle.
   */
  run(id: SessionId, identity: TranslationIdentity, signal: AbortSignal,
    operation: (log: TranslationLog) => Promise<string>): Promise<string> {
    const persistence = this.ctx.get('sessionPersistence')
    const key = JSON.stringify([id, identityKey(identity)])
    const writes: Promise<void>[] = []
    const task = (this.translations.get(key) ?? Promise.resolve()).then(async () => {
      signal.throwIfAborted()
      if (persistence === undefined) throw required()
      const current = (): void => {
        signal.throwIfAborted()
        if (this.ctx.get('sessionPersistence')?.identity !== persistence.identity) throw required()
      }
      try {
        current()
        if (await persistence.stat(id, { signal }) === undefined) throw required()
        current()
        const cached = await this.lookup(id, identity, persistence, signal, current)
        current()
        if (cached !== undefined) return cached
        const sessions = this.ctx.get('sessions'), session = sessions?.get(id)
        if (sessions === undefined || session === undefined) {
          throw new TranslationError('TRANSLATION_SESSION_INACTIVE', 'Uncached translation requires an active Session')
        }
        const live = (): void => {
          current()
          if (this.ctx.get('sessions')?.get(id) !== session) throw required()
        }
        const append = <K extends 'plugin:translator/request' | 'plugin:translator/result'>(type: K,
          data: import('@deepseek-ai/dsh-session/types').PluginRecordMap[K]): Promise<SessionSeq> => {
          const writing = (async () => {
            try {
              live()
              const snapshot = deepFreeze(structuredClone(data))
              const seq = appendPluginRecord(session, type, snapshot)
              await sessions.flush(session)
              live()
              const stored = (await this.read(id, persistence, signal, live, seq, 1))[0]
              live()
              if (stored === undefined || pluginRecordOf(stored)?.type !== type || !deepEqualJson(stored.data, snapshot)) throw invalid()
              return seq
            } catch (error) {
              failure(error, signal)
            }
          })()
          writes.push(writing.then(() => {}, () => {}))
          return writing
        }
        return await operation({
          request: data => append('plugin:translator/request', data),
          async result(requestSeq, text) { await append('plugin:translator/result', { requestSeq, text }) },
        })
      } catch (error) {
        failure(error, signal)
      }
    })
    const settled = task.then(() => {}, () => {})
    const tail = settled.then(async () => {
      await Promise.all(writes)
      if (this.translations.get(key) === tail) this.translations.delete(key)
    })
    this.translations.set(key, tail)
    return task
  }

  private async read(id: SessionId, persistence: SessionPersistence, signal: AbortSignal,
    current: () => void, start = 0, count?: number) {
    current()
    await using handle = await persistence.open(id, 'read', { signal })
    current()
    const stored = await handle.read(start, count, { signal })
    current()
    return stored.events
  }

  private async lookup(id: SessionId, identity: TranslationIdentity, persistence: SessionPersistence,
    signal: AbortSignal, current: () => void): Promise<string | undefined> {
    const requests = new Map<SessionSeq, TranslationRequestRecord>()
    const results = new Map<string, string>()
    for (const event of await this.read(id, persistence, signal, current)) {
      const record = pluginRecordOf(event)
      if (record?.type === 'plugin:translator/request') requests.set(record.seq, requestData(record.data))
      if (record?.type !== 'plugin:translator/result') continue
      const data = record.data
      if (!object(data) || typeof data.requestSeq !== 'number' || !Number.isSafeInteger(data.requestSeq)
        || data.requestSeq < 0 || Object.is(data.requestSeq, -0) || typeof data.text !== 'string') throw invalid()
      const request = requests.get(SessionSeq(data.requestSeq))
      if (request === undefined) throw invalid()
      results.set(identityKey(request), data.text)
    }
    return results.get(identityKey(identity))
  }
}
