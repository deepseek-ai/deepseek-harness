/**
 * Output capture, result encoding, and host binding proxies over the process channel.
 * @module @deepseek-ai/dsh-ptc-runtime-node/src/bootstrap
 */

import { inspect, types, type InspectOptions } from 'node:util'
import type { PtcJsonValue } from '@deepseek-ai/dsh-ptc-runtime'
import type { HostMethods, ProgramResult, ProgramBootData } from './protocol.ts'
import { jsonStringBytesUpTo, jsonValueBytesUpTo, truncateJsonStringBytes } from './output-json.ts'
import { decodePtcJsonWire, encodePtcJsonWire, snapshotPtcJsonValue, type PtcImageWire } from './json-wire.ts'

const CapturedError = Error
const { isNativeError, isProxy } = types
const {
  create: capturedObjectCreate,
  defineProperty: capturedObjectDefineProperty,
  getOwnPropertyDescriptor: capturedObjectGetOwnPropertyDescriptor,
  getPrototypeOf: capturedObjectGetPrototypeOf,
  is: capturedObjectIs,
} = Object
const capturedOwnKeys = Reflect.ownKeys

/** Text and the original JSON data associated with one binding result. */
export interface BindingInspection {
  /** Detached data used to detect changes before selecting the text. */
  snapshot: PtcJsonValue
  /** Host-authored text for direct inspection of the unchanged value. */
  text: string
}

/** Compare data properties without invoking accessors or traversing model-created proxies. */
function matchesInspection(value: object, snapshot: PtcJsonValue, images: Pick<WeakMap<object, string>, 'get'>): boolean {
  const pending: [unknown, PtcJsonValue][] = [[value, snapshot]]
  let size = 1
  while (size > 0) {
    const pair = pending[--size] as [unknown, PtcJsonValue]
    const current = pair[0]
    const original = pair[1]
    if (capturedObjectIs(current, original)) continue
    if (current === null || typeof current !== 'object' || original === null || typeof original !== 'object'
      || isProxy(current) || images.get(original) !== undefined
      || capturedObjectGetPrototypeOf(current) !== capturedObjectGetPrototypeOf(original)) return false
    const keys = capturedOwnKeys(current)
    if (keys.length !== capturedOwnKeys(original).length) return false
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index] as string | symbol
      const actual = capturedObjectGetOwnPropertyDescriptor(current, key) as PropertyDescriptor
      const expected = capturedObjectGetOwnPropertyDescriptor(original, key)
      if (!expected || !('value' in actual) || actual.enumerable !== expected.enumerable) return false
      const slot = capturedObjectCreate(null) as PropertyDescriptor
      slot.value = [actual.value, expected.value as PtcJsonValue]
      slot.configurable = true
      capturedObjectDefineProperty(pending, size++, slot)
    }
  }
  return true
}

/** Node formatting options shared with the runtime-owned Image hook. */
export interface ImageInspectOptions extends InspectOptions {
  /** Primitive token retained by Node when passing options to a formatter in another VM context. */
  ptcImageCollector?: symbol
}

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
 * the fitting prefix and reports truncation once; execution continues.
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

  /** Discard further output after the host exhausts the combined text and image budget. */
  discard(): void { this.truncated = true }

  /** Whether captured text has exceeded the shared output budget. */
  get overflowed(): boolean { return this.truncated }
}

/**
 * Render arguments without depth, array-length or string-length previews and emit registered images in order.
 * @param logs - the buffer every rendered line is pushed into.
 * @param images - Image identities owned by the execution process.
 * @param emitImage - Emits a registered image in the current evaluation.
 * @param inspections - Process-owned text associated with original binding result identities.
 * @returns The program's inspect function and its matching Image collection hook.
 * @throws If object formatting fails; preceding arguments remain visible.
 */
