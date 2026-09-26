/** Client-realm executor for the typed Runtime command protocol. */

import type {
  ClientCallArgument,
  ClientRuntimeCapability,
  ClientRuntimeCommand,
  ClientRuntimeCompletion,
  ClientRuntimeError,
  ClientRuntimeExceptionDetails,
  ClientRuntimeRequestFrame,
  ClientRuntimeResponseFrame,
  ClientRuntimeResult,
  ClientRuntimeRemoteObject,
} from '../../shared/bridge/messages/runtime/index.ts'
import type {
  ClientRemoteObjectHandle,
  ClientRuntimeRequestId,
  ClientRuntimeSessionId,
} from '../../shared/bridge/ids.ts'
import { isJsonValue, jsonByteLength } from '../../shared/json.ts'
import { INSPECTOR_PROTOCOL_VERSION } from '../../shared/bridge/version.ts'
import { ClientRuntimeExecutionError } from './errors.ts'
import type { RuntimeConsoleBackendEvent, RuntimeConsoleType, RuntimeStackTrace } from '../../shared/cdp/index.ts'
import { ClientObjectStore, type ClientObjectAllocation } from './objects.ts'
import { getClientProperties } from './properties.ts'
import { clientErrorStack, type ClientScriptKeyResolver } from './stack.ts'

const MAX_RUNTIME_ERROR_MESSAGE_LENGTH = 2_048

/**
 * Describe browser-side Runtime execution.
 * @param origin - Origin assigned to the synthetic execution context.
 * @returns The Runtime capability advertised by a browser Client source.
 */
export function runtimeBridgeCapability(origin: string): ClientRuntimeCapability {
  return { type: 'client-runtime', origin }
}

/** Client-side limits injected by the Host deployment. */
export interface ClientRuntimeLimits {
  readonly maxObjectsPerSession: number
  readonly maxPropertiesPerResult: number
  readonly maxResponseBytes: number
}

/** Executes Runtime requests while isolating object handles by DevTools session. */
export class ClientRuntimeExecutor {
  private readonly sessions = new Map<ClientRuntimeSessionId, ClientRuntimeSession>()
  private readonly responseAllocations = new Map<ClientRuntimeRequestId, {
    readonly sessionId: ClientRuntimeSessionId
    readonly session: ClientRuntimeSession
    readonly allocation: ClientObjectAllocation
  }>()

  constructor(
    private readonly limits: ClientRuntimeLimits,
    private readonly resolveScript: ClientScriptKeyResolver = () => undefined,
  ) {}

  /**
   * Execute one request and preserve its source, generation, session, and request identities.
   * @param frame - Validated command envelope from the Worker.
   * @param signal - Optional cancellation for an operation awaiting user code.
   * @param deferObjectCommit - Keep new object handles provisional until {@link acknowledge}.
   * @returns A success or transport-error response for the same request.
   */
  async execute(
    frame: ClientRuntimeRequestFrame,
    signal?: AbortSignal,
    deferObjectCommit = false,
  ): Promise<ClientRuntimeResponseFrame> {
    const session = this.session(frame.sessionId)
    const allocation = session.beginAllocation()
    try {
      const result = await session.execute(frame.command, allocation, signal)
      if (signal?.aborted === true) {
        throw new ClientRuntimeExecutionError('timeout', 'Client Runtime request was canceled')
      }
      const response = responseFrame(frame, { ok: true, result })
      if (!isJsonValue(response) || jsonByteLength(response) > this.limits.maxResponseBytes) {
        session.rollback(allocation)
        return responseFrame(frame, {
          ok: false,
          error: { code: 'result-too-large', message: 'Client Runtime result exceeds the source-frame byte limit' },
        })
      }
      if (deferObjectCommit) {
        if (this.responseAllocations.has(frame.requestId)) {
          session.rollback(allocation)
          return responseFrame(frame, {
            ok: false,
            error: { code: 'invalid-request', message: 'Client Runtime request id is already pending' },
          })
        }
        this.responseAllocations.set(frame.requestId, { sessionId: frame.sessionId, session, allocation })
      } else {
        session.commitAllocation(allocation)
      }
      return response
    } catch (error) {
      session.rollback(allocation)
      return responseFrame(frame, { ok: false, error: runtimeError(error) })
    }
  }

  /**
   * Commit handles after the Worker accepts one Runtime response.
   * @param sessionId - Session that owns the response.
   * @param requestId - Correlation id acknowledged by the Worker.
   */
  acknowledge(sessionId: ClientRuntimeSessionId, requestId: ClientRuntimeRequestId): void {
    const pending = this.responseAllocations.get(requestId)
    if (pending === undefined || pending.sessionId !== sessionId) return
    this.responseAllocations.delete(requestId)
    pending.session.commitAllocation(pending.allocation)
  }

