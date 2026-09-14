/**
 * Program evaluation, output capture, and host binding proxies over the process channel.
 * @module @deepseek-ai/dsh-ptc-runtime-node/src/bootstrap
 */

import { inspect } from 'node:util'
import type { DoneMessage, ReplyMessage, ProgramBootData, ProgramToHost } from './protocol.ts'
import { jsonStringBytesUpTo, jsonValueBytesUpTo, truncateJsonStringBytes } from './output-json.ts'
import { decodePtcJsonWire, encodePtcJsonWire, snapshotPtcJsonValue } from './json-wire.ts'

const CapturedError = Error
const capturedObjectCreate = Object.create
const capturedObjectDefineProperty = Object.defineProperty

/** Define one public binding-error field without consulting mutable globals or descriptor prototypes. */
function defineBindingErrorField(error: Error, key: string, value: string): void {
  const attributes = capturedObjectCreate(null) as PropertyDescriptor
  attributes.enumerable = true
  attributes.value = value
  capturedObjectDefineProperty(error, key, attributes)
}

/** Program messages and host replies transported by the private process channel. */
export interface BootstrapPort {
  postMessage(message: ProgramToHost): void
  on(event: 'message', listener: (message: ReplyMessage) => void): void
}

/**
 * A writable stream's `write` slot, as the bootstrap patches it (see
 * {@link captureStreamWrites}). Method-typed so the real
 * `process.stdout`/`process.stderr` (narrower chunk parameters) remain
 * assignable.
 */
export interface PatchableStream {
  write(chunk: unknown, ...rest: unknown[]): boolean
}

/**
 * Ordered text capture under the shared outer JSON-byte budget, delivered to
 * a sink as each item lands (the real sink streams text over the port eagerly,
 * so captured output survives a mid-run termination). It includes the log
 * array syntax and string escaping in its accounting. Once exhausted it emits
 * the fitting prefix and reports the limit once; the host turns that condition
 * into an explicit `output-limit` run failure.
 */
export class LogBuffer {
  private bytes = 2 // JSON serialization of the empty logs array: []
  private entries = 0
  private truncated = false
  // Explicit fields, not constructor parameter properties: this module loads
  // under Node's native strip-only mode, which rejects non-erasable syntax —
  // and parameter properties are non-erasable.
  private readonly sink: (text: string) => void
  private readonly onLimit: () => void
  private readonly maxBytes: number

  constructor(maxBytes: number, sink: (text: string) => void, onLimit: () => void = () => {}) {
    this.maxBytes = maxBytes
    this.sink = sink
    this.onLimit = onLimit
  }

  /**
   * Emit text to the sink, charging it against the budget (drops + marks once exhausted).
   * @param text - the captured text to deliver.
   */
  push(text: string): void {
    if (this.truncated) return
    const separatorBytes = this.entries > 0 ? 1 : 0
    const availableBytes = this.maxBytes - this.bytes - separatorBytes
    const stringBytes = jsonStringBytesUpTo(text, availableBytes)
    if (stringBytes === undefined) {
      this.truncated = true
      const prefix = truncateJsonStringBytes(text, availableBytes)
      if (prefix.length > 0) {
        const prefixBytes = jsonStringBytesUpTo(prefix, availableBytes)
        /* v8 ignore next -- truncateJsonStringBytes guarantees the returned prefix fits. */
        if (prefixBytes === undefined) throw new CapturedError('program output ledger produced an oversized log prefix')
        this.bytes += prefixBytes + separatorBytes
        this.entries += 1
        this.sink(prefix)
      }
      this.onLimit()
      return
    }
    this.bytes += stringBytes + separatorBytes
    this.entries += 1
    this.sink(text)
  }

  /** Remaining exact JSON-byte budget for the completion value or failure message. */
  remainingOutputBytes(): number {
    return this.maxBytes - this.bytes
  }
}

/** The five console methods the shim captures, in the seam's level vocabulary. */
const CONSOLE_LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const

/**
 * A `console` replacement whose five leveled methods render their arguments
 * `util.inspect`-style (matching real console formatting closely enough for
 * a model to recognize its own output) into the buffer. Only these five
 * exist — the program gets a deliberately small console, not Node's full
 * console API.
 * @param logs - the buffer every rendered line is pushed into.
 * @returns the five-method console object handed to the program.
 */