export function makeInspect(
  logs: Pick<LogBuffer, 'push' | 'overflowed'>, images: Pick<WeakMap<object, string>, 'get'>, emitImage: (id: string) => void,
  inspections?: Pick<WeakMap<object, BindingInspection>, 'get'>,
): {
  inspect: (...args: unknown[]) => void
  collectImage: (image: object, options: ImageInspectOptions) => void
} {
  const collectors = new Map<symbol, string[]>()
  const programInspect = (...args: unknown[]): void => {
    const pending: string[] = []
    const flush = (): void => {
      if (pending.length === 0) return
      logs.push(pending.join(' ') + '\n')
      pending.length = 0
    }
    for (const arg of args) {
      if (logs.overflowed) break
      const inspection = arg !== null && typeof arg === 'object' ? inspections?.get(arg) : undefined
      if (inspection !== undefined && matchesInspection(arg as object, inspection.snapshot, images)) {
        flush()
        if (inspection.text.length > 0) logs.push(inspection.text.endsWith('\n') ? inspection.text : inspection.text + '\n')
        continue
      }
      const directImage = arg !== null && typeof arg === 'object' ? images.get(arg) : undefined
      if (directImage !== undefined) {
        flush()
        emitImage(directImage)
        continue
      }
      const nested: string[] = []
      const collector = Symbol()
      const options: ImageInspectOptions = {
        depth: null, maxArrayLength: null, maxStringLength: null,
        ptcImageCollector: collector,
      }
      collectors.set(collector, nested)
      try {
        pending.push(typeof arg === 'string' ? arg : inspect(arg, options))
      } catch (error: unknown) {
        flush()
        throw error
      } finally {
        collectors.delete(collector)
      }
      if (nested.length === 0) continue
      flush()
      for (const id of nested) emitImage(id)
    }
    flush()
    if (args.length === 0) logs.push('\n')
  }
  return {
    inspect: programInspect,
    collectImage(image, options) {
      const id = images.get(image)
      if (id !== undefined && options.ptcImageCollector !== undefined) collectors.get(options.ptcImageCollector)?.push(id)
    },
  }
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

/**
 * Prepare the program's completion value for the run result. Only lossless
 * JSON crosses, and a value that does not fit even without captured output
 * reports `output-limit`; the host revalidates hostile traffic and
 * remains authoritative for native pipe writes the program shim cannot observe.
 *
 * @param value - the program's completion value.
 * @param availableBytes - bytes available to the completion or diagnostic.
 * @param maxOutputBytes - the configured cap named in an overflow diagnostic.
 * @returns the result fragment: `{}` for `undefined`, else a flat wire `{ value }`.
 */
export function prepareCompletion(
  value: unknown,
  availableBytes: number,
  maxOutputBytes: number = availableBytes,
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
      availableBytes,
    )
  }
  if (jsonValueBytesUpTo(snapshot, availableBytes) === undefined) {
    return { error: { kind: 'output-limit', message: `completion value exceeded ${maxOutputBytes} bytes` } }
  }
  return { value: encodePtcJsonWire(snapshot) }
}

/** Truncate diagnostic text while preserving its failure kind. */
function prepareFailure(
  kind: 'exception' | 'invalid-output',
  message: string,
  availableBytes: number,
): ProgramResult {
  const retained = truncateJsonStringBytes(message, availableBytes)
  return { error: { kind, message: retained }, ...retained !== message ? { outputTruncated: true } : {} }
}

/**
 * Prepare a thrown program value, including cross-realm errors, without sending
 * an unbounded stack or string across the process channel.
 * @param error - the value thrown by the program.
 * @param availableBytes - bytes available to the completion or diagnostic.
 * @returns a bounded exception preserving its kind and indicating truncated diagnostics.
 */
export function prepareException(
  error: unknown,
  availableBytes: number,
): ProgramResult {
  let message: string
  try {
    const detail: unknown = isNativeError(error) ? error.stack ?? error.message : error
    message = typeof detail === 'string' ? detail : String(detail)
  } catch {
    message = 'program threw an unrenderable value'
  }
  return prepareFailure('exception', message, availableBytes)
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
 * @param inspections - Required process-owned inspection text indexed by decoded result identity.
 * @param decodeImage - Optional decoder for host-issued images; image tokens are rejected when absent.
 * @param isImage - Optional recognition of decoded images; omission restricts inspection snapshots to JSON data.
 * @returns One namespace object per declaration.
 */
export function makeNamespaces(
  data: Pick<ProgramBootData, 'namespaces'>,
  host: Pick<HostMethods, 'invoke'>,
  errorClasses: Pick<ReadonlyMap<string, BindingErrorConstructor>, 'get'>,
  inspections: Pick<WeakMap<object, BindingInspection>, 'set'>,
  decodeImage?: (wire: PtcImageWire) => PtcJsonValue,
  isImage?: (value: object) => boolean,
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
            const resolution: unknown = await host.invoke(global, name, encodePtcJsonWire(detached))
            if (resolution === null || typeof resolution !== 'object' || Array.isArray(resolution) || !('value' in resolution)) {
              throw new CapturedError('binding resolution must be lossless JSON')
            }
            const inspection = 'inspection' in resolution ? resolution.inspection : undefined
            if (inspection !== undefined && typeof inspection !== 'string') throw new CapturedError('binding resolution must be lossless JSON')
            const result = decodePtcJsonWire(resolution.value, decodeImage)
            if (result === undefined) throw new CapturedError('binding resolution must be lossless JSON')
            if (inspection !== undefined) {
              if (result === null || typeof result !== 'object') throw new CapturedError('binding inspection requires an object or array')
              const snapshot = snapshotPtcJsonValue(result, isImage)
              if (snapshot === undefined) throw new CapturedError('binding inspection requires lossless JSON data')
              inspections.set(result, { snapshot, text: inspection })
            }
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
