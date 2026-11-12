/** Host registry for model-visible, read-only Cordis capability queries. */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-error'
import type {} from '@deepseek-ai/dsh-api-gateway'
import { snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import type {
  CordisInspectMethodManifest, CordisInspectPlatform, CordisInspectProviderManifest,
  CordisInspectProviderView, CordisInspectQueryRequest, CordisInspectQueryResolution,
  CordisInspectRequestId, CordisInspectResolveAck,
} from './types.ts'

/**
 * Every {@link InspectError} code:
 * - `INSPECT_PROVIDER_NOT_FOUND`: no provider with the requested id is registered on the platform.
 * - `INSPECT_METHOD_NOT_FOUND`: the provider declares no method with the requested name.
 * - `INSPECT_TARGET_NOT_FOUND`: the query names a target, such as a Loader entry, that the provider does not have.
 * - `INSPECT_INVALID_INPUT`: the input violates the method's input schema.
 * - `INSPECT_INVALID_OUTPUT`: the provider returned a non-JSON value or a value outside its output schema.
 * - `INSPECT_CLIENT_UNAVAILABLE`: no Harness page is connected to answer a Client query, or the registry was disposed while it waited.
 * - `INSPECT_TIMEOUT`: no valid Client response arrived within the query timeout.
 * - `INSPECT_FAILED`: a Host provider failed without its own error code; `cause` is the original error.
 */
export const INSPECT_ERROR_CODES = [
  'INSPECT_PROVIDER_NOT_FOUND',
  'INSPECT_METHOD_NOT_FOUND',
  'INSPECT_TARGET_NOT_FOUND',
  'INSPECT_INVALID_INPUT',
  'INSPECT_INVALID_OUTPUT',
  'INSPECT_CLIENT_UNAVAILABLE',
  'INSPECT_TIMEOUT',
  'INSPECT_FAILED',
] as const

/** One {@link InspectError} code. */
export type InspectErrorCode = typeof INSPECT_ERROR_CODES[number]

/** Typed Cordis inspect query failure; `code` is one of {@link INSPECT_ERROR_CODES}. */
export class InspectError extends HarnessError {
  override readonly code: InspectErrorCode

  constructor(message: string, code: InspectErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'InspectError'
    this.code = code
  }
}

/** Context supplied to a Host inspect query. */
export interface HostCordisInspectQueryContext {
  /** Tool-call cancellation. */
  signal: AbortSignal
  /** Agent whose scoped runtime is being inspected. */
  agent: Agent
}

/** Local registration paired with its serializable manifest. */
export interface HostCordisInspectProviderRegistration {
  /** Provider and explicit method directory. */
  manifest: CordisInspectProviderManifest
  /** Execute one declared method. */
  query(method: string, input: JsonValue | undefined, context: HostCordisInspectQueryContext): Promise<JsonValue>
}

interface PendingClientQuery {
  request: CordisInspectQueryRequest
  method: CordisInspectMethodManifest
  failure?: string
  settle(resolution: CordisInspectQueryResolution): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host registry for Cordis inspect providers and Client manifest/query routing. */
    cordisInspect: CordisInspectRegistryService
  }
}

/** Registry and cross-page router behind the two model-facing inspect tools. */
export class CordisInspectRegistryService extends Service {
  private readonly providers = new Map<string, HostCordisInspectProviderRegistration>()
  private readonly pending = new Map<CordisInspectRequestId, PendingClientQuery>()
  private clientManifest: readonly CordisInspectProviderManifest[] | undefined
  private nextRequest = 1

  /**
   * Register the process-global Host registry.
   * @param ctx - owning Host context.
   * @param clientQueryTimeoutMs - maximum wait for a valid Client response, in milliseconds.
   */
  constructor(ctx: Context, private readonly clientQueryTimeoutMs: number) {
    super(ctx, 'cordisInspect')
    ctx.effect(() => () => {
      for (const pending of this.pending.values()) {
        pending.settle({ ok: false, reason: 'cancelled', message: 'Client inspect registry was disposed' })
      }
    }, 'cordis-inspect: pending queries')
  }

  /**
   * Register one Host provider.
   * @param registration - manifest and local query handler.
   * @returns idempotent disposer.
   */
  register(registration: HostCordisInspectProviderRegistration): () => void {
    const manifest = validateManifest(registration.manifest)
    if (this.providers.has(manifest.id)) throw new Error(`Host Cordis inspect provider "${manifest.id}" is already registered`)
    const stored = { ...registration, manifest }
    this.providers.set(manifest.id, stored)
    return () => {
      if (this.providers.get(manifest.id) === stored) this.providers.delete(manifest.id)
    }
  }

