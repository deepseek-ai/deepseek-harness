/** Client Console observation shared by every active DevTools Runtime session. */

import type { ClientRemoteObjectHandle, ClientRuntimeSessionId } from '../../shared/bridge/ids.ts'
import type { ClientConsoleCapability } from '../../shared/bridge/messages/runtime/index.ts'
import type { RuntimeConsoleBackendEvent, RuntimeConsoleType } from '../../shared/cdp/index.ts'
import type { ClientRuntimeExecutor } from './runtime.ts'
import { captureClientConsoleStack, clientErrorStack, type ClientScriptKeyResolver } from './stack.ts'

/**
 * Describe browser-side Console observation.
 * @returns The Console capability advertised by a browser Client source.
 */
export function consoleBridgeCapability(): ClientConsoleCapability {
  return { type: 'client-console' }
}

/** Receives one Console event whose object handles belong to the given session. */
export type ClientConsoleSink = (
  sessionId: ClientRuntimeSessionId,
  event: RuntimeConsoleBackendEvent<ClientRemoteObjectHandle>,
) => void

const METHODS = [
  ['log', 'log'],
  ['debug', 'debug'],
  ['info', 'info'],
  ['error', 'error'],
  ['warn', 'warning'],
  ['dir', 'dir'],
  ['dirxml', 'dirxml'],
  ['table', 'table'],
  ['trace', 'trace'],
  ['clear', 'clear'],
  ['group', 'startGroup'],
  ['groupCollapsed', 'startGroupCollapsed'],
  ['groupEnd', 'endGroup'],
  ['assert', 'assert'],
  ['profile', 'profile'],
  ['profileEnd', 'profileEnd'],
  ['count', 'count'],
  ['timeEnd', 'timeEnd'],
] as const satisfies readonly (readonly [string, RuntimeConsoleType])[]

type ConsoleMethodName = typeof METHODS[number][0]

interface InstalledMethod {
  readonly name: ConsoleMethodName
  readonly original: (...args: unknown[]) => unknown
  readonly replacement: (...args: unknown[]) => unknown
}

/** Installs one transparent console/error observer and fans out session-local values. */
export class ClientConsoleObserver {
  private readonly sessions = new Set<ClientRuntimeSessionId>()
  private readonly installed: InstalledMethod[] = []
  private active = false
  private closed = false

  constructor(
    private readonly runtime: ClientRuntimeExecutor,
    private readonly sink: ClientConsoleSink,
    private readonly resolveScript: ClientScriptKeyResolver = () => undefined,
  ) {}

  /**
   * Start producing events for one DevTools Runtime session.
   * @param sessionId - Session whose object table retains event arguments.
   */
  enable(sessionId: ClientRuntimeSessionId): void {
    if (this.closed) return
    this.sessions.add(sessionId)
    if (!this.active) this.install()
  }

  /**
   * Stop producing events and release Console objects for one session.
   * @param sessionId - Session being disabled or closed.
   */
  disable(sessionId: ClientRuntimeSessionId): void {
    this.sessions.delete(sessionId)
    this.runtime.releaseObjectGroup(sessionId, 'console')
    if (this.sessions.size === 0) this.uninstall()
  }

  /** Restore original browser hooks and clear every active session. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.reset()
  }

  /** Stop observing the current source generation while allowing a later reconnect. */
  reset(): void {
    this.sessions.clear()
    this.uninstall()
  }

  private install(): void {
    this.active = true
    for (const [name, type] of METHODS) {
      const candidate: unknown = Reflect.get(console, name)
      if (typeof candidate !== 'function') continue
      const original = candidate as (...args: unknown[]) => unknown
      const capture = (values: readonly unknown[]): void => { this.captureConsole(type, values) }
      const replacement = function (this: unknown, ...args: unknown[]): unknown {
        const result = Reflect.apply(original, this, args)
        const values = name === 'assert' ? args.slice(1) : args
        if (name !== 'assert' || !args[0]) capture(values)
        return result
      }
      if (Reflect.set(console, name, replacement)) this.installed.push({ name, original, replacement })
    }
    addGlobalListener('error', this.onError)
    addGlobalListener('unhandledrejection', this.onUnhandledRejection)
  }

  private uninstall(): void {
    if (!this.active) return
    this.active = false
    removeGlobalListener('error', this.onError)
    removeGlobalListener('unhandledrejection', this.onUnhandledRejection)
    for (const method of this.installed.splice(0).reverse()) {
      if (Reflect.get(console, method.name) === method.replacement) Reflect.set(console, method.name, method.original)
    }
  }

  private readonly onError = (event: Event): void => {
    const error: unknown = Reflect.get(event, 'error')
    const message: unknown = Reflect.get(event, 'message')
    this.captureException(error ?? new Error(typeof message === 'string' ? message : 'Client error'))
  }

  private readonly onUnhandledRejection = (event: Event): void => {
    this.captureException(Reflect.get(event, 'reason') as unknown)
  }

  private captureConsole(type: RuntimeConsoleType, values: readonly unknown[]): void {
    const timestamp = Date.now()
    const stackTrace = captureClientConsoleStack(this.resolveScript)
    queueMicrotask(() => {
      for (const sessionId of [...this.sessions]) {
        try {
          const event = this.runtime.consoleEvent(sessionId, type, values, timestamp, stackTrace)
          if (event !== undefined) this.sink(sessionId, event)
        } catch {
          // Console observation must not affect the page's original console call.
        }
      }
    })
  }

  private captureException(error: unknown): void {
    const timestamp = Date.now()
    const stackTrace = clientErrorStack(error, this.resolveScript)
    queueMicrotask(() => {
      for (const sessionId of [...this.sessions]) {
        try {
          const event = this.runtime.exceptionEvent(sessionId, error, timestamp, stackTrace)
          if (event !== undefined) this.sink(sessionId, event)
        } catch {
          // Exception observation must not affect browser error dispatch.
        }
      }
    })
  }
}

function addGlobalListener(type: string, listener: EventListener): void {
  const add: unknown = Reflect.get(globalThis, 'addEventListener')
  if (typeof add === 'function') Reflect.apply(add, globalThis, [type, listener])
}

function removeGlobalListener(type: string, listener: EventListener): void {
  const remove: unknown = Reflect.get(globalThis, 'removeEventListener')
  if (typeof remove === 'function') Reflect.apply(remove, globalThis, [type, listener])
}
