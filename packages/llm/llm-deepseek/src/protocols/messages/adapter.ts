/** Direct Messages transport with one cancellable lifecycle per model request. */

import { attributionHeaders, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ImageAttachmentAccessResolver, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { DeepSeekLlmApiJson } from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { catalogModelInfo, modelInfo } from '../../common/model-info.ts'
import type { DeepSeekAdapterOptions, DeepSeekConnectionOptions as Connection } from '../../common/types.ts'
import type { DeepSeekFileStore } from '../../common/file-store.ts'
import { MESSAGES_FILES_BETA } from '../../common/files-api.ts'
import { FileResolutionFailure, RequestFiles } from '../../common/request-files.ts'
import { prepareRequestExtensions } from '../../common/request-extensions.ts'
import { imagePricing, inlineImages, prepareFileIds, prepareImages } from './images.ts'
import { serialize } from './serialize.ts'
import { parseSse } from './sse.ts'
import { translate } from './translate.ts'
import { providerError, providerErrorDetail } from './transport.ts'

/** Request-local dependencies supplied by the owning Cordis plugin. */
export interface AdapterDependencies {
  /** Resolve a single validated configuration generation. */
  connection(): Connection
  /** Resolve the key named by that same generation. */
  apiKey(connection: Connection): Promise<string>
  /** Stable anonymous Harness identity. */
  userId(): string
  /** Current attachment service; absence is valid for text requests. */
  attachments(): AttachmentStore | undefined
  /** Current execution-world attachment path. */
  imageAccess: ImageAttachmentAccessResolver
  /** Process-wide Files upload reuse and recovery. */
  files(): DeepSeekFileStore
  /** Prepare plugin-contributed fields for this exact HTTP request. */
  prepareExtensions: DeepSeekAdapterOptions['prepareExtensions']
  /** Report discarded replay metadata without exposing durable content or signatures. */
  onReplayDegrade?: (detail: { provider: string; model: string; reason: string }) => void
}

/** DeepSeek provider using Messages content and native thinking replay. */
export class DeepSeekMessagesAdapter extends LlmAdapter {
  constructor(private readonly dependencies: AdapterDependencies) { super() }

  override providerInfo(provider: string) { return { id: provider, name: 'DeepSeek' } }
  override providerRetryPolicy(_provider: string) { return this.dependencies.connection().retryPolicy }
  override listModels(provider: string) {
    const connection = this.dependencies.connection()
    return Promise.resolve(connection.models.map(model => catalogModelInfo(provider, model)))
  }
  override resolveModel(provider: string, model: string) {
    return Promise.resolve(modelInfo(this.dependencies.connection(), provider, model))
  }
  override imageRequestPricing(_provider: string, model: string) {
    return imagePricing(this.dependencies.connection(), model, this.dependencies.imageAccess)
  }
  override prepareCall(provider: string, model: string): Promise<PreparedAdapterCall> {
    const connection = this.dependencies.connection()
    return Promise.resolve({ model: modelInfo(connection, provider, model), stream: options => this.generate(options, connection) })
  }
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.generate(options, this.dependencies.connection())
  }

  private async * generate(options: GenerateOptions, connection: Connection): AsyncGenerator<StreamChunk> {
    const consumer = new AbortController()
    const signal = options.signal === undefined ? consumer.signal : AbortSignal.any([consumer.signal, options.signal])
    using watchdog = idleWatchdog(signal, connection.streamIdleTimeoutMs, 'MESSAGES_IDLE')
    const iterator = this.request(options, connection, watchdog.signal, () => { watchdog.pulse() })
    try {
      while (true) {
        const next = await watchdog.next(iterator)
        if (next.done) return
        yield next.value
      }
    } catch (error) {
      if (timeoutOf(watchdog.signal, 'MESSAGES_IDLE') !== undefined) throw new LlmError('DeepSeek Messages stream idle timeout', 'TIMEOUT', { cause: error })
      if (options.signal?.aborted) throw new LlmError('DeepSeek Messages request aborted', 'ABORTED', { cause: error })
      if (error instanceof LlmError) throw error
      throw new LlmError('DeepSeek Messages transport failed', 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort()
      try { await iterator.return(undefined) } catch (_abortedRequestCleanup) {
        // The request already settled; aborting its reader cannot replace that outcome.
      }
    }
  }

  private async * request(
    options: GenerateOptions, connection: Connection, signal: AbortSignal, activity: () => void,
  ): AsyncGenerator<StreamChunk> {
    signal.throwIfAborted()
    const { messages, versions } = await prepareImages(
      options.messages, connection, options.model, this.dependencies.attachments(), this.dependencies.imageAccess, signal,
    )
    const key = await this.dependencies.apiKey(connection)
    const files = new RequestFiles(this.dependencies.files(), { baseURL: connection.baseURL, apiKey: key, protocol: 'messages' },
      connection.filePolicy, connection.filesApiTimeoutMs, signal, activity)
    let inline = false
    while (true) {
      signal.throwIfAborted()
      files.beginAttempt()
      let fileIds: Awaited<ReturnType<typeof prepareFileIds>> | undefined
      if (!inline) {
        try {
          fileIds = await prepareFileIds(messages, versions, files)
        } catch (error) {
          if (!(error instanceof FileResolutionFailure)) throw error
          inline = true
          continue
        }
      }
      const history = inline ? inlineImages(messages, versions, connection) : messages
      const body = serialize(options, connection, history, versions, this.dependencies.imageAccess, (reason) => {
        this.dependencies.onReplayDegrade?.({ provider: options.provider, model: options.model, reason })
      }, fileIds)
      const extensions = await prepareRequestExtensions(body as unknown as Readonly<Record<string, DeepSeekLlmApiJson>>, {
        signal,
        ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
        ...options.purpose === undefined ? {} : { purpose: options.purpose },
      }, this.dependencies.prepareExtensions)
      signal.throwIfAborted()
      const response = await fetch(`${connection.baseURL.replace(/\/+$/u, '')}/v1/messages`, {
        method: 'POST', signal, body: extensions.payload, redirect: 'error',
        headers: {
          ...attributionHeaders(),
          'content-type': 'application/json', 'accept': 'text/event-stream',
          'x-api-key': key, 'anthropic-version': '2023-06-01',
          ...fileIds === undefined || fileIds.size === 0 ? {} : { 'anthropic-beta': MESSAGES_FILES_BETA },
          'x-deepseek-harness-user-id': this.dependencies.userId(),
          ...options.sessionId === undefined ? {} : { 'x-deepseek-harness-session-id': String(options.sessionId) },
          ...options.purpose === 'compaction' ? { 'x-deepseek-harness-compact': '1' } : {},
        },
      })
      if (!response.ok) {
        const text = await response.text()
        let raw: unknown
        try { raw = JSON.parse(text) } catch (_nonJsonGatewayError) {
          // HTTP status is authoritative when a gateway does not return JSON.
        }
        const detail = providerErrorDetail(raw)
        if (await files.retry(detail)) continue
        const failure = providerError(raw, response.status, response.headers)
        const message = files.errorMessage(response.status, failure.message, detail)
        throw new LlmError(message, failure.code, { ...failure.failure, cause: new Error(text) })
      }
      await extensions.accept()
      if (response.body === null) throw new LlmError('DeepSeek Messages returned no response body', 'EMPTY_RESPONSE')
      yield* translate(parseSse(response.body, activity), options.model)
      return
    }
  }
}
