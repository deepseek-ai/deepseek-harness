/**
 * Structural not-implemented stubs: a replaced module must expose every symbol
 * its importers name (a missing CommonJS symbol degrades to `undefined` at call
 * time instead of failing at link time), and every one of those symbols must
 * report exactly what is unavailable when it is finally called. The refusal
 * carries Node's `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` code, so a caller that
 * can run without the feature distinguishes it from other failures.
 */

/**
 * Build a function that throws naming its module and symbol. The refusal is
 * also written to the console before it propagates: callers routinely swallow
 * these errors far from their cause, and the console line is what places the
 * failure while debugging a worker session.
 *
 * `Face` is the Node declaration this stub stands in for, so the replaced module
 * publishes the type its importers compile against. The value is one throwing
 * function whatever that declaration says: a caller reaches the throw before any
 * declared parameter, return value, or `new` result exists, so the assertion
 * below cannot be observed as a lie. It is a function expression rather than an
 * arrow because a stub standing in for a class must refuse under `new` too, and
 * an arrow has no construct behavior to reach.
 * @param module - module specifier being stubbed.
 * @param symbol - exported symbol name.
 * @returns the throwing stand-in, typed as the member it replaces.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- only the return position carries the Node declaration
export function notImplementedFail<Face = (...args: never[]) => never>(module: string, symbol: string): Face {
  return (function refuse(): never {
    throw notAvailableError(module, symbol)
  }) as Face
}

/** Node's standard code for a feature the running platform cannot provide. */
const FEATURE_UNAVAILABLE_ON_PLATFORM = 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM'

/**
 * Build the refusal error and write it to the console first, for stubs that
 * cannot be a plain throwing function (constructors, methods on structural
 * fakes).
 * @param module - module specifier being stubbed.
 * @param symbol - unavailable member, named as the importer sees it.
 * @returns the error to throw, with `code` set to Node's `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`.
 */
export function notAvailableError(module: string, symbol: string): Error & { code: string } {
  const message = `web-preview: ${module}.${symbol} is not available in the worker host`
  console.error(message)
  return Object.assign(new Error(message), { code: FEATURE_UNAVAILABLE_ON_PLATFORM })
}