  /**
   * Roll back handles from a canceled or otherwise unaccepted Runtime response.
   * @param sessionId - Session that owns the response.
   * @param requestId - Correlation id rejected by the Worker.
   */
  cancel(sessionId: ClientRuntimeSessionId, requestId: ClientRuntimeRequestId): void {
    const pending = this.responseAllocations.get(requestId)
    if (pending === undefined || pending.sessionId !== sessionId) return
    this.responseAllocations.delete(requestId)
    pending.session.rollback(pending.allocation)
  }

  /**
   * Release all values retained for one closed DevTools connection.
   * @param sessionId - Runtime session owned by that DevTools connection.
   */
  closeSession(sessionId: ClientRuntimeSessionId): void {
    for (const [requestId, pending] of this.responseAllocations) {
      if (pending.sessionId === sessionId) this.responseAllocations.delete(requestId)
    }
    this.sessions.get(sessionId)?.close()
    this.sessions.delete(sessionId)
  }

  /**
   * Release one object group without closing the surrounding Runtime session.
   * @param sessionId - Session that owns the retained objects.
   * @param group - Object-group name to release.
   */
  releaseObjectGroup(sessionId: ClientRuntimeSessionId, group: string): void {
    this.sessions.get(sessionId)?.releaseObjectGroup(group)
  }

  /**
   * Serialize one Console call for a specific DevTools Runtime session.
   * @param sessionId - Session receiving the Console event.
   * @param type - Console API operation.
   * @param values - Original arguments from the page call.
   * @param timestamp - Epoch timestamp in milliseconds.
   * @param stackTrace - Browser call frames captured before deferred delivery.
   * @returns A wire-safe event whose object handles belong only to this session.
   */
  consoleEvent(
    sessionId: ClientRuntimeSessionId,
    type: RuntimeConsoleType,
    values: readonly unknown[],
    timestamp: number,
    stackTrace?: RuntimeStackTrace,
  ): RuntimeConsoleBackendEvent<ClientRemoteObjectHandle> | undefined {
    const session = this.session(sessionId)
    const allocation = session.beginAllocation()
    try {
      const event: RuntimeConsoleBackendEvent<ClientRemoteObjectHandle> = {
        type: 'console-api',
        event: {
          type,
          arguments: session.serializeAll(values, 'console', allocation),
          timestamp,
          ...(stackTrace === undefined ? {} : { stackTrace }),
        },
      }
      if (!isJsonValue(event) || jsonByteLength(event) + 4_096 > this.limits.maxResponseBytes) {
        session.rollback(allocation)
        return undefined
      }
      session.commitAllocation(allocation)
      return event
    } catch (error) {
      session.rollback(allocation)
      throw error
    }
  }

  /**
   * Serialize one uncaught Client exception for a DevTools Runtime session.
   * @param sessionId - Session receiving the exception event.
   * @param error - Thrown or rejected value.
   * @param timestamp - Epoch timestamp in milliseconds.
   * @param stackTrace - Browser call frames attached to the failure.
   * @returns A wire-safe exception event.
   */
  exceptionEvent(
    sessionId: ClientRuntimeSessionId,
    error: unknown,
    timestamp: number,
    stackTrace?: RuntimeStackTrace,
  ): RuntimeConsoleBackendEvent<ClientRemoteObjectHandle> | undefined {
    const session = this.session(sessionId)
    const allocation = session.beginAllocation()
    try {
      const event: RuntimeConsoleBackendEvent<ClientRemoteObjectHandle> = {
        type: 'exception',
        event: {
          timestamp,
          details: session.describeException(error, 'console', stackTrace, allocation),
        },
      }
      if (!isJsonValue(event) || jsonByteLength(event) + 4_096 > this.limits.maxResponseBytes) {
        session.rollback(allocation)
        return undefined
      }
      session.commitAllocation(allocation)
      return event
    } catch (serializationError) {
      session.rollback(allocation)
      throw serializationError
    }
  }

  /** Release all sessions when a source generation ends or reconnects. */
  reset(): void {
    this.responseAllocations.clear()
    for (const session of this.sessions.values()) session.close()
    this.sessions.clear()
  }

  private session(sessionId: ClientRuntimeSessionId): ClientRuntimeSession {
    let session = this.sessions.get(sessionId)
    if (session === undefined) {
      session = new ClientRuntimeSession(
        this.limits.maxObjectsPerSession,
        this.limits.maxPropertiesPerResult,
        this.resolveScript,
      )
      this.sessions.set(sessionId, session)
    }
    return session
  }
}