  /**
   * Replace the mirrored Client provider directory.
   * @param providers - complete Client manifest snapshot.
   */
  syncClientManifest(providers: readonly CordisInspectProviderManifest[]): void {
    const ids = new Set<string>()
    const validated = providers.map((provider) => {
      const manifest = validateManifest(provider)
      if (ids.has(manifest.id)) throw new Error(`Client Cordis inspect manifest repeats provider "${manifest.id}"`)
      ids.add(manifest.id)
      return manifest
    })
    this.clientManifest = Object.freeze(validated)
  }

  /**
   * Return the complete known Host and Client provider directory.
   * @returns Host providers followed by the Client providers.
   */
  list(): CordisInspectProviderView[] {
    return [
      ...[...this.providers.values()].map(provider => view('host', provider.manifest)),
      ...(this.clientManifest ?? []).map(provider => view('client', provider)),
    ]
  }

  /**
   * Execute one provider query on its owning platform.
   * @param platform - Host or Client runtime.
   * @param providerId - provider selected from {@link list}.
   * @param methodName - declared method name.
   * @param input - optional lossless JSON input.
   * @param agent - requesting Agent and scope.
   * @param signal - tool-call cancellation.
   * @returns provider JSON data; Client queries fail fast when Gateway has no live Client
   * and retain only the first observed failure diagnostic for timeout reporting.
   * @throws {InspectError} for an unknown provider or method, invalid input or output, a missing
   *   Client, a Client timeout, or a Host provider failure without its own `HarnessError`; cancellation
   *   rethrows the signal's reason.
   */
  async query(
    platform: CordisInspectPlatform,
    providerId: string,
    methodName: string,
    input: JsonValue | undefined,
    agent: Agent,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    if (platform === 'host') {
      const registration = this.providers.get(providerId)
      if (registration === undefined) {
        throw new InspectError(`Host Cordis inspect provider "${providerId}" is not registered`, 'INSPECT_PROVIDER_NOT_FOUND')
      }
      const method = findMethod(registration.manifest, methodName)
      validateInput('Host', providerId, method, input)
      signal.throwIfAborted()
      let data: JsonValue
      try {
        data = await registration.query(methodName, input, { agent, signal })
      } catch (error) {
        // The cancellation itself passes through for the tool registry to classify as ABORTED.
        if (error instanceof HarnessError || isCancellation(error, signal)) throw error
        throw new InspectError(
          `Host Cordis inspect ${providerId}.${methodName} failed: ${error instanceof Error ? error.message : String(error)}`,
          'INSPECT_FAILED', { cause: error },
        )
      }
      signal.throwIfAborted()
      return validateOutput('Host', providerId, method, data)
    }
    return await this.queryClient(providerId, methodName, input, agent, signal)
  }

  /**
   * Accept the first valid Client response for a pending query.
   * @param agent - Agent whose Session owns the query.
   * @param requestId - Pending Client query identity.
   * @param resolution - Client provider result or failure.
   * @returns acknowledgement with accepted true only for a success that settles the query; only the first failure diagnostic is retained.
   */
  resolveClientQuery(
    agent: Agent,
    requestId: CordisInspectRequestId,
    resolution: CordisInspectQueryResolution,
  ): CordisInspectResolveAck {
    const pending = this.pending.get(requestId)
    if (pending === undefined || pending.request.agentId !== agent.id) return { accepted: false }
    // A failed page must not prevent another page from supplying a valid result.
    if (!resolution.ok) {
      pending.failure ??= `${resolution.reason}: ${resolution.message}`
      return { accepted: false }
    }
    try {
      resolution = {
        ok: true,
        data: validateOutput('Client', pending.request.provider, pending.method, resolution.data),
      }
    } catch (error) {
      pending.failure ??= error instanceof Error ? error.message : String(error)
      return { accepted: false }
    }
    pending.settle(resolution)
    return { accepted: true }
  }

