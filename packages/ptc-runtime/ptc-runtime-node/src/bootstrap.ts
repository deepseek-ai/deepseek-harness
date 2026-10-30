/**
 * Output capture, result encoding, and host binding proxies over the process channel.
 * @module @deepseek-ai/dsh-ptc-runtime-node/src/bootstrap
 */

import { inspect, types } from 'node:util'
import type { HostMethods, ProgramResult, ProgramBootData } from './protocol.ts'
import { jsonStringBytesUpTo, jsonValueBytesUpTo, truncateJsonStringBytes } from './output-json.ts'
import { decodePtcJsonWire, encodePtcJsonWire, snapshotPtcJsonValue } from './json-wire.ts'

const CapturedError = Error
const isNativeError = types.isNativeError
const capturedObjectCreate = Object.create
const capturedObjectDefineProperty = Object.defineProperty

/** Define one public binding-error field without consulting mutable globals or descriptor prototypes. */
function defineBindingErrorField(error: Error, key: string, value: string): void {
  const attributes = capturedObjectCreate(null) as PropertyDescriptor
  attributes.enumerable = true
  attributes.value = value
  capturedObjectDefineProperty(error, key, attributes)
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
 * a sink as each item lands (the real sink sends text to the host eagerly,
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
export function makeConsoleShim(logs: Pick<LogBuffer, 'push'>): Record<(typeof CONSOLE_LEVELS)[number], (...args: unknown[]) => void> {
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
export function captureStreamWrites(logs: Pick<LogBuffer, 'push'>, stream: PatchableStream): () => void {
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
 * Prepare the program's completion value for the run result. Only lossless
 * JSON crosses, and a value that does not fit the remaining combined outer
 * budget reports `output-limit`; the host revalidates hostile traffic and
 * remains authoritative for native pipe writes the program shim cannot observe.
 *
 * @param value - the program's completion value.
 * @param remainingOutputBytes - exact bytes left after captured logs.
 * @param maxOutputBytes - the configured cap named in an overflow diagnostic.
 * @returns the result fragment: `{}` for `undefined`, else a flat wire `{ value }`.
 */
export function prepareCompletion(
  value: unknown,
  remainingOutputBytes: number,
  maxOutputBytes: number = remainingOutputBytes,
): ProgramResult {
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
function outputLimit(maxOutputBytes: number): ProgramResult {
  return { error: { kind: 'output-limit', message: `outer output exceeded ${maxOutputBytes} bytes` } }
}

/** Admit one bounded failure message or replace it with the fixed overflow diagnostic. */
function prepareFailure(
  kind: 'exception' | 'invalid-output',
  message: string,
  remainingOutputBytes: number,
  maxOutputBytes: number,
): ProgramResult {
  if (jsonStringBytesUpTo(message, remainingOutputBytes) === undefined) return outputLimit(maxOutputBytes)
  return { error: { kind, message } }
}

/**
 * Prepare a thrown program value, including cross-realm errors, without sending
 * an unbounded stack or string across the process channel.
 * @param error - the value thrown by the program.
 * @param remainingOutputBytes - exact bytes left after captured logs.
 * @param maxOutputBytes - the configured cap named in an overflow diagnostic.
 * @returns a bounded exception or fixed output-limit fragment.
 */
export function prepareException(
  error: unknown,
  remainingOutputBytes: number,
  maxOutputBytes: number = remainingOutputBytes,
): ProgramResult {
  let message: string
  try {
    const detail: unknown = isNativeError(error) ? error.stack ?? error.message : error
    message = typeof detail === 'string' ? detail : String(detail)
  } catch {
    message = 'program threw an unrenderable value'
  }
  return prepareFailure('exception', message, remainingOutputBytes, maxOutputBytes)
}

/** Constructor type for one program-visible binding rejection class. */
export type BindingErrorConstructor = new (memberName: string, message: string) => Error

/**
 * Materialize the real error constructor declared by one namespace.
 * @param descriptor - program-global class name and member-name property.
 * @returns the constructor injected into the program and used for rejections.
 */
export function makeBindingErrorClass(
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
 * Build null-prototype binding globals with namespace-specific rejection classes.
 * @param data - Namespace declarations injected into the program.
 * @param host - Evaluation-scoped remote binding calls.
 * @param errorClasses - Constructors shared with program globals, resolved per invocation.
 * @returns One namespace object per declaration; arguments and results must be lossless JSON.
 */
export function makeNamespaces(
  data: Pick<ProgramBootData, 'namespaces'>,
  host: Pick<HostMethods, 'invoke'>,
  errorClasses: Pick<ReadonlyMap<string, BindingErrorConstructor>, 'get'>,
): Record<string, unknown>[] {
  return data.namespaces.map(({ global, names }) => {
    const namespace = Object.create(null) as Record<string, unknown>
    for (const name of names) {
      Object.defineProperty(namespace, name, {
        enumerable: true,
        value: async (args: unknown): Promise<unknown> => {
          const errorClass = errorClasses.get(global)
          try {
            let detached: ReturnType<typeof snapshotPtcJsonValue>
            try { detached = snapshotPtcJsonValue(args) } catch {
              // Model-defined getters can fail while arguments are detached.
              detached = undefined
            }
            if (detached === undefined) throw new CapturedError('binding arguments must be lossless JSON')
            const result = decodePtcJsonWire(await host.invoke(global, name, encodePtcJsonWire(detached)))
            if (result === undefined) throw new CapturedError('binding resolution must be lossless JSON')
            return result
          } catch (error: unknown) {
            throw bindingFailure(errorClass, name, error instanceof CapturedError ? error.message : String(error))
          }
        },
      })
    }
    return namespace
  })
}