export function makeConsoleShim(logs: LogBuffer): Record<(typeof CONSOLE_LEVELS)[number], (...args: unknown[]) => void> {
  const render = (args: unknown[]): string =>
    args.map(arg => typeof arg === 'string' ? arg : inspect(arg, INSPECT_OPTIONS)).join(' ')
  const shim = Object.create(null) as Record<(typeof CONSOLE_LEVELS)[number], (...args: unknown[]) => void>
  for (const level of CONSOLE_LEVELS) {
    shim[level] = (...args: unknown[]) => { logs.push(render(args)) }
  }
  return shim
}

/**
 * Redirect a stream's `write` into the log buffer (the program-visible
 * `process.stdout`/`process.stderr` in the Node child), so raw writes land in emission order
 * alongside console output instead of racing down a pipe. It preserves Node's optional callback
 * contract: the callback runs asynchronously after admission, even when the log budget drops
 * the write.
 *
 * @param logs - the buffer captured writes are pushed into.
 * @param stream - the stream whose `write` slot is patched.
 * @returns the restore function (the in-process tests un-patch; the real
 *   child never needs to).
 */
export function captureStreamWrites(logs: LogBuffer, stream: PatchableStream): () => void {
  // The slot's VALUE is stored for restore and reassigned — never invoked
  // detached, so the unbound-method concern does not apply.
  // oxlint-disable-next-line typescript/unbound-method
  const original = stream.write
  stream.write = (chunk: unknown, ...rest: unknown[]): boolean => {
    logs.push(typeof chunk === 'string' ? chunk : String(chunk))
    // Node's optional-encoding shape: the callback is whichever of the next
    // two positions holds a function (a non-function there is the encoding).
    const callback = [rest[0], rest[1]].find(
      (arg): arg is (error?: Error | null) => void => typeof arg === 'function',
    )
    if (callback) queueMicrotask(() => { callback(null) })
    return true
  }
  return () => { stream.write = original }
}

/** Bounded inspect options: deep enough to be useful, bounded so a pathological value cannot explode the rendering. */
const INSPECT_OPTIONS = { depth: 4, maxArrayLength: 100, maxStringLength: 10_000 } as const

/**
 * Prepare the program's completion value for the done message. Only lossless
 * JSON crosses, and a value that does not fit the remaining combined outer
 * budget reports `output-limit`; the host revalidates hostile traffic and
 * remains authoritative for native pipe writes the program shim cannot observe.
 *
 * @param value - the program's completion value.
 * @param remainingOutputBytes - exact bytes left after captured logs.
 * @param maxOutputBytes - the configured cap named in an overflow diagnostic.
 * @returns the done-message fragment: `{}` for `undefined`, else a flat wire `{ value }`.
 */
export function prepareCompletion(
  value: unknown,
  remainingOutputBytes: number,
  maxOutputBytes: number = remainingOutputBytes,
): Omit<DoneMessage, 'type'> {
  if (value === undefined) return {}
  let snapshot: ReturnType<typeof snapshotPtcJsonValue>
  try {
    snapshot = snapshotPtcJsonValue(value)
  } catch {
    snapshot = undefined
  }
  if (snapshot === undefined) {
    return prepareFailure(
      'invalid-output',
      'program completion must be lossless JSON',
      remainingOutputBytes,
      maxOutputBytes,
    )
  }
  if (jsonValueBytesUpTo(snapshot, remainingOutputBytes) === undefined) {
    return outputLimit(maxOutputBytes)
  }
  return { value: encodePtcJsonWire(snapshot) }
}

/** Build the fixed overflow fragment without carrying rejected variable bytes. */
function outputLimit(maxOutputBytes: number): Omit<DoneMessage, 'type'> {
  return { error: { kind: 'output-limit', message: `outer output exceeded ${maxOutputBytes} bytes` } }
}

/** Admit one bounded failure message or replace it with the fixed overflow diagnostic. */
function prepareFailure(
  kind: 'exception' | 'invalid-output',
  message: string,
  remainingOutputBytes: number,
  maxOutputBytes: number,
): Omit<DoneMessage, 'type'> {
  if (jsonStringBytesUpTo(message, remainingOutputBytes) === undefined) return outputLimit(maxOutputBytes)
  return { error: { kind, message } }
}

