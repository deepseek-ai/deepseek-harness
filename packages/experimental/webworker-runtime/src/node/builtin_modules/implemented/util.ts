/**
 * `node:util` for the worker: the members harness code actually imports. Node's
 * inspect output is only used in diagnostics, so a JSON-shaped rendering is
 * enough; `promisify` follows Node's error-first callback convention exactly
 * because zlib-style APIs are wrapped with it at module scope.
 */

/**
 * Wrap an error-first callback function as a promise-returning one.
 * @param fn - callback-style function.
 * @returns the promise-returning wrapper.
 */
export function promisify<A extends unknown[], R>(
  fn: (...args: [...A, (error: unknown, value: R) => void]) => void,
): (...args: A) => Promise<R> {
  return (...args: A) => new Promise<R>((resolve, reject) => {
    fn(...args, (error: unknown, value: R) => {
      if (error !== null && error !== undefined) reject(error instanceof Error ? error : new Error(inspect(error)))
      else resolve(value)
    })
  })
}

/**
 * Wrap a promise-returning function as an error-first callback one.
 * @param fn - promise-returning function.
 * @returns the callback-style wrapper.
 */
export function callbackify<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
): (...args: [...A, (error: unknown, value?: R) => void]) => void {
  return (...args) => {
    const callback = args.at(-1) as (error: unknown, value?: R) => void
    const rest = args.slice(0, -1) as A
    fn(...rest).then((value) => { callback(null, value) }, (error: unknown) => { callback(error) })
  }
}

/**
 * Diagnostic rendering of a value.
 * @param value - the value.
 * @returns a readable one-line rendering.
 */
export function inspect(value: unknown): string {
  if (typeof value === 'string') return `'${value}'`
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  try {
    // `JSON.stringify` is typed as returning a string but answers undefined for
    // undefined, functions, and symbols.
    const rendered = JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? item.toString() : item) as string | undefined
    return rendered ?? String(value)
  } catch {
    // Cyclic or otherwise unserializable values still need a rendering.
    return String(value)
  }
}

/**
 * printf-style formatting for the `%s`/`%d`/`%j`/`%o` placeholders Node supports.
 * @param template - format string, or any value when used without placeholders.
 * @param args - substitution values.
 * @returns the formatted string.
 */
export function format(template: unknown, ...args: unknown[]): string {
  if (typeof template !== 'string') return [template, ...args].map(value => inspect(value)).join(' ')
  let index = 0
  const substituted = template.replaceAll(/%[sdifjoO%]/g, (token) => {
    if (token === '%%') return '%'
    if (index >= args.length) return token
    const value = args[index++]
    if (token === '%d' || token === '%i') return String(Number(value))
    if (token === '%f') return String(Number(value))
    if (token === '%s') return typeof value === 'string' ? value : inspect(value)
    return inspect(value)
  })
  const rest = args.slice(index)
  return rest.length === 0 ? substituted : `${substituted} ${rest.map(value => inspect(value)).join(' ')}`
}

/**
 * Structural deep equality over own enumerable properties, as `isDeepStrictEqual` defines it for plain data.
 * @param left - first value.
 * @param right - second value.
 * @returns true when both sides are structurally identical.
 */
export function isDeepStrictEqual(left: unknown, right: unknown): boolean {
  /* jscpd:ignore-start -- the walk necessarily matches credentials-local's
     sameJsonValue (both are structural equality over plain data); a shared
     helper would couple the self-contained builtin face packed into the worker
     image to a host package. */
  if (Object.is(left, right)) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every(key => Object.hasOwn(right, key)
    && isDeepStrictEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]))
  /* jscpd:ignore-end */
}

/** Runtime type predicates (`node:util/types`), checked against the Node module of that name. */
export const types = {
  isPromise: (value: unknown): value is Promise<unknown> => value instanceof Promise
    || (typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'),
  isDate: (value: unknown): value is Date => value instanceof Date,
  isRegExp: (value: unknown): value is RegExp => value instanceof RegExp,
  // Node counts only the integer and float views, so a DataView answers false.
  isTypedArray: (value: unknown): value is NodeJS.TypedArray => ArrayBuffer.isView(value) && !(value instanceof DataView),
} satisfies Partial<typeof import('node:util/types')>

/**
 * CLI argument parsing has no caller inside the worker host.
 * @returns Never — it throws naming the unavailable member.
 */
export function parseArgs(): never {
  throw new Error('web-preview: node:util.parseArgs is not available in the worker host')
}

/**
 * Deprecation wrappers pass the function through unchanged.
 * @param fn - the function a caller wanted wrapped.
 * @returns The same function, unwrapped.
 */
export function deprecate<F>(fn: F): F {
  return fn
}

/** Text decoder class, as `node:util` re-exports it. */
const TextDecoderClass = globalThis.TextDecoder

/** Text encoder class, as `node:util` re-exports it. */
const TextEncoderClass = globalThis.TextEncoder

export { TextDecoderClass as TextDecoder, TextEncoderClass as TextEncoder }

/** CommonJS interop marker: the worker loader hands `default` to default imports (see ./builtins.ts). */
export const __esModule = true

/**
 * The `node:util` declarations this module stands in for. Five members keep this
 * module's own types: `promisify`, `callbackify`, and `inspect` are the plain
 * conversions the harness calls, without Node's overload ladders and the
 * `custom`/`styles`/`defaultOptions` members hung off them; `types` publishes the
 * four predicates in use rather than Node's forty; and `TextDecoder` is the DOM
 * class, whose `decode` input union the Node declaration does not accept.
 */
type NodeFace = Partial<Omit<typeof import('node:util'), 'promisify' | 'callbackify' | 'inspect' | 'types' | 'TextDecoder'>>
  & Record<'promisify' | 'callbackify' | 'inspect' | 'types' | 'TextDecoder', unknown>

/** CommonJS default export: the members `require()` hands a caller of this module. */
export default {
  promisify, callbackify, inspect, format, isDeepStrictEqual, types, parseArgs, deprecate,
  TextDecoder: TextDecoderClass, TextEncoder: TextEncoderClass,
} satisfies NodeFace
