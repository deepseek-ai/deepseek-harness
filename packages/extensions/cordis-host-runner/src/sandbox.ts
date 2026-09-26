/**
 * The `node:vm` sandbox a dynamic package's HOST half evaluates in: a fresh realm whose globals
 * are a tagged write-through console, the `harness` registration helpers, the encoding primitives
 * a bare vm context lacks, and callable traps over the Node APIs the sandbox deliberately
 * withholds. Traps steer filesystem, network, process, and timer work to `ctx.fs`, `ctx.web`,
 * `ctx.bash`, and Cordis timers. This keeps cooperative packages inspectable and disposable but
 * is not containment: host-realm helper functions remain an escape route.
 *
 * The browser half never reaches this module — it is evaluated by the client-side runner in a
 * closure, with its own facade.
 * @module @deepseek-ai/dsh-cordis-host-runner/sandbox
 */

import { createContext, runInContext, Script } from 'node:vm'
import { sandboxDefineTool, sandboxRegisterTool } from './guard.ts'

/**
 * A write-through console for one package, tagging every line with the package
 * id. Write-through (host stdout/stderr), NOT buffered into the tool result:
 * a registered listener fires long after the run call returned, and its output
 * must land somewhere the user can see — for a terminal entry point, the host terminal.
 */
function taggedConsole(id: string): Record<'log' | 'info' | 'warn' | 'error' | 'debug', (...args: unknown[]) => void> {
  const tag = `[cordis:${id}]`
  const log = (...args: unknown[]): void => { console.log(tag, ...args) }
  const error = (...args: unknown[]): void => { console.error(tag, ...args) }
  return { log, info: log, warn: log, debug: log, error }
}

/**
 * Patch only VM constructors so `instanceof` accepts both VM values and host values passed as
 * arguments, events, or service results; host intrinsics remain untouched.
 */
const DUAL_REALM_INSTANCEOF_PRELUDE = `
(hostIntrinsics) => {
  'use strict'
  const ordinary = Function.prototype[Symbol.hasInstance]
  for (const name of Object.keys(hostIntrinsics)) {
    const VmCtor = globalThis[name]
    const HostCtor = hostIntrinsics[name]
    if (typeof VmCtor !== 'function' || typeof HostCtor !== 'function') continue
    Object.defineProperty(VmCtor, Symbol.hasInstance, {
      value: (instance) => ordinary.call(VmCtor, instance) || ordinary.call(HostCtor, instance),
      configurable: true,
    })
  }
}
`

/** Run {@link DUAL_REALM_INSTANCEOF_PRELUDE} in a freshly created sandbox, handing it the host intrinsics to pair up. */
function patchDualRealmInstanceof(sandbox: object): void {
  const patch = runInContext(DUAL_REALM_INSTANCEOF_PRELUDE, sandbox) as (intrinsics: Record<string, unknown>) => void
  patch({ Object, Array, Function, Error, TypeError, RangeError, SyntaxError, Promise, RegExp, Date, Map, Set })
}

const TIMER_REDIRECT
  = 'Node timers are unavailable. Use the cordis timer service instead: declare inject: [\'timer\'] on your plugin '
    + 'and call ctx.timeout / ctx.interval after querying Host Service.listService for the exact overloads. '
    + 'Those calls are fiber effects, cleaned up automatically when stopped.'

/**
 * The callable Node APIs the sandbox deliberately disables, each mapped to the
 * cordis alternative its trap error names. Only function-valued globals are
 * trapped; a data-valued global such as `process` stays `undefined`, because a
 * throwing accessor would detonate the common `typeof process` feature probe
 * at resolution time.
 */
const NODE_API_REDIRECTS: Record<string, string> = {
  require:
    'Node modules are unavailable. Use the cordis services on ctx instead — e.g. inject: [\'fs\'] for files, '
    + '[\'web\'] for HTTP, [\'bash\'] for processes; query Service.listService with cordis_inspect_query first.',
  setTimeout: TIMER_REDIRECT,
  setInterval: TIMER_REDIRECT,
  setImmediate: TIMER_REDIRECT,
  clearTimeout: TIMER_REDIRECT,
  clearInterval: TIMER_REDIRECT,
  fetch:
    'Network access goes through the cordis web service: declare inject: [\'web\'] and call ctx.web '
    + '(query Host Service.listService with cordis_inspect_query for its methods).',
}

