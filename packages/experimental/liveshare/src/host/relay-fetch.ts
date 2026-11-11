/**
 * Relay HTTP calls over a connection owned by one share host.
 *
 * Each transport owns its dispatcher: it honours the process proxy policy but does not replace the
 * global dispatcher. HTTP/2 stays enabled; undici's informational idle-teardown error is consumed by a
 * Relay-scoped socket guard instead of reaching the process fail-loud path. A replaced
 * `globalThis.fetch` is deliberately ignored so instrumentation cannot move Relay traffic onto the
 * shared transport.
 * @module @deepseek-ai/dsh-experimental-liveshare/src/host/relay-fetch
 */

import { createRouteDispatcher } from '@deepseek-ai/dsh-http-proxy'
import type { RequestInit, Response } from 'undici'
import { armRelayH2Guard, runRelayH2Scoped } from './relay-h2-idle.ts'

/** Send one Relay request. */
export type RelayFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

/** Lookup shape the proxy policy resolves from. */
export type RelayEnvironment = (name: string) => { readonly value: string } | undefined

/** One host-owned Relay transport and the connection pool it must close. */
export interface RelayTransport {
  readonly fetch: RelayFetch
  close(): Promise<void>
}

/** The plain global fetch, captured before a test can replace it. */
const plainFetch = globalThis.fetch

/**
 * Resolve one proxy setting from the process environment.
 * @param name - environment variable name.
 * @returns the value in the proxy lookup shape, or undefined when absent.
 */
export function processRelayEnvironment(name: string): { readonly value: string } | undefined {
  const value = process.env[name]
  /* v8 ignore next -- an absent variable is the unproxied case; the launcher snapshot is the configured path. */
  return value === undefined ? undefined : { value }
}

/**
 * Create one Relay transport with a dispatcher owned by the caller.
 * @param environment - proxy lookup; defaults to the process environment.
 * @returns the fetch function and the close operation that releases its pool.
 */
export function createRelayTransport(environment: RelayEnvironment = processRelayEnvironment): RelayTransport {
  let dispatcher: ReturnType<typeof createRouteDispatcher> | undefined
  const relayDispatcher = (): ReturnType<typeof createRouteDispatcher> => {
    armRelayH2Guard()
    dispatcher ??= createRouteDispatcher({ get: name => environment(name) }, { allowH2: true })
    return dispatcher
  }
  return {
    fetch: async (input, init = {}) => {
      // Tests replace the global fetch to stand in for the Relay. Production keeps its private
      // dispatcher even when instrumentation replaces the global, so this branch is test-only.
      if (process.env.NODE_ENV === 'test' && globalThis.fetch !== plainFetch) {
        return await (globalThis.fetch(input, init as globalThis.RequestInit) as Promise<Response>)
      }
      return await runRelayH2Scoped(async () => {
        const { fetch } = await import('undici')
        // proxy-exempt: createRouteDispatcher routes by the resolved proxy policy.
        return await fetch(input, { ...init, dispatcher: await relayDispatcher() })
      })
    },
    async close() {
      const current = dispatcher
      dispatcher = undefined
      if (current !== undefined) await (await current).close()
    },
  }
}

/** The module-level transport used by callers that have not moved to an owned one. */
let defaultEnvironment: RelayEnvironment = processRelayEnvironment
let defaultTransport = createRelayTransport(defaultEnvironment)

/**
 * Resolve the module-level transport through another environment lookup.
 * @param lookup - proxy lookup, usually a launcher snapshot.
 */
export function configureRelayFetchEnvironment(lookup: RelayEnvironment): void {
  defaultEnvironment = lookup
  defaultTransport = createRelayTransport(lookup)
}

/**
 * Send one Relay request over the module-level transport.
 * @param input - absolute Relay URL or URL object.
 * @param init - request options.
 * @returns the Relay response.
 */
export async function relayFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  return await defaultTransport.fetch(input, init)
}

/** Close the module-level transport, if it has a pool. */
export async function closeRelayFetch(): Promise<void> {
  await defaultTransport.close()
  defaultTransport = createRelayTransport(defaultEnvironment)
}