/**
 * Prepare a thrown program value without sending an unbounded stack or
 * string across the process channel.
 * @param error - the value thrown by the program.
 * @param remainingOutputBytes - exact bytes left after captured logs.
 * @param maxOutputBytes - the configured cap named in an overflow diagnostic.
 * @returns a bounded exception or fixed output-limit fragment.
 */
export function prepareException(
  error: unknown,
  remainingOutputBytes: number,
  maxOutputBytes: number = remainingOutputBytes,
): Omit<DoneMessage, 'type'> {
  let message: string
  try {
    const detail: unknown = error instanceof CapturedError ? error.stack ?? error.message : error
    message = typeof detail === 'string' ? detail : String(detail)
  } catch {
    message = 'program threw an unrenderable value'
  }
  return prepareFailure('exception', message, remainingOutputBytes, maxOutputBytes)
}

/** One awaited binding call's settlement handles, keyed by call id in the pending map. */
export interface PendingCall {
  resolve(value: unknown): void
  reject(error: Error): void
}

/** Constructor type for one program-visible binding rejection class. */
export type BindingErrorConstructor = new (memberName: string, message: string) => Error

/**
 * Materialize the real error constructor declared by one namespace.
 * @param descriptor - program-global class name and member-name property.
 * @returns the constructor injected into the program and used for rejections.
 */
function makeBindingErrorClass(
  descriptor: { name: string; memberNameProperty: string },
): BindingErrorConstructor {
  return class BindingCallError extends CapturedError {
    constructor(memberName: string, message: string) {
      super(message)
      defineBindingErrorField(this, 'name', descriptor.name)
      defineBindingErrorField(this, descriptor.memberNameProperty, memberName)
    }
  }
}

/** Create the namespace-specific rejection for one failed binding call. */
function bindingFailure(errorClass: BindingErrorConstructor | undefined, memberName: string, message: string): Error {
  return errorClass ? new errorClass(memberName, message) : new CapturedError(message)
}

/**
 * Build each declared error class once so calls and `instanceof` share constructor identity.
 * @param data - binding namespace declarations from the boot payload.
 * @returns constructors keyed by their owning namespace global.
 */
export function makeBindingErrorClasses(
  data: Pick<ProgramBootData, 'namespaces'>,
): Map<string, BindingErrorConstructor> {
  const classes = new Map<string, BindingErrorConstructor>()
  for (const namespace of data.namespaces) {
    if (namespace.errorClass) classes.set(namespace.global, makeBindingErrorClass(namespace.errorClass))
  }
  return classes
}

/**
 * Route host replies into the pending-call map: each reply settles its call
 * at most once, and a reply for an unknown id (stray, or a duplicate answer
 * to an id already settled) is ignored. Shared wiring between
 * {@link runProgram} and the tests that exercise {@link makeNamespaces}
 * standalone.
 * @param port - the port whose `message` events carry the replies.
 * @param pending - the id-keyed map of unsettled binding calls.
 */
export function wireReplies(port: BootstrapPort, pending: Map<number, PendingCall>): void {
  port.on('message', (message: ReplyMessage) => {
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.ok) {
      const value = decodePtcJsonWire(message.value)
      if (value === undefined) entry.reject(new CapturedError('binding resolution must be lossless JSON'))
      else entry.resolve(value)
    } else {
      entry.reject(new CapturedError(message.message))
    }
  })
}

/**
 * Build the binding namespace objects the program sees: one null-prototype global per
 * namespace, each declared name an own enumerable async function that bridges over the port
 * (`__proto__`/`constructor`/`toString` are ordinary keys, never prototype collisions).
 * Lossy arguments reject before posting; clone failures and host failure
 * replies reject only the corresponding call.
 *
 * @param data - the boot payload's namespace declarations (globals + names).
 * @param port - the port binding calls are posted to.
 * @param pending - the id-keyed map each posted call parks its handles in.
 * @param nextId - the shared mutable id counter (program-issued correlation ids).
 * @param errorClasses - per-namespace constructors shared with program globals.
 * @returns one namespace object per declaration, in declaration order.
 */