/** Build the trap functions for {@link NODE_API_REDIRECTS}: calling one throws the redirect. */
function nodeApiTraps(): Record<string, () => never> {
  const traps: Record<string, () => never> = {}
  for (const [name, redirect] of Object.entries(NODE_API_REDIRECTS)) {
    traps[name] = () => {
      throw new Error(`${name} is not available in the dynamic package sandbox — ${redirect}`)
    }
  }
  return traps
}

/**
 * Build the vm context one host half evaluates in: the tagged console, the
 * `harness` registration helpers, the encoding primitives, the Node-API traps,
 * and the dual-realm `instanceof` patch, already `createContext`-ed.
 * @param id - the package id (`dyn-<n>`), used as the console tag and filename stem.
 * @param harnessExtras - per-package `harness` verbs beyond the registration pair (`handle`).
 * @returns the contextified sandbox object to pass to {@link evaluateHostCode}.
 */
export function createSandbox(id: string, harnessExtras: Record<string, unknown> = {}): object {
  const sandbox = {
    ...nodeApiTraps(),
    console: taggedConsole(id),
    harness: { defineTool: sandboxDefineTool, registerTool: sandboxRegisterTool, ...harnessExtras },
    // Web APIs absent from fresh vm contexts — made available so the model
    // can encode/decode base64 without Buffer (which is also absent). Host
    // closures over Buffer, never Buffer itself.
    btoa: (s: string) => Buffer.from(s, 'utf-8').toString('base64'),
    atob: (s: string) => Buffer.from(s, 'base64').toString('utf-8'),
    TextEncoder,
    TextDecoder,
  }
  createContext(sandbox)
  patchDualRealmInstanceof(sandbox)
  return sandbox
}

/**
 * Cross-realm SyntaxError detection: a compile failure inside `runInContext`
 * constructs its error in the SANDBOX realm, so a host `instanceof
 * SyntaxError` is silently false — the `name` property is the realm-safe tag.
 */
function isSyntaxError(error: unknown): error is Error {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'SyntaxError'
}

/**
 * The parse-failure context a vm `SyntaxError` carries: the vm prints the
 * offending source line and a caret before the message, which is exactly what
 * a model needs to self-correct — surface it instead of the bare message.
 * Falls back to `String(error)` when the stack carries no such prelude.
 * @param error - the `SyntaxError` (host- or sandbox-realm) thrown while compiling package code.
 * @returns the stack prefix up to and including the `SyntaxError: …` line.
 */
export function syntaxErrorContext(error: Error): string {
  const lines = (error.stack ?? '').split('\n')
  const messageIndex = lines.findIndex(line => line.startsWith('SyntaxError'))
  if (messageIndex === -1) return String(error)
  return lines.slice(0, messageIndex + 1).join('\n')
}

/**
 * The teaching text one parse failure produces, shared by the define-time
 * precheck and the run-time evaluation so a model reads the same diagnosis
 * whichever verb caught it.
 * @param half - which half failed to parse, named as the define argument that carried it.
 * @param context - the {@link syntaxErrorContext} of the failure.
 * @returns the model-facing error message.
 */
