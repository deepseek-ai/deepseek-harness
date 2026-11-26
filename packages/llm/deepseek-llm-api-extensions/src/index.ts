/**
 * Plugins contribute top-level fields and `x-deepseek-harness-` headers to official
 * DeepSeek requests. The adapter prepares and accepts the body fields together.
 * @module @deepseek-ai/dsh-deepseek-llm-api-extensions
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  DeepSeekLlmApiExtensionMap,
  DeepSeekLlmApiExtensionProvider,
  DeepSeekLlmApiExtensionRequest,
  DeepSeekLlmApiHeaderMap,
  DeepSeekLlmApiHeaderProvider,
  DeepSeekLlmApiHeaderRequest,
  DeepSeekLlmApiJson,
  PreparedDeepSeekLlmApiExtensions,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    deepseekLlmApiExtensions: DeepSeekLlmApiExtensionRegistry
  }
}

interface ErasedProvider {
  prepare(request: DeepSeekLlmApiExtensionRequest):
    | { readonly value: DeepSeekLlmApiJson; accept?(): void | Promise<void> }
    | undefined
    | Promise<{ readonly value: DeepSeekLlmApiJson; accept?(): void | Promise<void> } | undefined>
}

interface ErasedHeaderProvider {
  value(request: DeepSeekLlmApiHeaderRequest): string | undefined
}

/** Lowercase `x-deepseek-harness-` name of hyphen-separated ASCII letters and digits. */
const HEADER_NAME = /^x-deepseek-harness-[0-9a-z]+(?:-[0-9a-z]+)*$/u
const ADAPTER_HEADERS = new Set([
  'x-deepseek-harness-user-id',
  'x-deepseek-harness-session-id',
  'x-deepseek-harness-compact',
])
/** Non-empty printable ASCII; spaces and tabs only between visible characters, which HTTP keeps verbatim. */
const HEADER_VALUE = /^[\x21-\x7e](?:[\t\x20-\x7e]*[\x21-\x7e])?$/u

/** Recursively freeze a fresh structured clone. */
function freezeJson<T extends DeepSeekLlmApiJson>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Array.isArray(value) ? value : Object.values(value)) freezeJson(child)
    Object.freeze(value)
  }
  return value
}

/** Settle every acceptance callback before reporting failures. */
async function acceptAll(callbacks: readonly (() => void | Promise<void>)[]): Promise<void> {
  const outcomes = await Promise.allSettled(callbacks.map(callback => Promise.resolve().then(callback)))
  const failures: unknown[] = outcomes
    .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
    .map(outcome => outcome.reason as unknown)
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'DeepSeek LLM API extension acceptance failed')
}