export function makeNamespaces(
  data: Pick<ProgramBootData, 'namespaces'>,
  port: BootstrapPort,
  pending: Map<number, PendingCall>,
  nextId: { value: number },
  errorClasses: Map<string, BindingErrorConstructor> = makeBindingErrorClasses(data),
): Record<string, unknown>[] {
  return data.namespaces.map(({ global, names }) => {
    const errorClass = errorClasses.get(global)
    const namespace = Object.create(null) as Record<string, unknown>
    for (const name of names) {
      Object.defineProperty(namespace, name, {
        enumerable: true,
        value: (args: unknown): Promise<unknown> => {
          let detached: ReturnType<typeof snapshotPtcJsonValue>
          try {
            detached = snapshotPtcJsonValue(args)
          } catch {
            detached = undefined
          }
          if (detached === undefined) {
            return Promise.reject(bindingFailure(errorClass, name, 'binding arguments must be lossless JSON'))
          }
          return new Promise((resolve, reject) => {
            const id = nextId.value++
            pending.set(id, {
              resolve,
              reject: (error) => {
                reject(bindingFailure(errorClass, name, error.message))
              },
            })
            try {
              port.postMessage({ type: 'call', id, global, name, args: encodePtcJsonWire(detached) })
            } catch (error: unknown) {
              pending.delete(id)
              const message = `binding arguments must be structured-cloneable: ${error instanceof CapturedError ? error.message : String(error)}`
              reject(bindingFailure(errorClass, name, message))
            }
          })
        },
      })
    }
    return namespace
  })
}

/**
 * Run one strict async-function body, allowing top-level `await` and `return`, and post exactly
 * one terminal {@link DoneMessage}; a thrown program error becomes its `error` field.
 * @param port - host message port or test double.
 * @param data - the boot payload the host sent.
 * @param streams - stdout/stderr objects captured as program logs.
 * @returns after posting the done message.
 */
export async function runProgram(
  port: BootstrapPort,
  data: ProgramBootData,
  streams: { stdout: PatchableStream; stderr: PatchableStream },
): Promise<void> {
  const logs = new LogBuffer(
    data.maxOutputBytes,
    (text) => { port.postMessage({ type: 'log', text }) },
    () => { port.postMessage({ type: 'output-limit' }) },
  )
  captureStreamWrites(logs, streams.stdout)
  captureStreamWrites(logs, streams.stderr)

  const pending = new Map<number, PendingCall>()
  wireReplies(port, pending)

  const nextId = { value: 1 }
  const errorClasses = makeBindingErrorClasses(data)
  const namespaces = makeNamespaces(data, port, pending, nextId, errorClasses)
  const errorClassParameters: string[] = []
  const errorClassValues: BindingErrorConstructor[] = []
  for (const namespace of data.namespaces) {
    if (!namespace.errorClass) continue
    errorClassParameters.push(namespace.errorClass.name)
    const errorClass = errorClasses.get(namespace.global)
    /* v8 ignore next -- makeBindingErrorClasses covers every declaration in the same data. */
    if (!errorClass) throw new CapturedError(`missing binding error class for ${namespace.global}`)
    errorClassValues.push(errorClass)
  }
  const consoleShim = makeConsoleShim(logs)

  let done: DoneMessage
  try {
    // The async function constructor, reached through an instance because
    // `AsyncFunction` is not a global. The program body is strict-mode.
    /* v8 ignore next -- the arrow exists only to reach the AsyncFunction constructor; it is never invoked. */
    const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (...fnArgs: unknown[]) => Promise<unknown>
    const fn = new AsyncFunction(
      ...data.namespaces.map(namespace => namespace.global),
      ...errorClassParameters,
      'console',
      `'use strict';\n${data.code}`,
    )
    const value = await fn(...namespaces, ...errorClassValues, consoleShim)
    done = {
      type: 'done',
      ...prepareCompletion(value, logs.remainingOutputBytes(), data.maxOutputBytes),
    }
  } catch (error: unknown) {
    done = {
      type: 'done',
      ...prepareException(error, logs.remainingOutputBytes(), data.maxOutputBytes),
    }
  }
  port.postMessage(done)
}