export function parseErrorMessage(half: 'code.host' | 'code.client', context: string): string {
  // Scope the TypeScript heuristic to the OFFENDING line, not the whole code:
  // an ` as ` inside an ordinary description string must not turn a plain
  // syntax error into a misleading remove-annotations message.
  const offendingLine = context.split('\n')[1] ?? ''
  if (/\bas\b/.test(offendingLine)) {
    return `dynamic package \`${half}\` failed to parse:\n${context}\n`
      + 'The sandbox runs plain JavaScript, not TypeScript. Remove type annotations:\n'
      + '  ✗ { type: \'text\' as const, text: x }\n'
      + '  ✓ { type: \'text\', text: x }'
  }
  return `dynamic package \`${half}\` failed to parse:\n${context}\n`
    + 'Note: it runs as the BODY of an async function (line numbers are offset by the 1-line wrapper). '
    + 'Check bracket balance — ending the returned plugin object with `});` closes a call that was never opened; '
    + 'a plain `return { … }` ends with `}` (an optional `;`), never `)`.'
}

/**
 * Parse one half's source without running it: the define-time precheck that
 * keeps unparseable code out of the registry, so a model fixes it and defines
 * again instead of discovering the failure at run time. `new Function` is the
 * gate — hosts without a real `node:vm` (the browser worker) still refuse
 * unparseable code — and `vm.Script` is only the best-effort prettifier: on a
 * Node host its failure carries the source-line-and-caret prelude the
 * teaching text builds on, and where the vm is a stub the message stays bare.
 * The two parsers' syntax faces differ at the margin (`new.target` parses in
 * a function body but not at the vm wrapper's top level), an accepted cost of
 * a vm-free gate; and under a page CSP without `'unsafe-eval'`, `new Function`
 * throws `EvalError`, which propagates unwrapped.
 * @param code - the model-written function body.
 * @param half - which define argument carried it, for the error text.
 * @throws when the body does not parse, with the offending line and a teaching hint.
 */
export function precheckCode(code: string, half: 'code.host' | 'code.client'): void {
  const wrapped = `(async () => {\n${code}\n})()`
  try {
    // Compile-only: constructing the function parses the source and runs nothing.
    // oxlint-disable-next-line typescript/no-implied-eval -- parse gate over model-written code; nothing is invoked
    new Function(wrapped)
  } catch (error) {
    if (!isSyntaxError(error)) throw error
    throw new Error(parseErrorMessage(half, prettyParseContext(wrapped, half, error)))
  }
}

/**
 * Best-effort vm recompile of a body `new Function` already refused, for the
 * source-line-and-caret prelude only.
 * @param wrapped - the wrapped source that failed to parse.
 * @param half - which define argument carried it, for the vm filename.
 * @param refusal - the gate's own `SyntaxError`, the fallback context source.
 * @returns the vm prelude when a real vm produced one, else the bare refusal.
 */
function prettyParseContext(wrapped: string, half: 'code.host' | 'code.client', refusal: Error): string {
  try {
    new Script(wrapped, { filename: `cordis-dyn-${half}.js` })
  } catch (vmError) {
    if (isSyntaxError(vmError)) return syntaxErrorContext(vmError)
    // A stubbed vm (the browser worker) refuses Script itself; the gate's
    // error is the only context there is.
  }
  return String(refusal)
}

/**
 * Evaluate a host half as the body of an async function inside the sandbox. `vmTimeoutMs` only
 * bounds the SYNCHRONOUS portion; an async body escapes it — acceptable under the module's
 * trust stance. Parse errors include the offending line and a TypeScript-removal or bracket-
 * balance hint.
 * @param sandbox - the contextified object from {@link createSandbox}.
 * @param code - the model-written function body; must `return` a plugin.
 * @param id - the package id, used as the vm filename (`cordis-dyn-<id>.js`).
 * @param vmTimeoutMs - the synchronous evaluation bound in milliseconds.
 * @returns whatever the code returned, still un-narrowed (the run lifecycle checks plugin shape).
 */
export async function evaluateHostCode(sandbox: object, code: string, id: string, vmTimeoutMs: number): Promise<unknown> {
  try {
    return await runInContext(
      `(async () => {\n${code}\n})()`,
      sandbox,
      { filename: `cordis-dyn-${id}.js`, timeout: vmTimeoutMs },
    )
  } catch (error) {
    if (!isSyntaxError(error)) throw error
    throw new Error(parseErrorMessage('code.host', syntaxErrorContext(error)))
  }
}