class ClientRuntimeSession {
  private readonly objects: ClientObjectStore

  constructor(
    maxObjects: number,
    private readonly maxProperties: number,
    private readonly resolveScript: ClientScriptKeyResolver,
  ) {
    this.objects = new ClientObjectStore(maxObjects)
  }

  beginAllocation(): ClientObjectAllocation {
    return this.objects.beginAllocation()
  }

  commitAllocation(allocation: ClientObjectAllocation): void {
    this.objects.commitAllocation(allocation)
  }

  rollback(allocation: ClientObjectAllocation): void {
    this.objects.rollback(allocation)
  }

  async execute(
    command: ClientRuntimeCommand,
    allocation: ClientObjectAllocation,
    signal?: AbortSignal,
  ): Promise<ClientRuntimeResult> {
    switch (command.op) {
      case 'evaluate':
        return { op: command.op, completion: await this.evaluate(command, allocation, signal) }
      case 'get-properties': {
        const result = getClientProperties(this.objects, command, this.maxProperties, allocation)
        return { op: command.op, ...result }
      }
      case 'call-function':
        return { op: command.op, completion: await this.callFunction(command, allocation, signal) }
      case 'await-promise':
        return { op: command.op, completion: await this.awaitPromise(command, allocation, signal) }
      case 'release-object':
        this.objects.release(command.handle)
        return { op: command.op }
      case 'release-object-group':
        this.releaseObjectGroup(command.objectGroup)
        return { op: command.op }
      case 'global-lexical-scope-names':
        return { op: command.op, names: [] }
      default:
        return assertNever(command)
    }
  }

  close(): void {
    this.objects.clear()
  }

  releaseObjectGroup(group: string): void {
    this.objects.releaseGroup(group)
  }

  serializeAll(
    values: readonly unknown[],
    group: string,
    allocation: ClientObjectAllocation,
  ): ClientRuntimeRemoteObject[] {
    return values.map(value => this.objects.serialize(value, { group, generatePreview: true }, allocation))
  }

  describeException(
    error: unknown,
    group: string | undefined,
    stackTrace?: RuntimeStackTrace,
    allocation?: ClientObjectAllocation,
  ): ClientRuntimeExceptionDetails {
    const options = { ...(group === undefined ? {} : { group }) }
    const resolvedStackTrace = stackTrace ?? clientErrorStack(error, this.resolveScript)
    const firstFrame = resolvedStackTrace?.callFrames[0]
    return {
      text: 'Uncaught',
      lineNumber: firstFrame?.lineNumber ?? 0,
      columnNumber: firstFrame?.columnNumber ?? 0,
      ...(firstFrame === undefined ? clientUrl() : { url: firstFrame.url }),
      ...(resolvedStackTrace === undefined ? {} : { stackTrace: resolvedStackTrace }),
      exception: this.objects.serialize(error, options, allocation),
    }
  }

  private async evaluate(
    command: Extract<ClientRuntimeCommand, { op: 'evaluate' }>,
    allocation: ClientObjectAllocation,
    signal?: AbortSignal,
  ): Promise<ClientRuntimeCompletion> {
    let value: unknown
    try {
      value = globalThis.eval(command.expression) as unknown
      if (command.awaitPromise === true) value = await awaitWithCancellation(value, signal, command.timeoutMs)
    } catch (error) {
      if (error instanceof ClientRuntimeExecutionError) throw error
      return this.exception(error, command.objectGroup, allocation)
    }
    return this.completion(
      value,
      allocation,
      command.objectGroup,
      command.generatePreview,
      command.returnByValue,
    )
  }

  private async callFunction(
    command: Extract<ClientRuntimeCommand, { op: 'call-function' }>,
    allocation: ClientObjectAllocation,
    signal?: AbortSignal,
  ): Promise<ClientRuntimeCompletion> {
    const receiver = command.receiver === undefined ? globalThis : this.objects.get(command.receiver)
    const inheritedGroup = command.receiver === undefined ? undefined : this.objects.group(command.receiver)
    const group = command.objectGroup ?? inheritedGroup
    const args = (command.arguments ?? []).map(argument => this.resolveArgument(argument))
    let value: unknown
    try {
      const fn: unknown = globalThis.eval(`(${command.functionDeclaration}\n)`)
      if (typeof fn !== 'function') throw new TypeError('functionDeclaration did not evaluate to a function')
      value = Reflect.apply(fn, receiver, args)
      if (command.awaitPromise === true) value = await awaitWithCancellation(value, signal)
    } catch (error) {
      if (error instanceof ClientRuntimeExecutionError) throw error
      return this.exception(error, group, allocation)
    }
    return this.completion(value, allocation, group, command.generatePreview, command.returnByValue)
  }