  private async queryClient(
    providerId: string,
    methodName: string,
    input: JsonValue | undefined,
    agent: Agent,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const provider = this.clientManifest?.find(candidate => candidate.id === providerId)
    if (provider === undefined) {
      throw new InspectError(`Client Cordis inspect provider "${providerId}" is not registered`, 'INSPECT_PROVIDER_NOT_FOUND')
    }
    const method = findMethod(provider, methodName)
    validateInput('Client', providerId, method, input)
    signal.throwIfAborted()
    const gateway = this.ctx.get('typertGateway')
    if (gateway !== undefined && !gateway.hasLiveClient()) {
      throw new InspectError(
        `Client inspect query ${providerId}.${methodName} has no connected Harness page. Open or reconnect the Harness page, then retry.`,
        'INSPECT_CLIENT_UNAVAILABLE',
      )
    }
    const requestId = `inspect-${this.nextRequest++}` as CordisInspectRequestId
    const request: CordisInspectQueryRequest = {
      requestId,
      agentId: agent.id,
      provider: providerId,
      method: methodName,
      ...input === undefined ? {} : { input },
    }
    const result = new Promise<CordisInspectQueryResolution>((resolve) => {
      this.pending.set(requestId, {
        request,
        method,
        settle: (resolution) => {
          this.pending.delete(requestId)
          resolve(resolution)
          try {
            this.ctx.emit('cordis/inspect-query-resolved', { requestId })
          } catch (error) {
            console.error('[cordis-host-runner] notifying Client inspect completion failed:', error)
          }
        },
      })
    })
    const onAbort = (): void => {
      this.pending.get(requestId)?.settle({
        ok: false,
        reason: 'cancelled',
        message: `Client inspect query ${providerId}.${methodName} was cancelled`,
      })
    }
    const timer = setTimeout(() => {
      const pending = this.pending.get(requestId)
      if (pending === undefined) return
      const detail = pending.failure === undefined
        ? 'Open or reconnect the Harness page, then retry.'
        : `Client failure: ${pending.failure}`
      pending.settle({
        ok: false,
        reason: 'provider-error',
        message: `Client inspect query ${providerId}.${methodName} timed out after ${this.clientQueryTimeoutMs}ms. ${detail}`,
      })
    }, this.clientQueryTimeoutMs)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      if (signal.aborted) onAbort()
      else this.ctx.emit('cordis/inspect-query', request)
      const resolution = await result
      if (!resolution.ok) {
        signal.throwIfAborted()
        // Locally settled failures: the response deadline, or registry disposal reported as cancellation.
        const code = resolution.reason === 'cancelled' ? 'INSPECT_CLIENT_UNAVAILABLE' : 'INSPECT_TIMEOUT'
        throw new InspectError(`${providerId}.${methodName}: ${resolution.message}`, code)
      }
      return resolution.data
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      this.pending.delete(requestId)
    }
  }
}

/** Whether a rejection is the caller's cancellation rather than a failure of its own. */
function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && (error === signal.reason || (error instanceof Error && error.name === 'AbortError'))
}

function view(platform: CordisInspectPlatform, manifest: CordisInspectProviderManifest): CordisInspectProviderView {
  return { platform, ...manifest, methods: [...manifest.methods] }
}

function validateManifest(manifest: CordisInspectProviderManifest): CordisInspectProviderManifest {
  if (manifest.id.trim() === '') throw new Error('Cordis inspect provider id must not be empty')
  if (manifest.description.trim() === '') throw new Error(`Cordis inspect provider "${manifest.id}" needs a description`)
  const names = new Set<string>()
  const methods = manifest.methods.map((method) => {
    if (method.name.trim() === '') throw new Error(`Cordis inspect provider "${manifest.id}" has an empty method name`)
    if (names.has(method.name)) throw new Error(`Cordis inspect provider "${manifest.id}" repeats method "${method.name}"`)
    if (method.description.trim() === '') throw new Error(`Cordis inspect method ${manifest.id}.${method.name} needs a description`)
    assertSupportedJsonSchema(method.inputSchema)
    assertSupportedJsonSchema(method.outputSchema)
    names.add(method.name)
    return Object.freeze({ ...method })
  })
  return Object.freeze({ ...manifest, methods: Object.freeze(methods) })
}

function findMethod(manifest: CordisInspectProviderManifest, name: string): CordisInspectMethodManifest {
  const method = manifest.methods.find(candidate => candidate.name === name)
  if (method === undefined) throw new InspectError(`Cordis inspect provider "${manifest.id}" has no method "${name}"`, 'INSPECT_METHOD_NOT_FOUND')
  return method
}

function validateInput(
  platform: 'Host' | 'Client',
  provider: string,
  method: CordisInspectMethodManifest,
  input: JsonValue | undefined,
): void {
  const violations = validateJsonSchemaValue(method.inputSchema as JsonSchemaNode, input ?? {}, 'input')
  if (violations.length > 0) {
    throw new InspectError(`${platform} Cordis inspect ${provider}.${method.name} rejected input: ${violations.join('; ')}`, 'INSPECT_INVALID_INPUT')
  }
}

function validateOutput(
  platform: 'Host' | 'Client',
  provider: string,
  method: CordisInspectMethodManifest,
  data: JsonValue,
): JsonValue {
  const snapshot = snapshotJsonValue(data)
  if (snapshot === undefined) {
    throw new InspectError(`${platform} Cordis inspect ${provider}.${method.name} returned a non-JSON value`, 'INSPECT_INVALID_OUTPUT')
  }
  const violations = validateJsonSchemaValue(method.outputSchema as JsonSchemaNode, snapshot, 'output')
  if (violations.length > 0) {
    throw new InspectError(`${platform} Cordis inspect ${provider}.${method.name} returned invalid output: ${violations.join('; ')}`, 'INSPECT_INVALID_OUTPUT')
  }
  return snapshot
}