/** Stop awaiting provider work when the containing model request is cancelled. */
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  const aborted = Promise.withResolvers<never>()
  const onAbort = (): void => { aborted.reject(signal.reason) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const result = await Promise.race([work, aborted.promise])
    signal.throwIfAborted()
    return result
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** Registry of independently owned top-level fields and request headers for official DeepSeek requests. */
export class DeepSeekLlmApiExtensionRegistry extends Service {
  private readonly providers = new Map<string, ErasedProvider>()
  /** Fields whose preparation failure was already logged; later failures stay silent. */
  private readonly warnedFields = new Set<string>()
  private readonly headerProviders = new Map<string, ErasedHeaderProvider>()
  /** Headers whose omission was already logged; later omissions stay silent. */
  private readonly warnedHeaders = new Set<string>()

  constructor(ctx: Context) {
    super(ctx, 'deepseekLlmApiExtensions')
  }

  /**
   * Register the sole provider of one top-level request field. Registration is effect-scoped.
   * @param field - declaration-merged field owned by the provider.
   * @param provider - request-time field preparation and optional acceptance behavior.
   * @returns disposer that releases the field.
   */
  register<K extends keyof DeepSeekLlmApiExtensionMap>(
    field: K,
    provider: DeepSeekLlmApiExtensionProvider<DeepSeekLlmApiExtensionMap[K]>,
  ): () => Promise<void> {
    const fieldName = field as string
    if (fieldName.length === 0 || fieldName.trim() !== fieldName) {
      throw new Error('deepseek-llm-api-extensions: field must be a non-blank trimmed string')
    }
    const providers = this.providers
    const erased = provider as ErasedProvider
    const dispose = this.ctx.effect(() => {
      if (providers.has(fieldName)) {
        throw new Error(`deepseek-llm-api-extensions: field ${JSON.stringify(fieldName)} is already registered`)
      }
      providers.set(fieldName, erased)
      return () => {
        providers.delete(fieldName)
      }
    }, `deepseekLlmApiExtensions.register(${JSON.stringify(fieldName)})`)
    return dispose
  }

  /**
   * Prepare every currently registered field from one immutable base request.
   * A provider whose preparation throws, or whose value cannot be cloned, is omitted
   * from this request; the first such failure per field is logged. Only cancellation rejects. Field values are cloned
   * and frozen; providers retain no mutable alias to the outgoing request.
   * @param request - exact serialized request facts before extension fields.
   * @returns detached fields and their idempotent joint acceptance transaction.
   */
  async prepare(request: DeepSeekLlmApiExtensionRequest): Promise<PreparedDeepSeekLlmApiExtensions> {
    request.signal.throwIfAborted()
    const entries = [...this.providers.entries()]
    const prepared = await abortable(Promise.all(entries.map(async ([field, provider]) => {
      try {
        const result = await provider.prepare(request)
        return result === undefined ? undefined : { field, value: freezeJson(structuredClone(result.value)), result }
      } catch (error) {
        if (!request.signal.aborted && !this.warnedFields.has(field)) {
          this.warnedFields.add(field)
          this.ctx.logger.warn(`deepseek-llm-api-extensions: omitting field ${JSON.stringify(field)} from this request because its preparation failed: %o`, error)
        }
        return undefined
      }
    })), request.signal)
    const fields: Record<string, DeepSeekLlmApiJson> = Object.create(null) as Record<string, DeepSeekLlmApiJson>
    const callbacks: Array<() => void | Promise<void>> = []
    for (const item of prepared) {
      if (item === undefined) continue
      const { field, value, result } = item
      fields[field] = value
      const accept = result.accept
      if (accept !== undefined) callbacks.push(accept.bind(result))
    }
    Object.freeze(fields)
    let acceptance: Promise<void> | undefined
    return {
      fields,
      accept: () => acceptance ??= acceptAll(callbacks),
    }
  }

  /**
   * Register the sole provider of one request header for the calling fiber.
   * The adapter reserves its user-id, session-id, and compact headers.
   * @param name - declaration-merged lowercase `x-deepseek-harness-` header of hyphen-separated ASCII letters and digits.
   * @param provider - synchronous request-time value computation.
   * @returns disposer that releases the header.
   */
  registerHeader<K extends keyof DeepSeekLlmApiHeaderMap>(
    name: K,
    provider: DeepSeekLlmApiHeaderProvider<DeepSeekLlmApiHeaderMap[K]>,
  ): () => Promise<void> {
    const headerName = name as string
    if (!HEADER_NAME.test(headerName)) {
      throw new Error(`deepseek-llm-api-extensions: header ${JSON.stringify(headerName)} must be a lowercase x-deepseek-harness- name of hyphen-separated ASCII letters and digits`)
    }
    if (ADAPTER_HEADERS.has(headerName)) {
      throw new Error(`deepseek-llm-api-extensions: header ${JSON.stringify(headerName)} is reserved by the adapter`)
    }
    const providers = this.headerProviders
    const erased: ErasedHeaderProvider = provider
    return this.ctx.effect(() => {
      if (providers.has(headerName)) {
        throw new Error(`deepseek-llm-api-extensions: header ${JSON.stringify(headerName)} is already registered`)
      }
      providers.set(headerName, erased)
      return () => {
        providers.delete(headerName)
      }
    }, `deepseekLlmApiExtensions.registerHeader(${JSON.stringify(headerName)})`)
  }

  /**
   * Compute every currently registered header for one model request. A provider that
   * returns `undefined` contributes nothing. A provider that throws, or returns a value
   * other than non-empty printable ASCII without leading or trailing whitespace, is
   * omitted from this request; the first such omission per header is logged.
   * @param request - request identity and auxiliary purpose.
   * @returns frozen header names and values to add to the HTTP request.
   */
  headers(request: DeepSeekLlmApiHeaderRequest): Readonly<Record<string, string>> {
    const headers: Record<string, string> = {}
    for (const [name, provider] of this.headerProviders) {
      let value: string | undefined
      try {
        value = provider.value(request)
      } catch (error) {
        this.warnHeader(name, 'its provider failed: %o', error)
        continue
      }
      if (value === undefined) continue
      if (!HEADER_VALUE.test(value)) {
        this.warnHeader(name, 'its value cannot be sent verbatim as an HTTP field value')
        continue
      }
      headers[name] = value
    }
    return Object.freeze(headers)
  }

  private warnHeader(name: string, reason: string, ...args: unknown[]): void {
    if (this.warnedHeaders.has(name)) return
    this.warnedHeaders.add(name)
    this.ctx.logger.warn(`deepseek-llm-api-extensions: omitting header ${JSON.stringify(name)} from this request because ${reason}`, ...args)
  }
}

export default DeepSeekLlmApiExtensionRegistry