  private async awaitPromise(
    command: Extract<ClientRuntimeCommand, { op: 'await-promise' }>,
    allocation: ClientObjectAllocation,
    signal?: AbortSignal,
  ): Promise<ClientRuntimeCompletion> {
    const group = this.objects.group(command.promise)
    let value: unknown
    try {
      value = await awaitWithCancellation(this.objects.get(command.promise), signal)
    } catch (error) {
      if (error instanceof ClientRuntimeExecutionError) throw error
      return this.exception(error, group, allocation)
    }
    return this.completion(value, allocation, group, command.generatePreview, command.returnByValue)
  }

  private resolveArgument(argument: ClientCallArgument): unknown {
    switch (argument.kind) {
      case 'value': return argument.value
      case 'object': return this.objects.get(argument.handle)
      case 'undefined': return undefined
      case 'unserializable': return parseUnserializable(argument.value)
      default: return assertNever(argument)
    }
  }

  private exception(
    error: unknown,
    group: string | undefined,
    allocation: ClientObjectAllocation,
  ): ClientRuntimeCompletion {
    const options = { ...(group === undefined ? {} : { group }) }
    const details = this.describeException(error, group, undefined, allocation)
    return { result: this.objects.serialize(error, options, allocation), exceptionDetails: details }
  }

  private completion(
    value: unknown,
    allocation: ClientObjectAllocation,
    group: string | undefined,
    generatePreview: boolean | undefined,
    returnByValue: boolean | undefined,
  ): ClientRuntimeCompletion {
    return {
      result: this.objects.serialize(value, {
        ...(group === undefined ? {} : { group }),
        ...(generatePreview === undefined ? {} : { generatePreview }),
        ...(returnByValue === undefined ? {} : { returnByValue }),
      }, allocation),
    }
  }
}

function responseFrame(
  request: ClientRuntimeRequestFrame,
  outcome: ClientRuntimeResponseFrame['outcome'],
): ClientRuntimeResponseFrame {
  return {
    v: INSPECTOR_PROTOCOL_VERSION,
    t: 'client-runtime/response',
    sourceId: request.sourceId,
    generation: request.generation,
    sessionId: request.sessionId,
    requestId: request.requestId,
    outcome,
  }
}

function runtimeError(error: unknown): ClientRuntimeError {
  const code = error instanceof ClientRuntimeExecutionError ? error.code : 'internal-error'
  const message = error instanceof Error ? error.message : String(error)
  return { code, message: message.slice(0, MAX_RUNTIME_ERROR_MESSAGE_LENGTH) }
}

function parseUnserializable(value: string): unknown {
  if (value === 'NaN') return Number.NaN
  if (value === 'Infinity') return Number.POSITIVE_INFINITY
  if (value === '-Infinity') return Number.NEGATIVE_INFINITY
  if (value === '-0') return -0
  if (/^-?(?:0|[1-9]\d*)n$/u.test(value)) return BigInt(value.slice(0, -1))
  throw new ClientRuntimeExecutionError('invalid-request', `Unsupported unserializable value ${JSON.stringify(value)}`)
}

function clientUrl(): { readonly url?: string } {
  const location: unknown = Reflect.get(globalThis, 'location')
  if (typeof location !== 'object' || location === null) return {}
  const href: unknown = Reflect.get(location, 'href')
  return typeof href === 'string' ? { url: href } : {}
}

async function awaitWithCancellation(
  value: unknown,
  signal: AbortSignal | undefined,
  timeoutMs?: number,
): Promise<unknown> {
  if (signal?.aborted === true) throw new ClientRuntimeExecutionError('timeout', 'Client Runtime request was canceled')
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    const limits: Promise<never>[] = []
    if (timeoutMs !== undefined) {
      limits.push(new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new ClientRuntimeExecutionError('timeout', `Client evaluation exceeded ${String(timeoutMs)}ms`))
        }, timeoutMs)
      }))
    }
    if (signal !== undefined) {
      limits.push(new Promise<never>((_resolve, reject) => {
        onAbort = () => { reject(new ClientRuntimeExecutionError('timeout', 'Client Runtime request was canceled')) }
        signal.addEventListener('abort', onAbort, { once: true })
      }))
    }
    return await Promise.race([Promise.resolve(value), ...limits])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected Client Runtime variant: ${JSON.stringify(value)}`)
}
