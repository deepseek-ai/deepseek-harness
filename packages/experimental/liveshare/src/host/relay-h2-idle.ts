/**
 * Consume undici's HTTP/2 idle-session teardown for Relay requests only.
 *
 * undici reports an idle h2 close as `InformationalError('socket idle timeout')` on a socket no
 * request owns. The Relay keeps HTTP/2, so this guard observes connected sockets only while a
 * Relay request is on the async call stack. Sockets opened by any other component are left alone.
 * @module @deepseek-ai/dsh-experimental-liveshare/src/host/relay-h2-idle
 */

/** The undici diagnostics channel that announces every connected client socket. */
const CONNECTED_CHANNEL = 'undici:client:connected'

/** Sockets this guard already instrumented. */
const guarded = new WeakSet<object>()

/** Whether the diagnostics listener is installed. */
let armed = false

/** Async context marking the Relay fetch that owns a connection attempt. */
let scope: import('node:async_hooks').AsyncLocalStorage<boolean> | undefined

function asyncHooks(): typeof import('node:async_hooks') {
  return process.getBuiltinModule('node:async_hooks')
}

function relayScope(): import('node:async_hooks').AsyncLocalStorage<boolean> {
  scope ??= new (asyncHooks().AsyncLocalStorage<boolean>)()
  return scope
}

/**
 * Run one Relay request inside the guard's async scope.
 * @param operation - the request to run.
 * @returns the operation result.
 */
export function runRelayH2Scoped<T>(operation: () => Promise<T>): Promise<T> {
  return relayScope().run(true, operation)
}

/**
 * Whether a value is undici's HTTP/2 idle-timeout notification.
 * @param error - The emitted socket error.
 * @returns True for the informational idle timeout.
 */
export function isRelayH2IdleTimeout(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { readonly name?: unknown; readonly code?: unknown; readonly message?: unknown }
  return candidate.name === 'InformationalError'
    && candidate.code === 'UND_ERR_INFO'
    && typeof candidate.message === 'string'
    && candidate.message.includes('socket idle timeout')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function guardSocket(socket: Record<string, unknown>): void {
  guarded.add(socket)
  const onError = (error: unknown): void => {
    if (isRelayH2IdleTimeout(error)) return
    const listeners = (socket.listenerCount as (event: string) => number)('error')
    /* v8 ignore next -- a socket without its own listener is a fatal process error, not a test path. */
    if (listeners <= 1) queueMicrotask(() => { throw error })
  }
  ;(socket.on as (event: 'error', listener: (error: unknown) => void) => void)('error', onError)
}

function onConnected(message: unknown): void {
  if (relayScope().getStore() !== true) return
  /* v8 ignore next -- diagnostic payloads are records; other values are ignored defensively. */
  if (!isRecord(message)) return
  const socket = message.socket
  /* v8 ignore next -- undici always supplies a socket; the guard keeps a duplicate from double-listening. */
  if (!isRecord(socket) || guarded.has(socket)) return
  const connectParams = isRecord(message.connectParams) ? message.connectParams : undefined
  if (socket.alpnProtocol !== 'h2' && connectParams?.version !== 'h2') return
  guardSocket(socket)
}

/** Install the diagnostics listener once. */
export function armRelayH2Guard(): void {
  if (armed) return
  armed = true
  process.getBuiltinModule('node:diagnostics_channel').channel(CONNECTED_CHANNEL).subscribe(onConnected)
}
